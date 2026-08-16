import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';

import { computeChecksum, readBackupManifest } from '../../src/core/backup.js';
import { exportToJson } from '../../src/core/parser.js';
import {
  createSessionReadContext,
  getSession,
  listSessions,
  listWorkspaces,
  searchSessions,
} from '../../src/core/storage.js';
import {
  exportAllSessionsToJson,
  exportAllSessionsToMarkdown,
  getSession as getLibrarySession,
  listSessions as listLibrarySessions,
  searchSessions as searchLibrarySessions,
} from '../../src/lib/index.js';
import {
  createFixtureBackup,
  createSessionIntegrityFixtureRoot,
  SESSION_INTEGRITY_IDS,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { createIoEventRecorder } from '../helpers/io-probe.js';

const fixtures: SessionIntegrityFixtureRoot[] = [];

function fixture(prefix: string): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot(prefix);
  fixtures.push(value);
  return value;
}

function session(
  id: string,
  workspacePath: string,
  title: string,
  createdAt: number
): ComposerFixtureSession {
  return {
    id,
    title,
    workspacePath,
    createdAt,
    messages: [{ role: 'user', content: title, createdAt }],
  };
}

async function rewriteBackup(
  sourcePath: string,
  destinationPath: string,
  mutate: (zip: JSZip, manifest: Record<string, unknown>) => void
): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(sourcePath));
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) throw new Error('Synthetic backup has no manifest.');
  const manifest = JSON.parse(await manifestEntry.async('string')) as Record<string, unknown>;
  mutate(zip, manifest);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  writeFileSync(
    destinationPath,
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    { mode: 0o600 }
  );
}

async function stripWorkspaceInventory(sourcePath: string, destinationPath: string): Promise<void> {
  await rewriteBackup(sourcePath, destinationPath, (_zip, manifest) => {
    delete manifest['composerWorkspaceInventory'];
    manifest['version'] = '1.0.0';
  });
}

async function poisonArchiveDatabaseEntries(
  sourcePath: string,
  destinationPath: string,
  entryPaths: readonly string[]
): Promise<void> {
  await rewriteBackup(sourcePath, destinationPath, (zip, manifest) => {
    const files = manifest['files'] as Array<Record<string, unknown>>;
    for (const entryPath of entryPaths) {
      const poison = Buffer.from(`poison: archive entry must never be extracted: ${entryPath}`);
      zip.file(entryPath, poison);
      const file = files.find(({ path }) => path === entryPath);
      if (!file) throw new Error('Synthetic backup manifest omitted the poison entry.');
      file['size'] = poison.length;
      file['checksum'] = computeChecksum(poison);
    }
  });
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
});

