import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackup } from '../../src/core/backup.js';

export const SESSION_INTEGRITY_IDS = Object.freeze({
  workspaceA: 'aaaaaaaa-0000-0000-0000-000000000016',
  workspaceB: 'bbbbbbbb-0000-0000-0000-000000000016',
  duplicate: 'dddddddd-0000-0000-0000-000000000016',
  storeOnly: 'eeeeeeee-0000-0000-0000-000000000016',
});

export interface SessionIntegrityFixtureRoot {
  root: string;
  workspaceStorage: string;
  globalStorage: string;
  storeRoot: string;
  projectA: string;
  projectB: string;
  cleanup(): void;
}

export interface ComposerFixtureMessage {
  id?: string | null;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
}

export interface ComposerFixtureSession {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: number;
  messages: ComposerFixtureMessage[];
}

export function createSessionIntegrityFixtureRoot(
  prefix = 'cursor-history-integrity-'
): SessionIntegrityFixtureRoot {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspaceStorage = join(root, 'User', 'workspaceStorage');
  const globalStorage = join(root, 'User', 'globalStorage');
  const storeRoot = join(root, 'store');
  const projectA = join(root, 'workspaces', 'a');
  const projectB = join(root, 'workspaces', 'b');
  for (const path of [workspaceStorage, globalStorage, storeRoot, projectA, projectB]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    root,
    workspaceStorage,
    globalStorage,
    storeRoot,
    projectA,
    projectB,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ensureItemTable(path: string): import('better-sqlite3').Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

export function writeComposerWorkspaceSummary(
  fixture: SessionIntegrityFixtureRoot,
  workspaceId: string,
  workspacePath: string,
  sessions: readonly ComposerFixtureSession[]
): string {
  const workspaceDir = join(fixture.workspaceStorage, workspaceId);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'workspace.json'),
    JSON.stringify({ folder: pathToFileURL(workspacePath).href })
  );
  const dbPath = join(workspaceDir, 'state.vscdb');
  const db = ensureItemTable(dbPath);
  try {
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerData',
      JSON.stringify({
        allComposers: sessions.map((session) => ({
          composerId: session.id,
          name: session.title,
          createdAt: session.createdAt,
          lastUpdatedAt: session.createdAt,
        })),
      })
    );
  } finally {
    db.close();
  }
  return dbPath;
}

export function writeComposerGlobalSessions(
  fixture: SessionIntegrityFixtureRoot,
  sessions: readonly ComposerFixtureSession[]
): string {
  const dbPath = join(fixture.globalStorage, 'state.vscdb');
  mkdirSync(fixture.globalStorage, { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const insert = db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
  try {
    for (const session of sessions) {
      const headers: Array<{ bubbleId?: string; type: number }> = [];
      session.messages.forEach((message, index) => {
        const nativeId =
          typeof message.id === 'string' && message.id.length > 0 ? message.id : undefined;
        const rowId = nativeId ?? `compat-row-${index}`;
        headers.push({
          ...(nativeId ? { bubbleId: nativeId } : {}),
          type: message.role === 'user' ? 1 : 2,
        });
        insert.run(
          `bubbleId:${session.id}:${rowId}`,
          JSON.stringify({
            ...(nativeId ? { bubbleId: nativeId } : {}),
            type: message.role === 'user' ? 1 : 2,
            text: message.content,
            ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
          })
        );
      });
      insert.run(
        `composerData:${session.id}`,
        JSON.stringify({
          name: session.title,
          createdAt: session.createdAt,
          lastUpdatedAt: session.createdAt,
          workspaceIdentifier: { uri: { fsPath: session.workspacePath } },
          fullConversationHeadersOnly: headers,
        })
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function merkleFrame(hash: string): Buffer {
  return Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(hash, 'hex')]);
}

export function writeStoreDb(
  fixture: SessionIntegrityFixtureRoot,
  sessionId: string,
  messages: readonly Array<{ role: 'user' | 'assistant'; content: string }>,
  title = 'Synthetic Store session'
): string {
  const sessionDir = join(fixture.storeRoot, 'chats', sessionId.replaceAll('-', ''));
  mkdirSync(sessionDir, { recursive: true });
  const dbPath = join(sessionDir, 'store.db');
  writeStoreDbAtPath(dbPath, sessionId, messages, title);
  return dbPath;
}

/** Write one Store database occurrence at an explicitly selected test-only physical path. */
export function writeStoreDbAtPath(
  dbPath: string,
  sessionId: string,
  messages: readonly Array<{ role: 'user' | 'assistant'; content: string }>,
  title = 'Synthetic Store session'
): string {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  try {
    const hashes: string[] = [];
    for (const message of messages) {
      const payload = Buffer.from(JSON.stringify(message));
      const hash = sha256(payload);
      hashes.push(hash);
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(hash, payload);
    }
    const root = Buffer.concat(hashes.map(merkleFrame));
    const rootHash = sha256(root);
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(rootHash, root);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      Buffer.from(
        JSON.stringify({
          agentId: sessionId,
          latestRootBlobId: rootHash,
          name: title,
          createdAt: 1_700_000_000_000,
        })
      ).toString('hex')
    );
  } finally {
    db.close();
  }
  return dbPath;
}

/** Write deterministic Store metadata beside one test-only physical occurrence. */
export function writeStoreMeta(
  sessionDir: string,
  values: {
    cwd?: string;
    title?: string;
    hasConversation?: boolean;
    createdAtMs?: number;
    updatedAtMs?: number;
  }
): string {
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'meta.json');
  writeFileSync(path, JSON.stringify(values), { encoding: 'utf8', mode: 0o600 });
  return path;
}

export function writeStoreTranscript(
  fixture: SessionIntegrityFixtureRoot,
  workspaceSlug: string,
  sessionId: string,
  records: readonly unknown[]
): string {
  const path = join(
    fixture.storeRoot,
    'projects',
    workspaceSlug,
    'agent-transcripts',
    sessionId,
    `${sessionId}.jsonl`
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

export function seedConflictingWorkspaceCorpus(fixture: SessionIntegrityFixtureRoot): {
  sessionA: ComposerFixtureSession;
  sessionB: ComposerFixtureSession;
} {
  const sessionA: ComposerFixtureSession = {
    id: SESSION_INTEGRITY_IDS.workspaceA,
    title: 'Workspace A older session',
    workspacePath: fixture.projectA,
    createdAt: 1_700_000_000_000,
    messages: [{ id: null, role: 'user', content: 'needle-a', createdAt: 1_700_000_000_000 }],
  };
  const sessionB: ComposerFixtureSession = {
    id: SESSION_INTEGRITY_IDS.workspaceB,
    title: 'Workspace B newer session',
    workspacePath: fixture.projectB,
    createdAt: 1_800_000_000_000,
    messages: [{ id: 'native-b', role: 'user', content: 'needle-b', createdAt: 1_800_000_000_000 }],
  };
  writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [sessionA]);
  writeComposerWorkspaceSummary(fixture, 'workspace-b', fixture.projectB, [sessionB]);
  writeComposerGlobalSessions(fixture, [sessionA, sessionB]);
  return { sessionA, sessionB };
}

export async function createFixtureBackup(
  fixture: SessionIntegrityFixtureRoot,
  filename = 'session-integrity.zip'
): Promise<string> {
  const outputPath = join(fixture.root, filename);
  const result = await createBackup({ sourcePath: fixture.workspaceStorage, outputPath });
  if (!result.success) throw new Error(result.error ?? 'Synthetic fixture backup failed');
  return outputPath;
}
