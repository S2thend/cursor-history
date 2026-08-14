import BetterSqlite3 from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionReadContext,
  findWorkspaces,
  getSession,
  listSessionSummaries,
  listSessions,
  searchSessions,
} from '../../src/core/storage.js';
import { createBackup, readBackupManifest } from '../../src/core/backup.js';
import { migrateSession } from '../../src/lib/index.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  writeStoreMeta,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const UPPER_ID = 'AAAAAAAA-0000-4000-8000-000000000016';
const LOWER_ID = UPPER_ID.toLowerCase();
const fixtures: SessionIntegrityFixtureRoot[] = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-composer-case-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function session(
  root: SessionIntegrityFixtureRoot,
  id: string,
  title: string,
  content: string,
  createdAt: number
): ComposerFixtureSession {
  return {
    id,
    title,
    workspacePath: id === UPPER_ID ? root.projectA : root.projectB,
    createdAt,
    messages: [{ id: `${title}-bubble`, role: 'user', content, createdAt }],
  };
}

afterEach(() => {
  for (const value of fixtures.splice(0)) value.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe('v0.16 byte-exact session-ID identity', () => {
  it('does not attach a differently-cased bubble stream to a session', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Upper', 'owned-upper', 1_700_000_000_000);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [upper]);
    const globalPath = writeComposerGlobalSessions(root, [upper]);
    const db = new BetterSqlite3(globalPath);
    try {
      db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`bubbleId:${UPPER_ID}:Upper-bubble`);
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        `bubbleId:${LOWER_ID}:foreign-bubble`,
        JSON.stringify({ bubbleId: 'foreign-bubble', type: 1, text: 'foreign-lower' })
      );
    } finally {
      db.close();
    }

    const logical = await listSessionSummaries({ all: true, limit: 0 }, root.workspaceStorage);
    expect(logical).toEqual([
      expect.objectContaining({ id: UPPER_ID, resolutionState: 'partial' }),
    ]);
    await expect(getSession(UPPER_ID, root.workspaceStorage)).resolves.toMatchObject({
      id: UPPER_ID,
    });
    await expect(getSession(LOWER_ID, root.workspaceStorage)).resolves.toBeNull();
    await expect(
      searchSessions('foreign-lower', { limit: 0, contextChars: 40 }, root.workspaceStorage)
    ).resolves.toEqual([]);
  });

  it('keeps differently-cased UUIDs as two independently addressable sessions', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Upper', 'needle-upper', 1_800_000_000_000);
    const lower = session(root, LOWER_ID, 'Lower', 'needle-lower', 1_700_000_000_000);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [upper]);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [lower]);
    writeComposerGlobalSessions(root, [lower, upper]);

    const logical = await listSessionSummaries({ all: true, limit: 0 }, root.workspaceStorage);
    expect(logical.map(({ id }) => id)).toEqual([UPPER_ID, LOWER_ID]);
    await expect(getSession(UPPER_ID, root.workspaceStorage)).resolves.toMatchObject({
      id: UPPER_ID,
      messages: [expect.objectContaining({ content: 'needle-upper' })],
    });
    await expect(getSession(LOWER_ID, root.workspaceStorage)).resolves.toMatchObject({
      id: LOWER_ID,
      messages: [expect.objectContaining({ content: 'needle-lower' })],
    });
    await expect(
      searchSessions('needle-upper', { limit: 0, contextChars: 40 }, root.workspaceStorage)
    ).resolves.toEqual([expect.objectContaining({ sessionId: UPPER_ID })]);
    await expect(
      searchSessions('needle-lower', { limit: 0, contextChars: 40 }, root.workspaceStorage)
    ).resolves.toEqual([expect.objectContaining({ sessionId: LOWER_ID })]);
  });

  it('does not resolve an opposite-case direct query', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Upper', 'single-content', 1_700_000_000_000);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [upper]);
    writeComposerGlobalSessions(root, [upper]);

    await expect(getSession(UPPER_ID, root.workspaceStorage)).resolves.toMatchObject({
      id: UPPER_ID,
      messages: [expect.objectContaining({ content: 'single-content' })],
    });
    await expect(getSession(LOWER_ID, root.workspaceStorage)).resolves.toBeNull();
  });

  it('does not hydrate a workspace record from an opposite-case global carrier', async () => {
    const root = fixture();
    const workspace = session(root, UPPER_ID, 'Workspace authority', 'unused', 1_700_000_000_000);
    const global = session(
      root,
      LOWER_ID,
      'Global carrier',
      'global-carrier-content',
      1_700_000_000_000
    );
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [workspace]);
    writeComposerGlobalSessions(root, [global]);

    const assertResolved = async (backupPath?: string): Promise<void> => {
      const listed = await listSessions(
        { all: true, limit: 0 },
        backupPath ? undefined : root.workspaceStorage,
        backupPath
      );
      expect(listed.map(({ id }) => id)).toEqual([UPPER_ID, LOWER_ID]);
      expect(listed.find(({ id }) => id === UPPER_ID)).toMatchObject({
        id: UPPER_ID,
        source: 'workspace-fallback',
        resolutionState: 'partial',
      });
      const selected = await getSession(
        LOWER_ID,
        backupPath ? undefined : root.workspaceStorage,
        backupPath
      );
      expect(selected).toMatchObject({ id: LOWER_ID, source: 'global' });
      expect(selected?.messages.map(({ content }) => content)).toEqual(['global-carrier-content']);
    };

    await assertResolved();
    const backupPath = join(root.root, 'opposite-case-global-carrier.zip');
    await expect(
      createBackup({ sourcePath: root.workspaceStorage, outputPath: backupPath })
    ).resolves.toMatchObject({ success: true });
    await assertResolved(backupPath);
  });

  it('does not collapse equivalent payloads whose IDs differ by case', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Same', 'same-content', 1_700_000_000_000);
    const lower = { ...upper, id: LOWER_ID, workspacePath: root.projectB };
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [lower]);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [upper]);
    writeComposerGlobalSessions(root, [lower, upper]);

    const listed = await listSessions({ all: true, limit: 0 }, root.workspaceStorage);
    expect(new Set(listed.map(({ id }) => id))).toEqual(new Set([UPPER_ID, LOWER_ID]));
    const selected = await getSession(LOWER_ID, root.workspaceStorage);
    expect(selected).toMatchObject({ id: LOWER_ID });
    expect(selected?.messages.map(({ content }) => content)).toEqual(['same-content']);
  });

  it('keeps equivalent unlinked global-only case variants independently addressable', async () => {
    for (const lowerFirst of [true, false]) {
      const root = fixture();
      const upper = session(root, UPPER_ID, 'Same', 'global-only-same', 1_700_000_000_000);
      const lower = { ...upper, id: LOWER_ID };

      // Neither spelling has a workspace summary or pointer. Exercise both physical insertion
      // orders so neither public spelling nor selected payload can depend on scan order.
      writeComposerGlobalSessions(root, lowerFirst ? [lower, upper] : [upper, lower]);

      const listed = await listSessions({ all: true, limit: 0 }, root.workspaceStorage);
      expect(new Set(listed.map(({ id }) => id))).toEqual(new Set([UPPER_ID, LOWER_ID]));
      for (const query of [LOWER_ID, UPPER_ID]) {
        await expect(getSession(query, root.workspaceStorage)).resolves.toMatchObject({
          id: query,
          messages: [expect.objectContaining({ content: 'global-only-same' })],
        });
      }
    }
  });

  it('does not let a bubble-only case variant become addressable through another ID', async () => {
    const root = fixture();
    const lower = session(
      root,
      LOWER_ID,
      'Lower metadata authority',
      'equivalent-bubble-content',
      1_700_000_000_000
    );
    const globalPath = writeComposerGlobalSessions(root, [lower]);
    const db = new BetterSqlite3(globalPath);
    try {
      const row = db
        .prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ?')
        .get(`bubbleId:${LOWER_ID}:%`) as { key: string; value: string };
      db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
        row.key.replace(`bubbleId:${LOWER_ID}:`, `bubbleId:${UPPER_ID}:`),
        row.value
      );
    } finally {
      db.close();
    }

    const listed = await listSessions({ all: true, limit: 0 }, root.workspaceStorage);
    expect(listed).toEqual([
      expect.objectContaining({
        id: LOWER_ID,
        title: 'Lower metadata authority',
        resolutionState: 'complete',
      }),
    ]);
    await expect(getSession(UPPER_ID, root.workspaceStorage)).resolves.toBeNull();
    await expect(getSession(LOWER_ID, root.workspaceStorage)).resolves.toMatchObject({
      id: LOWER_ID,
      title: 'Lower metadata authority',
      messages: [expect.objectContaining({ content: 'equivalent-bubble-content' })],
    });

    const backupPath = join(root.root, 'bubble-only-case-spelling.zip');
    await expect(
      createBackup({ sourcePath: root.workspaceStorage, outputPath: backupPath })
    ).resolves.toMatchObject({ success: true });
    await expect(listSessions({ all: true, limit: 0 }, undefined, backupPath)).resolves.toEqual([
      expect.objectContaining({
        id: LOWER_ID,
        title: 'Lower metadata authority',
        resolutionState: 'complete',
      }),
    ]);
    await expect(getSession(UPPER_ID, undefined, backupPath)).resolves.toBeNull();
    await expect(getSession(LOWER_ID, undefined, backupPath)).resolves.toMatchObject({
      id: LOWER_ID,
      title: 'Lower metadata authority',
      messages: [expect.objectContaining({ content: 'equivalent-bubble-content' })],
    });
  });

  it('returns divergent unlinked global-only case variants separately for live and backup reads', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Upper', 'global-only-upper', 1_800_000_000_000);
    const lower = session(root, LOWER_ID, 'Lower', 'global-only-lower', 1_700_000_000_000);

    // Reverse the deterministic public-spelling order to prove discovery order is irrelevant.
    writeComposerGlobalSessions(root, [lower, upper]);

    const assertAmbiguous = async (backupPath?: string): Promise<void> => {
      const listed = await listSessionSummaries(
        { all: true, limit: 0 },
        backupPath ? undefined : root.workspaceStorage,
        backupPath
      );
      expect(listed.map(({ id }) => id)).toEqual([UPPER_ID, LOWER_ID]);
      await expect(
        getSession(UPPER_ID, backupPath ? undefined : root.workspaceStorage, backupPath)
      ).resolves.toMatchObject({
        id: UPPER_ID,
        messages: [expect.objectContaining({ content: 'global-only-upper' })],
      });
      await expect(
        getSession(LOWER_ID, backupPath ? undefined : root.workspaceStorage, backupPath)
      ).resolves.toMatchObject({
        id: LOWER_ID,
        messages: [expect.objectContaining({ content: 'global-only-lower' })],
      });
    };

    await assertAmbiguous();

    const backupPath = join(root.root, 'global-only-case-variants.zip');
    await expect(
      createBackup({ sourcePath: root.workspaceStorage, outputPath: backupPath })
    ).resolves.toMatchObject({ success: true });
    await assertAmbiguous(backupPath);
  });

  it('does not borrow payload from an opposite-case global-only session', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Metadata only', 'remove-me', 1_800_000_000_000);
    const lower = session(root, LOWER_ID, 'Payload', 'surviving-lower-payload', 1_700_000_000_000);
    const globalPath = writeComposerGlobalSessions(root, [lower, upper]);
    const db = new BetterSqlite3(globalPath);
    try {
      db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(
        `bubbleId:${UPPER_ID}:Metadata only-bubble`
      );
    } finally {
      db.close();
    }

    await expect(
      listSessionSummaries({ all: true, limit: 0 }, root.workspaceStorage)
    ).resolves.toEqual([expect.objectContaining({ id: LOWER_ID })]);
    await expect(getSession(UPPER_ID, root.workspaceStorage)).resolves.toBeNull();
    await expect(getSession(LOWER_ID, root.workspaceStorage)).resolves.toMatchObject({
      id: LOWER_ID,
      messages: [expect.objectContaining({ content: 'surviving-lower-payload' })],
    });

    const backupPath = join(root.root, 'metadata-only-preferred-spelling.zip');
    await expect(
      createBackup({ sourcePath: root.workspaceStorage, outputPath: backupPath })
    ).resolves.toMatchObject({ success: true });
    await expect(
      listSessionSummaries({ all: true, limit: 0 }, undefined, backupPath)
    ).resolves.toEqual([expect.objectContaining({ id: LOWER_ID })]);
    await expect(getSession(UPPER_ID, undefined, backupPath)).resolves.toBeNull();
    await expect(getSession(LOWER_ID, undefined, backupPath)).resolves.toMatchObject({
      id: LOWER_ID,
      messages: [expect.objectContaining({ content: 'surviving-lower-payload' })],
    });
  });

  it('does not merge Composer and Store sessions whose IDs differ by case', async () => {
    const root = fixture();
    const composer = session(root, LOWER_ID, 'Composer', 'composer-content', 1_700_000_000_000);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [composer]);
    writeComposerGlobalSessions(root, [composer]);
    const storeDb = writeStoreDb(
      root,
      UPPER_ID,
      [{ role: 'assistant', content: 'store-content' }],
      'Store'
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: root.projectA,
      title: 'Store',
      hasConversation: true,
      createdAtMs: 1_700_000_000_000,
    });

    const listed = await listSessions({ all: true, limit: 0 }, root.workspaceStorage);
    expect(new Set(listed.map(({ id }) => id))).toEqual(new Set([UPPER_ID, LOWER_ID]));
    expect(listed.find(({ id }) => id === LOWER_ID)).toMatchObject({
      id: LOWER_ID,
      resolvedSource: 'composer',
    });
    expect(listed.find(({ id }) => id === UPPER_ID)).toMatchObject({ id: UPPER_ID });
    const selected = await getSession(UPPER_ID, root.workspaceStorage);
    expect(selected).toMatchObject({ id: UPPER_ID });
    expect(selected?.messages.map(({ content }) => content)).toEqual(['store-content']);
    await expect(getSession(LOWER_ID, root.workspaceStorage)).resolves.toMatchObject({
      id: LOWER_ID,
      messages: [expect.objectContaining({ content: 'composer-content' })],
    });
  });

  it('does not hydrate an opted-in Store session from an opposite-case Composer occurrence', async () => {
    const root = fixture();
    const composer = session(
      root,
      LOWER_ID,
      'Off-scope Composer',
      'off-scope-composer-content',
      1_700_000_000_000
    );
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [composer]);
    const storeDb = writeStoreDb(
      root,
      UPPER_ID,
      [{ role: 'assistant', content: 'in-scope-store-content' }],
      'In-scope Store'
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: root.projectA,
      title: 'In-scope Store',
      hasConversation: true,
      createdAtMs: 1_700_000_000_000,
    });

    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
    });
    try {
      const listed = await listSessions(
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
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: UPPER_ID, resolvedSource: 'store-metadata' });
      const hydrated = await getSession(
        UPPER_ID,
        root.workspaceStorage,
        undefined,
        context,
        listed[0]!.index
      );
      expect(hydrated).toMatchObject({ id: UPPER_ID });
      expect(hydrated!.messages.map(({ content }) => content)).toEqual(['in-scope-store-content']);
    } finally {
      await context.dispose();
    }
  });

  it('hydrates only the exact off-scope Composer spelling selected by Store', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Upper off-scope', 'upper', 1_800_000_000_000);
    const lower = session(root, LOWER_ID, 'Lower off-scope', 'lower', 1_700_000_000_000);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [lower, upper]);
    const storeDb = writeStoreDb(
      root,
      UPPER_ID,
      [{ role: 'assistant', content: 'in-scope-store-content' }],
      'In-scope Store'
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: root.projectA,
      title: 'In-scope Store',
      hasConversation: true,
      createdAtMs: 1_700_000_000_000,
    });

    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
    });
    try {
      const listed = await listSessionSummaries(
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
      expect(listed).toEqual([
        expect.objectContaining({
          id: UPPER_ID,
          resolvedSource: 'merged',
        }),
      ]);
      await expect(
        getSession(UPPER_ID, root.workspaceStorage, undefined, context, listed[0]!.index)
      ).resolves.toMatchObject({
        id: UPPER_ID,
        messages: expect.arrayContaining([
          expect.objectContaining({ content: 'Upper off-scope' }),
          expect.objectContaining({ content: 'in-scope-store-content' }),
        ]),
      });
      await expect(
        getSession(LOWER_ID, root.workspaceStorage, undefined, context)
      ).resolves.toBeNull();
    } finally {
      await context.dispose();
    }
  });

  it('writes backup pointer membership with its exact native spelling', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Same', 'same-content', 1_700_000_000_000);
    const lower = { ...upper, id: LOWER_ID };
    const workspaceDbPath = writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
    const workspaceDb = new BetterSqlite3(workspaceDbPath);
    try {
      workspaceDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          `workbench.panel.composerChatViewPane.${LOWER_ID}`,
          JSON.stringify({ selectedComposerId: LOWER_ID })
        );
    } finally {
      workspaceDb.close();
    }
    // Reverse lexical spelling order in the physical global insertion sequence.
    writeComposerGlobalSessions(root, [lower, upper]);
    const backupPath = join(root.root, 'case-membership.zip');
    const result = await createBackup({
      sourcePath: root.workspaceStorage,
      outputPath: backupPath,
    });
    expect(result.success).toBe(true);
    await expect(readBackupManifest(backupPath)).resolves.toMatchObject({
      composerWorkspaceInventory: {
        schemaVersion: 1,
        workspaces: [
          expect.objectContaining({
            workspaceId: 'workspace-a',
            sessionIds: [],
            linkedGlobalSessionIds: [LOWER_ID],
          }),
        ],
      },
    });
    await expect(
      listSessions({ all: true, limit: 0, workspacePath: root.projectA }, undefined, backupPath)
    ).resolves.toEqual([
      expect.objectContaining({
        id: LOWER_ID,
        source: 'workspace-fallback',
        resolutionState: 'partial',
        resolution: expect.objectContaining({
          reasonCodes: expect.arrayContaining(['workspace-scope-omitted']),
        }),
      }),
    ]);
  });

  it('does not link a lower-case pointer-only workspace to an uppercase global carrier', async () => {
    const root = fixture();
    const workspaceDbPath = writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
    const workspaceDb = new BetterSqlite3(workspaceDbPath);
    try {
      workspaceDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          `workbench.panel.composerChatViewPane.${LOWER_ID}`,
          JSON.stringify({ selectedComposerId: LOWER_ID })
        );
    } finally {
      workspaceDb.close();
    }

    const carrier = session(
      root,
      UPPER_ID,
      'Unstamped global carrier',
      'pointer-case-live-needle',
      1_700_000_000_000
    );
    const globalPath = writeComposerGlobalSessions(root, [carrier]);
    const globalDb = new BetterSqlite3(globalPath);
    try {
      const key = `composerData:${UPPER_ID}`;
      const row = globalDb.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key) as {
        value: string;
      };
      const metadata = JSON.parse(row.value) as Record<string, unknown>;
      delete metadata['composerId'];
      delete metadata['workspaceIdentifier'];
      delete metadata['workspaceId'];
      delete metadata['workspacePath'];
      globalDb
        .prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?')
        .run(JSON.stringify(metadata), key);
    } finally {
      globalDb.close();
    }

    await expect(findWorkspaces(root.workspaceStorage)).resolves.toEqual([]);

    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
    });
    try {
      const listed = await listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(listed).toEqual([]);
      await expect(
        getSession(UPPER_ID, root.workspaceStorage, undefined, context)
      ).resolves.toBeNull();
      await expect(
        searchSessions(
          'pointer-case-live-needle',
          { limit: 0, contextChars: 40, workspacePath: root.projectA },
          root.workspaceStorage,
          undefined,
          context
        )
      ).resolves.toEqual([]);
    } finally {
      await context.dispose();
    }
  });

  it('links an exact-case pointer-only workspace to an unstamped global carrier', async () => {
    const root = fixture();
    const workspaceDbPath = writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
    const workspaceDb = new BetterSqlite3(workspaceDbPath);
    try {
      workspaceDb
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          `workbench.panel.composerChatViewPane.${UPPER_ID}`,
          JSON.stringify({ selectedComposerId: UPPER_ID })
        );
    } finally {
      workspaceDb.close();
    }

    const carrier = session(
      root,
      UPPER_ID,
      'Exact unstamped global carrier',
      'exact-pointer-live-needle',
      1_700_000_000_000
    );
    const globalPath = writeComposerGlobalSessions(root, [carrier]);
    const globalDb = new BetterSqlite3(globalPath);
    try {
      const key = `composerData:${UPPER_ID}`;
      const row = globalDb.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key) as {
        value: string;
      };
      const metadata = JSON.parse(row.value) as Record<string, unknown>;
      delete metadata['composerId'];
      delete metadata['workspaceIdentifier'];
      delete metadata['workspaceId'];
      delete metadata['workspacePath'];
      globalDb
        .prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?')
        .run(JSON.stringify(metadata), key);
    } finally {
      globalDb.close();
    }

    await expect(findWorkspaces(root.workspaceStorage)).resolves.toEqual([
      expect.objectContaining({ id: 'workspace-a', path: root.projectA, sessionCount: 1 }),
    ]);

    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
    });
    try {
      const listed = await listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(listed).toEqual([
        expect.objectContaining({
          id: UPPER_ID,
          source: 'global',
          resolutionState: 'complete',
          preview: 'exact-pointer-live-needle',
        }),
      ]);
      await expect(
        getSession(UPPER_ID, root.workspaceStorage, undefined, context, listed[0]!.index)
      ).resolves.toMatchObject({
        id: UPPER_ID,
        messages: [expect.objectContaining({ content: 'exact-pointer-live-needle' })],
      });
      await expect(
        searchSessions(
          'exact-pointer-live-needle',
          { limit: 0, contextChars: 40, workspacePath: root.projectA },
          root.workspaceStorage,
          undefined,
          context
        )
      ).resolves.toEqual([
        expect.objectContaining({ sessionId: UPPER_ID, workspacePath: root.projectA }),
      ]);
    } finally {
      await context.dispose();
    }
  });

  it('does not migrate an opposite-case bubble-only occurrence', async () => {
    const root = fixture();
    const upper = session(root, UPPER_ID, 'Upper', 'move-upper', 1_700_000_000_000);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [upper]);
    writeComposerWorkspaceSummary(root, 'workspace-destination', root.projectB, []);
    const globalPath = writeComposerGlobalSessions(root, [upper]);
    const db = new BetterSqlite3(globalPath);
    try {
      const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
      for (let index = 0; index < 8; index++) {
        insert.run(
          `bubbleId:${LOWER_ID}:foreign-${String(index)}`,
          JSON.stringify({ bubbleId: `foreign-${String(index)}`, type: 1, text: 'foreign' })
        );
      }
    } finally {
      db.close();
    }
    const beforeDb = new BetterSqlite3(globalPath, { readonly: true });
    const before = beforeDb
      .prepare(
        'SELECT key, value FROM cursorDiskKV WHERE substr(CAST(key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB) ORDER BY key'
      )
      .all(`bubbleId:${LOWER_ID}:`, `bubbleId:${LOWER_ID}:`);
    beforeDb.close();

    await expect(
      migrateSession({
        sessions: LOWER_ID,
        destination: root.projectB,
        workspace: root.projectA,
        dataPath: root.workspaceStorage,
        sourceReadLimits: { sqlitePageRows: 2, sqliteRowCount: 64 },
      })
    ).rejects.toMatchObject({ code: 'SESSION_SCOPE_MISMATCH' });
    const verify = new BetterSqlite3(globalPath, { readonly: true });
    try {
      expect(
        verify
          .prepare(
            'SELECT key, value FROM cursorDiskKV WHERE substr(CAST(key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB) ORDER BY key'
          )
          .all(`bubbleId:${LOWER_ID}:`, `bubbleId:${LOWER_ID}:`)
      ).toEqual(before);
    } finally {
      verify.close();
    }
  });
});
