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
import { decodeDeterministicUtf8, resolveSourceReadLimits } from '../source-read-limits.js';
import type {
  ResolutionReasonCode,
  SessionDiagnostic,
  SourceReadLimitsOverride,
} from '../types.js';
import { acpSessionsDir, chatsDir, projectsDir } from './paths.js';
import { parseStoreDb } from './store-db.js';
import { parseTranscriptFile, type TranscriptSourceFailure } from './transcript.js';
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
  /** Receives only safe typed diagnostics (never a locator or content). */
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
}

interface InventoryEvidence {
  perSessionDirectory: boolean;
  metadataPresent: boolean;
  dbInventoried: boolean;
  dbPaths: string[];
  transcriptInventoried: boolean;
  hasConversationTrue: boolean;
  hasConversationFalse: boolean;
  unsupportedExpectationMetadata: boolean;
}

interface MetaReadResult {
  meta?: StoreMetaJson;
  present: boolean;
  hasConversation?: boolean;
  unsupportedExpectationMetadata: boolean;
}

interface DirectoryListing<T> {
  entries: T[];
  complete: boolean;
}

/** Best-effort error message for debug diagnostics. */
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function discoverStoreSessions(
  storeRoot: string,
  options: StoreDiscoveryOptions = {}
): Promise<StoreSession[]> {
  // Validation is deliberately the first operation: invalid caller policy
  // must fail before even a payload-presence check can trigger source I/O.
  const limits = resolveSourceReadLimits(options.sourceReadLimits);
  const byId = new Map<string, StoreSession>();
  const inventory = new Map<string, InventoryEvidence>();
  const selectedTranscriptFailures = new Map<string, TranscriptSourceFailure[]>();
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
        hasConversationTrue: false,
        hasConversationFalse: false,
        unsupportedExpectationMetadata: false,
      };
      inventory.set(uuid, value);
    }
    return value;
  };

  // 1. chats/ metadata inventory.
  const chats = chatsDir(storeRoot);
  if (pathExists(chats)) {
    const hashListing = listDirs(chats);
    perSessionInventoryComplete &&= hashListing.complete;
    for (const hash of hashListing.entries) {
      const sessionListing = listDirs(join(chats, hash));
      perSessionInventoryComplete &&= sessionListing.complete;
      for (const uuid of sessionListing.entries) {
        const sessionDir = join(chats, hash, uuid);
        const metaRead = readMeta(join(sessionDir, 'meta.json'));
        const dbPath = join(sessionDir, 'store.db');
        const dbInventoried = pathExists(dbPath);
        recordInventory(evidenceFor(uuid), metaRead, sessionDir, dbPath, dbInventoried);

        const meta = metaRead.meta;
        const createdAt = isValidMs(meta?.createdAtMs)
          ? new Date(meta.createdAtMs)
          : (readMtime(sessionDir) ?? new Date(0));
        const hasExplicitUpdatedAt = isValidMs(meta?.updatedAtMs);
        const updatedAt = hasExplicitUpdatedAt ? new Date(meta!.updatedAtMs!) : createdAt;
        const candidate = emptyStoreSession({
          id: uuid,
          workspacePath: meta?.cwd,
          title: meta?.title ?? null,
          createdAt,
          lastUpdatedAt: updatedAt,
          storeDbPath: dbInventoried ? dbPath : undefined,
          chatDir: sessionDir,
        });
        selectMetadataCandidate(byId, candidate, hasExplicitUpdatedAt, explicitUpdatedAt);
      }
    }
  }

  // 2. ACP metadata inventory.
  const acp = acpSessionsDir(storeRoot);
  if (pathExists(acp)) {
    const sessionListing = listDirs(acp);
    perSessionInventoryComplete &&= sessionListing.complete;
    for (const uuid of sessionListing.entries) {
      const sessionDir = join(acp, uuid);
      const metaRead = readMeta(join(sessionDir, 'meta.json'));
      const dbPath = join(sessionDir, 'store.db');
      const dbInventoried = pathExists(dbPath);
      recordInventory(evidenceFor(uuid), metaRead, sessionDir, dbPath, dbInventoried);
      const createdAt = readMtime(sessionDir) ?? new Date(0);
      const candidate = emptyStoreSession({
        id: uuid,
        workspacePath: metaRead.meta?.cwd,
        title: metaRead.meta?.title ?? null,
        createdAt,
        lastUpdatedAt: createdAt,
        storeDbPath: dbInventoried ? dbPath : undefined,
        chatDir: sessionDir,
      });
      selectMetadataCandidate(byId, candidate, false, explicitUpdatedAt);
    }
  }

  // 3. Canonical transcript inventory and bounded parse.
  const projects = projectsDir(storeRoot);
  if (pathExists(projects)) {
    const projectListing = listDirs(projects);
    for (const sanitized of projectListing.entries) {
      const transcriptDir = join(projects, sanitized, 'agent-transcripts');
      if (!pathExists(transcriptDir)) continue;
      const transcriptListing = listEntries(transcriptDir);
      for (const entry of transcriptListing.entries) {
        if (entry.isDirectory()) {
          const uuid = entry.name;
          const nested = join(transcriptDir, uuid, `${uuid}.jsonl`);
          if (pathExists(nested)) {
            evidenceFor(uuid).transcriptInventoried = true;
            attachTranscript(byId, selectedTranscriptFailures, uuid, nested, limits);
          }
        } else if (entry.name.endsWith('.jsonl')) {
          const uuid = entry.name.slice(0, -'.jsonl'.length);
          evidenceFor(uuid).transcriptInventoried = true;
          attachTranscript(
            byId,
            selectedTranscriptFailures,
            uuid,
            join(transcriptDir, entry.name),
            limits
          );
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

  // 4. Exhaustive representation selection.
  const resolved: StoreSession[] = [];
  for (const ss of byId.values()) {
    const evidence = evidenceFor(ss.id);
    const expectation = classifyStoreDbExpectation(evidence, perSessionInventoryComplete);
    ss.storeDbExpectation = expectation;

    // Retain typed parser failures until both representations are known. A
    // partial outcome is safe only when the other representation contributed
    // real conversation content; otherwise the same failure is promoted to a
    // fatal operation error instead of publishing an empty/truncated session.
    const dbFailures: TranscriptSourceFailure[] = [];
    const deep = ss.storeDbPath
      ? await parseStoreDb(ss.storeDbPath, {
          limits,
          failureOutcome: 'partial',
          onDiagnostic: (error) => dbFailures.push(error),
        })
      : null;

    const transcriptFailures = selectedTranscriptFailures.get(ss.id) ?? [];
    const transcriptUsable = ss.messages.length > 0;
    const dbUsable = Boolean(deep && deep.messages.length > 0);
    if (deep?.rawContentBlockEvidence.length) {
      ss.rawContentBlockEvidence = [
        ...(ss.rawContentBlockEvidence ?? []),
        ...deep.rawContentBlockEvidence,
      ];
    }
    retainSafeSourceFailures(
      ss,
      transcriptFailures,
      dbFailures,
      transcriptUsable,
      dbUsable,
      options.onDiagnostic
    );

    if (deep?.title) ss.title = deep.title;
    if (deep?.createdAt) {
      ss.createdAt = deep.createdAt;
      if (!explicitUpdatedAt.has(ss.id)) ss.lastUpdatedAt = deep.createdAt;
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
      if (deep.completeness === 'complete') {
        setResolution(ss, 'complete', []);
      } else {
        setResolution(ss, 'partial', ['source-partial']);
      }
      logStoreResolution(ss, dbState, 'unused');
      resolved.push(ss);
      continue;
    }

    if (transcriptUsable) {
      const reasons: ResolutionReasonCode[] = [];
      if (expectation === 'expected') reasons.push('expected-store-db-unavailable');
      if (expectation === 'unknown') reasons.push('store-db-expectation-unknown');
      if (ss.transcriptState !== 'parsed') reasons.push('source-partial');
      ss.resolvedSource = 'store-transcript';
      setResolution(ss, reasons.length === 0 ? 'complete' : 'partial', reasons);
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
    setResolution(ss, 'partial', ['store-conversation-unavailable']);
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
    'id' | 'workspacePath' | 'title' | 'createdAt' | 'lastUpdatedAt' | 'storeDbPath' | 'chatDir'
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
  transcriptFailures: readonly TranscriptSourceFailure[],
  dbFailures: readonly TranscriptSourceFailure[],
  transcriptUsable: boolean,
  dbUsable: boolean,
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void
): void {
  const transcriptSafe = transcriptUsable && transcriptFailures.length === 0;
  const dbSafe = dbUsable && dbFailures.length === 0;
  if (transcriptFailures.length > 0 && !dbSafe) {
    throw promoteSourceFailure(transcriptFailures[0]!);
  }
  if (dbFailures.length > 0 && !transcriptSafe) {
    throw promoteSourceFailure(dbFailures[0]!);
  }

  const diagnostics = [...transcriptFailures, ...dbFailures].map((error) =>
    toSessionDiagnostic(error, session.id)
  );
  if (diagnostics.length === 0) return;
  session.diagnostics = [...(session.diagnostics ?? []), ...diagnostics];
  for (const diagnostic of diagnostics) onDiagnostic?.(diagnostic);
}

function attachTranscript(
  byId: Map<string, StoreSession>,
  selectedFailures: Map<string, TranscriptSourceFailure[]>,
  uuid: string,
  file: string,
  limits: ReturnType<typeof resolveSourceReadLimits>
): void {
  const parsed = parseTranscriptFile(file, limits, 'partial');
  const modifiedAt = readMtime(file) ?? new Date(0);
  const existing = byId.get(uuid);
  const failures = parsed.diagnostic ? [parsed.diagnostic] : [];

  if (existing) {
    if (
      !shouldReplaceTranscript(existing, parsed.state, parsed.messages.length, modifiedAt, file)
    ) {
      return;
    }
    existing.transcriptState = parsed.state;
    existing.transcriptPath = file;
    existing.messages = parsed.messages;
    existing.messageIdentityEvidence = parsed.messageIdentityEvidence;
    existing.rawContentBlockEvidence = parsed.rawContentBlockEvidence;
    selectedFailures.set(uuid, failures);
    if (!existing.chatDir) {
      existing.createdAt = modifiedAt;
      existing.lastUpdatedAt = modifiedAt;
    }
    return;
  }

  byId.set(uuid, {
    id: uuid,
    workspacePath: undefined,
    title: null,
    createdAt: modifiedAt,
    lastUpdatedAt: modifiedAt,
    messages: parsed.messages,
    messageIdentityEvidence: parsed.messageIdentityEvidence,
    rawContentBlockEvidence: parsed.rawContentBlockEvidence,
    source: 'workspace-fallback',
    transcriptState: parsed.state,
    transcriptPath: file,
  });
  selectedFailures.set(uuid, failures);
}

/** Prefer state, then message count, then recency; path is a stable tie-breaker. */
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
  if (rank[candidateState] !== rank[existing.transcriptState]) {
    return rank[candidateState] > rank[existing.transcriptState];
  }
  if (candidateMessageCount !== existing.messages.length) {
    return candidateMessageCount > existing.messages.length;
  }
  const existingModifiedAt = readMtime(existing.transcriptPath)?.getTime() ?? 0;
  if (candidateModifiedAt.getTime() !== existingModifiedAt) {
    return candidateModifiedAt.getTime() > existingModifiedAt;
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

function listDirs(dir: string): DirectoryListing<string> {
  try {
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

function listEntries(dir: string): DirectoryListing<Dirent> {
  try {
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

function readMeta(path: string): MetaReadResult {
  let raw: Buffer;
  try {
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
    if (error instanceof SyntaxError || error instanceof SourceEncodingError) {
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

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isAbsentOrWrongType(error)) return false;
    throw error;
  }
}

function readMtime(path: string): Date | undefined {
  try {
    return statSync(path).mtime ?? undefined;
  } catch (error) {
    if (isAbsentOrWrongType(error)) return undefined;
    throw error;
  }
}

function isAbsentOrWrongType(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
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
  target.lastUpdatedAt = source.lastUpdatedAt;
  target.storeDbPath = source.storeDbPath;
  target.chatDir = source.chatDir;
}
