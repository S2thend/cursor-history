/**
 * Cross-stack session merge.
 *
 * When the same session ID exists in both the Composer stack (vscdb) and the
 * Store stack (~/.cursor), the two representations are merged field by field
 * instead of selecting one and discarding the other. See
 * specs/015-cursor-store-stack/incremental-update/solutions.md.
 *
 * Merge rules:
 * 1. Only one source provides a value -> keep it.
 * 2. Both provide equivalent values -> keep one, record both sources.
 * 3. Both provide different values -> resolve by the runtime conflict priority
 *    (`preferredSource`), computed by `detectPreferredStackSource()`. Scalar
 *    conflicts (title, createdAt, lastUpdatedAt, workspacePath) follow the same
 *    preferred-source-wins / fill-when-missing policy.
 *
 * Message order follows the preferred source's own stored sequence -- it is
 * NEVER reconstructed by sorting timestamps. Alignment is two-phase:
 *
 *  Phase 1 - strong anchors: a deterministic LCS over a STRONG signature
 *    (role + normalized real content + ordered tool signatures). Only messages
 *    that carry identifying info (real content OR a tool call) can anchor; blank
 *    messages get side-unique weak keys so they never form a low-confidence
 *    anchor (and a corrupt message on one side can never anchor an empty
 *    message on the other).
 *
 *  Phase 2 - compatible fill between anchors: the messages left unmatched in
 *    each anchor gap are paired greedily by role + relative position when they
 *    are FIELD-COMPATIBLE. Two messages are compatible when they share a role
 *    and their contents do not truly conflict -- i.e. it is NOT the case that
 *    BOTH sides carry real, different content. One side lacking content or tool
 *    calls is a fillable gap, not a conflict (so a low-fidelity source can still
 *    merge with a higher-fidelity one). Duplicate signatures match the earliest
 *    position first (stable). Tool-call arrays are always merged additively,
 *    never treated as a conflict.
 *
 * A `[corrupted message]` sentinel means the content is UNKNOWN, not empty, so
 * it is never normalized to empty and only matches another corrupt message.
 * Only `[empty message]` is treated as empty.
 *
 * Signature keys use JSON tuple stringification (no bespoke separator) so the
 * source file contains no control bytes and matching is unambiguous.
 */
import type { ChatSession, ChatSessionSummary, Message, ToolCall } from '../types.js';
import { findEmbeddedToolCallIndex } from '../parser.js';

/** Sentinel content produced by the storage layer for a present-but-empty bubble. */
const EMPTY_PLACEHOLDER = '[empty message]';
/** Sentinel content produced by the storage layer for an unparseable bubble. */
const CORRUPTED_PLACEHOLDER = '[corrupted message]';

/**
 * Product threshold above which the O(n*m) LCS DP table is skipped in favor of a
 * linear greedy strong-anchor pass, bounding memory on very long conversations.
 * 250k is roughly a 500x500 alignment; real sessions rarely approach this.
 */
const LCS_DP_CELL_LIMIT = 250_000;

/** Normalize whitespace for content matching (trim + collapse internal runs). */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Store transcripts may preserve the transport-only wrapper used for user
 * prompts while Composer bubbles expose only its inner text. Treat a wrapper
 * that encloses the whole message as representation metadata, not content.
 */
function unwrapUserQuery(text: string): string {
  const match = text.match(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/i);
  return match?.[1] ?? text;
}

/**
 * Content used for matching. Only the EMPTY placeholder is collapsed to '' so it
 * can match other blank messages. The CORRUPTED placeholder is kept as a
 * distinct literal (unknown content must not equal a real empty message).
 */
function matchContent(text: string): string {
  if (text === EMPTY_PLACEHOLDER) return '';
  return normalizeText(unwrapUserQuery(text));
}

/** Composer's rendered tool marker is metadata when structured tools exist. */
function isSyntheticToolContent(message: Message): boolean {
  if (!message.toolCalls?.length) return false;
  return findEmbeddedToolCallIndex(message.content.trimStart(), message.toolCalls) >= 0;
}

/** Content class for compatibility decisions. */
type ContentClass = 'empty' | 'corrupt' | 'real';

