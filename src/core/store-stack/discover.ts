/**
 * Discover and resolve Cursor Store-stack sessions.
 *
 * Inventory fixes StoreDbExpectation before payload hydration. The exhaustive
 * DB/transcript/metadata state machine then selects one representation without
 * using message content, timestamps, or read failures to revise expectation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { SourceEncodingError, SourceLimitExceededError } from '../errors.js';
import { debugLogStorage } from '../database/debug.js';
import type { DriverName } from '../database/index.js';
import { observeAdapterIo, type OperationIoContext } from '../io-observer.js';
import { decodeDeterministicUtf8, resolveSourceReadLimits } from '../source-read-limits.js';
import { resolveSessionTimestamps } from '../timestamps.js';
import {
  buildSessionCatalog,
  reconcileReplicaGroup,
  sessionAmbiguityErrorFromReplicaGroup,
  type PhysicalSessionInstance,
  type ReplicaConsumedPayload,
} from '../session-catalog.js';
import {
  prepareStoreIdentityCandidates,
  sha256CanonicalJsonV1,
  type StoreIdentityRecord,
} from '../session-identity.js';
import type {
  Message,
  ResolutionReasonCode,
  SessionDiagnostic,
  SessionSourceInstance,
  SourceReadLimitsOverride,
  WorkspaceMembership,
} from '../types.js';
import { normalizeWorkspacePath } from '../workspace-scope.js';
import { acpSessionsDir, chatsDir, projectsDir } from './paths.js';
import { parseStoreDb, type StoreDbData } from './store-db.js';
import {
  parseTranscriptFile,
  type TranscriptParseResult,
  type TranscriptSourceFailure,
} from './transcript.js';
import type {
  StoreDbExpectation,
  StoreDbState,
  StoreMetaJson,
  StorePhysicalOccurrence,
  StoreSession,
  TranscriptUse,
} from './types.js';

export interface StoreDiscoveryOptions {
  /** Validated before any source content or directory inventory is read. */
  sourceReadLimits?: SourceReadLimitsOverride;
  /** Strict SQLite provider preference for Store snapshot/read operations. */
  sqliteDriver?: DriverName;
  /** Cooperatively cancel inventory, transcript parsing, and Store snapshots. */
  signal?: AbortSignal;
  /** Receives only safe typed diagnostics (never a locator or content). */
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
  /** Internal operation-bound I/O audit context. */
  io?: OperationIoContext;
  /** Optional already-selected logical UUIDs; unrelated payloads remain unopened. */
  sessionIds?: ReadonlySet<string>;
  /** Inventory metadata only; never decode transcript or store.db conversation payloads. */
  metadataOnly?: boolean;
  /** Internal exact physical selection bound by one SessionReadContext. */
  allowedOccurrenceKeys?: ReadonlySet<string>;
  /** Internal safe-catalog mode excludes display titles until scope is bound. */
  includeDisplayMetadata?: boolean;
}

interface InventoryEvidence {
  perSessionDirectory: boolean;
  metadataPresent: boolean;
  dbInventoried: boolean;
  dbOccurrences: StorePhysicalOccurrence[];
  transcriptInventoried: boolean;
  transcriptOccurrences: StorePhysicalOccurrence[];
  metadataOccurrences: StorePhysicalOccurrence[];
  hasConversationTrue: boolean;
  hasConversationFalse: boolean;
  unsupportedExpectationMetadata: boolean;
  metadataFailures: SourceEncodingError[];
}

interface MetaReadResult {
  meta?: StoreMetaJson;
  present: boolean;
  hasConversation?: boolean;
  unsupportedExpectationMetadata: boolean;
  diagnostic?: SourceEncodingError;
}

interface DirectoryListing<T> {
  entries: T[];
  complete: boolean;
}

interface TranscriptCandidate {
  readonly path: string;
  readonly workspacePath?: string;
  readonly parsed: TranscriptParseResult;
}

interface StoreDbCandidate {
  readonly path: string;
  readonly workspacePath?: string;
  readonly parsed: StoreDbData | null;
  readonly failures: readonly TranscriptSourceFailure[];
}

/** Unicode code-point ordering, independent of ICU/process locale. */
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
    const difference = compareCodePoints(left[index]!, right[index]!);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

const physicalOccurrences = new WeakMap<StoreSession, readonly StorePhysicalOccurrence[]>();

/** Return private occurrence inventory for an in-process Store catalog row. */
export function getStorePhysicalOccurrences(
  session: StoreSession
): readonly StorePhysicalOccurrence[] {
  return physicalOccurrences.get(session) ?? [];
}

function occurrenceKey(
  representation: StorePhysicalOccurrence['representation'],
  path: string
): string {
  return `${representation}\0${path}`;
}

function occurrence(
  logicalSessionId: string,
  representation: StorePhysicalOccurrence['representation'],
  path: string,
  workspacePath?: string
): StorePhysicalOccurrence {
  return {
    instanceKey: occurrenceKey(representation, path),
    logicalSessionId,
    representation,
    path,
    ...(workspacePath ? { workspacePath: normalizeWorkspacePath(workspacePath) } : {}),
    sourceOrder: 0,
  };
}

const TRANSCRIPT_STATE_RANK: Readonly<Record<StoreSession['transcriptState'], number>> =
  Object.freeze({
    parsed: 6,
    partial: 5,
    'error-only': 4,
    unsupported: 3,
    empty: 2,
    unreadable: 1,
    missing: 0,
  });

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

function consumedToolCalls(
  message: Message
): ReplicaConsumedPayload['messages'][number]['toolCalls'] {
  return message.toolCalls?.map((tool) => ({
    id: tool.id ?? `tool:${sha256CanonicalJsonV1({ name: tool.name, params: tool.params })}`,
    name: tool.name,
    status: tool.status,
    ...(tool.params !== undefined ? { params: tool.params } : {}),
    ...(tool.result !== undefined ? { result: tool.result } : {}),
    ...(tool.error !== undefined ? { error: tool.error } : {}),
  }));
}

/** Project one Store representation using only fields consumed by unchanged callers. */
function consumedStorePayload(
  messages: readonly Message[],
  identityEvidence: readonly StoreSession['messageIdentityEvidence'][number][]
): ReplicaConsumedPayload {
  const identityRecords: StoreIdentityRecord[] = messages.map((message, index) => {
    const evidence = identityEvidence[index];
    if (evidence?.representation === 'db') {
      return { representation: 'db', leafHash: evidence.leafHash };
    }
    if (evidence?.representation === 'transcript') {
      return {
        representation: 'transcript',
        role: evidence.role,
        content: evidence.content,
        toolActivity: evidence.toolActivity,
        sourceRelationships: evidence.sourceRelationships,
      };
    }
    const sourceRelationships: Record<string, unknown> = {};
    if (message.parentMessageId !== undefined) {
      sourceRelationships['parentMessageId'] = message.parentMessageId;
    }
    if (message.isSidechain !== undefined) sourceRelationships['isSidechain'] = message.isSidechain;
    return {
      representation: 'transcript',
      role: message.role,
      content: message.content,
      toolActivity: (message.toolCalls ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.params !== undefined ? { params: tool.params } : {}),
      })),
      sourceRelationships,
    };
  });
  const identities = prepareStoreIdentityCandidates(identityRecords);
  return {
    messages: messages.map((message, index) => {
      const toolCalls = consumedToolCalls(message);
      return {
        id: identities[index]!.candidateId,
        role: message.role,
        content: message.content,
        ...(message.timestamp &&
        (message.timestampSource === 'composer-created-at' ||
          message.timestampSource === 'composer-timing' ||
          message.timestampSource === 'store-turn-timing')
          ? { directTimestamp: message.timestamp.toISOString() }
          : {}),
        ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
        ...(message.parentMessageId !== undefined
          ? { parentMessageId: message.parentMessageId }
          : {}),
        ...(message.isSidechain !== undefined ? { isSidechain: message.isSidechain } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      };
    }),
  };
}