describe('workspace-scoped backup I/O boundary', () => {
  it.each([
    ['workbench.panel.aichat.view.aichat.chatdata', 'absent'],
    ['workbench.panel.chat.view.chat.chatdata', 'absent'],
    ['workbench.panel.aichat.view.aichat.chatdata', 'stale'],
    ['workbench.panel.chat.view.chat.chatdata', 'malformed'],
  ] as const)(
    'inventories and reads %s with a %s modern candidate',
    async (legacyKey, modernState) => {
      const root = fixture(`cursor-history-backup-legacy-${modernState}-`);
      const id = legacyKey.includes('aichat')
        ? modernState === 'absent'
          ? '10000000-2000-4000-8000-000000000016'
          : '20000000-2000-4000-8000-000000000016'
        : modernState === 'absent'
          ? '30000000-2000-4000-8000-000000000016'
          : '40000000-2000-4000-8000-000000000016';
      const workspacePath = writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
      const db = new BetterSqlite3(workspacePath);
      try {
        db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
          legacyKey,
          JSON.stringify({
            chatSessions: [
              {
                id,
                title: `legacy-${modernState}`,
                createdAt: 1_700_000_000_000,
                messages: [
                  {
                    id: 'legacy-message',
                    role: 'user',
                    content: `legacy-${modernState}-needle`,
                    timestamp: 1_700_000_000_000,
                  },
                ],
              },
            ],
          })
        );
        if (modernState === 'absent') {
          db.prepare("DELETE FROM ItemTable WHERE key = 'composer.composerData'").run();
        } else if (modernState === 'stale') {
          db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'").run(
            JSON.stringify({ allComposers: [] })
          );
        } else {
          db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'").run(
            '{malformed'
          );
        }
      } finally {
        db.close();
      }

      const backup = await createFixtureBackup(root, `legacy-${modernState}.zip`);
      await expect(readBackupManifest(backup)).resolves.toMatchObject({
        composerWorkspaceInventory: {
          schemaVersion: 1,
          workspaces: [expect.objectContaining({ sessionIds: [id] })],
        },
      });

      for (const workspace of [undefined, root.projectA]) {
        const config = { backupPath: backup, ...(workspace ? { workspace } : {}) };
        const listed = await listLibrarySessions(config);
        expect(listed.data).toHaveLength(1);
        expect(listed.data[0]).toMatchObject({
          id,
          messages: [expect.objectContaining({ content: `legacy-${modernState}-needle` })],
        });
        await expect(getLibrarySession(id, config)).resolves.toMatchObject({ id });
        await expect(
          searchLibrarySessions(`legacy-${modernState}-needle`, config)
        ).resolves.toMatchObject([{ session: expect.objectContaining({ id }) }]);
        await expect(exportAllSessionsToJson(config)).resolves.toContain(
          `legacy-${modernState}-needle`
        );
        await expect(exportAllSessionsToMarkdown(config)).resolves.toContain(
          `legacy-${modernState}-needle`
        );
      }
    }
  );

  it('surfaces unlinked global-only Composer sessions only in the unfiltered archive catalog', async () => {
    const root = fixture('cursor-history-backup-global-catch-all-');
    const workspaceSession = session(
      SESSION_INTEGRITY_IDS.workspaceA,
      root.projectA,
      'workspace-a visible conversation',
      1_784_900_000_000
    );
    const globalOnlyId = 'abababab-0000-0000-0000-000000000016';
    const globalOnly = session(
      globalOnlyId,
      root.projectB,
      'unlinked global catch-all title',
      1_785_100_000_000
    );
    globalOnly.messages = [
      {
        role: 'user',
        content: 'unlinked global catch-all payload',
        createdAt: 1_785_100_000_000,
      },
    ];

    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [workspaceSession]);
    writeComposerGlobalSessions(root, [workspaceSession, globalOnly]);
    const backup = await createFixtureBackup(root, 'global-catch-all.zip');

    await expect(readBackupManifest(backup)).resolves.toMatchObject({
      composerWorkspaceInventory: {
        workspaces: [
          {
            workspaceId: 'workspace-a',
            sessionIds: [SESSION_INTEGRITY_IDS.workspaceA],
            globalCounterpartSessionIds: [SESSION_INTEGRITY_IDS.workspaceA],
            linkedGlobalSessionIds: [],
          },
        ],
      },
    });

    const unfiltered = await listSessions({ all: true, limit: 0 }, undefined, backup);
    expect(unfiltered.filter(({ id }) => id === globalOnlyId)).toMatchObject([
      {
        id: globalOnlyId,
        title: 'unlinked global catch-all title',
        workspaceId: 'global',
        source: 'global',
        resolutionState: 'complete',
      },
    ]);
    await expect(getSession(globalOnlyId, undefined, backup)).resolves.toMatchObject({
      id: globalOnlyId,
      source: 'global',
      messages: [expect.objectContaining({ content: 'unlinked global catch-all payload' })],
    });
    await expect(
      searchSessions(
        'unlinked global catch-all payload',
        { all: true, limit: 0 },
        undefined,
        backup
      )
    ).resolves.toMatchObject([expect.objectContaining({ sessionId: globalOnlyId })]);

    const json = JSON.parse(await exportAllSessionsToJson({ backupPath: backup })) as Array<{
      id: string;
      messages: Array<{ content: string }>;
    }>;
    expect(json.filter(({ id }) => id === globalOnlyId)).toMatchObject([
      {
        id: globalOnlyId,
        messages: [expect.objectContaining({ content: 'unlinked global catch-all payload' })],
      },
    ]);
    const markdown = await exportAllSessionsToMarkdown({ backupPath: backup });
    expect(markdown).toContain('# unlinked global catch-all title');
    expect(markdown).toContain('unlinked global catch-all payload');

    const scopedRecorder = createIoEventRecorder();
    const scopedContext = createSessionReadContext({
      backupPath: backup,
      workspacePath: root.projectA,
      ioObserver: scopedRecorder.observer,
    });
    try {
      const scoped = await listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        undefined,
        backup,
        scopedContext
      );
      expect(scoped.map(({ id }) => id)).toEqual([SESSION_INTEGRITY_IDS.workspaceA]);
      await expect(
        searchSessions(
          'unlinked global catch-all payload',
          { all: true, limit: 0, workspacePath: root.projectA },
          undefined,
          backup,
          scopedContext
        )
      ).resolves.toEqual([]);
      scopedRecorder.assertNone(
        { resourceClass: 'backup-entry', representation: 'composer-global' },
        'workspace scope must not admit or extract an unlinked global-only session'
      );
    } finally {
      await scopedContext.dispose();
    }

    await expect(
      exportAllSessionsToJson({ backupPath: backup, workspace: root.projectA })
    ).resolves.not.toContain(globalOnlyId);
    await expect(
      exportAllSessionsToMarkdown({ backupPath: backup, workspace: root.projectA })
    ).resolves.not.toContain('unlinked global catch-all payload');
  });

  it('keeps a verified workspace-linked global-only UUID addressable without global extraction', async () => {
    const root = fixture('cursor-history-backup-global-link-');
    const globalOnlyId = 'cccccccc-0000-0000-0000-000000000016';
    const phantomPointerId = 'ffffffff-0000-0000-0000-000000000016';
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
    const workspaceDb = new BetterSqlite3(
      join(root.workspaceStorage, 'workspace-a', 'state.vscdb')
    );
    try {
      workspaceDb
        .prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          'workbench.panel.composerChatViewPane.pointer',
          JSON.stringify([globalOnlyId, phantomPointerId])
        );
    } finally {
      workspaceDb.close();
    }
    const globalOnlySession = session(
      globalOnlyId,
      root.projectA,
      'global-only secret',
      1_785_000_000_000
    );
    writeComposerGlobalSessions(root, [globalOnlySession]);

    // A second workspace may point at the same global UUID. Unfiltered discovery must still
    // produce one complete logical session, while each scoped membership remains independently
    // addressable without opening the shared carrier.
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, []);
    const workspaceB = new BetterSqlite3(join(root.workspaceStorage, 'workspace-b', 'state.vscdb'));
    try {
      workspaceB
        .prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        .run('workbench.panel.composerChatViewPane.pointer', JSON.stringify([globalOnlyId]));
    } finally {
      workspaceB.close();
    }

    const backup = await createFixtureBackup(root, 'global-link.zip');
    const globalOnlyWorkspaces = await listWorkspaces(undefined, backup);
    expect(globalOnlyWorkspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'workspace-a', path: root.projectA, sessionCount: 1 }),
        expect.objectContaining({ id: 'workspace-b', path: root.projectB, sessionCount: 1 }),
      ])
    );
    const unscoped = await listSessions({ all: true, limit: 0 }, undefined, backup);
    expect(unscoped).toMatchObject([
      {
        id: globalOnlyId,
        title: 'global-only secret',
        source: 'global',
        resolutionState: 'complete',
      },
    ]);
    const unscopedSession = await getSession(globalOnlyId, undefined, backup);
    expect(unscopedSession).toMatchObject({
      id: globalOnlyId,
      source: 'global',
      messages: [expect.objectContaining({ content: 'global-only secret' })],
    });
    await expect(
      searchSessions('global-only secret', { all: true, limit: 0 }, undefined, backup)
    ).resolves.toMatchObject([expect.objectContaining({ sessionId: globalOnlyId })]);
    const unscopedExport = JSON.parse(
      await exportAllSessionsToJson({ backupPath: backup })
    ) as Array<{ id: string; messages: Array<{ content: string }> }>;
    expect(unscopedExport).toMatchObject([
      { id: globalOnlyId, messages: [expect.objectContaining({ content: 'global-only secret' })] },
    ]);
    const poisoned = `${backup}.poisoned.zip`;
    await poisonArchiveDatabaseEntries(backup, poisoned, ['globalStorage/state.vscdb']);
    await expect(readBackupManifest(poisoned)).resolves.toMatchObject({
      composerWorkspaceInventory: {
        workspaces: [
          {
            workspaceId: 'workspace-a',
            sessionIds: [],
            globalCounterpartSessionIds: [],
            linkedGlobalSessionIds: [globalOnlyId],
          },
          {
            workspaceId: 'workspace-b',
            sessionIds: [],
            globalCounterpartSessionIds: [],
            linkedGlobalSessionIds: [globalOnlyId],
          },
        ],
      },
    });

    const recorder = createIoEventRecorder();
    const context = createSessionReadContext({
      backupPath: poisoned,
      workspacePath: root.projectA,
      ioObserver: recorder.observer,
    });
    try {
      const rows = await listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        undefined,
        poisoned,
        context
      );
      expect(rows).toHaveLength(1);
      expect(rows).toMatchObject([
        {
          id: globalOnlyId,
          title: null,
          messageCount: 0,
          source: 'workspace-fallback',
          resolutionState: 'partial',
          sourceInstances: expect.arrayContaining([
            expect.objectContaining({
              representation: 'composer-global',
              state: 'omitted-by-scope',
            }),
          ]),
        },
      ]);
      const resolved = await getSession(globalOnlyId, undefined, poisoned, context);
      expect(resolved).toMatchObject({
        id: globalOnlyId,
        messages: [],
        messageCount: 0,
        source: 'workspace-fallback',
        resolutionState: 'partial',
      });
      await expect(
        searchSessions(
          'global-only secret',
          { limit: 0, contextChars: 20, workspacePath: root.projectA },
          undefined,
          poisoned,
          context
        )
      ).resolves.toEqual([]);
      recorder.assertNone(
        { resourceClass: 'backup-entry', representation: 'composer-global' },
        'global-only scoped hydration must not extract the shared global database'
      );
    } finally {
      await context.dispose();
    }

    const exported = JSON.parse(
      await exportAllSessionsToJson({ backupPath: poisoned, workspace: root.projectA })
    ) as Array<{ id: string; messages: unknown[]; resolution: { state: string } }>;
    expect(exported).toMatchObject([
      { id: globalOnlyId, messages: [], resolution: { state: 'partial' } },
    ]);
  });

  it('does not turn a pointer to metadata-only global Composer data into an empty session', async () => {
    const root = fixture('cursor-history-backup-metadata-only-pointer-');
    const metadataOnlyId = 'dddddddd-2000-4000-8000-000000000016';
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
    const workspaceDb = new BetterSqlite3(
      join(root.workspaceStorage, 'workspace-a', 'state.vscdb')
    );
    try {
      workspaceDb
        .prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        .run('workbench.panel.composerChatViewPane.pointer', JSON.stringify([metadataOnlyId]));
    } finally {
      workspaceDb.close();
    }
    const globalPath = writeComposerGlobalSessions(root, [
      session(metadataOnlyId, root.projectA, 'metadata-only', 1_785_000_000_000),
    ]);
    const globalDb = new BetterSqlite3(globalPath);
    try {
      globalDb.prepare("DELETE FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").run();
    } finally {
      globalDb.close();
    }

    await expect(
      listSessions({ all: true, limit: 0, workspacePath: root.projectA }, root.workspaceStorage)
    ).resolves.toEqual([]);

    const backup = await createFixtureBackup(root, 'metadata-only-pointer.zip');
    await expect(readBackupManifest(backup)).resolves.toMatchObject({
      version: '1.0.0',
      composerWorkspaceInventory: {
        schemaVersion: 1,
        workspaces: [
          expect.objectContaining({
            workspaceId: 'workspace-a',
            sessionIds: [],
            globalCounterpartSessionIds: [],
            linkedGlobalSessionIds: [],
          }),
        ],
      },
    });
    await expect(
      listSessions({ all: true, limit: 0, workspacePath: root.projectA }, undefined, backup)
    ).resolves.toEqual([]);
  });

  it.each(['selectedComposerIds', 'pane-pointer'] as const)(
    'keeps a legacy single-workspace %s global membership scoped-readable without global extraction',
    async (pointerKind) => {
      const root = fixture(`cursor-history-backup-legacy-${pointerKind}-`);
      const id =
        pointerKind === 'selectedComposerIds'
          ? '55555555-2000-4000-8000-000000000016'
          : '66666666-2000-4000-8000-000000000016';
      const workspaceDbPath = writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
      const workspaceDb = new BetterSqlite3(workspaceDbPath);
      try {
        if (pointerKind === 'selectedComposerIds') {
          workspaceDb
            .prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerData'")
            .run(JSON.stringify({ allComposers: [], selectedComposerIds: [id] }));
        } else {
          workspaceDb
            .prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
            .run('workbench.panel.composerChatViewPane.pointer', JSON.stringify([id]));
        }
      } finally {
        workspaceDb.close();
      }
      writeComposerGlobalSessions(root, [
        session(id, root.projectA, `legacy-${pointerKind}-secret`, 1_785_000_000_000),
      ]);
      const current = await createFixtureBackup(root, `${pointerKind}-current.zip`);
      const legacy = join(root.root, `${pointerKind}-legacy.zip`);
      await stripWorkspaceInventory(current, legacy);

      const unscoped = await listLibrarySessions({ backupPath: legacy });
      expect(unscoped.data).toMatchObject([
        {
          id,
          source: 'global',
          messages: [expect.objectContaining({ content: `legacy-${pointerKind}-secret` })],
        },
      ]);

      const scopedConfig = { backupPath: legacy, workspace: root.projectA };
      const scoped = await listLibrarySessions(scopedConfig);
      expect(scoped.data).toMatchObject([
        {
          id,
          source: 'workspace-fallback',
          resolutionState: 'partial',
          messages: [],
        },
      ]);
      await expect(getLibrarySession(id, scopedConfig)).resolves.toMatchObject({
        id,
        source: 'workspace-fallback',
        messages: [],
      });
      await expect(
        searchLibrarySessions(`legacy-${pointerKind}-secret`, scopedConfig)
      ).resolves.toEqual([]);
      const json = JSON.parse(await exportAllSessionsToJson(scopedConfig)) as Array<{
        id: string;
        messages: unknown[];
      }>;
      expect(json).toMatchObject([{ id, messages: [] }]);
      await expect(exportAllSessionsToMarkdown(scopedConfig)).resolves.not.toContain(
        `legacy-${pointerKind}-secret`
      );
    }
  );

  it('builds inventory from valid negative and zero SQLite rowids', async () => {
    const root = fixture('cursor-history-backup-signed-rowid-');
    const signedRowIdSession = session(
      'eeeeeeee-2000-4000-8000-000000000016',
      root.projectA,
      'signed-rowid',
      1_785_000_000_000
    );
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [signedRowIdSession]);
    const globalPath = writeComposerGlobalSessions(root, [signedRowIdSession]);
    const globalDb = new BetterSqlite3(globalPath);
    try {
      const bubble = globalDb
        .prepare("SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
        .get() as { rowid: number; key: string; value: string };
      globalDb.prepare('UPDATE cursorDiskKV SET rowid = -1 WHERE rowid = ?').run(bubble.rowid);
      globalDb
        .prepare('INSERT INTO cursorDiskKV (rowid, key, value) VALUES (0, ?, ?)')
        .run(`${bubble.key}-second`, bubble.value);
    } finally {
      globalDb.close();
    }

    const backup = await createFixtureBackup(root, 'signed-rowid.zip');
    await expect(readBackupManifest(backup)).resolves.toMatchObject({
      composerWorkspaceInventory: {
        schemaVersion: 1,
        workspaces: [
          expect.objectContaining({
            workspaceId: 'workspace-a',
            globalCounterpartSessionIds: [signedRowIdSession.id],
          }),
        ],
      },
    });
  });

  it('uses canonical manifest membership without extracting an unrelated workspace database', async () => {
    const onlyA = fixture('cursor-history-backup-scope-a-only-');
    const both = fixture('cursor-history-backup-scope-a-b-');
    const sessionAOnly = session(
      SESSION_INTEGRITY_IDS.workspaceA,
      onlyA.projectA,
      'needle-a',
      1_783_000_000_000
    );
    const sessionA = session(
      SESSION_INTEGRITY_IDS.workspaceA,
      both.projectA,
      'needle-a',
      1_783_000_000_000
    );
    const sessionB = session(
      SESSION_INTEGRITY_IDS.workspaceB,
      both.projectB,
      'needle-b',
      1_784_000_000_000
    );
    writeComposerWorkspaceSummary(onlyA, 'workspace-a', onlyA.projectA, [sessionAOnly]);
    writeComposerWorkspaceSummary(both, 'workspace-a', both.projectA, [sessionA]);
    writeComposerWorkspaceSummary(both, 'workspace-b', both.projectB, [sessionB]);
    writeComposerGlobalSessions(onlyA, [sessionAOnly]);
    writeComposerGlobalSessions(both, [sessionA, sessionB]);

    const onlyABackup = await createFixtureBackup(onlyA, 'a-only.zip');
    const bothBackup = await createFixtureBackup(both, 'a-and-b.zip');
    const poisonedBothBackup = `${bothBackup}.poisoned.zip`;
    await poisonArchiveDatabaseEntries(bothBackup, poisonedBothBackup, [
      'workspaceStorage/workspace-b/state.vscdb',
      'globalStorage/state.vscdb',
    ]);

    const manifest = await readBackupManifest(poisonedBothBackup);
    expect(manifest).toMatchObject({
      version: '1.0.0',
      stats: { sessionCount: 2, workspaceCount: 2 },
      composerWorkspaceInventory: {
        schemaVersion: 1,
        workspaces: [
          {
            workspaceId: 'workspace-a',
            workspacePath: both.projectA,
            sessionIds: [SESSION_INTEGRITY_IDS.workspaceA],
            globalCounterpartSessionIds: [SESSION_INTEGRITY_IDS.workspaceA],
            linkedGlobalSessionIds: [],
          },
          {
            workspaceId: 'workspace-b',
            workspacePath: both.projectB,
            sessionIds: [SESSION_INTEGRITY_IDS.workspaceB],
            globalCounterpartSessionIds: [SESSION_INTEGRITY_IDS.workspaceB],
            linkedGlobalSessionIds: [],
          },
        ],
      },
    });

    // The strict carrier rule is scoped-only. An unfiltered read still uses the shared global
    // representation and must retain the existing complete/global-primary behavior.
    const unscopedContext = createSessionReadContext({ backupPath: bothBackup });
    try {
      const unscopedRows = await listSessions(
        { all: true, limit: 0 },
        undefined,
        bothBackup,
        unscopedContext
      );
      expect(unscopedRows.map(({ id }) => id).sort()).toEqual(
        [SESSION_INTEGRITY_IDS.workspaceA, SESSION_INTEGRITY_IDS.workspaceB].sort()
      );
      const unscopedA = await getSession(
        SESSION_INTEGRITY_IDS.workspaceA,
        undefined,
        bothBackup,
        unscopedContext
      );
      expect(unscopedA).toMatchObject({
        source: 'global',
        resolutionState: 'complete',
        messages: [expect.objectContaining({ content: 'needle-a' })],
      });
    } finally {
      await unscopedContext.dispose();
    }

    async function scopedRead(
      backupPath: string,
      workspacePath: string
    ): Promise<{ backupEntries: number; snapshots: number }> {
      const recorder = createIoEventRecorder();
      const context = createSessionReadContext({
        backupPath,
        workspacePath,
        ioObserver: recorder.observer,
      });
      try {
        const rows = await listSessions(
          { all: true, limit: 0, workspacePath },
          undefined,
          backupPath,
          context
        );
        expect(rows.map(({ id }) => id)).toEqual([SESSION_INTEGRITY_IDS.workspaceA]);
        expect(rows[0]).toMatchObject({
          source: 'workspace-fallback',
          resolutionState: 'partial',
          resolution: { reasonCodes: expect.arrayContaining(['workspace-scope-omitted']) },
          sourceInstances: expect.arrayContaining([
            expect.objectContaining({
              representation: 'composer-global',
              state: 'omitted-by-scope',
            }),
          ]),
        });
        const resolved = await getSession(
          SESSION_INTEGRITY_IDS.workspaceA,
          undefined,
          backupPath,
          context
        );
        expect(resolved?.messages[0]?.content).toBe('needle-a');
        expect(JSON.parse(exportToJson(resolved!))).toMatchObject({
          id: SESSION_INTEGRITY_IDS.workspaceA,
        });
        const found = await searchSessions(
          'needle-a',
          { limit: 0, contextChars: 20, workspacePath },
          undefined,
          backupPath,
          context
        );
        expect(found.map(({ sessionId }) => sessionId)).toEqual([SESSION_INTEGRITY_IDS.workspaceA]);
        recorder.assertNone(
          { resourceClass: 'backup-entry', representation: 'composer-global' },
          'workspace scope must not materialize the shared global backup carrier'
        );
        return {
          backupEntries: recorder.count({
            resourceClass: 'backup-entry',
            representation: 'composer-workspace',
          }),
          snapshots: recorder.count({ resourceClass: 'sqlite-snapshot' }),
        };
      } finally {
        await context.dispose();
      }
    }

    const aOnlyEvents = await scopedRead(onlyABackup, onlyA.projectA);
    const aAndBEvents = await scopedRead(poisonedBothBackup, both.projectA);
    expect(aAndBEvents).toEqual(aOnlyEvents);

    const strictRecorder = createIoEventRecorder();
    const strictContext = createSessionReadContext({
      backupPath: poisonedBothBackup,
      workspacePath: both.projectA,
      includeCrossWorkspaceSources: true,
      ioObserver: strictRecorder.observer,
    });
    try {
      await expect(
        listSessions(
          {
            all: true,
            limit: 0,
            workspacePath: both.projectA,
            includeCrossWorkspaceSources: true,
          },
          undefined,
          poisonedBothBackup,
          strictContext
        )
      ).resolves.toMatchObject([{ id: SESSION_INTEGRITY_IDS.workspaceA }]);
      strictRecorder.assertNone(
        { resourceClass: 'backup-entry', representation: 'composer-global' },
        'workspace scope must not materialize the shared global backup carrier'
      );
    } finally {
      await strictContext.dispose();
    }

    const exported = JSON.parse(
      await exportAllSessionsToJson({ backupPath: poisonedBothBackup, workspace: both.projectA })
    ) as Array<{ id: string }>;
    expect(exported.map(({ id }) => id)).toEqual([SESSION_INTEGRITY_IDS.workspaceA]);
  });

  it('uses pointer membership only as scope evidence when opt-in finds an off-scope payload', async () => {
    const root = fixture('cursor-history-backup-pointer-payload-');
    const sharedId = 'dddddddd-0000-0000-0000-000000000016';
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, []);
    const workspaceA = new BetterSqlite3(join(root.workspaceStorage, 'workspace-a', 'state.vscdb'));
    try {
      workspaceA
        .prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
        .run('workbench.panel.composerChatViewPane.pointer', JSON.stringify([sharedId]));
    } finally {
      workspaceA.close();
    }
    const workspacePayload = session(
      sharedId,
      root.projectB,
      'off-scope workspace payload',
      1_785_500_000_000
    );
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [workspacePayload]);
    writeComposerGlobalSessions(root, [
      session(sharedId, root.projectA, 'shared global payload', 1_785_500_000_000),
    ]);
    const backup = await createFixtureBackup(root, 'pointer-payload.zip');

    const scopedDefault = await listSessions(
      { all: true, limit: 0, workspacePath: root.projectA },
      undefined,
      backup
    );
    expect(scopedDefault).toMatchObject([
      { id: sharedId, messageCount: 0, source: 'workspace-fallback' },
    ]);

    const context = createSessionReadContext({
      backupPath: backup,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
    });
    try {
      const rows = await listSessions(
        {
          all: true,
          limit: 0,
          workspacePath: root.projectA,
          includeCrossWorkspaceSources: true,
        },
        undefined,
        backup,
        context
      );
      expect(rows).toMatchObject([
        {
          id: sharedId,
          resolutionState: 'partial',
          resolution: { reasonCodes: expect.arrayContaining(['workspace-scope-omitted']) },
        },
      ]);
      expect(context.logicalSummaries?.[0]?.resolutionState).not.toBe('ambiguous');
      await expect(getSession(sharedId, undefined, backup, context)).resolves.toMatchObject({
        id: sharedId,
        source: 'workspace-fallback',
        messages: [expect.objectContaining({ content: 'off-scope workspace payload' })],
      });
    } finally {
      await context.dispose();
    }
  });

  it('opens an off-scope workspace only for an explicitly selected duplicate UUID', async () => {
    const root = fixture('cursor-history-backup-selected-uuid-opt-in-');
    const duplicateId = SESSION_INTEGRITY_IDS.duplicate;
    const unrelatedId = SESSION_INTEGRITY_IDS.workspaceB;
    const selected = session(duplicateId, root.projectA, 'selected duplicate', 1_786_000_000_000);
    const equivalent = session(duplicateId, root.projectB, 'selected duplicate', 1_786_000_000_000);
    const unrelated = session(unrelatedId, root.projectB, 'unrelated secret', 1_786_000_000_001);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [selected]);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [equivalent, unrelated]);

    const backup = await createFixtureBackup(root, 'selected-uuid-opt-in.zip');
    const workspaceCounts = await listWorkspaces(undefined, backup);
    const scopedA = await listSessions(
      { all: true, limit: 0, workspacePath: root.projectA },
      undefined,
      backup
    );
    const scopedB = await listSessions(
      { all: true, limit: 0, workspacePath: root.projectB },
      undefined,
      backup
    );
    expect(workspaceCounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workspace-a',
          sessionCount: scopedA.length,
        }),
        expect.objectContaining({
          id: 'workspace-b',
          sessionCount: scopedB.length,
        }),
      ])
    );
    expect(scopedA.map(({ id }) => id)).toEqual([duplicateId]);
    expect(new Set(scopedB.map(({ id }) => id))).toEqual(new Set([duplicateId, unrelatedId]));
    const defaultRecorder = createIoEventRecorder();
    const defaultContext = createSessionReadContext({
      backupPath: backup,
      workspacePath: root.projectA,
      ioObserver: defaultRecorder.observer,
    });
    try {
      await expect(
        listSessions(
          { all: true, limit: 0, workspacePath: root.projectA },
          undefined,
          backup,
          defaultContext
        )
      ).resolves.toMatchObject([
        {
          id: duplicateId,
          resolution: { reasonCodes: expect.arrayContaining(['workspace-scope-omitted']) },
        },
      ]);
      expect(
        defaultRecorder.count({
          resourceClass: 'backup-entry',
          representation: 'composer-workspace',
        })
      ).toBe(1);
    } finally {
      await defaultContext.dispose();
    }

    const optInRecorder = createIoEventRecorder();
    const optInContext = createSessionReadContext({
      backupPath: backup,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
      ioObserver: optInRecorder.observer,
    });
    try {
      const rows = await listSessions(
        {
          all: true,
          limit: 0,
          workspacePath: root.projectA,
          includeCrossWorkspaceSources: true,
        },
        undefined,
        backup,
        optInContext
      );
      expect(rows.map(({ id }) => id)).toEqual([duplicateId]);
      expect(
        optInRecorder.count({
          resourceClass: 'backup-entry',
          representation: 'composer-workspace',
        })
      ).toBe(2);
      expect(
        optInRecorder.count({
          classification: 'conversation-payload',
          logicalSessionId: unrelatedId,
        })
      ).toBe(0);
      optInRecorder.assertNone(
        { resourceClass: 'backup-entry', representation: 'composer-global' },
        'selected-UUID opt-in must not broaden to the shared global carrier'
      );
    } finally {
      await optInContext.dispose();
    }
  });

  it('keeps legacy single-workspace backups readable and fails closed for multi-workspace scope', async () => {
    const onlyA = fixture('cursor-history-backup-legacy-a-only-');
    const both = fixture('cursor-history-backup-legacy-a-b-');
    const onlyASession = session(
      SESSION_INTEGRITY_IDS.workspaceA,
      onlyA.projectA,
      'needle-a',
      1_783_000_000_000
    );
    const bothASession = session(
      SESSION_INTEGRITY_IDS.workspaceA,
      both.projectA,
      'needle-a',
      1_783_000_000_000
    );
    const bothBSession = session(
      SESSION_INTEGRITY_IDS.workspaceB,
      both.projectB,
      'needle-b',
      1_784_000_000_000
    );
    writeComposerWorkspaceSummary(onlyA, 'workspace-a', onlyA.projectA, [onlyASession]);
    writeComposerWorkspaceSummary(both, 'workspace-a', both.projectA, [bothASession]);
    writeComposerWorkspaceSummary(both, 'workspace-b', both.projectB, [bothBSession]);
    writeComposerGlobalSessions(onlyA, [onlyASession]);
    writeComposerGlobalSessions(both, [bothASession, bothBSession]);

    const onlyANew = await createFixtureBackup(onlyA, 'a-only-new.zip');
    const bothNew = await createFixtureBackup(both, 'a-b-new.zip');
    const onlyAPoisoned = `${onlyANew}.poisoned.zip`;
    const onlyALegacy = `${onlyANew}.legacy.zip`;
    const bothLegacy = `${bothNew}.legacy.zip`;
    await poisonArchiveDatabaseEntries(onlyANew, onlyAPoisoned, ['globalStorage/state.vscdb']);
    await stripWorkspaceInventory(onlyAPoisoned, onlyALegacy);
    await stripWorkspaceInventory(bothNew, bothLegacy);

    const singleRecorder = createIoEventRecorder();
    const singleContext = createSessionReadContext({
      backupPath: onlyALegacy,
      workspacePath: onlyA.projectA,
      ioObserver: singleRecorder.observer,
    });
    try {
      await expect(
        listSessions(
          { all: true, limit: 0, workspacePath: onlyA.projectA },
          undefined,
          onlyALegacy,
          singleContext
        )
      ).resolves.toMatchObject([
        {
          id: SESSION_INTEGRITY_IDS.workspaceA,
          source: 'workspace-fallback',
          resolutionState: 'partial',
          resolution: {
            loadedSourceRoles: ['composer'],
            omittedSourceRoles: ['composer'],
            reasonCodes: expect.arrayContaining(['workspace-scope-omitted']),
          },
          sourceInstances: expect.arrayContaining([
            expect.objectContaining({
              representation: 'composer-global',
              state: 'omitted-by-scope',
            }),
          ]),
        },
      ]);
      singleRecorder.assertNone(
        { resourceClass: 'backup-entry', representation: 'composer-global' },
        'legacy single-workspace scope must not materialize the shared global database'
      );
    } finally {
      await singleContext.dispose();
    }

    const recorder = createIoEventRecorder();
    const context = createSessionReadContext({
      backupPath: bothLegacy,
      workspacePath: both.projectA,
      ioObserver: recorder.observer,
    });
    try {
      await expect(
        listSessions(
          { all: true, limit: 0, workspacePath: both.projectA },
          undefined,
          bothLegacy,
          context
        )
      ).rejects.toMatchObject({
        code: 'BACKUP_WORKSPACE_SCOPE_METADATA_REQUIRED',
        details: { workspaceCount: 2 },
      });
      recorder.assertNone(
        { resourceClass: 'backup-entry' },
        'legacy fail-closed preflight must not extract a workspace database'
      );
      recorder.assertNone(
        { resourceClass: 'sqlite-snapshot' },
        'legacy fail-closed preflight must not open a SQLite snapshot'
      );
      recorder.assertNone(
        { resourceClass: 'workspace-membership-json' },
        'legacy fail-closed preflight must not inspect off-scope workspace sidecars'
      );
    } finally {
      await context.dispose();
    }
  });
});
