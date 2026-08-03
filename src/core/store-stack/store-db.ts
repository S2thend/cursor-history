/**
 * Parse a Cursor Store stack `store.db` as the PRIMARY conversation source.
 * See specs/015-cursor-store-stack/research.md §5 / P15.
 *
 * DESIGN: store.db is the primary message source; the transcript is consulted
 * only as a fallback when this parse is unreadable or yields no messages (the
 * source selection order lives in discover.ts). Tool results are NOT guessed —
 * an orphan role:'tool' leaf (no stable tool_call_id matching) marks the parse
 * 'partial' rather than attaching to the wrong tool call.
 *
 * Completeness is tracked explicitly: missing blobs, malformed leaves, and
 * unmatched tool results → 'partial'. A valid `system` leaf is intentionally
 * ignored and does NOT make the database partial.
 *
 * Parsing goes through the shared SQLite registry (backupDatabase +
 * openDatabase) instead of a direct `node:sqlite` dependency, so the configured
 * `better-sqlite3` fallback and `CURSOR_HISTORY_SQLITE_DRIVER` are honored. The
 * backup yields a WAL-consistent snapshot, avoiding stale reads.
 *
 * Defensive: any failure → null (caller degrades to transcript).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, openDatabase, type Database } from '../database/index.js';
import { debugLogStorage } from '../database/debug.js';
import type { Message, MessageRole, ToolCall } from '../types.js';

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
  tool_call_id?: string;
  name?: string;
  error?: unknown;
  isError?: boolean;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface StoredToolResult {
  name?: string;
  result?: string;
  error?: string;
  status: ToolCall['status'];
}

interface ToolResultIndex {
  byId: Map<string, StoredToolResult>;
  usedIds: Set<string>;
}

export async function parseStoreDb(path: string): Promise<StoreDbData | null> {
  let tempDir: string | null = null;
  let db: Database | null = null;
  try {
    // Keep the WAL-consistent snapshot in a process-private directory. If the
    // native backup cannot produce an atomic snapshot, degrade to transcript
    // instead of pairing a copied database with a separately copied WAL.
    tempDir = mkdtempSync(join(tmpdir(), 'ch-store-'));
    const tmpPath = join(tempDir, 'store.db');
    try {
      await backupDatabase(path, tmpPath);
    } catch (backupError) {
      debugLogStorage(
        `store.db snapshot failed for ${path}; degrading to transcript: ${String(backupError)}`
      );
      return null;
    }
    db = await openDatabase(tmpPath);
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as
      { value: string } | undefined;
    if (!metaRow) return null;
    const meta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8')) as {
      name?: string;
      latestRootBlobId?: string;
      createdAt?: number;
    };
    const title = typeof meta.name === 'string' ? meta.name : null;
    const createdAt = validDateFromMs(meta.createdAt);
    const { messages, complete } = meta.latestRootBlobId
      ? readMessages(db, meta.latestRootBlobId)
      : { messages: [] as Message[], complete: true };
    return { title, messages, createdAt, completeness: complete ? 'complete' : 'partial' };
  } catch (error) {
    debugLogStorage(`store.db parse failed for ${path}: ${String(error)}`);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

/** Recursive Merkle walk: 0x0a=message leaf, 0x12=subtree (recurse, ordered). */
function readMessages(db: Database, rootId: string): { messages: Message[]; complete: boolean } {
  const messages: Message[] = [];
  const visited = new Set<string>();
  const reachableLeaves: LeafObj[] = [];
  let complete = true;
  const walk = (blobId: string): void => {
    if (visited.has(blobId)) return; // cycle guard
    visited.add(blobId);
    const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(blobId) as
      { data: Uint8Array } | undefined;
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
          const leaf = readLeafObject(db, childHash);
          if (leaf === null) {
            complete = false; // missing blob
            debugLogStorage(`store.db: missing leaf blob ${childHash.slice(0, 12)}…`);
          } else if (leaf.kind === 'malformed') {
            complete = false; // unparseable leaf
            debugLogStorage(`store.db: malformed leaf ${childHash.slice(0, 12)}… → partial`);
          } else {
            reachableLeaves.push(leaf.object);
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

  // Index only tool results reachable from the active root. Historical or
  // abandoned blobs must not enrich the current conversation DAG.
  const toolResults: ToolResultIndex = { byId: new Map(), usedIds: new Set() };
  for (const object of reachableLeaves) {
    for (const [callId, stored] of extractToolResults(object)) {
      toolResults.byId.set(callId, stored);
    }
  }

  const encounteredToolResultIds: string[] = [];
  let encounteredUnkeyedToolResult = false;
  for (const object of reachableLeaves) {
    const leaf = classifyLeaf(object, toolResults);
    if (leaf.kind === 'message') {
      messages.push(leaf.message);
      if (!leaf.complete) {
        complete = false;
        debugLogStorage('store.db: unsupported message content block → partial');
      }
    } else if (leaf.kind === 'tool-result') {
      encounteredToolResultIds.push(...leaf.callIds);
      if (leaf.callIds.length === 0) encounteredUnkeyedToolResult = true;
      if (!leaf.complete) complete = false;
    } else if (leaf.kind === 'malformed') {
      complete = false;
    }
    // Only a valid system leaf is intentionally ignored.
  }
  const orphanToolResult = encounteredToolResultIds.some((id) => !toolResults.usedIds.has(id));
  if (encounteredUnkeyedToolResult || orphanToolResult) {
    complete = false;
    debugLogStorage('store.db: orphan tool result (no tool_call_id match) → partial');
  }
  return { messages, complete };
}

type LeafResult =
  | { kind: 'message'; message: Message; complete: boolean }
  | { kind: 'tool-result'; callIds: string[]; complete: boolean }
  | { kind: 'ignore' }
  | { kind: 'malformed' };

type DecodedLeaf = { kind: 'decoded'; object: LeafObj } | { kind: 'malformed' };

function readLeafObject(db: Database, hash: string): DecodedLeaf | null {
  const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(hash) as
    { data: Uint8Array } | undefined;
  if (!row) return null; // missing blob → caller marks partial
  try {
    const obj = decodeMessageObject(Buffer.from(row.data));
    return obj ? { kind: 'decoded', object: obj } : { kind: 'malformed' };
  } catch {
    return { kind: 'malformed' };
  }
}

function classifyLeaf(obj: LeafObj, toolResults: ToolResultIndex): LeafResult {
  if (obj.role === 'tool') {
    // Tool results are indexed separately and joined only by a stable
    // toolCallId. The leaf itself is not emitted as a chat message.
    return {
      kind: 'tool-result',
      callIds: getToolResultIds(obj),
      complete: hasOnlySupportedToolResultContent(obj),
    };
  }
  if (obj.role === 'user' || obj.role === 'assistant') {
    const built = buildMessage(obj, obj.role as MessageRole, toolResults);
    return built.message
      ? { kind: 'message', message: built.message, complete: built.complete }
      : { kind: 'malformed' };
  }
  if (obj.role === 'system') return { kind: 'ignore' };
  // Unknown roles can contain data from a newer schema; silently dropping them
  // would incorrectly report a complete parse.
  return { kind: 'malformed' };
}

function buildMessage(
  obj: LeafObj,
  role: MessageRole,
  toolResults: ToolResultIndex
): { message: Message | null; complete: boolean } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let complete = true;
  if (typeof obj.content === 'string') {
    texts.push(obj.content);
  } else if (Array.isArray(obj.content)) {
    const r = extractBlocks(obj.content, toolResults);
    texts.push(r.text);
    toolCalls.push(...r.toolCalls);
    complete = r.complete;
  } else if (obj.content !== undefined && obj.content !== null) {
    // Missing/null content is valid for a tool-only assistant turn. Any other
    // unrecognized value can hide user-visible data.
    complete = false;
  }
  if (Array.isArray(obj.tool_calls)) {
    for (const tc of obj.tool_calls) {
      if (!tc || typeof tc !== 'object') {
        complete = false;
        continue;
      }
      const name = tc.function?.name;
      if (typeof name !== 'string') {
        complete = false;
        continue;
      }
      let params: Record<string, unknown> | undefined;
      if (tc.function?.arguments) {
        try {
          params = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          params = { _raw: tc.function.arguments };
        }
      }
      const call = applyStoredResult({ name, status: 'completed', params }, tc.id, toolResults);
      toolCalls.push(call);
    }
  } else if (obj.tool_calls !== undefined) {
    complete = false;
  }
  // No directly-stored per-message timestamp at this layer; leave undefined.
  const content = texts.join('');
  if (content.length === 0 && toolCalls.length === 0) {
    return { message: null, complete: false };
  }
  const msg: Message = { id: null, role, content, codeBlocks: [] };
  if (toolCalls.length > 0) msg.toolCalls = toolCalls;
  return { message: msg, complete };
}

function extractBlocks(
  blocks: unknown[],
  toolResults: ToolResultIndex
): { text: string; toolCalls: ToolCall[]; complete: boolean } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let complete = true;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') {
      complete = false;
      continue;
    }
    const block = b as {
      type?: string;
      text?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      name?: unknown;
      args?: unknown;
      input?: unknown;
      arguments?: unknown;
      result?: unknown;
    };
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (
      (block.type === 'tool_use' || block.type === 'tool-call' || block.type === 'tool_call') &&
      (typeof block.toolName === 'string' || typeof block.name === 'string')
    ) {
      const name = (block.toolName ?? block.name) as string;
      let tc: ToolCall = {
        name,
        status: 'completed',
        params: parseToolParams(block.args ?? block.input ?? block.arguments),
      };
      if (block.result !== undefined && block.result !== null) {
        tc.result = resultToString(block.result);
      }
      tc = applyStoredResult(
        tc,
        typeof block.toolCallId === 'string' ? block.toolCallId : undefined,
        toolResults
      );
      toolCalls.push(tc);
    } else {
      // Unknown content blocks can carry user-visible data (for example image
      // or reasoning content). Keep known fields, but report degraded fidelity.
      complete = false;
    }
  }
  return { text: texts.join(''), toolCalls, complete };
}

