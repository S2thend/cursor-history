import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySessionMigration,
  bindMigrationTargets,
  migrateSession,
  migrateSessions,
  migrateWorkspace,
  prepareSessionMigration,
} from '../../src/core/migrate.js';
import { registry } from '../../src/core/database/registry.js';
import { betterSqlite3Driver } from '../../src/core/database/drivers/better-sqlite3.js';
import { nodeSqliteDriver } from '../../src/core/database/drivers/node-sqlite.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const fixtures: SessionIntegrityFixtureRoot[] = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-migrate-unit-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function session(
  value: SessionIntegrityFixtureRoot,
  id = '11111111-2222-4333-8444-555555555555',
  workspacePath = value.projectA
): ComposerFixtureSession {
  return {
    id,
    title: `Session ${id.slice(0, 4)}`,
    workspacePath,
    createdAt: 1_700_000_000_000,
    messages: [{ id: `${id}-bubble`, role: 'user', content: 'hello' }],
  };
}

function destination(value: SessionIntegrityFixtureRoot): {
  path: string;
  databasePath: string;
} {
  const path = join(value.root, 'workspaces', 'destination');
  mkdirSync(path, { recursive: true });
  const databasePath = writeComposerWorkspaceSummary(value, 'workspace-destination', path, []);
  return { path, databasePath };
}

