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
import {
  allocateStoreMessageIdentities,
  allocateToolCallIdentities,
  matchAlignedToolCalls,
  MESSAGE_IDENTITY_VERSION,
  prepareStoreIdentityCandidates,
  projectV016ComposerMessages,
} from '../session-identity.js';

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

interface AlignmentPair {
  composerIndex: number;
  storeIndex: number;
}

interface AlignmentPlan {
  composer: Message[];
  store: Message[];
  pairs: AlignmentPair[];
}

interface RenderedMessage {
  message: Message;
  composerIndex?: number;
  storeIndex?: number;
}

/** Internal mutation switches used only to prove the load-bearing regressions. */
export interface MergeFaultInjection {
  preferredBackbonePairing?: boolean;
  preferredBackboneToolOrder?: boolean;
}

/** Attach modern tool identities after the containing message identity is final. */
function resolveToolIdentities(messageId: string, calls: ToolCall[]): ToolCall[] {
  return allocateToolCallIdentities(messageId, calls).map(({ call, id, identityOrigin }) => ({
    ...call,
    id,
    identityOrigin,
  }));
}

/** Fill non-outcome fields; conflicting outcomes remain wholly preferred-source-owned. */
function mergeToolCall(preferred: ToolCall, other: ToolCall): ToolCall {
  const merged: ToolCall = { ...preferred };
  if (preferred.status === other.status) {
    if (merged.result === undefined && other.result !== undefined) merged.result = other.result;
    if (merged.error === undefined && other.error !== undefined) merged.error = other.error;
  }
  if (merged.files === undefined && other.files !== undefined) merged.files = [...other.files];
  if (merged.params === undefined && other.params !== undefined) merged.params = other.params;
  return merged;
}

/**
 * Pair calls once in Composer-to-Store orientation. Composer calls retain their
 * released array slots, matched Store data enriches those slots, and unmatched
 * Store calls append in Store-native order. Preferred source controls only
 * conflicting values inside a paired call.
 */
function mergeToolCalls(
  composer: ToolCall[],
  store: ToolCall[],
  preferredSource: 'composer' | 'store',
  messageId: string,
  faults?: MergeFaultInjection
): ToolCall[] | undefined {
  if (composer.length === 0 && store.length === 0) return undefined;

  const alignment = matchAlignedToolCalls(composer, store);
  if (faults?.preferredBackboneToolOrder && preferredSource === 'store') {
    const composerByStore = new Map(
      alignment.pairs.map(({ composerIndex, storeIndex }) => [storeIndex, composerIndex])
    );
    const reordered = store.map((storeCall, storeIndex) => {
      const composerIndex = composerByStore.get(storeIndex);
      return composerIndex === undefined
        ? { ...storeCall }
        : mergeToolCall(storeCall, composer[composerIndex]!);
    });
    for (const composerIndex of alignment.unmatchedComposerIndices) {
      reordered.push({ ...composer[composerIndex]! });
    }
    return resolveToolIdentities(messageId, reordered);
  }
  const storeByComposer = new Map(
    alignment.pairs.map(({ composerIndex, storeIndex }) => [composerIndex, storeIndex])
  );
  const merged: ToolCall[] = composer.map((composerCall, composerIndex) => {
    const storeIndex = storeByComposer.get(composerIndex);
    if (storeIndex === undefined) return { ...composerCall };
    const storeCall = store[storeIndex]!;
    const call =
      preferredSource === 'composer'
        ? mergeToolCall(composerCall, storeCall)
        : mergeToolCall(storeCall, composerCall);

    // A matched call stays in the Composer slot. Preserve the Composer-native
    // identity when it exists; otherwise a Store-native identity may enrich it.
    if (isPresent(composerCall.id)) call.id = composerCall.id;
    else if (isPresent(storeCall.id)) call.id = storeCall.id;
    else delete call.id;
    delete call.identityOrigin;
    return call;
  });
  for (const storeIndex of alignment.unmatchedStoreIndices) {
    merged.push({ ...store[storeIndex]! });
  }
  return resolveToolIdentities(messageId, merged);
}

/** Resolve tool IDs on a message that occurs in only one source. */
function tagUnmatched(message: Message, origin: 'composer' | 'store'): Message {
  const tagged: Message = { ...message, source: origin };
  if (message.toolCalls?.length) {
    tagged.toolCalls = resolveToolIdentities(message.id!, message.toolCalls);
  }
  return tagged;
}

