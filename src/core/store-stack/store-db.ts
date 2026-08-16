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
 * Source/schema corruption may fall back to an explicitly safe transcript,
 * while driver, snapshot, cleanup, encoding, and fatal limit failures remain
 * typed operation failures.
 */
import { chmodSync, statSync } from 'node:fs';
import {
  backupDatabase,
  openDatabase,
  type Database,
  type DatabaseCapability,
  type DatabaseOperationRequest,
  type DriverName,
} from '../database/index.js';
import { debugLogStorage } from '../database/debug.js';
import { observeAdapterIo, type OperationIoContext } from '../io-observer.js';
import {
  SourceEncodingError,
  SourceLimitExceededError,
  isSessionIntegrityError,
} from '../errors.js';
import { createPrivateTempWorkspace, type PrivateTempWorkspace } from '../private-temp.js';
import {
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  SqliteSourceReadBudget,
  decodeDeterministicUtf8,
  type SourceFailureOutcome,
} from '../source-read-limits.js';
import type { Message, MessageRole, SourceReadLimitsV1, ToolCall } from '../types.js';
import { projectInlineAttachment, retainRawContentBlock } from './content-evidence.js';
import type { StoreMessageIdentityEvidence, StoreRawContentBlockEvidence } from './types.js';

export type StoreCompleteness = 'complete' | 'partial';

export interface StoreDbData {
  title: string | null;
  messages: Message[];
  messageIdentityEvidence: StoreMessageIdentityEvidence[];
  rawContentBlockEvidence: StoreRawContentBlockEvidence[];
  createdAt: Date | null;
  completeness: StoreCompleteness;
}

export interface StoreDbParseOptions {
  limits?: Readonly<SourceReadLimitsV1>;
  failureOutcome?: SourceFailureOutcome;
  onDiagnostic?: (error: SourceEncodingError | SourceLimitExceededError) => void;
  /** Strict provider preference for this Store snapshot/read operation. */
  sqliteDriver?: DriverName;
  /** Cooperatively cancel snapshot creation and bounded payload reads. */
  signal?: AbortSignal;
  /** Internal operation-bound I/O audit context. */
  io?: OperationIoContext;
  /** Stable logical identity only; never a physical locator. */
  logicalSessionId?: string;
}

const STORE_SNAPSHOT_CAPABILITIES = new Set<DatabaseCapability>(['read', 'onlineBackup']);
const STORE_READ_CAPABILITIES = new Set<DatabaseCapability>(['read']);

