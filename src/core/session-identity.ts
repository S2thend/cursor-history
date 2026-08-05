/**
 * Pure, source-independent identity primitives for Composer/Store resolution.
 *
 * This module deliberately performs no filesystem, database, network, clock, or
 * environment access. Parsers retain source-native evidence and pass it here;
 * presentation order and later enrichment therefore cannot alter identity.
 */
import { createHash } from 'node:crypto';
import type { MessageIdentityOrigin, ToolIdentityOrigin } from './types.js';

export type { MessageIdentityOrigin, ToolIdentityOrigin } from './types.js';

export const MESSAGE_IDENTITY_VERSION = 1 as const;
export const REPLICA_EQUIVALENCE_VERSION = 1 as const;

export interface StableMessageIdentity {
  value: string;
  version: typeof MESSAGE_IDENTITY_VERSION;
  origin: MessageIdentityOrigin;
  sourceOrdinal: number;
  baseFingerprint?: string;
  occurrence?: number;
  collisionOrdinal?: number;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function unsupportedCanonicalValue(value: unknown): never {
  const type = value === null ? 'null' : typeof value;
  throw new TypeError(`Unsupported canonical JSON value of type ${type}`);
}

function canonicalize(value: unknown, ancestors: Set<object>, arrayElement: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (value === undefined) {
    if (arrayElement) return 'null';
    return unsupportedCanonicalValue(value);
  }
  if (typeof value !== 'object') return unsupportedCanonicalValue(value);

  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON cannot contain a circular reference');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const elements: string[] = [];
      for (let index = 0; index < value.length; index++) {
        elements.push(canonicalize(value[index], ancestors, true));
      }
      return `[${elements.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupportedCanonicalValue(value);
    }

    const object = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(object).sort(compareCodePoints)) {
      const member = object[key];
      if (member === undefined) continue;
      members.push(`${JSON.stringify(key)}:${canonicalize(member, ancestors, false)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonical JSON v1 used by every synthetic identity hash. */
export function canonicalJsonV1(value: unknown): string {
  return canonicalize(value, new Set<object>(), false);
}

/** Full lowercase SHA-256 of UTF-8 canonical JSON v1. */
export function sha256CanonicalJsonV1(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value), 'utf8').digest('hex');
}

export interface ComposerMessageInput {
  id?: string | null;
  [key: string]: unknown;
}

export type ProjectedComposerMessage<T extends ComposerMessageInput = ComposerMessageInput> = T & {
  id: string;
  messageIdentityVersion: typeof MESSAGE_IDENTITY_VERSION;
  identityOrigin: 'composer-native' | 'composer-v0.16-index';
  sourceOrdinal: number;
};

/**
 * Freeze Composer identities against the final Composer-only sequence produced
 * by the released v0.16 projector, before any Store alignment or insertion.
 */
export function projectV016ComposerMessages<T extends ComposerMessageInput>(
  messages: readonly T[]
): Array<ProjectedComposerMessage<T>> {
  return messages.map((message, sourceOrdinal) => {
    const hasNativeId = typeof message.id === 'string' && message.id.length > 0;
    return {
      ...message,
      id: hasNativeId ? message.id! : `msg:${sourceOrdinal}`,
      messageIdentityVersion: MESSAGE_IDENTITY_VERSION,
      identityOrigin: hasNativeId ? 'composer-native' : 'composer-v0.16-index',
      sourceOrdinal,
    };
  });
}

interface StoreIdentityRecordBase {
  [key: string]: unknown;
}

export interface StoreDbMessageRecord extends StoreIdentityRecordBase {
  representation: 'db';
  leafHash: string;
}

export interface TranscriptMessageRecord extends StoreIdentityRecordBase {
  representation: 'transcript';
  role: string;
  content: string;
  toolActivity?: readonly unknown[];
  sourceRelationships?: unknown;
}

export type StoreIdentityRecord = StoreDbMessageRecord | TranscriptMessageRecord;

export interface StoreIdentityCandidate<T extends StoreIdentityRecord = StoreIdentityRecord> {
  record: T;
  representation: T['representation'];
  sourceOrdinal: number;
  baseFingerprint: string;
  occurrence: number;
  candidateId: string;
  identityOrigin: 'store-db-v1' | 'store-transcript-v1';
}

function normalizeLeafHash(hash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new TypeError('Store DB leaf hash must contain exactly 64 hexadecimal characters');
  }
  return hash.toLowerCase();
}