/** Merge fields of one fixed Composer/Store pair. Preferred source wins conflicts. */
function mergeMessage(
  composer: Message,
  store: Message,
  preferredSource: 'composer' | 'store',
  faults?: MergeFaultInjection
): Message {
  const backbone = preferredSource === 'composer' ? composer : store;
  const other = preferredSource === 'composer' ? store : composer;
  const merged: Message = {
    ...backbone,
    // Matched Store messages always inherit the frozen Composer identity,
    // regardless of which representation supplies the rendering backbone.
    id: composer.id,
    messageIdentityVersion: MESSAGE_IDENTITY_VERSION,
    identityOrigin: composer.identityOrigin,
    source: 'both',
  };

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
  const mergedTools = mergeToolCalls(
    composer.toolCalls ?? [],
    store.toolCalls ?? [],
    preferredSource,
    composer.id!,
    faults
  );
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

  return merged;
}

/**
 * Phase-2 gap pairing in one permanent Composer-to-Store orientation. Each
 * Composer message chooses the earliest compatible Store message after the
 * previous pair, so pair selection cannot change with the rendering backbone.
 */
function matchGapPairs(
  composer: Message[],
  store: Message[],
  composerStart: number,
  composerEnd: number,
  storeStart: number,
  storeEnd: number
): AlignmentPair[] {
  const pairs: AlignmentPair[] = [];
  let storeCursor = storeStart;
  for (let composerIndex = composerStart; composerIndex < composerEnd; composerIndex++) {
    let match = -1;
    for (let storeIndex = storeCursor; storeIndex < storeEnd; storeIndex++) {
      if (messagesCompatible(composer[composerIndex]!, store[storeIndex]!)) {
        match = storeIndex;
        break;
      }
    }
    if (match >= 0) {
      pairs.push({ composerIndex, storeIndex: match });
      storeCursor = match + 1;
    }
  }
  return pairs;
}

/**
 * Compute pair selection exactly once in Composer-to-Store orientation.
 * Preferred rendering is deliberately absent from this function.
 */
function computeAlignment(composer: Message[], store: Message[]): AlignmentPlan {
  const composerKeys = composer.map((message, index) => strongKey(message, index, 'b'));
  const storeKeys = store.map((message, index) => strongKey(message, index, 'o'));
  const anchors =
    composerKeys.length * storeKeys.length > LCS_DP_CELL_LIMIT
      ? greedyAnchorPairs(composerKeys, storeKeys)
      : lcsAnchorPairs(composerKeys, storeKeys);

  const pairs: AlignmentPair[] = [];
  let composerCursor = 0;
  let storeCursor = 0;
  for (const [composerIndex, storeIndex] of anchors) {
    pairs.push(
      ...matchGapPairs(composer, store, composerCursor, composerIndex, storeCursor, storeIndex)
    );
    pairs.push({ composerIndex, storeIndex });
    composerCursor = composerIndex + 1;
    storeCursor = storeIndex + 1;
  }
  pairs.push(
    ...matchGapPairs(composer, store, composerCursor, composer.length, storeCursor, store.length)
  );
  return { composer, store, pairs };
}

