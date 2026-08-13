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
import type {
  ChatSession,
  ChatSessionSummary,
  Message,
  ResolutionReasonCode,
  SessionResolution,
  SessionSourceInstance,
  SourceRole,
  ToolCall,
  WorkspaceMembership,
} from '../types.js';
import { findEmbeddedToolCallIndex } from '../parser.js';
import {
  isValidTimestamp,
  resolveMessageTimestamps,
  resolveSessionTimestamps,
} from '../timestamps.js';
import {
  renderInlineAttachmentProjections,
  splitInlineAttachmentProjections,
} from './content-evidence.js';
import {
  allocateStoreMessageIdentities,
  allocateToolCallIdentities,
  matchAlignedToolCalls,
  MESSAGE_IDENTITY_VERSION,
  prepareStoreIdentityCandidates,
  projectV016ComposerMessages,
  type StoreIdentityCandidate,
  type StoreIdentityRecord,
} from '../session-identity.js';

/** Sentinel content produced by the storage layer for a present-but-empty bubble. */
const EMPTY_PLACEHOLDER = '[empty message]';
/** Sentinel content produced by the storage layer for an unparseable bubble. */
const CORRUPTED_PLACEHOLDER = '[corrupted message]';

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
  const projected = splitInlineAttachmentProjections(text);
  const base = normalizeText(unwrapUserQuery(projected.baseContent));
  if (base.length > 0) return base;
  if (projected.encodedAttachments.length > 0) {
    return JSON.stringify(['attachments', projected.encodedAttachments]);
  }
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

/** Deterministic work counters used by alignment complexity regression tests. */
export interface LcsAlignmentWork {
  cellEvaluations: number;
  checkpointRows: number;
  peakRetainedRows: number;
}

/** Fill one exact suffix-LCS row from the already-computed row below it. */
function fillLcsSuffixRow(
  aKey: string,
  b: readonly string[],
  next: Uint32Array,
  work?: LcsAlignmentWork
): Uint32Array {
  const current = new Uint32Array(b.length + 1);
  for (let bIndex = b.length - 1; bIndex >= 0; bIndex--) {
    if (work) work.cellEvaluations++;
    current[bIndex] =
      aKey === b[bIndex] ? next[bIndex + 1]! + 1 : Math.max(next[bIndex]!, current[bIndex + 1]!);
  }
  return current;
}

/**
 * Phase-1 anchor pairs with the exact legacy DP tie contract.
 *
 * The legacy implementation matched an equal current cell immediately and, on
 * a mismatch with equal remaining LCS lengths, advanced Composer. A plain
 * Hirschberg split can choose a different duplicate occurrence, so it is not a
 * safe replacement for identity-bearing alignment.
 *
 * Instead, this implementation computes exact suffix rows once while retaining
 * only square-root-spaced checkpoints. It then reconstructs one checkpoint
 * block at a time using the same DP cells and the same branch order as the
 * legacy full matrix. Every cell is evaluated at most twice: once to establish
 * checkpoints and once while reconstructing its block. Runtime is therefore
 * O(a.length * b.length), with O(b.length * sqrt(a.length)) retained cells
 * rather than a quadratic matrix. No input-size threshold changes semantics.
 *
 * @internal Exported so deterministic equivalence and work-bound tests exercise
 * the production implementation directly.
 */
