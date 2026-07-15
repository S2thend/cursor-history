/**
 * Parse a Cursor Store stack `store.db` (P2): SAFE field-level enhancement.
 * See specs/015-cursor-store-stack/research.md §5.
 *
 * DESIGN (P2 rework): store.db NEVER overrides transcript messages. It only
 * adds safe fields: title + createdAt (always), and messages ONLY for
 * store-only sessions (no transcript). Tool results are NOT guessed — an
 * orphan role:'tool' leaf (no stable tool_call_id matching) marks the parse
 * 'partial' rather than attaching to the wrong tool call.
 *
 * Completeness is tracked explicitly: any missing/corrupt leaf, JSON failure,
 * or orphan tool result → 'partial'. The caller (discover) labels the session
 * 'store-partial' and keeps the degraded warning.
 *
 * Defensive: any failure → null (caller degrades to transcript). node:sqlite
 * is lazy-loaded on the FIRST parseStoreDb call (not at module import) so the
 * ExperimentalWarning only appears when store.db is actually parsed, not on
 * every CLI invocation. Reads from a temp copy to bypass cursor-agent WAL locks.
 */
import { createRequire } from 'node:module';
import { copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DbType } from 'node:sqlite';
import type { Message, MessageRole, ToolCall } from '../types.js';
import { debugLogStorage } from '../database/debug.js';

const nodeRequire = createRequire(import.meta.url);
// Lazy: NOT required at module load (avoids ExperimentalWarning on every CLI).
let dbCtor: typeof DbType | null = null;
let dbTried = false;
function getDbCtor(): typeof DbType | null {
  if (!dbTried) {
    dbTried = true;
    try {
      dbCtor = nodeRequire('node:sqlite').DatabaseSync;
    } catch {
      dbCtor = null;
      debugLogStorage('node:sqlite unavailable (Node <22.5); store.db deep-parse disabled');
    }
  }
  return dbCtor;
}

export type StoreCompleteness = 'complete' | 'partial';

export interface StoreDbData {
  title: string | null;
  messages: Message[];
  createdAt: Date | null;
  completeness: StoreCompleteness;
}