/** Render one fixed plan while allowing the preferred source to order gaps. */
function renderAlignment(
  plan: AlignmentPlan,
  preferredSource: 'composer' | 'store',
  faults?: MergeFaultInjection
): RenderedMessage[] {
  const result: RenderedMessage[] = [];
  let composerCursor = 0;
  let storeCursor = 0;

  const appendUnmatched = (source: 'composer' | 'store', start: number, end: number): void => {
    const messages = source === 'composer' ? plan.composer : plan.store;
    for (let index = start; index < end; index++) {
      result.push({
        message: tagUnmatched(messages[index]!, source),
        ...(source === 'composer' ? { composerIndex: index } : { storeIndex: index }),
      });
    }
  };

  for (const pair of plan.pairs) {
    if (preferredSource === 'composer') {
      appendUnmatched('composer', composerCursor, pair.composerIndex);
      appendUnmatched('store', storeCursor, pair.storeIndex);
    } else {
      appendUnmatched('store', storeCursor, pair.storeIndex);
      appendUnmatched('composer', composerCursor, pair.composerIndex);
    }
    result.push({
      message: mergeMessage(
        plan.composer[pair.composerIndex]!,
        plan.store[pair.storeIndex]!,
        preferredSource,
        faults
      ),
      composerIndex: pair.composerIndex,
      storeIndex: pair.storeIndex,
    });
    composerCursor = pair.composerIndex + 1;
    storeCursor = pair.storeIndex + 1;
  }

  if (preferredSource === 'composer') {
    appendUnmatched('composer', composerCursor, plan.composer.length);
    appendUnmatched('store', storeCursor, plan.store.length);
  } else {
    appendUnmatched('store', storeCursor, plan.store.length);
    appendUnmatched('composer', composerCursor, plan.composer.length);
  }
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

/** Freeze the exact Composer-only array before Store messages can affect it. */
function freezeComposerMessages(messages: Message[]): Message[] {
  return projectV016ComposerMessages(messages).map((projected) => {
    const message = { ...projected } as Message & { sourceOrdinal?: number };
    delete message.sourceOrdinal;
    return message;
  });
}

/** Stable transcript identity evidence excludes outcome/enrichment fields. */
function transcriptIdentityRecords(messages: Message[]) {
  return messages.map((message) => {
    const sourceRelationships: Record<string, unknown> = {};
    if (message.parentMessageId !== undefined) {
      sourceRelationships['parentMessageId'] = message.parentMessageId;
    }
    if (message.isSidechain !== undefined) {
      sourceRelationships['isSidechain'] = message.isSidechain;
    }
    const toolActivity = (message.toolCalls ?? []).map((call) => {
      const activity: Record<string, unknown> = { name: call.name };
      if (call.params !== undefined) activity['params'] = call.params;
      return activity;
    });
    return {
      representation: 'transcript' as const,
      role: message.role,
      content: message.content,
      toolActivity,
      ...(Object.keys(sourceRelationships).length > 0 ? { sourceRelationships } : {}),
    };
  });
}

/** Allocate Store IDs only after the fixed alignment identifies Composer matches. */
function resolveMessageIdentities(
  composerMessages: Message[],
  storeMessages: Message[],
  pairs: AlignmentPair[]
): { composer: Message[]; store: Message[] } {
  const composer = freezeComposerMessages(composerMessages);
  const candidates = prepareStoreIdentityCandidates(transcriptIdentityRecords(storeMessages));
  const matchedComposerByStore = new Map(
    pairs.map(({ composerIndex, storeIndex }) => [storeIndex, composerIndex])
  );
  const allocated = allocateStoreMessageIdentities(
    projectV016ComposerMessages(composerMessages),
    candidates,
    matchedComposerByStore
  );
  const store = storeMessages.map((message, index) => {
    const identity = allocated[index]!.identity;
    return {
      ...message,
      id: identity.value,
      messageIdentityVersion: identity.version,
      identityOrigin: identity.origin,
    };
  });
  return { composer, store };
}

function addIdentityMapping(
  map: Map<string, string>,
  sourceId: string | null | undefined,
  resolvedId: string
): void {
  if (isPresent(sourceId) && !map.has(sourceId)) map.set(sourceId, resolvedId);
  if (!map.has(resolvedId)) map.set(resolvedId, resolvedId);
}

/** Build representation-local source-reference maps without conflating equal raw IDs. */
function buildSourceIdentityMaps(
  rawComposer: Message[],
  rawStore: Message[],
  resolvedComposer: Message[],
  resolvedStore: Message[]
): { composer: Map<string, string>; store: Map<string, string> } {
  const composer = new Map<string, string>();
  const store = new Map<string, string>();
  for (let index = 0; index < resolvedComposer.length; index++) {
    addIdentityMapping(composer, rawComposer[index]?.id, resolvedComposer[index]!.id!);
  }
  for (let index = 0; index < resolvedStore.length; index++) {
    addIdentityMapping(store, rawStore[index]?.id, resolvedStore[index]!.id!);
  }
  return { composer, store };
}

/** Rewrite explicitly stored parent references through the correct source map. */
function rewriteRenderedRelationships(
  rendered: RenderedMessage[],
  rawComposer: Message[],
  rawStore: Message[],
  identityMaps: { composer: Map<string, string>; store: Map<string, string> },
  preferredSource: 'composer' | 'store'
): void {
  for (const entry of rendered) {
    const composerMessage =
      entry.composerIndex === undefined ? undefined : rawComposer[entry.composerIndex];
    const storeMessage = entry.storeIndex === undefined ? undefined : rawStore[entry.storeIndex];
    const ordered =
      preferredSource === 'composer'
        ? ([
            ['composer', composerMessage],
            ['store', storeMessage],
          ] as const)
        : ([
            ['store', storeMessage],
            ['composer', composerMessage],
          ] as const);

    delete entry.message.parentMessageId;
    for (const [source, sourceMessage] of ordered) {
      if (sourceMessage?.parentMessageId === undefined) continue;
      const parentMessageId = identityMaps[source].get(sourceMessage.parentMessageId);
      if (parentMessageId !== undefined) entry.message.parentMessageId = parentMessageId;
      break;
    }

    delete entry.message.isSidechain;
    for (const [, sourceMessage] of ordered) {
      if (sourceMessage?.isSidechain === undefined) continue;
      entry.message.isSidechain = sourceMessage.isSidechain;
      break;
    }
  }
}

/**
 * Rewrite the Composer branch and include Store-only gaps only between two
 * confirmed active Composer nodes. A trailing Store message cannot be inferred
 * to be active merely because it follows the last known branch node.
 */
function rewriteActiveBranch(
  composer: ChatSession,
  rendered: RenderedMessage[],
  composerIdentityMap: Map<string, string>
): string[] | undefined {
  const sourceBranch = composer.activeBranchBubbleIds ?? composer.activeBranchMessageIds;
  if (sourceBranch === undefined) return undefined;
  const mapped = sourceBranch.flatMap((sourceId) => {
    const resolved = composerIdentityMap.get(sourceId);
    return resolved === undefined ? [] : [resolved];
  });
  if (mapped.length <= 1) return mapped;

  const positions: number[] = [];
  let cursor = -1;
  for (const id of mapped) {
    const position = rendered.findIndex(
      (entry, index) =>
        index > cursor && entry.message.id === id && entry.composerIndex !== undefined
    );
    if (position < 0) continue;
    positions.push(position);
    cursor = position;
  }
  if (positions.length === 0) return [];

  const branch: string[] = [rendered[positions[0]!]!.message.id!];
  for (let index = 1; index < positions.length; index++) {
    const previous = positions[index - 1]!;
    const current = positions[index]!;
    for (let renderedIndex = previous + 1; renderedIndex < current; renderedIndex++) {
      const entry = rendered[renderedIndex]!;
      if (
        entry.composerIndex === undefined &&
        entry.storeIndex !== undefined &&
        entry.message.isSidechain !== true
      ) {
        branch.push(entry.message.id!);
      }
    }
    branch.push(rendered[current]!.message.id!);
  }
  return branch;
}

/** Rebuild active parent/leaf semantics after Store gaps alter the branch. */
function rebuildActiveBranchParents(
  rendered: RenderedMessage[],
  activeBranchMessageIds: string[] | undefined
): void {
  if (activeBranchMessageIds === undefined) return;
  let cursor = -1;
  let previousId: string | undefined;
  for (const id of activeBranchMessageIds) {
    const position = rendered.findIndex(
      (entry, index) => index > cursor && entry.message.id === id
    );
    if (position < 0) continue;
    const message = rendered[position]!.message;
    if (previousId === undefined) delete message.parentMessageId;
    else message.parentMessageId = previousId;
    message.isSidechain = false;
    previousId = id;
    cursor = position;
  }
}

type FidelityInput = Pick<ChatSession, 'source' | 'resolution' | 'transcriptState'>;

function isCompleteContribution(session: FidelityInput, unknownIsComplete: boolean): boolean {
  if (session.resolution !== undefined) return session.resolution.state === 'complete';
  switch (session.source) {
    case 'workspace-fallback':
    case 'store-partial':
      return false;
    case 'transcript':
      return session.transcriptState === 'parsed';
    default:
      // Undefined is retained for source-compatible callers and unit fixtures;
      // explicit modern adapters must report partial fidelity themselves.
      return session.source === undefined ? unknownIsComplete : true;
  }
}

function mergedResolution(composer: FidelityInput, store: FidelityInput, unknownIsComplete = true) {
  const complete =
    isCompleteContribution(composer, unknownIsComplete) &&
    isCompleteContribution(store, unknownIsComplete);
  const reasonCodes = new Set([
    ...(composer.resolution?.reasonCodes ?? []),
    ...(store.resolution?.reasonCodes ?? []),
  ]);
  if (!complete && reasonCodes.size === 0) reasonCodes.add('source-partial' as const);
  return {
    state: complete ? ('complete' as const) : ('partial' as const),
    expectedSourceRoles: ['composer', 'store'] as const,
    loadedSourceRoles: ['composer', 'store'] as const,
    omittedSourceRoles: [] as const,
    failedSourceRoles: [] as const,
    reasonCodes: [...reasonCodes],
  };
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
  index: number,
  faults?: MergeFaultInjection
): ChatSession {
  const backbone = preferredSource === 'composer' ? composer : store;
  const other = preferredSource === 'composer' ? store : composer;
  const rawPlan =
    faults?.preferredBackbonePairing && preferredSource === 'store'
      ? (() => {
          const reversed = computeAlignment(store.messages, composer.messages);
          return {
            composer: composer.messages,
            store: store.messages,
            pairs: reversed.pairs.map((pair) => ({
              composerIndex: pair.storeIndex,
              storeIndex: pair.composerIndex,
            })),
          };
        })()
      : computeAlignment(composer.messages, store.messages);
  const resolved = resolveMessageIdentities(composer.messages, store.messages, rawPlan.pairs);
  const plan: AlignmentPlan = { ...rawPlan, ...resolved };
  const rendered = renderAlignment(plan, preferredSource, faults);
  const identityMaps = buildSourceIdentityMaps(
    composer.messages,
    store.messages,
    resolved.composer,
    resolved.store
  );
  rewriteRenderedRelationships(
    rendered,
    composer.messages,
    store.messages,
    identityMaps,
    preferredSource
  );
  const activeBranchMessageIds = rewriteActiveBranch(composer, rendered, identityMaps.composer);
  rebuildActiveBranchParents(rendered, activeBranchMessageIds);
  const messages = rendered.map(({ message }) => message);
  const resolution = mergedResolution(composer, store);

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
    // `source` remains the v0.16 replacement-safety signal. Actual provenance
    // is additive so unchanged incremental consumers can replace complete data.
    source: resolution.state === 'complete' ? 'global' : 'workspace-fallback',
    resolvedSource: 'merged',
    sources: ['composer', 'store'],
    preferredSource,
    resolution: {
      ...resolution,
      expectedSourceRoles: [...resolution.expectedSourceRoles],
      loadedSourceRoles: [...resolution.loadedSourceRoles],
      omittedSourceRoles: [...resolution.omittedSourceRoles],
      failedSourceRoles: [...resolution.failedSourceRoles],
    },
    messageIdentityVersion: MESSAGE_IDENTITY_VERSION,
    transcriptState: store.transcriptState,
  };
  if (usage) session.usage = usage;
  if (activeBranchMessageIds !== undefined) {
    session.activeBranchMessageIds = activeBranchMessageIds;
    session.activeBranchBubbleIds = [...activeBranchMessageIds];
  }
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
  source?: ChatSession['source'];
  resolution?: ChatSession['resolution'];
  transcriptState: ChatSessionSummary['transcriptState'];
}

/**
 * Merge Store-side summary fields into an existing (Composer) summary in place.
 * Legacy `source` reports conservative replacement safety while
 * `resolvedSource` records merged provenance. Used by `listSessions` so a
 * session visible in both stacks appears once with merged scalar metadata; the
 * real message merge happens in `getSession` via `mergeCrossStackSessions`.
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

  // Listings that predate fidelity metadata must not claim replacement safety;
  // full hydration will later promote a genuinely complete resolved session.
  const resolution = mergedResolution(existing, store, false);
  existing.source = resolution.state === 'complete' ? 'global' : 'workspace-fallback';
  existing.resolvedSource = 'merged';
  existing.sources = ['composer', 'store'];
  existing.preferredSource = preferredSource;
  existing.resolutionState = resolution.state;
  existing.resolution = {
    ...resolution,
    expectedSourceRoles: [...resolution.expectedSourceRoles],
    loadedSourceRoles: [...resolution.loadedSourceRoles],
    omittedSourceRoles: [...resolution.omittedSourceRoles],
    failedSourceRoles: [...resolution.failedSourceRoles],
  };
  existing.messageIdentityVersion = MESSAGE_IDENTITY_VERSION;
  existing.transcriptState = store.transcriptState;
}