function contentClass(text: string): ContentClass {
  if (text === CORRUPTED_PLACEHOLDER) return 'corrupt';
  if (text.length === 0 || text === EMPTY_PLACEHOLDER) return 'empty';
  return 'real';
}

/** Whether a message carries real (non-blank, non-corrupt) text content. */
function hasRealContent(text: string): boolean {
  return contentClass(text) === 'real';
}

/** Whether a message's content is absent enough that it should be filled. */
function contentMissing(text: string): boolean {
  return contentClass(text) !== 'real';
}

/**
 * Deterministic deep clone with object keys sorted recursively so two
 * structurally-equivalent param objects serialize identically regardless of
 * key insertion order.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortDeep(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable string key for a tool's params, or null when the tool carries no
 * params (a "missing params" wildcard for matching).
 */
function paramsKey(tc: ToolCall): string | null {
  if (tc.params === undefined || tc.params === null) return null;
  return JSON.stringify(sortDeep(tc.params));
}

/** Whether a message is "strong" enough to serve as a reliable anchor. */
function isStrongMessage(m: Message): boolean {
  return hasRealContent(m.content) || (m.toolCalls?.length ?? 0) > 0;
}

/**
 * Strong signature key for anchoring, or a side-unique weak sentinel so blank
 * messages can never anchor across sides. The `side` tag makes weak keys
 * side-unique (a corrupt/empty message on one side cannot anchor a blank
 * message on the other). Tool identity in the key uses the FULL normalized
 * params (per solutions.md "tool name + normalized params"), so two calls of
 * the same tool with different params are distinct and never equated. The
 * missing-params case is handled later by Phase-2 compatibility, not by
 * weakening this key.
 */
function strongKey(m: Message, index: number, side: 'b' | 'o'): string {
  if (!isStrongMessage(m)) {
    return JSON.stringify(['weak', side, index]);
  }
  const tools = (m.toolCalls ?? []).map((tc) => [tc.name, sortDeep(tc.params ?? null)]);
  return JSON.stringify([m.role, matchContent(m.content), tools]);
}

/**
 * Phase-1 anchor pairs via LCS over strong keys (deterministic, earliest-first
 * backtracking). Returns [] for the oversize case (caller falls back to a
 * linear greedy strong-anchor pass).
 */
function lcsAnchorPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > LCS_DP_CELL_LIMIT) return []; // scale guard -- caller falls back

  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? 1 + dp[i + 1]![j + 1]! : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++; // advance backbone on ties (deterministic)
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Linear fallback anchor pass for oversize sequences: match equal strong keys
 * in order, O(n+m). Weak messages (side-unique keys) never match across sides.
 * The returned pairs are STRICTLY INCREASING on both axes (the b-side cursor
 * only advances forward), so they never cross — `alignAndMerge` relies on this.
 */
export function greedyAnchorPairs(a: string[], b: string[]): Array<[number, number]> {
  const bIndices = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const list = bIndices.get(b[j]!);
    if (list) list.push(j);
    else bIndices.set(b[j]!, [j]);
  }
  const pairs: Array<[number, number]> = [];
  let lastB = -1; // b-side index must strictly increase to avoid crossing anchors
  for (let i = 0; i < a.length; i++) {
    const candidates = bIndices.get(a[i]!);
    if (!candidates) continue;
    // candidates are ascending; pick the first one past lastB (monotonic).
    const next = candidates.find((j) => j > lastB);
    if (next === undefined) continue;
    lastB = next;
    pairs.push([i, next]);
  }
  return pairs;
}

/**
 * Whether two contents can belong to the same message. Corrupt only matches
 * corrupt (unknown != empty/real). Empty matches empty or real (fillable). Real
 * matches real only when equal after normalization.
 */
function contentCompatible(a: string, b: string): boolean {
  const ca = contentClass(a);
  const cb = contentClass(b);
  if (ca === 'corrupt' || cb === 'corrupt') {
    return ca === 'corrupt' && cb === 'corrupt';
  }
  if (ca === 'real' && cb === 'real') {
    return matchContent(a) === matchContent(b);
  }
  return true; // empty involved (but no corrupt) -> fillable
}