function storeSourceInstance(
  representation: 'store-db' | 'store-transcript' | 'store-metadata',
  workspacePath: string | undefined,
  state: SessionSourceInstance['state']
): SessionSourceInstance {
  return {
    sourceRole: 'store',
    representation,
    workspacePaths: workspacePath ? [workspacePath] : [],
    state,
  };
}

function canonicalSourceInstances(
  instances: readonly SessionSourceInstance[]
): SessionSourceInstance[] {
  const representationOrder = ['store-db', 'store-transcript', 'store-metadata'] as const;
  const stateOrder = [
    'contributed',
    'equivalent-replica',
    'omitted-by-scope',
    'failed',
    'superseded',
  ] as const;
  return [...instances].sort((left, right) => {
    const byRepresentation =
      representationOrder.indexOf(left.representation as (typeof representationOrder)[number]) -
      representationOrder.indexOf(right.representation as (typeof representationOrder)[number]);
    if (byRepresentation !== 0) return byRepresentation;
    const byPath = compareStringArrays(left.workspacePaths, right.workspacePaths);
    if (byPath !== 0) return byPath;
    return stateOrder.indexOf(left.state) - stateOrder.indexOf(right.state);
  });
}

function metadataSourceInstances(
  selected: StoreSession,
  candidates: readonly StoreSession[]
): SessionSourceInstance[] {
  return canonicalSourceInstances(
    [...candidates]
      .sort((left, right) => compareCodePoints(left.chatDir ?? '', right.chatDir ?? ''))
      .map((candidate) =>
        storeSourceInstance(
          'store-metadata',
          candidate.workspacePath,
          candidate.chatDir === selected.chatDir ? 'contributed' : 'equivalent-replica'
        )
      )
  );
}

function canonicalOccurrences(evidence: InventoryEvidence): readonly StorePhysicalOccurrence[] {
  const representationOrder = ['store-db', 'store-transcript', 'store-metadata'] as const;
  return Object.freeze(
    [...evidence.dbOccurrences, ...evidence.transcriptOccurrences, ...evidence.metadataOccurrences]
      .sort((left, right) => {
        const byRepresentation =
          representationOrder.indexOf(left.representation) -
          representationOrder.indexOf(right.representation);
        return byRepresentation || compareCodePoints(left.path, right.path);
      })
      .map((value, sourceOrder) => Object.freeze({ ...value, sourceOrder }))
  );
}

function inventorySourceInstances(evidence: InventoryEvidence): SessionSourceInstance[] {
  if (evidence.dbOccurrences.length > 0) {
    return canonicalSourceInstances([
      ...[...evidence.dbOccurrences]
        .sort((left, right) => compareCodePoints(left.path, right.path))
        .map((item, index) =>
          storeSourceInstance(
            'store-db',
            item.workspacePath,
            index === 0 ? 'contributed' : 'superseded'
          )
        ),
      ...[...evidence.transcriptOccurrences]
        .sort((left, right) => compareCodePoints(left.path, right.path))
        .map((item) => storeSourceInstance('store-transcript', item.workspacePath, 'superseded')),
    ]);
  }
  if (evidence.transcriptOccurrences.length > 0) {
    return canonicalSourceInstances(
      [...evidence.transcriptOccurrences]
        .sort((left, right) => compareCodePoints(left.path, right.path))
        .map((item, index) =>
          storeSourceInstance(
            'store-transcript',
            item.workspacePath,
            index === 0 ? 'contributed' : 'superseded'
          )
        )
    );
  }
  return canonicalSourceInstances(
    [...evidence.metadataOccurrences]
      .sort((left, right) => compareCodePoints(left.path, right.path))
      .map((item, index) =>
        storeSourceInstance(
          'store-metadata',
          item.workspacePath,
          index === 0 ? 'contributed' : 'equivalent-replica'
        )
      )
  );
}

function omittedSourceInstances(
  evidence: InventoryEvidence,
  allowed: ReadonlySet<string> | undefined
): SessionSourceInstance[] {
  if (!allowed) return [];
  const relevant =
    evidence.dbOccurrences.length > 0
      ? [...evidence.dbOccurrences, ...evidence.transcriptOccurrences]
      : evidence.transcriptOccurrences.length > 0
        ? evidence.transcriptOccurrences
        : evidence.metadataOccurrences;
  return canonicalSourceInstances(
    relevant
      .filter((item) => !occurrenceIsAllowed(item, allowed))
      .map((item) =>
        storeSourceInstance(item.representation, item.workspacePath, 'omitted-by-scope')
      )
  );
}

function workspaceMembershipsFromOccurrences(
  occurrences: readonly StorePhysicalOccurrence[]
): WorkspaceMembership[] {
  const countsByRepresentation = new Map<
    string,
    Map<StorePhysicalOccurrence['representation'], number>
  >();
  for (const item of occurrences) {
    if (!item.workspacePath) continue;
    const representationCounts =
      countsByRepresentation.get(item.workspacePath) ??
      new Map<StorePhysicalOccurrence['representation'], number>();
    representationCounts.set(
      item.representation,
      (representationCounts.get(item.representation) ?? 0) + 1
    );
    countsByRepresentation.set(item.workspacePath, representationCounts);
  }
  return [...countsByRepresentation.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([workspacePath, representationCounts]) => {
      // Store metadata, DB, and transcript records can describe the same
      // physical conversation occurrence.  Union their verified paths while
      // taking the largest per-representation multiplicity so provenance from
      // another representation does not count the same occurrence twice.
      const contributingInstanceCount = Math.max(...representationCounts.values());
      return {
        workspacePath,
        sourceRoles: ['store'],
        contributingInstanceCount,
      };
    });
}

function occurrenceIsAllowed(
  value: StorePhysicalOccurrence,
  allowed: ReadonlySet<string> | undefined
): boolean {
  return allowed === undefined || allowed.has(value.instanceKey);
}

function uniqueMetadataWorkspacePath(candidates: readonly StoreSession[]): string | undefined {
  const paths = [
    ...new Set(
      candidates.flatMap(({ workspacePath }) =>
        workspacePath ? [normalizeWorkspacePath(workspacePath)] : []
      )
    ),
  ];
  return paths.length === 1 ? paths[0] : undefined;
}

function physicalStoreCandidates<T>(
  logicalSessionId: string,
  representation: 'store-db' | 'store-transcript',
  fidelityTier: 'complete' | 'partial',
  candidates: readonly {
    path: string;
    workspacePath?: string;
    payload: ReplicaConsumedPayload;
    value: T;
  }[]
): {
  readonly catalog: ReturnType<typeof buildSessionCatalog<T>>[number];
  readonly valueByKey: ReadonlyMap<string, T>;
} {
  const ordered = [...candidates].sort((left, right) => compareCodePoints(left.path, right.path));
  const valueByKey = new Map<string, T>();
  const instances: PhysicalSessionInstance<T>[] = ordered.map((candidate, sourceOrder) => {
    valueByKey.set(candidate.path, candidate.value);
    return {
      instanceKey: candidate.path,
      logicalSessionId,
      sourceRole: 'store',
      representation,
      fidelityTier,
      locator: candidate.value,
      workspacePaths: candidate.workspacePath ? [candidate.workspacePath] : [],
      sourceOrder,
      loadConsumedPayload: () => candidate.payload,
    };
  });
  return { catalog: buildSessionCatalog(instances)[0]!, valueByKey };
}

