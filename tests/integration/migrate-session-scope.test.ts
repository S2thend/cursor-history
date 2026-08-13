import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as migrationModule from '../../src/core/migrate.js';
import * as storage from '../../src/core/storage.js';
import { registry } from '../../src/core/database/registry.js';
import { betterSqlite3Driver } from '../../src/core/database/drivers/better-sqlite3.js';
import { nodeSqliteDriver } from '../../src/core/database/drivers/node-sqlite.js';
import type { DatabaseDriver } from '../../src/core/database/types.js';
import {
  DatabaseCapabilityError,
  DatabaseCapabilityMissingError,
  NoCapableDriverError,
  NoCapableDatabaseDriverError,
  migrateSession as migrateLibrarySession,
  migrateWorkspace as migrateLibraryWorkspace,
} from '../../src/lib/index.js';
import type {
  MigrateSessionConfig,
  MigrateWorkspaceConfig,
  SessionMigrationResult,
  SourceReadLimitsOverride,
} from '../../src/lib/types.js';
import {
  SESSION_INTEGRITY_IDS,
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreTranscript,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

interface FeatureMigrateSessionConfig extends MigrateSessionConfig {
  workspace?: string;
  sourceReadLimits?: SourceReadLimitsOverride;
  signal?: AbortSignal;
}

interface FeatureMigrateWorkspaceConfig extends MigrateWorkspaceConfig {
  sourceReadLimits?: SourceReadLimitsOverride;
  signal?: AbortSignal;
}

interface ContractMigrationTarget {
  logicalSessionId: string;
  sourceWorkspacePath: string;
  occurrenceFingerprint: string;
}

interface MigrationPipelineContract {
  bindMigrationTargets(
    selectors: readonly (number | string)[],
    options: {
      numericBase: 0 | 1;
      workspacePath?: string;
      dataPath?: string;
    },
    context: unknown
  ): Promise<ContractMigrationTarget[]>;
  prepareSessionMigration(
    target: ContractMigrationTarget,
    destination: string,
    options: {
      mode: 'move' | 'copy';
      force?: boolean;
      dataPath?: string;
      sourceReadLimits?: SourceReadLimitsOverride;
      signal?: AbortSignal;
      uuidFactory?: () => string;
    }
  ): Promise<unknown>;
  applySessionMigration(prepared: unknown): Promise<SessionMigrationResult>;
}

interface FailureResult extends SessionMigrationResult {
  errorCode?: string;
}

const fixtures: SessionIntegrityFixtureRoot[] = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

function newFixture(prefix = 'cursor-history-migration-scope-') {
  const fixture = createSessionIntegrityFixtureRoot(prefix);
  fixtures.push(fixture);
  process.env['CURSOR_STORE_ROOT'] = fixture.storeRoot;
  return fixture;
}

function addDestination(fixture: SessionIntegrityFixtureRoot): string {
  const destination = join(fixture.root, 'workspaces', 'destination');
  mkdirSync(destination, { recursive: true });
  writeComposerWorkspaceSummary(fixture, 'workspace-destination', destination, []);
  return destination;
}

function readTable(path: string, table: 'ItemTable' | 'cursorDiskKV') {
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT key, value FROM ${table} ORDER BY key`).all() as Array<{
      key: string;
      value: string;
    }>;
  } finally {
    db.close();
  }
}

function mutationSnapshot(fixture: SessionIntegrityFixtureRoot): string {
  const workspaceRows = [
    'workspace-a',
    'workspace-a-copy',
    'workspace-b',
    'workspace-destination',
  ].map((workspaceId) => {
    const path = join(fixture.workspaceStorage, workspaceId, 'state.vscdb');
    try {
      return [workspaceId, readTable(path, 'ItemTable')] as const;
    } catch {
      return [workspaceId, null] as const;
    }
  });
  let globalRows: ReturnType<typeof readTable> | null = null;
  try {
    globalRows = readTable(join(fixture.globalStorage, 'state.vscdb'), 'cursorDiskKV');
  } catch {
    // A workspace-fallback-only fixture legitimately has no global database.
  }
  return JSON.stringify({ workspaceRows, globalRows });
}

function globalMutationSnapshot(fixture: SessionIntegrityFixtureRoot): string {
  return JSON.stringify(readTable(join(fixture.globalStorage, 'state.vscdb'), 'cursorDiskKV'));
}

async function expectTypedRefusal(
  operation: Promise<SessionMigrationResult[] | unknown>,
  code: string
): Promise<void> {
  let value: SessionMigrationResult[] | unknown;
  let thrown: unknown;
  try {
    value = await operation;
  } catch (error) {
    thrown = error;
  }
  if (thrown !== undefined) {
    expect(thrown).toMatchObject({ code });
    return;
  }
  const results = Array.isArray(value) ? (value as FailureResult[]) : [];
  expect(results, `expected a typed ${code} refusal`).toHaveLength(1);
  expect(results[0]).toMatchObject({ success: false, errorCode: code });
}

function requireMigrationPipeline(): MigrationPipelineContract {
  const candidate = migrationModule as typeof migrationModule & Partial<MigrationPipelineContract>;
  expect(candidate.bindMigrationTargets).toBeTypeOf('function');
  expect(candidate.prepareSessionMigration).toBeTypeOf('function');
  expect(candidate.applySessionMigration).toBeTypeOf('function');
  return candidate as MigrationPipelineContract;
}

function addStoreConversation(
  fixture: SessionIntegrityFixtureRoot,
  id: string,
  workspacePath: string,
  content: string
): void {
  const chatDir = join(fixture.storeRoot, 'chats', 'fixture-hash', id);
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(
    join(chatDir, 'meta.json'),
    JSON.stringify({
      cwd: workspacePath,
      title: `Store ${id}`,
      createdAtMs: 1_900_000_000_000,
      hasConversation: false,
    })
  );
  writeStoreTranscript(fixture, 'fixture', id, [
    { role: 'user', message: { content: [{ type: 'text', text: content }] } },
  ]);
}

function sessionConfig(
  fixture: SessionIntegrityFixtureRoot,
  destination: string,
  sessions: MigrateSessionConfig['sessions'],
  overrides: Partial<FeatureMigrateSessionConfig> = {}
): FeatureMigrateSessionConfig {
  return {
    sessions,
    destination,
    mode: 'move',
    dataPath: fixture.workspaceStorage,
    ...overrides,
  };
}

function composerSession(
  fixture: SessionIntegrityFixtureRoot,
  id: string,
  title: string,
  workspacePath = fixture.projectA
): ComposerFixtureSession {
  return {
    id,
    title,
    workspacePath,
    createdAt: 1_700_000_000_000,
    messages: [{ id: `${id}:message`, role: 'user', content: title }],
  };
}

function twoComposerSessions(fixture: SessionIntegrityFixtureRoot): ComposerFixtureSession[] {
  return [
    composerSession(fixture, '11111111-0000-4000-8000-000000000016', 'First migration target'),
    composerSession(fixture, '22222222-0000-4000-8000-000000000016', 'Second migration target'),
  ];
}

function readComposerIds(databasePath: string): string[] {
  const db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get() as { value: string };
    const parsed = JSON.parse(row.value) as {
      allComposers?: Array<{ composerId?: string }>;
    };
    return (parsed.allComposers ?? [])
      .map((composer) => composer.composerId)
      .filter((id): id is string => typeof id === 'string');
  } finally {
    db.close();
  }
}

function hookedBetterSqliteDriver(hooks: {
  beforeOpen?: (path: string, readonly: boolean) => void;
  beforeAll?: (path: string, sql: string) => void;
  beforeRun?: (path: string, sql: string, params: readonly unknown[]) => void;
}): DatabaseDriver {
  return {
    name: 'better-sqlite3',
    async isAvailable() {
      return true;
    },
    async getCapabilityProfile() {
      return {
        driver: 'better-sqlite3',
        available: true,
        capabilities: new Set(['read', 'readWrite'] as const),
      };
    },
    open(path, options) {
      hooks.beforeOpen?.(path, options.readonly);
      const db = new BetterSqlite3(path, {
        readonly: options.readonly,
        fileMustExist: true,
      });
      return {
        prepare(sql) {
          const statement = db.prepare(sql);
          return {
            get: (...params: unknown[]) => statement.get(...params),
            all: (...params: unknown[]) => {
              hooks.beforeAll?.(path, sql);
              return statement.all(...params) as unknown[];
            },
            run: (...params: unknown[]) => {
              hooks.beforeRun?.(path, sql, params);
              const result = statement.run(...params);
              return {
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid,
              };
            },
          };
        },
        runSQL(sql) {
          db.exec(sql);
        },
        close() {
          db.close();
        },
      };
    },
    async backup() {
      throw new Error('not used');
    },
  };
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error('Expected operation to reject');
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  registry.reset();
  registry.register(nodeSqliteDriver);
  registry.register(betterSqlite3Driver);
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe.sequential('workspace-scoped migration selection', () => {
  it('uses one-based public migration selectors inside the active workspace for preview and apply', async () => {
    const fixture = newFixture();
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const config = sessionConfig(fixture, destination, 1, { workspace: fixture.projectA });
    const beforePreview = mutationSnapshot(fixture);

    const preview = await migrateLibrarySession({ ...config, dryRun: true });
    expect(preview).toEqual([
      expect.objectContaining({
        success: true,
        sessionId: sessionA.id,
        sourceWorkspace: fixture.projectA,
        dryRun: true,
      }),
    ]);
    expect(preview[0]?.sessionId).not.toBe(sessionB.id);
    expect(mutationSnapshot(fixture)).toBe(beforePreview);

    const applied = await migrateLibrarySession({ ...config, dryRun: false });
    expect(applied).toEqual([
      expect.objectContaining({
        success: true,
        sessionId: sessionA.id,
        sourceWorkspace: fixture.projectA,
        dryRun: false,
      }),
    ]);
    expect(applied[0]?.sessionId).toBe(preview[0]?.sessionId);
  });

  it('normalizes file URI and dot-segment workspace selectors before binding an index', async () => {
    const fixture = newFixture();
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const workspaceFileUri = `file://${fixture.root}/workspaces/./discard/../a/`;
    const before = mutationSnapshot(fixture);

    const result = await migrateLibrarySession(
      sessionConfig(fixture, destination, 1, {
        workspace: workspaceFileUri,
        dryRun: true,
      })
    );

    expect(result).toEqual([
      expect.objectContaining({
        success: true,
        sessionId: sessionA.id,
        sourceWorkspace: fixture.projectA,
        dryRun: true,
      }),
    ]);
    expect(result[0]?.sessionId).not.toBe(sessionB.id);
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('prefers an exact workspace match over another path with the same component suffix', async () => {
    const fixture = newFixture();
    const exactSession = composerSession(
      fixture,
      '13131313-0000-4000-8000-000000000016',
      'Exact workspace target'
    );
    const shadowPath = join(fixture.root, 'shadow', fixture.projectA);
    const suffixSession = composerSession(
      fixture,
      '14141414-0000-4000-8000-000000000016',
      'Suffix-only workspace target',
      shadowPath
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [exactSession]);
    writeComposerWorkspaceSummary(fixture, 'workspace-b', shadowPath, [suffixSession]);
    writeComposerGlobalSessions(fixture, [exactSession, suffixSession]);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    const result = await migrateLibrarySession(
      sessionConfig(fixture, destination, 1, {
        workspace: fixture.projectA,
        dryRun: true,
      })
    );

    expect(result).toEqual([
      expect.objectContaining({
        success: true,
        sessionId: exactSession.id,
        sourceWorkspace: fixture.projectA,
        dryRun: true,
      }),
    ]);
    expect(result[0]?.sessionId).not.toBe(suffixSession.id);
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('accepts an unambiguous complete-component workspace suffix', async () => {
    const fixture = newFixture();
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    const result = await migrateLibrarySession(
      sessionConfig(fixture, destination, 1, {
        workspace: join('workspaces', 'a'),
        dryRun: true,
      })
    );

    expect(result).toEqual([
      expect.objectContaining({
        success: true,
        sessionId: sessionA.id,
        sourceWorkspace: fixture.projectA,
        dryRun: true,
      }),
    ]);
    expect(result[0]?.sessionId).not.toBe(sessionB.id);
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('refuses an ambiguous component suffix before performing migration writes', async () => {
    const fixture = newFixture();
    const leftPath = join(fixture.root, 'tenant-a', 'team', 'project');
    const rightPath = join(fixture.root, 'tenant-b', 'team', 'project');
    const leftSession = composerSession(
      fixture,
      '15151515-0000-4000-8000-000000000016',
      'Left ambiguous target',
      leftPath
    );
    const rightSession = composerSession(
      fixture,
      '16161616-0000-4000-8000-000000000016',
      'Right ambiguous target',
      rightPath
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', leftPath, [leftSession]);
    writeComposerWorkspaceSummary(fixture, 'workspace-b', rightPath, [rightSession]);
    writeComposerGlobalSessions(fixture, [leftSession, rightSession]);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    await expectTypedRefusal(
      migrateLibrarySession(
        sessionConfig(fixture, destination, 1, {
          workspace: join('team', 'project'),
          dryRun: false,
        })
      ),
      'WORKSPACE_AMBIGUOUS'
    );
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('treats Windows drive and WSL mount spellings as the same workspace selector', async () => {
    const fixture = newFixture();
    const wslWorkspacePath = '/mnt/d/Team/Project';
    const session = composerSession(
      fixture,
      '17171717-0000-4000-8000-000000000016',
      'Cross-platform workspace target',
      wslWorkspacePath
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', wslWorkspacePath, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    const result = await migrateLibrarySession(
      sessionConfig(fixture, destination, 1, {
        workspace: 'D:\\TEAM\\discard\\..\\PROJECT\\',
        dryRun: true,
      })
    );

    expect(result).toEqual([
      expect.objectContaining({
        success: true,
        sessionId: session.id,
        dryRun: true,
      }),
    ]);
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('keeps unfiltered one-based numeric preview/apply behavior unchanged', async () => {
    const fixture = newFixture();
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const config = sessionConfig(fixture, destination, 1);
    const beforePreview = mutationSnapshot(fixture);

    const preview = await migrateLibrarySession({ ...config, dryRun: true });
    expect(preview[0]).toMatchObject({
      success: true,
      sessionId: sessionB.id,
      sourceWorkspace: fixture.projectB,
      dryRun: true,
    });
    expect(preview[0]?.sessionId).not.toBe(sessionA.id);
    expect(mutationSnapshot(fixture)).toBe(beforePreview);

    const applied = await migrateLibrarySession({ ...config, dryRun: false });
    expect(applied[0]).toMatchObject({
      success: true,
      sessionId: sessionB.id,
      sourceWorkspace: fixture.projectB,
      dryRun: false,
    });
  });

  it('applies workspace membership checks to direct IDs and rejects zero as an index', async () => {
    const fixture = newFixture();
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);

    const direct = await migrateLibrarySession(
      sessionConfig(fixture, destination, sessionA.id, {
        workspace: fixture.projectA,
        dryRun: true,
      })
    );
    expect(direct[0]).toMatchObject({ success: true, sessionId: sessionA.id });

    const before = mutationSnapshot(fixture);
    await expectTypedRefusal(
      migrateLibrarySession(
        sessionConfig(fixture, destination, sessionB.id, {
          workspace: fixture.projectA,
          dryRun: false,
        })
      ),
      'SESSION_SCOPE_MISMATCH'
    );
    expect(mutationSnapshot(fixture)).toBe(before);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, 0, {
          workspace: fixture.projectA,
          dryRun: true,
        })
      )
    ).rejects.toThrow();
  });

  it('applies a Composer session linked only through global storage', async () => {
    const fixture = newFixture();
    const globalOnly = composerSession(
      fixture,
      '33333333-0000-4000-8000-000000000016',
      'Global-only migration target'
    );
    const sourceDbPath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-a',
      fixture.projectA,
      []
    );
    writeComposerGlobalSessions(fixture, [globalOnly]);
    const destination = addDestination(fixture);
    const destinationDbPath = join(
      fixture.workspaceStorage,
      'workspace-destination',
      'state.vscdb'
    );

    const [result] = await migrateLibrarySession(
      sessionConfig(fixture, destination, globalOnly.id, {
        workspace: fixture.projectA,
      })
    );

    expect(result).toMatchObject({
      success: true,
      sessionId: globalOnly.id,
      sourceWorkspace: fixture.projectA,
    });
    expect(readComposerIds(sourceDbPath)).toEqual([]);
    expect(readComposerIds(destinationDbPath)).toEqual([globalOnly.id]);
  });
});

describe.sequential('atomic multi-target migration', () => {
  it('applies two bound sessions to one destination without invalidating the second plan', async () => {
    const fixture = newFixture();
    const sessions = twoComposerSessions(fixture);
    const sourceDbPath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-a',
      fixture.projectA,
      sessions
    );
    writeComposerGlobalSessions(fixture, sessions);
    const destination = addDestination(fixture);
    const destinationDbPath = join(
      fixture.workspaceStorage,
      'workspace-destination',
      'state.vscdb'
    );

    const results = await migrateLibrarySession(
      sessionConfig(
        fixture,
        destination,
        sessions.map((session) => session.id),
        { workspace: fixture.projectA }
      )
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.success)).toBe(true);
    expect(readComposerIds(sourceDbPath)).toEqual([]);
    expect(readComposerIds(destinationDbPath).sort()).toEqual(
      sessions.map((session) => session.id).sort()
    );
  });

  it('applies a workspace-wide multi-session plan against evolving destination state', async () => {
    const fixture = newFixture();
    const sessions = twoComposerSessions(fixture);
    const sourceDbPath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-a',
      fixture.projectA,
      sessions
    );
    writeComposerGlobalSessions(fixture, sessions);
    const destination = addDestination(fixture);
    const destinationDbPath = join(
      fixture.workspaceStorage,
      'workspace-destination',
      'state.vscdb'
    );

    const result = await migrateLibraryWorkspace({
      source: fixture.projectA,
      destination,
      dataPath: fixture.workspaceStorage,
    });

    expect(result).toMatchObject({ success: true, totalSessions: 2, successCount: 2 });
    expect(readComposerIds(sourceDbPath)).toEqual([]);
    expect(readComposerIds(destinationDbPath).sort()).toEqual(
      sessions.map((session) => session.id).sort()
    );
  });

  it('rolls back every earlier write when a later destination CAS fails', async () => {
    const fixture = newFixture();
    const sessions = twoComposerSessions(fixture);
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, sessions);
    writeComposerGlobalSessions(fixture, sessions);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);
    let composerWriteCount = 0;
    const failLaterDriver: DatabaseDriver = {
      name: 'better-sqlite3',
      async isAvailable() {
        return true;
      },
      async getCapabilityProfile() {
        return {
          driver: 'better-sqlite3',
          available: true,
          capabilities: new Set(['read', 'readWrite'] as const),
        };
      },
      open(path, options) {
        const db = new BetterSqlite3(path, {
          readonly: options.readonly,
          fileMustExist: true,
        });
        return {
          prepare(sql) {
            const statement = db.prepare(sql);
            return {
              get: (...params: unknown[]) => statement.get(...params),
              all: (...params: unknown[]) => statement.all(...params) as unknown[],
              run: (...params: unknown[]) => {
                if (
                  /(?:UPDATE ItemTable|INSERT OR REPLACE INTO ItemTable|DELETE FROM ItemTable)/i.test(
                    sql
                  ) &&
                  params.some((value) => value === 'composer.composerData')
                ) {
                  composerWriteCount++;
                  if (composerWriteCount === 3) {
                    throw new Error('synthetic later destination failure');
                  }
                }
                const result = statement.run(...params);
                return {
                  changes: result.changes,
                  lastInsertRowid: result.lastInsertRowid,
                };
              },
            };
          },
          runSQL(sql) {
            db.exec(sql);
          },
          close() {
            db.close();
          },
        };
      },
      async backup() {
        throw new Error('not used');
      },
    };
    registry.reset();
    registry.register(failLaterDriver);
    registry.setDriver('better-sqlite3');

    const results = await migrateLibrarySession(
      sessionConfig(
        fixture,
        destination,
        sessions.map((session) => session.id),
        { workspace: fixture.projectA }
      )
    );
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      sessions.map((session) =>
        expect.objectContaining({
          success: false,
          sessionId: session.id,
          sourceWorkspace: fixture.projectA,
          error: 'synthetic later destination failure',
        })
      )
    );
    expect(composerWriteCount).toBe(3);
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('continues source and global compensation after the first restore failure', async () => {
    const fixture = newFixture();
    const sessions = twoComposerSessions(fixture);
    const sourceDbPath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-a',
      fixture.projectA,
      sessions
    );
    writeComposerGlobalSessions(fixture, sessions);
    const destination = addDestination(fixture);
    const destinationDbPath = join(
      fixture.workspaceStorage,
      'workspace-destination',
      'state.vscdb'
    );
    const before = mutationSnapshot(fixture);
    const globalBefore = globalMutationSnapshot(fixture);
    let destinationCommitFailed = false;
    let destinationRestoreFailed = false;
    const failApplyAndFirstRestoreDriver: DatabaseDriver = {
      name: 'better-sqlite3',
      async isAvailable() {
        return true;
      },
      async getCapabilityProfile() {
        return {
          driver: 'better-sqlite3',
          available: true,
          capabilities: new Set(['read', 'readWrite'] as const),
        };
      },
      open(path, options) {
        const db = new BetterSqlite3(path, {
          readonly: options.readonly,
          fileMustExist: true,
        });
        return {
          prepare(sql) {
            const statement = db.prepare(sql);
            return {
              get: (...params: unknown[]) => statement.get(...params),
              all: (...params: unknown[]) => statement.all(...params) as unknown[],
              run: (...params: unknown[]) => {
                if (
                  path === destinationDbPath &&
                  /INSERT OR REPLACE INTO ItemTable/i.test(sql) &&
                  params.some((value) => value === 'composer.composerData')
                ) {
                  destinationRestoreFailed = true;
                  throw new Error('synthetic first compensation failure');
                }
                const result = statement.run(...params);
                return {
                  changes: result.changes,
                  lastInsertRowid: result.lastInsertRowid,
                };
              },
            };
          },
          runSQL(sql) {
            if (path === destinationDbPath && /^COMMIT$/i.test(sql.trim())) {
              db.exec(sql);
              destinationCommitFailed = true;
              throw new Error('synthetic later commit failure');
            }
            db.exec(sql);
          },
          close() {
            db.close();
          },
        };
      },
      async backup() {
        throw new Error('not used');
      },
    };
    registry.reset();
    registry.register(failApplyAndFirstRestoreDriver);
    registry.setDriver('better-sqlite3');

    const failure = await captureRejection(
      migrateLibrarySession(
        sessionConfig(
          fixture,
          destination,
          sessions.map((session) => session.id),
          { workspace: fixture.projectA }
        )
      )
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBeInstanceOf(Error);
    expect((aggregate.cause as Error).message).toBe('synthetic later commit failure');
    expect(aggregate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'synthetic later commit failure' }),
        expect.objectContaining({
          message: 'Migration compensation failed for workspace batch snapshot.',
        }),
      ])
    );
    expect(destinationCommitFailed).toBe(true);
    expect(destinationRestoreFailed).toBe(true);
    expect(readComposerIds(sourceDbPath).sort()).toEqual(
      sessions.map((session) => session.id).sort()
    );
    expect(globalMutationSnapshot(fixture)).toBe(globalBefore);
    expect(mutationSnapshot(fixture)).not.toBe(before);
  });
});

