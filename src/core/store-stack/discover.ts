/**
 * Discover Cursor Store-stack sessions under ~/.cursor.
 * See specs/015-cursor-store-stack/research.md §4 / data-model.md §1.
 *
 * - `chats/<hash>/<uuid>/meta.json` → id + workspacePath (cwd) + createdAt
 * - `projects/<sanitized>/agent-transcripts/<uuid>/(<uuid>/<uuid>.jsonl | <uuid>.jsonl)`
 *   → messages
 * Merged by session uuid. P1: `source` is always `'transcript'`
 * (store.db deep parse is P2 — storeDbPath is recorded for later use).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chatsDir, projectsDir, acpSessionsDir } from './paths.js';
import { parseTranscriptFile } from './transcript.js';
import { parseStoreDb } from './store-db.js';
import type { StoreMetaJson, StoreSession } from './types.js';

export function discoverStoreSessions(storeRoot: string): StoreSession[] {
  const byId = new Map<string, StoreSession>();

  // 1. chats/ → metadata (cwd, createdAt, title, store.db presence)
  const chats = chatsDir(storeRoot);
  if (existsSync(chats)) {
    for (const hash of listDirs(chats)) {
      for (const uuid of listDirs(join(chats, hash))) {
        const sessionDir = join(chats, hash, uuid);
        const meta = readMeta(join(sessionDir, 'meta.json'));
        const createdAt = isValidMs(meta?.createdAtMs)
          ? new Date(meta.createdAtMs)
          : (safeMtime(sessionDir) ?? new Date(0));
        const storeDbPath = existsSync(join(sessionDir, 'store.db'))
          ? join(sessionDir, 'store.db')
          : undefined;

        const existing = byId.get(uuid);
        if (existing) {
          existing.workspacePath ??= meta?.cwd;
          existing.title ??= meta?.title ?? null;
          existing.storeDbPath ??= storeDbPath;
          existing.chatDir = sessionDir;
          if (createdAt.getTime() > existing.createdAt.getTime()) {
            existing.createdAt = createdAt;
          }
        } else {
          byId.set(uuid, {
            id: uuid,
            workspacePath: meta?.cwd,
            title: meta?.title ?? null,
            createdAt,
            messages: [],
            source: 'transcript',
            storeDbPath,
            chatDir: sessionDir,
          });
        }
      }
    }
  }

  // 2. acp-sessions/<uuid>/{meta.json, store.db} → metadata (no workspace-hash layer)
  // Register every metadata source before attaching transcripts, so a transcript
  // inherits its session timestamp instead of its file mtime fallback.
  const acp = acpSessionsDir(storeRoot);
  if (existsSync(acp)) {
    for (const uuid of listDirs(acp)) {
      const sessionDir = join(acp, uuid);
      const meta = readMeta(join(sessionDir, 'meta.json'));
      const storeDbPath = existsSync(join(sessionDir, 'store.db'))
        ? join(sessionDir, 'store.db')
        : undefined;
      const existing = byId.get(uuid);
      if (existing) {
        existing.workspacePath ??= meta?.cwd;
        existing.title ??= meta?.title ?? null;
        existing.storeDbPath ??= storeDbPath;
        existing.chatDir ??= sessionDir;
      } else {
        byId.set(uuid, {
          id: uuid,
          workspacePath: meta?.cwd,
          title: meta?.title ?? null,
          createdAt: safeMtime(sessionDir) ?? new Date(0),
          messages: [],
          source: 'transcript',
          storeDbPath,
          chatDir: sessionDir,
        });
      }
    }
  }

  // 3. projects/<sanitized>/agent-transcripts/ → messages (nested or flat layout)
  const projects = projectsDir(storeRoot);
  // Discover agent transcript files from projects directory
  if (existsSync(projects)) {
    for (const sanitized of listDirs(projects)) {
      const atDir = join(projects, sanitized, 'agent-transcripts');
      if (!existsSync(atDir)) continue; // Skip if agent-transcripts dir is missing
      // For nested or flat layout under agent-transcripts
      for (const entry of readdirSync(atDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // Nested layout: look for agent-transcripts/uuid/uuid.jsonl
          const uuid = entry.name;
          const nested = join(atDir, uuid, `${uuid}.jsonl`);
          if (existsSync(nested)) attachTranscript(byId, uuid, nested);
        } else if (entry.name.endsWith('.jsonl')) {
          // Flat layout: agent-transcripts/<uuid>.jsonl
          const uuid = entry.name.slice(0, -'.jsonl'.length);
          attachTranscript(byId, uuid, join(atDir, entry.name));
        }
      }
    }
  }

  // 4. Deep-parse store.db only as the store-only fallback (P2).
  //    Transcript-backed sessions stay entirely on the P1 path: this avoids
  //    unnecessary SQLite work/warnings and keeps the authoritative source
  //    independent of the best-effort P2 parser.
  for (const ss of byId.values()) {
    if (!ss.storeDbPath || ss.messages.length > 0) continue;

    const deep = parseStoreDb(ss.storeDbPath);
    if (!deep) continue;

    ss.title = deep.title ?? ss.title;
    ss.createdAt = deep.createdAt ?? ss.createdAt;
    ss.messages = deep.messages;
    ss.source = deep.completeness === 'complete' ? 'store-complete' : 'store-partial';
  }

  return [...byId.values()];
}

function attachTranscript(byId: Map<string, StoreSession>, uuid: string, file: string): void {
  const existing = byId.get(uuid);
  // Transcripts carry no per-message timestamps; messages get none. For a
  // transcript-only session (no chats meta), fall back to file mtime for the
  // SESSION-level createdAt only (not copied onto messages).
  const sessionCreatedAt = existing?.createdAt ?? safeMtime(file) ?? new Date(0);
  // Parse the transcript file into messages
  const messages = parseTranscriptFile(file);
  if (existing) {
    if (existing.messages.length === 0) existing.messages = messages;
    existing.transcriptPath = file;
  } else {
    byId.set(uuid, {
      id: uuid,
      workspacePath: undefined,
      title: null,
      createdAt: sessionCreatedAt,
      messages,
      source: 'transcript',
      transcriptPath: file,
    });
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readMeta(path: string): StoreMetaJson | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as StoreMetaJson) : undefined;
  } catch {
    return undefined;
  }
}

function safeMtime(path: string): Date | undefined {
  try {
    return statSync(path).mtime ?? undefined;
  } catch {
    return undefined;
  }
}

/** Validate a Unix-ms timestamp (consistent with feature 010's threshold). */
function isValidMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 1_000_000_000_000;
}