/** Best-effort error message for debug diagnostics. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cursor also stores some sessions directly in chats/<uuid-without-dashes>/. */
function uuidFromCompactDirectoryName(value: string): string | undefined {
  if (!/^[0-9a-f]{32}$/iu.test(value)) return undefined;
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

export async function discoverStoreSessions(
  storeRoot: string,
  options: StoreDiscoveryOptions = {}
): Promise<StoreSession[]> {
  // Validation is deliberately the first operation: invalid caller policy
  // must fail before even a payload-presence check can trigger source I/O.
  const limits = resolveSourceReadLimits(options.sourceReadLimits);
  const signal = options.signal;
  const io = options.io;
  const selectedSessionIds = options.sessionIds;
  throwIfAborted(signal);
  const byId = new Map<string, StoreSession>();
  const inventory = new Map<string, InventoryEvidence>();
  const selectedTranscriptFailures = new Map<string, TranscriptSourceFailure[]>();
  const transcriptCandidates = new Map<string, TranscriptCandidate[]>();
  const metadataCandidates = new Map<string, StoreSession[]>();
  const explicitUpdatedAt = new Set<string>();
  let perSessionInventoryComplete = true;

  const evidenceFor = (uuid: string): InventoryEvidence => {
    let value = inventory.get(uuid);
    if (!value) {
      value = {
        perSessionDirectory: false,
        metadataPresent: false,
        dbInventoried: false,
        dbOccurrences: [],
        transcriptInventoried: false,
        transcriptOccurrences: [],
        metadataOccurrences: [],
        hasConversationTrue: false,
        hasConversationFalse: false,
        unsupportedExpectationMetadata: false,
        metadataFailures: [],
      };
      inventory.set(uuid, value);
    }
    return value;
  };

  const recordChatInventory = (uuid: string, sessionDir: string): void => {
    throwIfAborted(signal);
    const dbPath = join(sessionDir, 'store.db');
    const metadataInstanceKey = occurrenceKey('store-metadata', sessionDir);
    const includeDisplayMetadata =
      (options.includeDisplayMetadata ?? true) &&
      (!options.allowedOccurrenceKeys || options.allowedOccurrenceKeys.has(metadataInstanceKey));
    const metaRead = readMeta(
      join(sessionDir, 'meta.json'),
      signal,
      io,
      uuid,
      includeDisplayMetadata
    );
    const dbInventoried = pathExists(dbPath, signal, io, 'store-session-metadata', uuid);
    recordInventory(evidenceFor(uuid), uuid, metaRead, sessionDir, dbPath, dbInventoried);

    const meta = metaRead.meta;
    const storeMetadataTimestamps = timestampsFromStoreMeta(meta);
    const hasExplicitUpdatedAt = isValidMs(meta?.updatedAtMs);
    const projectedTimestamps = resolveSessionTimestamps({
      view: 'store-only',
      storeMetadata: storeMetadataTimestamps,
      directMessages: [],
    });
    const candidate = emptyStoreSession({
      id: uuid,
      workspacePath: meta?.cwd,
      title: meta?.title ?? null,
      ...projectedTimestamps,
      ...(storeMetadataTimestamps ? { storeMetadataTimestamps } : {}),
      storeDbPath: dbInventoried ? dbPath : undefined,
      chatDir: sessionDir,
    });
    const candidates = metadataCandidates.get(uuid) ?? [];
    candidates.push({ ...candidate });
    metadataCandidates.set(uuid, candidates);
    selectMetadataCandidate(byId, candidate, hasExplicitUpdatedAt, explicitUpdatedAt);
  };

  // 1. chats/ metadata inventory.
  const chats = chatsDir(storeRoot);
  if (pathExists(chats, signal, io, 'store-root-directory')) {
    const hashListing = listDirs(chats, signal, io);
    perSessionInventoryComplete &&= hashListing.complete;
    for (const hash of hashListing.entries) {
      throwIfAborted(signal);
      const hashDir = join(chats, hash);
      const directUuid = uuidFromCompactDirectoryName(hash);
      if (
        directUuid &&
        (!selectedSessionIds || selectedSessionIds.has(directUuid)) &&
        pathExists(join(hashDir, 'store.db'), signal, io, 'store-session-metadata', directUuid)
      ) {
        recordChatInventory(directUuid, hashDir);
      }
      const sessionListing = listDirs(hashDir, signal, io);
      perSessionInventoryComplete &&= sessionListing.complete;
      for (const uuid of sessionListing.entries) {
        if (selectedSessionIds && !selectedSessionIds.has(uuid)) continue;
        const sessionDir = join(chats, hash, uuid);
        recordChatInventory(uuid, sessionDir);
      }
    }
  }

  // 2. ACP metadata inventory.
  const acp = acpSessionsDir(storeRoot);
  throwIfAborted(signal);
  if (pathExists(acp, signal, io, 'store-root-directory')) {
    const sessionListing = listDirs(acp, signal, io);
    perSessionInventoryComplete &&= sessionListing.complete;
    for (const uuid of sessionListing.entries) {
      if (selectedSessionIds && !selectedSessionIds.has(uuid)) continue;
      const sessionDir = join(acp, uuid);
      throwIfAborted(signal);
      const dbPath = join(sessionDir, 'store.db');
      const metadataInstanceKey = occurrenceKey('store-metadata', sessionDir);
      const includeDisplayMetadata =
        (options.includeDisplayMetadata ?? true) &&
        (!options.allowedOccurrenceKeys || options.allowedOccurrenceKeys.has(metadataInstanceKey));
      const metaRead = readMeta(
        join(sessionDir, 'meta.json'),
        signal,
        io,
        uuid,
        includeDisplayMetadata
      );
      const dbInventoried = pathExists(dbPath, signal, io, 'store-session-metadata', uuid);
      recordInventory(evidenceFor(uuid), uuid, metaRead, sessionDir, dbPath, dbInventoried);
      const storeMetadataTimestamps = timestampsFromStoreMeta(metaRead.meta);
      const projectedTimestamps = resolveSessionTimestamps({
        view: 'store-only',
        storeMetadata: storeMetadataTimestamps,
        directMessages: [],
      });
      const candidate = emptyStoreSession({
        id: uuid,
        workspacePath: metaRead.meta?.cwd,
        title: metaRead.meta?.title ?? null,
        ...projectedTimestamps,
        ...(storeMetadataTimestamps ? { storeMetadataTimestamps } : {}),
        storeDbPath: dbInventoried ? dbPath : undefined,
        chatDir: sessionDir,
      });
      const candidates = metadataCandidates.get(uuid) ?? [];
      candidates.push({ ...candidate });
      metadataCandidates.set(uuid, candidates);
      selectMetadataCandidate(byId, candidate, false, explicitUpdatedAt);
    }
  }

  // An operation-bound payload read must carry scalar metadata from one of
  // the exact permitted occurrences, never from a same-UUID off-scope copy.
  if (options.allowedOccurrenceKeys) {
    for (const [uuid, candidates] of metadataCandidates) {
      const permitted = candidates
        .filter(
          ({ chatDir }) =>
            chatDir && options.allowedOccurrenceKeys!.has(occurrenceKey('store-metadata', chatDir))
        )
        .sort((left, right) => {
          if (shouldReplaceMetadata(left, right)) return 1;
          if (shouldReplaceMetadata(right, left)) return -1;
          return compareCodePoints(left.chatDir ?? '', right.chatDir ?? '');
        });
      if (permitted[0]) byId.set(uuid, { ...permitted[0] });
    }
  }

  // 3. Canonical transcript inventory and bounded parse.
  const projects = projectsDir(storeRoot);
  throwIfAborted(signal);
  if (pathExists(projects, signal, io, 'store-root-directory')) {
    const projectListing = listDirs(projects, signal, io);
    for (const sanitized of projectListing.entries) {
      throwIfAborted(signal);
      const transcriptDir = join(projects, sanitized, 'agent-transcripts');
      if (!pathExists(transcriptDir, signal, io, 'store-root-directory')) continue;
      const transcriptListing = listEntries(transcriptDir, signal, io);
      for (const entry of transcriptListing.entries) {
        throwIfAborted(signal);
        if (entry.isDirectory()) {
          const uuid = entry.name;
          if (selectedSessionIds && !selectedSessionIds.has(uuid)) continue;
          const nested = join(transcriptDir, uuid, `${uuid}.jsonl`);
          if (pathExists(nested, signal, io, 'store-session-metadata', uuid)) {
            const evidence = evidenceFor(uuid);
            evidence.transcriptInventoried = true;
            const transcriptOccurrence = occurrence(
              uuid,
              'store-transcript',
              nested,
              uniqueMetadataWorkspacePath(metadataCandidates.get(uuid) ?? [])
            );
            if (!evidence.transcriptOccurrences.some(({ path }) => path === nested)) {
              evidence.transcriptOccurrences.push(transcriptOccurrence);
            }
            if (options.metadataOnly) {
              attachTranscriptInventory(byId, uuid, nested);
            } else if (occurrenceIsAllowed(transcriptOccurrence, options.allowedOccurrenceKeys)) {
              attachTranscript(
                byId,
                selectedTranscriptFailures,
                transcriptCandidates,
                uuid,
                nested,
                transcriptOccurrence.workspacePath,
                limits,
                signal,
                io
              );
            }
          }
        } else if (entry.name.endsWith('.jsonl')) {
          const uuid = entry.name.slice(0, -'.jsonl'.length);
          if (selectedSessionIds && !selectedSessionIds.has(uuid)) continue;
          const evidence = evidenceFor(uuid);
          evidence.transcriptInventoried = true;
          const transcriptPath = join(transcriptDir, entry.name);
          const transcriptOccurrence = occurrence(
            uuid,
            'store-transcript',
            transcriptPath,
            uniqueMetadataWorkspacePath(metadataCandidates.get(uuid) ?? [])
          );
          if (!evidence.transcriptOccurrences.some(({ path }) => path === transcriptPath)) {
            evidence.transcriptOccurrences.push(transcriptOccurrence);
          }
          if (options.metadataOnly) {
            attachTranscriptInventory(byId, uuid, transcriptPath);
          } else if (occurrenceIsAllowed(transcriptOccurrence, options.allowedOccurrenceKeys)) {
            attachTranscript(
              byId,
              selectedTranscriptFailures,
              transcriptCandidates,
              uuid,
              transcriptPath,
              transcriptOccurrence.workspacePath,
              limits,
              signal,
              io
            );
          }
        }
      }
    }
  }

  // A selected metadata replica may lack its own DB while another inventoried
  // occurrence had one. Preserve the deterministic inventory fact and locator
  // until replica reconciliation is introduced; never downgrade expectation.
  for (const [uuid, ss] of byId) {
    const evidence = evidenceFor(uuid);
    if (!ss.storeDbPath && evidence.dbOccurrences.length > 0) {
      ss.storeDbPath = [...evidence.dbOccurrences].sort((left, right) =>
        compareCodePoints(left.path, right.path)
      )[0]!.path;
    }
  }

  if (options.metadataOnly) {
    const metadataRows: StoreSession[] = [];
    for (const ss of byId.values()) {
      throwIfAborted(signal);
      const evidence = evidenceFor(ss.id);
      ss.storeDbExpectation = classifyStoreDbExpectation(evidence, perSessionInventoryComplete);
      if (shouldOmitExplicitNoConversation(evidence, ss.storeDbExpectation)) {
        logStoreResolution(ss, 'missing', 'unused', 'omitted');
        continue;
      }
      ss.source = evidence.transcriptInventoried ? 'transcript' : 'store';
      ss.resolvedSource = 'store-metadata';
      if (evidence.metadataFailures.length > 0) {
        ss.diagnostics = evidence.metadataFailures.map((error) =>
          toSessionDiagnostic(error, ss.id)
        );
        for (const diagnostic of ss.diagnostics) options.onDiagnostic?.(diagnostic);
      }
      ss.sourceInstances = inventorySourceInstances(evidence);
      ss.workspaceMemberships = workspaceMembershipsFromOccurrences(canonicalOccurrences(evidence));
      resolveStoreSessionTimestamps(ss);
      physicalOccurrences.set(ss, canonicalOccurrences(evidence));
      metadataRows.push(ss);
    }
    return metadataRows;
  }

  // 4. Exhaustive representation selection.
  const resolved: StoreSession[] = [];
  for (const ss of byId.values()) {
    throwIfAborted(signal);
    const evidence = evidenceFor(ss.id);
    const expectation = classifyStoreDbExpectation(evidence, perSessionInventoryComplete);
    ss.storeDbExpectation = expectation;
    ss.workspaceMemberships = workspaceMembershipsFromOccurrences(canonicalOccurrences(evidence));
    physicalOccurrences.set(ss, canonicalOccurrences(evidence));
    const scopeOmissions = omittedSourceInstances(evidence, options.allowedOccurrenceKeys);

    // Retain typed parser failures until both representations are known. A
    // partial outcome is safe only when the other representation contributed
    // real conversation content; otherwise the same failure is promoted to a
    // fatal operation error instead of publishing an empty/truncated session.
    const dbCandidates: StoreDbCandidate[] = [];
    for (const dbOccurrence of [...evidence.dbOccurrences]
      .filter((item) => occurrenceIsAllowed(item, options.allowedOccurrenceKeys))
      .sort((left, right) => compareCodePoints(left.path, right.path))) {
      const failures: TranscriptSourceFailure[] = [];
      const parsed = await parseStoreDb(dbOccurrence.path, {
        limits,
        failureOutcome: 'partial',
        onDiagnostic: (error) => failures.push(error),
        sqliteDriver: options.sqliteDriver,
        signal,
        io,
        logicalSessionId: ss.id,
      });
      dbCandidates.push({
        path: dbOccurrence.path,
        workspacePath: dbOccurrence.workspacePath,
        parsed,
        failures,
      });
    }

    const usableDbCandidates = dbCandidates.filter(
      (candidate): candidate is StoreDbCandidate & { parsed: StoreDbData } =>
        Boolean(candidate.parsed && candidate.parsed.messages.length > 0)
    );
    const selectedDbFidelity = usableDbCandidates.some(
      ({ parsed }) => parsed.completeness === 'complete'
    )
      ? ('complete' as const)
      : ('partial' as const);
    const selectedDbTier = usableDbCandidates.filter(
      ({ parsed }) => parsed.completeness === selectedDbFidelity
    );
    let selectedDbCandidate =
      selectedDbTier[0] ??
      dbCandidates.find(({ path }) => path === ss.storeDbPath) ??
      dbCandidates[0];
    let dbReplicaInstances: SessionSourceInstance[] = [];
    if (selectedDbTier.length > 1) {
      const physical = physicalStoreCandidates(
        ss.id,
        'store-db',
        selectedDbFidelity,
        selectedDbTier.map((candidate) => ({
          path: candidate.path,
          workspacePath: candidate.workspacePath,
          payload: consumedStorePayload(
            candidate.parsed.messages,
            candidate.parsed.messageIdentityEvidence
          ),
          value: candidate,
        }))
      );
      const reconciliation = await reconcileReplicaGroup(physical.catalog.replicaGroups[0]!, {
        diagnosticContextId: options.io?.contextId ?? `store-discovery:${ss.id}`,
      });
      if (reconciliation.state === 'divergent') {
        throw sessionAmbiguityErrorFromReplicaGroup(reconciliation);
      }
      selectedDbCandidate = physical.valueByKey.get(reconciliation.selected.instanceKey)!;
      dbReplicaInstances = [...reconciliation.sourceInstances];
    } else if (selectedDbCandidate?.parsed && selectedDbCandidate.parsed.messages.length > 0) {
      dbReplicaInstances = [
        storeSourceInstance('store-db', selectedDbCandidate.workspacePath, 'contributed'),
      ];
    }
    for (const candidate of usableDbCandidates) {
      if (selectedDbTier.includes(candidate)) continue;
      dbReplicaInstances.push(
        storeSourceInstance('store-db', candidate.workspacePath, 'superseded')
      );
    }
    for (const candidate of dbCandidates) {
      if (candidate.parsed && candidate.parsed.messages.length > 0) continue;
      dbReplicaInstances.push(storeSourceInstance('store-db', candidate.workspacePath, 'failed'));
    }
    const deep = selectedDbCandidate?.parsed ?? null;
    const dbFailures = dbCandidates.flatMap(({ failures }) => failures);
    if (selectedDbCandidate) ss.storeDbPath = selectedDbCandidate.path;

    const dbUsable = Boolean(deep && deep.messages.length > 0);
    const selectedDbSafe = dbUsable && (selectedDbCandidate?.failures.length ?? 0) === 0;
    const sessionTranscriptCandidates = transcriptCandidates.get(ss.id) ?? [];
    let selectedTranscriptSafe = false;
    let transcriptReplicaInstances: SessionSourceInstance[] = [];
    if (dbUsable) {
      selectedTranscriptSafe = sessionTranscriptCandidates.some(
        ({ parsed }) => parsed.messages.length > 0 && !parsed.diagnostic
      );
      transcriptReplicaInstances = sessionTranscriptCandidates.map((candidate) =>
        storeSourceInstance(
          'store-transcript',
          candidate.workspacePath,
          candidate.parsed.diagnostic ? 'failed' : 'superseded'
        )
      );
    } else if (sessionTranscriptCandidates.length > 0) {
      const usableTranscriptCandidates = sessionTranscriptCandidates.filter(
        ({ parsed }) => parsed.messages.length > 0
      );
      const selectedFidelity = usableTranscriptCandidates.some(
        ({ parsed }) => parsed.state === 'parsed'
      )
        ? ('complete' as const)
        : ('partial' as const);
      const selectedTranscriptTier = usableTranscriptCandidates.filter(
        ({ parsed }) => (parsed.state === 'parsed' ? 'complete' : 'partial') === selectedFidelity
      );
      let selectedTranscript: TranscriptCandidate;
      if (selectedTranscriptTier.length > 0) {
        selectedTranscript = selectedTranscriptTier[0]!;
      } else {
        // No candidate contains usable conversation content. Retain the best
        // parser state only for the eventual degraded metadata projection.
        selectedTranscript = [...sessionTranscriptCandidates].sort(
          (left, right) =>
            TRANSCRIPT_STATE_RANK[right.parsed.state] - TRANSCRIPT_STATE_RANK[left.parsed.state] ||
            compareCodePoints(left.path, right.path)
        )[0]!;
      }
      if (selectedTranscriptTier.length > 1) {
        const physical = physicalStoreCandidates(
          ss.id,
          'store-transcript',
          selectedFidelity,
          selectedTranscriptTier.map((candidate) => ({
            path: candidate.path,
            workspacePath: candidate.workspacePath,
            payload: consumedStorePayload(
              candidate.parsed.messages,
              candidate.parsed.messageIdentityEvidence
            ),
            value: candidate,
          }))
        );
        const reconciliation = await reconcileReplicaGroup(physical.catalog.replicaGroups[0]!, {
          diagnosticContextId: options.io?.contextId ?? `store-discovery:${ss.id}`,
        });
        if (reconciliation.state === 'divergent') {
          throw sessionAmbiguityErrorFromReplicaGroup(reconciliation);
        }
        selectedTranscript = physical.valueByKey.get(reconciliation.selected.instanceKey)!;
        transcriptReplicaInstances = [...reconciliation.sourceInstances];
      } else if (selectedTranscriptTier.length === 1) {
        transcriptReplicaInstances = [
          storeSourceInstance('store-transcript', selectedTranscript.workspacePath, 'contributed'),
        ];
      } else {
        transcriptReplicaInstances = [];
      }
      for (const candidate of sessionTranscriptCandidates) {
        if (selectedTranscriptTier.includes(candidate)) continue;
        transcriptReplicaInstances.push(
          storeSourceInstance(
            'store-transcript',
            candidate.workspacePath,
            candidate.parsed.diagnostic || candidate.parsed.messages.length === 0
              ? 'failed'
              : 'superseded'
          )
        );
      }
      ss.transcriptState = selectedTranscript.parsed.state;
      ss.transcriptPath = selectedTranscript.path;
      ss.messages = selectedTranscript.parsed.messages;
      ss.messageIdentityEvidence = selectedTranscript.parsed.messageIdentityEvidence;
      ss.rawContentBlockEvidence = selectedTranscript.parsed.rawContentBlockEvidence;
      selectedTranscriptSafe =
        selectedTranscript.parsed.messages.length > 0 && !selectedTranscript.parsed.diagnostic;
    }

    const transcriptFailures = sessionTranscriptCandidates.flatMap(({ parsed }) =>
      parsed.diagnostic ? [parsed.diagnostic] : []
    );
    const transcriptUsable = ss.messages.length > 0;
    if (deep?.rawContentBlockEvidence.length) {
      ss.rawContentBlockEvidence = [
        ...(ss.rawContentBlockEvidence ?? []),
        ...deep.rawContentBlockEvidence,
      ];
    }
    const unusableSelectedTierReplica = dbUsable
      ? dbCandidates.some(({ parsed }) => !parsed || parsed.messages.length === 0)
      : transcriptUsable
        ? sessionTranscriptCandidates.some(({ parsed }) => parsed.messages.length === 0)
        : false;
    const retainedSourceFailure =
      retainSafeSourceFailures(
        ss,
        evidence.metadataFailures,
        transcriptFailures,
        dbFailures,
        selectedTranscriptSafe,
        selectedDbSafe,
        options.onDiagnostic
      ) || unusableSelectedTierReplica;

    if (deep?.title) ss.title = deep.title;
    if (deep?.createdAt) {
      ss.storeDbMetadataTimestamps = {
        createdAt: deep.createdAt,
        // store.db currently exposes one session time. Preserve the released
        // last-update fallback only when meta.json did not store updatedAtMs.
        ...(!explicitUpdatedAt.has(ss.id) ? { lastUpdatedAt: deep.createdAt } : {}),
      };
    }

    const dbState: StoreDbState = !ss.storeDbPath
      ? 'missing'
      : !deep
        ? 'failed'
        : deep.messages.length === 0
          ? deep.completeness === 'complete'
            ? 'empty'
            : 'failed'
          : deep.completeness;

    if (deep && deep.messages.length > 0) {
      ss.messages = deep.messages;
      ss.messageIdentityEvidence = deep.messageIdentityEvidence;
      ss.resolvedSource = 'store-db';
      ss.sourceInstances = canonicalSourceInstances([
        ...dbReplicaInstances,
        ...transcriptReplicaInstances,
        ...scopeOmissions,
      ]);
      if (deep.completeness === 'complete' && !retainedSourceFailure) {
        setResolution(ss, 'complete', []);
      } else {
        setResolution(ss, 'partial', [
          ...(deep.completeness === 'complete' ? [] : (['source-partial'] as const)),
          ...(retainedSourceFailure ? (['source-read-failed'] as const) : []),
        ]);
      }
      applyScopeOmission(ss, scopeOmissions.length > 0);
      resolveStoreSessionTimestamps(ss);
      logStoreResolution(ss, dbState, 'unused');
      resolved.push(ss);
      continue;
    }

    if (transcriptUsable) {
      const reasons: ResolutionReasonCode[] = [];
      if (expectation === 'expected') reasons.push('expected-store-db-unavailable');
      if (expectation === 'unknown') reasons.push('store-db-expectation-unknown');
      if (ss.transcriptState !== 'parsed') reasons.push('source-partial');
      if (retainedSourceFailure) reasons.push('source-read-failed');
      ss.resolvedSource = 'store-transcript';
      ss.sourceInstances = canonicalSourceInstances([
        ...transcriptReplicaInstances,
        ...dbReplicaInstances,
        ...scopeOmissions,
      ]);
      setResolution(ss, reasons.length === 0 ? 'complete' : 'partial', reasons);
      applyScopeOmission(ss, scopeOmissions.length > 0);
      resolveStoreSessionTimestamps(ss);
      logStoreResolution(ss, dbState, ss.storeDbPath ? 'fallback' : 'only-source');
      resolved.push(ss);
      continue;
    }

    if (shouldOmitExplicitNoConversation(evidence, expectation)) {
      logStoreResolution(ss, dbState, 'unused', 'omitted');
      continue;
    }

    ss.messages = [];
    ss.messageIdentityEvidence = [];
    ss.resolvedSource = 'store-metadata';
    const metadata = metadataCandidates.get(ss.id) ?? [];
    if (metadata.length > 0) {
      ss.sourceInstances = canonicalSourceInstances([
        ...metadataSourceInstances(ss, metadata),
        ...scopeOmissions,
      ]);
    }
    setResolution(ss, 'partial', ['store-conversation-unavailable']);
    applyScopeOmission(ss, scopeOmissions.length > 0);
    resolveStoreSessionTimestamps(ss);
    logStoreResolution(ss, dbState, 'unused');
    resolved.push(ss);
  }

  return resolved;
}

function shouldOmitExplicitNoConversation(
  evidence: Readonly<InventoryEvidence>,
  expectation: StoreDbExpectation
): boolean {
  const explicitNoConversation =
    expectation === 'not-expected' &&
    evidence.hasConversationFalse &&
    !evidence.hasConversationTrue;
  const positiveConversationEvidence =
    evidence.dbInventoried ||
    evidence.transcriptInventoried ||
    evidence.hasConversationTrue ||
    expectation === 'unknown';
  return explicitNoConversation && !positiveConversationEvidence;
}

export function classifyStoreDbExpectation(
  evidence: Readonly<InventoryEvidence>,
  inventoryComplete: boolean
): StoreDbExpectation {
  if (evidence.dbInventoried || evidence.hasConversationTrue) return 'expected';
  if (evidence.unsupportedExpectationMetadata) return 'unknown';
  if (evidence.hasConversationFalse) return 'not-expected';
  if (
    evidence.transcriptInventoried &&
    !evidence.perSessionDirectory &&
    !evidence.metadataPresent &&
    inventoryComplete
  ) {
    return 'not-expected';
  }
  return 'unknown';
}

function emptyStoreSession(
  fields: Pick<
    StoreSession,
    | 'id'
    | 'workspacePath'
    | 'title'
    | 'createdAt'
    | 'createdAtSource'
    | 'lastUpdatedAt'
    | 'lastUpdatedAtSource'
    | 'storeDbMetadataTimestamps'
    | 'storeMetadataTimestamps'
    | 'storeDbPath'
    | 'chatDir'
  >
): StoreSession {
  return {
    ...fields,
    messages: [],
    messageIdentityEvidence: [],
    rawContentBlockEvidence: [],
    source: 'workspace-fallback',
    transcriptState: 'missing',
  };
}

function recordInventory(
  evidence: InventoryEvidence,
  logicalSessionId: string,
  metaRead: MetaReadResult,
  sessionDir: string,
  dbPath: string,
  dbInventoried: boolean
): void {
  evidence.perSessionDirectory = true;
  evidence.metadataPresent ||= metaRead.present;
  evidence.hasConversationTrue ||= metaRead.hasConversation === true;
  evidence.hasConversationFalse ||= metaRead.hasConversation === false;
  evidence.unsupportedExpectationMetadata ||= metaRead.unsupportedExpectationMetadata;
  if (metaRead.diagnostic) evidence.metadataFailures.push(metaRead.diagnostic);
  const metadataOccurrence = occurrence(
    logicalSessionId,
    'store-metadata',
    sessionDir,
    metaRead.meta?.cwd
  );
  if (!evidence.metadataOccurrences.some(({ path }) => path === sessionDir)) {
    evidence.metadataOccurrences.push(metadataOccurrence);
  }
  if (dbInventoried) {
    evidence.dbInventoried = true;
    if (!evidence.dbOccurrences.some(({ path }) => path === dbPath)) {
      evidence.dbOccurrences.push(
        occurrence(logicalSessionId, 'store-db', dbPath, metaRead.meta?.cwd)
      );
    }
  }
}

function setResolution(
  ss: StoreSession,
  state: 'complete' | 'partial',
  reasonCodes: ResolutionReasonCode[]
): void {
  const normalizedReasons = orderedResolutionReasons(reasonCodes);
  ss.source = state === 'complete' ? 'global' : 'workspace-fallback';
  ss.resolution = {
    state,
    expectedSourceRoles: ['store'],
    loadedSourceRoles: ['store'],
    omittedSourceRoles: [],
    failedSourceRoles: normalizedReasons.includes('source-read-failed') ? ['store'] : [],
    reasonCodes: normalizedReasons,
  };
}

function applyScopeOmission(session: StoreSession, omitted: boolean): void {
  if (!omitted || !session.resolution) return;
  session.resolution = {
    ...session.resolution,
    state: 'partial',
    expectedSourceRoles: ['store'],
    loadedSourceRoles: ['store'],
    omittedSourceRoles: ['store'],
    failedSourceRoles: [...session.resolution.failedSourceRoles],
    reasonCodes: orderedResolutionReasons([
      ...session.resolution.reasonCodes,
      'workspace-scope-omitted',
    ]),
  };
  session.source = 'workspace-fallback';
}

function toSessionDiagnostic(
  error: SourceEncodingError | SourceLimitExceededError,
  sessionId: string
): SessionDiagnostic {
  if (error instanceof SourceEncodingError) {
    return {
      code: error.code,
      message: error.message,
      sessionId,
      sourceRole: 'store',
      sourceKind: error.details.sourceKind as 'jsonl' | 'sqlite',
      outcome: 'partial',
      remedy: error.details.remedy,
    };
  }
  const details = error.details;
  const common = {
    code: error.code,
    message: error.message,
    sessionId,
    sourceRole: 'store' as const,
    policyVersion: details.policyVersion,
    limit: details.limit,
    observedAtLeast: details.observedAtLeast,
    outcome: 'partial' as const,
    retryableWithOverride: true as const,
    remedy: details.remedy,
  };
  if (details.sourceKind === 'jsonl') {
    return details.bound === 'jsonl-record-count'
      ? { ...common, sourceKind: 'jsonl', bound: details.bound, unit: 'records' }
      : {
          ...common,
          sourceKind: 'jsonl',
          bound: details.bound as 'jsonl-record-bytes' | 'jsonl-source-bytes',
          unit: 'bytes',
        };
  }
  return details.bound === 'sqlite-page-rows' || details.bound === 'sqlite-row-count'
    ? {
        ...common,
        sourceKind: 'sqlite',
        bound: details.bound,
        unit: 'rows',
      }
    : {
        ...common,
        sourceKind: 'sqlite',
        bound: details.bound as 'sqlite-page-bytes' | 'sqlite-value-bytes' | 'sqlite-decoded-bytes',
        unit: 'bytes',
      };
}

/** Rebuild a retained partial parser failure with a fatal operation outcome. */
function promoteSourceFailure(error: TranscriptSourceFailure): TranscriptSourceFailure {
  if (error instanceof SourceEncodingError) {
    return new SourceEncodingError(error.details.sourceKind as 'jsonl' | 'sqlite', 'fatal');
  }
  return new SourceLimitExceededError({
    sourceKind: error.details.sourceKind,
    bound: error.details.bound,
    unit: error.details.unit,
    limit: error.details.limit,
    observedAtLeast: error.details.observedAtLeast,
    outcome: 'fatal',
  });
}

/**
 * Publish source failures as partial diagnostics only when the opposite
 * representation yielded content without its own defensive failure. A partial
 * prefix from either failing source cannot validate the other source and must
 * never turn two truncated representations into success.
 */
function retainSafeSourceFailures(
  session: StoreSession,
  metadataFailures: readonly SourceEncodingError[],
  transcriptFailures: readonly TranscriptSourceFailure[],
  dbFailures: readonly TranscriptSourceFailure[],
  transcriptSafe: boolean,
  dbSafe: boolean,
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void
): boolean {
  if (metadataFailures.length > 0 && !transcriptSafe && !dbSafe) {
    throw promoteSourceFailure(metadataFailures[0]!);
  }
  if (transcriptFailures.length > 0 && !dbSafe && !transcriptSafe) {
    throw promoteSourceFailure(transcriptFailures[0]!);
  }
  if (dbFailures.length > 0 && !transcriptSafe && !dbSafe) {
    throw promoteSourceFailure(dbFailures[0]!);
  }

  const diagnostics = [...metadataFailures, ...transcriptFailures, ...dbFailures].map((error) =>
    toSessionDiagnostic(error, session.id)
  );
  if (diagnostics.length === 0) return false;
  session.diagnostics = [...(session.diagnostics ?? []), ...diagnostics];
  for (const diagnostic of diagnostics) onDiagnostic?.(diagnostic);
  return true;
}

function attachTranscript(
  byId: Map<string, StoreSession>,
  selectedFailures: Map<string, TranscriptSourceFailure[]>,
  candidatesById: Map<string, TranscriptCandidate[]>,
  uuid: string,
  file: string,
  workspacePath: string | undefined,
  limits: ReturnType<typeof resolveSourceReadLimits>,
  signal?: AbortSignal,
  io?: OperationIoContext
): void {
  throwIfAborted(signal);
  const parsed = parseTranscriptFile(file, limits, 'partial', signal, io, uuid);
  const candidates = candidatesById.get(uuid) ?? [];
  candidates.push({ path: file, workspacePath, parsed });
  candidatesById.set(uuid, candidates);
  const existing = byId.get(uuid);
  const failures = parsed.diagnostic ? [parsed.diagnostic] : [];

  if (existing) {
    if (!shouldReplaceTranscript(existing, parsed.state, parsed.messages.length, file, signal)) {
      return;
    }
    existing.transcriptState = parsed.state;
    existing.transcriptPath = file;
    existing.messages = parsed.messages;
    existing.messageIdentityEvidence = parsed.messageIdentityEvidence;
    existing.rawContentBlockEvidence = parsed.rawContentBlockEvidence;
    selectedFailures.set(uuid, failures);
    return;
  }

  const projectedTimestamps = resolveSessionTimestamps({
    view: 'store-only',
    directMessages: parsed.messages,
  });

  byId.set(uuid, {
    id: uuid,
    workspacePath,
    title: null,
    ...projectedTimestamps,
    messages: parsed.messages,
    messageIdentityEvidence: parsed.messageIdentityEvidence,
    rawContentBlockEvidence: parsed.rawContentBlockEvidence,
    source: 'workspace-fallback',
    transcriptState: parsed.state,
    transcriptPath: file,
  });
  selectedFailures.set(uuid, failures);
}

/** Record transcript presence without opening or decoding its conversation payload. */
function attachTranscriptInventory(
  byId: Map<string, StoreSession>,
  uuid: string,
  file: string
): void {
  const existing = byId.get(uuid);
  if (existing) {
    if (!existing.transcriptPath || file < existing.transcriptPath) {
      existing.transcriptPath = file;
    }
    return;
  }

  const projectedTimestamps = resolveSessionTimestamps({
    view: 'store-only',
    directMessages: [],
  });
  byId.set(
    uuid,
    emptyStoreSession({
      id: uuid,
      workspacePath: undefined,
      title: null,
      ...projectedTimestamps,
      storeDbPath: undefined,
      chatDir: undefined,
    })
  );
  byId.get(uuid)!.transcriptPath = file;
}

/** Prefer state, then message count, then canonical path; never filesystem time. */
function shouldReplaceTranscript(
  existing: StoreSession,
  candidateState: StoreSession['transcriptState'],
  candidateMessageCount: number,
  candidatePath: string,
  signal?: AbortSignal
): boolean {
  throwIfAborted(signal);
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
  if (rank[candidateState] !== rank[existing.transcriptState]) {
    return rank[candidateState] > rank[existing.transcriptState];
  }
  if (candidateMessageCount !== existing.messages.length) {
    return candidateMessageCount > existing.messages.length;
  }
  return candidatePath < existing.transcriptPath;
}

function selectMetadataCandidate(
  byId: Map<string, StoreSession>,
  candidate: StoreSession,
  hasExplicitUpdatedAt: boolean,
  explicitUpdatedAt: Set<string>
): void {
  const existing = byId.get(candidate.id);
  if (!existing) {
    byId.set(candidate.id, candidate);
    if (hasExplicitUpdatedAt) explicitUpdatedAt.add(candidate.id);
    return;
  }
  if (!shouldReplaceMetadata(existing, candidate)) return;
  replaceMetadata(existing, candidate);
  if (hasExplicitUpdatedAt) explicitUpdatedAt.add(candidate.id);
  else explicitUpdatedAt.delete(candidate.id);
}

function logStoreResolution(
  ss: Pick<StoreSession, 'id' | 'source' | 'resolvedSource' | 'storeDbExpectation'>,
  dbState: StoreDbState,
  transcriptUse: TranscriptUse,
  suffix = ''
): void {
  debugLogStorage(
    `store: ${ss.id} expectation=${ss.storeDbExpectation} dbState=${dbState} transcriptUse=${transcriptUse} source=${ss.source} resolvedSource=${ss.resolvedSource ?? 'none'}${suffix ? ` ${suffix}` : ''}`
  );
}

function listDirs(
  dir: string,
  signal?: AbortSignal,
  io?: OperationIoContext
): DirectoryListing<string> {
  throwIfAborted(signal);
  try {
    observeStoreFs(io, 'read', 'store-root-directory');
    return {
      entries: readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareCodePoints),
      complete: true,
    };
  } catch (error) {
    if (isAbsentOrWrongType(error)) {
      debugLogStorage(
        `store: directory disappeared or has the wrong type ${dir}: ${errMsg(error)}`
      );
      return { entries: [], complete: false };
    }
    throw error;
  }
}