function composerIds(databasePath: string): string[] {
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

function globalRows(value: SessionIntegrityFixtureRoot): Array<{ key: string; value: string }> {
  const db = new BetterSqlite3(join(value.globalStorage, 'state.vscdb'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db.prepare('SELECT key, value FROM cursorDiskKV ORDER BY key').all() as Array<{
      key: string;
      value: string;
    }>;
  } finally {
    db.close();
  }
}

function overwriteBubbleWithPaths(
  value: SessionIntegrityFixtureRoot,
  target: ComposerFixtureSession,
  externalPath: string
): void {
  const bubbleId = target.messages[0]!.id!;
  const internalPath = join(target.workspacePath, 'src', 'inside.ts');
  const db = new BetterSqlite3(join(value.globalStorage, 'state.vscdb'));
  try {
    db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
      JSON.stringify({
        bubbleId,
        type: 1,
        text: 'path fixture',
        toolFormerData: {
          params: JSON.stringify({
            relativeWorkspacePath: internalPath,
            targetFile: externalPath,
          }),
        },
        codeBlocks: [
          {
            uri: {
              path: internalPath,
              _fsPath: internalPath,
              _formatted: `file://${internalPath}`,
            },
          },
        ],
      }),
      `bubbleId:${target.id}:${bubbleId}`
    );
  } finally {
    db.close();
  }
}

function readBubble(
  value: SessionIntegrityFixtureRoot,
  composerId: string
): Record<string, unknown> {
  const row = globalRows(value).find((candidate) =>
    candidate.key.startsWith(`bubbleId:${composerId}:`)
  );
  if (!row) throw new Error(`Missing bubble for ${composerId}`);
  return JSON.parse(row.value) as Record<string, unknown>;
}

afterEach(() => {
  registry.reset();
  registry.register(nodeSqliteDriver);
  registry.register(betterSqlite3Driver);
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  for (const value of fixtures.splice(0)) value.cleanup();
});

describe.sequential('migration prepared state machine', () => {
  it('exports the bind, prepare, and apply stages', () => {
    expect(bindMigrationTargets).toBeTypeOf('function');
    expect(prepareSessionMigration).toBeTypeOf('function');
    expect(applySessionMigration).toBeTypeOf('function');
  });

  it('uses one frozen target for dry-run and apply', async () => {
    const value = fixture();
    const targetSession = session(value);
    const sourcePath = writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [
      targetSession,
    ]);
    writeComposerGlobalSessions(value, [targetSession]);
    const dest = destination(value);

    const preview = await migrateSession(targetSession.id, {
      destination: dest.path,
      mode: 'move',
      dryRun: true,
      force: false,
      dataPath: value.workspaceStorage,
      sourceWorkspacePath: value.projectA,
    });
    expect(preview).toMatchObject({
      success: true,
      sessionId: targetSession.id,
      dryRun: true,
      eligibility: 'eligible-composer',
    });
    expect(composerIds(sourcePath)).toEqual([targetSession.id]);

    const applied = await migrateSession(targetSession.id, {
      destination: dest.path,
      mode: 'move',
      dryRun: false,
      force: false,
      dataPath: value.workspaceStorage,
      sourceWorkspacePath: value.projectA,
    });
    expect(applied).toMatchObject({
      success: true,
      sessionId: preview.sessionId,
      targetFingerprint: preview.targetFingerprint,
      dryRun: false,
    });
    expect(composerIds(sourcePath)).toEqual([]);
    expect(composerIds(dest.databasePath)).toEqual([targetSession.id]);
  });

  it('rejects same and nested destinations before mutation', async () => {
    const value = fixture();
    const targetSession = session(value);
    const sourcePath = writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [
      targetSession,
    ]);
    writeComposerGlobalSessions(value, [targetSession]);

    await expect(
      migrateSession(targetSession.id, {
        destination: value.projectA,
        mode: 'move',
        dryRun: false,
        force: false,
        dataPath: value.workspaceStorage,
      })
    ).rejects.toThrow('Source and destination are the same');
    await expect(
      migrateSession(targetSession.id, {
        destination: join(value.projectA, 'nested'),
        mode: 'move',
        dryRun: false,
        force: false,
        dataPath: value.workspaceStorage,
      })
    ).rejects.toThrow('nested');
    expect(composerIds(sourcePath)).toEqual([targetSession.id]);
  });

  it('requires force for a nonempty session-migration destination in preview and apply', async () => {
    const value = fixture();
    const targetSession = session(value);
    const sourcePath = writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [
      targetSession,
    ]);
    writeComposerGlobalSessions(value, [targetSession]);
    const dest = destination(value);
    const existingSession = session(value, '99999999-8888-4777-8666-555555555555', dest.path);
    writeComposerWorkspaceSummary(value, 'workspace-destination', dest.path, [existingSession]);
    const beforeGlobal = JSON.stringify(globalRows(value));

    const [boundTarget] = await bindMigrationTargets([targetSession.id], {
      numericBase: 1,
      treatStringSelectorsAsIds: true,
      workspacePath: value.projectA,
      dataPath: value.workspaceStorage,
    });
    expect(boundTarget).toBeDefined();
    await expect(
      prepareSessionMigration(boundTarget!, dest.path, {
        mode: 'move',
        force: false,
        dataPath: value.workspaceStorage,
      })
    ).rejects.toMatchObject({
      name: 'DestinationHasSessionsError',
      path: dest.path,
      sessionCount: 1,
    });
    await expect(
      prepareSessionMigration(boundTarget!, dest.path, {
        mode: 'move',
        force: true,
        dataPath: value.workspaceStorage,
      })
    ).resolves.toMatchObject({ destinationWorkspacePath: dest.path, mode: 'move' });
    expect(composerIds(sourcePath)).toEqual([targetSession.id]);
    expect(composerIds(dest.databasePath)).toEqual([existingSession.id]);
    expect(JSON.stringify(globalRows(value))).toBe(beforeGlobal);

    for (const dryRun of [true, false]) {
      await expect(
        migrateSession(targetSession.id, {
          destination: dest.path,
          mode: 'move',
          dryRun,
          force: false,
          dataPath: value.workspaceStorage,
          sourceWorkspacePath: value.projectA,
        })
      ).rejects.toMatchObject({
        name: 'DestinationHasSessionsError',
        path: dest.path,
        sessionCount: 1,
      });
      expect(composerIds(sourcePath)).toEqual([targetSession.id]);
      expect(composerIds(dest.databasePath)).toEqual([existingSession.id]);
      expect(JSON.stringify(globalRows(value))).toBe(beforeGlobal);
    }

    const preview = await migrateSession(targetSession.id, {
      destination: dest.path,
      mode: 'move',
      dryRun: true,
      force: true,
      dataPath: value.workspaceStorage,
      sourceWorkspacePath: value.projectA,
    });
    expect(preview).toMatchObject({ success: true, sessionId: targetSession.id, dryRun: true });
    expect(composerIds(sourcePath)).toEqual([targetSession.id]);
    expect(composerIds(dest.databasePath)).toEqual([existingSession.id]);
    expect(JSON.stringify(globalRows(value))).toBe(beforeGlobal);

    const applied = await migrateSession(targetSession.id, {
      destination: dest.path,
      mode: 'move',
      dryRun: false,
      force: true,
      dataPath: value.workspaceStorage,
      sourceWorkspacePath: value.projectA,
    });
    expect(applied).toMatchObject({ success: true, sessionId: targetSession.id, dryRun: false });
    expect(composerIds(sourcePath)).toEqual([]);
    expect(composerIds(dest.databasePath)).toEqual([existingSession.id, targetSession.id]);
  });

  it('rejects unknown sessions and destinations', async () => {
    const value = fixture();
    const targetSession = session(value);
    writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [targetSession]);
    writeComposerGlobalSessions(value, [targetSession]);

    await expect(
      migrateSession('missing-session', {
        destination: join(value.root, 'missing-destination'),
        mode: 'move',
        dryRun: false,
        force: false,
        dataPath: value.workspaceStorage,
      })
    ).rejects.toThrow('Session not found');
    await expect(
      migrateSession(targetSession.id, {
        destination: join(value.root, 'missing-destination'),
        mode: 'move',
        dryRun: false,
        force: false,
        dataPath: value.workspaceStorage,
      })
    ).rejects.toThrow('No workspace found');
  });

  it('keeps legacy sessionIds atomic when a later target is missing', async () => {
    const value = fixture();
    const targetSession = session(value);
    const sourcePath = writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [
      targetSession,
    ]);
    writeComposerGlobalSessions(value, [targetSession]);
    const dest = destination(value);

    const results = await migrateSessions({
      sessionIds: [targetSession.id, 'missing-session'],
      workspacePath: value.projectA,
      destination: dest.path,
      mode: 'move',
      dryRun: false,
      force: false,
      dataPath: value.workspaceStorage,
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.success)).toBe(true);
    expect(composerIds(sourcePath)).toEqual([targetSession.id]);
    expect(composerIds(dest.databasePath)).toEqual([]);
  });
});