export function exactLcsAnchorPairs(
  a: readonly string[],
  b: readonly string[],
  work?: LcsAlignmentWork
): Array<[number, number]> {
  if (work) {
    work.cellEvaluations = 0;
    work.checkpointRows = 0;
    work.peakRetainedRows = 0;
  }
  if (a.length === 0 || b.length === 0) return [];

  const blockSize = Math.max(1, Math.ceil(Math.sqrt(a.length)));
  const checkpoints = new Map<number, Uint32Array>();
  let next: Uint32Array = new Uint32Array(b.length + 1);
  checkpoints.set(a.length, next);

  for (let aIndex = a.length - 1; aIndex >= 0; aIndex--) {
    const current = fillLcsSuffixRow(a[aIndex]!, b, next, work);
    if (aIndex % blockSize === 0) checkpoints.set(aIndex, current);
    next = current;
  }

  if (work) {
    work.checkpointRows = checkpoints.size;
    work.peakRetainedRows = checkpoints.size + 2;
  }

  const pairs: Array<[number, number]> = [];
  let aCursor = 0;
  let bCursor = 0;
  while (aCursor < a.length && bCursor < b.length) {
    const blockStart = aCursor;
    const blockEnd = Math.min(a.length, Math.floor(blockStart / blockSize + 1) * blockSize);
    const boundary = checkpoints.get(blockEnd);
    if (!boundary) {
      throw new Error(`Missing LCS checkpoint at Composer row ${blockEnd}`);
    }

    const rows = new Array<Uint32Array>(blockEnd - blockStart + 1);
    rows[blockEnd - blockStart] = boundary;
    let blockNext = boundary;
    for (let aIndex = blockEnd - 1; aIndex >= blockStart; aIndex--) {
      const current = fillLcsSuffixRow(a[aIndex]!, b, blockNext, work);
      rows[aIndex - blockStart] = current;
      blockNext = current;
    }
    if (work) {
      work.peakRetainedRows = Math.max(work.peakRetainedRows, checkpoints.size + rows.length);
    }

    while (aCursor < blockEnd && bCursor < b.length) {
      const current = rows[aCursor - blockStart]!;
      if (current[bCursor] === 0) return pairs;
      if (a[aCursor] === b[bCursor]) {
        pairs.push([aCursor, bCursor]);
        aCursor++;
        bCursor++;
        continue;
      }
      const skipComposer = rows[aCursor - blockStart + 1]![bCursor]!;
      const skipStore = current[bCursor + 1]!;
      if (skipComposer >= skipStore) aCursor++;
      else bCursor++;
    }
  }
  return pairs;
}

/**
 * Linear monotonic anchor helper retained for callers that explicitly need a
 * best-effort greedy plan. Production merge alignment always uses the exact
 * checkpointed LCS above. Weak messages never match across sides.
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
    const aProjected = splitInlineAttachmentProjections(a);
    const bProjected = splitInlineAttachmentProjections(b);
    const aBase = normalizeText(unwrapUserQuery(aProjected.baseContent));
    const bBase = normalizeText(unwrapUserQuery(bProjected.baseContent));
    if (aBase.length > 0 || bBase.length > 0) {
      return aBase.length > 0 && aBase === bBase;
    }
    if (aProjected.encodedAttachments.length > 0 && bProjected.encodedAttachments.length > 0) {
      const bAttachments = new Set(bProjected.encodedAttachments);
      return aProjected.encodedAttachments.some((attachment) => bAttachments.has(attachment));
    }
    return matchContent(a) === matchContent(b);
  }
  return true; // empty involved (but no corrupt) -> fillable
}

/**
 * Merge attachment enrichment only when the pair has a content bridge. The
 * projection sequence is always Composer then Store, independent of the
 * rendering backbone, while exact base formatting still follows the preferred
 * source like other scalar content.
 */