/** Whether a role:tool leaf contains only tool-result shapes we understand. */
function hasOnlySupportedToolResultContent(obj: LeafObj): boolean {
  if (!Array.isArray(obj.content)) {
    return typeof obj.tool_call_id === 'string' && obj.tool_call_id.length > 0;
  }
  return obj.content.every((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const block = raw as Record<string, unknown>;
    if (block['type'] !== 'tool-result' && block['type'] !== 'tool_result') return false;
    const callId = block['toolCallId'] ?? block['tool_call_id'];
    return typeof callId === 'string' && callId.length > 0;
  });
}

function parseToolParams(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { _raw: value };
    }
    return { _raw: value };
  }
  return undefined;
}

function applyStoredResult(
  call: ToolCall,
  callId: string | undefined,
  toolResults: ToolResultIndex
): ToolCall {
  if (!callId) return call;
  const stored = toolResults.byId.get(callId);
  if (!stored) return call;
  toolResults.usedIds.add(callId);
  const merged: ToolCall = { ...call, status: stored.status };
  if (stored.result !== undefined) merged.result = stored.result;
  if (stored.error !== undefined) merged.error = stored.error;
  return merged;
}

/**
 * Cursor stores current assistant turns inside protobuf DAG nodes. Field 4 is
 * the JSON message payload; older stores may still keep the leaf as plain JSON.
 */