/**
 * Whether two tool-call arrays have a TRUE conflict that forbids merging the
 * messages. A conflict exists when the SAME tool name has param-bearing calls
 * on BOTH sides with DISJOINT param sets AND neither side has a no-params
 * wildcard for that name -- e.g. `Read{/a}` vs `Read{/b}` with no bare `Read`.
 *
 * A no-params call is a wildcard: it can absorb a differing-param call via
 * fill, so its presence clears the conflict for that name. Same name + equal
 * params: not a conflict.
 */
function toolsConflict(aTools: ToolCall[], bTools: ToolCall[]): boolean {
  const collect = (tools: ToolCall[]) => {
    const paramd = new Map<string, Set<string>>();
    const wildcards = new Set<string>();
    for (const tc of tools) {
      const pk = paramsKey(tc);
      if (pk === null) wildcards.add(tc.name);
      else {
        const set = paramd.get(tc.name);
        if (set) set.add(pk);
        else paramd.set(tc.name, new Set([pk]));
      }
    }
    return { paramd, wildcards };
  };
  const a = collect(aTools);
  const b = collect(bTools);
  for (const [name, aSet] of a.paramd) {
    const bSet = b.paramd.get(name);
    if (!bSet) continue;
    // A wildcard on either side for this name can bridge the difference.
    if (a.wildcards.has(name) || b.wildcards.has(name)) continue;
    let common = false;
    for (const v of aSet) {
      if (bSet.has(v)) {
        common = true;
        break;
      }
    }
    if (!common) return true;
  }
  return false;
}

/** Both non-empty sides need a real same-tool bridge before their messages can merge. */
function hasCompatibleToolPair(aTools: ToolCall[], bTools: ToolCall[]): boolean {
  if (aTools.length === 0 || bTools.length === 0) return true;
  return aTools.some((a) =>
    bTools.some((b) => {
      if (a.name !== b.name) return false;
      const aParams = paramsKey(a);
      const bParams = paramsKey(b);
      return aParams === null || bParams === null || aParams === bParams;
    })
  );
}

/**
 * Phase-2 compatibility: two messages can be merged if they share a role, their
 * contents are compatible, and their tool calls do not truly conflict. One side
 * lacking content/params is a fillable gap, not a conflict.
 */
function messagesCompatible(a: Message, b: Message): boolean {
  if (a.role !== b.role) return false;
  const aTools = a.toolCalls ?? [];
  const bTools = b.toolCalls ?? [];
  const compatibleTools = hasCompatibleToolPair(aTools, bTools) && !toolsConflict(aTools, bTools);
  if (!compatibleTools) return false;
  if (contentCompatible(a.content, b.content)) return true;
  // Composer can render a structured tool call as `[Tool: ...]` while Store
  // keeps the assistant's natural-language text plus the same structured call.
  // The compatible tool signature is the identity bridge in that case.
  return isSyntheticToolContent(a) || isSyntheticToolContent(b);
}

function isPresent(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value.length > 0;
}

/** Tag a message that came from only one stack with its origin. Does not mutate input. */
function tagUnmatched(message: Message, origin: 'composer' | 'store'): Message {
  return { ...message, source: origin };
}

