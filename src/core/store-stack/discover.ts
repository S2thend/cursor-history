/**
 * Discover Cursor Store-stack sessions under ~/.cursor.
 * See specs/015-cursor-store-stack/research.md §4 / data-model.md §1.
 *
 *   chats/<hash>/<uuid>/meta.json        → id + workspacePath (cwd) + createdAt + updatedAt
 *   acp-sessions/<uuid>/{meta.json,...}   → metadata (no workspace-hash layer)
 *   projects/<sanitized>/agent-transcripts/<uuid>/*.jsonl → messages + TranscriptState
 *
 * Sessions are merged by UUID. Any usable transcript messages are authoritative;
 * `store.db` is used only when the transcript yields no messages, while retaining
 * the transcript state for provenance. Discovery is asynchronous
 * because store.db parsing goes through the shared SQLite registry. Session-level
 * `lastUpdatedAt` comes from `updatedAtMs` when available.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { chatsDir, projectsDir, acpSessionsDir } from './paths.js';
import { parseTranscriptFile } from './transcript.js';
import { parseStoreDb } from './store-db.js';
import { debugLogStorage } from '../database/debug.js';
import type { StoreMetaJson, StoreSession } from './types.js';

/** Best-effort error message for debug diagnostics. */
function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function discoverStoreSessions(storeRoot: string): Promise<StoreSession[]> {
  const byId = new Map<string, StoreSession>();
  const explicitUpdatedAt = new Set<string>();
  const metadataBackedIds = new Set<string>();

  // 1. chats/ → metadata (cwd, createdAt, updatedAt, title, store.db presence)
  const chats = chatsDir(storeRoot);
  if (existsSync(chats)) {
    for (const hash of listDirs(chats)) {
      for (const uuid of listDirs(join(chats, hash))) {
        metadataBackedIds.add(uuid);
        const sessionDir = join(chats, hash, uuid);
        const meta = readMeta(join(sessionDir, 'meta.json'));
        const createdAt = isValidMs(meta?.createdAtMs)
          ? new Date(meta.createdAtMs)
          : (safeMtime(sessionDir) ?? new Date(0));
        const updatedAtMs = meta?.updatedAtMs;
        const hasExplicitUpdatedAt = isValidMs(updatedAtMs);
        const updatedAt = hasExplicitUpdatedAt ? new Date(updatedAtMs) : createdAt;
        const storeDbPath = existsSync(join(sessionDir, 'store.db'))
          ? join(sessionDir, 'store.db')
          : undefined;
        const candidate: StoreSession = {
          id: uuid,
          workspacePath: meta?.cwd,
          title: meta?.title ?? null,
          createdAt,
          lastUpdatedAt: updatedAt,
          messages: [],
          source: 'transcript',
          transcriptState: 'missing',
          storeDbPath,
          chatDir: sessionDir,
        };

        const existing = byId.get(uuid);
        if (existing) {
          if (shouldReplaceMetadata(existing, candidate)) {
            replaceMetadata(existing, candidate);
            if (hasExplicitUpdatedAt) explicitUpdatedAt.add(uuid);
            else explicitUpdatedAt.delete(uuid);
          }
        } else {
          byId.set(uuid, candidate);
          if (hasExplicitUpdatedAt) explicitUpdatedAt.add(uuid);
        }
      }
    }
  }

  // 2. acp-sessions/<uuid>/{meta.json, store.db} → metadata (no workspace-hash layer).
  // Register every metadata source before attaching transcripts, so a transcript
  // inherits its session timestamp instead of its file mtime fallback.
  const acp = acpSessionsDir(storeRoot);
  if (existsSync(acp)) {
    for (const uuid of listDirs(acp)) {
      metadataBackedIds.add(uuid);
      const sessionDir = join(acp, uuid);
      const meta = readMeta(join(sessionDir, 'meta.json'));
      const storeDbPath = existsSync(join(sessionDir, 'store.db'))
        ? join(sessionDir, 'store.db')
        : undefined;
      const createdAt = safeMtime(sessionDir) ?? new Date(0);
      const candidate: StoreSession = {
        id: uuid,
        workspacePath: meta?.cwd,
        title: meta?.title ?? null,
        createdAt,
        lastUpdatedAt: createdAt,
        messages: [],
        source: 'transcript',
        transcriptState: 'missing',
        storeDbPath,
        chatDir: sessionDir,
      };
      const existing = byId.get(uuid);
      if (existing) {
        if (shouldReplaceMetadata(existing, candidate)) {
          replaceMetadata(existing, candidate);
          explicitUpdatedAt.delete(uuid);
        }
      } else {
        byId.set(uuid, candidate);
      }
    }
  }

  // 3. projects/<sanitized>/agent-transcripts/ → messages + state (nested or flat).
  const projects = projectsDir(storeRoot);
  if (existsSync(projects)) {
    for (const sanitized of listDirs(projects)) {
      const atDir = join(projects, sanitized, 'agent-transcripts');
      if (!existsSync(atDir)) continue; // Skip if agent-transcripts dir is missing
      // Enumerate each project's transcript directory safely so one
      // unreadable/removed directory skips only itself.
      for (const entry of listEntries(atDir)) {
        if (entry.isDirectory()) {
          // Nested layout: agent-transcripts/uuid/uuid.jsonl
          const uuid = entry.name;
          const nested = join(atDir, uuid, `${uuid}.jsonl`);
          if (existsSync(nested)) {
            attachTranscript(byId, uuid, nested, metadataBackedIds.has(uuid));
          }
        } else if (entry.name.endsWith('.jsonl')) {
          // Flat layout: agent-transcripts/<uuid>.jsonl
          const uuid = entry.name.slice(0, -'.jsonl'.length);
          attachTranscript(byId, uuid, join(atDir, entry.name), metadataBackedIds.has(uuid));
        }
      }
    }
  }

  // 4. Resolve backing data per session: any usable transcript messages first,
  //    then store.db fallback, else degraded. Source reflects the backing data;
  //    transcriptState is retained for provenance in all cases.
  for (const ss of byId.values()) {
    if (ss.messages.length > 0) {
      ss.source = 'transcript';
      continue;
    }
    if (ss.storeDbPath) {
      const deep = await parseStoreDb(ss.storeDbPath);
      if (deep) {
        ss.title = deep.title ?? ss.title;
        if (deep.createdAt) {
          ss.createdAt = deep.createdAt;
          if (!explicitUpdatedAt.has(ss.id)) ss.lastUpdatedAt = deep.createdAt;
        }
        ss.messages = deep.messages;
        ss.source = deep.completeness === 'complete' ? 'store-complete' : 'store-partial';
      } else {
        ss.source = 'store-partial'; // store.db unreadable → degraded
      }
      continue;
    }
    // With no store.db, retain the actual provenance. A degraded transcript
    // may still contain useful messages (`partial`); metadata-only sessions use
    // the legacy generic Store source instead of claiming a DB parse occurred.
    ss.source = ss.transcriptState === 'missing' ? 'store' : 'transcript';
  }

  return [...byId.values()];
}