/** Compute Store candidates and equal-fingerprint occurrences in native order. */
export function prepareStoreIdentityCandidates<T extends StoreIdentityRecord>(
  records: readonly T[]
): Array<StoreIdentityCandidate<T>> {
  const occurrences = new Map<string, number>();
  return records.map((record, sourceOrdinal) => {
    const dbRecord = record.representation === 'db';
    const baseFingerprint = dbRecord
      ? normalizeLeafHash(record.leafHash)
      : sha256CanonicalJsonV1({
          role: record.role,
          content: record.content,
          toolActivity: record.toolActivity ?? [],
          sourceRelationships: record.sourceRelationships ?? [],
        });
    const occurrenceKey = `${record.representation}\0${baseFingerprint}`;
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const identityOrigin = dbRecord ? 'store-db-v1' : 'store-transcript-v1';
    const namespace = dbRecord ? 'db' : 'transcript';
    return {
      record,
      representation: record.representation,
      sourceOrdinal,
      baseFingerprint,
      occurrence,
      candidateId: `store:v1:${namespace}:${baseFingerprint}:${occurrence}`,
      identityOrigin,
    } as StoreIdentityCandidate<T>;
  });
}

export interface AllocatedStoreMessageIdentity<
  T extends StoreIdentityRecord = StoreIdentityRecord,
> {
  candidate: StoreIdentityCandidate<T>;
  identity: StableMessageIdentity;
  matchedComposerId?: string;
}

/**
 * Allocate only unmatched Store identities. Matched Store messages always
 * inherit the frozen Composer identity; Store collisions never rewrite it.
 */
export function allocateStoreMessageIdentities<
  C extends ComposerMessageInput,
  S extends StoreIdentityRecord,
>(
  composerMessages: readonly ProjectedComposerMessage<C>[],
  storeCandidates: readonly StoreIdentityCandidate<S>[],
  matchedComposerOrdinalByStoreOrdinal: ReadonlyMap<number, number> = new Map()
): Array<AllocatedStoreMessageIdentity<S>> {
  const matchedComposerOrdinals = new Set<number>();
  for (const [storeOrdinal, composerOrdinal] of matchedComposerOrdinalByStoreOrdinal) {
    if (
      !Number.isSafeInteger(storeOrdinal) ||
      storeOrdinal < 0 ||
      storeOrdinal >= storeCandidates.length
    ) {
      throw new RangeError(`Matched Store ordinal ${storeOrdinal} is out of range`);
    }
    if (
      !Number.isSafeInteger(composerOrdinal) ||
      composerOrdinal < 0 ||
      composerOrdinal >= composerMessages.length
    ) {
      throw new RangeError(`Matched Composer ordinal ${composerOrdinal} is out of range`);
    }
    if (matchedComposerOrdinals.has(composerOrdinal)) {
      throw new TypeError(`Composer ordinal ${composerOrdinal} was matched more than once`);
    }
    matchedComposerOrdinals.add(composerOrdinal);
  }

  const used = new Set(composerMessages.map((message) => message.id));
  return storeCandidates.map((candidate) => {
    const matchedComposerOrdinal = matchedComposerOrdinalByStoreOrdinal.get(
      candidate.sourceOrdinal
    );
    if (matchedComposerOrdinal !== undefined) {
      const composer = composerMessages[matchedComposerOrdinal]!;
      return {
        candidate,
        matchedComposerId: composer.id,
        identity: {
          value: composer.id,
          version: MESSAGE_IDENTITY_VERSION,
          origin: composer.identityOrigin,
          sourceOrdinal: composer.sourceOrdinal,
        },
      };
    }

    let value = candidate.candidateId;
    let collisionOrdinal: number | undefined;
    if (used.has(value)) {
      collisionOrdinal = 1;
      while (used.has(`${candidate.candidateId}:collision:${collisionOrdinal}`)) {
        collisionOrdinal++;
      }
      value = `${candidate.candidateId}:collision:${collisionOrdinal}`;
    }
    used.add(value);
    const identity: StableMessageIdentity = {
      value,
      version: MESSAGE_IDENTITY_VERSION,
      origin: candidate.identityOrigin,
      sourceOrdinal: candidate.sourceOrdinal,
      baseFingerprint: candidate.baseFingerprint,
      occurrence: candidate.occurrence,
    };
    if (collisionOrdinal !== undefined) identity.collisionOrdinal = collisionOrdinal;
    return { candidate, identity };
  });
}