function listEntries(
  dir: string,
  signal?: AbortSignal,
  io?: OperationIoContext
): DirectoryListing<Dirent> {
  throwIfAborted(signal);
  try {
    observeStoreFs(io, 'read', 'store-root-directory');
    return {
      entries: readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        compareCodePoints(a.name, b.name)
      ),
      complete: true,
    };
  } catch (error) {
    if (isAbsentOrWrongType(error)) {
      debugLogStorage(
        `store: directory disappeared or has the wrong type ${dir}: ${errMsg(error)}`
      );
      return { entries: [], complete: false };
    }
    throw error;
  }
}

function readMeta(
  path: string,
  signal?: AbortSignal,
  io?: OperationIoContext,
  logicalSessionId?: string,
  includeDisplayMetadata = true
): MetaReadResult {
  throwIfAborted(signal);
  let raw: Buffer;
  try {
    observeStoreFs(io, 'read', 'store-session-metadata', logicalSessionId, 'store-db');
    raw = readFileSync(path);
  } catch (error) {
    if (isAbsentOrWrongType(error)) {
      return { present: false, unsupportedExpectationMetadata: false };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    const projected = includeDisplayMetadata ? raw : redactTopLevelDisplayTitle(raw);
    parsed = JSON.parse(decodeDeterministicUtf8(projected, 'jsonl', 'partial').text) as unknown;
  } catch (error) {
    if (error instanceof SourceEncodingError) {
      return {
        present: true,
        unsupportedExpectationMetadata: true,
        diagnostic: error,
      };
    }
    if (error instanceof SyntaxError) {
      return { present: true, unsupportedExpectationMetadata: true };
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, unsupportedExpectationMetadata: true };
  }

  const record = parsed as Record<string, unknown>;
  const meta: StoreMetaJson = {};
  let unsupportedExpectationMetadata = false;
  let hasConversation: boolean | undefined;

  if (record['schemaVersion'] !== undefined) {
    if (typeof record['schemaVersion'] === 'number' && Number.isFinite(record['schemaVersion'])) {
      meta.schemaVersion = record['schemaVersion'];
    }
  }
  if (record['hasConversation'] !== undefined) {
    if (typeof record['hasConversation'] === 'boolean') {
      meta.hasConversation = record['hasConversation'];
      hasConversation = record['hasConversation'];
    } else {
      unsupportedExpectationMetadata = true;
    }
  }
  if (typeof record['cwd'] === 'string') meta.cwd = record['cwd'];
  if (includeDisplayMetadata && typeof record['title'] === 'string') meta.title = record['title'];
  if (isValidMs(record['createdAtMs'])) meta.createdAtMs = record['createdAtMs'];
  if (isValidMs(record['updatedAtMs'])) meta.updatedAtMs = record['updatedAtMs'];

  return {
    meta,
    present: true,
    hasConversation,
    unsupportedExpectationMetadata,
  };
}

/**
 * Produce the metadata-only projection used before an operation binds exact
 * Store occurrences.  A title is conversation display payload, so its bytes
 * must not participate in UTF-8 decoding or JSON materialization during the
 * safe catalog pass.
 *
 * The scan is deliberately byte-oriented.  It decodes only a top-level object
 * key token, then replaces the matching key and string value in a private copy
 * before the ordinary deterministic decoder sees the document.  Unknown
 * fields remain untouched and continue to follow JSON's forward-compatible
 * ignore behavior.
 */
function redactTopLevelDisplayTitle(raw: Buffer): Buffer {
  let depth = 0;
  let redacted: Buffer | undefined;

  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index];
    if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      continue;
    }
    if (byte === 0x7d || byte === 0x5d) {
      depth -= 1;
      continue;
    }
    if (byte !== 0x22) continue;

    const keyStart = index;
    const keyEnd = findJsonStringEnd(raw, keyStart);
    if (keyEnd === undefined) break;
    index = keyEnd;
    if (depth !== 1 || decodeJsonObjectKey(raw, keyStart, keyEnd) !== 'title') continue;

    let cursor = keyEnd + 1;
    while (cursor < raw.length && isJsonWhitespace(raw[cursor]!)) cursor += 1;
    if (raw[cursor] !== 0x3a) continue;
    cursor += 1;
    while (cursor < raw.length && isJsonWhitespace(raw[cursor]!)) cursor += 1;
    if (raw[cursor] !== 0x22) continue;

    const valueStart = cursor;
    const valueEnd = findJsonStringEnd(raw, valueStart);
    if (valueEnd === undefined) break;

    redacted ??= Buffer.from(raw);
    // Rename the property so JSON.parse never materializes a field named
    // `title`, then blank the payload bytes without decoding them.
    redacted.fill(0x5f, keyStart + 1, keyEnd);
    redacted.fill(0x20, valueStart + 1, valueEnd);
    index = valueEnd;
  }

  return redacted ?? raw;
}