describe.sequential('migration path fidelity', () => {
  it('moves internal tool/code-block paths and preserves external paths', async () => {
    const value = fixture();
    const targetSession = session(value);
    writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [targetSession]);
    writeComposerGlobalSessions(value, [targetSession]);
    const externalPath = join(value.root, 'external', 'keep.ts');
    overwriteBubbleWithPaths(value, targetSession, externalPath);
    const dest = destination(value);

    const result = await migrateSession(targetSession.id, {
      destination: dest.path,
      mode: 'move',
      dryRun: false,
      force: false,
      dataPath: value.workspaceStorage,
      sourceWorkspacePath: value.projectA,
    });
    expect(result.success).toBe(true);

    const bubble = readBubble(value, targetSession.id);
    const params = JSON.parse((bubble['toolFormerData'] as { params: string }).params) as Record<
      string,
      string
    >;
    expect(params['relativeWorkspacePath']).toBe(join(dest.path, 'src', 'inside.ts'));
    expect(params['targetFile']).toBe(externalPath);
    const uri = (bubble['codeBlocks'] as Array<{ uri: Record<string, string> }>)[0]!.uri;
    expect(uri['path']).toBe(join(dest.path, 'src', 'inside.ts'));
    expect(uri['_fsPath']).toBe(join(dest.path, 'src', 'inside.ts'));
    expect(uri['_formatted']).toBe(`file://${join(dest.path, 'src', 'inside.ts')}`);

    const composerRow = globalRows(value).find(
      (row) => row.key === `composerData:${targetSession.id}`
    );
    const composer = JSON.parse(composerRow!.value) as {
      workspaceUri: string;
      workspaceIdentifier: { uri: { fsPath: string } };
    };
    expect(composer.workspaceIdentifier.uri.fsPath).toBe(dest.path);
    expect(composer.workspaceUri).toContain('/destination');
  });

  it('copies global data under independent IDs while retaining the source', async () => {
    const value = fixture();
    const targetSession = session(value);
    const sourcePath = writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [
      targetSession,
    ]);
    writeComposerGlobalSessions(value, [targetSession]);
    const externalPath = join(value.root, 'external', 'keep.ts');
    overwriteBubbleWithPaths(value, targetSession, externalPath);
    const dest = destination(value);

    const result = await migrateSession(targetSession.id, {
      destination: dest.path,
      mode: 'copy',
      dryRun: false,
      force: false,
      dataPath: value.workspaceStorage,
      sourceWorkspacePath: value.projectA,
    });
    expect(result).toMatchObject({ success: true, sessionId: targetSession.id, mode: 'copy' });
    expect(result.newSessionId).toBeTruthy();
    expect(result.newSessionId).not.toBe(targetSession.id);
    expect(composerIds(sourcePath)).toEqual([targetSession.id]);
    expect(composerIds(dest.databasePath)).toEqual([result.newSessionId]);

    const copiedBubble = readBubble(value, result.newSessionId!);
    const params = JSON.parse(
      (copiedBubble['toolFormerData'] as { params: string }).params
    ) as Record<string, string>;
    expect(params['relativeWorkspacePath']).toBe(join(dest.path, 'src', 'inside.ts'));
    expect(params['targetFile']).toBe(externalPath);
    expect(copiedBubble['bubbleId'] as string).not.toBe(targetSession.messages[0]!.id);
    expect(readBubble(value, targetSession.id)['bubbleId']).toBe(targetSession.messages[0]!.id);
  });
});

describe.sequential('workspace migration compatibility', () => {
  it('rejects an empty source workspace', async () => {
    const value = fixture();
    writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, []);
    const dest = destination(value);

    await expect(
      migrateWorkspace({
        source: value.projectA,
        destination: dest.path,
        mode: 'move',
        dryRun: false,
        force: false,
        dataPath: value.workspaceStorage,
      })
    ).rejects.toThrow('No sessions found');
  });

  it('rejects a non-empty destination unless force is set', async () => {
    const value = fixture();
    const sourceSession = session(value);
    const destinationSession = session(
      value,
      '99999999-8888-4777-8666-555555555555',
      join(value.root, 'workspaces', 'destination')
    );
    writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [sourceSession]);
    writeComposerGlobalSessions(value, [sourceSession]);
    const dest = destination(value);
    writeComposerWorkspaceSummary(value, 'workspace-destination', dest.path, [destinationSession]);

    await expect(
      migrateWorkspace({
        source: value.projectA,
        destination: dest.path,
        mode: 'move',
        dryRun: false,
        force: false,
        dataPath: value.workspaceStorage,
      })
    ).rejects.toThrow('already has');
  });
});