export interface ToolIdentityInput {
  id?: string | null;
  name: string;
  params?: unknown;
  files?: readonly string[];
  sourceRelationships?: unknown;
  [key: string]: unknown;
}

export interface ToolCallMatch {
  composerIndex: number;
  storeIndex: number;
  pass: 'native-id' | 'canonical-params' | 'missing-params';
}

export interface ToolCallAlignment {
  pairs: ToolCallMatch[];
  unmatchedComposerIndices: number[];
  unmatchedStoreIndices: number[];
}

function hasNativeToolId(call: ToolIdentityInput): call is ToolIdentityInput & { id: string } {
  return typeof call.id === 'string' && call.id.length > 0;
}

function hasParams(call: ToolIdentityInput): boolean {
  return call.params !== undefined && call.params !== null;
}

/** Fixed Composer-to-Store, stable one-to-one tool matching. */
export function matchAlignedToolCalls(
  composer: readonly ToolIdentityInput[],
  store: readonly ToolIdentityInput[]
): ToolCallAlignment {
  const usedComposer = new Set<number>();
  const usedStore = new Set<number>();
  const pairs: ToolCallMatch[] = [];

  const runPass = (
    pass: ToolCallMatch['pass'],
    matches: (composerCall: ToolIdentityInput, storeCall: ToolIdentityInput) => boolean
  ): void => {
    for (let composerIndex = 0; composerIndex < composer.length; composerIndex++) {
      if (usedComposer.has(composerIndex)) continue;
      const composerCall = composer[composerIndex]!;
      for (let storeIndex = 0; storeIndex < store.length; storeIndex++) {
        if (usedStore.has(storeIndex)) continue;
        const storeCall = store[storeIndex]!;
        if (!matches(composerCall, storeCall)) continue;
        usedComposer.add(composerIndex);
        usedStore.add(storeIndex);
        pairs.push({ composerIndex, storeIndex, pass });
        break;
      }
    }
  };

  runPass(
    'native-id',
    (composerCall, storeCall) =>
      composerCall.name === storeCall.name &&
      hasNativeToolId(composerCall) &&
      hasNativeToolId(storeCall) &&
      composerCall.id === storeCall.id
  );
  runPass(
    'canonical-params',
    (composerCall, storeCall) =>
      composerCall.name === storeCall.name &&
      hasParams(composerCall) &&
      hasParams(storeCall) &&
      canonicalJsonV1(composerCall.params) === canonicalJsonV1(storeCall.params)
  );
  runPass(
    'missing-params',
    (composerCall, storeCall) =>
      composerCall.name === storeCall.name && (!hasParams(composerCall) || !hasParams(storeCall))
  );

  return {
    pairs,
    unmatchedComposerIndices: composer
      .map((_, index) => index)
      .filter((index) => !usedComposer.has(index)),
    unmatchedStoreIndices: store.map((_, index) => index).filter((index) => !usedStore.has(index)),
  };
}