function decodeMessageObject(data: Buffer): LeafObj | null {
  const direct = parseLeafJson(data);
  if (direct) return direct;

  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    if (!tag) return null;
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;

    if (wire === 0) {
      const value = readVarint(data, offset);
      if (!value) return null;
      offset = value.next;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    if (wire !== 2) return null;

    const length = readVarint(data, offset);
    if (!length) return null;
    offset = length.next;
    const end = offset + length.value;
    if (end > data.length) return null;
    if (field === 4) {
      const nested = parseLeafJson(data.subarray(offset, end));
      if (nested) return nested;
    }
    offset = end;
  }
  return null;
}

function parseLeafJson(data: Uint8Array): LeafObj | null {
  try {
    const parsed = JSON.parse(Buffer.from(data).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as LeafObj) : null;
  } catch {
    return null;
  }
}

function readVarint(data: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < data.length && shift <= 49) {
    const byte = data[offset++];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }
  return null;
}

function getToolResultIds(obj: LeafObj): string[] {
  return [...new Set(extractToolResults(obj).map(([callId]) => callId))];
}

/** Decode both modern content blocks and standard OpenAI top-level tool results. */
function extractToolResults(obj: LeafObj): Array<[string, StoredToolResult]> {
  if (obj.role !== 'tool') return [];
  const results: Array<[string, StoredToolResult]> = [];
  if (typeof obj.tool_call_id === 'string' && obj.tool_call_id.length > 0) {
    const isError = obj.isError === true || obj.error !== undefined;
    const stored: StoredToolResult = { status: isError ? 'error' : 'completed' };
    if (typeof obj.name === 'string') stored.name = obj.name;
    if (isError) stored.error = resultToString(obj.error ?? obj.content ?? 'error');
    else if (obj.content !== undefined) stored.result = resultToString(obj.content);
    results.push([obj.tool_call_id, stored]);
  }

  if (!Array.isArray(obj.content)) return results;
  for (const raw of obj.content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block['type'] !== 'tool-result' && block['type'] !== 'tool_result') continue;
    const callId = block['toolCallId'] ?? block['tool_call_id'];
    if (typeof callId !== 'string' || callId.length === 0) continue;

    const errorValue = block['error'];
    const isError = block['isError'] === true || errorValue !== undefined;
    const stored: StoredToolResult = { status: isError ? 'error' : 'completed' };
    const name = block['toolName'] ?? block['name'];
    if (typeof name === 'string') stored.name = name;
    if (isError) {
      stored.error = resultToString(errorValue ?? block['result'] ?? block['output'] ?? 'error');
    } else {
      const result = block['result'] ?? block['output'] ?? block['experimental_content'];
      if (result !== undefined) stored.result = resultToString(result);
    }
    results.push([callId, stored]);
  }
  return results;
}

function resultToString(r: unknown): string {
  if (typeof r === 'string') return r;
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}

function validDateFromMs(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 1_000_000_000_000) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