interface LeafObj {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

export function parseStoreDb(path: string): StoreDbData | null {
  const DatabaseSyncCtor = getDbCtor();
  if (!DatabaseSyncCtor) return null;
  const tmpPath = join(tmpdir(), `ch-store-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  let db: DbType | null = null;
  try {
    copyFileSync(path, tmpPath);
    db = new DatabaseSyncCtor(tmpPath, { readOnly: true });
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return null;
  }
  try {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as
      | { value: string }
      | undefined;
    if (!metaRow) return null;
    const meta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8')) as {
      name?: string;
      latestRootBlobId?: string;
      createdAt?: number;
    };
    const title = typeof meta.name === 'string' ? meta.name : null;
    const createdAt =
      typeof meta.createdAt === 'number' && meta.createdAt > 1_000_000_000_000
        ? new Date(meta.createdAt)
        : null;
    const { messages, complete } = meta.latestRootBlobId
      ? readMessages(db, meta.latestRootBlobId)
      : { messages: [] as Message[], complete: true };
    return { title, messages, createdAt, completeness: complete ? 'complete' : 'partial' };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

/** Recursive Merkle walk: 0x0a=message leaf, 0x12=subtree (recurse, ordered). */
function readMessages(
  db: DbType,
  rootId: string
): { messages: Message[]; complete: boolean } {
  const messages: Message[] = [];
  const visited = new Set<string>();
  let complete = true;
  const walk = (blobId: string): void => {
    if (visited.has(blobId)) return; // cycle guard
    visited.add(blobId);
    const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(blobId) as
      | { data: Uint8Array }
      | undefined;
    if (!row) {
      complete = false;
      debugLogStorage(`store.db: missing subtree blob ${blobId.slice(0, 12)}…`);
      return;
    }
    const buf = Buffer.from(row.data);
    let i = 0;
    while (i < buf.length - 1) {
      const tag = buf[i];
      const len = buf[i + 1];
      if ((tag === 0x0a || tag === 0x12) && len === 0x20 && i + 34 <= buf.length) {
        const childHash = buf.subarray(i + 2, i + 34).toString('hex');
        if (tag === 0x0a) {
          const leaf = readLeaf(db, childHash);
          if (!leaf) {
            complete = false;
            debugLogStorage(`store.db: missing/unparseable leaf ${childHash.slice(0, 12)}…`);
          } else if (leaf.kind === 'tool-result') {
            // Orphan OpenAI role:'tool' result — P2 does NOT guess tool_call_id
            // ownership. Mark partial; do not attach.
            complete = false;
            debugLogStorage('store.db: orphan tool result (no tool_call_id match) → partial');
          } else if (leaf.message) {
            messages.push(leaf.message);
          }
        } else {
          walk(childHash); // 0x12 subtree → recurse in order
        }
        i += 34;
      } else {
        i += 1;
      }
    }
  };
  walk(rootId);
  return { messages, complete };
}

interface LeafResult {
  kind: 'message' | 'tool-result';
  message?: Message;
}

function readLeaf(db: DbType, hash: string): LeafResult | null {
  const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(hash) as
    | { data: Uint8Array }
    | undefined;
  if (!row) return null;
  try {
    const obj = JSON.parse(Buffer.from(row.data).toString('utf8')) as LeafObj;
    return classifyLeaf(obj);
  } catch {
    return null; // protobuf leaf or non-JSON → skip (defensive)
  }
}

function classifyLeaf(obj: LeafObj): LeafResult | null {
  if (obj.role === 'tool') {
    // OpenAI tool-result leaf. P2 does NOT attach (no tool_call_id matching).
    // Caller marks completeness 'partial'.
    return { kind: 'tool-result' };
  }
  if (obj.role !== 'user' && obj.role !== 'assistant') return null; // skip system/unknown
  const msg = buildMessage(obj, obj.role as MessageRole);
  return msg ? { kind: 'message', message: msg } : null;
}

function buildMessage(obj: LeafObj, role: MessageRole): Message | null {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  if (typeof obj.content === 'string') {
    texts.push(obj.content);
  } else if (Array.isArray(obj.content)) {
    const r = extractBlocks(obj.content);
    texts.push(r.text);
    toolCalls.push(...r.toolCalls);
  }
  if (Array.isArray(obj.tool_calls)) {
    for (const tc of obj.tool_calls) {
      const name = tc.function?.name;
      if (typeof name !== 'string') continue;
      let params: Record<string, unknown> | undefined;
      if (tc.function?.arguments) {
        try {
          params = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          params = { _raw: tc.function.arguments };
        }
      }
      toolCalls.push({ name, status: 'completed', params });
    }
  }
  // No directly-stored per-message timestamp at this layer; leave undefined.
  const msg: Message = { id: null, role, content: texts.join(''), codeBlocks: [] };
  if (toolCalls.length > 0) msg.toolCalls = toolCalls;
  return msg;
}

function extractBlocks(blocks: unknown[]): { text: string; toolCalls: ToolCall[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as {
      type?: string;
      text?: unknown;
      toolName?: unknown;
      name?: unknown;
      args?: unknown;
      input?: unknown;
      result?: unknown;
    };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (
      block.type === 'tool_use' &&
      (typeof block.toolName === 'string' || typeof block.name === 'string')
    ) {
      const name = (block.toolName ?? block.name) as string;
      const tc: ToolCall = {
        name,
        status: 'completed',
        params: (block.args ?? block.input) as Record<string, unknown> | undefined,
      };
      if (block.result !== undefined && block.result !== null) {
        tc.result = resultToString(block.result);
      }
      toolCalls.push(tc);
    }
    // unknown block types ignored (forward compat)
  }
  return { text: texts.join(''), toolCalls };
}

function resultToString(r: unknown): string {
  if (typeof r === 'string') return r;
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}