describe.sequential('legacy and operation-bound migration regressions', () => {
  it('routes the legacy single-session API through the same bound preview and apply target', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      '55555555-0000-4000-8000-000000000016',
      'Legacy core target'
    );
    const sourcePath = writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [
      session,
    ]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const destinationPath = join(fixture.workspaceStorage, 'workspace-destination', 'state.vscdb');
    const before = mutationSnapshot(fixture);

    const preview = await migrationModule.migrateSession(session.id, {
      destination,
      mode: 'move',
      dryRun: true,
      force: false,
      dataPath: fixture.workspaceStorage,
      sourceWorkspacePath: fixture.projectA,
    });
    expect(preview).toMatchObject({
      success: true,
      sessionId: session.id,
      sourceWorkspace: fixture.projectA,
      destinationWorkspace: destination,
      dryRun: true,
      eligibility: 'eligible-composer',
    });
    expect(mutationSnapshot(fixture)).toBe(before);

    const applied = await migrationModule.migrateSession(session.id, {
      destination,
      mode: 'move',
      dryRun: false,
      force: false,
      dataPath: fixture.workspaceStorage,
      sourceWorkspacePath: fixture.projectA,
    });
    expect(applied).toMatchObject({
      success: true,
      sessionId: preview.sessionId,
      targetFingerprint: preview.targetFingerprint,
      dryRun: false,
    });
    expect(readComposerIds(sourcePath)).toEqual([]);
    expect(readComposerIds(destinationPath)).toEqual([session.id]);
  });

  it('binds every legacy sessionIds member before applying the atomic batch', async () => {
    const fixture = newFixture();
    const sessions = twoComposerSessions(fixture);
    const sourcePath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-a',
      fixture.projectA,
      sessions
    );
    writeComposerGlobalSessions(fixture, sessions);
    const destination = addDestination(fixture);
    const destinationPath = join(fixture.workspaceStorage, 'workspace-destination', 'state.vscdb');

    const results = await migrationModule.migrateSessions({
      sessionIds: sessions.map((session) => session.id),
      workspacePath: fixture.projectA,
      destination,
      mode: 'move',
      dryRun: false,
      force: false,
      dataPath: fixture.workspaceStorage,
    });
    expect(results.map((result) => result.sessionId)).toEqual(
      sessions.map((session) => session.id)
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect(readComposerIds(sourcePath)).toEqual([]);
    expect(readComposerIds(destinationPath).sort()).toEqual(
      sessions.map((session) => session.id).sort()
    );
  });

  it('returns ordered legacy failure results and performs zero writes when a later ID is missing', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      '66666666-0000-4000-8000-000000000016',
      'Valid batch member'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const missing = '77777777-0000-4000-8000-000000000016';
    const before = mutationSnapshot(fixture);

    const results = await migrationModule.migrateSessions({
      sessionIds: [session.id, missing],
      workspacePath: fixture.projectA,
      destination,
      mode: 'move',
      dryRun: false,
      force: false,
      dataPath: fixture.workspaceStorage,
    });
    expect(results).toEqual([
      expect.objectContaining({ success: false, sessionId: session.id }),
      expect.objectContaining({ success: false, sessionId: missing }),
    ]);
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('keeps one resolved limits map when the caller mutates its override after binding starts', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      '88888888-0000-4000-8000-000000000016',
      'Frozen limits target'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const override: SourceReadLimitsOverride = { sqliteValueBytes: 1_048_576 };
    let mutated = false;
    const driver = hookedBetterSqliteDriver({
      beforeOpen() {
        if (mutated) return;
        mutated = true;
        override.sqliteValueBytes = 1;
      },
    });
    registry.reset();
    registry.register(driver);

    const [result] = await migrateLibrarySession(
      sessionConfig(fixture, destination, session.id, {
        workspace: fixture.projectA,
        sourceReadLimits: override,
      })
    );
    expect(mutated).toBe(true);
    expect(override.sqliteValueBytes).toBe(1);
    expect(result).toMatchObject({ success: true, sessionId: session.id });
  });

  it('keeps using the provider selected at operation start when process preference changes mid-read', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      '89898989-0000-4000-8000-000000000016',
      'Frozen provider target'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    let betterOpens = 0;
    let nodeOpens = 0;
    let switched = false;
    const selected = hookedBetterSqliteDriver({
      beforeOpen() {
        betterOpens++;
        if (switched) return;
        switched = true;
        registry.setDriver('node:sqlite');
      },
    });
    const retargeted: DatabaseDriver = {
      name: 'node:sqlite',
      async isAvailable() {
        return true;
      },
      async getCapabilityProfile() {
        return {
          driver: 'node:sqlite',
          available: true,
          capabilities: new Set(['read', 'readWrite'] as const),
        };
      },
      open() {
        nodeOpens++;
        throw new Error('operation retargeted to node:sqlite');
      },
      async backup() {
        throw new Error('not used');
      },
    };
    registry.reset();
    registry.register(selected);
    registry.register(retargeted);
    registry.setDriver('better-sqlite3');

    const [result] = await migrateLibrarySession(
      sessionConfig(fixture, destination, session.id, { workspace: fixture.projectA })
    );
    expect(result).toMatchObject({ success: true, sessionId: session.id });
    expect(switched).toBe(true);
    expect(betterOpens).toBeGreaterThan(1);
    expect(nodeOpens).toBe(0);
  });

  it('propagates cancellation raised during Composer membership inventory with zero writes', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      '99999999-0000-4000-8000-000000000016',
      'Abort inventory target'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const controller = new AbortController();
    let abortedDuringInventory = false;
    const driver = hookedBetterSqliteDriver({
      beforeAll(_path, sql) {
        if (
          abortedDuringInventory ||
          !sql.includes('FROM ItemTable') ||
          !sql.includes('WHERE key LIKE ?')
        )
          return;
        abortedDuringInventory = true;
        controller.abort();
      },
    });
    registry.reset();
    registry.register(driver);
    const before = mutationSnapshot(fixture);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, {
          workspace: fixture.projectA,
          signal: controller.signal,
        })
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedDuringInventory).toBe(true);
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('rejects replacement of the captured global database even when rows are recreated identically', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'aaaaaaaa-1111-4000-8000-000000000016',
      'Global replacement target'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    const globalPath = writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [session.id],
        { numericBase: 1 },
        context
      );
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'move',
        dataPath: fixture.workspaceStorage,
      });
      const originalInode = statSync(globalPath).ino;
      renameSync(globalPath, `${globalPath}.replaced`);
      writeComposerGlobalSessions(fixture, [session]);
      expect(statSync(globalPath).ino).not.toBe(originalInode);
      const afterReplacement = mutationSnapshot(fixture);

      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        code: 'MIGRATION_TARGET_CHANGED',
      });
      expect(mutationSnapshot(fixture)).toBe(afterReplacement);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('rechecks Store membership before apply and refuses a newly merged target', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'abababab-1111-4000-8000-000000000016',
      'Late Store occurrence target'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [session.id],
        { numericBase: 1 },
        context
      );
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'move',
        dataPath: fixture.workspaceStorage,
      });
      addStoreConversation(fixture, session.id, fixture.projectA, 'late Store content');
      const afterStoreAppeared = mutationSnapshot(fixture);

      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        code: 'MIGRATION_TARGET_CHANGED',
      });
      expect(mutationSnapshot(fixture)).toBe(afterStoreAppeared);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('compares the destination snapshot with the prepared fingerprint before staging writes', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'bbbbbbbb-1111-4000-8000-000000000016',
      'Destination race target'
    );
    const sourcePath = writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [
      session,
    ]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const destinationPath = join(fixture.workspaceStorage, 'workspace-destination', 'state.vscdb');
    const externalId = 'cccccccc-1111-4000-8000-000000000016';
    let destinationWriteOpenCount = 0;
    let mutated = false;
    const driver = hookedBetterSqliteDriver({
      beforeOpen(path, readonly) {
        if (readonly || path !== destinationPath) return;
        destinationWriteOpenCount++;
        if (destinationWriteOpenCount !== 3) return;
        const db = new BetterSqlite3(destinationPath);
        try {
          db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'").run(
            JSON.stringify({
              allComposers: [
                {
                  composerId: externalId,
                  name: 'External destination mutation',
                  createdAt: 1,
                  lastUpdatedAt: 1,
                },
              ],
            })
          );
          mutated = true;
        } finally {
          db.close();
        }
      },
    });
    registry.reset();
    registry.register(driver);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, { workspace: fixture.projectA })
      )
    ).rejects.toMatchObject({ code: 'MIGRATION_TARGET_CHANGED' });
    expect(mutated).toBe(true);
    expect(readComposerIds(sourcePath)).toEqual([session.id]);
    expect(readComposerIds(destinationPath)).toEqual([externalId]);
  });

  it('locks the destination before its final CAS so a boundary writer cannot be overwritten', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'bcbcbcbc-1111-4000-8000-000000000016',
      'First-write boundary target'
    );
    const sourcePath = writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [
      session,
    ]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const destinationPath = join(fixture.workspaceStorage, 'workspace-destination', 'state.vscdb');
    let attempted = false;
    let blocked = false;
    const driver = hookedBetterSqliteDriver({
      beforeRun(path, sql) {
        if (
          attempted ||
          path !== destinationPath ||
          !/UPDATE ItemTable SET value = \? WHERE key = \? AND value = \?/i.test(sql)
        ) {
          return;
        }
        attempted = true;
        const external = new BetterSqlite3(destinationPath, { timeout: 0 });
        try {
          external
            .prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'")
            .run(
              JSON.stringify({
                allComposers: [
                  {
                    composerId: 'race-writer-session',
                    name: 'Must not be overwritten',
                  },
                ],
              })
            );
        } catch (error) {
          blocked =
            error instanceof Error &&
            (error.message.includes('database is locked') || error.message.includes('SQLITE_BUSY'));
        } finally {
          external.close();
        }
      },
    });
    registry.reset();
    registry.register(driver);

    const results = await migrateLibrarySession(
      sessionConfig(fixture, destination, session.id, { workspace: fixture.projectA })
    );

    expect(results).toEqual([expect.objectContaining({ success: true, sessionId: session.id })]);
    expect(attempted).toBe(true);
    expect(blocked).toBe(true);
    expect(readComposerIds(sourcePath)).toEqual([]);
    expect(readComposerIds(destinationPath)).toEqual([session.id]);
  });
});

