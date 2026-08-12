import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { SessionAmbiguityError } from '../../src/core/errors.js';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';
import {
  createSessionReadContext,
  getSession,
  listSessions,
  listWorkspaces,
} from '../../src/core/storage.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDbAtPath,
  writeStoreMeta,
  writeStoreTranscript,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { createIoEventRecorder } from '../helpers/io-probe.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-store-occurrence-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function composerSession(
  root: SessionIntegrityFixtureRoot,
  id: string,
  content = 'composer-a'
): ComposerFixtureSession {
  const session: ComposerFixtureSession = {
    id,
    title: 'Composer session',
    workspacePath: root.projectA,
    createdAt: 1_700_000_000_000,
    messages: [{ id: 'composer-native', role: 'user', content }],
  };
  writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [session]);
  writeComposerGlobalSessions(root, [session]);
  return session;
}

function storeDbOccurrence(
  root: SessionIntegrityFixtureRoot,
  lane: string,
  id: string,
  workspacePath: string,
  content: string
): string {
  const dbPath = join(root.storeRoot, 'chats', lane, id, 'store.db');
  writeStoreDbAtPath(dbPath, id, [{ role: 'assistant', content }], 'Store occurrence');
  writeStoreMeta(dirname(dbPath), {
    cwd: workspacePath,
    hasConversation: true,
    createdAtMs: 1_700_000_000_000,
  });
  return dbPath;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe('Store physical occurrence integrity', () => {
  it('counts one multi-workspace Composer UUID once in every filterable membership', async () => {
    const root = fixture();
    const id = '00000000-3333-4000-8000-000000000000';
    const session = composerSession(root, id, 'shared-composer');
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [
      { ...session, workspacePath: root.projectB },
    ]);

    const workspaces = await listWorkspaces(root.workspaceStorage);
    const counts = new Map(workspaces.map(({ path, sessionCount }) => [path, sessionCount]));
    expect(counts.get(root.projectA)).toBe(1);
    expect(counts.get(root.projectB)).toBe(1);

    for (const workspacePath of [root.projectA, root.projectB]) {
      const rows = await listSessions(
        { limit: 0, all: true, workspacePath },
        root.workspaceStorage
      );
      expect(rows.map((row) => row.id)).toEqual([id]);
      expect(counts.get(workspacePath)).toBe(rows.length);
    }
  });

  it('throws a typed ambiguity error for divergent Store database payloads', async () => {
    const root = fixture();
    const id = '11111111-1111-4111-8111-111111111111';
    storeDbOccurrence(root, 'a-copy', id, root.projectA, 'divergent-db-a');
    storeDbOccurrence(root, 'z-copy', id, root.projectB, 'divergent-db-b');

    let error: unknown;
    try {
      await discoverStoreSessions(root.storeRoot);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SessionAmbiguityError);
    expect(error).toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      details: {
        sessionId: id,
        occurrenceCount: 2,
        occurrenceRefs: [
          expect.stringMatching(/^occurrence:v1:[0-9a-f]{64}$/u),
          expect.stringMatching(/^occurrence:v1:[0-9a-f]{64}$/u),
        ],
      },
    });
    expect(JSON.stringify(error)).not.toContain(root.root);
  });

  it('throws a typed ambiguity error for divergent Store transcript payloads', async () => {
    const root = fixture();
    const id = '22222222-2222-4222-8222-222222222222';
    writeStoreTranscript(root, 'a-copy', id, [
      { role: 'user', message: { content: [{ type: 'text', text: 'divergent-transcript-a' }] } },
    ]);
    writeStoreTranscript(root, 'z-copy', id, [
      { role: 'user', message: { content: [{ type: 'text', text: 'divergent-transcript-b' }] } },
    ]);

    await expect(discoverStoreSessions(root.storeRoot)).rejects.toMatchObject({
      name: SessionAmbiguityError.name,
      code: 'SESSION_AMBIGUOUS',
      details: {
        sessionId: id,
        occurrenceCount: 2,
        occurrenceRefs: [
          expect.stringMatching(/^occurrence:v1:[0-9a-f]{64}$/u),
          expect.stringMatching(/^occurrence:v1:[0-9a-f]{64}$/u),
        ],
      },
    });
  });

  it('retains each Store database occurrence workspace in provenance and membership metadata', async () => {
    const root = fixture();
    const id = '33333333-3333-4333-8333-333333333333';
    storeDbOccurrence(root, 'a-copy', id, root.projectA, 'equivalent-db');
    storeDbOccurrence(root, 'z-copy', id, root.projectB, 'equivalent-db');

    const rows = await discoverStoreSessions(root.storeRoot, { metadataOnly: true });
    const row = rows.find((candidate) => candidate.id === id);

    expect(row).toBeDefined();
    expect(
      row?.sourceInstances
        ?.filter(({ representation }) => representation === 'store-db')
        .map(({ workspacePaths }) => workspacePaths)
    ).toEqual([[root.projectA], [root.projectB]]);
    expect(row?.workspaceMemberships).toEqual([
      {
        workspacePath: root.projectA,
        sourceRoles: ['store'],
        contributingInstanceCount: 1,
      },
      {
        workspacePath: root.projectB,
        sourceRoles: ['store'],
        contributingInstanceCount: 1,
      },
    ]);

    const workspaces = await listWorkspaces(root.workspaceStorage);
    expect(
      workspaces
        .filter(({ path }) => path === root.projectA || path === root.projectB)
        .map(({ path, sessionCount }) => ({ path, sessionCount }))
        .sort((left, right) => left.path.localeCompare(right.path))
    ).toEqual([root.projectA, root.projectB].sort().map((path) => ({ path, sessionCount: 1 })));
  });

  it('hydrates only the selected-workspace Store DB occurrence unless cross-workspace reads opt in', async () => {
    const root = fixture();
    const id = '44444444-4444-4444-8444-444444444444';
    composerSession(root, id);
    storeDbOccurrence(root, 'a-copy', id, root.projectA, 'store-db-a');
    storeDbOccurrence(root, 'z-copy', id, root.projectB, 'store-db-b');

    const defaultRecorder = createIoEventRecorder();
    const defaultContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: false,
      ioObserver: defaultRecorder.observer,
    });
    try {
      const rows = await listSessions(
        {
          all: true,
          limit: 0,
          workspacePath: root.projectA,
          includeCrossWorkspaceSources: false,
        },
        root.workspaceStorage,
        undefined,
        defaultContext
      );
      const row = rows.find((candidate) => candidate.id === id);
      expect(row).toBeDefined();

      const resolved = await getSession(
        id,
        root.workspaceStorage,
        undefined,
        defaultContext,
        row!.index
      );
      expect(resolved?.messages.map(({ content }) => content)).toEqual(
        expect.arrayContaining(['composer-a', 'store-db-a'])
      );
      expect(resolved?.messages.map(({ content }) => content)).not.toContain('store-db-b');
      expect(
        defaultRecorder.count({
          adapter: 'sqlite',
          operation: 'backup',
          resourceClass: 'store-database',
          logicalSessionId: id,
          sourceRole: 'store',
        })
      ).toBe(1);
      expect(resolved?.workspaceMemberships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workspacePath: root.projectA }),
          expect.objectContaining({ workspacePath: root.projectB, sourceRoles: ['store'] }),
        ])
      );
    } finally {
      await defaultContext.dispose();
    }

    const optInRecorder = createIoEventRecorder();
    const optInContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
      ioObserver: optInRecorder.observer,
    });
    try {
      await expect(
        getSession(id, root.workspaceStorage, undefined, optInContext)
      ).rejects.toBeInstanceOf(SessionAmbiguityError);
      expect(
        optInRecorder.count({
          adapter: 'sqlite',
          operation: 'backup',
          resourceClass: 'store-database',
          logicalSessionId: id,
          sourceRole: 'store',
        })
      ).toBe(2);
    } finally {
      await optInContext.dispose();
    }
  });

  it('keeps Composer A and Store B memberships while gating the Store transcript payload', async () => {
    const root = fixture();
    const id = '55555555-5555-4555-8555-555555555555';
    composerSession(root, id);
    writeStoreMeta(join(root.storeRoot, 'chats', 'store-b', id), {
      cwd: root.projectB,
      hasConversation: true,
      createdAtMs: 1_700_000_000_000,
    });
    writeStoreTranscript(root, 'store-b', id, [
      { role: 'assistant', message: { content: [{ type: 'text', text: 'store-transcript-b' }] } },
    ]);

    const defaultRecorder = createIoEventRecorder();
    const defaultContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: false,
      ioObserver: defaultRecorder.observer,
    });
    try {
      const resolved = await getSession(id, root.workspaceStorage, undefined, defaultContext);
      expect(resolved?.messages.map(({ content }) => content)).toEqual(['composer-a']);
      expect(
        defaultRecorder.count({
          adapter: 'filesystem',
          operation: 'open',
          resourceClass: 'store-transcript',
          logicalSessionId: id,
          sourceRole: 'store',
        })
      ).toBe(0);
      expect(resolved?.workspaceMemberships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workspacePath: root.projectA, sourceRoles: ['composer'] }),
          expect.objectContaining({ workspacePath: root.projectB, sourceRoles: ['store'] }),
        ])
      );
    } finally {
      await defaultContext.dispose();
    }

    const optInRecorder = createIoEventRecorder();
    const optInContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
      ioObserver: optInRecorder.observer,
    });
    try {
      const resolved = await getSession(id, root.workspaceStorage, undefined, optInContext);
      expect(resolved?.messages.map(({ content }) => content)).toEqual(
        expect.arrayContaining(['composer-a', 'store-transcript-b'])
      );
      expect(
        optInRecorder.count({
          adapter: 'filesystem',
          operation: 'open',
          resourceClass: 'store-transcript',
          logicalSessionId: id,
          sourceRole: 'store',
        })
      ).toBe(1);
      expect(resolved?.workspaceMemberships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workspacePath: root.projectA, sourceRoles: ['composer'] }),
          expect.objectContaining({ workspacePath: root.projectB, sourceRoles: ['store'] }),
        ])
      );
    } finally {
      await optInContext.dispose();
    }
  });
});