function databaseRequest(
  operation: DatabaseOperationRequest['operation'],
  required: ReadonlySet<DatabaseCapability>,
  forcedDriver?: DriverName,
  options?: Pick<StoreDbParseOptions, 'io' | 'logicalSessionId'>,
  resourceClass: 'store-database' | 'sqlite-snapshot' = 'store-database'
): DatabaseOperationRequest {
  return {
    operation,
    required,
    ...(forcedDriver ? { forcedDriver } : {}),
    ...(options?.io ? { io: options.io } : {}),
    ioResource: {
      resourceClass,
      sourceRole: 'store',
      representation: 'store-db',
      ...(options?.logicalSessionId ? { logicalSessionId: options.logicalSessionId } : {}),
    },
  };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error('The Store database read was aborted.', {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Preserve the primary failure when a later close/cleanup failure takes precedence. */
function attachErrorCause(error: unknown, cause: unknown): void {
  if (
    error instanceof Error &&
    cause !== undefined &&
    !Object.prototype.hasOwnProperty.call(error, 'cause')
  ) {
    Object.defineProperty(error, 'cause', {
      configurable: true,
      value: cause,
    });
  }
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

export async function parseStoreDb(
  path: string,
  options: StoreDbParseOptions = {}
): Promise<StoreDbData | null> {
  const limits = options.limits ?? SOURCE_READ_LIMITS_V1_DEFAULTS;
  const failureOutcome = options.failureOutcome ?? 'fatal';
  // Operation policy and cancellation are checked before even the source
  // presence probe, keeping invalid/pre-aborted requests I/O-free.
  throwIfAborted(options.signal);
  if (!pathExists(path, options.signal, options.io, options.logicalSessionId)) return null;
  const budget = new SqliteSourceReadBudget(limits, failureOutcome);
  let workspace: PrivateTempWorkspace | null = null;
  let db: Database | null = null;
  let snapshotComplete = false;
  let result: StoreDbData | null = null;
  let operationError: unknown;
  try {
    // Snapshot failures are operation-level infrastructure failures and must
    // propagate. Only payload/schema corruption may resolve through a safe
    // transcript/metadata fallback chosen by discover.ts.
    workspace = createPrivateTempWorkspace({ prefix: 'ch-store-', signal: options.signal });
    const tmpPath = workspace.createFile('store.db');
    throwIfAborted(options.signal);
    await backupDatabase(
      path,
      tmpPath,
      databaseRequest(
        'store-snapshot',
        STORE_SNAPSHOT_CAPABILITIES,
        options.sqliteDriver,
        options,
        'store-database'
      )
    );
    snapshotComplete = true;
    throwIfAborted(options.signal);
    // A provider may replace/recreate the destination. Reassert the plaintext
    // mode immediately after the online backup and before any subsequent open.
    if (process.platform !== 'win32') chmodSync(tmpPath, 0o600);
    throwIfAborted(options.signal);
    db = await openDatabase(
      tmpPath,
      databaseRequest(
        'read-session',
        STORE_READ_CAPABILITIES,
        options.sqliteDriver,
        options,
        'sqlite-snapshot'
      )
    );
    throwIfAborted(options.signal);

    const metaValue = readBoundedValue(db, budget, 'meta', 'value', 'key', '0', options.signal);
    if (typeof metaValue !== 'string') throw new StoreSourceCorruptError();
    const metaBytes = decodeHexText(metaValue, failureOutcome);
    let meta: { name?: string; latestRootBlobId?: string; createdAt?: number };
    try {
      meta = JSON.parse(decodeDeterministicUtf8(metaBytes, 'sqlite', failureOutcome).text) as {
        name?: string;
        latestRootBlobId?: string;
        createdAt?: number;
      };
    } catch (error) {
      if (error instanceof SourceEncodingError || error instanceof SourceLimitExceededError) {
        throw error;
      }
      if (error instanceof SyntaxError) throw new StoreSourceCorruptError();
      throw error;
    }
    const title = typeof meta.name === 'string' ? meta.name : null;
    const createdAt = validDateFromMs(meta.createdAt);
    const parsed = meta.latestRootBlobId
      ? readMessages(
          db,
          meta.latestRootBlobId,
          budget,
          failureOutcome,
          options.onDiagnostic,
          options.signal
        )
      : {
          messages: [] as Message[],
          messageIdentityEvidence: [] as StoreMessageIdentityEvidence[],
          rawContentBlockEvidence: [] as StoreRawContentBlockEvidence[],
          complete: true,
        };
    result = {
      title,
      messages: parsed.messages,
      messageIdentityEvidence: parsed.messageIdentityEvidence,
      rawContentBlockEvidence: parsed.rawContentBlockEvidence,
      createdAt,
      completeness: parsed.complete ? 'complete' : 'partial',
    };
  } catch (error) {
    if (!snapshotComplete) {
      operationError = error;
    } else if (error instanceof SourceEncodingError || error instanceof SourceLimitExceededError) {
      if (failureOutcome === 'fatal') operationError = error;
      else {
        options.onDiagnostic?.(error);
        debugLogStorage(`store.db defensive parse failed for ${path}: ${error.code}`);
      }
    } else if (isSessionIntegrityError(error)) {
      operationError = error;
    } else if (error instanceof StoreSourceCorruptError || isSqliteSourceCorruptionError(error)) {
      debugLogStorage(`store.db source/schema parse failed for ${path}: ${String(error)}`);
    } else {
      operationError = error;
    }
  } finally {
    let closeError: unknown;
    let cleanupError: unknown;
    try {
      db?.close();
    } catch (error) {
      closeError = error;
    }
    try {
      workspace?.dispose();
    } catch (error) {
      cleanupError = error;
    }
    attachErrorCause(closeError, operationError);
    attachErrorCause(cleanupError, closeError ?? operationError);
    operationError = cleanupError ?? closeError ?? operationError;
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

/** Private control-flow marker for source/schema corruption that may fallback. */
class StoreSourceCorruptError extends Error {}

/** Missing paths are normal inventory races; all other filesystem failures propagate. */
function pathExists(
  path: string,
  signal?: AbortSignal,
  io?: OperationIoContext,
  logicalSessionId?: string
): boolean {
  throwIfAborted(signal);
  try {
    if (io) {
      observeAdapterIo(io, {
        adapter: 'filesystem',
        operation: 'open',
        resourceClass: 'store-session-metadata',
        sourceRole: 'store',
        representation: 'store-db',
        ...(logicalSessionId ? { logicalSessionId } : {}),
      });
    }
    statSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Positively identify SQLite source/schema corruption that may use a safe
 * alternate representation. Generic driver, I/O, lock, prepare, and query
 * failures are deliberately not classified and therefore propagate.
 */
function isSqliteSourceCorruptionError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('database disk image is malformed') ||
    message.includes('file is not a database') ||
    message.includes('malformed database schema') ||
    /^no such (table|column):/.test(message)
  );
}

function decodeHexText(value: string, outcome: SourceFailureOutcome): Buffer {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new SourceEncodingError('sqlite', outcome);
  }
  return Buffer.from(value, 'hex');
}

/** Metadata preflight followed by one row-ID payload fetch. */
function readBoundedValue(
  db: Database,
  budget: SqliteSourceReadBudget,
  table: 'meta' | 'blobs',
  valueColumn: 'value' | 'data',
  keyColumn: 'key' | 'id',
  key: string,
  signal?: AbortSignal
): unknown {
  throwIfAborted(signal);
  const metadata = db
    .prepare(
      `SELECT rowid AS rowId, length(${valueColumn}) AS byteLength FROM ${table} WHERE ${keyColumn} = ?`
    )
    .get(key) as { rowId?: number | bigint; byteLength?: number | bigint } | undefined;
  if (!metadata || metadata.rowId === undefined || metadata.byteLength === undefined) {
    return undefined;
  }
  const declared = Number(metadata.byteLength);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new TypeError('SQLite returned an invalid declared payload length');
  }
  budget.admitMetadataPage([declared]);
  throwIfAborted(signal);
  const row = db
    .prepare(`SELECT ${valueColumn} AS value FROM ${table} WHERE rowid = ?`)
    .get(metadata.rowId) as { value?: unknown } | undefined;
  if (!row || row.value === undefined || row.value === null) return undefined;
  const actual =
    typeof row.value === 'string'
      ? Buffer.byteLength(row.value, 'utf8')
      : row.value instanceof Uint8Array
        ? row.value.byteLength
        : -1;
  if (actual < 0) throw new TypeError('SQLite returned an unsupported payload value');
  budget.admitDecodedValue(actual);
  return row.value;
}

interface BlobMetadata {
  rowId: number | bigint;
  byteLength: number;
}

/**
 * Finite metadata-page reader for reachable Store blobs. Metadata is fetched
 * in operation-bounded pages, admitted as a complete page, and payloads are
 * then fetched sequentially by row ID.
 */
class BoundedBlobReader {
  private readonly metadata = new Map<string, BlobMetadata | null>();

  constructor(
    private readonly db: Database,
    private readonly budget: SqliteSourceReadBudget,
    private readonly signal?: AbortSignal
  ) {}

  prefetch(ids: readonly string[]): void {
    throwIfAborted(this.signal);
    const unresolved = [...new Set(ids)].filter((id) => !this.metadata.has(id));
    const pageRows = this.budget.limits.sqlitePageRows;
    for (let start = 0; start < unresolved.length; start += pageRows) {
      throwIfAborted(this.signal);
      const pageIds = unresolved.slice(start, start + pageRows);
      if (pageIds.length === 0) continue;
      const placeholders = pageIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT rowid AS rowId, id, length(data) AS byteLength FROM blobs WHERE id IN (${placeholders}) ORDER BY rowid`
        )
        .all(...pageIds) as Array<{
        rowId?: number | bigint;
        id?: unknown;
        byteLength?: number | bigint;
      }>;

      const admitted: Array<{ id: string; metadata: BlobMetadata }> = [];
      for (const row of rows) {
        throwIfAborted(this.signal);
        if (
          (typeof row.rowId !== 'number' && typeof row.rowId !== 'bigint') ||
          typeof row.id !== 'string' ||
          (typeof row.byteLength !== 'number' && typeof row.byteLength !== 'bigint')
        ) {
          throw new TypeError('SQLite returned invalid blob metadata');
        }
        const byteLength = Number(row.byteLength);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
          throw new TypeError('SQLite returned an invalid declared blob length');
        }
        admitted.push({ id: row.id, metadata: { rowId: row.rowId, byteLength } });
      }
      this.budget.admitMetadataPage(admitted.map(({ metadata }) => metadata.byteLength));
      for (const { id, metadata } of admitted) this.metadata.set(id, metadata);
      for (const id of pageIds) {
        if (!this.metadata.has(id)) this.metadata.set(id, null);
      }
    }
  }

  read(id: string): Uint8Array | undefined {
    throwIfAborted(this.signal);
    this.prefetch([id]);
    const metadata = this.metadata.get(id);
    if (!metadata) return undefined;
    throwIfAborted(this.signal);
    const row = this.db
      .prepare('SELECT data AS value FROM blobs WHERE rowid = ?')
      .get(metadata.rowId) as { value?: unknown } | undefined;
    if (!row || !(row.value instanceof Uint8Array)) return undefined;
    this.budget.admitDecodedValue(row.value.byteLength);
    return row.value;
  }
}

/** Recursive Merkle walk: 0x0a=message leaf, 0x12=subtree (recurse, ordered). */
function readMessages(
  db: Database,
  rootId: string,
  budget: SqliteSourceReadBudget,
  failureOutcome: SourceFailureOutcome,
  onDiagnostic?: (error: SourceEncodingError | SourceLimitExceededError) => void,
  signal?: AbortSignal
): {
  messages: Message[];
  messageIdentityEvidence: StoreMessageIdentityEvidence[];
  rawContentBlockEvidence: StoreRawContentBlockEvidence[];
  complete: boolean;
} {
  const messages: Message[] = [];
  const messageIdentityEvidence: StoreMessageIdentityEvidence[] = [];
  const rawContentBlockEvidence: StoreRawContentBlockEvidence[] = [];
  const visited = new Set<string>();
  const reachableLeaves: Array<{ hash: string; object: LeafObj }> = [];
  const blobs = new BoundedBlobReader(db, budget, signal);
  let complete = true;
  let halted = false;

  const reportSourceFailure = (error: unknown): boolean => {
    if (!(error instanceof SourceEncodingError || error instanceof SourceLimitExceededError)) {
      return false;
    }
    if (failureOutcome === 'fatal') throw error;
    complete = false;
    halted = true;
    onDiagnostic?.(error);
    return true;
  };

  const walk = (blobId: string): void => {
    throwIfAborted(signal);
    if (halted || visited.has(blobId)) return; // cycle / exhausted-budget guard
    visited.add(blobId);
    let raw: unknown;
    try {
      raw = blobs.read(blobId);
    } catch (error) {
      if (reportSourceFailure(error)) return;
      throw error;
    }
    if (!(raw instanceof Uint8Array)) {
      complete = false;
      debugLogStorage(`store.db: missing subtree blob ${blobId.slice(0, 12)}…`);
      return;
    }
    const buf = Buffer.from(raw);
    const references: Array<{ tag: number; childHash: string }> = [];
    let i = 0;
    while (i < buf.length - 1) {
      const tag = buf[i];
      const len = buf[i + 1];
      if ((tag === 0x0a || tag === 0x12) && len === 0x20 && i + 34 <= buf.length) {
        const childHash = buf.subarray(i + 2, i + 34).toString('hex');
        references.push({ tag, childHash });
        i += 34;
      } else {
        i += 1;
      }
    }

    try {
      blobs.prefetch(references.map(({ childHash }) => childHash));
    } catch (error) {
      if (reportSourceFailure(error)) return;
      throw error;
    }
    for (const { tag, childHash } of references) {
      throwIfAborted(signal);
      if (halted) return;
      if (tag === 0x0a) {
        let leaf: DecodedLeaf | null;
        try {
          leaf = readLeafObject(blobs, childHash, failureOutcome);
        } catch (error) {
          if (reportSourceFailure(error)) return;
          throw error;
        }
        if (leaf === null) {
          complete = false; // missing blob
          debugLogStorage(`store.db: missing leaf blob ${childHash.slice(0, 12)}…`);
        } else if (leaf.kind === 'malformed') {
          complete = false; // unparseable leaf
          debugLogStorage(`store.db: malformed leaf ${childHash.slice(0, 12)}… → partial`);
        } else {
          reachableLeaves.push({ hash: childHash, object: leaf.object });
        }
      } else {
        walk(childHash); // 0x12 subtree → recurse in order
      }
    }
  };
  walk(rootId);

  // Index only tool results reachable from the active root. Historical or
  // abandoned blobs must not enrich the current conversation DAG.
  const toolResults: ToolResultIndex = { byId: new Map(), usedIds: new Set() };
  for (const { object } of reachableLeaves) {
    throwIfAborted(signal);
    for (const [callId, stored] of extractToolResults(object)) {
      toolResults.byId.set(callId, stored);
    }
  }

  const encounteredToolResultIds: string[] = [];
  let encounteredUnkeyedToolResult = false;
  for (let traversalOrdinal = 0; traversalOrdinal < reachableLeaves.length; traversalOrdinal++) {
    throwIfAborted(signal);
    const { hash, object } = reachableLeaves[traversalOrdinal]!;
    const leaf = classifyLeaf(object, toolResults);
    rawContentBlockEvidence.push(...leaf.rawContentBlocks);
    if (leaf.kind === 'message') {
      messages.push(leaf.message);
      messageIdentityEvidence.push({
        representation: 'db',
        leafHash: hash,
        traversalOrdinal,
      });
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
  return { messages, messageIdentityEvidence, rawContentBlockEvidence, complete };
}

type LeafResult =
  | {
      kind: 'message';
      message: Message;
      complete: boolean;
      rawContentBlocks: StoreRawContentBlockEvidence[];
    }
  | {
      kind: 'tool-result';
      callIds: string[];
      complete: boolean;
      rawContentBlocks: StoreRawContentBlockEvidence[];
    }
  | { kind: 'ignore'; rawContentBlocks: StoreRawContentBlockEvidence[] }
  | { kind: 'malformed'; rawContentBlocks: StoreRawContentBlockEvidence[] };

type DecodedLeaf = { kind: 'decoded'; object: LeafObj } | { kind: 'malformed' };

function readLeafObject(
  blobs: BoundedBlobReader,
  hash: string,
  outcome: SourceFailureOutcome
): DecodedLeaf | null {
  const raw = blobs.read(hash);
  if (!(raw instanceof Uint8Array)) return null; // missing blob → caller marks partial
  try {
    const obj = decodeMessageObject(Buffer.from(raw), outcome);
    return obj ? { kind: 'decoded', object: obj } : { kind: 'malformed' };
  } catch (error) {
    if (error instanceof SourceEncodingError || error instanceof SourceLimitExceededError) {
      throw error;
    }
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
      rawContentBlocks: retainToolResultBlocks(obj),
    };
  }
  if (obj.role === 'user' || obj.role === 'assistant') {
    const built = buildMessage(obj, obj.role as MessageRole, toolResults);
    return built.message
      ? {
          kind: 'message',
          message: built.message,
          complete: built.complete,
          rawContentBlocks: built.rawContentBlocks,
        }
      : { kind: 'malformed', rawContentBlocks: built.rawContentBlocks };
  }
  if (obj.role === 'system') return { kind: 'ignore', rawContentBlocks: [] };
  // Unknown roles can contain data from a newer schema; silently dropping them
  // would incorrectly report a complete parse.
  return { kind: 'malformed', rawContentBlocks: retainUnsupportedContent(obj.content) };
}

function buildMessage(
  obj: LeafObj,
  role: MessageRole,
  toolResults: ToolResultIndex
): {
  message: Message | null;
  complete: boolean;
  rawContentBlocks: StoreRawContentBlockEvidence[];
} {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const rawContentBlocks: StoreRawContentBlockEvidence[] = [];
  let complete = true;
  if (typeof obj.content === 'string') {
    texts.push(obj.content);
  } else if (Array.isArray(obj.content)) {
    const r = extractBlocks(obj.content, toolResults);
    texts.push(r.text);
    toolCalls.push(...r.toolCalls);
    rawContentBlocks.push(...r.rawContentBlocks);
    complete = r.complete;
  } else if (obj.content !== undefined && obj.content !== null) {
    // Missing/null content is valid for a tool-only assistant turn. Any other
    // unrecognized value can hide user-visible data.
    complete = false;
    rawContentBlocks.push(retainRawContentBlock(obj.content, 'unsupported', 'db'));
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
    return { message: null, complete: false, rawContentBlocks };
  }
  const msg: Message = { id: null, role, content, codeBlocks: [] };
  if (toolCalls.length > 0) msg.toolCalls = toolCalls;
  return { message: msg, complete, rawContentBlocks };
}

function extractBlocks(
  blocks: unknown[],
  toolResults: ToolResultIndex
): {
  text: string;
  toolCalls: ToolCall[];
  complete: boolean;
  rawContentBlocks: StoreRawContentBlockEvidence[];
} {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const rawContentBlocks: StoreRawContentBlockEvidence[] = [];
  let complete = true;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') {
      rawContentBlocks.push(retainRawContentBlock(b, 'unsupported', 'db'));
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
      rawContentBlocks.push(retainRawContentBlock(block, 'projected-text', 'db'));
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
      rawContentBlocks.push(retainRawContentBlock(block, 'projected-tool', 'db'));
    } else {
      const attachment = projectInlineAttachment(block);
      if (attachment !== null) {
        texts.push(attachment);
        rawContentBlocks.push(retainRawContentBlock(block, 'projected-attachment', 'db'));
        continue;
      }
      // Unknown content blocks can carry user-visible data (for example image
      // or reasoning content). Keep known fields, but report degraded fidelity.
      rawContentBlocks.push(retainRawContentBlock(block, 'unsupported', 'db'));
      complete = false;
    }
  }
  return { text: texts.join(''), toolCalls, complete, rawContentBlocks };
}

function retainUnsupportedContent(content: unknown): StoreRawContentBlockEvidence[] {
  if (content === undefined || content === null || typeof content === 'string') return [];
  const values = Array.isArray(content) ? content : [content];
  return values.map((value) => retainRawContentBlock(value, 'unsupported', 'db'));
}

function retainToolResultBlocks(obj: LeafObj): StoreRawContentBlockEvidence[] {
  if (!Array.isArray(obj.content)) return [];
  return obj.content.map((raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const block = raw as Record<string, unknown>;
      if (block['type'] === 'tool-result' || block['type'] === 'tool_result') {
        return retainRawContentBlock(raw, 'projected-tool', 'db');
      }
    }
    return retainRawContentBlock(raw, 'unsupported', 'db');
  });
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
function decodeMessageObject(data: Buffer, outcome: SourceFailureOutcome): LeafObj | null {
  const direct = parseLeafJson(data, outcome);
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
      const nested = parseLeafJson(data.subarray(offset, end), outcome);
      if (nested) return nested;
    }
    offset = end;
  }
  return null;
}

function parseLeafJson(data: Uint8Array, outcome: SourceFailureOutcome): LeafObj | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const offset =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  if (bytes[offset] !== 0x7b && bytes[offset] !== 0x5b) return null;
  try {
    const parsed = JSON.parse(decodeDeterministicUtf8(data, 'sqlite', outcome).text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as LeafObj) : null;
  } catch (error) {
    if (error instanceof SourceEncodingError) throw error;
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