describe.sequential('migration preparation policy', () => {
  it('ignores an unrelated valid workspace database that has no ItemTable', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'cececece-2222-4000-8000-000000000016',
      'Missing unrelated ItemTable'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const unrelatedPath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-b',
      fixture.projectB,
      []
    );
    const unrelated = new BetterSqlite3(unrelatedPath);
    try {
      unrelated.exec('DROP TABLE ItemTable; CREATE TABLE unrelated (value TEXT)');
    } finally {
      unrelated.close();
    }
    const destination = addDestination(fixture);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, {
          workspace: fixture.projectA,
          dryRun: true,
        })
      )
    ).resolves.toEqual([
      expect.objectContaining({ success: true, sessionId: session.id, dryRun: true }),
    ]);
  });

  it('resets SQLite aggregate counters at each catalog and logical hydration boundary', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'cdcdcdcd-2222-4000-8000-000000000016',
      'Per-catalog limit reset'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    const destination = addDestination(fixture);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, {
          workspace: fixture.projectA,
          dryRun: true,
          sourceReadLimits: { sqlitePageRows: 1, sqliteRowCount: 1 },
        })
      )
    ).resolves.toEqual([
      expect.objectContaining({
        success: true,
        sessionId: session.id,
        dryRun: true,
      }),
    ]);
  });

  it('validates session/workspace sourceReadLimits before source reads and propagates valid overrides', async () => {
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    const invalid = { sqliteValueBytes: 0 } as unknown as SourceReadLimitsOverride;
    const unreadableDataPath = join(fixture.root, 'must-not-be-read-before-limit-validation');
    await expectTypedRefusal(
      migrateLibrarySession({
        ...sessionConfig(fixture, destination, sessionA.id, {
          workspace: fixture.projectA,
          sourceReadLimits: invalid,
        }),
        dataPath: unreadableDataPath,
      }),
      'SOURCE_LIMIT_CONFIGURATION_INVALID'
    );
    await expect(
      migrateLibraryWorkspace({
        source: fixture.projectA,
        destination,
        dataPath: unreadableDataPath,
        sourceReadLimits: invalid,
      } as FeatureMigrateWorkspaceConfig)
    ).rejects.toMatchObject({ code: 'SOURCE_LIMIT_CONFIGURATION_INVALID' });
    expect(mutationSnapshot(fixture)).toBe(before);

    const restrictive: SourceReadLimitsOverride = { sqliteValueBytes: 1 };
    await expectTypedRefusal(
      migrateLibrarySession(
        sessionConfig(fixture, destination, sessionA.id, {
          workspace: fixture.projectA,
          sourceReadLimits: restrictive,
        })
      ),
      'SOURCE_LIMIT_EXCEEDED'
    );
    await expect(
      migrateLibraryWorkspace({
        source: fixture.projectA,
        destination,
        dataPath: fixture.workspaceStorage,
        sourceReadLimits: restrictive,
      } as FeatureMigrateWorkspaceConfig)
    ).rejects.toMatchObject({ code: 'SOURCE_LIMIT_EXCEEDED' });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('fails an explicitly selected incapable driver during dry-run preflight with zero writes', async () => {
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);
    const readOnlyNodeDriver: DatabaseDriver = {
      name: 'node:sqlite',
      async isAvailable() {
        return true;
      },
      async getCapabilityProfile() {
        return {
          driver: 'node:sqlite',
          available: true,
          capabilities: new Set(['read'] as const),
        };
      },
      open(path, options) {
        const db = new BetterSqlite3(path, {
          readonly: options.readonly,
          fileMustExist: true,
        });
        return {
          prepare(sql) {
            const statement = db.prepare(sql);
            return {
              get: (...params: unknown[]) => statement.get(...params),
              all: (...params: unknown[]) => statement.all(...params) as unknown[],
              run: (...params: unknown[]) => {
                const result = statement.run(...params);
                return {
                  changes: result.changes,
                  lastInsertRowid: result.lastInsertRowid,
                };
              },
            };
          },
          runSQL(sql) {
            db.exec(sql);
          },
          close() {
            db.close();
          },
        };
      },
      async backup() {
        throw new Error('not supported');
      },
    };
    registry.reset();
    registry.register(readOnlyNodeDriver);
    registry.register(betterSqlite3Driver);
    registry.setDriver('node:sqlite');

    const error = await captureRejection(
      migrateLibrarySession(
        sessionConfig(fixture, destination, sessionA.id, {
          workspace: fixture.projectA,
          dryRun: true,
        })
      )
    );
    expect(DatabaseCapabilityMissingError).toBe(DatabaseCapabilityError);
    expect(error).toBeInstanceOf(DatabaseCapabilityError);
    expect(error).toMatchObject({ code: 'DATABASE_CAPABILITY_MISSING' });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('throws the package-exported no-capable-driver class in automatic mode', async () => {
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);
    const readOnlyDriver: DatabaseDriver = {
      name: 'node:sqlite',
      async isAvailable() {
        return true;
      },
      async getCapabilityProfile() {
        return {
          driver: 'node:sqlite',
          available: true,
          capabilities: new Set(['read'] as const),
        };
      },
      open(path, options) {
        const db = new BetterSqlite3(path, {
          readonly: options.readonly,
          fileMustExist: true,
        });
        return {
          prepare(sql) {
            const statement = db.prepare(sql);
            return {
              get: (...params: unknown[]) => statement.get(...params),
              all: (...params: unknown[]) => statement.all(...params) as unknown[],
              run: (...params: unknown[]) => {
                const result = statement.run(...params);
                return {
                  changes: result.changes,
                  lastInsertRowid: result.lastInsertRowid,
                };
              },
            };
          },
          runSQL(sql) {
            db.exec(sql);
          },
          close() {
            db.close();
          },
        };
      },
      async backup() {
        throw new Error('not supported');
      },
    };
    registry.reset();
    registry.register(readOnlyDriver);

    const error = await captureRejection(
      migrateLibrarySession(
        sessionConfig(fixture, destination, sessionA.id, {
          workspace: fixture.projectA,
          dryRun: true,
        })
      )
    );
    expect(NoCapableDatabaseDriverError).toBe(NoCapableDriverError);
    expect(error).toBeInstanceOf(NoCapableDriverError);
    expect(error).toMatchObject({ code: 'NO_CAPABLE_DATABASE_DRIVER' });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('rejects a fingerprint race instead of rediscovering a different target', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const createContext = storage.createSessionReadContext as unknown as (
      options: Record<string, unknown>
    ) => unknown;
    const context = createContext({
      dataPath: fixture.workspaceStorage,
      workspacePath: fixture.projectA,
      resolvedSessionCapacity: 0,
    });

    try {
      const targets = await pipeline.bindMigrationTargets([1], { numericBase: 1 }, context);
      expect(targets).toEqual([
        expect.objectContaining({
          logicalSessionId: sessionA.id,
          sourceWorkspacePath: fixture.projectA,
        }),
      ]);
      const prepared = await pipeline.prepareSessionMigration(targets[0]!, destination, {
        mode: 'move',
        dataPath: fixture.workspaceStorage,
      });

      const sourcePath = join(fixture.workspaceStorage, 'workspace-a', 'state.vscdb');
      const sourceDb = new BetterSqlite3(sourcePath);
      try {
        const row = sourceDb
          .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
          .get() as { value: string };
        const parsed = JSON.parse(row.value) as {
          allComposers: Array<Record<string, unknown>>;
        };
        parsed.allComposers[0]!['name'] = 'Changed after preview';
        sourceDb
          .prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'")
          .run(JSON.stringify(parsed));
      } finally {
        sourceDb.close();
      }
      const afterExternalMutation = mutationSnapshot(fixture);

      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        code: 'MIGRATION_TARGET_CHANGED',
      });
      expect(mutationSnapshot(fixture)).toBe(afterExternalMutation);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('deep-freezes the locator and rejects an exact record reordered after preparation', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const sessions = twoComposerSessions(fixture);
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, sessions);
    writeComposerGlobalSessions(fixture, sessions);
    const destination = addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const targets = await pipeline.bindMigrationTargets(
        [sessions[0]!.id],
        { numericBase: 1 },
        context
      );
      const frozenTarget = targets[0] as ContractMigrationTarget & {
        composerLocator: object;
      };
      expect(Object.isFrozen(frozenTarget)).toBe(true);
      expect(Object.isFrozen(frozenTarget.composerLocator)).toBe(true);
      const prepared = await pipeline.prepareSessionMigration(frozenTarget, destination, {
        mode: 'move',
        dataPath: fixture.workspaceStorage,
      });

      writeComposerWorkspaceSummary(
        fixture,
        'workspace-a',
        fixture.projectA,
        [...sessions].reverse()
      );
      const afterReorder = mutationSnapshot(fixture);
      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        code: 'MIGRATION_TARGET_CHANGED',
      });
      expect(mutationSnapshot(fixture)).toBe(afterReorder);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('revalidates the exact bound index during preparation before producing a plan', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const sessions = twoComposerSessions(fixture);
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, sessions);
    writeComposerGlobalSessions(fixture, sessions);
    const destination = addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [sessions[0]!.id],
        { numericBase: 1 },
        context
      );
      writeComposerWorkspaceSummary(
        fixture,
        'workspace-a',
        fixture.projectA,
        [...sessions].reverse()
      );
      const afterReorder = mutationSnapshot(fixture);

      await expect(
        pipeline.prepareSessionMigration(target!, destination, {
          mode: 'move',
          dataPath: fixture.workspaceStorage,
        })
      ).rejects.toMatchObject({ code: 'MIGRATION_TARGET_CHANGED' });
      expect(mutationSnapshot(fixture)).toBe(afterReorder);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('rejects replacement of the bound physical database even when its row bytes are identical', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const session = composerSession(fixture, SESSION_INTEGRITY_IDS.workspaceA, 'Replacement');
    const sourcePath = writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [
      session,
    ]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [session.id],
        { numericBase: 1 },
        context
      );
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'move',
        dataPath: fixture.workspaceStorage,
      });

      renameSync(sourcePath, `${sourcePath}.replaced`);
      writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
      const afterReplacement = mutationSnapshot(fixture);
      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        code: 'MIGRATION_TARGET_CHANGED',
      });
      expect(mutationSnapshot(fixture)).toBe(afterReplacement);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('rejects replacement of the prepared destination database with identical content', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'abababab-2222-4000-8000-000000000016',
      'Destination replacement'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const destinationPath = join(fixture.workspaceStorage, 'workspace-destination', 'state.vscdb');
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [session.id],
        { numericBase: 1 },
        context
      );
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'move',
        dataPath: fixture.workspaceStorage,
      });

      const originalInode = statSync(destinationPath).ino;
      renameSync(destinationPath, `${destinationPath}.replaced`);
      writeComposerWorkspaceSummary(fixture, 'workspace-destination', destination, []);
      expect(statSync(destinationPath).ino).not.toBe(originalInode);
      const afterReplacement = mutationSnapshot(fixture);

      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        code: 'MIGRATION_TARGET_CHANGED',
      });
      expect(mutationSnapshot(fixture)).toBe(afterReplacement);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('enforces source limits on global Composer and bubble hydration reads', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const session = composerSession(fixture, SESSION_INTEGRITY_IDS.workspaceA, 'Bounded global');
    session.messages = [
      {
        id: 'large-global-bubble',
        role: 'user',
        content: 'x'.repeat(16_384),
      },
    ];
    const sourcePath = writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [
      session,
    ]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const destinationPath = join(fixture.workspaceStorage, 'workspace-destination', 'state.vscdb');
    const composerValueBytes = [sourcePath, destinationPath].map((databasePath) => {
      const db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare(
            "SELECT length(CAST(value AS BLOB)) AS valueBytes FROM ItemTable WHERE key = 'composer.composerData'"
          )
          .get() as { valueBytes: number };
        return Number(row.valueBytes);
      } finally {
        db.close();
      }
    });
    const valueLimit = Math.max(...composerValueBytes) + 128;
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    const before = mutationSnapshot(fixture);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [session.id],
        { numericBase: 1 },
        context
      );
      await expect(
        pipeline.prepareSessionMigration(target!, destination, {
          mode: 'move',
          dataPath: fixture.workspaceStorage,
          sourceReadLimits: { sqliteValueBytes: valueLimit },
        })
      ).rejects.toMatchObject({
        code: 'SOURCE_LIMIT_EXCEEDED',
        details: expect.objectContaining({ bound: 'sqlite-value-bytes' }),
      });
      expect(mutationSnapshot(fixture)).toBe(before);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('rejects invalid UTF-8 in a prepared destination catalog before any write', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'dededede-2222-4000-8000-000000000016',
      'Invalid destination UTF-8'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const destinationPath = join(fixture.workspaceStorage, 'workspace-destination', 'state.vscdb');
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [session.id],
        { numericBase: 1 },
        context
      );
      const db = new BetterSqlite3(destinationPath);
      try {
        db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'").run(
          Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])
        );
      } finally {
        db.close();
      }
      const before = mutationSnapshot(fixture);

      await expect(
        pipeline.prepareSessionMigration(target!, destination, {
          mode: 'move',
          dataPath: fixture.workspaceStorage,
        })
      ).rejects.toMatchObject({
        code: 'SOURCE_ENCODING_INVALID',
        details: { sourceKind: 'sqlite', outcome: 'fatal' },
      });
      expect(mutationSnapshot(fixture)).toBe(before);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('propagates malformed global payload errors instead of silently dropping hydration', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const session = composerSession(fixture, SESSION_INTEGRITY_IDS.workspaceA, 'Malformed global');
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const globalDb = new BetterSqlite3(join(fixture.globalStorage, 'state.vscdb'));
    try {
      globalDb
        .prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?')
        .run('{malformed-json', `composerData:${session.id}`);
    } finally {
      globalDb.close();
    }
    addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    const before = mutationSnapshot(fixture);
    try {
      await expect(
        pipeline.bindMigrationTargets([session.id], { numericBase: 1 }, context)
      ).rejects.toBeInstanceOf(SyntaxError);
      expect(mutationSnapshot(fixture)).toBe(before);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('rechecks cancellation before apply and performs zero writes', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const controller = new AbortController();
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [sessionA.id],
        { numericBase: 1 },
        context
      );
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'move',
        dataPath: fixture.workspaceStorage,
        signal: controller.signal,
      });
      controller.abort();
      const before = mutationSnapshot(fixture);
      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(mutationSnapshot(fixture)).toBe(before);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('rejects a proposed copy UUID that collides in global storage after preparation', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [sessionA.id],
        { numericBase: 1 },
        context
      );
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'copy',
        dataPath: fixture.workspaceStorage,
      });
      const copyId = (prepared as { proposedCopySessionId?: string }).proposedCopySessionId;
      expect(copyId).toMatch(/^[0-9a-f-]{36}$/);
      const globalDb = new BetterSqlite3(join(fixture.globalStorage, 'state.vscdb'));
      try {
        globalDb
          .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
          .run(`composerData:${copyId}`, JSON.stringify({ composerId: copyId }));
      } finally {
        globalDb.close();
      }
      const afterCollision = mutationSnapshot(fixture);

      await expect(pipeline.applySessionMigration(prepared)).rejects.toMatchObject({
        code: 'MIGRATION_TARGET_CHANGED',
      });
      expect(mutationSnapshot(fixture)).toBe(afterCollision);
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('checks generated copy UUIDs during preparation before accepting a proposal', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    const storeOnlyCopyId = '33333333-0000-4000-8000-000000000016';
    const uniqueCopyId = '44444444-0000-4000-8000-000000000016';
    const candidates = [storeOnlyCopyId, sessionB.id, uniqueCopyId];
    let calls = 0;
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [sessionA.id],
        { numericBase: 1 },
        context
      );
      // A directory occurrence alone is sufficient Store catalog evidence.
      // Do not add meta.json, store.db, or transcript content: collision
      // resolution must remain metadata-only.
      mkdirSync(join(fixture.storeRoot, 'chats', 'collision-hash', storeOnlyCopyId), {
        recursive: true,
      });
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'copy',
        dataPath: fixture.workspaceStorage,
        uuidFactory: () => candidates[calls++]!,
      });

      expect(calls).toBe(3);
      expect((prepared as { proposedCopySessionId?: string }).proposedCopySessionId).toBe(
        uniqueCopyId
      );
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });

  it('rejects a generated copy UUID that collides with the compact chats layout', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const destination = addDestination(fixture);
    const compactCollisionId = '55555555-0000-4000-8000-000000000016';
    const uniqueCopyId = '66666666-0000-4000-8000-000000000016';
    const compactStoreDir = join(
      fixture.storeRoot,
      'chats',
      compactCollisionId.replaceAll('-', '')
    );
    mkdirSync(compactStoreDir, { recursive: true });
    writeFileSync(join(compactStoreDir, 'store.db'), 'metadata-only collision marker');
    const context = storage.createSessionReadContext(fixture.workspaceStorage);
    let calls = 0;
    try {
      const [target] = await pipeline.bindMigrationTargets(
        [sessionA.id],
        { numericBase: 1 },
        context
      );
      const prepared = await pipeline.prepareSessionMigration(target!, destination, {
        mode: 'copy',
        dataPath: fixture.workspaceStorage,
        uuidFactory: () => [compactCollisionId, uniqueCopyId][calls++]!,
      });

      expect(calls).toBe(2);
      expect((prepared as { proposedCopySessionId?: string }).proposedCopySessionId).toBe(
        uniqueCopyId
      );
    } finally {
      await (context as { dispose?: () => Promise<void> }).dispose?.();
    }
  });
});

