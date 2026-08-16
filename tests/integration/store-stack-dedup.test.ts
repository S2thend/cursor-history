import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const storeRootState = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock('../../src/lib/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/platform.js')>(
    '../../src/lib/platform.js'
  );
  return {
    ...actual,
    getStoreStackRoot: () =>
      storeRootState.current ?? join(process.cwd(), 'tests', 'fixtures', 'store-root'),
  };
});

import { createSessionReadContext, getSession, listSessions } from '../../src/core/storage.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  writeStoreMeta,
  type ComposerFixtureSession,
} from '../helpers/session-integrity-fixtures.js';

const SESSION_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PROJECT_PATH = '/mnt/d/1_yuyu_proj/cursor-history';
const root = mkdtempSync(join(tmpdir(), 'cursor-history-hybrid-'));
const workspaceStorage = join(root, 'User', 'workspaceStorage');
const globalStorage = join(root, 'User', 'globalStorage');

beforeAll(() => {
  mkdirSync(workspaceStorage, { recursive: true });
  mkdirSync(globalStorage, { recursive: true });

  const db = new BetterSqlite3(join(globalStorage, 'state.vscdb'));
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');

  insert.run(
    `composerData:${SESSION_ID}`,
    JSON.stringify({
      name: 'Hybrid fixture session',
      createdAt: 1783737832293,
      lastUpdatedAt: 1783737833338,
      workspaceIdentifier: { uri: { fsPath: PROJECT_PATH } },
      fullConversationHeadersOnly: [
        { bubbleId: 'composer-user', type: 1 },
        { bubbleId: 'composer-assistant', type: 2 },
      ],
    })
  );
  insert.run(
    `bubbleId:${SESSION_ID}:composer-user`,
    JSON.stringify({
      bubbleId: 'composer-user',
      type: 1,
      text: 'Read foo.txt',
      createdAt: 1783737832293,
    })
  );
  insert.run(
    `bubbleId:${SESSION_ID}:composer-assistant`,
    JSON.stringify({
      bubbleId: 'composer-assistant',
      type: 2,
      text: 'Reading the file.',
      createdAt: 1783737833338,
      toolFormerData: {
        name: 'Read',
        status: 'completed',
        params: JSON.stringify({ path: '/tmp/foo.txt' }),
      },
    })
  );
  db.close();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  storeRootState.current = undefined;
});

describe('Composer + Store stack integration', () => {
  it('deduplicates the same ID and resolves one merged session with full provenance', async () => {
    const context = createSessionReadContext(workspaceStorage);
    const summaries = await listSessions(
      { limit: 0, all: true },
      workspaceStorage,
      undefined,
      context
    );
    const duplicates = summaries.filter((summary) => summary.id === SESSION_ID);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({
      title: 'Hybrid fixture session',
      // Listing cannot prove Composer fidelity without payload hydration, so it
      // remains conservative while still advertising actual merged provenance.
      source: 'workspace-fallback',
      resolvedSource: 'merged',
      sources: ['composer', 'store'],
      preferredSource: 'composer',
      workspacePath: PROJECT_PATH,
    });

    const session = await getSession(SESSION_ID, workspaceStorage, undefined, context);
    expect(session).not.toBeNull();
    expect(session).toMatchObject({
      id: SESSION_ID,
      title: 'Hybrid fixture session',
      source: 'workspace-fallback',
      resolvedSource: 'merged',
      sources: ['composer', 'store'],
      preferredSource: 'composer',
    });
    expect(session!.messages.map((message) => message.content)).toEqual([
      'Read foo.txt',
      'Reading the file.',
    ]);
    expect(session!.messages.every((message) => message.source === 'both')).toBe(true);
    expect(session!.messages[1]?.toolCalls).toEqual([expect.objectContaining({ name: 'Read' })]);

    const originalMessages = structuredClone(session!.messages);
    session!.messages[0]!.content = 'caller mutation';
    const byIndex = await getSession(duplicates[0]!.index, workspaceStorage, undefined, context);
    expect(byIndex?.id).toBe(SESSION_ID);
    expect(byIndex?.messages).toEqual(originalMessages);
    expect(byIndex).not.toBe(session);
    expect(context.resolvedSessions.size).toBe(1);
  });

  it('collapses duplicate Composer discovery into one deterministically ordered complementary row', async () => {
    const fixture = createSessionIntegrityFixtureRoot('ch-hybrid-replica-dedup-');
    storeRootState.current = fixture.storeRoot;
    const duplicateId = 'dddddddd-0000-0000-0000-000000000075';
    const composer: ComposerFixtureSession = {
      id: duplicateId,
      title: 'Composer canonical title',
      workspacePath: fixture.projectA,
      createdAt: 1_783_000_000_000,
      messages: [
        {
          id: 'composer-native-message',
          role: 'user',
          content: 'composer-complementary-content',
          createdAt: 1_783_000_000_000,
        },
      ],
    };

    try {
      // Create in deliberately non-canonical order. Discovery order must not
      // affect the logical row or public source-instance ordering.
      writeComposerWorkspaceSummary(fixture, 'z-copy', fixture.projectA, [composer]);
      writeComposerWorkspaceSummary(fixture, 'a-copy', fixture.projectA, [composer]);
      writeComposerGlobalSessions(fixture, [composer]);
      const dbPath = writeStoreDb(
        fixture,
        duplicateId,
        [{ role: 'assistant', content: 'store-complementary-content' }],
        'Store complement'
      );
      writeStoreMeta(dirname(dbPath), {
        cwd: fixture.projectA,
        title: 'Store complement',
        hasConversation: true,
        createdAtMs: 1_783_000_000_000,
      });

      const context = createSessionReadContext({
        dataPath: fixture.workspaceStorage,
        workspacePath: fixture.projectA,
      });
      const summaries = await listSessions(
        { limit: 0, all: true, workspacePath: fixture.projectA },
        fixture.workspaceStorage,
        undefined,
        context
      );
      const logicalRows = summaries.filter(({ id }) => id === duplicateId);

      expect(logicalRows).toHaveLength(1);
      expect(logicalRows[0]).toMatchObject({
        id: duplicateId,
        canonicalWorkspacePath: fixture.projectA,
        matchedWorkspacePath: fixture.projectA,
        resolvedSource: 'merged',
        sources: ['composer', 'store'],
        sourceInstances: [
          expect.objectContaining({
            sourceRole: 'composer',
            representation: 'composer-global',
            state: 'contributed',
          }),
          expect.objectContaining({
            sourceRole: 'composer',
            representation: 'composer-workspace',
            state: 'superseded',
          }),
          expect.objectContaining({
            sourceRole: 'composer',
            representation: 'composer-workspace',
            state: 'superseded',
          }),
          expect.objectContaining({
            sourceRole: 'store',
            representation: 'store-db',
            state: 'contributed',
          }),
        ],
      });

      const byId = await getSession(duplicateId, fixture.workspaceStorage, undefined, context);
      const byIndex = await getSession(
        logicalRows[0]!.index,
        fixture.workspaceStorage,
        undefined,
        context
      );
      expect(byIndex?.id).toBe(byId?.id);
      expect(byId?.messages.map(({ content }) => content)).toEqual(
        expect.arrayContaining(['composer-complementary-content', 'store-complementary-content'])
      );
      expect(byId?.sourceInstances).toEqual(logicalRows[0]!.sourceInstances);
    } finally {
      fixture.cleanup();
    }
  });
});
