import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackup } from '../../src/core/backup.js';
import { resolveCommandSession } from '../../src/cli/commands/session-lookup.js';
import {
  createSessionReadContext,
  getSession,
  listSessions,
  searchSessions,
} from '../../src/core/storage.js';
import {
  exportAllSessionsToJson,
  exportAllSessionsToMarkdown,
  exportSessionToJson,
  exportSessionToMarkdown,
  getSession as getLibrarySession,
  listSessions as listLibrarySessions,
  searchSessions as searchLibrarySessions,
} from '../../src/lib/index.js';
import type { LibraryConfig } from '../../src/lib/types.js';

const root = mkdtempSync(join(tmpdir(), 'cursor-history-workspace-roundtrip-'));
const workspaceStorage = join(root, 'User', 'workspaceStorage');
const backupPath = join(root, 'workspace-backup.zip');
const emptyStoreRoot = join(root, 'empty-store');
const projectA = join(root, 'project-a');
const projectB = join(root, 'project-b');
const sessionA = 'aaaaaaaa-0000-0000-0000-000000000033';
const sessionB = 'bbbbbbbb-0000-0000-0000-000000000033';
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

function writeComposerWorkspace(
  workspaceId: string,
  projectPath: string,
  sessionId: string,
  createdAt: number,
  content: string
): void {
  const workspaceDir = join(workspaceStorage, workspaceId);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'workspace.json'),
    JSON.stringify({ folder: pathToFileURL(projectPath).href })
  );

  const db = new BetterSqlite3(join(workspaceDir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerData',
    JSON.stringify({
      allComposers: [
        {
          composerId: sessionId,
          name: content,
          createdAt,
          lastUpdatedAt: createdAt,
        },
      ],
    })
  );
  db.close();
}

beforeAll(async () => {
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  mkdirSync(emptyStoreRoot, { recursive: true });
  process.env['CURSOR_STORE_ROOT'] = emptyStoreRoot;

  writeComposerWorkspace('workspace-a', projectA, sessionA, 1783000000000, 'needle-a');
  writeComposerWorkspace('workspace-b', projectB, sessionB, 1784000000000, 'needle-b');

  const backup = await createBackup({ sourcePath: workspaceStorage, outputPath: backupPath });
  expect(backup.success).toBe(true);
});

afterAll(() => {
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  rmSync(root, { recursive: true, force: true });
});

async function expectWorkspaceRoundTrip(
  customDataPath: string | undefined,
  sourceBackupPath: string | undefined
): Promise<void> {
  const global = await listSessions({ limit: 0, all: true }, customDataPath, sourceBackupPath);
  expect(global.map((summary) => summary.id)).toEqual([sessionB, sessionA]);

  const context = createSessionReadContext({
    ...(customDataPath ? { dataPath: customDataPath } : {}),
    ...(sourceBackupPath ? { backupPath: sourceBackupPath } : {}),
    workspacePath: projectA,
  });
  const filtered = await listSessions(
    { limit: 0, all: true, workspacePath: projectA },
    customDataPath,
    sourceBackupPath,
    context
  );
  expect(filtered.map((summary) => [summary.index, summary.id])).toEqual([[1, sessionA]]);

  const resolved = await getSession(1, customDataPath, sourceBackupPath, context);
  expect(resolved?.id).toBe(sessionA);
  expect(resolved?.messages[0]?.content).toBe('needle-a');
  await expect(
    resolveCommandSession(sessionA, projectA, customDataPath, sourceBackupPath)
  ).resolves.toMatchObject({ id: sessionA });
  await expect(
    resolveCommandSession(sessionB, projectA, customDataPath, sourceBackupPath)
  ).rejects.toMatchObject({ code: 'SESSION_SCOPE_MISMATCH' });

  const foundA = await searchSessions(
    'needle-a',
    { limit: 0, contextChars: 50, workspacePath: projectA },
    customDataPath,
    sourceBackupPath
  );
  const foundB = await searchSessions(
    'needle-b',
    { limit: 0, contextChars: 50, workspacePath: projectA },
    customDataPath,
    sourceBackupPath
  );
  expect(foundA.map((result) => result.sessionId)).toEqual([sessionA]);
  expect(foundB).toEqual([]);

  const libraryConfig: LibraryConfig = { workspace: projectA };
  if (customDataPath !== undefined) libraryConfig.dataPath = customDataPath;
  if (sourceBackupPath !== undefined) libraryConfig.backupPath = sourceBackupPath;

  const libraryList = await listLibrarySessions(libraryConfig);
  expect(libraryList.data.map((session) => session.id)).toEqual([sessionA]);

  const librarySession = await getLibrarySession(0, libraryConfig);
  expect(librarySession.id).toBe(sessionA);
  expect(librarySession.messages[0]?.content).toBe('needle-a');
  await expect(getLibrarySession(sessionA, libraryConfig)).resolves.toMatchObject({ id: sessionA });
  await expect(getLibrarySession(sessionB, libraryConfig)).rejects.toMatchObject({
    code: 'SESSION_SCOPE_MISMATCH',
  });

  const libraryFoundA = await searchLibrarySessions('needle-a', libraryConfig);
  const libraryFoundB = await searchLibrarySessions('needle-b', libraryConfig);
  expect(libraryFoundA.map((result) => result.session.id)).toEqual([sessionA]);
  expect(libraryFoundB).toEqual([]);

  const singleJson = JSON.parse(await exportSessionToJson(0, libraryConfig)) as {
    id: string;
    index: number;
    messages: Array<{ content: string }>;
  };
  expect(singleJson.id).toBe(sessionA);
  expect(singleJson.index).toBe(0);
  expect(singleJson.messages[0]?.content).toBe('needle-a');

  const singleMarkdown = await exportSessionToMarkdown(0, libraryConfig);
  expect(singleMarkdown).toContain('needle-a');
  expect(singleMarkdown).not.toContain('needle-b');

  const allJson = JSON.parse(await exportAllSessionsToJson(libraryConfig)) as Array<{
    id: string;
    index: number;
  }>;
  expect(allJson.map((session) => session.id)).toEqual([sessionA]);
  expect(allJson.map((session) => session.index)).toEqual([0]);

  const allMarkdown = await exportAllSessionsToMarkdown(libraryConfig);
  expect(allMarkdown).toContain('needle-a');
  expect(allMarkdown).not.toContain('needle-b');
}

describe('workspace-filtered index round-trip with real Composer SQLite', () => {
  it('round-trips against a custom live data path', async () => {
    await expectWorkspaceRoundTrip(workspaceStorage, undefined);
  });

  it('round-trips against a backup archive', async () => {
    await expectWorkspaceRoundTrip(undefined, backupPath);
  });
});