describe.sequential('ambiguous and unsupported migration targets', () => {
  it.each([
    {
      name: 'multiple equivalent Composer locators in one workspace',
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      setup(fixture: SessionIntegrityFixtureRoot) {
        const duplicate = composerSession(fixture, SESSION_INTEGRITY_IDS.duplicate, 'Equivalent');
        writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [duplicate]);
        writeComposerWorkspaceSummary(fixture, 'workspace-a-copy', fixture.projectA, [duplicate]);
        writeComposerGlobalSessions(fixture, [duplicate]);
        return duplicate.id;
      },
    },
    {
      name: 'one global Composer footprint shared by two workspace memberships',
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      setup(fixture: SessionIntegrityFixtureRoot) {
        const shared = composerSession(fixture, SESSION_INTEGRITY_IDS.duplicate, 'Shared');
        writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [shared]);
        writeComposerWorkspaceSummary(fixture, 'workspace-b', fixture.projectB, [shared]);
        writeComposerGlobalSessions(fixture, [shared]);
        return shared.id;
      },
    },
    {
      name: 'divergent Composer replicas',
      code: 'SESSION_AMBIGUOUS',
      setup(fixture: SessionIntegrityFixtureRoot) {
        const left = composerSession(fixture, SESSION_INTEGRITY_IDS.duplicate, 'Divergent left');
        const right = composerSession(fixture, SESSION_INTEGRITY_IDS.duplicate, 'Divergent right');
        writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [left]);
        writeComposerWorkspaceSummary(fixture, 'workspace-a-copy', fixture.projectA, [right]);
        return left.id;
      },
    },
    {
      name: 'Store-only logical session',
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      setup(fixture: SessionIntegrityFixtureRoot) {
        addStoreConversation(
          fixture,
          SESSION_INTEGRITY_IDS.storeOnly,
          fixture.projectA,
          'store-only content'
        );
        return SESSION_INTEGRITY_IDS.storeOnly;
      },
    },
    {
      name: 'merged Composer/Store logical session',
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      setup(fixture: SessionIntegrityFixtureRoot) {
        const merged = composerSession(fixture, SESSION_INTEGRITY_IDS.workspaceA, 'Composer half');
        writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [merged]);
        writeComposerGlobalSessions(fixture, [merged]);
        addStoreConversation(fixture, merged.id, fixture.projectA, 'Store half');
        return merged.id;
      },
    },
  ])('refuses $name before any write', async ({ setup, code }) => {
    const fixture = newFixture();
    const sessionId = setup(fixture);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    await expectTypedRefusal(
      migrateLibrarySession(
        sessionConfig(fixture, destination, sessionId, {
          workspace: fixture.projectA,
          dryRun: false,
        })
      ),
      code
    );
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('reuses an ambiguous scoped row index and returns the same typed occurrence diagnostics', async () => {
    const pipeline = requireMigrationPipeline();
    const fixture = newFixture();
    const sessionId = 'dddddddd-1111-4000-8000-000000000016';
    const left = composerSession(fixture, sessionId, 'Divergent indexed left');
    const right = composerSession(fixture, sessionId, 'Divergent indexed right');
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [left]);
    writeComposerWorkspaceSummary(fixture, 'workspace-a-copy', fixture.projectA, [right]);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    const directError = await captureRejection(
      pipeline.bindMigrationTargets(
        [sessionId],
        {
          numericBase: 1,
          workspacePath: fixture.projectA,
          dataPath: fixture.workspaceStorage,
        },
        undefined
      )
    );
    const numericError = await captureRejection(
      pipeline.bindMigrationTargets(
        [1],
        {
          numericBase: 1,
          workspacePath: fixture.projectA,
          dataPath: fixture.workspaceStorage,
        },
        undefined
      )
    );
    const libraryError = await captureRejection(
      migrateLibrarySession(
        sessionConfig(fixture, destination, 1, {
          workspace: fixture.projectA,
          dryRun: false,
        })
      )
    );

    for (const error of [directError, numericError, libraryError]) {
      expect(error).toMatchObject({
        code: 'SESSION_AMBIGUOUS',
        details: {
          sessionId,
          occurrenceCount: 2,
          occurrenceRefs: [
            expect.stringMatching(/^occurrence:v1:/u),
            expect.stringMatching(/^occurrence:v1:/u),
          ],
        },
      });
    }
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('rejects a filtered Composer target when the same UUID has a Store occurrence in another workspace', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'dddddddd-1111-4000-8000-000000000016',
      'Filtered Composer half'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    addStoreConversation(fixture, session.id, fixture.projectB, 'Off-scope Store half');
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    await expect(
      migrationModule.migrateSession(session.id, {
        destination,
        mode: 'move',
        dryRun: false,
        force: false,
        dataPath: fixture.workspaceStorage,
        sourceWorkspacePath: fixture.projectA,
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      details: expect.objectContaining({ eligibility: 'merged' }),
    });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('rejects a Composer target whose Store counterpart uses the compact chats layout', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'abababab-1111-4000-8000-000000000016',
      'Compact Store counterpart'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    const compactStoreDir = join(fixture.storeRoot, 'chats', session.id.replaceAll('-', ''));
    mkdirSync(compactStoreDir, { recursive: true });
    writeFileSync(join(compactStoreDir, 'store.db'), 'metadata-only collision marker');
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, { workspace: fixture.projectA })
      )
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      details: expect.objectContaining({ eligibility: 'merged' }),
    });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('rejects a global-only UUID whose pointer footprint is shared by two workspaces', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'eeeeeeee-1111-4000-8000-000000000016',
      'Shared pointer target'
    );
    const workspaceAPath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-a',
      fixture.projectA,
      []
    );
    const workspaceBPath = writeComposerWorkspaceSummary(
      fixture,
      'workspace-b',
      fixture.projectB,
      []
    );
    writeComposerGlobalSessions(fixture, [session]);
    for (const databasePath of [workspaceAPath, workspaceBPath]) {
      const db = new BetterSqlite3(databasePath);
      try {
        db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
          `fixture.composerChatViewPane.${session.id}`,
          JSON.stringify({ composerId: session.id })
        );
      } finally {
        db.close();
      }
    }
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, {
          workspace: fixture.projectA,
        })
      )
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      details: expect.objectContaining({ eligibility: 'shared-membership' }),
    });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('rejects an incomplete Store metadata inventory instead of admitting Composer-only migration', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      'ffffffff-1111-4000-8000-000000000016',
      'Incomplete Store inventory'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerGlobalSessions(fixture, [session]);
    writeFileSync(join(fixture.storeRoot, 'chats'), 'not a directory');
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, { workspace: fixture.projectA })
      )
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      details: expect.objectContaining({ eligibility: 'incomplete-store-inventory' }),
    });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it('rejects an incomplete Composer pointer inventory before any write', async () => {
    const fixture = newFixture();
    const session = composerSession(
      fixture,
      '12121212-1111-4000-8000-000000000016',
      'Incomplete Composer inventory'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    writeComposerWorkspaceSummary(fixture, 'workspace-b', fixture.projectB, []);
    writeComposerGlobalSessions(fixture, [session]);
    const destination = addDestination(fixture);
    const workspaceBPath = join(fixture.workspaceStorage, 'workspace-b', 'state.vscdb');
    const driver = hookedBetterSqliteDriver({
      beforeAll(path, sql) {
        if (
          path === workspaceBPath &&
          sql.includes('FROM ItemTable') &&
          sql.includes('WHERE key LIKE ?')
        ) {
          throw new Error('synthetic pointer inventory failure');
        }
      },
    });
    registry.reset();
    registry.register(driver);
    const before = mutationSnapshot(fixture);

    await expect(
      migrateLibrarySession(
        sessionConfig(fixture, destination, session.id, { workspace: fixture.projectA })
      )
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SESSION_MIGRATION',
      details: expect.objectContaining({ eligibility: 'incomplete-composer-inventory' }),
    });
    expect(mutationSnapshot(fixture)).toBe(before);
  });

  it.each([
    {
      name: 'Store-only workspace member',
      setup(fixture: SessionIntegrityFixtureRoot) {
        writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, []);
        addStoreConversation(
          fixture,
          SESSION_INTEGRITY_IDS.storeOnly,
          fixture.projectA,
          'store-only workspace content'
        );
      },
    },
    {
      name: 'merged Composer/Store workspace member',
      setup(fixture: SessionIntegrityFixtureRoot) {
        const merged = composerSession(fixture, SESSION_INTEGRITY_IDS.workspaceA, 'Composer half');
        writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [merged]);
        writeComposerGlobalSessions(fixture, [merged]);
        addStoreConversation(fixture, merged.id, fixture.projectA, 'Store half');
      },
    },
  ])('refuses workspace-wide migration of a $name without moving one half', async ({ setup }) => {
    const fixture = newFixture();
    setup(fixture);
    const destination = addDestination(fixture);
    const before = mutationSnapshot(fixture);

    await expectTypedRefusal(
      migrateLibraryWorkspace({
        source: fixture.projectA,
        destination,
        dataPath: fixture.workspaceStorage,
      }),
      'UNSUPPORTED_SESSION_MIGRATION'
    );
    expect(mutationSnapshot(fixture)).toBe(before);
  });
});
