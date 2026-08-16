import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SessionAmbiguityError } from '../../src/core/errors.js';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';
import {
  createSessionReadContext,
  listSessionSummaries,
  listSessions,
  listWorkspaces,
  searchSessions,
} from '../../src/core/storage.js';
import type { SessionDiagnostic } from '../../src/core/types.js';
import {
  createSessionIntegrityFixtureRoot,
  writeStoreDbAtPath,
  writeStoreMeta,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-store-catalog-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function storeDbOccurrence(
  root: SessionIntegrityFixtureRoot,
  lane: string,
  id: string,
  workspacePath: string,
  content: string,
  title: string
): string {
  const dbPath = join(root.storeRoot, 'chats', lane, id, 'store.db');
  writeStoreDbAtPath(dbPath, id, [{ role: 'user', content }], title);
  writeStoreMeta(dirname(dbPath), {
    cwd: workspacePath,
    title,
    hasConversation: true,
    createdAtMs: 1_700_000_000_000,
  });
  return dbPath;
}

function writeRawTranscript(
  root: SessionIntegrityFixtureRoot,
  lane: string,
  id: string,
  lines: readonly string[]
): string {
  const path = join(root.storeRoot, 'projects', lane, 'agent-transcripts', id, `${id}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

function transcriptMessage(content: string, parentMessageId?: string): string {
  return JSON.stringify({
    role: 'user',
    ...(parentMessageId ? { parentMessageId } : {}),
    message: { content: [{ type: 'text', text: content }] },
  });
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe('Store safe catalog and replica regressions', () => {
  it('omits an explicit no-conversation metadata record from every logical catalog', async () => {
    const root = fixture();
    const id = '00000000-2222-4000-8000-000000000000';
    writeStoreMeta(join(root.storeRoot, 'chats', 'metadata-only', id), {
      cwd: root.projectA,
      title: 'Must not become a session',
      hasConversation: false,
      createdAtMs: 1_700_000_000_000,
    });

    await expect(discoverStoreSessions(root.storeRoot, { metadataOnly: true })).resolves.toEqual(
      []
    );
    await expect(
      listSessionSummaries({ limit: 0, all: true }, root.workspaceStorage)
    ).resolves.toEqual([]);
    await expect(listWorkspaces(root.workspaceStorage)).resolves.toEqual([]);
  });

  it('retains selected display metadata without caching an off-scope title', async () => {
    const root = fixture();
    const selectedId = '11111111-2222-4111-8111-111111111111';
    const offScopeId = '22222222-2222-4222-8222-222222222222';
    storeDbOccurrence(
      root,
      'selected-a',
      selectedId,
      root.projectA,
      'selected payload',
      'selected-title-a'
    );
    storeDbOccurrence(
      root,
      'off-scope-b',
      offScopeId,
      root.projectB,
      'off-scope payload',
      'secret-title-b'
    );

    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
    });
    try {
      const rows = await listSessions(
        { limit: 0, all: true, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: selectedId, title: 'selected-title-a' });
      expect(context.storeSessions?.find(({ id }) => id === selectedId)?.title).toBe(
        'selected-title-a'
      );
      expect(context.storeSessions?.find(({ id }) => id === offScopeId)?.title).toBeNull();
      expect(JSON.stringify(context.storeSessions)).not.toContain('secret-title-b');
    } finally {
      await context.dispose();
    }
  });

  it('retains metadata-verified memberships when the selected transcript is pathless', async () => {
    const root = fixture();
    const id = '77777777-2222-4777-8777-777777777777';
    writeStoreMeta(join(root.storeRoot, 'chats', 'metadata-a', id), {
      cwd: root.projectA,
      hasConversation: true,
      createdAtMs: 1_700_000_000_000,
    });
    writeStoreMeta(join(root.storeRoot, 'chats', 'metadata-b', id), {
      cwd: root.projectB,
      hasConversation: true,
      createdAtMs: 1_700_000_000_000,
    });
    writeRawTranscript(root, 'pathless-transcript', id, [transcriptMessage('pathless payload')]);

    const metadataRow = (await discoverStoreSessions(root.storeRoot, { metadataOnly: true })).find(
      (candidate) => candidate.id === id
    );
    expect(metadataRow?.sourceInstances).toEqual([
      expect.objectContaining({
        representation: 'store-transcript',
        workspacePaths: [],
      }),
    ]);
    expect(metadataRow?.workspaceMemberships).toEqual([
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

    const resolvedRow = (await discoverStoreSessions(root.storeRoot)).find(
      (candidate) => candidate.id === id
    );
    expect(resolvedRow?.messages.map(({ content }) => content)).toEqual(['pathless payload']);
    expect(resolvedRow?.workspaceMemberships).toEqual(metadataRow?.workspaceMemberships);

    const workspaces = await listWorkspaces(root.workspaceStorage);
    expect(
      workspaces
        .filter(({ path }) => path === root.projectA || path === root.projectB)
        .map(({ path, sessionCount }) => ({ path, sessionCount }))
        .sort((left, right) => left.path.localeCompare(right.path))
    ).toEqual([root.projectA, root.projectB].sort().map((path) => ({ path, sessionCount: 1 })));
  });

  it('treats transcript source-line drift from blank, error, and ignored records as equivalent', async () => {
    const root = fixture();
    const id = '33333333-2222-4333-8333-333333333333';
    const message = transcriptMessage('same logical transcript');
    const error = JSON.stringify({ type: 'error', error: 'ignored provider error' });
    const ignored = JSON.stringify({ role: 'system', message: { content: [] } });

    writeRawTranscript(root, 'early-message', id, [message, error, ignored]);
    writeRawTranscript(root, 'late-message', id, ['', error, ignored, message]);

    const sessions = await discoverStoreSessions(root.storeRoot);
    const session = sessions.find((candidate) => candidate.id === id);

    expect(session?.messages.map(({ content }) => content)).toEqual(['same logical transcript']);
    expect(session?.messageIdentityEvidence[0]).toMatchObject({
      representation: 'transcript',
      sourceLine: 1,
    });
    expect(session?.sourceInstances).toEqual([
      expect.objectContaining({
        representation: 'store-transcript',
        state: 'contributed',
      }),
      expect.objectContaining({
        representation: 'store-transcript',
        state: 'equivalent-replica',
      }),
    ]);
  });

  it.each([
    {
      label: 'content',
      first: transcriptMessage('content-a'),
      second: transcriptMessage('content-b'),
    },
    {
      label: 'source relationship',
      first: transcriptMessage('same content', 'parent-a'),
      second: transcriptMessage('same content', 'parent-b'),
    },
  ])(
    'keeps changed transcript $label divergent despite source-line noise',
    async ({ first, second }) => {
      const root = fixture();
      const id = '44444444-2222-4444-8444-444444444444';
      const ignored = JSON.stringify({ role: 'system', message: { content: [] } });
      writeRawTranscript(root, 'candidate-a', id, [first, ignored]);
      writeRawTranscript(root, 'candidate-b', id, ['', ignored, second]);

      await expect(discoverStoreSessions(root.storeRoot)).rejects.toBeInstanceOf(
        SessionAmbiguityError
      );
    }
  );

  it('projects one Store ambiguity row and diagnoses it once without searching content', async () => {
    const root = fixture();
    const id = '55555555-2222-4555-8555-555555555555';
    storeDbOccurrence(root, 'candidate-a', id, root.projectA, 'divergent-a', 'Replica A');
    storeDbOccurrence(root, 'candidate-b', id, root.projectB, 'divergent-b', 'Replica B');
    const diagnostics: SessionDiagnostic[] = [];
    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      const logical = await listSessionSummaries(
        { limit: 0, all: true },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(logical).toHaveLength(1);
      expect(logical[0]).toMatchObject({
        id,
        resolutionState: 'ambiguous',
        sourceRoles: ['store'],
        occurrenceCount: 2,
      });
      expect(logical[0]?.diagnosticOccurrenceRefs).toHaveLength(2);

      await expect(
        listSessions({ limit: 0, all: true }, root.workspaceStorage, undefined, context)
      ).resolves.toEqual([]);
      await expect(
        searchSessions(
          'divergent-a',
          { limit: 0, contextChars: 50 },
          root.workspaceStorage,
          undefined,
          context
        )
      ).resolves.toEqual([]);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'SESSION_AMBIGUOUS',
          sessionId: id,
          occurrenceCount: 2,
        }),
      ]);
    } finally {
      await context.dispose();
    }

    const workspaces = await listWorkspaces(root.workspaceStorage);
    expect(
      workspaces
        .filter(({ path }) => path === root.projectA || path === root.projectB)
        .map(({ path, sessionCount }) => ({ path, sessionCount }))
        .sort((left, right) => left.path.localeCompare(right.path))
    ).toEqual([root.projectA, root.projectB].sort().map((path) => ({ path, sessionCount: 1 })));
  });

  it('retains every locator-free source instance and membership for equivalent Store copies', async () => {
    const root = fixture();
    const id = '66666666-2222-4666-8666-666666666666';
    storeDbOccurrence(root, 'copy-a', id, root.projectA, 'equivalent payload', 'Same title');
    storeDbOccurrence(root, 'copy-b', id, root.projectB, 'equivalent payload', 'Same title');
    const context = createSessionReadContext({ dataPath: root.workspaceStorage });
    try {
      const logical = await listSessionSummaries(
        { limit: 0, all: true },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(logical).toHaveLength(1);
      expect(logical[0]).toMatchObject({
        id,
        sourceInstances: [
          {
            sourceRole: 'store',
            representation: 'store-db',
            workspacePaths: [root.projectA],
            state: 'contributed',
          },
          {
            sourceRole: 'store',
            representation: 'store-db',
            workspacePaths: [root.projectB],
            state: 'equivalent-replica',
          },
        ],
        workspaceMemberships: [
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
        ],
      });

      const serialized = JSON.stringify(logical[0]);
      expect(serialized).not.toContain('store.db');
      expect(serialized).not.toContain('copy-a');
      expect(serialized).not.toContain('copy-b');
      expect(serialized).not.toContain('instanceKey');
      expect(serialized).not.toContain('chatDir');
      expect(serialized).not.toContain('storeDbPath');
    } finally {
      await context.dispose();
    }
  });
});