/** Merge fields of two matched (compatible) messages. Backbone wins true conflicts. */
function mergeMessage(
  backbone: Message,
  other: Message,
  _backboneOrigin: 'composer' | 'store',
  _otherOrigin: 'composer' | 'store'
): Message {
  // Start from the backbone message (preferred source wins conflicts).
  const merged: Message = { ...backbone, source: 'both' };

  // Content: if the backbone's content is missing/blank/corrupt but the other
  // side has real content, adopt it (a fidelity gap, not a conflict).
  if (contentMissing(backbone.content) && hasRealContent(other.content)) {
    merged.content = other.content;
  } else if (
    isSyntheticToolContent(backbone) &&
    hasRealContent(other.content) &&
    !isSyntheticToolContent(other)
  ) {
    // Prefer the natural-language representation over a generated display
    // marker even when Composer is the scalar-conflict backbone.
    merged.content = other.content;
  }

  // Thinking: fill from other when the backbone lacks it.
  if (!isPresent(merged.thinking) && isPresent(other.thinking)) {
    merged.thinking = other.thinking;
  }

  // Code blocks: fill from other when the backbone has none.
  if ((!merged.codeBlocks || merged.codeBlocks.length === 0) && other.codeBlocks?.length) {
    merged.codeBlocks = [...other.codeBlocks];
  }

  // Token usage / model / duration: Composer-only typically; fill from other.
  if (merged.tokenUsage === undefined && other.tokenUsage !== undefined) {
    merged.tokenUsage = other.tokenUsage;
  }
  if (merged.model === undefined && other.model !== undefined) {
    merged.model = other.model;
  }
  if (merged.durationMs === undefined && other.durationMs !== undefined) {
    merged.durationMs = other.durationMs;
  }

  // Tool calls: match by signature and fill missing fields; append unmatched
  // tool calls from either side (additive, no duplication).
  const mergedTools = mergeToolCalls(backbone.toolCalls ?? [], other.toolCalls ?? []);
  if (mergedTools && mergedTools.length > 0) {
    merged.toolCalls = mergedTools;
  } else if (merged.toolCalls !== undefined && (merged.toolCalls?.length ?? 0) === 0) {
    delete merged.toolCalls;
  }

  // Timestamp: keep the backbone's directly-stored time when present; otherwise
  // adopt the other side's directly-stored time (with its provenance). Never
  // fabricate.
  if (merged.timestamp === undefined && other.timestamp !== undefined) {
    merged.timestamp = other.timestamp;
    merged.timestampSource = other.timestampSource;
  }

  // Metadata: merge, backbone values take precedence.
  if (other.metadata) {
    merged.metadata = { ...other.metadata, ...(merged.metadata ?? {}) };
  }

  // ID: keep backbone id when present, else adopt the other side's.
  if ((merged.id === null || merged.id === undefined) && other.id) {
    merged.id = other.id;
  }

  return merged;
}

/**
 * Merge two tool-call arrays with a GLOBAL two-pass pairing (not per-tool), so a
 * no-params backbone call cannot steal an exact-match partner from another call:
 *
 *  Pass 1 - EXACT: pair every backbone call with an unused other call of the
 *    same name AND equal normalized params (covers both-no-params and
 *    both-same-params). All exact matches are committed before any fill.
 *  Pass 2 - FILL: for backbone calls still unmatched, pair with an unused other
 *    call of the same name where AT LEAST ONE side has no params (fillable).
 *  Remaining: unmatched calls from both sides are appended in order.
 *
 * Differing params are never overwritten (both-present-different never pairs);
 * no call is ever lost or duplicated.
 */
function mergeToolCalls(backbone: ToolCall[], other: ToolCall[]): ToolCall[] | undefined {
  if (backbone.length === 0 && other.length === 0) return undefined;
  if (backbone.length === 0) return other.map((tc) => ({ ...tc }));
  if (other.length === 0) return backbone.map((tc) => ({ ...tc }));

  const usedOther = new Set<number>();
  const matched: Array<number | null> = new Array(backbone.length).fill(null);

  // Pass 1: exact (name + equal paramsKey), committed globally first.
  for (let i = 0; i < backbone.length; i++) {
    const bt = backbone[i]!;
    const bp = paramsKey(bt);
    for (let k = 0; k < other.length; k++) {
      if (usedOther.has(k)) continue;
      const ot = other[k]!;
      if (ot.name !== bt.name) continue;
      if (paramsKey(ot) === bp) {
        matched[i] = k;
        usedOther.add(k);
        break;
      }
    }
  }

  // Pass 2: fill (same name, one side missing params), only for still-unmatched
  // backbone calls, against still-unused other calls.
  for (let i = 0; i < backbone.length; i++) {
    if (matched[i] != null) continue;
    const bt = backbone[i]!;
    const bp = paramsKey(bt);
    for (let k = 0; k < other.length; k++) {
      if (usedOther.has(k)) continue;
      const ot = other[k]!;
      if (ot.name !== bt.name) continue;
      const op = paramsKey(ot);
      if (bp === null || op === null) {
        matched[i] = k;
        usedOther.add(k);
        break;
      }
    }
  }

  // Build result in backbone order; append unmatched other calls in order.
  const merged: ToolCall[] = [];
  for (let i = 0; i < backbone.length; i++) {
    const k = matched[i];
    if (k != null) merged.push(mergeToolCall(backbone[i]!, other[k]!));
    else merged.push({ ...backbone[i]! });
  }
  for (let k = 0; k < other.length; k++) {
    if (!usedOther.has(k)) merged.push({ ...other[k]! });
  }
  return merged;
}