function findJsonStringEnd(raw: Buffer, start: number): number | undefined {
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const byte = raw[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (byte === 0x5c) {
      escaped = true;
      continue;
    }
    if (byte === 0x22) return index;
  }
  return undefined;
}

function decodeJsonObjectKey(raw: Buffer, start: number, end: number): string | undefined {
  try {
    const token = decodeDeterministicUtf8(raw.subarray(start, end + 1), 'jsonl', 'partial').text;
    const parsed = JSON.parse(token) as unknown;
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    // The full deterministic decode below remains authoritative for malformed
    // metadata.  This helper only decides whether a valid key names payload.
    return undefined;
  }
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function pathExists(
  path: string,
  signal?: AbortSignal,
  io?: OperationIoContext,
  resourceClass = 'store-root-directory',
  logicalSessionId?: string
): boolean {
  throwIfAborted(signal);
  try {
    observeStoreFs(io, 'open', resourceClass, logicalSessionId);
    statSync(path);
    return true;
  } catch (error) {
    if (isAbsentOrWrongType(error)) return false;
    throw error;
  }
}

function observeStoreFs(
  io: OperationIoContext | undefined,
  operation: 'open' | 'read',
  resourceClass: string,
  logicalSessionId?: string,
  representation?: 'store-db' | 'store-transcript'
): void {
  if (!io) return;
  observeAdapterIo(io, {
    adapter: 'filesystem',
    operation,
    resourceClass,
    sourceRole: 'store',
    ...(logicalSessionId ? { logicalSessionId } : {}),
    ...(representation ? { representation } : {}),
  });
}

function isAbsentOrWrongType(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error('The Store discovery operation was aborted.', {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function isValidMs(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 1_000_000_000_000) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function shouldReplaceMetadata(existing: StoreSession, candidate: StoreSession): boolean {
  const updateDelta = candidate.lastUpdatedAt.getTime() - existing.lastUpdatedAt.getTime();
  if (updateDelta !== 0) return updateDelta > 0;
  const creationDelta = candidate.createdAt.getTime() - existing.createdAt.getTime();
  if (creationDelta !== 0) return creationDelta > 0;
  return compareCodePoints(candidate.chatDir ?? '', existing.chatDir ?? '') < 0;
}

function replaceMetadata(target: StoreSession, source: StoreSession): void {
  target.workspacePath = source.workspacePath;
  target.title = source.title;
  target.createdAt = source.createdAt;
  target.createdAtSource = source.createdAtSource;
  target.lastUpdatedAt = source.lastUpdatedAt;
  target.lastUpdatedAtSource = source.lastUpdatedAtSource;
  target.storeDbMetadataTimestamps = source.storeDbMetadataTimestamps;
  target.storeMetadataTimestamps = source.storeMetadataTimestamps;
  target.storeDbPath = source.storeDbPath;
  target.chatDir = source.chatDir;
}

function timestampsFromStoreMeta(
  meta: StoreMetaJson | undefined
): StoreSession['storeMetadataTimestamps'] {
  const createdAt = isValidMs(meta?.createdAtMs) ? new Date(meta.createdAtMs) : undefined;
  const explicitUpdatedAt = isValidMs(meta?.updatedAtMs) ? new Date(meta.updatedAtMs) : undefined;
  const lastUpdatedAt = explicitUpdatedAt ?? createdAt;
  if (!createdAt && !lastUpdatedAt) return undefined;
  return {
    ...(createdAt ? { createdAt } : {}),
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
  };
}

/** Resolve public Store session clocks without filesystem or discovery-time input. */
function resolveStoreSessionTimestamps(session: StoreSession): void {
  const projection = resolveSessionTimestamps({
    view: 'store-only',
    storeDbMetadata: session.storeDbMetadataTimestamps,
    storeMetadata: session.storeMetadataTimestamps,
    directMessages: session.messages,
  });
  session.createdAt = projection.createdAt;
  session.createdAtSource = projection.createdAtSource;
  session.lastUpdatedAt = projection.lastUpdatedAt;
  session.lastUpdatedAtSource = projection.lastUpdatedAtSource;
}