function mergeProjectedAttachmentContent(
  composerContent: string,
  storeContent: string,
  preferredSource: 'composer' | 'store'
): string | null {
  const composer = splitInlineAttachmentProjections(composerContent);
  const store = splitInlineAttachmentProjections(storeContent);
  if (composer.encodedAttachments.length === 0 && store.encodedAttachments.length === 0) {
    return null;
  }

  const composerBase = normalizeText(unwrapUserQuery(composer.baseContent));
  const storeBase = normalizeText(unwrapUserQuery(store.baseContent));
  const sameNonemptyBase = composerBase.length > 0 && composerBase === storeBase;
  const sharedAttachment = composer.encodedAttachments.some((attachment) =>
    store.encodedAttachments.includes(attachment)
  );
  const oneSideMissing = contentMissing(composerContent) || contentMissing(storeContent);
  if (!sameNonemptyBase && !sharedAttachment && !oneSideMissing) return null;

  const preferred = preferredSource === 'composer' ? composer : store;
  const other = preferredSource === 'composer' ? store : composer;
  const baseContent =
    normalizeText(preferred.baseContent).length > 0 ? preferred.baseContent : other.baseContent;
  const encodedAttachments = [
    ...composer.encodedAttachments,
    ...store.encodedAttachments.filter(
      (attachment) => !composer.encodedAttachments.includes(attachment)
    ),
  ];
  return renderInlineAttachmentProjections(baseContent, encodedAttachments);
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
  if (toolsConflict(aTools, bTools)) return false;
  // Real compatible content is an anchor; distinct tool arrays are additive
  // enrichment. When both contents are blank, however, tools are the only
  // identity evidence and disjoint calls must remain separate turns.
  if (contentCompatible(a.content, b.content)) {
    if (
      !hasRealContent(a.content) &&
      !hasRealContent(b.content) &&
      aTools.length > 0 &&
      bTools.length > 0 &&
      !hasCompatibleToolPair(aTools, bTools)
    ) {
      return false;
    }
    return true;
  }
  // Composer can render a structured tool call as `[Tool: ...]` while Store
  // keeps the assistant's natural-language text plus the same structured call.
  // The compatible tool signature is the identity bridge in that case.
  return (
    (isSyntheticToolContent(a) || isSyntheticToolContent(b)) &&
    aTools.length > 0 &&
    bTools.length > 0 &&
    hasCompatibleToolPair(aTools, bTools)
  );
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
  const projectedAttachmentContent = mergeProjectedAttachmentContent(
    composer.content,
    store.content,
    preferredSource
  );
  if (projectedAttachmentContent !== null) merged.content = projectedAttachmentContent;

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

  // Timestamp selection is permanently Composer-to-Store oriented. Preserve a
  // legacy Composer value byte-for-byte even when its provenance is unknown;
  // otherwise enrich from Store. Inferred values are recomputed after the full
  // semantic order is rendered and therefore cannot become merge anchors.
  const selectedTimestamp = isValidTimestamp(composer.timestamp)
    ? composer
    : isValidTimestamp(store.timestamp)
      ? store
      : undefined;
  if (selectedTimestamp) {
    merged.timestamp = selectedTimestamp.timestamp;
    merged.timestampSource = selectedTimestamp.timestampSource;
  } else {
    delete merged.timestamp;
    delete merged.timestampSource;
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
  const anchors = exactLcsAnchorPairs(composerKeys, storeKeys);

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

const SOURCE_ROLE_ORDER = ['composer', 'store'] as const;
const SOURCE_REPRESENTATION_ORDER = [
  'composer-global',
  'composer-workspace',
  'store-db',
  'store-transcript',
  'store-metadata',
] as const;
const SOURCE_INSTANCE_STATE_ORDER = [
  'contributed',
  'equivalent-replica',
  'omitted-by-scope',
  'failed',
  'superseded',
] as const;

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareCodePoints(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

/** Canonicalize safe occurrence provenance without exposing private locators. */
function mergeSourceInstances(
  composer: ChatSession | ChatSessionSummary,
  store: ChatSession | StoreSummaryInput
): SessionSourceInstance[] | undefined {
  const instances = [...(composer.sourceInstances ?? []), ...(store.sourceInstances ?? [])].map(
    (instance) => ({
      ...instance,
      workspacePaths: [...instance.workspacePaths].sort(compareCodePoints),
    })
  );
  if (instances.length === 0) return undefined;
  return instances.sort((left, right) => {
    const byRole =
      SOURCE_ROLE_ORDER.indexOf(left.sourceRole) - SOURCE_ROLE_ORDER.indexOf(right.sourceRole);
    if (byRole !== 0) return byRole;
    const byRepresentation =
      SOURCE_REPRESENTATION_ORDER.indexOf(left.representation) -
      SOURCE_REPRESENTATION_ORDER.indexOf(right.representation);
    if (byRepresentation !== 0) return byRepresentation;
    const byPaths = compareStringArrays(left.workspacePaths, right.workspacePaths);
    if (byPaths !== 0) return byPaths;
    return (
      SOURCE_INSTANCE_STATE_ORDER.indexOf(left.state) -
      SOURCE_INSTANCE_STATE_ORDER.indexOf(right.state)
    );
  });
}

/** Merge public membership metadata by normalized path and declared role order. */
function mergeWorkspaceMemberships(
  composer: ChatSession | ChatSessionSummary,
  store: ChatSession | StoreSummaryInput,
  sourceInstances: readonly SessionSourceInstance[] | undefined
): WorkspaceMembership[] | undefined {
  const memberships = new Map<
    string,
    {
      roles: Set<'composer' | 'store'>;
      explicitCount: number;
      instanceCount: number;
    }
  >();
  const add = (membership: WorkspaceMembership): void => {
    const current = memberships.get(membership.workspacePath) ?? {
      roles: new Set<'composer' | 'store'>(),
      explicitCount: 0,
      instanceCount: 0,
    };
    for (const role of membership.sourceRoles) current.roles.add(role);
    current.explicitCount += membership.contributingInstanceCount;
    memberships.set(membership.workspacePath, current);
  };
  for (const membership of composer.workspaceMemberships ?? []) add(membership);
  for (const membership of store.workspaceMemberships ?? []) add(membership);

  // Source instances can disclose a path absent from one side's explicit
  // membership projection. Always union their roles and paths, but an explicit
  // membership count is authoritative: one physical Store occurrence may have
  // metadata, DB, and transcript provenance entries, which must not inflate
  // the occurrence count merely because several representations describe it.
  for (const instance of sourceInstances ?? []) {
    for (const workspacePath of instance.workspacePaths) {
      const current = memberships.get(workspacePath) ?? {
        roles: new Set<'composer' | 'store'>(),
        explicitCount: 0,
        instanceCount: 0,
      };
      current.roles.add(instance.sourceRole);
      current.instanceCount++;
      memberships.set(workspacePath, current);
    }
  }
  if (memberships.size === 0) return undefined;
  return [...memberships.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([workspacePath, value]) => ({
      workspacePath,
      sourceRoles: [...value.roles].sort(
        (left, right) => SOURCE_ROLE_ORDER.indexOf(left) - SOURCE_ROLE_ORDER.indexOf(right)
      ),
      contributingInstanceCount:
        value.explicitCount > 0 ? value.explicitCount : value.instanceCount,
    }));
}

/** Freeze the exact Composer-only array before Store messages can affect it. */
function freezeComposerMessages(messages: Message[]): Message[] {
  return projectV016ComposerMessages(messages).map((projected) => {
    const message = { ...projected } as Message & { sourceOrdinal?: number };
    delete message.sourceOrdinal;
    if (message.toolCalls?.length) {
      message.toolCalls = allocateToolCallIdentities(
        message.id!,
        message.toolCalls,
        'composer'
      ).map(({ call, id, identityOrigin }) => ({ ...call, id, identityOrigin }));
    }
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

const STORE_MESSAGE_ID_PATTERN =
  /^store:v1:(db|transcript):([0-9a-f]{64}):([1-9][0-9]*)(?::collision:[1-9][0-9]*)?$/;

/** Preserve source-native DB/transcript candidates allocated before mapping. */
function storeIdentityCandidates(
  messages: Message[]
): Array<StoreIdentityCandidate<StoreIdentityRecord>> {
  const fallback = prepareStoreIdentityCandidates(transcriptIdentityRecords(messages));
  return messages.map((message, sourceOrdinal) => {
    const match =
      typeof message.id === 'string' &&
      (message.identityOrigin === 'store-db-v1' || message.identityOrigin === 'store-transcript-v1')
        ? message.id.match(STORE_MESSAGE_ID_PATTERN)
        : null;
    if (!match?.[1] || !match[2] || !match[3]) return fallback[sourceOrdinal]!;
    const occurrence = Number(match[3]);
    if (!Number.isSafeInteger(occurrence)) return fallback[sourceOrdinal]!;
    const representation = match[1] === 'db' ? 'db' : 'transcript';
    const record: StoreIdentityRecord =
      representation === 'db'
        ? { representation: 'db', leafHash: match[2] }
        : transcriptIdentityRecords([message])[0]!;
    return {
      record,
      representation,
      sourceOrdinal,
      baseFingerprint: match[2],
      occurrence,
      candidateId: `store:v1:${match[1]}:${match[2]}:${occurrence}`,
      identityOrigin:
        representation === 'db' ? ('store-db-v1' as const) : ('store-transcript-v1' as const),
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
  const candidates = storeIdentityCandidates(storeMessages);
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
): boolean {
  let hasUnresolvedRelationship = false;
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
    let explicitParentPresent = false;
    let parentResolved = false;
    for (const [source, sourceMessage] of ordered) {
      if (sourceMessage?.parentMessageId === undefined) continue;
      explicitParentPresent = true;
      const parentMessageId = identityMaps[source].get(sourceMessage.parentMessageId);
      if (parentMessageId === undefined) continue;
      entry.message.parentMessageId = parentMessageId;
      parentResolved = true;
      break;
    }
    if (explicitParentPresent && !parentResolved) hasUnresolvedRelationship = true;

    delete entry.message.isSidechain;
    for (const [, sourceMessage] of ordered) {
      if (sourceMessage?.isSidechain === undefined) continue;
      entry.message.isSidechain = sourceMessage.isSidechain;
      break;
    }
  }
  return hasUnresolvedRelationship;
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
): { ids: string[] | undefined; unresolved: boolean } {
  const sourceBranch = composer.activeBranchBubbleIds ?? composer.activeBranchMessageIds;
  if (sourceBranch === undefined) return { ids: undefined, unresolved: false };
  let unresolved = false;
  const mapped = sourceBranch.flatMap((sourceId) => {
    const resolved = composerIdentityMap.get(sourceId);
    if (resolved !== undefined) return [resolved];
    unresolved = true;
    return [];
  });
  if (unresolved) return { ids: undefined, unresolved: true };
  if (mapped.length <= 1) return { ids: mapped, unresolved: false };

  const positions: number[] = [];
  let cursor = -1;
  for (const id of mapped) {
    const position = rendered.findIndex(
      (entry, index) =>
        index > cursor && entry.message.id === id && entry.composerIndex !== undefined
    );
    if (position < 0) {
      unresolved = true;
      continue;
    }
    positions.push(position);
    cursor = position;
  }
  if (unresolved) return { ids: undefined, unresolved: true };
  if (positions.length === 0) return { ids: [], unresolved: false };

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
  return { ids: branch, unresolved: false };
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

const RESOLUTION_REASON_ORDER = [
  'workspace-scope-omitted',
  'source-unavailable',
  'source-read-failed',
  'source-partial',
  'expected-store-db-unavailable',
  'store-db-expectation-unknown',
  'store-conversation-unavailable',
] as const satisfies readonly ResolutionReasonCode[];

function orderedResolutionReasons(reasons: Iterable<ResolutionReasonCode>): ResolutionReasonCode[] {
  const values = new Set(reasons);
  return RESOLUTION_REASON_ORDER.filter((reason) => values.has(reason));
}

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

function mergedResolution(
  composer: FidelityInput,
  store: FidelityInput,
  unknownIsComplete = true,
  relationshipPartial = false
) {
  const complete =
    isCompleteContribution(composer, unknownIsComplete) &&
    isCompleteContribution(store, unknownIsComplete) &&
    !relationshipPartial;
  const reasonCodes = new Set<ResolutionReasonCode>([
    ...(composer.resolution?.reasonCodes ?? []),
    ...(store.resolution?.reasonCodes ?? []),
  ]);
  if (relationshipPartial) reasonCodes.add('source-partial');
  if (!complete && reasonCodes.size === 0) reasonCodes.add('source-partial' as const);
  const orderedRoles = (roles: Iterable<SourceRole>): SourceRole[] => {
    const values = new Set(roles);
    return (['composer', 'store'] as const).filter((role) => values.has(role));
  };
  const rolesFrom = (
    session: FidelityInput,
    field: keyof Pick<
      SessionResolution,
      'expectedSourceRoles' | 'loadedSourceRoles' | 'omittedSourceRoles' | 'failedSourceRoles'
    >,
    fallback: SourceRole
  ): readonly SourceRole[] =>
    session.resolution?.[field] ?? (field === 'loadedSourceRoles' ? [fallback] : []);
  return {
    state: complete ? ('complete' as const) : ('partial' as const),
    expectedSourceRoles: orderedRoles([
      'composer',
      'store',
      ...rolesFrom(composer, 'expectedSourceRoles', 'composer'),
      ...rolesFrom(store, 'expectedSourceRoles', 'store'),
    ]),
    loadedSourceRoles: orderedRoles([
      ...rolesFrom(composer, 'loadedSourceRoles', 'composer'),
      ...rolesFrom(store, 'loadedSourceRoles', 'store'),
    ]),
    omittedSourceRoles: orderedRoles([
      ...rolesFrom(composer, 'omittedSourceRoles', 'composer'),
      ...rolesFrom(store, 'omittedSourceRoles', 'store'),
    ]),
    failedSourceRoles: orderedRoles([
      ...rolesFrom(composer, 'failedSourceRoles', 'composer'),
      ...rolesFrom(store, 'failedSourceRoles', 'store'),
    ]),
    reasonCodes: orderedResolutionReasons(reasonCodes),
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
  const hasUnresolvedParent = rewriteRenderedRelationships(
    rendered,
    composer.messages,
    store.messages,
    identityMaps,
    preferredSource
  );
  const activeBranch = rewriteActiveBranch(composer, rendered, identityMaps.composer);
  const activeBranchMessageIds = activeBranch.ids;
  rebuildActiveBranchParents(rendered, activeBranchMessageIds);
  const messages = rendered.map(({ message }) => message);
  const relationshipPartial = hasUnresolvedParent || activeBranch.unresolved;
  const resolution = mergedResolution(composer, store, true, relationshipPartial);

  // A merged session is Composer-backed regardless of the rendering backbone.
  // Resolve clocks from source-native inputs in fixed Composer-then-Store order
  // so changing preferredSource cannot rewrite incremental-backup watermarks.
  const sessionTimestamps = resolveSessionTimestamps({
    view: 'composer-backed',
    composerMetadata: {
      ...(composer.createdAtSource === 'composer-metadata'
        ? { createdAt: composer.createdAt }
        : {}),
      ...(composer.lastUpdatedAtSource === 'composer-metadata'
        ? { lastUpdatedAt: composer.lastUpdatedAt }
        : {}),
    },
    directMessages: [...composer.messages, ...store.messages],
  });
  resolveMessageTimestamps(messages, {
    timestamp: sessionTimestamps.createdAt,
    source: sessionTimestamps.createdAtSource,
  });

  // Scalar presentation metadata may follow the preferred backbone, but
  // logical addressing never does: a Composer-backed session keeps its
  // Composer canonical path and workspace identity across both orientations.
  const title = pickScalar(backbone.title, other.title);
  const canonicalWorkspacePath =
    composer.canonicalWorkspacePath ?? composer.workspacePath ?? store.canonicalWorkspacePath;
  const workspacePath = canonicalWorkspacePath ?? store.workspacePath;
  const matchedWorkspacePath = composer.matchedWorkspacePath ?? store.matchedWorkspacePath;
  const sourceInstances = mergeSourceInstances(composer, store);
  const workspaceMemberships = mergeWorkspaceMemberships(composer, store, sourceInstances);

  // Source-specific structured data is additive: keep whichever side provides it
  // (Composer typically provides usage + activeBranchBubbleIds; Store may extend).
  const usage = backbone.usage ?? other.usage;
  const session: ChatSession = {
    id: composer.id,
    index,
    title,
    ...sessionTimestamps,
    messageCount: messages.length,
    messages,
    workspaceId: composer.workspaceId,
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
    ...(canonicalWorkspacePath ? { canonicalWorkspacePath } : {}),
    ...(matchedWorkspacePath ? { matchedWorkspacePath } : {}),
    ...((composer.workspaceMatchKind ?? store.workspaceMatchKind)
      ? { workspaceMatchKind: composer.workspaceMatchKind ?? store.workspaceMatchKind }
      : {}),
    ...(workspaceMemberships ? { workspaceMemberships } : {}),
    ...(sourceInstances ? { sourceInstances } : {}),
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
  createdAtSource?: ChatSessionSummary['createdAtSource'];
  /** Store session-level update time (`updatedAtMs` or `createdAt`). */
  lastUpdatedAt: Date;
  lastUpdatedAtSource?: ChatSessionSummary['lastUpdatedAtSource'];
  /** Source-native Store messages used only for direct-time extrema. */
  directMessages?: readonly Message[];
  workspacePath?: string;
  messageCount: number;
  source?: ChatSession['source'];
  resolution?: ChatSession['resolution'];
  transcriptState: ChatSessionSummary['transcriptState'];
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
  workspaceMatchKind?: ChatSessionSummary['workspaceMatchKind'];
  workspaceMemberships?: ChatSessionSummary['workspaceMemberships'];
  sourceInstances?: ChatSessionSummary['sourceInstances'];
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

  const canonicalWorkspacePath =
    existing.canonicalWorkspacePath ?? existing.workspacePath ?? store.canonicalWorkspacePath;
  existing.workspacePath = canonicalWorkspacePath ?? store.workspacePath ?? existing.workspacePath;
  if (canonicalWorkspacePath) existing.canonicalWorkspacePath = canonicalWorkspacePath;
  existing.matchedWorkspacePath ??= store.matchedWorkspacePath;
  existing.workspaceMatchKind ??= store.workspaceMatchKind;
  const sourceInstances = mergeSourceInstances(existing, store);
  if (sourceInstances) existing.sourceInstances = sourceInstances;
  const workspaceMemberships = mergeWorkspaceMemberships(existing, store, sourceInstances);
  if (workspaceMemberships) existing.workspaceMemberships = workspaceMemberships;

  const composerDirectExtrema: Message[] = [];
  if (existing.createdAtSource === 'direct-message') {
    composerDirectExtrema.push({
      id: null,
      role: 'user',
      content: '',
      codeBlocks: [],
      timestamp: existing.createdAt,
      timestampSource: 'composer-timing',
    });
  }
  if (
    existing.lastUpdatedAtSource === 'direct-message' &&
    existing.lastUpdatedAt.getTime() !== existing.createdAt.getTime()
  ) {
    composerDirectExtrema.push({
      id: null,
      role: 'user',
      content: '',
      codeBlocks: [],
      timestamp: existing.lastUpdatedAt,
      timestampSource: 'composer-timing',
    });
  }
  const sessionTimestamps = resolveSessionTimestamps({
    view: 'composer-backed',
    composerMetadata: {
      ...(existing.createdAtSource === 'composer-metadata'
        ? { createdAt: existing.createdAt }
        : {}),
      ...(existing.lastUpdatedAtSource === 'composer-metadata'
        ? { lastUpdatedAt: existing.lastUpdatedAt }
        : {}),
    },
    directMessages: [...composerDirectExtrema, ...(store.directMessages ?? [])],
  });
  existing.createdAt = sessionTimestamps.createdAt;
  existing.createdAtSource = sessionTimestamps.createdAtSource;
  existing.lastUpdatedAt = sessionTimestamps.lastUpdatedAt;
  existing.lastUpdatedAtSource = sessionTimestamps.lastUpdatedAtSource;

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