function attachTranscript(
  byId: Map<string, StoreSession>,
  uuid: string,
  file: string,
  metadataBacked: boolean
): void {
  const { messages, state } = parseTranscriptFile(file);
  const modifiedAt = safeMtime(file) ?? new Date(0);
  const existing = byId.get(uuid);
  if (existing) {
    if (!shouldReplaceTranscript(existing, state, messages.length, modifiedAt, file)) return;
    // Replace state, path, and messages atomically so duplicate UUIDs cannot
    // combine one transcript's messages with another transcript's provenance.
    existing.transcriptState = state;
    existing.transcriptPath = file;
    existing.messages = messages;
    if (!metadataBacked) {
      existing.createdAt = modifiedAt;
      existing.lastUpdatedAt = modifiedAt;
    }
    return;
  }
  // Transcript-only session (no chats/acp meta). Use file mtime for session time.
  const createdAt = modifiedAt;
  byId.set(uuid, {
    id: uuid,
    workspacePath: undefined,
    title: null,
    createdAt,
    lastUpdatedAt: createdAt,
    messages,
    source: 'transcript', // finalized by the resolve loop
    transcriptState: state,
    transcriptPath: file,
  });
}

/** Prefer state, then message count, then recency; use path only as a stable tie-breaker. */
function shouldReplaceTranscript(
  existing: StoreSession,
  candidateState: StoreSession['transcriptState'],
  candidateMessageCount: number,
  candidateModifiedAt: Date,
  candidatePath: string
): boolean {
  if (!existing.transcriptPath) return true;
  const rank: Record<StoreSession['transcriptState'], number> = {
    parsed: 6,
    partial: 5,
    'error-only': 4,
    unsupported: 3,
    empty: 2,
    unreadable: 1,
    missing: 0,
  };
  const candidateRank = rank[candidateState];
  const existingRank = rank[existing.transcriptState];
  if (candidateRank !== existingRank) return candidateRank > existingRank;
  if (candidateMessageCount !== existing.messages.length) {
    return candidateMessageCount > existing.messages.length;
  }
  const existingModifiedAt = safeMtime(existing.transcriptPath)?.getTime() ?? 0;
  if (candidateModifiedAt.getTime() !== existingModifiedAt) {
    return candidateModifiedAt.getTime() > existingModifiedAt;
  }
  return candidatePath < existing.transcriptPath;
}

/** Safe subdirectory names; logs and continues on per-directory failure. */
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    debugLogStorage(`store: skipping unreadable directory ${dir}: ${errMsg(error)}`);
    return [];
  }
}

/** Safe directory entries (Dirent[]); logs and continues on per-directory failure. */
function listEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    debugLogStorage(`store: skipping unreadable directory ${dir}: ${errMsg(error)}`);
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
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 1_000_000_000_000) return false;
  return Number.isFinite(new Date(v).getTime());
}

/** Choose one metadata replica atomically: newest update, then creation time, then path. */
function shouldReplaceMetadata(existing: StoreSession, candidate: StoreSession): boolean {
  const updateDelta = candidate.lastUpdatedAt.getTime() - existing.lastUpdatedAt.getTime();
  if (updateDelta !== 0) return updateDelta > 0;
  const creationDelta = candidate.createdAt.getTime() - existing.createdAt.getTime();
  if (creationDelta !== 0) return creationDelta > 0;
  return (candidate.chatDir ?? '') < (existing.chatDir ?? '');
}

function replaceMetadata(target: StoreSession, source: StoreSession): void {
  target.workspacePath = source.workspacePath;
  target.title = source.title;
  target.createdAt = source.createdAt;
  target.lastUpdatedAt = source.lastUpdatedAt;
  target.storeDbPath = source.storeDbPath;
  target.chatDir = source.chatDir;
}