/** Fill non-outcome fields; conflicting outcomes remain wholly backbone-owned. */
function mergeToolCall(backbone: ToolCall, other: ToolCall): ToolCall {
  const merged: ToolCall = { ...backbone };
  if (backbone.status === other.status) {
    if (merged.result === undefined && other.result !== undefined) merged.result = other.result;
    if (merged.error === undefined && other.error !== undefined) merged.error = other.error;
  }
  if (merged.files === undefined && other.files !== undefined) merged.files = [...other.files!];
  if (merged.params === undefined && other.params !== undefined) merged.params = other.params;
  return merged;
}

/**
 * Phase-2 gap matching: pair backbone gap messages with compatible other-side
 * gap messages greedily (earliest compatible match wins, stable). Backbone
 * defines order; unmatched messages from either side are preserved in relative
 * position. Never reorders by timestamp.
 */
function matchGap(
  bGap: Message[],
  oGap: Message[],
  backboneOrigin: 'composer' | 'store',
  otherOrigin: 'composer' | 'store'
): Message[] {
  const result: Message[] = [];
  let oCursor = 0;
  for (const bMsg of bGap) {
    let match = -1;
    for (let j = oCursor; j < oGap.length; j++) {
      if (messagesCompatible(bMsg, oGap[j]!)) {
        match = j;
        break;
      }
    }
    if (match >= 0) {
      for (let j = oCursor; j < match; j++) {
        result.push(tagUnmatched(oGap[j]!, otherOrigin));
      }
      result.push(mergeMessage(bMsg, oGap[match]!, backboneOrigin, otherOrigin));
      oCursor = match + 1;
    } else {
      result.push(tagUnmatched(bMsg, backboneOrigin));
    }
  }
  for (let j = oCursor; j < oGap.length; j++) {
    result.push(tagUnmatched(oGap[j]!, otherOrigin));
  }
  return result;
}

/**
 * Align two ordered message sequences (two-phase) and merge them. The backbone
 * (preferred source) defines canonical order.
 */
function alignAndMerge(
  backbone: Message[],
  other: Message[],
  backboneOrigin: 'composer' | 'store',
  otherOrigin: 'composer' | 'store'
): Message[] {
  const bKeys = backbone.map((m, i) => strongKey(m, i, 'b'));
  const oKeys = other.map((m, i) => strongKey(m, i, 'o'));
  const anchors =
    bKeys.length * oKeys.length > LCS_DP_CELL_LIMIT
      ? greedyAnchorPairs(bKeys, oKeys)
      : lcsAnchorPairs(bKeys, oKeys);

  const result: Message[] = [];
  let bi = 0;
  let oi = 0;
  for (const [bIdx, oIdx] of anchors) {
    result.push(
      ...matchGap(backbone.slice(bi, bIdx), other.slice(oi, oIdx), backboneOrigin, otherOrigin)
    );
    result.push(mergeMessage(backbone[bIdx]!, other[oIdx]!, backboneOrigin, otherOrigin));
    bi = bIdx + 1;
    oi = oIdx + 1;
  }
  result.push(...matchGap(backbone.slice(bi), other.slice(oi), backboneOrigin, otherOrigin));
  return result;
}

/** Pick the preferred scalar value when non-empty, else the other. */
function pickScalar<T>(preferred: T | null | undefined, other: T | null | undefined): T | null {
  if (preferred !== null && preferred !== undefined && String(preferred).length > 0) {
    return preferred;
  }
  if (other !== null && other !== undefined) return other;
  return null;
}

/**
 * Scalar conflict resolution: preferred source wins a true conflict; when the
 * preferred side is missing a value, the other side fills it.
 */
function pickPreferredDate(preferred: Date, other: Date): Date {
  return preferred ?? other;
}