export interface AllocatedToolCallIdentity<T extends ToolIdentityInput = ToolIdentityInput> {
  call: T;
  id: string;
  identityOrigin: ToolIdentityOrigin;
  sourceOrdinal: number;
  baseFingerprint?: string;
  occurrence?: number;
}

/** Allocate modern tool IDs without using status/result/error enrichment. */
export function allocateToolCallIdentities<T extends ToolIdentityInput>(
  stableMessageId: string,
  calls: readonly T[]
): Array<AllocatedToolCallIdentity<T>> {
  if (stableMessageId.length === 0) {
    throw new TypeError('Stable message identity must be nonempty');
  }
  const occurrences = new Map<string, number>();
  return calls.map((call, sourceOrdinal) => {
    if (hasNativeToolId(call)) {
      return {
        call,
        id: call.id,
        identityOrigin: 'source-native',
        sourceOrdinal,
      };
    }

    const canonicalInput: Record<string, unknown> = { name: call.name };
    if (hasParams(call)) canonicalInput['params'] = call.params;
    if (call.files !== undefined) canonicalInput['files'] = [...call.files];
    if (call.sourceRelationships !== undefined) {
      canonicalInput['sourceRelationships'] = call.sourceRelationships;
    }
    const baseFingerprint = sha256CanonicalJsonV1(canonicalInput);
    const occurrence = (occurrences.get(baseFingerprint) ?? 0) + 1;
    occurrences.set(baseFingerprint, occurrence);
    return {
      call,
      id: `tool:v1:${stableMessageId}:${baseFingerprint}:${occurrence}`,
      identityOrigin: 'tool-v1',
      sourceOrdinal,
      baseFingerprint,
      occurrence,
    };
  });
}

export interface SourceRelationshipReferences {
  parentId?: string;
  branchIds?: readonly string[];
  leafId?: string;
  sidechainIds?: readonly string[];
}

export interface ResolvedRelationshipReferences {
  parentMessageId?: string;
  branchMessageIds?: string[];
  leafMessageId?: string;
  sidechainMessageIds?: string[];
  unresolvedSourceIds: string[];
}

/** Rewrite only explicitly supplied source relationships through stable IDs. */
export function rewriteRelationshipReferences(
  relationships: SourceRelationshipReferences,
  identityBySourceId: ReadonlyMap<string, string>
): ResolvedRelationshipReferences {
  const unresolved: string[] = [];
  const unresolvedSet = new Set<string>();
  const resolve = (sourceId: string): string | undefined => {
    const resolved = identityBySourceId.get(sourceId);
    if (resolved !== undefined && resolved.length > 0) return resolved;
    if (!unresolvedSet.has(sourceId)) {
      unresolvedSet.add(sourceId);
      unresolved.push(sourceId);
    }
    return undefined;
  };
  const resolveMany = (sourceIds: readonly string[] | undefined): string[] | undefined => {
    if (sourceIds === undefined) return undefined;
    return sourceIds.flatMap((sourceId) => {
      const resolved = resolve(sourceId);
      return resolved === undefined ? [] : [resolved];
    });
  };

  const rewritten: ResolvedRelationshipReferences = { unresolvedSourceIds: unresolved };
  if (relationships.parentId !== undefined) {
    const parentMessageId = resolve(relationships.parentId);
    if (parentMessageId !== undefined) rewritten.parentMessageId = parentMessageId;
  }
  const branchMessageIds = resolveMany(relationships.branchIds);
  if (branchMessageIds !== undefined) rewritten.branchMessageIds = branchMessageIds;
  if (relationships.leafId !== undefined) {
    const leafMessageId = resolve(relationships.leafId);
    if (leafMessageId !== undefined) rewritten.leafMessageId = leafMessageId;
  }
  const sidechainMessageIds = resolveMany(relationships.sidechainIds);
  if (sidechainMessageIds !== undefined) rewritten.sidechainMessageIds = sidechainMessageIds;
  return rewritten;
}

/** Design-contract alias used by the later merge integration. */
export const rewriteResolvedRelationships = rewriteRelationshipReferences;
