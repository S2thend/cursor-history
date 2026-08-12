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
  projectAmbiguousSessionSummary,
  reconcileReplicaGroup,
  type PhysicalSessionInstance,
  type ReplicaConsumedPayload,
} from '../session-catalog.js';
import { sha256CanonicalJsonV1 } from '../session-identity.js';
import type {
  Message,
  ResolutionReasonCode,
  SessionDiagnostic,
  SessionSourceInstance,
  SourceReadLimitsOverride,
} from '../types.js';
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
}

interface InventoryEvidence {
  perSessionDirectory: boolean;
  metadataPresent: boolean;
  dbInventoried: boolean;
  dbPaths: string[];
  transcriptInventoried: boolean;
  transcriptPaths: string[];
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
  readonly parsed: TranscriptParseResult;
}

interface StoreDbCandidate {
  readonly path: string;
  readonly parsed: StoreDbData | null;
  readonly failures: readonly TranscriptSourceFailure[];
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
  const occurrences = new Map<string, number>();
  return {
    messages: messages.map((message, index) => {
      const evidence = identityEvidence[index] ?? {
        representation: 'transcript' as const,
        sourceLine: index + 1,
        role: message.role,
        content: message.content,
        toolActivity: [],
        sourceRelationships: {},
      };
      const fingerprint = sha256CanonicalJsonV1(evidence);
      const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
      occurrences.set(fingerprint, occurrence);
      const toolCalls = consumedToolCalls(message);
      return {
        id: `store-replica:v1:${fingerprint}:${occurrence}`,
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
    const byPath = (left.workspacePaths[0] ?? '').localeCompare(right.workspacePaths[0] ?? '');
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
      .sort((left, right) => (left.chatDir ?? '').localeCompare(right.chatDir ?? ''))
      .map((candidate) =>
        storeSourceInstance(
          'store-metadata',
          candidate.workspacePath,
          candidate.chatDir === selected.chatDir ? 'contributed' : 'equivalent-replica'
        )
      )
  );
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
  const ordered = [...candidates].sort((left, right) => left.path.localeCompare(right.path));
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

function ambiguousStoreProjection(
  catalog: ReturnType<typeof buildSessionCatalog<unknown>>[number],
  divergence: Awaited<ReturnType<typeof reconcileReplicaGroup<unknown>>> & { state: 'divergent' }
): StoreSession {
  const projected = projectAmbiguousSessionSummary(catalog, [divergence], {
    index: 0,
    indexScope: 'global',
  });
  return projected as unknown as StoreSession;
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
        dbPaths: [],
        transcriptInventoried: false,
        transcriptPaths: [],
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
    const metaRead = readMeta(join(sessionDir, 'meta.json'), signal, io, uuid);
    const dbPath = join(sessionDir, 'store.db');
    const dbInventoried = pathExists(dbPath, signal, io, 'store-session-metadata', uuid);
    recordInventory(evidenceFor(uuid), metaRead, sessionDir, dbPath, dbInventoried);

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
      const metaRead = readMeta(join(sessionDir, 'meta.json'), signal, io, uuid);
      const dbPath = join(sessionDir, 'store.db');
      const dbInventoried = pathExists(dbPath, signal, io, 'store-session-metadata', uuid);
      recordInventory(evidenceFor(uuid), metaRead, sessionDir, dbPath, dbInventoried);
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
            evidenceFor(uuid).transcriptInventoried = true;
            if (!evidenceFor(uuid).transcriptPaths.includes(nested)) {
              evidenceFor(uuid).transcriptPaths.push(nested);
            }
            if (options.metadataOnly) {
              attachTranscriptInventory(byId, uuid, nested);
            } else {
              attachTranscript(
                byId,
                selectedTranscriptFailures,
                transcriptCandidates,
                uuid,
                nested,
                limits,
                signal,
                io
              );
            }
          }
        } else if (entry.name.endsWith('.jsonl')) {
          const uuid = entry.name.slice(0, -'.jsonl'.length);
          if (selectedSessionIds && !selectedSessionIds.has(uuid)) continue;
          evidenceFor(uuid).transcriptInventoried = true;
          const transcriptPath = join(transcriptDir, entry.name);
          if (!evidenceFor(uuid).transcriptPaths.includes(transcriptPath)) {
            evidenceFor(uuid).transcriptPaths.push(transcriptPath);
          }
          if (options.metadataOnly) {
            attachTranscriptInventory(byId, uuid, transcriptPath);
          } else {
            attachTranscript(
              byId,
              selectedTranscriptFailures,
              transcriptCandidates,
              uuid,
              transcriptPath,
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
    if (!ss.storeDbPath && evidence.dbPaths.length > 0) {
      ss.storeDbPath = [...evidence.dbPaths].sort()[0];
    }
  }

  if (options.metadataOnly) {
    const metadataRows: StoreSession[] = [];
    for (const ss of byId.values()) {
      throwIfAborted(signal);
      const evidence = evidenceFor(ss.id);
      ss.storeDbExpectation = classifyStoreDbExpectation(evidence, perSessionInventoryComplete);
      ss.source = evidence.transcriptInventoried ? 'transcript' : 'store';
      ss.resolvedSource = 'store-metadata';
      if (evidence.metadataFailures.length > 0) {
        ss.diagnostics = evidence.metadataFailures.map((error) =>
          toSessionDiagnostic(error, ss.id)
        );
        for (const diagnostic of ss.diagnostics) options.onDiagnostic?.(diagnostic);
      }
      const metadata = metadataCandidates.get(ss.id) ?? [];
      if (evidence.dbPaths.length > 0) {
        ss.sourceInstances = canonicalSourceInstances([
          ...[...evidence.dbPaths]
            .sort()
            .map((_path, index) =>
              storeSourceInstance(
                'store-db',
                ss.workspacePath,
                index === 0 ? 'contributed' : 'superseded'
              )
            ),
          ...[...evidence.transcriptPaths]
            .sort()
            .map(() => storeSourceInstance('store-transcript', ss.workspacePath, 'superseded')),
        ]);
      } else if (evidence.transcriptPaths.length > 0) {
        ss.sourceInstances = canonicalSourceInstances(
          [...evidence.transcriptPaths]
            .sort()
            .map((_path, index) =>
              storeSourceInstance(
                'store-transcript',
                ss.workspacePath,
                index === 0 ? 'contributed' : 'superseded'
              )
            )
        );
      } else if (metadata.length > 0) {
        ss.sourceInstances = metadataSourceInstances(ss, metadata);
      }
      resolveStoreSessionTimestamps(ss);
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

    // Retain typed parser failures until both representations are known. A
    // partial outcome is safe only when the other representation contributed
    // real conversation content; otherwise the same failure is promoted to a
    // fatal operation error instead of publishing an empty/truncated session.
    const dbCandidates: StoreDbCandidate[] = [];
    for (const path of [...evidence.dbPaths].sort()) {
      const failures: TranscriptSourceFailure[] = [];
      const parsed = await parseStoreDb(path, {
        limits,
        failureOutcome: 'partial',
        onDiagnostic: (error) => failures.push(error),
        sqliteDriver: options.sqliteDriver,
        signal,
        io,
        logicalSessionId: ss.id,
      });
      dbCandidates.push({ path, parsed, failures });
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
          workspacePath: ss.workspacePath,
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
        resolved.push(
          ambiguousStoreProjection(
            physical.catalog as ReturnType<typeof buildSessionCatalog<unknown>>[number],
            reconciliation as Awaited<ReturnType<typeof reconcileReplicaGroup<unknown>>> & {
              state: 'divergent';
            }
          )
        );
        continue;
      }
      selectedDbCandidate = physical.valueByKey.get(reconciliation.selected.instanceKey)!;
      dbReplicaInstances = [...reconciliation.sourceInstances];
    } else if (selectedDbCandidate?.parsed && selectedDbCandidate.parsed.messages.length > 0) {
      dbReplicaInstances = [storeSourceInstance('store-db', ss.workspacePath, 'contributed')];
    }
    for (const candidate of usableDbCandidates) {
      if (selectedDbTier.includes(candidate)) continue;
      dbReplicaInstances.push(storeSourceInstance('store-db', ss.workspacePath, 'superseded'));
    }
    for (const candidate of dbCandidates) {
      if (candidate.parsed && candidate.parsed.messages.length > 0) continue;
      dbReplicaInstances.push(storeSourceInstance('store-db', ss.workspacePath, 'failed'));
    }
    const deep = selectedDbCandidate?.parsed ?? null;
    const dbFailures = [...(selectedDbCandidate?.failures ?? [])];
    if (selectedDbCandidate) ss.storeDbPath = selectedDbCandidate.path;

    const dbUsable = Boolean(deep && deep.messages.length > 0);
    const sessionTranscriptCandidates = transcriptCandidates.get(ss.id) ?? [];
    let transcriptReplicaInstances: SessionSourceInstance[] = [];
    if (dbUsable) {
      transcriptReplicaInstances = sessionTranscriptCandidates.map(() =>
        storeSourceInstance('store-transcript', ss.workspacePath, 'superseded')
      );
    } else if (sessionTranscriptCandidates.length > 0) {
      const bestStateRank = Math.max(
        ...sessionTranscriptCandidates.map(({ parsed }) => TRANSCRIPT_STATE_RANK[parsed.state])
      );
      const bestState = sessionTranscriptCandidates.filter(
        ({ parsed }) => TRANSCRIPT_STATE_RANK[parsed.state] === bestStateRank
      );
      const bestMessageCount = Math.max(...bestState.map(({ parsed }) => parsed.messages.length));
      const selectedTranscriptTier = bestState.filter(
        ({ parsed }) => parsed.messages.length === bestMessageCount
      );
      let selectedTranscript = selectedTranscriptTier[0]!;
      if (selectedTranscriptTier.length > 1) {
        const fidelity = selectedTranscript.parsed.state === 'parsed' ? 'complete' : 'partial';
        const physical = physicalStoreCandidates(
          ss.id,
          'store-transcript',
          fidelity,
          selectedTranscriptTier.map((candidate) => ({
            path: candidate.path,
            workspacePath: ss.workspacePath,
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
          resolved.push(
            ambiguousStoreProjection(
              physical.catalog as ReturnType<typeof buildSessionCatalog<unknown>>[number],
              reconciliation as Awaited<ReturnType<typeof reconcileReplicaGroup<unknown>>> & {
                state: 'divergent';
              }
            )
          );
          continue;
        }
        selectedTranscript = physical.valueByKey.get(reconciliation.selected.instanceKey)!;
        transcriptReplicaInstances = [...reconciliation.sourceInstances];
      } else {
        transcriptReplicaInstances = [
          storeSourceInstance('store-transcript', ss.workspacePath, 'contributed'),
        ];
      }
      for (const candidate of sessionTranscriptCandidates) {
        if (selectedTranscriptTier.includes(candidate)) continue;
        transcriptReplicaInstances.push(
          storeSourceInstance('store-transcript', ss.workspacePath, 'superseded')
        );
      }
      ss.transcriptState = selectedTranscript.parsed.state;
      ss.transcriptPath = selectedTranscript.path;
      ss.messages = selectedTranscript.parsed.messages;
      ss.messageIdentityEvidence = selectedTranscript.parsed.messageIdentityEvidence;
      ss.rawContentBlockEvidence = selectedTranscript.parsed.rawContentBlockEvidence;
      selectedTranscriptFailures.set(
        ss.id,
        selectedTranscript.parsed.diagnostic ? [selectedTranscript.parsed.diagnostic] : []
      );
    }

    const transcriptFailures = selectedTranscriptFailures.get(ss.id) ?? [];
    const transcriptUsable = ss.messages.length > 0;
    if (deep?.rawContentBlockEvidence.length) {
      ss.rawContentBlockEvidence = [
        ...(ss.rawContentBlockEvidence ?? []),
        ...deep.rawContentBlockEvidence,
      ];
    }
    const retainedSourceFailure = retainSafeSourceFailures(
      ss,
      evidence.metadataFailures,
      transcriptFailures,
      dbFailures,
      transcriptUsable,
      dbUsable,
      options.onDiagnostic
    );

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
      ]);
      if (deep.completeness === 'complete' && !retainedSourceFailure) {
        setResolution(ss, 'complete', []);
      } else {
        setResolution(ss, 'partial', [
          ...(deep.completeness === 'complete' ? [] : (['source-partial'] as const)),
          ...(retainedSourceFailure ? (['source-read-failed'] as const) : []),
        ]);
      }
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
      ]);
      setResolution(ss, reasons.length === 0 ? 'complete' : 'partial', reasons);
      resolveStoreSessionTimestamps(ss);
      logStoreResolution(ss, dbState, ss.storeDbPath ? 'fallback' : 'only-source');
      resolved.push(ss);
      continue;
    }

    const explicitNoConversation =
      expectation === 'not-expected' &&
      evidence.hasConversationFalse &&
      !evidence.hasConversationTrue;
    const positiveConversationEvidence =
      evidence.dbInventoried ||
      evidence.transcriptInventoried ||
      evidence.hasConversationTrue ||
      expectation === 'unknown';

    if (explicitNoConversation && !positiveConversationEvidence) {
      logStoreResolution(ss, dbState, 'unused', 'omitted');
      continue;
    }

    ss.messages = [];
    ss.messageIdentityEvidence = [];
    ss.resolvedSource = 'store-metadata';
    const metadata = metadataCandidates.get(ss.id) ?? [];
    if (metadata.length > 0) ss.sourceInstances = metadataSourceInstances(ss, metadata);
    setResolution(ss, 'partial', ['store-conversation-unavailable']);
    resolveStoreSessionTimestamps(ss);
    logStoreResolution(ss, dbState, 'unused');
    resolved.push(ss);
  }

  return resolved;
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
  metaRead: MetaReadResult,
  _sessionDir: string,
  dbPath: string,
  dbInventoried: boolean
): void {
  evidence.perSessionDirectory = true;
  evidence.metadataPresent ||= metaRead.present;
  evidence.hasConversationTrue ||= metaRead.hasConversation === true;
  evidence.hasConversationFalse ||= metaRead.hasConversation === false;
  evidence.unsupportedExpectationMetadata ||= metaRead.unsupportedExpectationMetadata;
  if (metaRead.diagnostic) evidence.metadataFailures.push(metaRead.diagnostic);
  if (dbInventoried) {
    evidence.dbInventoried = true;
    if (!evidence.dbPaths.includes(dbPath)) evidence.dbPaths.push(dbPath);
  }
}

function setResolution(
  ss: StoreSession,
  state: 'complete' | 'partial',
  reasonCodes: ResolutionReasonCode[]
): void {
  ss.source = state === 'complete' ? 'global' : 'workspace-fallback';
  ss.resolution = {
    state,
    expectedSourceRoles: ['store'],
    loadedSourceRoles: ['store'],
    omittedSourceRoles: [],
    failedSourceRoles: [],
    reasonCodes: [...new Set(reasonCodes)],
  };
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
  transcriptUsable: boolean,
  dbUsable: boolean,
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void
): boolean {
  const transcriptSafe = transcriptUsable && transcriptFailures.length === 0;
  const dbSafe = dbUsable && dbFailures.length === 0;
  if (metadataFailures.length > 0 && !transcriptSafe && !dbSafe) {
    throw promoteSourceFailure(metadataFailures[0]!);
  }
  if (transcriptFailures.length > 0 && !dbSafe) {
    throw promoteSourceFailure(transcriptFailures[0]!);
  }
  if (dbFailures.length > 0 && !transcriptSafe) {
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
  limits: ReturnType<typeof resolveSourceReadLimits>,
  signal?: AbortSignal,
  io?: OperationIoContext
): void {
  throwIfAborted(signal);
  const parsed = parseTranscriptFile(file, limits, 'partial', signal, io, uuid);
  const candidates = candidatesById.get(uuid) ?? [];
  candidates.push({ path: file, parsed });
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
    workspacePath: undefined,
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
        .sort(),
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
        a.name.localeCompare(b.name)
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
  logicalSessionId?: string
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
    parsed = JSON.parse(decodeDeterministicUtf8(raw, 'jsonl', 'partial').text) as unknown;
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
  if (typeof record['title'] === 'string') meta.title = record['title'];
  if (isValidMs(record['createdAtMs'])) meta.createdAtMs = record['createdAtMs'];
  if (isValidMs(record['updatedAtMs'])) meta.updatedAtMs = record['updatedAtMs'];

  return {
    meta,
    present: true,
    hasConversation,
    unsupportedExpectationMetadata,
  };
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
  return (candidate.chatDir ?? '') < (existing.chatDir ?? '');
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