/**
 * Merge two full ChatSessions (one per stack) into a single resolved session.
 * Both inputs already use the unified `Message` model; `composer` and `store`
 * identify the contributing stacks. `preferredSource` selects the backbone and
 * wins scalar conflicts.
 */
export function mergeCrossStackSessions(
  composer: ChatSession,
  store: ChatSession,
  preferredSource: 'composer' | 'store',
  index: number
): ChatSession {
  const backbone = preferredSource === 'composer' ? composer : store;
  const other = preferredSource === 'composer' ? store : composer;
  const backboneOrigin = preferredSource;
  const otherOrigin: 'composer' | 'store' = preferredSource === 'composer' ? 'store' : 'composer';

  const messages = alignAndMerge(backbone.messages, other.messages, backboneOrigin, otherOrigin);

  // Scalar metadata: preferred wins conflicts, fill gaps from the other.
  const title = pickScalar(backbone.title, other.title);
  const workspacePath = backbone.workspacePath ?? other.workspacePath ?? composer.workspacePath;
  const createdAt = pickPreferredDate(backbone.createdAt, other.createdAt);
  // lastUpdatedAt: preferred source wins (e.g. WSL -> Store's value), not the
  // later of the two.
  const lastUpdatedAt = pickPreferredDate(backbone.lastUpdatedAt, other.lastUpdatedAt);

  // Source-specific structured data is additive: keep whichever side provides it
  // (Composer typically provides usage + activeBranchBubbleIds; Store may extend).
  const usage = backbone.usage ?? other.usage;
  const activeBranchBubbleIds = backbone.activeBranchBubbleIds ?? other.activeBranchBubbleIds;

  const session: ChatSession = {
    id: composer.id,
    index,
    title,
    createdAt,
    lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: backbone.workspaceId,
    workspacePath,
    source: 'merged',
    sources: ['composer', 'store'],
    preferredSource,
    transcriptState: store.transcriptState,
  };
  if (usage) session.usage = usage;
  if (activeBranchBubbleIds) session.activeBranchBubbleIds = activeBranchBubbleIds;
  return session;
}

/**
 * Minimal Store-side fields needed to merge a listing summary. Avoids importing
 * the full StoreSession type so this module stays decoupled from discovery.
 */
export interface StoreSummaryInput {
  id: string;
  title: string | null;
  createdAt: Date;
  /** Store session-level update time (`updatedAtMs` or `createdAt`). */
  lastUpdatedAt: Date;
  workspacePath?: string;
  messageCount: number;
  transcriptState: ChatSessionSummary['transcriptState'];
}

/**
 * Merge Store-side summary fields into an existing (Composer) summary in place.
 * Marks the summary as merged and records the contributing stacks + preferred
 * source. Used by `listSessions` so a session visible in both stacks appears
 * once with merged scalar metadata; the real message merge happens in
 * `getSession` via `mergeCrossStackSessions`.
 */
export function applyStoreMergeToSummary(
  existing: ChatSessionSummary,
  store: StoreSummaryInput,
  preferredSource: 'composer' | 'store'
): void {
  const preferStore = preferredSource === 'store';
  const prefTitle = preferStore ? store.title : existing.title;
  const otherTitle = preferStore ? existing.title : store.title;
  existing.title = pickScalar(prefTitle, otherTitle);

  const prefPath = preferStore ? store.workspacePath : existing.workspacePath;
  const otherPath = preferStore ? existing.workspacePath : store.workspacePath;
  existing.workspacePath = prefPath ?? otherPath ?? existing.workspacePath;

  // createdAt: preferred source wins.
  existing.createdAt = preferStore ? store.createdAt : existing.createdAt;

  // lastUpdatedAt: preferred source wins. Store keeps its own update time
  // (`updatedAtMs` or `createdAt`) instead of reusing another source's value.
  existing.lastUpdatedAt = preferStore ? store.lastUpdatedAt : existing.lastUpdatedAt;

  // messageCount: approximate (preferred source's count); recomputed on get.
  existing.messageCount = preferStore ? store.messageCount : existing.messageCount;

  existing.source = 'merged';
  existing.sources = ['composer', 'store'];
  existing.preferredSource = preferredSource;
  existing.transcriptState = store.transcriptState;
}
