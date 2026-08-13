import { afterEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { dirname, join } from 'node:path';

import * as database from '../../src/core/database/index.js';
import { DatabaseCapabilityError } from '../../src/core/database/errors.js';
import {
  arbitrateComposerContribution,
  buildSessionCatalog,
  type PhysicalSessionInstance,
  type ReplicaConsumedPayload,
} from '../../src/core/session-catalog.js';
import * as storage from '../../src/core/storage.js';
import * as library from '../../src/lib/index.js';
import type { LibraryConfig } from '../../src/lib/types.js';
import {
  SESSION_INTEGRITY_IDS,
  createFixtureBackup,
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  writeStoreMeta,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const roots: SessionIntegrityFixtureRoot[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('ch-composer-arbitration-');
  roots.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function composer(
  root: SessionIntegrityFixtureRoot,
  title: string,
  workspacePath = root.projectA,
  id = SESSION_INTEGRITY_IDS.duplicate
): ComposerFixtureSession {
  return {
    id,
    title,
    workspacePath,
    createdAt: 1_783_000_000_000,
    messages: [
      {
        id: 'native-composer-message',
        role: 'user',
        content: title,
        createdAt: 1_783_000_000_000,
      },
    ],
  };
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const root of roots.splice(0)) root.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe.sequential('Composer tier arbitration through physical fixtures', () => {
  it('marks a global-only Composer counterpart omitted until scoped Store reads opt in', async () => {
    const root = fixture();
    const global = composer(root, 'global-only-composer-needle');
    writeComposerGlobalSessions(root, [global]);
    const storeDb = writeStoreDb(
      root,
      global.id,
      [{ role: 'assistant', content: 'scoped-store-needle' }],
      'Scoped Store half'
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: root.projectA,
      title: 'Scoped Store half',
      hasConversation: true,
      createdAtMs: 1_783_000_000_000,
    });

    const scopedConfig: LibraryConfig = {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    };
    const scoped = await library.listSessions(scopedConfig);
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0]).toMatchObject({
      id: global.id,
      resolvedSource: 'store-db',
      sources: ['composer', 'store'],
      resolution: {
        state: 'partial',
        loadedSourceRoles: ['store'],
        omittedSourceRoles: ['composer'],
        reasonCodes: ['workspace-scope-omitted'],
      },
      sourceInstances: expect.arrayContaining([
        expect.objectContaining({
          representation: 'composer-global',
          state: 'omitted-by-scope',
        }),
        expect.objectContaining({ representation: 'store-db', state: 'contributed' }),
      ]),
    });
    expect(scoped.data[0]!.messages.map(({ content }) => content)).toContain('scoped-store-needle');
    expect(scoped.data[0]!.messages.map(({ content }) => content)).not.toContain(
      'global-only-composer-needle'
    );

    const optedIn = await library.listSessions({
      ...scopedConfig,
      includeCrossWorkspaceSources: true,
    });
    expect(optedIn.data).toHaveLength(1);
    expect(optedIn.data[0]).toMatchObject({
      id: global.id,
      resolvedSource: 'merged',
      sources: ['composer', 'store'],
    });
    expect(optedIn.data[0]!.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining(['global-only-composer-needle', 'scoped-store-needle'])
    );
  });

  it('retains a global-only Composer canonical path while strict scope omits its payload', async () => {
    const root = fixture();
    const global = composer(
      root,
      'off-scope-global-composer-needle',
      root.projectB,
      '13572468-2468-4ace-8ace-135724681357'
    );
    writeComposerGlobalSessions(root, [global]);
    const storeDb = writeStoreDb(
      root,
      global.id,
      [{ role: 'assistant', content: 'in-scope-store-needle' }],
      'Scoped Store half'
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: root.projectA,
      title: 'Scoped Store half',
      hasConversation: true,
      createdAtMs: 1_783_000_000_000,
    });

    const unfiltered = await library.listSessions({ dataPath: root.workspaceStorage });
    const scoped = await library.listSessions({
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    });

    expect(unfiltered.data).toHaveLength(1);
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0]).toMatchObject({
      id: global.id,
      workspace: root.projectB,
      canonicalWorkspacePath: root.projectB,
      matchedWorkspacePath: root.projectA,
      resolvedSource: 'store-db',
      resolution: {
        state: 'partial',
        loadedSourceRoles: ['store'],
        omittedSourceRoles: ['composer'],
      },
      sourceInstances: expect.arrayContaining([
        expect.objectContaining({
          sourceRole: 'composer',
          representation: 'composer-global',
          workspacePaths: [root.projectB],
          state: 'omitted-by-scope',
        }),
      ]),
      workspaceMemberships: expect.arrayContaining([
        expect.objectContaining({
          workspacePath: root.projectA,
          sourceRoles: ['store'],
        }),
        expect.objectContaining({
          workspacePath: root.projectB,
          sourceRoles: ['composer'],
        }),
      ]),
    });
    expect(scoped.data[0]!.canonicalWorkspacePath).toBe(unfiltered.data[0]!.canonicalWorkspacePath);
    expect(scoped.data[0]!.messages.map(({ content }) => content)).toEqual([
      'in-scope-store-needle',
    ]);

    const searchResults = await storage.searchSessions(
      'in-scope-store-needle',
      { limit: 0, contextChars: 40, workspacePath: root.projectA },
      root.workspaceStorage
    );
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]).toMatchObject({
      sessionId: global.id,
      workspacePath: root.projectB,
      canonicalWorkspacePath: root.projectB,
      matchedWorkspacePath: root.projectA,
    });
  });

  it('binds an opted-in off-scope workspace fallback and reports its later loss as partial', async () => {
    const root = fixture();
    const composerHalf = composer(
      root,
      'off-scope-workspace-fallback-needle',
      root.projectB,
      '97531864-2468-4ace-8ace-975318642468'
    );
    const composerDbPath = writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [
      composerHalf,
    ]);
    const storeDb = writeStoreDb(
      root,
      composerHalf.id,
      [{ role: 'assistant', content: 'in-scope-store-half-needle' }],
      'Scoped Store half'
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: root.projectA,
      title: 'Scoped Store half',
      hasConversation: true,
      createdAtMs: 1_783_000_000_000,
    });

    const optedInConfig: LibraryConfig = {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
      includeCrossWorkspaceSources: true,
    };
    const hydrated = await library.listSessions(optedInConfig);
    expect(hydrated.data).toHaveLength(1);
    expect(hydrated.data[0]).toMatchObject({
      id: composerHalf.id,
      resolvedSource: 'merged',
      resolution: {
        state: 'partial',
        loadedSourceRoles: ['composer', 'store'],
      },
    });
    expect(hydrated.data[0]!.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining(['off-scope-workspace-fallback-needle', 'in-scope-store-half-needle'])
    );

    const context = storage.createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
    });
    try {
      const summaries = await storage.listSessionSummaries(
        {
          all: true,
          limit: 0,
          workspacePath: root.projectA,
          includeCrossWorkspaceSources: true,
        },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ resolvedSource: 'merged' });

      const removedComposer = new BetterSqlite3(composerDbPath);
      removedComposer.prepare("DELETE FROM ItemTable WHERE key = 'composer.composerData'").run();
      removedComposer.close();
      const degraded = await storage.getSession(
        composerHalf.id,
        root.workspaceStorage,
        undefined,
        context,
        summaries[0]!.index
      );
      expect(degraded).toMatchObject({
        id: composerHalf.id,
        resolvedSource: 'store-db',
        resolutionState: 'partial',
        resolution: {
          state: 'partial',
          expectedSourceRoles: ['composer', 'store'],
          loadedSourceRoles: ['store'],
          failedSourceRoles: ['composer'],
          reasonCodes: expect.arrayContaining(['source-unavailable']),
        },
      });
    } finally {
      await context.dispose();
    }
  });

  it('merges admitted global bubbles even when their optional Composer metadata row is absent', async () => {
    const root = fixture();
    const global = composer(
      root,
      'bubble-without-composer-metadata',
      root.projectA,
      '24681357-1357-4bdf-8bdf-246813572468'
    );
    const globalDbPath = writeComposerGlobalSessions(root, [global]);
    const raw = new BetterSqlite3(globalDbPath);
    raw.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`composerData:${global.id}`);
    raw.close();

    const storeDb = writeStoreDb(
      root,
      global.id,
      [{ role: 'assistant', content: 'store-half-without-composer-metadata' }],
      'Store half'
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: root.projectA,
      title: 'Store half',
      hasConversation: true,
      createdAtMs: 1_783_000_000_000,
    });

    const unfiltered = await library.listSessions({ dataPath: root.workspaceStorage });
    const page = await library.listSessions({
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
      includeCrossWorkspaceSources: true,
    });

    expect(unfiltered.data).toHaveLength(1);
    expect(unfiltered.data[0]).toMatchObject({
      id: global.id,
      source: 'global',
      resolvedSource: 'merged',
    });
    expect(unfiltered.data[0]!.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining([
        'bubble-without-composer-metadata',
        'store-half-without-composer-metadata',
      ])
    );
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: global.id,
      source: 'global',
      resolvedSource: 'merged',
      resolution: {
        state: 'complete',
        loadedSourceRoles: ['composer', 'store'],
      },
    });
    expect(page.data[0]!.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining([
        'bubble-without-composer-metadata',
        'store-half-without-composer-metadata',
      ])
    );
  });

  it('uses one global payload as primary and treats workspace rows as membership-only', async () => {
    const root = fixture();
    const global = composer(root, 'global-primary-needle');
    const workspaceCopyA = composer(root, 'workspace-copy-must-not-replace-global');
    const workspaceCopyB = composer(root, 'another-workspace-copy-must-not-replace-global');
    writeComposerGlobalSessions(root, [global]);
    writeComposerWorkspaceSummary(root, 'workspace-copy-z', root.projectA, [workspaceCopyA]);
    writeComposerWorkspaceSummary(root, 'workspace-copy-a', root.projectA, [workspaceCopyB]);

    const config: LibraryConfig = { dataPath: root.workspaceStorage, workspace: root.projectA };
    const page = await library.listSessions(config);
    expect(page.pagination).toMatchObject({ total: 1, hasMore: false });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: global.id,
      source: 'global',
      resolvedSource: 'composer',
      resolution: {
        state: 'complete',
        expectedSourceRoles: ['composer'],
        loadedSourceRoles: ['composer'],
      },
      sourceInstances: [
        expect.objectContaining({
          representation: 'composer-global',
          state: 'contributed',
        }),
        expect.objectContaining({
          representation: 'composer-workspace',
          state: 'superseded',
        }),
        expect.objectContaining({
          representation: 'composer-workspace',
          state: 'superseded',
        }),
      ],
    });
    const session = await library.getSession(global.id, config);
    expect(session.messages.map(({ content }) => content)).toEqual(['global-primary-needle']);
    expect(session.messages.map(({ content }) => content)).not.toContain(
      'workspace-copy-must-not-replace-global'
    );

    const backupPath = await createFixtureBackup(root, 'global-primary.zip');
    const backupSummaries = await storage.listSessionSummaries(
      { all: true, limit: 0 },
      undefined,
      backupPath
    );
    expect(backupSummaries).toEqual([
      expect.objectContaining({
        id: global.id,
        title: 'global-primary-needle',
        messageCount: 1,
        source: 'global',
        resolutionState: 'complete',
        sourceInstances: [
          expect.objectContaining({
            representation: 'composer-global',
            state: 'contributed',
          }),
          expect.objectContaining({
            representation: 'composer-workspace',
            state: 'superseded',
          }),
          expect.objectContaining({
            representation: 'composer-workspace',
            state: 'superseded',
          }),
        ],
      }),
    ]);
    await expect(library.getSession(global.id, { backupPath })).resolves.toMatchObject({
      id: global.id,
      messages: [expect.objectContaining({ content: 'global-primary-needle' })],
    });
  });

  it('retains selected workspace metadata when global bubbles have no metadata or timestamps', async () => {
    const root = fixture();
    const sessionId = 'abcdefab-1234-4abc-8abc-abcdefabcdef';
    const preferredCreatedAt = 1_783_111_222_333;
    const global: ComposerFixtureSession = {
      id: sessionId,
      title: 'removed-global-metadata',
      workspacePath: root.projectA,
      createdAt: 1,
      messages: [
        {
          id: 'global-message-without-time',
          role: 'user',
          content: 'global-payload-with-workspace-metadata',
        },
      ],
    };
    const globalDbPath = writeComposerGlobalSessions(root, [global]);
    const globalDb = new BetterSqlite3(globalDbPath);
    globalDb.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`composerData:${sessionId}`);
    globalDb.close();

    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [
      {
        ...global,
        title: 'workspace-metadata-title',
        createdAt: preferredCreatedAt,
        messages: [{ role: 'assistant', content: 'divergent-workspace-a-payload' }],
      },
    ]);
    writeComposerWorkspaceSummary(root, 'workspace-z', root.projectA, [
      {
        ...global,
        title: 'later-divergent-workspace-title',
        createdAt: preferredCreatedAt + 10_000,
        messages: [{ role: 'assistant', content: 'divergent-workspace-z-payload' }],
      },
    ]);

    const liveOptions = {
      all: true,
      limit: 0,
      workspacePath: root.projectA,
    } as const;
    const liveSummaries = await storage.listSessionSummaries(liveOptions, root.workspaceStorage);
    expect(liveSummaries).toEqual([
      expect.objectContaining({
        id: sessionId,
        title: 'workspace-metadata-title',
        createdAt: new Date(preferredCreatedAt),
        createdAtSource: 'composer-metadata',
        lastUpdatedAt: new Date(preferredCreatedAt),
        lastUpdatedAtSource: 'composer-metadata',
        messageCount: 1,
        source: 'global',
      }),
    ]);
    const liveSession = await library.getSession(sessionId, {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    });
    expect(liveSession.messages).toEqual([
      expect.objectContaining({
        content: 'global-payload-with-workspace-metadata',
        timestamp: new Date(preferredCreatedAt).toISOString(),
        timestampSource: 'session-fallback',
      }),
    ]);
    expect(liveSession.messages.map(({ content }) => content)).not.toContain(
      'divergent-workspace-a-payload'
    );

    const backupPath = await createFixtureBackup(root, 'global-metadata-fallback.zip');
    const backupSummaries = await storage.listSessionSummaries(
      { all: true, limit: 0 },
      undefined,
      backupPath
    );
    expect(backupSummaries).toEqual([
      expect.objectContaining({
        id: sessionId,
        title: 'workspace-metadata-title',
        createdAt: new Date(preferredCreatedAt),
        createdAtSource: 'composer-metadata',
        lastUpdatedAt: new Date(preferredCreatedAt),
        lastUpdatedAtSource: 'composer-metadata',
        messageCount: 1,
        source: 'global',
      }),
    ]);
    const backupSession = await library.getSession(sessionId, { backupPath });
    expect(backupSession.messages).toEqual([
      expect.objectContaining({
        content: 'global-payload-with-workspace-metadata',
        timestamp: new Date(preferredCreatedAt).toISOString(),
        timestampSource: 'session-fallback',
      }),
    ]);
  });

  it('uses workspace content only as an explicit partial fallback when global is absent', async () => {
    const root = fixture();
    const fallback = composer(root, 'workspace-fallback-needle');
    writeComposerWorkspaceSummary(root, 'workspace-fallback', root.projectA, [fallback]);

    const config: LibraryConfig = { dataPath: root.workspaceStorage, workspace: root.projectA };
    const page = await library.listSessions(config);
    expect(page.pagination.total).toBe(1);
    expect(page.data[0]).toMatchObject({
      id: fallback.id,
      source: 'workspace-fallback',
      resolvedSource: 'composer',
      resolution: {
        state: 'partial',
        expectedSourceRoles: ['composer'],
        loadedSourceRoles: ['composer'],
        reasonCodes: ['source-unavailable'],
      },
      sourceInstances: [
        expect.objectContaining({
          representation: 'composer-workspace',
          state: 'contributed',
        }),
      ],
    });
    const session = await library.getSession(fallback.id, config);
    expect(session.messages.map(({ content }) => content)).toContain('workspace-fallback-needle');
  });

  it('omits an off-scope same-tier candidate by default and compares it only after opt-in', async () => {
    const root = fixture();
    const scoped = composer(root, 'scope-a-content', root.projectA);
    const offScope = composer(root, 'scope-b-divergent-content', root.projectB);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [scoped]);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [offScope]);

    const defaultPage = await library.listSessions({
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    });
    expect(defaultPage.pagination.total).toBe(1);
    expect(defaultPage.data).toHaveLength(1);
    expect(defaultPage.data[0]).toMatchObject({
      id: scoped.id,
      resolution: {
        state: 'partial',
        omittedSourceRoles: ['composer'],
        reasonCodes: ['workspace-scope-omitted', 'source-unavailable'],
      },
      sourceInstances: expect.arrayContaining([
        expect.objectContaining({
          representation: 'composer-workspace',
          workspacePaths: [root.projectA],
          state: 'contributed',
        }),
        expect.objectContaining({
          representation: 'composer-workspace',
          workspacePaths: [root.projectB],
          state: 'omitted-by-scope',
        }),
      ]),
    });
    const defaultSession = await library.getSession(scoped.id, {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    });
    expect(defaultSession.messages.map(({ content }) => content)).toContain('scope-a-content');
    expect(defaultSession.messages.map(({ content }) => content)).not.toContain(
      'scope-b-divergent-content'
    );

    const diagnostics: unknown[] = [];
    const optedIn = await library.listSessions({
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
      includeCrossWorkspaceSources: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(optedIn.pagination.total).toBe(1);
    expect(optedIn.data).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SESSION_AMBIGUOUS',
        sessionId: scoped.id,
        occurrenceCount: 2,
      }),
    ]);
  });

  it('never lets a divergent global tier fall through to workspace fallback', async () => {
    const root = fixture();
    const workspaceLoader = vi.fn(async (): Promise<ReplicaConsumedPayload> => ({
      messages: [{ id: 'workspace', role: 'user', content: 'workspace fallback' }],
    }));
    const instance = (
      key: string,
      representation: 'composer-global' | 'composer-workspace',
      content: string,
      sourceOrder: number
    ): PhysicalSessionInstance<string> => ({
      instanceKey: key,
      logicalSessionId: SESSION_INTEGRITY_IDS.duplicate,
      sourceRole: 'composer',
      representation,
      fidelityTier: representation === 'composer-global' ? 'complete' : 'partial',
      locator: join(root.root, `${key}.vscdb`),
      workspacePaths: [root.projectA],
      sourceOrder,
      loadConsumedPayload:
        representation === 'composer-workspace'
          ? workspaceLoader
          : async () => ({ messages: [{ id: 'global', role: 'user', content }] }),
    });
    const record = buildSessionCatalog([
      instance('global-a', 'composer-global', 'global-a', 1),
      instance('global-b', 'composer-global', 'global-b', 2),
      instance('workspace', 'composer-workspace', 'workspace fallback', 1),
    ])[0]!;

    const result = await arbitrateComposerContribution(record, {
      diagnosticContextId: 'composer-global-divergence',
    });
    expect(result).toMatchObject({ state: 'ambiguous', selectedTier: 'global-primary' });
    expect(workspaceLoader).not.toHaveBeenCalled();
  });

  it('propagates global database capability failure instead of publishing workspace fallback', async () => {
    const root = fixture();
    const session = composer(root, 'fatal-global-capability');
    writeComposerGlobalSessions(root, [session]);
    writeComposerWorkspaceSummary(root, 'workspace-fallback', root.projectA, [session]);
    const context = storage.createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
    });
    const summaries = await storage.listSessions(
      { all: true, limit: 0, workspacePath: root.projectA },
      root.workspaceStorage,
      undefined,
      context
    );
    expect(summaries).toHaveLength(1);

    const actualOpen = database.openDatabase;
    const globalPath = join(root.globalStorage, 'state.vscdb');
    const spy = vi.spyOn(database, 'openDatabase').mockImplementation(async (path, options) => {
      if (path === globalPath) {
        throw new DatabaseCapabilityError('node:sqlite', 'read-session', ['read']);
      }
      return actualOpen(path, options);
    });
    spies.push(spy);

    await expect(
      storage.getSession(session.id, root.workspaceStorage, undefined, context)
    ).rejects.toMatchObject({ code: 'DATABASE_CAPABILITY_MISSING' });
  });
});
