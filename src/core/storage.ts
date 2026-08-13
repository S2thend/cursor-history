/**
 * Storage discovery and database access for Cursor chat history
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openDatabase as openDatabaseAsync,
  openDatabaseReadWrite as openDatabaseReadWriteAsync,
  DriverNotAvailableError,
  NoDriverAvailableError,
  type Database,
  type DatabaseCapability,
  type DatabaseOperationRequest,
  type DriverName,
} from './database/index.js';
import type {
  Workspace,
  ChatSession,
  ChatSessionSummary,
  ListOptions,
  Message,
  MessageTimestampSource,
  SearchOptions,
  SearchResult,
  SourceReadLimitsV1,
  SourceReadLimitsOverride,
  TokenUsage,
  ToolCall,
  SessionUsage,
  ContextWindowStatus,
  AmbiguousSessionSummary,
  LogicalSessionSummary,
  ResolutionReasonCode,
  SessionResolution,
  SourceRole,
} from './types.js';
import {
  getCursorDataPath,
  getGlobalStoragePath,
  contractPath,
  normalizePath,
  pathsEqual,
  getStoreStackRoot,
  detectPreferredStackSource,
} from '../lib/platform.js';
import { SessionNotFoundError } from '../lib/errors.js';
import {
  parseChatData,
  getSearchSnippets,
  mapStoreSession,
  resolveComposerMessageIdentities,
  type CursorChatBundle,
} from './parser.js';
import {
  BackupEntryNotFoundError,
  openBackupDatabase,
  readBackupEntryBuffer,
  readBackupManifest,
} from './backup.js';
import { ZipArchiveFormatError } from './zip-stream.js';
import { debugLogStorage } from './database/debug.js';
import { discoverStoreSessions, getStorePhysicalOccurrences } from './store-stack/discover.js';
import type { StorePhysicalOccurrence, StoreSession } from './store-stack/types.js';
import { mergeCrossStackSessions, applyStoreMergeToSummary } from './store-stack/merge.js';
import {
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  decodeDeterministicUtf8,
  resolveSourceReadLimits,
} from './source-read-limits.js';
import {
  createComposerSqliteBudget,
  forEachBoundedComposerBubbleMetadata,
  forEachBoundedComposerBubbleValue,
  forEachBoundedComposerMetadata,
  forEachBoundedComposerValue,
  getBoundedComposerMetadataByKey,
  readBoundedComposerValueByKey,
  readFirstBoundedComposerBubbleValue,
  sqliteLikeLiteralPrefix,
  type ComposerSqliteMetadata,
} from './composer-sqlite.js';
import {
  isSessionIntegrityError,
  SessionAmbiguityError,
  ReadContextDisposedError,
  ReadContextOptionsMismatchError,
  ReadContextScopeMismatchError,
  ReadContextSourceMismatchError,
} from './errors.js';
import {
  buildSessionCatalog,
  projectAmbiguousSessionSummary,
  reconcileReplicaGroup,
  type PhysicalSessionInstance,
  type ReplicaConsumedPayload,
} from './session-catalog.js';
import { projectV016ComposerMessages } from './session-identity.js';
import {
  normalizeWorkspacePath,
  resolveWorkspaceScope,
  type WorkspaceScopeResult,
} from './workspace-scope.js';
import {
  createOperationIoContext,
  IoObserverError,
  observeAdapterIo,
  type AdapterIoEventInput,
  type AdapterIoObserver,
  type OperationIoContext,
} from './io-observer.js';
import {
  isValidTimestamp,
  resolveMessageTimestamps,
  resolveSessionTimestamps,
  type ResolvedSessionTimestamps,
  type SessionMetadataTimestamps,
} from './timestamps.js';

export interface ContextOwnershipSnapshot {
  readonly resolvedSessionCapacity: number;
  readonly activeResolutions: number;
  readonly completedSessions: number;
  readonly discoveryDecodedSessions: number;
  readonly ownedDecodedSessions: number;
  readonly resolutionStarts: number;
}

export interface StorageReadOperationOptions {
  readonly sqliteDriver?: DriverName;
  readonly sourceReadLimits?: SourceReadLimitsOverride | Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
  /** Internal/test-only low-level adapter observer. */
  readonly ioObserver?: AdapterIoObserver;
  /** Immutable operation context inherited by nested adapters. */
  readonly io?: OperationIoContext;
  /** Reviewed default classification for an opened SQLite source. */
  readonly ioResource?: DatabaseOperationRequest['ioResource'];
  /** Full normalized Composer workspace selected before payload discovery. */
  readonly workspaceFilterPath?: string;
  /** Immutable workspace request bound at context construction. */
  readonly workspacePath?: string;
  /** Permit contributors outside scope only for logical IDs selected in scope. */
  readonly includeCrossWorkspaceSources?: boolean;
  /** Maximum completed decoded sessions retained by the context. */
  readonly resolvedSessionCapacity?: number;
  /** Safe continuation diagnostic sink owned by the top-level operation. */
  readonly onDiagnostic?: (diagnostic: import('./types.js').SessionDiagnostic) => void;
  /** Internal ownership-bound observer used only by regression tests. */
  readonly testOnlyOnOwnershipChange?: (snapshot: Readonly<ContextOwnershipSnapshot>) => void;
}

export interface SessionReadContextOptions extends StorageReadOperationOptions {
  readonly dataPath?: string;
  readonly backupPath?: string;
}

const SESSION_READ_CAPABILITIES = new Set<DatabaseCapability>(['read']);
const MIGRATION_CAPABILITIES = new Set<DatabaseCapability>(['readWrite']);
const OWNING_DATABASE_READ_FAILURES = new WeakSet<object>();

function sessionReadRequest(
  sqliteDriver?: DriverName,
  io?: OperationIoContext,
  ioResource: DatabaseOperationRequest['ioResource'] = {
    resourceClass: 'unclassified-resource',
  }
): DatabaseOperationRequest {
  return {
    operation: 'read-session',
    required: SESSION_READ_CAPABILITIES,
    ...(sqliteDriver ? { forcedDriver: sqliteDriver } : {}),
    ...(io ? { io } : {}),
    ioResource,
  };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error('The session read operation was aborted.', {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
  error.name = 'AbortError';
  return error;
}

function throwIfReadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Copy and validate operation options before the first await or source probe. */
function bindStorageReadOptions(
  options: StorageReadOperationOptions = {}
): Readonly<StorageReadOperationOptions> {
  const sourceReadLimits =
    options.sourceReadLimits === undefined
      ? undefined
      : resolveSourceReadLimits(options.sourceReadLimits);
  throwIfReadAborted(options.signal);
  return Object.freeze({
    ...(options.sqliteDriver ? { sqliteDriver: options.sqliteDriver } : {}),
    ...(sourceReadLimits ? { sourceReadLimits } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.io ? { io: options.io } : {}),
    ...(options.ioResource ? { ioResource: options.ioResource } : {}),
    ...(options.workspaceFilterPath
      ? { workspaceFilterPath: normalizeWorkspacePath(options.workspaceFilterPath) }
      : {}),
  });
}

function withDatabaseIo(
  options: StorageReadOperationOptions | undefined,
  ioResource: NonNullable<DatabaseOperationRequest['ioResource']>
): StorageReadOperationOptions {
  return {
    ...(options?.sqliteDriver ? { sqliteDriver: options.sqliteDriver } : {}),
    ...(options?.sourceReadLimits ? { sourceReadLimits: options.sourceReadLimits } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.io ? { io: options.io } : {}),
    ...(options?.workspaceFilterPath ? { workspaceFilterPath: options.workspaceFilterPath } : {}),
    ioResource,
  };
}

function observeStorageAdapterIo(
  options: Pick<StorageReadOperationOptions, 'io'> | undefined,
  input: AdapterIoEventInput
): void {
  if (options?.io) observeAdapterIo(options.io, input);
}

/** Infrastructure/cancellation failures must never become empty or partial reads. */
function shouldPropagateReadFailure(error: unknown): boolean {
  const code =
    error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined;
  return (
    isSessionIntegrityError(error) ||
    error instanceof IoObserverError ||
    (typeof error === 'object' && error !== null && OWNING_DATABASE_READ_FAILURES.has(error)) ||
    error instanceof ZipArchiveFormatError ||
    error instanceof DriverNotAvailableError ||
    error instanceof NoDriverAvailableError ||
    Boolean(code && /^(?:ERR_)?SQLITE_/i.test(code)) ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function throwOwningDatabaseReadFailure(error: unknown): never {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    OWNING_DATABASE_READ_FAILURES.add(error as object);
    throw error;
  }
  const wrapped = new Error('Cursor database query failed.', { cause: error });
  OWNING_DATABASE_READ_FAILURES.add(wrapped);
  throw wrapped;
}

/** A valid Cursor SQLite file may predate chat storage and omit ItemTable entirely. */
function isMissingItemTableError(error: unknown): boolean {
  return (
    error instanceof Error && /(?:no such table|does not exist).*\bItemTable\b/i.test(error.message)
  );
}

function attachReadFailureCause(error: unknown, cause: unknown): void {
  if (
    error instanceof Error &&
    cause !== undefined &&
    !Object.prototype.hasOwnProperty.call(error, 'cause')
  ) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
}

/**
 * Known SQLite keys for chat data (in priority order)
 */
const CHAT_DATA_KEYS = [
  'composer.composerData', // New Cursor format
  'workbench.panel.aichat.view.aichat.chatdata', // Legacy format
  'workbench.panel.chat.view.chat.chatdata', // Legacy format
];

/**
 * Keys for prompts and generations (new Cursor format)
 */
const PROMPTS_KEY = 'aiService.prompts';
const GENERATIONS_KEY = 'aiService.generations';

/**
 * Open a SQLite database file (read-only)
 * @deprecated Use openDatabaseAsync for new code
 */
export async function openDatabase(
  dbPath: string,
  options: StorageReadOperationOptions = {}
): Promise<Database> {
  throwIfReadAborted(options.signal);
  const db = await openDatabaseAsync(
    dbPath,
    sessionReadRequest(options.sqliteDriver, options.io, options.ioResource)
  );
  try {
    throwIfReadAborted(options.signal);
    return db;
  } catch (operationError) {
    closeDatabaseOrThrow(db, operationError);
    throw operationError;
  }
}

/**
 * Open a SQLite database file for read-write operations
 * IMPORTANT: Only use for migration operations. Requires Cursor to be closed.
 * @deprecated Use openDatabaseReadWriteAsync for new code
 */
export async function openDatabaseReadWrite(
  dbPath: string,
  options: Pick<StorageReadOperationOptions, 'sqliteDriver' | 'signal'> = {}
): Promise<Database> {
  throwIfReadAborted(options.signal);
  const db = await openDatabaseReadWriteAsync(dbPath, {
    operation: 'migrate',
    required: MIGRATION_CAPABILITIES,
    ...(options.sqliteDriver ? { forcedDriver: options.sqliteDriver } : {}),
  });
  try {
    throwIfReadAborted(options.signal);
    return db;
  } catch (operationError) {
    closeDatabaseOrThrow(db, operationError);
    throw operationError;
  }
}

interface ToolFormerAdditionalData {
  status?: string;
  userDecision?: string;
}

interface ToolFormerData {
  name?: string;
  params?: string;
  rawArgs?: string;
  result?: string;
  status?: string;
  additionalData?: ToolFormerAdditionalData;
}

interface BubbleRow {
  key: string;
  value: string | null;
}

interface GlobalComposerSummary {
  id: string;
  title: string | null;
  createdAt: Date;
  createdAtSource: ResolvedSessionTimestamps['createdAtSource'];
  lastUpdatedAt: Date;
  lastUpdatedAtSource: ResolvedSessionTimestamps['lastUpdatedAtSource'];
  messageCount: number;
  preview: string;
  workspacePath?: string;
}

type BubbleMessage = Omit<Message, 'timestamp'> & { timestamp: Date | null };

type ChatDataSource = 'allComposers' | 'selectedComposerIds';

interface ChatDataResult {
  data: string;
  bundle: CursorChatBundle;
}

interface WorkspaceGlobalCandidate {
  workspace: Workspace;
  composerIds: string[];
  existingIds: Set<string>;
  includeWorkspaceLinked: boolean;
}

interface GlobalComposerRecord {
  id: string;
  data: Record<string, unknown>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
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

function closeDatabase(db: Database | null): void {
  if (!db) {
    return;
  }

  try {
    db.close();
  } catch {
    // Ignore close failures during fallback handling.
  }
}

/**
 * Close a database whose lifecycle owns a private snapshot or other required
 * resource. Cleanup failures take precedence and retain the primary operation
 * failure as their cause instead of being swallowed by a fallback path.
 */
function closeDatabaseOrThrow(db: Database | null, operationError?: unknown): void {
  if (!db) return;
  try {
    db.close();
  } catch (closeError) {
    attachReadFailureCause(closeError, operationError);
    throw closeError;
  }
}

function getBubbleRowId(rowKey: string): string | null {
  return rowKey.split(':').pop() ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A composer entry carries real metadata when it has any field beyond `composerId`.
 * Synthetic `{ composerId }` stubs (fabricated from `selectedComposerIds` by
 * getComposerData) must never be persisted back into `allComposers`, or they would
 * parse to phantom sessions with a null title and a "now" timestamp.
 */
function isHydratedComposer(composer: { composerId?: string; [key: string]: unknown }): boolean {
  return Object.keys(composer).some((key) => key !== 'composerId');
}

function parseDateValue(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  // Epoch-ms timestamps can arrive as numeric strings ("1778672423842"); new Date()
  // treats those as invalid, so coerce all-digit strings to a number first.
  const normalized =
    typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function composerMetadataTimestamps(
  data: Readonly<Record<string, unknown>>
): SessionMetadataTimestamps {
  return {
    createdAt: parseDateValue(data['createdAt']),
    lastUpdatedAt: parseDateValue(data['lastUpdatedAt']) ?? parseDateValue(data['updatedAt']),
  };
}

function composerMetadataTimestampsFromJson(value: string | undefined): SessionMetadataTimestamps {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return composerMetadataTimestamps(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function composerMetadataTimestampsForSummary(
  value: string | undefined,
  summary: Pick<
    ChatSessionSummary,
    'createdAt' | 'createdAtSource' | 'lastUpdatedAt' | 'lastUpdatedAtSource'
  >
): SessionMetadataTimestamps {
  const stored = composerMetadataTimestampsFromJson(value);
  return {
    createdAt:
      stored.createdAt ??
      (summary.createdAtSource === 'composer-metadata' ? summary.createdAt : undefined),
    lastUpdatedAt:
      stored.lastUpdatedAt ??
      (summary.lastUpdatedAtSource === 'composer-metadata' ? summary.lastUpdatedAt : undefined),
  };
}

function uriToPath(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
}

function workspacePathMatches(candidatePath: unknown, workspacePath: string): boolean {
  return typeof candidatePath === 'string' && pathsEqual(uriToPath(candidatePath), workspacePath);
}

function composerBelongsToWorkspace(
  composerData: Record<string, unknown>,
  workspace: Workspace
): boolean {
  const workspaceIdentifier = composerData['workspaceIdentifier'];
  if (isRecord(workspaceIdentifier)) {
    if (workspaceIdentifier['id'] === workspace.id) {
      return true;
    }

    const uri = workspaceIdentifier['uri'];
    if (isRecord(uri)) {
      if (
        workspacePathMatches(uri['fsPath'], workspace.path) ||
        workspacePathMatches(uri['path'], workspace.path) ||
        workspacePathMatches(uri['external'], workspace.path)
      ) {
        return true;
      }
    }
  }

  return workspacePathMatches(composerData['workspaceUri'], workspace.path);
}

/** Whether a global composer record carries any explicit workspace attribution. */
function composerHasWorkspaceStamp(composerData: Record<string, unknown>): boolean {
  if (isRecord(composerData['workspaceIdentifier'])) {
    return true;
  }
  const workspaceUri = composerData['workspaceUri'];
  return typeof workspaceUri === 'string' && workspaceUri.length > 0;
}

/**
 * Best-effort workspace path for a global composer that is not attributed to any
 * discovered workspace, derived from whatever workspace metadata the record does
 * carry. Returns null when the record has no usable workspace hint.
 */
function workspacePathFromComposer(composerData: Record<string, unknown>): string | null {
  const workspaceIdentifier = composerData['workspaceIdentifier'];
  if (isRecord(workspaceIdentifier) && isRecord(workspaceIdentifier['uri'])) {
    const uri = workspaceIdentifier['uri'] as Record<string, unknown>;
    for (const field of ['fsPath', 'path', 'external'] as const) {
      const value = uri[field];
      if (typeof value === 'string' && value.length > 0) {
        return uriToPath(value);
      }
    }
  }
  const workspaceUri = composerData['workspaceUri'];
  if (typeof workspaceUri === 'string' && workspaceUri.length > 0) {
    return uriToPath(workspaceUri);
  }
  return null;
}

function extractComposerIdsFromData(
  dataText: string | undefined
): Array<{ composerId: string; source: ChatDataSource }> {
  if (!dataText) {
    return [];
  }

  try {
    const parsed = JSON.parse(dataText) as unknown;
    const ids = new Map<string, ChatDataSource>();

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        const composerId = (entry as { composerId?: unknown }).composerId;
        if (typeof composerId === 'string' && composerId.trim().length > 0) {
          ids.set(composerId, 'allComposers');
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      const allComposers = (parsed as { allComposers?: unknown }).allComposers;
      if (Array.isArray(allComposers)) {
        for (const entry of allComposers) {
          if (!entry || typeof entry !== 'object') continue;
          const composerId = (entry as { composerId?: unknown }).composerId;
          if (typeof composerId === 'string' && composerId.trim().length > 0) {
            ids.set(composerId, 'allComposers');
          }
        }
      }

      const selected = (parsed as { selectedComposerIds?: unknown }).selectedComposerIds;
      if (Array.isArray(selected)) {
        for (const composerId of selected) {
          if (
            typeof composerId === 'string' &&
            composerId.trim().length > 0 &&
            !ids.has(composerId)
          ) {
            ids.set(composerId, 'selectedComposerIds');
          }
        }
      }
    }

    return [...ids.entries()].map(([composerId, source]) => ({ composerId, source }));
  } catch {
    return [];
  }
}

const COMPOSER_GUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * Modern Cursor links a workspace to its agent/composer sessions through
 * per-workspace UI-state pointer keys (e.g. `workbench.panel.composerChatViewPane.<guid>`)
 * rather than stamping the workspace into the global composer record. Extract the
 * composer GUIDs referenced by those pointers so they can be resolved from global
 * storage. GUIDs that are not real composers simply resolve to nothing downstream.
 */
function getWorkspaceComposerPointerIds(
  db: Database,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): string[] {
  try {
    const ids = new Set<string>();
    forEachBoundedComposerValue(
      db,
      'ItemTable',
      '%composerChatViewPane%',
      budget,
      (row) => {
        for (const source of [row.key, row.value]) {
          const matches = source.match(COMPOSER_GUID_RE);
          if (matches) {
            for (const match of matches) {
              ids.add(match.toLowerCase());
            }
          }
        }
      },
      signal
    );
    return [...ids];
  } catch (error) {
    if (isMissingItemTableError(error)) return [];
    throwOwningDatabaseReadFailure(error);
  }
}

function parseToolParams(
  paramsText?: string,
  rawArgsText?: string
): Record<string, unknown> | undefined {
  const rawText = paramsText ?? rawArgsText;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve the raw payload below.
  }

  return { _raw: rawText };
}

function getParam(params: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!params) {
    return '';
  }

  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return '';
}

function getToolCallStatus(toolData: ToolFormerData): ToolCall['status'] {
  const statuses = [toolData.additionalData?.status, toolData.status];
  if (statuses.includes('error')) {
    return 'error';
  }
  if (statuses.includes('cancelled')) {
    return 'cancelled';
  }
  return 'completed';
}

function extractToolFiles(params: Record<string, unknown> | undefined): string[] | undefined {
  const candidates = [
    getParam(params, 'targetFile', 'file', 'filePath', 'relativeWorkspacePath'),
    getParam(params, 'path'),
    getParam(params, 'targetDirectory', 'directory'),
  ].filter((value) => value.length > 0);

  const files = [...new Set(candidates)];
  return files.length > 0 ? files : undefined;
}

function extractToolError(result: string): string {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    for (const key of ['error', 'message', 'stderr', 'output', 'resultForModel']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
  } catch {
    // Fall back to the raw string below.
  }

  return result;
}

export function extractToolCalls(data: Record<string, unknown>): ToolCall[] | undefined {
  const toolData = data['toolFormerData'] as ToolFormerData | undefined;
  const name = typeof toolData?.name === 'string' ? toolData.name.trim() : '';
  if (!name || !toolData) {
    return undefined;
  }

  const params = parseToolParams(toolData.params, toolData.rawArgs);
  const status = getToolCallStatus(toolData);
  const resultText =
    typeof toolData.result === 'string' && toolData.result.trim().length > 0
      ? toolData.result
      : undefined;

  const toolCall: ToolCall = {
    name,
    status,
  };

  if (params) {
    toolCall.params = params;
  }

  const files = extractToolFiles(params);
  if (files) {
    toolCall.files = files;
  }

  if (status === 'error' && resultText) {
    toolCall.error = extractToolError(resultText);
  } else if (status === 'completed' && resultText) {
    toolCall.result = resultText;
  }

  return [toolCall];
}

export function mapBubbleToMessage(row: BubbleRow): BubbleMessage {
  const corruptedMessage = (): BubbleMessage => ({
    id: getBubbleRowId(row.key),
    role: 'assistant',
    content: '[corrupted message]',
    timestamp: null,
    codeBlocks: [],
    metadata: { corrupted: true },
    source: 'composer',
  });

  if (row.value === null) {
    debugLogStorage(`Malformed bubble row ${row.key}: NULL payload`);
    return corruptedMessage();
  }

  let rawData: Record<string, unknown>;

  try {
    rawData = JSON.parse(row.value) as Record<string, unknown>;
  } catch (error) {
    debugLogStorage(`Malformed bubble row ${row.key}: ${getErrorMessage(error)}`);
    return corruptedMessage();
  }

  try {
    const data = rawData as RawBubbleData & {
      bubbleId?: string;
      createdAt?: string;
      type?: number;
    };
    const bubbleType = typeof data.type === 'number' ? data.type : undefined;
    const extractedContent = extractBubbleText(rawData);
    const metadata =
      bubbleType !== undefined
        ? {
            bubbleType,
          }
        : undefined;

    return {
      id: data.bubbleId ?? getBubbleRowId(row.key),
      role: bubbleType === 2 ? 'assistant' : 'user',
      content: extractedContent.length > 0 ? extractedContent : '[empty message]',
      timestamp: extractTimestamp(data),
      timestampSource: extractTimestampSource(data),
      codeBlocks: [],
      toolCalls: extractToolCalls(rawData),
      tokenUsage: extractTokenUsage(data),
      model: extractModelInfo(data),
      durationMs: extractTimingInfo(data),
      metadata,
      source: 'composer',
    };
  } catch (error) {
    debugLogStorage(`Failed to map bubble row ${row.key}: ${getErrorMessage(error)}`);
    return corruptedMessage();
  }
}

interface ComposerBubbleProjection extends ResolvedSessionTimestamps {
  messages: Message[];
}

function resolveBubbleMessages(
  bubbleRows: BubbleRow[],
  composerMetadata: SessionMetadataTimestamps = {}
): ComposerBubbleProjection {
  const messages = resolveComposerMessageIdentities(
    bubbleRows.map((row) => mapBubbleToMessage(row)) as Message[]
  );
  const sessionTimestamps = resolveSessionTimestamps({
    view: 'composer-backed',
    composerMetadata,
    directMessages: messages,
  });
  resolveMessageTimestamps(messages, {
    timestamp: sessionTimestamps.createdAt,
    source: sessionTimestamps.createdAtSource,
  });
  return { ...sessionTimestamps, messages };
}

function parseComposerSessionUsage(
  composerDataValue: string | undefined,
  messages: Array<{ tokenUsage?: TokenUsage }>
): SessionUsage | undefined {
  if (!composerDataValue) {
    return undefined;
  }

  try {
    const composerData = JSON.parse(composerDataValue) as RawComposerData;
    return extractSessionUsage(composerData, messages);
  } catch {
    return undefined;
  }
}

function extractActiveBranchBubbleIds(composerDataValue: string | undefined): string[] | undefined {
  if (!composerDataValue) {
    return undefined;
  }

  try {
    const composerData = JSON.parse(composerDataValue) as RawComposerData;
    if (!Array.isArray(composerData.fullConversationHeadersOnly)) {
      return undefined;
    }

    const bubbleIds = composerData.fullConversationHeadersOnly.flatMap((header) => {
      if (!header || typeof header !== 'object') {
        return [];
      }

      const bubbleId = (header as { bubbleId?: unknown }).bubbleId;
      if (typeof bubbleId !== 'string' || bubbleId.trim().length === 0) {
        return [];
      }

      return [bubbleId];
    });

    return bubbleIds.length > 0 ? bubbleIds : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Backup Data Source (T027)
// ============================================================================

/**
 * Workspace.json shape: folder (single-folder) or workspace (.code-workspace path)
 */
interface WorkspaceJsonShape {
  folder?: string;
  workspace?: string;
}

/**
 * Convert file:// URI from workspace.json to filesystem path
 */
function workspaceUriToPath(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''));
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
}

/**
 * Read workspace path from parsed workspace.json (folder or configuration).
 * Prefers workspace (.code-workspace path); falls back to folder for single-folder workspaces.
 */
function getWorkspacePathFromJson(data: WorkspaceJsonShape): string | null {
  if (data.workspace) {
    return workspaceUriToPath(data.workspace);
  }
  if (data.folder) {
    return workspaceUriToPath(data.folder);
  }
  return null;
}

/**
 * Read workspace.json from a backup zip file
 */
async function readWorkspaceJsonFromBackup(
  backupPath: string,
  workspaceId: string,
  readOptions: Readonly<StorageReadOperationOptions>
): Promise<string | null> {
  const jsonPath = `workspaceStorage/${workspaceId}/workspace.json`;
  const buffer = await readBackupEntryBuffer(backupPath, jsonPath, readOptions);
  throwIfReadAborted(readOptions.signal);
  if (!buffer) return null;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
  } catch {
    throw new ZipArchiveFormatError(
      `Backup workspace metadata for ${workspaceId} is not deterministic UTF-8.`
    );
  }
  let jsonData: WorkspaceJsonShape;
  try {
    jsonData = JSON.parse(content) as WorkspaceJsonShape;
  } catch (error) {
    throw new ZipArchiveFormatError(
      `Backup workspace metadata for ${workspaceId} is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return getWorkspacePathFromJson(jsonData);
}

/**
 * Find workspaces from a backup file
 * Note: This is async to ensure driver auto-selection happens first
 */
async function findWorkspacesFromBackup(
  backupPath: string,
  readOptions: Readonly<StorageReadOperationOptions>
): Promise<Workspace[]> {
  const manifest = await readBackupManifest(backupPath, readOptions);
  if (!manifest) {
    return [];
  }
  throwIfReadAborted(readOptions.signal);

  const workspaces: Workspace[] = [];

  // Find all workspace databases
  for (const file of manifest.files) {
    throwIfReadAborted(readOptions.signal);
    if (file.type !== 'workspace-db') continue;

    // Extract workspace ID from path: workspaceStorage/{id}/state.vscdb
    const match = file.path.match(/^workspaceStorage\/([^/]+)\/state\.vscdb$/);
    if (!match) continue;

    const workspaceId = match[1]!;
    // Try to get workspace path from workspace.json, fall back to workspace ID
    const workspacePath =
      (await readWorkspaceJsonFromBackup(backupPath, workspaceId, readOptions)) ??
      `(workspace: ${workspaceId})`;

    if (
      readOptions.workspaceFilterPath &&
      !pathsEqual(workspacePath, readOptions.workspaceFilterPath)
    ) {
      continue;
    }

    // Count sessions in this workspace
    let sessionCount = 0;
    let db: Database | null = null;
    let readError: unknown;
    try {
      db = await openBackupDatabase(backupPath, file.path, readOptions);
      throwIfReadAborted(readOptions.signal);
      const result = getChatDataFromDb(
        db,
        createComposerSqliteBudget(resolveSourceReadLimits(readOptions.sourceReadLimits)),
        readOptions.signal
      );
      if (result) {
        const parsed = parseChatData(result.data, result.bundle);
        sessionCount = parsed.length;
      }
    } catch (error) {
      readError = error;
    }
    if (db) {
      try {
        db.close();
      } catch (closeError) {
        attachReadFailureCause(closeError, readError);
        throw closeError;
      }
    }
    if (readError !== undefined) throw readError;

    if (sessionCount > 0) {
      workspaces.push({
        id: workspaceId,
        path: workspacePath,
        dbPath: file.path, // Relative path within backup
        sessionCount,
      });
    }
  }

  return workspaces;
}

/**
 * Enumerate Composer workspace membership without opening any conversation DB.
 * This preflight is the only input to exact/unique-suffix scope resolution.
 */
async function findComposerWorkspaceInventory(
  customDataPath: string | undefined,
  backupPath: string | undefined,
  readOptions: Readonly<StorageReadOperationOptions>
): Promise<Workspace[]> {
  if (backupPath) {
    const manifest = await readBackupManifest(backupPath, readOptions);
    if (!manifest) return [];
    const inventory: Workspace[] = [];
    for (const file of manifest.files) {
      if (file.type !== 'workspace-db') continue;
      const match = file.path.match(/^workspaceStorage\/([^/]+)\/state\.vscdb$/u);
      if (!match) continue;
      const workspaceId = match[1]!;
      const workspacePath =
        (await readWorkspaceJsonFromBackup(backupPath, workspaceId, readOptions)) ??
        `(workspace: ${workspaceId})`;
      inventory.push({
        id: workspaceId,
        path: workspacePath,
        dbPath: file.path,
        sessionCount: 0,
      });
    }
    return inventory;
  }

  const basePath = getCursorDataPath(customDataPath);
  observeStorageAdapterIo(readOptions, {
    adapter: 'filesystem',
    operation: 'open',
    resourceClass: 'workspace-root-directory',
  });
  if (!existsSync(basePath)) return [];

  observeStorageAdapterIo(readOptions, {
    adapter: 'filesystem',
    operation: 'read',
    resourceClass: 'workspace-root-directory',
  });
  const entries = readdirSync(basePath, { withFileTypes: true });
  const inventory: Workspace[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = join(basePath, entry.name);
    const dbPath = join(workspaceDir, 'state.vscdb');
    observeStorageAdapterIo(readOptions, {
      adapter: 'filesystem',
      operation: 'open',
      resourceClass: 'workspace-session-index',
      sourceRole: 'composer',
      representation: 'composer-workspace',
    });
    if (!existsSync(dbPath)) continue;
    inventory.push({
      id: entry.name,
      path: readWorkspaceJson(workspaceDir, readOptions) ?? `(workspace: ${entry.name})`,
      dbPath,
      sessionCount: 0,
    });
  }
  return inventory;
}

/** Read only native Composer UUIDs from one workspace catalog row. */
function loadWorkspaceComposerIdsOnly(
  db: Database,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): string[] {
  try {
    const source = getBoundedComposerMetadataByKey(
      db,
      'ItemTable',
      'composer.composerData',
      budget,
      signal
    );
    if (!source) return [];

    const ids = new Set<string>();
    const pageRows = budget.limits.sqlitePageRows;
    let afterIndex = -1;
    while (true) {
      throwIfReadAborted(signal);
      const rows = db
        .prepare(
          `SELECT CAST(j.key AS INTEGER) AS itemIndex,
             length(CAST(json_extract(j.value, '$.composerId') AS BLOB)) AS byteLength
           FROM ItemTable AS i, json_each(i.value, '$.allComposers') AS j
           WHERE i.rowid = ?
             AND json_type(j.value, '$.composerId') = 'text'
             AND CAST(j.key AS INTEGER) > ?
           ORDER BY itemIndex ASC LIMIT ?`
        )
        .all(source.rowId, afterIndex, pageRows) as Array<{
        itemIndex?: number | bigint;
        byteLength?: number | bigint;
        composerId?: string;
      }>;
      if (rows.length === 0) break;

      // Compatibility for existing SQL test doubles that return the historical
      // projected payload rows directly.
      if (
        rows.some(
          ({ itemIndex, byteLength }) => itemIndex === undefined && byteLength === undefined
        )
      ) {
        const values = rows
          .map(({ composerId }) => composerId)
          .filter((value): value is string => typeof value === 'string');
        budget.admitMetadataPage(values.map((value) => Buffer.byteLength(value)));
        for (const value of values) {
          budget.admitDecodedValue(Buffer.byteLength(value));
          ids.add(value);
        }
        break;
      }

      const metadata = rows.map(({ itemIndex, byteLength }) => {
        const normalizedIndex = Number(itemIndex);
        const normalizedLength = Number(byteLength);
        if (
          !Number.isSafeInteger(normalizedIndex) ||
          normalizedIndex < 0 ||
          !Number.isSafeInteger(normalizedLength) ||
          normalizedLength < 0
        ) {
          throw new TypeError('SQLite returned invalid Composer UUID projection metadata');
        }
        return { itemIndex: normalizedIndex, byteLength: normalizedLength };
      });
      budget.admitMetadataPage(metadata.map(({ byteLength }) => byteLength));
      for (const row of metadata) {
        throwIfReadAborted(signal);
        const projected = db
          .prepare(
            `SELECT json_extract(j.value, '$.composerId') AS composerId
             FROM ItemTable AS i, json_each(i.value, '$.allComposers') AS j
             WHERE i.rowid = ? AND CAST(j.key AS INTEGER) = ?`
          )
          .get(source.rowId, row.itemIndex) as { composerId?: unknown } | undefined;
        if (typeof projected?.composerId !== 'string') continue;
        const actualBytes = Buffer.byteLength(projected.composerId);
        if (actualBytes !== row.byteLength) {
          throw new Error('Composer UUID projection changed after metadata admission.');
        }
        budget.admitDecodedValue(actualBytes);
        ids.add(projected.composerId);
      }
      afterIndex = metadata[metadata.length - 1]!.itemIndex;
      if (rows.length < pageRows) break;
    }
    return [...ids];
  } catch (error) {
    if (isMissingItemTableError(error)) return [];
    throwOwningDatabaseReadFailure(error);
  }
}

/** Hydrate only one admitted workspace Composer object after scope planning. */
function loadOneWorkspaceComposer(
  db: Database,
  composerId: string,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): ChatSession | null {
  let value: string | undefined;
  try {
    const source = getBoundedComposerMetadataByKey(
      db,
      'ItemTable',
      'composer.composerData',
      budget,
      signal
    );
    if (!source) return null;
    const metadata = db
      .prepare(
        `SELECT CAST(j.key AS INTEGER) AS itemIndex,
           length(CAST(j.value AS BLOB)) AS byteLength
         FROM ItemTable AS i, json_each(i.value, '$.allComposers') AS j
         WHERE i.rowid = ?
           AND json_extract(j.value, '$.composerId') = ?
         LIMIT 1`
      )
      .get(source.rowId, composerId) as
      { itemIndex?: number | bigint; byteLength?: number | bigint; value?: unknown } | undefined;
    if (!metadata) return null;

    // Compatibility for historical SQL test doubles that return the projected
    // value directly from the metadata query.
    if (metadata.itemIndex === undefined && metadata.byteLength === undefined) {
      if (metadata.value === undefined || metadata.value === null) return null;
      const bytes =
        typeof metadata.value === 'string'
          ? Buffer.from(metadata.value)
          : metadata.value instanceof Uint8Array
            ? metadata.value
            : undefined;
      if (!bytes) throw new TypeError('SQLite returned an unsupported Composer projection');
      budget.admitMetadataPage([bytes.byteLength]);
      budget.admitDecodedValue(bytes.byteLength);
      value = decodeDeterministicUtf8(bytes, 'sqlite', 'fatal').text;
    } else {
      const itemIndex = Number(metadata.itemIndex);
      const byteLength = Number(metadata.byteLength);
      if (
        !Number.isSafeInteger(itemIndex) ||
        itemIndex < 0 ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0
      ) {
        throw new TypeError('SQLite returned invalid Composer projection metadata');
      }
      budget.admitMetadataPage([byteLength]);
      throwIfReadAborted(signal);
      const row = db
        .prepare(
          `SELECT CAST(j.value AS BLOB) AS value
           FROM ItemTable AS i, json_each(i.value, '$.allComposers') AS j
           WHERE i.rowid = ? AND CAST(j.key AS INTEGER) = ?`
        )
        .get(source.rowId, itemIndex) as { value?: unknown } | undefined;
      if (!row || row.value === undefined || row.value === null) {
        throw new Error('Composer projection changed after metadata admission.');
      }
      const bytes =
        typeof row.value === 'string'
          ? Buffer.from(row.value)
          : row.value instanceof Uint8Array
            ? row.value
            : undefined;
      if (!bytes || bytes.byteLength !== byteLength) {
        throw new Error('Composer projection length changed after metadata admission.');
      }
      budget.admitDecodedValue(bytes.byteLength);
      value = decodeDeterministicUtf8(bytes, 'sqlite', 'fatal').text;
    }
  } catch (error) {
    if (isMissingItemTableError(error)) return null;
    throwOwningDatabaseReadFailure(error);
  }
  if (!value) return null;
  try {
    return (
      parseChatData(JSON.stringify({ allComposers: [JSON.parse(value) as unknown] }))[0] ?? null
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/**
 * Read workspace.json to get the original workspace path.
 * Supports single-folder workspaces (folder) and .code-workspace files (configuration).
 */
export function readWorkspaceJson(
  workspaceDir: string,
  readOptions: Pick<StorageReadOperationOptions, 'io'> = {}
): string | null {
  const jsonPath = join(workspaceDir, 'workspace.json');
  observeStorageAdapterIo(readOptions, {
    adapter: 'filesystem',
    operation: 'open',
    resourceClass: 'workspace-membership-json',
    sourceRole: 'composer',
    representation: 'composer-workspace',
  });
  if (!existsSync(jsonPath)) {
    return null;
  }

  observeStorageAdapterIo(readOptions, {
    adapter: 'filesystem',
    operation: 'read',
    resourceClass: 'workspace-membership-json',
    sourceRole: 'composer',
    representation: 'composer-workspace',
  });
  try {
    const content = readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(content) as WorkspaceJsonShape;
    return getWorkspacePathFromJson(data);
  } catch {
    return null;
  }
}

const COUNTED_COMPOSER_SESSION_IDS = Symbol('countedComposerSessionIds');
type WorkspaceWithCountedSessions = Workspace & {
  [COUNTED_COMPOSER_SESSION_IDS]?: ReadonlySet<string>;
};

/**
 * Retain the exact IDs represented by a Composer workspace count without
 * exposing implementation metadata through the public Workspace shape.
 */
function attachCountedComposerSessionIds(
  workspace: Workspace,
  sessionIds: Iterable<string>
): Workspace {
  Object.defineProperty(workspace, COUNTED_COMPOSER_SESSION_IDS, {
    value: new Set(sessionIds),
  });
  return workspace;
}

function getCountedComposerSessionIds(workspace: Workspace): ReadonlySet<string> | undefined {
  return (workspace as WorkspaceWithCountedSessions)[COUNTED_COMPOSER_SESSION_IDS];
}

/**
 * Find all workspaces with chat history
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function findWorkspaces(
  customDataPath?: string,
  backupPath?: string,
  readOptions: StorageReadOperationOptions = {}
): Promise<Workspace[]> {
  const operationOptions = bindStorageReadOptions(readOptions);
  // T028: Support reading from backup
  if (backupPath) {
    return await findWorkspacesFromBackup(backupPath, operationOptions);
  }

  const basePath = getCursorDataPath(customDataPath);

  observeStorageAdapterIo(operationOptions, {
    adapter: 'filesystem',
    operation: 'open',
    resourceClass: 'workspace-root-directory',
  });
  if (!existsSync(basePath)) {
    return [];
  }

  const workspaces: Workspace[] = [];
  let globalDb: Database | null = null;
  let globalDbChecked = false;
  let globalDbAvailable = false;
  let globalComposerRecords: GlobalComposerRecord[] = [];
  let globalBubbleCounts = new Map<string, number>();
  const globalCatalogBudget = createComposerSqliteBudget(
    resolveSourceReadLimits(operationOptions.sourceReadLimits)
  );

  try {
    observeStorageAdapterIo(operationOptions, {
      adapter: 'filesystem',
      operation: 'read',
      resourceClass: 'workspace-root-directory',
    });
    const entries = readdirSync(basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspaceDir = join(basePath, entry.name);
      const dbPath = join(workspaceDir, 'state.vscdb');

      observeStorageAdapterIo(operationOptions, {
        adapter: 'filesystem',
        operation: 'open',
        resourceClass: 'workspace-session-index',
        sourceRole: 'composer',
        representation: 'composer-workspace',
      });
      if (!existsSync(dbPath)) continue;

      const workspacePath =
        readWorkspaceJson(workspaceDir, operationOptions) ?? `(workspace: ${entry.name})`;
      if (workspacePath.startsWith('(workspace:')) {
        debugLogStorage(
          `Using workspace ID fallback path for ${entry.name} (workspace.json missing/unknown)`
        );
      }
      if (
        operationOptions.workspaceFilterPath &&
        !pathsEqual(workspacePath, operationOptions.workspaceFilterPath)
      ) {
        continue;
      }

      // Count sessions in this workspace
      let sessionCount = 0;
      const seenComposerIds = new Set<string>();
      const selectedIds: string[] = [];
      const pointerIds: string[] = [];
      let workspaceDb: Database | null = null;
      try {
        throwIfReadAborted(operationOptions.signal);
        workspaceDb = await openDatabase(
          dbPath,
          withDatabaseIo(operationOptions, {
            resourceClass: 'workspace-conversation',
            sourceRole: 'composer',
            representation: 'composer-workspace',
          })
        );
        throwIfReadAborted(operationOptions.signal);
        const workspaceCatalogBudget = createComposerSqliteBudget(
          resolveSourceReadLimits(operationOptions.sourceReadLimits)
        );
        const result = getChatDataFromDb(
          workspaceDb,
          workspaceCatalogBudget,
          operationOptions.signal
        );
        if (result) {
          const parsed = parseChatData(result.data, result.bundle);
          sessionCount = parsed.length;
          for (const session of parsed) {
            seenComposerIds.add(session.id);
          }

          const rawComposerData = result.bundle.composerData;
          const composerRefs = extractComposerIdsFromData(rawComposerData);
          selectedIds.push(
            ...composerRefs
              .filter((ref) => ref.source === 'selectedComposerIds')
              .map((ref) => ref.composerId)
          );
        } else {
          debugLogStorage(`No chat data keys found in workspace DB ${dbPath}`);
        }
        // Pointer keys live in ItemTable independently of composer.composerData.
        pointerIds.push(
          ...getWorkspaceComposerPointerIds(
            workspaceDb,
            workspaceCatalogBudget,
            operationOptions.signal
          )
        );
      } catch (error) {
        if (shouldPropagateReadFailure(error)) throw error;
        debugLogStorage(`Skipping unreadable workspace DB ${dbPath}: ${getErrorMessage(error)}`);
        // Skip workspaces with unreadable databases
        continue;
      } finally {
        closeDatabase(workspaceDb);
      }

      if (!globalDbChecked) {
        globalDbChecked = true;
        const globalDbPath = join(getGlobalStoragePath(customDataPath), 'state.vscdb');
        observeStorageAdapterIo(operationOptions, {
          adapter: 'filesystem',
          operation: 'open',
          resourceClass: 'global-session-index',
          sourceRole: 'composer',
          representation: 'composer-global',
        });
        if (existsSync(globalDbPath)) {
          try {
            throwIfReadAborted(operationOptions.signal);
            globalDb = await openDatabase(
              globalDbPath,
              withDatabaseIo(operationOptions, {
                resourceClass: 'global-session-index',
                sourceRole: 'composer',
                representation: 'composer-global',
              })
            );
            throwIfReadAborted(operationOptions.signal);
            const tableCheck = globalDb
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
              .get();
            globalDbAvailable = Boolean(tableCheck);
            if (globalDbAvailable && !operationOptions.workspaceFilterPath) {
              globalComposerRecords = loadGlobalComposerRecords(
                globalDb,
                globalCatalogBudget,
                operationOptions.signal
              );
              globalBubbleCounts = loadGlobalBubbleCounts(
                globalDb,
                globalCatalogBudget,
                operationOptions.signal
              );
            }
          } catch (error) {
            if (shouldPropagateReadFailure(error)) throw error;
            closeDatabase(globalDb);
            globalDb = null;
            globalDbAvailable = false;
          }
        }
      }

      if (globalDb && globalDbAvailable) {
        const workspaceForGlobalMatch: Workspace = {
          id: entry.name,
          path: workspacePath,
          dbPath,
          sessionCount,
        };

        // Selected + pointer IDs are only counted when they resolve to a real
        // global composer with bubbles, so non-composer GUIDs never inflate counts.
        for (const composerId of [...selectedIds, ...pointerIds]) {
          if (seenComposerIds.has(composerId)) continue;
          const bubbleCount = operationOptions.workspaceFilterPath
            ? countGlobalComposerBubbles(
                globalDb,
                composerId,
                globalCatalogBudget,
                operationOptions.signal
              )
            : (globalBubbleCounts.get(composerId) ?? 0);
          if (bubbleCount > 0) {
            seenComposerIds.add(composerId);
            sessionCount++;
          }
        }

        if (operationOptions.workspaceFilterPath) {
          for (const composerId of loadGlobalComposerMembershipIds(
            globalDb,
            workspaceForGlobalMatch,
            globalCatalogBudget,
            operationOptions.signal
          )) {
            if (seenComposerIds.has(composerId)) continue;
            if (
              countGlobalComposerBubbles(
                globalDb,
                composerId,
                globalCatalogBudget,
                operationOptions.signal
              ) <= 0
            )
              continue;
            seenComposerIds.add(composerId);
            sessionCount++;
          }
        }

        if (!operationOptions.workspaceFilterPath) {
          for (const summary of getGlobalComposerSummariesForWorkspace(
            globalDb,
            workspaceForGlobalMatch,
            globalComposerRecords,
            globalBubbleCounts,
            globalCatalogBudget,
            operationOptions.signal
          )) {
            if (seenComposerIds.has(summary.id)) continue;
            seenComposerIds.add(summary.id);
            sessionCount++;
          }
        }
      } else {
        // No global storage: pointer GUIDs cannot be confirmed as composers, so
        // only count real selectedComposerIds (avoid phantom session counts).
        for (const composerId of selectedIds) {
          if (seenComposerIds.has(composerId)) continue;
          seenComposerIds.add(composerId);
          sessionCount++;
        }
      }

      if (sessionCount > 0) {
        workspaces.push(
          attachCountedComposerSessionIds(
            {
              id: entry.name,
              path: workspacePath,
              dbPath,
              sessionCount,
            },
            seenComposerIds
          )
        );
      }
    }
  } catch (error) {
    if (shouldPropagateReadFailure(error)) throw error;
    return [];
  } finally {
    closeDatabase(globalDb);
  }

  return workspaces;
}

/**
 * Get chat data JSON from database
 * Returns both the main chat data and the bundle for new format
 */
function getChatDataFromDb(
  db: Database,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): ChatDataResult | null {
  const candidates: Array<{ key: string; value: string }> = [];
  for (const key of CHAT_DATA_KEYS) {
    try {
      const value = readBoundedComposerValueByKey(db, 'ItemTable', key, budget, signal);
      if (value) {
        candidates.push({ key, value });
      }
    } catch (error) {
      // A Cursor database without ItemTable simply has no workspace chat
      // payload. Every other query failure is an owning-read failure and must
      // not be converted into an empty session list.
      if (isMissingItemTableError(error)) return null;
      throwOwningDatabaseReadFailure(error);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  let selected = candidates[0]!;
  let bestSessionCount = -1;

  for (const candidate of candidates) {
    const candidateBundle: CursorChatBundle = {};
    if (candidate.key === 'composer.composerData') {
      candidateBundle.composerData = candidate.value;
    }

    const parsedCount = parseChatData(candidate.value, candidateBundle).length;
    if (parsedCount > bestSessionCount) {
      selected = candidate;
      bestSessionCount = parsedCount;
    }
  }

  const mainData = selected.value;
  const bundle: CursorChatBundle = {};
  const composerCandidate = candidates.find(
    (candidate) => candidate.key === 'composer.composerData'
  );
  if (composerCandidate) {
    bundle.composerData = composerCandidate.value;
  }

  // For new format, also get prompts and generations
  try {
    const prompts = readBoundedComposerValueByKey(db, 'ItemTable', PROMPTS_KEY, budget, signal);
    if (prompts) {
      bundle.prompts = prompts;
    }

    const generations = readBoundedComposerValueByKey(
      db,
      'ItemTable',
      GENERATIONS_KEY,
      budget,
      signal
    );
    if (generations) {
      bundle.generations = generations;
    }
  } catch (error) {
    throwOwningDatabaseReadFailure(error);
  }

  return { data: mainData, bundle };
}

/**
 * Count bubbles per composer in a single pass over global storage, instead of one
 * `COUNT(*) ... LIKE 'bubbleId:<id>:%'` full scan per composer. Reused across the
 * recovery passes so listing stays roughly one bubble-table scan rather than O(C).
 */
function loadGlobalBubbleCounts(
  db: Database,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    forEachBoundedComposerBubbleMetadata(
      db,
      'bubbleId:%',
      budget,
      ({ key }) => {
        // key form: bubbleId:<composerId>:<bubbleId>
        const composerId = key.split(':')[1];
        if (composerId) {
          counts.set(composerId, (counts.get(composerId) ?? 0) + 1);
        }
      },
      signal
    );
  } catch (error) {
    throwOwningDatabaseReadFailure(error);
  }
  return counts;
}

/** Count one already selected Composer UUID without scanning another session's keys. */
function countGlobalComposerBubbles(
  db: Database,
  composerId: string,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): number {
  try {
    let count = 0;
    forEachBoundedComposerBubbleMetadata(
      db,
      `bubbleId:${sqliteLikeLiteralPrefix(composerId)}:%`,
      budget,
      () => {
        count++;
      },
      signal
    );
    return count;
  } catch (error) {
    throwOwningDatabaseReadFailure(error);
  }
}

function buildGlobalComposerSummary(
  db: Database,
  composerId: string,
  composerData: Record<string, unknown>,
  options?: { bubbleCount?: number; includePreview?: boolean },
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): GlobalComposerSummary | null {
  const messageCount =
    options?.bubbleCount ?? countGlobalComposerBubbles(db, composerId, budget, signal);
  if (messageCount <= 0) {
    return null;
  }

  const composerMetadata = composerMetadataTimestamps(composerData);
  let directMessages: Message[] = [];
  let firstBubbleValue: string | null | undefined;
  if (!composerMetadata.createdAt || !composerMetadata.lastUpdatedAt) {
    const timestampRows: BubbleRow[] = [];
    forEachBoundedComposerBubbleValue(
      db,
      `bubbleId:${sqliteLikeLiteralPrefix(composerId)}:%`,
      budget,
      (row) => {
        if (firstBubbleValue === undefined) firstBubbleValue = row.value;
        timestampRows.push({ key: row.key, value: row.value });
      },
      signal
    );
    directMessages = timestampRows.map((row) => mapBubbleToMessage(row)) as Message[];
  }
  const sessionTimestamps = resolveSessionTimestamps({
    view: 'composer-backed',
    composerMetadata,
    directMessages,
  });

  let preview = '';
  if (options?.includePreview !== false) {
    firstBubbleValue ??= readFirstBoundedComposerBubbleValue(
      db,
      `bubbleId:${sqliteLikeLiteralPrefix(composerId)}:%`,
      budget,
      signal
    )?.value;
    if (typeof firstBubbleValue === 'string' && firstBubbleValue.length > 0) {
      try {
        const bubbleData = JSON.parse(firstBubbleValue) as Record<string, unknown>;
        preview = extractBubbleText(bubbleData).slice(0, 100);
      } catch {
        preview = '';
      }
    }
  }

  const workspacePath = workspacePathFromComposer(composerData);
  return {
    id: composerId,
    title:
      typeof composerData['name'] === 'string'
        ? composerData['name']
        : typeof composerData['title'] === 'string'
          ? composerData['title']
          : null,
    ...sessionTimestamps,
    messageCount,
    preview,
    ...(workspacePath ? { workspacePath } : {}),
  };
}

function getGlobalComposerSummary(
  db: Database,
  composerId: string,
  bubbleCounts?: Map<string, number>,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): GlobalComposerSummary | null {
  let composerValue: string | undefined;
  try {
    composerValue = readBoundedComposerValueByKey(
      db,
      'cursorDiskKV',
      `composerData:${composerId}`,
      budget,
      signal
    );
  } catch (error) {
    throwOwningDatabaseReadFailure(error);
  }
  if (!composerValue) return null;
  try {
    const composerData = JSON.parse(composerValue) as unknown;
    if (!isRecord(composerData)) {
      return null;
    }

    return buildGlobalComposerSummary(
      db,
      composerId,
      composerData,
      {
        bubbleCount: bubbleCounts?.get(composerId),
      },
      budget,
      signal
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

/**
 * Load and parse every `composerData:%` row from global storage exactly once.
 * Callers reuse the result across all workspaces instead of re-scanning and
 * re-parsing the full composer table per workspace (which made `list` O(W×C)).
 */
function loadGlobalComposerRecords(
  db: Database,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): GlobalComposerRecord[] {
  const records: GlobalComposerRecord[] = [];
  try {
    forEachBoundedComposerValue(
      db,
      'cursorDiskKV',
      'composerData:%',
      budget,
      (row) => {
        try {
          const data = JSON.parse(row.value) as unknown;
          if (isRecord(data)) records.push({ id: row.key.replace('composerData:', ''), data });
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      },
      signal
    );
  } catch (error) {
    throwOwningDatabaseReadFailure(error);
  }
  return records;
}

interface GlobalComposerMembershipRow {
  key: string;
  workspaceId?: string | null;
  fsPath?: string | null;
  uriPath?: string | null;
  externalPath?: string | null;
  workspaceUri?: string | null;
  /** Test-double compatibility only; the production query never selects this column. */
  value?: string;
}

/**
 * Project only a global Composer record's workspace attribution. This keeps a
 * Composer-backed canonical path stable even when strict scope omits that
 * contributor's conversation payload.
 */
function getGlobalComposerWorkspacePathMetadata(
  db: Database,
  composerId: string,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): string | null {
  try {
    return projectGlobalComposerWorkspacePathMetadata(db, composerId, budget, signal);
  } catch (error) {
    throwOwningDatabaseReadFailure(error);
  }
}

function projectGlobalComposerWorkspacePathMetadata(
  db: Database,
  composerId: string,
  budget: ReturnType<typeof createComposerSqliteBudget>,
  signal?: AbortSignal
): string | null {
  const metadata = getBoundedComposerMetadataByKey(
    db,
    'cursorDiskKV',
    `composerData:${composerId}`,
    budget,
    signal
  );
  if (!metadata) return null;

  const inlineValue = (metadata as ComposerSqliteMetadata & { inlineValue?: unknown }).inlineValue;
  if (typeof inlineValue === 'string') {
    budget.admitDecodedValue(Buffer.byteLength(inlineValue));
    try {
      const parsed = JSON.parse(inlineValue) as unknown;
      return isRecord(parsed) ? workspacePathFromComposer(parsed) : null;
    } catch {
      return null;
    }
  }

  const row = db
    .prepare(
      `SELECT
        CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.fsPath') END AS fsPath,
        CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.path') END AS uriPath,
        CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.external') END AS externalPath,
        CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceUri') END AS workspaceUri
      FROM cursorDiskKV WHERE rowid = ?`
    )
    .get(metadata.rowId) as Omit<GlobalComposerMembershipRow, 'key'> | undefined;
  if (!row) throw new Error('Composer workspace metadata changed after admission.');
  const projected = [row.fsPath, row.uriPath, row.externalPath, row.workspaceUri].filter(
    (value): value is string => typeof value === 'string'
  );
  budget.admitDecodedValue(
    projected.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0)
  );
  const candidate = projected.find((value) => value.length > 0);
  return candidate ? uriToPath(candidate) : null;
}

/**
 * Read only UUID/workspace membership fields from global composer records.
 * SQLite performs the JSON projection so titles and other payload fields never
 * cross the adapter boundary during scoped discovery.
 */
function loadGlobalComposerMembershipIds(
  db: Database,
  workspace: Workspace,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): string[] {
  const ids = new Set<string>();
  try {
    forEachBoundedComposerMetadata(
      db,
      'cursorDiskKV',
      'composerData:%',
      budget,
      (metadata) => {
        const inlineValue = (metadata as ComposerSqliteMetadata & { inlineValue?: unknown })
          .inlineValue;
        let row: GlobalComposerMembershipRow | undefined;
        if (typeof inlineValue === 'string') {
          row = { key: metadata.key, value: inlineValue };
          budget.admitDecodedValue(Buffer.byteLength(inlineValue));
        } else {
          row = db
            .prepare(
              `SELECT key,
                CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.id') END AS workspaceId,
                CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.fsPath') END AS fsPath,
                CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.path') END AS uriPath,
                CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.external') END AS externalPath,
                CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceUri') END AS workspaceUri
              FROM cursorDiskKV WHERE rowid = ?`
            )
            .get(metadata.rowId) as GlobalComposerMembershipRow | undefined;
          if (!row) throw new Error('Composer membership row changed after metadata admission.');
          const projectedBytes = [
            row.key,
            row.workspaceId,
            row.fsPath,
            row.uriPath,
            row.externalPath,
            row.workspaceUri,
          ].reduce(
            (total, value) =>
              total + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0),
            0
          );
          budget.admitDecodedValue(projectedBytes);
        }

        let matches =
          row.workspaceId === workspace.id ||
          [row.fsPath, row.uriPath, row.externalPath, row.workspaceUri].some((candidate) =>
            workspacePathMatches(candidate, workspace.path)
          );
        // Existing unit-test adapters may return the historical key/value row
        // shape. Real SQLite never selects `value` in this projection query.
        if (!matches && typeof row.value === 'string') {
          try {
            const parsed = JSON.parse(row.value) as unknown;
            matches = isRecord(parsed) && composerBelongsToWorkspace(parsed, workspace);
          } catch {
            matches = false;
          }
        }
        if (matches) ids.add(row.key.replace(/^composerData:/u, ''));
      },
      signal
    );
  } catch (error) {
    throwOwningDatabaseReadFailure(error);
  }
  return [...ids];
}

function getGlobalComposerSummariesForWorkspace(
  db: Database,
  workspace: Workspace,
  records: GlobalComposerRecord[],
  bubbleCounts?: Map<string, number>,
  budget = createComposerSqliteBudget(),
  signal?: AbortSignal
): GlobalComposerSummary[] {
  const summaries: GlobalComposerSummary[] = [];

  for (const record of records) {
    if (!composerBelongsToWorkspace(record.data, workspace)) {
      continue;
    }

    const summary = buildGlobalComposerSummary(
      db,
      record.id,
      record.data,
      {
        bubbleCount: bubbleCounts?.get(record.id),
      },
      budget,
      signal
    );
    if (summary) {
      summaries.push(summary);
    }
  }

  return summaries;
}

/**
 * Return the composer IDs whose global-storage record is linked to `workspace`
 * (via workspaceIdentifier or workspaceUri). Used by workspace migration so that
 * sessions discoverable only through global storage are migrated too, matching
 * what `list` surfaces for the workspace.
 */
export async function getWorkspaceLinkedComposerIds(
  workspace: Workspace,
  customDataPath?: string
): Promise<string[]> {
  const globalDbPath = join(getGlobalStoragePath(customDataPath), 'state.vscdb');
  if (!existsSync(globalDbPath)) {
    return [];
  }

  let db: Database | null = null;
  let readError: unknown;
  try {
    db = await openDatabase(globalDbPath);
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();
    if (!tableCheck) {
      return [];
    }

    const ids = new Set<string>();
    const records = loadGlobalComposerRecords(db);
    const recordById = new Map(records.map((record) => [record.id, record.data]));
    for (const record of records) {
      if (composerBelongsToWorkspace(record.data, workspace)) {
        ids.add(record.id);
      }
    }

    // Also include composers referenced by this workspace's pointer keys (the
    // modern linkage). Because migration is destructive, only include a pointer ID
    // when its record is unstamped or already belongs to this workspace — never one
    // explicitly stamped for a different workspace (which the user merely viewed).
    if (existsSync(workspace.dbPath)) {
      let wsDb: Database | null = null;
      let workspaceReadError: unknown;
      try {
        wsDb = await openDatabase(workspace.dbPath);
        for (const pointerId of getWorkspaceComposerPointerIds(wsDb)) {
          const data = recordById.get(pointerId);
          if (!data) continue;
          if (!composerHasWorkspaceStamp(data) || composerBelongsToWorkspace(data, workspace)) {
            ids.add(pointerId);
          }
        }
      } catch (error) {
        workspaceReadError = error;
        if (shouldPropagateReadFailure(error)) throw error;
        throwOwningDatabaseReadFailure(error);
      } finally {
        closeDatabaseOrThrow(wsDb, workspaceReadError);
      }
    }

    return [...ids];
  } catch (error) {
    readError = error;
    if (shouldPropagateReadFailure(error)) throw error;
    throwOwningDatabaseReadFailure(error);
  } finally {
    closeDatabaseOrThrow(db, readError);
  }
}

/**
 * Operation-scoped read context. Caches the Store sessions discovered for
 * one top-level operation and, when populated, the full listing summaries, so
 * search / export-all / library loops do not re-discover the Store corpus or
 * re-list sessions per item. Public functions accept it as an optional trailing
 * argument; direct public calls create one automatically.
 */
export interface SessionReadContext {
  readonly customDataPath?: string;
  readonly backupPath?: string;
  /** Strict per-operation provider preference inherited by every nested read. */
  readonly sqliteDriver?: DriverName;
  /** Validated immutable Source Read Limits override inherited by Store readers. */
  readonly sourceReadLimits?: Readonly<SourceReadLimitsV1>;
  /** Cooperative cancellation inherited by discovery, snapshot, and payload readers. */
  readonly signal?: AbortSignal;
  /** Internal immutable low-level adapter observation context. */
  readonly io: OperationIoContext;
  /** Immutable normalized workspace request; `null` is explicit global scope. */
  readonly workspaceScope: string | null;
  /** Whether selected UUIDs may load disclosed contributors outside scope. */
  readonly includeCrossWorkspaceSources: boolean;
  /** Maximum number of completed decoded sessions retained by this context. */
  readonly resolvedSessionCapacity: number;
  /** Whether the idempotent disposal lifecycle has begun. */
  readonly disposed: boolean;
  /** Safe continuation diagnostic sink, if supplied by the operation owner. */
  readonly onDiagnostic?: (diagnostic: import('./types.js').SessionDiagnostic) => void;
  /** Cached Store sessions (discovered at most once per operation). */
  storeSessions: StoreSession[] | null;
  /** In-flight Store discovery, shared by concurrent readers. */
  storeSessionsPromise?: Promise<StoreSession[]> | null;
  /** Cached Composer workspaces (discovered at most once per operation). */
  workspaces?: Workspace[] | null;
  /** In-flight Composer workspace discovery, shared by concurrent readers. */
  workspacesPromise?: Promise<Workspace[]> | null;
  /** Cached summaries for the operation's current listing scope. */
  summaries: ChatSessionSummary[] | null;
  /** One row per logical UUID, including message-free ambiguity rows. */
  logicalSummaries: LogicalSessionSummary[] | null;
  /** In-flight resolutions only; concurrent reads of one key share one promise. */
  readonly activeResolutions: Map<string, Promise<ChatSession | null>>;
  /** Completed decoded sessions in least-to-most-recently-used order. */
  readonly completedSessions: Map<string, ChatSession | null>;
  /** Backward-compatible read-only cache view used by internal diagnostics/tests. */
  readonly resolvedSessions: ReadonlyMap<string, Promise<ChatSession | null>>;
  /** Monotonic count of actual resolution starts for bounded-memory auditing. */
  resolutionStarts: number;
  /** Evict every completed occurrence for one logical native session ID. */
  releaseSession(sessionId: string): void;
  /** Idempotently release context-owned decoded values and discovery state. */
  dispose(): Promise<void>;
  /** Internal ownership-bound observer used only by regression tests. */
  readonly testOnlyOnOwnershipChange?: (snapshot: Readonly<ContextOwnershipSnapshot>) => void;
}

interface SessionReadContextPrivateState {
  /**
   * Workspace locator selected while reconciling Composer replicas. Keeping
   * this operation-private lets getSession() hydrate an explicitly selected
   * cross-workspace contributor without widening the context's workspace scan.
   */
  readonly boundComposerWorkspaceBySession: Map<string, Workspace>;
  readonly boundStoreOccurrencesBySession: Map<string, readonly StorePhysicalOccurrence[]>;
  readonly emittedDiagnosticKeys: Set<string>;
}

/** Physical Store locators stay operation-private and can never be cloned/serialized. */
const sessionReadContextPrivate = new WeakMap<SessionReadContext, SessionReadContextPrivateState>();

function privateReadState(context: SessionReadContext): SessionReadContextPrivateState {
  const state = sessionReadContextPrivate.get(context);
  if (!state) throw new ReadContextDisposedError();
  return state;
}

function reportSessionAmbiguity(
  context: SessionReadContext,
  sessionId: string,
  occurrenceRefs: readonly string[]
): void {
  if (!context.onDiagnostic) {
    throw new SessionAmbiguityError(sessionId, [...occurrenceRefs]);
  }
  const state = privateReadState(context);
  const orderedRefs = [...new Set(occurrenceRefs)].sort(compareCodePoints);
  const key = `SESSION_AMBIGUOUS\0${sessionId}\0${orderedRefs.join('\0')}`;
  if (state.emittedDiagnosticKeys.has(key)) return;
  state.emittedDiagnosticKeys.add(key);
  context.onDiagnostic({
    code: 'SESSION_AMBIGUOUS',
    message: `Session ${sessionId} has divergent physical occurrences.`,
    sessionId,
    occurrenceCount: orderedRefs.length,
    occurrenceRefs: orderedRefs,
    remedy: 'Resolve or remove the divergent replicas, then retry the operation.',
  });
}

let nextReadContextId = 1;

function storageDataSourceIdentity(customDataPath?: string, backupPath?: string): string {
  const source = backupPath
    ? `backup\0${backupPath}`
    : customDataPath
      ? `live\0${customDataPath}`
      : 'live\0default';
  return `source:${createHash('sha256').update(source).digest('hex')}`;
}

function countDiscoveryDecodedSessions(context: SessionReadContext): number {
  return context.storeSessions?.filter((session) => session.messages.length > 0).length ?? 0;
}

function contextOwnershipSnapshot(context: SessionReadContext): Readonly<ContextOwnershipSnapshot> {
  const discoveryDecodedSessions = countDiscoveryDecodedSessions(context);
  const activeResolutions = context.activeResolutions.size;
  const completedSessions = context.completedSessions.size;
  return Object.freeze({
    resolvedSessionCapacity: context.resolvedSessionCapacity,
    activeResolutions,
    completedSessions,
    discoveryDecodedSessions,
    ownedDecodedSessions: completedSessions + discoveryDecodedSessions + activeResolutions,
    resolutionStarts: context.resolutionStarts,
  });
}

function emitContextOwnership(context: SessionReadContext): void {
  context.testOnlyOnOwnershipChange?.(contextOwnershipSnapshot(context));
}

function assertValidResolvedSessionCapacity(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('resolvedSessionCapacity must be a finite non-negative safe integer.');
  }
}

function isSessionReadContextOptions(value: unknown): value is SessionReadContextOptions {
  return typeof value === 'object' && value !== null;
}

/** Create an immutable-binding, bounded operation-scoped read context. */
export function createSessionReadContext(options?: SessionReadContextOptions): SessionReadContext;
/** Deprecated compatibility overload for an explicitly global source binding. */
export function createSessionReadContext(
  customDataPath?: string,
  backupPath?: string,
  options?: StorageReadOperationOptions
): SessionReadContext;
export function createSessionReadContext(
  customDataPathOrOptions?: string | SessionReadContextOptions,
  legacyBackupPath?: string,
  legacyOptions: StorageReadOperationOptions = {}
): SessionReadContext {
  const options = isSessionReadContextOptions(customDataPathOrOptions)
    ? { ...customDataPathOrOptions }
    : { ...legacyOptions };
  const customDataPath = isSessionReadContextOptions(customDataPathOrOptions)
    ? customDataPathOrOptions.dataPath
    : customDataPathOrOptions;
  const backupPath = isSessionReadContextOptions(customDataPathOrOptions)
    ? customDataPathOrOptions.backupPath
    : legacyBackupPath;
  const resolvedSessionCapacity = options.resolvedSessionCapacity ?? 1;
  assertValidResolvedSessionCapacity(resolvedSessionCapacity);
  if (
    options.includeCrossWorkspaceSources !== undefined &&
    typeof options.includeCrossWorkspaceSources !== 'boolean'
  ) {
    throw new TypeError('includeCrossWorkspaceSources must be a boolean.');
  }
  // Validate caller policy and cancellation before any later source I/O.
  const sourceReadLimits = resolveSourceReadLimits(options.sourceReadLimits);
  throwIfReadAborted(options.signal);
  const io =
    options.io ??
    createOperationIoContext({
      contextId: `read-context:${nextReadContextId++}`,
      dataSourceIdentity: storageDataSourceIdentity(customDataPath, backupPath),
      sourceReadLimits,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.ioObserver ? { emit: options.ioObserver } : {}),
    });
  const activeResolutions = new Map<string, Promise<ChatSession | null>>();
  const completedSessions = new Map<string, ChatSession | null>();
  let contextDisposed = false;
  let contextDisposalPromise: Promise<void> | null = null;
  const context: SessionReadContext = {
    customDataPath,
    backupPath,
    ...(options.sqliteDriver ? { sqliteDriver: options.sqliteDriver } : {}),
    sourceReadLimits,
    ...(options.signal ? { signal: options.signal } : {}),
    io,
    workspaceScope: options.workspacePath ? normalizeWorkspacePath(options.workspacePath) : null,
    includeCrossWorkspaceSources: options.includeCrossWorkspaceSources ?? false,
    resolvedSessionCapacity,
    get disposed() {
      return contextDisposed;
    },
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    storeSessions: null,
    storeSessionsPromise: null,
    workspaces: null,
    workspacesPromise: null,
    summaries: null,
    logicalSummaries: null,
    activeResolutions,
    completedSessions,
    resolvedSessions: new Map(),
    resolutionStarts: 0,
    releaseSession(sessionId: string): void {
      if (context.disposed) throw new ReadContextDisposedError();
      for (const key of [...context.completedSessions.keys()]) {
        if (key === sessionId || key.startsWith(`${sessionId}\0`)) {
          context.completedSessions.delete(key);
        }
      }
      emitContextOwnership(context);
    },
    dispose(): Promise<void> {
      if (contextDisposalPromise) return contextDisposalPromise;
      contextDisposed = true;
      contextDisposalPromise = (async (): Promise<void> => {
        const active = [
          ...context.activeResolutions.values(),
          ...(context.storeSessionsPromise ? [context.storeSessionsPromise] : []),
          ...(context.workspacesPromise ? [context.workspacesPromise] : []),
        ];
        if (active.length > 0) await Promise.allSettled(active);
        context.activeResolutions.clear();
        context.completedSessions.clear();
        context.storeSessions = null;
        context.storeSessionsPromise = null;
        context.workspaces = null;
        context.workspacesPromise = null;
        context.summaries = null;
        context.logicalSummaries = null;
        const privateState = sessionReadContextPrivate.get(context);
        privateState?.boundComposerWorkspaceBySession.clear();
        privateState?.boundStoreOccurrencesBySession.clear();
        privateState?.emittedDiagnosticKeys.clear();
        sessionReadContextPrivate.delete(context);
        emitContextOwnership(context);
      })();
      return contextDisposalPromise;
    },
    ...(options.testOnlyOnOwnershipChange
      ? { testOnlyOnOwnershipChange: options.testOnlyOnOwnershipChange }
      : {}),
  };

  sessionReadContextPrivate.set(context, {
    boundComposerWorkspaceBySession: new Map(),
    boundStoreOccurrencesBySession: new Map(),
    emittedDiagnosticKeys: new Set(),
  });

  Object.defineProperty(context, 'resolvedSessions', {
    configurable: false,
    enumerable: true,
    get(): ReadonlyMap<string, Promise<ChatSession | null>> {
      const view = new Map(context.activeResolutions);
      for (const [key, value] of context.completedSessions) {
        if (!view.has(key)) view.set(key, Promise.resolve(value));
      }
      return view;
    },
  });
  for (const key of [
    'customDataPath',
    'backupPath',
    'sqliteDriver',
    'sourceReadLimits',
    'signal',
    'io',
    'workspaceScope',
    'includeCrossWorkspaceSources',
    'resolvedSessionCapacity',
    'onDiagnostic',
    'testOnlyOnOwnershipChange',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) continue;
    Object.defineProperty(context, key, {
      configurable: false,
      enumerable: true,
      value: context[key],
      writable: false,
    });
  }
  emitContextOwnership(context);
  return context;
}

function optionalPathsEqual(left?: string, right?: string): boolean {
  if (left === undefined || right === undefined) return left === right;
  return pathsEqual(left, right);
}

const UNKNOWN_WORKSPACE_PATH = '(unknown workspace)';

/** Compare an already bound full workspace path. Suffix resolution happens before payload I/O. */
function workspaceFilterMatches(candidatePath: string | undefined, requestedPath: string): boolean {
  if (!candidatePath) return requestedPath === UNKNOWN_WORKSPACE_PATH;
  return pathsEqual(candidatePath, requestedPath);
}

function assertContextSource(
  context: SessionReadContext | undefined,
  customDataPath?: string,
  backupPath?: string
): void {
  if (!context) return;
  if (context.disposed) throw new ReadContextDisposedError();
  if (
    !optionalPathsEqual(context.customDataPath, customDataPath) ||
    !optionalPathsEqual(context.backupPath, backupPath)
  ) {
    throw new ReadContextSourceMismatchError();
  }
}

function bindContextWorkspaceScope(
  context: SessionReadContext | undefined,
  workspacePath?: string
): void {
  if (!context) return;
  if (context.disposed) throw new ReadContextDisposedError();

  const requestedScope = workspacePath ? normalizeWorkspacePath(workspacePath) : null;
  const sameScope =
    context.workspaceScope === null
      ? requestedScope === null
      : requestedScope !== null && context.workspaceScope === requestedScope;
  if (!sameScope) {
    throw new ReadContextScopeMismatchError();
  }
}

function sourceReadLimitsEqual(
  left: Readonly<SourceReadLimitsV1>,
  right: Readonly<SourceReadLimitsV1>
): boolean {
  for (const key of Object.keys(left) as Array<keyof SourceReadLimitsV1>) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function assertContextReadOptions(
  context: SessionReadContext,
  options: Pick<ListOptions, 'includeCrossWorkspaceSources' | 'sourceReadLimits' | 'signal'>
): void {
  if (context.disposed) throw new ReadContextDisposedError();
  if (
    options.includeCrossWorkspaceSources !== undefined &&
    options.includeCrossWorkspaceSources !== context.includeCrossWorkspaceSources
  ) {
    throw new ReadContextOptionsMismatchError('includeCrossWorkspaceSources');
  }
  if (options.signal !== undefined && options.signal !== context.signal) {
    throw new ReadContextOptionsMismatchError('signal');
  }
  if (options.sourceReadLimits !== undefined) {
    const requested = resolveSourceReadLimits(options.sourceReadLimits);
    if (!sourceReadLimitsEqual(requested, context.sourceReadLimits!)) {
      throw new ReadContextOptionsMismatchError('sourceReadLimits');
    }
  }
}

function applySessionListLimit(
  summaries: ChatSessionSummary[],
  options: ListOptions
): ChatSessionSummary[] {
  const selected =
    !options.all && options.limit > 0 ? summaries.slice(0, options.limit) : summaries;
  return structuredClone(selected);
}

interface ComposerPhysicalCandidate {
  readonly summary: ChatSessionSummary;
  readonly session: ChatSession;
  readonly workspace: Workspace;
}

function consumedComposerPayload(session: ChatSession): ReplicaConsumedPayload {
  const projected = projectV016ComposerMessages(session.messages);
  return {
    messages: projected.map((message) => ({
      id: message.id!,
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
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((tool, toolIndex) => ({
              id: tool.id ?? `tool:${toolIndex}`,
              name: tool.name,
              status: tool.status,
              ...(tool.params !== undefined ? { params: tool.params } : {}),
              ...(tool.result !== undefined ? { result: tool.result } : {}),
              ...(tool.error !== undefined ? { error: tool.error } : {}),
            })),
          }
        : {}),
    })),
    ...(session.activeBranchMessageIds
      ? { activeBranchMessageIds: [...session.activeBranchMessageIds] }
      : {}),
  };
}

function composerWorkspaceMemberships(
  candidates: readonly ComposerPhysicalCandidate[]
): NonNullable<ChatSessionSummary['workspaceMemberships']> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const path = normalizeWorkspacePath(candidate.workspace.path);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([workspacePath, contributingInstanceCount]) => ({
      workspacePath,
      sourceRoles: ['composer'],
      contributingInstanceCount,
    }));
}

/**
 * Freeze Composer's canonical attribution independently from the active scope.
 * This reproduces the unfiltered v0.16 preference: configuration workspaces
 * precede folders, then normalized paths and physical workspace IDs break ties.
 */
function canonicalComposerCandidate(
  candidates: readonly ComposerPhysicalCandidate[]
): ComposerPhysicalCandidate | undefined {
  return [...candidates].sort((left, right) => {
    const leftPath = normalizeWorkspacePath(left.workspace.path);
    const rightPath = normalizeWorkspacePath(right.workspace.path);
    const leftKind = leftPath.toLowerCase().endsWith('.code-workspace') ? 0 : 1;
    const rightKind = rightPath.toLowerCase().endsWith('.code-workspace') ? 0 : 1;
    return (
      leftKind - rightKind ||
      compareCodePoints(leftPath, rightPath) ||
      compareCodePoints(left.workspace.id, right.workspace.id)
    );
  })[0];
}

interface ReconciledComposerRows {
  readonly resolved: ChatSessionSummary[];
  readonly ambiguous: AmbiguousSessionSummary[];
  /** Physical Composer workspace selected for each resolved logical UUID. */
  readonly selectedWorkspaces: ReadonlyMap<string, Workspace>;
}

/** Reconcile workspace replicas and apply the global-primary Composer rule. */
async function reconcileComposerRows(
  candidatesById: ReadonlyMap<string, readonly ComposerPhysicalCandidate[]>,
  globalPrimaryIds: ReadonlySet<string>,
  omittedWorkspacesById: ReadonlyMap<string, readonly Workspace[]>,
  indexScope: 'global' | 'workspace',
  activeWorkspacePath: string | undefined,
  workspaceMatchKind: ChatSessionSummary['workspaceMatchKind'],
  diagnosticContextId: string
): Promise<ReconciledComposerRows> {
  const resolved: ChatSessionSummary[] = [];
  const ambiguous: AmbiguousSessionSummary[] = [];
  const selectedWorkspaces = new Map<string, Workspace>();
  for (const [id, unsorted] of [...candidatesById.entries()].sort(([left], [right]) =>
    compareCodePoints(left, right)
  )) {
    const candidates = [...unsorted].sort((left, right) => {
      const leftPath = normalizeWorkspacePath(left.workspace.path);
      const rightPath = normalizeWorkspacePath(right.workspace.path);
      const leftMatched = activeWorkspacePath === leftPath ? 0 : 1;
      const rightMatched = activeWorkspacePath === rightPath ? 0 : 1;
      return (
        leftMatched - rightMatched ||
        compareCodePoints(leftPath, rightPath) ||
        compareCodePoints(left.workspace.id, right.workspace.id)
      );
    });
    if (candidates.length === 0) continue;
    const omittedWorkspaces = omittedWorkspacesById.get(id) ?? [];
    const membershipCandidates = [
      ...candidates,
      ...omittedWorkspaces.map((workspace): ComposerPhysicalCandidate => ({
        workspace,
        summary: candidates[0]!.summary,
        session: candidates[0]!.session,
      })),
    ];
    const memberships = composerWorkspaceMemberships(membershipCandidates);
    const canonical = canonicalComposerCandidate(membershipCandidates)!;
    const canonicalPath = normalizeWorkspacePath(canonical.workspace.path);
    if (globalPrimaryIds.has(id)) {
      const selected = candidates[0]!;
      const summary = selected.summary;
      summary.source = 'global';
      summary.resolvedSource = 'composer';
      summary.resolutionState = 'complete';
      summary.resolution = {
        state: 'complete',
        expectedSourceRoles: ['composer'],
        loadedSourceRoles: ['composer'],
        omittedSourceRoles: [],
        failedSourceRoles: [],
        reasonCodes: [],
      };
      summary.workspacePath = contractPath(canonicalPath);
      summary.canonicalWorkspacePath = canonicalPath;
      summary.workspaceMemberships = memberships;
      summary.sourceInstances = [
        {
          sourceRole: 'composer',
          representation: 'composer-global',
          workspacePaths: memberships.map(({ workspacePath }) => workspacePath),
          state: 'contributed',
        },
        ...candidates.map((candidate) => ({
          sourceRole: 'composer' as const,
          representation: 'composer-workspace' as const,
          workspacePaths: [normalizeWorkspacePath(candidate.workspace.path)],
          state: 'superseded' as const,
        })),
      ];
      resolved.push(summary);
      selectedWorkspaces.set(id, selected.workspace);
      continue;
    }

    const instances: PhysicalSessionInstance<ComposerPhysicalCandidate>[] = candidates.map(
      (candidate, sourceOrder) => ({
        instanceKey: `${candidate.workspace.id}\0${id}`,
        logicalSessionId: id,
        sourceRole: 'composer',
        representation: 'composer-workspace',
        fidelityTier: 'partial',
        locator: candidate,
        workspacePaths: [normalizeWorkspacePath(candidate.workspace.path)],
        canonicalWorkspaceCandidates: [
          {
            workspacePath: normalizeWorkspacePath(candidate.workspace.path),
            kind: candidate.workspace.path.toLowerCase().endsWith('.code-workspace')
              ? 'composer-configuration'
              : 'composer-folder',
          },
        ],
        sourceOrder,
        loadConsumedPayload: () => consumedComposerPayload(candidate.session),
      })
    );
    const catalog = buildSessionCatalog(instances, {
      ...(activeWorkspacePath
        ? {
            activeWorkspace: {
              matchedWorkspacePath: activeWorkspacePath,
              matchKind: workspaceMatchKind ?? 'exact',
            },
          }
        : {}),
    })[0]!;
    const reconciliation = await reconcileReplicaGroup(catalog.replicaGroups[0]!, {
      diagnosticContextId,
    });
    if (reconciliation.state === 'divergent') {
      ambiguous.push({
        ...projectAmbiguousSessionSummary(catalog, [reconciliation], {
          index: 0,
          indexScope,
          ...(activeWorkspacePath ? { indexWorkspacePath: activeWorkspacePath } : {}),
        }),
        canonicalWorkspacePath: canonicalPath,
      });
      continue;
    }

    const selected = reconciliation.selected.locator;
    const summary = selected.summary;
    summary.source = 'workspace-fallback';
    summary.resolvedSource = 'composer';
    summary.resolutionState = 'partial';
    summary.resolution = {
      state: 'partial',
      expectedSourceRoles: ['composer'],
      loadedSourceRoles: ['composer'],
      omittedSourceRoles: omittedWorkspaces.length > 0 ? ['composer'] : [],
      failedSourceRoles: [],
      reasonCodes:
        omittedWorkspaces.length > 0
          ? ['workspace-scope-omitted', 'source-unavailable']
          : ['source-unavailable'],
    };
    summary.workspacePath = contractPath(canonicalPath);
    summary.canonicalWorkspacePath = canonicalPath;
    summary.matchedWorkspacePath = catalog.matchedWorkspacePath;
    summary.workspaceMatchKind = catalog.workspaceMatchKind;
    summary.workspaceMemberships = memberships;
    summary.sourceInstances = [
      ...reconciliation.sourceInstances,
      ...omittedWorkspaces.map((workspace) => ({
        sourceRole: 'composer' as const,
        representation: 'composer-workspace' as const,
        workspacePaths: [normalizeWorkspacePath(workspace.path)],
        state: 'omitted-by-scope' as const,
      })),
    ];
    resolved.push(summary);
    selectedWorkspaces.set(id, selected.workspace);
  }
  return { resolved, ambiguous, selectedWorkspaces };
}

/** Record a known Store counterpart that strict workspace scope did not permit loading. */
function markStoreContributorOmittedByScope(
  summary: ChatSessionSummary,
  store: StoreSession
): void {
  summary.resolutionState = 'partial';
  summary.resolution = mergeSessionResolutions(summary.resolution, {
    state: 'partial',
    expectedSourceRoles: ['composer', 'store'],
    loadedSourceRoles: ['composer'],
    omittedSourceRoles: ['store'],
    failedSourceRoles: [],
    reasonCodes: ['workspace-scope-omitted'],
  });
  summary.resolvedSource ??= 'composer';
  const storePaths = verifiedStoreWorkspacePaths(store);
  const storePath = storePaths[0];
  const membershipByPath = new Map(
    (summary.workspaceMemberships ?? []).map((membership) => [
      membership.workspacePath,
      {
        ...membership,
        sourceRoles: [...membership.sourceRoles],
      },
    ])
  );
  for (const membership of store.workspaceMemberships ?? []) {
    const current = membershipByPath.get(membership.workspacePath);
    membershipByPath.set(
      membership.workspacePath,
      current
        ? {
            workspacePath: current.workspacePath,
            sourceRoles: orderedSourceRoles([...current.sourceRoles, ...membership.sourceRoles]),
            contributingInstanceCount: Math.max(
              current.contributingInstanceCount,
              membership.contributingInstanceCount
            ),
          }
        : { ...membership, sourceRoles: [...membership.sourceRoles] }
    );
  }
  summary.workspaceMemberships = [...membershipByPath.values()].sort((left, right) =>
    compareCodePoints(left.workspacePath, right.workspacePath)
  );
  summary.sourceInstances = [
    ...(summary.sourceInstances ?? []),
    ...(store.sourceInstances?.map((instance) => ({
      ...instance,
      workspacePaths: [...instance.workspacePaths],
      state: 'omitted-by-scope' as const,
    })) ?? [
      {
        sourceRole: 'store' as const,
        representation: store.storeDbPath
          ? ('store-db' as const)
          : store.transcriptPath
            ? ('store-transcript' as const)
            : ('store-metadata' as const),
        workspacePaths: storePath ? [storePath] : [],
        state: 'omitted-by-scope' as const,
      },
    ]),
  ];
}

function markComposerContributorOmittedByScope(
  summary: ChatSessionSummary,
  workspaces: readonly Workspace[]
): void {
  if (workspaces.length === 0) return;
  summary.resolutionState = 'partial';
  summary.resolution = mergeSessionResolutions(summary.resolution, {
    state: 'partial',
    expectedSourceRoles: ['composer', 'store'],
    loadedSourceRoles: ['store'],
    omittedSourceRoles: ['composer'],
    failedSourceRoles: [],
    reasonCodes: ['workspace-scope-omitted'],
  });
  summary.source = 'workspace-fallback';
  summary.sources = ['composer', 'store'];
  summary.sourceInstances = [
    ...(summary.sourceInstances ?? []),
    ...workspaces.map((workspace) => ({
      sourceRole: 'composer' as const,
      representation: 'composer-workspace' as const,
      workspacePaths: [normalizeWorkspacePath(workspace.path)],
      state: 'omitted-by-scope' as const,
    })),
  ];
  const memberships = new Map(
    (summary.workspaceMemberships ?? []).map((membership) => [
      membership.workspacePath,
      { ...membership, sourceRoles: [...membership.sourceRoles] },
    ])
  );
  for (const workspace of workspaces) {
    const workspacePath = normalizeWorkspacePath(workspace.path);
    const current = memberships.get(workspacePath);
    memberships.set(workspacePath, {
      workspacePath,
      sourceRoles: orderedSourceRoles([...(current?.sourceRoles ?? []), 'composer']),
      contributingInstanceCount: Math.max(current?.contributingInstanceCount ?? 0, 1),
    });
  }
  summary.workspaceMemberships = [...memberships.values()].sort((left, right) =>
    compareCodePoints(left.workspacePath, right.workspacePath)
  );
}

function markGlobalComposerContributorUnavailable(
  summary: ChatSessionSummary,
  state: 'omitted-by-scope' | 'failed',
  workspacePath?: string
): void {
  const omitted = state === 'omitted-by-scope';
  summary.resolutionState = 'partial';
  summary.resolution = mergeSessionResolutions(summary.resolution, {
    state: 'partial',
    expectedSourceRoles: ['composer', 'store'],
    loadedSourceRoles: ['store'],
    omittedSourceRoles: omitted ? ['composer'] : [],
    failedSourceRoles: omitted ? [] : ['composer'],
    reasonCodes: [omitted ? 'workspace-scope-omitted' : 'source-unavailable'],
  });
  summary.source = 'workspace-fallback';
  summary.sources = ['composer', 'store'];
  summary.sourceInstances = [
    ...(summary.sourceInstances ?? []),
    {
      sourceRole: 'composer',
      representation: 'composer-global',
      workspacePaths: workspacePath ? [normalizeWorkspacePath(workspacePath)] : [],
      state,
    },
  ];
  if (workspacePath) {
    const canonicalPath = normalizeWorkspacePath(workspacePath);
    summary.workspacePath = contractPath(canonicalPath);
    summary.canonicalWorkspacePath = canonicalPath;
    const memberships = new Map(
      (summary.workspaceMemberships ?? []).map((membership) => [
        membership.workspacePath,
        { ...membership, sourceRoles: [...membership.sourceRoles] },
      ])
    );
    const current = memberships.get(canonicalPath);
    memberships.set(canonicalPath, {
      workspacePath: canonicalPath,
      sourceRoles: orderedSourceRoles([...(current?.sourceRoles ?? []), 'composer']),
      contributingInstanceCount: Math.max(current?.contributingInstanceCount ?? 0, 1),
    });
    summary.workspaceMemberships = [...memberships.values()].sort((left, right) =>
      compareCodePoints(left.workspacePath, right.workspacePath)
    );
  }
}

const RESOLUTION_SOURCE_ROLE_ORDER: readonly SourceRole[] = ['composer', 'store'];
const RESOLUTION_REASON_ORDER = [
  'workspace-scope-omitted',
  'source-unavailable',
  'source-read-failed',
  'source-partial',
  'expected-store-db-unavailable',
  'store-db-expectation-unknown',
  'store-conversation-unavailable',
] as const satisfies readonly ResolutionReasonCode[];

function orderedSourceRoles(values: Iterable<SourceRole>): SourceRole[] {
  const roles = new Set(values);
  return RESOLUTION_SOURCE_ROLE_ORDER.filter((role) => roles.has(role));
}

function orderedResolutionReasons(values: Iterable<ResolutionReasonCode>): ResolutionReasonCode[] {
  const reasons = new Set(values);
  return RESOLUTION_REASON_ORDER.filter((reason) => reasons.has(reason));
}

/** Union independent degradation evidence without hiding either source failure. */
function mergeSessionResolutions(
  left: SessionResolution | undefined,
  right: SessionResolution | undefined
): SessionResolution | undefined {
  if (!left && !right) return undefined;
  if (!left) {
    return {
      ...right!,
      expectedSourceRoles: [...right!.expectedSourceRoles],
      loadedSourceRoles: [...right!.loadedSourceRoles],
      omittedSourceRoles: [...right!.omittedSourceRoles],
      failedSourceRoles: [...right!.failedSourceRoles],
      reasonCodes: orderedResolutionReasons(right!.reasonCodes),
    };
  }
  if (!right) {
    return {
      ...left,
      expectedSourceRoles: [...left.expectedSourceRoles],
      loadedSourceRoles: [...left.loadedSourceRoles],
      omittedSourceRoles: [...left.omittedSourceRoles],
      failedSourceRoles: [...left.failedSourceRoles],
      reasonCodes: orderedResolutionReasons(left.reasonCodes),
    };
  }
  return {
    state: left.state === 'partial' || right.state === 'partial' ? 'partial' : 'complete',
    expectedSourceRoles: orderedSourceRoles([
      ...left.expectedSourceRoles,
      ...right.expectedSourceRoles,
    ]),
    loadedSourceRoles: orderedSourceRoles([...left.loadedSourceRoles, ...right.loadedSourceRoles]),
    omittedSourceRoles: orderedSourceRoles([
      ...left.omittedSourceRoles,
      ...right.omittedSourceRoles,
    ]),
    failedSourceRoles: orderedSourceRoles([...left.failedSourceRoles, ...right.failedSourceRoles]),
    reasonCodes: orderedResolutionReasons([...left.reasonCodes, ...right.reasonCodes]),
  };
}

/** Attach locator-free scope/provenance fields after source merging is complete. */
function projectSummaryAddressing(
  summary: ChatSessionSummary,
  activeWorkspacePath: string | undefined,
  workspaceMatchKind: ChatSessionSummary['workspaceMatchKind']
): void {
  const composerBacked = summary.workspaceId !== 'store';
  const reportedPath =
    summary.workspacePath && !summary.workspacePath.startsWith('(')
      ? normalizeWorkspacePath(summary.workspacePath)
      : undefined;
  const composerPath = composerBacked ? reportedPath : undefined;
  const storePath = composerBacked ? undefined : reportedPath;
  const canonicalWorkspacePath = summary.canonicalWorkspacePath ?? composerPath ?? storePath;
  const sourceRoles: Array<'composer' | 'store'> = summary.sources
    ? (['composer', 'store'] as const).filter((role) => summary.sources!.includes(role))
    : summary.resolvedSource === 'merged'
      ? (['composer', 'store'] as const)
      : composerBacked
        ? (['composer'] as const)
        : (['store'] as const);
  summary.sources = [...sourceRoles];
  summary.resolvedSource ??= composerBacked ? 'composer' : 'store-metadata';
  const inferredState = summary.source === 'global' ? 'complete' : 'partial';
  const resolution = (summary.resolution ??= {
    state: inferredState,
    expectedSourceRoles: [...sourceRoles],
    loadedSourceRoles: [...sourceRoles],
    omittedSourceRoles: [],
    failedSourceRoles: [],
    reasonCodes: inferredState === 'complete' ? [] : ['source-unavailable'],
  });
  summary.resolutionState = resolution.state;
  summary.source = resolution.state === 'complete' ? 'global' : 'workspace-fallback';
  summary.messageIdentityVersion = 1;
  summary.indexScope = activeWorkspacePath ? 'workspace' : 'global';
  if (activeWorkspacePath) {
    summary.indexWorkspacePath = activeWorkspacePath;
    summary.matchedWorkspacePath = activeWorkspacePath;
    if (workspaceMatchKind) summary.workspaceMatchKind = workspaceMatchKind;
  }
  if (canonicalWorkspacePath) summary.canonicalWorkspacePath = canonicalWorkspacePath;
  if (composerBacked && canonicalWorkspacePath) {
    // `workspacePath` is the released compatibility alias for the canonical
    // Composer attribution, never the currently selected replica path.
    summary.workspacePath = contractPath(canonicalWorkspacePath);
  }
  if (!summary.workspaceMemberships) {
    summary.workspaceMemberships = canonicalWorkspacePath
      ? [
          {
            workspacePath: canonicalWorkspacePath,
            sourceRoles: [...sourceRoles],
            contributingInstanceCount: sourceRoles.length,
          },
        ]
      : [];
  }
  {
    const sourceInstances: NonNullable<ChatSessionSummary['sourceInstances']> = [
      ...(summary.sourceInstances ?? []),
    ];
    if (composerBacked && !sourceInstances.some(({ sourceRole }) => sourceRole === 'composer')) {
      sourceInstances.push({
        sourceRole: 'composer',
        representation: summary.workspaceId === 'global' ? 'composer-global' : 'composer-workspace',
        workspacePaths: composerPath ? [composerPath] : [],
        state: 'contributed',
      });
    }
    if (
      (summary.sources?.includes('store') || !composerBacked) &&
      !sourceInstances.some(({ sourceRole }) => sourceRole === 'store')
    ) {
      sourceInstances.push({
        sourceRole: 'store',
        representation:
          summary.resolvedSource === 'store-transcript'
            ? 'store-transcript'
            : summary.resolvedSource === 'store-metadata'
              ? 'store-metadata'
              : 'store-db',
        workspacePaths: storePath ? [storePath] : [],
        state: 'contributed',
      });
    }
    summary.sourceInstances = sourceInstances.sort((left, right) => {
      if (left.sourceRole !== right.sourceRole) return left.sourceRole === 'composer' ? -1 : 1;
      if (left.representation !== right.representation) {
        return compareCodePoints(left.representation, right.representation);
      }
      return compareStringArrays(left.workspacePaths, right.workspacePaths);
    });
  }
}

async function getWorkspacesCached(
  context: SessionReadContext | undefined,
  customDataPath?: string,
  backupPath?: string,
  workspaceFilterPath?: string
): Promise<Workspace[]> {
  assertContextSource(context, customDataPath, backupPath);
  throwIfReadAborted(context?.signal);
  if (context?.workspaces) return context.workspaces;
  if (context?.workspacesPromise) return context.workspacesPromise;

  const discovery = findWorkspaces(customDataPath, backupPath, {
    ...(context ?? {}),
    ...(workspaceFilterPath ? { workspaceFilterPath } : {}),
  });
  if (!context) return discovery;

  const tracked = discovery.then((workspaces) => {
    if (context.disposed) throw new ReadContextDisposedError();
    context.workspaces = workspaces;
    return workspaces;
  });
  context.workspacesPromise = tracked;
  const clearTrackedWorkspaceDiscovery = (): void => {
    if (!context.disposed && context.workspacesPromise === tracked) {
      context.workspacesPromise = null;
    }
  };
  void tracked.then(clearTrackedWorkspaceDiscovery, clearTrackedWorkspaceDiscovery);
  return tracked;
}

/**
 * Return the Store sessions for the operation, discovering at most once and
 * caching into the context when one is supplied. Backups never carry ~/.cursor.
 */
async function getStoreSessionsCached(
  context: SessionReadContext | undefined,
  customDataPath?: string,
  backupPath?: string,
  sessionIds?: ReadonlySet<string>,
  mode: 'metadata' | 'payload' = 'metadata'
): Promise<StoreSession[]> {
  assertContextSource(context, customDataPath, backupPath);
  throwIfReadAborted(context?.signal);
  if (backupPath) return [];
  const onDiagnostic = context?.onDiagnostic
    ? (diagnostic: import('./types.js').SessionDiagnostic): void => {
        if (context.disposed) return;
        const state = privateReadState(context);
        const key = JSON.stringify([
          diagnostic.code,
          diagnostic.sessionId,
          'sourceKind' in diagnostic ? diagnostic.sourceKind : null,
          'bound' in diagnostic ? diagnostic.bound : null,
          'observedAtLeast' in diagnostic ? diagnostic.observedAtLeast : null,
        ]);
        if (state.emittedDiagnosticKeys.has(key)) return;
        state.emittedDiagnosticKeys.add(key);
        context.onDiagnostic!(diagnostic);
      }
    : undefined;
  if (mode === 'payload') {
    let allowedOccurrenceKeys: ReadonlySet<string> | undefined;
    if (context && sessionIds) {
      const state = privateReadState(context);
      const bound = [...sessionIds].flatMap((id) => [
        ...(state.boundStoreOccurrencesBySession.get(id) ?? []),
      ]);
      if (bound.length === 0) return [];
      allowedOccurrenceKeys = new Set(bound.map(({ instanceKey }) => instanceKey));
    }
    return discoverStoreSessions(getStoreStackRoot(customDataPath), {
      sourceReadLimits: context?.sourceReadLimits,
      sqliteDriver: context?.sqliteDriver,
      signal: context?.signal,
      io: context?.io,
      ...(onDiagnostic ? { onDiagnostic } : {}),
      ...(sessionIds ? { sessionIds } : {}),
      ...(allowedOccurrenceKeys ? { allowedOccurrenceKeys } : {}),
    });
  }
  if (context?.storeSessions) return context.storeSessions;
  if (context?.storeSessionsPromise) return context.storeSessionsPromise;

  const discovery = discoverStoreSessions(getStoreStackRoot(customDataPath), {
    sourceReadLimits: context?.sourceReadLimits,
    sqliteDriver: context?.sqliteDriver,
    signal: context?.signal,
    io: context?.io,
    ...(onDiagnostic ? { onDiagnostic } : {}),
    ...(sessionIds ? { sessionIds } : {}),
    metadataOnly: true,
    includeDisplayMetadata: false,
  });
  if (!context) return discovery;

  const tracked = discovery.then((sessions) => {
    if (context.disposed) throw new ReadContextDisposedError();
    context.storeSessions = sessions;
    emitContextOwnership(context);
    return sessions;
  });
  context.storeSessionsPromise = tracked;
  const clearTrackedStoreDiscovery = (): void => {
    if (!context.disposed && context.storeSessionsPromise === tracked) {
      context.storeSessionsPromise = null;
    }
  };
  void tracked.then(clearTrackedStoreDiscovery, clearTrackedStoreDiscovery);
  return tracked;
}

function verifiedStoreWorkspacePaths(session: StoreSession): string[] {
  return [
    ...new Set(
      getStorePhysicalOccurrences(session).flatMap(({ workspacePath }) =>
        workspacePath ? [normalizeWorkspacePath(workspacePath)] : []
      )
    ),
  ].sort(compareCodePoints);
}

function storeMatchesWorkspace(session: StoreSession, workspacePath: string): boolean {
  return verifiedStoreWorkspacePaths(session).some((candidate) =>
    workspaceFilterMatches(candidate, workspacePath)
  );
}

function bindStoreOccurrences(
  context: SessionReadContext,
  storeSessions: readonly StoreSession[],
  selectedLogicalIds: ReadonlySet<string>,
  activeWorkspacePath: string | undefined
): void {
  const bindings = privateReadState(context).boundStoreOccurrencesBySession;
  bindings.clear();
  for (const session of storeSessions) {
    if (!selectedLogicalIds.has(session.id)) continue;
    const inventoried = getStorePhysicalOccurrences(session);
    const permitted =
      !activeWorkspacePath || context.includeCrossWorkspaceSources
        ? inventoried
        : inventoried.filter(
            ({ workspacePath }) =>
              workspacePath && workspaceFilterMatches(workspacePath, activeWorkspacePath)
          );
    bindings.set(session.id, Object.freeze([...permitted]));
  }
}

function projectBoundStoreScope(
  context: SessionReadContext,
  session: StoreSession,
  activeWorkspacePath: string | undefined
): void {
  if (!activeWorkspacePath) return;
  const all = getStorePhysicalOccurrences(session);
  const bound = new Set(
    (privateReadState(context).boundStoreOccurrencesBySession.get(session.id) ?? []).map(
      ({ instanceKey }) => instanceKey
    )
  );
  const db = all.filter(({ representation }) => representation === 'store-db');
  const transcripts = all.filter(({ representation }) => representation === 'store-transcript');
  const metadata = all.filter(({ representation }) => representation === 'store-metadata');
  const relevant =
    db.length > 0 ? [...db, ...transcripts] : transcripts.length > 0 ? transcripts : metadata;
  let contributed = false;
  session.sourceInstances = relevant.map((item) => {
    if (!bound.has(item.instanceKey)) {
      return {
        sourceRole: 'store' as const,
        representation: item.representation,
        workspacePaths: item.workspacePath ? [item.workspacePath] : [],
        state: 'omitted-by-scope' as const,
      };
    }
    const state = contributed
      ? item.representation === 'store-metadata'
        ? ('equivalent-replica' as const)
        : ('superseded' as const)
      : ('contributed' as const);
    contributed = true;
    return {
      sourceRole: 'store' as const,
      representation: item.representation,
      workspacePaths: item.workspacePath ? [item.workspacePath] : [],
      state,
    };
  });
  if (relevant.some((item) => !bound.has(item.instanceKey))) {
    session.resolution = mergeSessionResolutions(session.resolution, {
      state: 'partial',
      expectedSourceRoles: ['store'],
      loadedSourceRoles: bound.size > 0 ? ['store'] : [],
      omittedSourceRoles: ['store'],
      failedSourceRoles: [],
      reasonCodes: ['workspace-scope-omitted'],
    });
    session.source = 'workspace-fallback';
  }
}

async function hydrateSelectedStoreDisplayMetadata(
  context: SessionReadContext,
  storeSessions: readonly StoreSession[],
  customDataPath?: string
): Promise<void> {
  const bindings = privateReadState(context).boundStoreOccurrencesBySession;
  const selectedIds = new Set(
    [...bindings.entries()].flatMap(([id, occurrences]) => (occurrences.length > 0 ? [id] : []))
  );
  if (selectedIds.size === 0) return;
  const allowedOccurrenceKeys = new Set(
    [...selectedIds].flatMap((id) => (bindings.get(id) ?? []).map(({ instanceKey }) => instanceKey))
  );
  const displayRows = await discoverStoreSessions(getStoreStackRoot(customDataPath), {
    sourceReadLimits: context.sourceReadLimits,
    sqliteDriver: context.sqliteDriver,
    signal: context.signal,
    io: context.io,
    sessionIds: selectedIds,
    allowedOccurrenceKeys,
    metadataOnly: true,
    includeDisplayMetadata: true,
  });
  const displayById = new Map(displayRows.map((session) => [session.id, session]));
  for (const session of storeSessions) {
    const display = displayById.get(session.id);
    if (!display) continue;
    // Display hydration is intentionally narrow. Canonical workspace and
    // source timestamps were selected from the complete metadata inventory;
    // replacing them with the active scope's occurrence would make stable
    // returned values depend on the workspace filter.
    session.title = display.title;
  }
}

/**
 * List one resolved presentation row per logical native session UUID.
 * Workspace filters bind an ephemeral local index and the permitted physical
 * contributor set; they do not change the public logical ID.
 * @param options - List options (limit, all, workspacePath)
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 * @param context - Optional operation-scoped read context for caching
 */
export async function listSessions(
  options: ListOptions,
  customDataPath?: string,
  backupPath?: string,
  context?: SessionReadContext
): Promise<ChatSessionSummary[]> {
  if (!context) {
    const ownedContext = createSessionReadContext({
      dataPath: customDataPath,
      backupPath,
      workspacePath: options.workspacePath,
      includeCrossWorkspaceSources: options.includeCrossWorkspaceSources,
      sourceReadLimits: options.sourceReadLimits,
      signal: options.signal,
    });
    try {
      return await listSessions(options, customDataPath, backupPath, ownedContext);
    } finally {
      await ownedContext.dispose();
    }
  }
  resolveSourceReadLimits(options.sourceReadLimits ?? context?.sourceReadLimits);
  throwIfReadAborted(options.signal ?? context?.signal);
  assertContextSource(context, customDataPath, backupPath);
  bindContextWorkspaceScope(context, options.workspacePath);
  assertContextReadOptions(context, options);

  let workspaceScopeResult: WorkspaceScopeResult | undefined;
  let activeWorkspacePath: string | undefined;
  let composerWorkspaceInventory: Workspace[] = [];
  const storeCatalogSessions = backupPath
    ? []
    : await getStoreSessionsCached(context, customDataPath, backupPath);
  if (options.workspacePath) {
    composerWorkspaceInventory = await findComposerWorkspaceInventory(
      customDataPath,
      backupPath,
      context
    );
    const storeWorkspacePaths = storeCatalogSessions.flatMap(verifiedStoreWorkspacePaths);
    workspaceScopeResult = resolveWorkspaceScope(options.workspacePath, [
      ...composerWorkspaceInventory.map(({ path }) => path),
      ...storeWorkspacePaths,
    ]);
    if (workspaceScopeResult.kind === 'not-found') {
      if (context) context.summaries = [];
      return [];
    }
    activeWorkspacePath = workspaceScopeResult.path;
  }
  if (context?.summaries) {
    return applySessionListLimit(context.summaries, options);
  }

  // T029: Support reading from backup
  const workspaces = await getWorkspacesCached(
    context,
    customDataPath,
    backupPath,
    activeWorkspacePath
  );

  // Filter by workspace if specified
  // Deterministic order: .code-workspace paths before others, then by path (for stable attribution when deduping)
  const filteredWorkspaces = (
    activeWorkspacePath
      ? workspaces.filter((w) => workspaceFilterMatches(w.path, activeWorkspacePath!))
      : workspaces
  ).sort((a, b) => {
    const normA = normalizePath(a.path);
    const normB = normalizePath(b.path);
    const aCode = normA.endsWith('.code-workspace') ? 0 : 1;
    const bCode = normB.endsWith('.code-workspace') ? 0 : 1;
    if (aCode !== bCode) return aCode - bCode;
    return compareCodePoints(normA, normB);
  });

  const allSessions: ChatSessionSummary[] = [];
  const composerCandidatesById = new Map<string, ComposerPhysicalCandidate[]>();
  const omittedComposerWorkspacesById = new Map<string, Workspace[]>();
  const selectedStoreIds = new Set(
    storeCatalogSessions
      .filter(
        (session) => !activeWorkspacePath || storeMatchesWorkspace(session, activeWorkspacePath)
      )
      .map(({ id }) => id)
  );
  const globalPrimaryIds = new Set<string>();
  const omittedGlobalComposerIds = new Set<string>();
  const failedGlobalComposerIds = new Set<string>();
  const globalComposerWorkspacePaths = new Map<string, string>();
  // When listing all workspaces (no filter), dedupe by session id; keep first occurrence (workspace order is already deterministic)
  const seenIds = activeWorkspacePath ? null : new Set<string>();
  const globalFallbackCandidates: WorkspaceGlobalCandidate[] = [];

  for (const workspace of filteredWorkspaces) {
    throwIfReadAborted(options.signal ?? context?.signal);
    let workspaceDb: Database | null = null;
    let workspaceReadError: unknown;
    try {
      // Open database from live or backup source
      workspaceDb = backupPath
        ? await openBackupDatabase(backupPath, workspace.dbPath, {
            sourceReadLimits: context?.sourceReadLimits,
            signal: options.signal ?? context?.signal,
            sqliteDriver: context?.sqliteDriver,
            io: context?.io,
          })
        : await openDatabase(
            workspace.dbPath,
            withDatabaseIo(context, {
              resourceClass: 'workspace-conversation',
              sourceRole: 'composer',
              representation: 'composer-workspace',
            })
          );
      throwIfReadAborted(options.signal ?? context?.signal);
      const workspaceCatalogBudget = createComposerSqliteBudget(
        context.sourceReadLimits ?? SOURCE_READ_LIMITS_V1_DEFAULTS
      );
      const result = getChatDataFromDb(
        workspaceDb,
        workspaceCatalogBudget,
        options.signal ?? context?.signal
      );
      // Pointer keys (e.g. composerChatViewPane.<guid>) live in ItemTable and link
      // this workspace to its global composers even when no workspace stamp exists.
      const pointerIds = backupPath
        ? []
        : getWorkspaceComposerPointerIds(
            workspaceDb,
            workspaceCatalogBudget,
            options.signal ?? context?.signal
          );

      const sessions = result ? parseChatData(result.data, result.bundle) : [];
      const workspaceSeenIds = new Set<string>();
      const selectedIds: string[] = [];

      if (result) {
        const rawComposerData = result.bundle.composerData;
        const composerRefs = extractComposerIdsFromData(rawComposerData);
        selectedIds.push(
          ...composerRefs
            .filter((ref) => ref.source === 'selectedComposerIds')
            .map((ref) => ref.composerId)
        );
      }
      selectedIds.push(...pointerIds);
      if (selectedIds.length > 0) {
        debugLogStorage(
          `Workspace ${workspace.id} has ${selectedIds.length} global recovery candidate(s)`
        );
      }

      for (const session of sessions) {
        workspaceSeenIds.add(session.id);
        seenIds?.add(session.id);
        const summary: ChatSessionSummary = {
          id: session.id,
          index: 0, // Will be assigned after sorting
          title: session.title,
          createdAt: session.createdAt,
          createdAtSource: session.createdAtSource,
          lastUpdatedAt: session.lastUpdatedAt,
          lastUpdatedAtSource: session.lastUpdatedAtSource,
          messageCount: session.messageCount,
          workspaceId: workspace.id,
          workspacePath: contractPath(workspace.path),
          preview: session.messages[0]?.content.slice(0, 100) ?? '(Empty session)',
        };
        allSessions.push(summary);
        const candidates = composerCandidatesById.get(session.id) ?? [];
        candidates.push({ summary, session, workspace });
        composerCandidatesById.set(session.id, candidates);
      }

      if (!backupPath) {
        globalFallbackCandidates.push({
          workspace,
          composerIds: selectedIds,
          existingIds: workspaceSeenIds,
          includeWorkspaceLinked: true,
        });
      }
    } catch (error) {
      workspaceReadError = error;
      if (backupPath || shouldPropagateReadFailure(error)) throw error;
      debugLogStorage(
        `Skipping workspace ${workspace.id} while listing sessions: ${getErrorMessage(error)}`
      );
      continue;
    } finally {
      closeDatabaseOrThrow(workspaceDb, workspaceReadError);
    }
  }

  // Workspace scope may inspect UUID-only catalog metadata outside the
  // selected path. Payload hydration remains forbidden unless the caller opts
  // in, and even then is restricted to UUIDs already admitted in scope.
  if (activeWorkspacePath) {
    const offScopeWorkspaces = composerWorkspaceInventory.filter(
      ({ path }) => !workspaceFilterMatches(path, activeWorkspacePath!)
    );
    for (const workspace of offScopeWorkspaces) {
      let metadataDb: Database | null = null;
      let metadataError: unknown;
      try {
        metadataDb = backupPath
          ? await openBackupDatabase(backupPath, workspace.dbPath, {
              sourceReadLimits: context.sourceReadLimits,
              signal: context.signal,
              sqliteDriver: context.sqliteDriver,
              io: context.io,
            })
          : await openDatabase(
              workspace.dbPath,
              withDatabaseIo(context, {
                resourceClass: 'workspace-session-index',
                sourceRole: 'composer',
                representation: 'composer-workspace',
              })
            );
        const metadataBudget = createComposerSqliteBudget(
          context.sourceReadLimits ?? SOURCE_READ_LIMITS_V1_DEFAULTS
        );
        for (const id of loadWorkspaceComposerIdsOnly(metadataDb, metadataBudget, context.signal)) {
          if (!composerCandidatesById.has(id) && !selectedStoreIds.has(id)) continue;
          const omitted = omittedComposerWorkspacesById.get(id) ?? [];
          omitted.push(workspace);
          omittedComposerWorkspacesById.set(id, omitted);
        }
      } catch (error) {
        metadataError = error;
        if (shouldPropagateReadFailure(error)) throw error;
      } finally {
        closeDatabaseOrThrow(metadataDb, metadataError);
      }
    }

    if (context.includeCrossWorkspaceSources) {
      for (const [id, offScopeWorkspacesForId] of omittedComposerWorkspacesById) {
        for (const workspace of offScopeWorkspacesForId) {
          let payloadDb: Database | null = null;
          let payloadError: unknown;
          try {
            payloadDb = backupPath
              ? await openBackupDatabase(backupPath, workspace.dbPath, {
                  sourceReadLimits: context.sourceReadLimits,
                  signal: context.signal,
                  sqliteDriver: context.sqliteDriver,
                  io: context.io,
                  logicalSessionId: id,
                })
              : await openDatabase(
                  workspace.dbPath,
                  withDatabaseIo(context, {
                    resourceClass: 'workspace-conversation',
                    logicalSessionId: id,
                    sourceRole: 'composer',
                    representation: 'composer-workspace',
                  })
                );
            const session = loadOneWorkspaceComposer(
              payloadDb,
              id,
              createComposerSqliteBudget(
                context.sourceReadLimits ?? SOURCE_READ_LIMITS_V1_DEFAULTS
              ),
              context.signal
            );
            if (!session) continue;
            const summary: ChatSessionSummary = {
              id,
              index: 0,
              title: session.title,
              createdAt: session.createdAt,
              createdAtSource: session.createdAtSource,
              lastUpdatedAt: session.lastUpdatedAt,
              lastUpdatedAtSource: session.lastUpdatedAtSource,
              messageCount: session.messageCount,
              workspaceId: workspace.id,
              workspacePath: contractPath(workspace.path),
              preview: session.messages[0]?.content.slice(0, 100) ?? '(Empty session)',
            };
            const candidates = composerCandidatesById.get(id) ?? [];
            candidates.push({ summary, session, workspace });
            composerCandidatesById.set(id, candidates);
          } catch (error) {
            payloadError = error;
            if (shouldPropagateReadFailure(error)) throw error;
          } finally {
            closeDatabaseOrThrow(payloadDb, payloadError);
          }
        }
      }
    }
  }

  if (
    !backupPath &&
    (globalFallbackCandidates.length > 0 || !activeWorkspacePath || selectedStoreIds.size > 0)
  ) {
    const globalDbPath = join(getGlobalStoragePath(customDataPath), 'state.vscdb');
    observeStorageAdapterIo(context, {
      adapter: 'filesystem',
      operation: 'open',
      resourceClass: 'global-session-index',
      sourceRole: 'composer',
      representation: 'composer-global',
    });
    if (existsSync(globalDbPath)) {
      let globalDb: Database | null = null;
      try {
        throwIfReadAborted(options.signal ?? context?.signal);
        globalDb = await openDatabase(
          globalDbPath,
          withDatabaseIo(context, {
            resourceClass: 'global-session-index',
            sourceRole: 'composer',
            representation: 'composer-global',
          })
        );
        const tableCheck = globalDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
          .get();

        if (tableCheck) {
          const globalCatalogBudget = createComposerSqliteBudget(
            context.sourceReadLimits ?? SOURCE_READ_LIMITS_V1_DEFAULTS
          );
          // Unfiltered discovery already needs the complete bubble catalog for
          // catch-all recovery. Reuse that one bounded scan for Store UUID
          // probes instead of issuing one LIKE count per Store session.
          const globalBubbleCounts = activeWorkspacePath
            ? new Map<string, number>()
            : loadGlobalBubbleCounts(
                globalDb,
                globalCatalogBudget,
                options.signal ?? context.signal
              );
          const scopedStoreComposerIds = new Set<string>();
          const catalogProbeIds = new Set([...composerCandidatesById.keys(), ...selectedStoreIds]);
          for (const composerId of catalogProbeIds) {
            const bubbleCount = activeWorkspacePath
              ? countGlobalComposerBubbles(
                  globalDb,
                  composerId,
                  globalCatalogBudget,
                  options.signal ?? context.signal
                )
              : (globalBubbleCounts.get(composerId) ?? 0);
            if (bubbleCount > 0) {
              globalPrimaryIds.add(composerId);
              if (selectedStoreIds.has(composerId) && !composerCandidatesById.has(composerId)) {
                const projectedWorkspacePath = getGlobalComposerWorkspacePathMetadata(
                  globalDb,
                  composerId,
                  globalCatalogBudget,
                  options.signal ?? context.signal
                );
                if (projectedWorkspacePath) {
                  globalComposerWorkspacePaths.set(composerId, projectedWorkspacePath);
                }
                if (!activeWorkspacePath || context.includeCrossWorkspaceSources) {
                  const globalSummary =
                    getGlobalComposerSummary(
                      globalDb,
                      composerId,
                      new Map([[composerId, bubbleCount]]),
                      globalCatalogBudget,
                      options.signal ?? context.signal
                    ) ??
                    buildGlobalComposerSummary(
                      globalDb,
                      composerId,
                      {},
                      { bubbleCount },
                      globalCatalogBudget,
                      options.signal ?? context.signal
                    );
                  if (globalSummary) {
                    scopedStoreComposerIds.add(composerId);
                    const globalWorkspacePath =
                      globalSummary.workspacePath ?? projectedWorkspacePath;
                    allSessions.push({
                      id: globalSummary.id,
                      index: 0,
                      title: globalSummary.title,
                      createdAt: globalSummary.createdAt,
                      createdAtSource: globalSummary.createdAtSource,
                      lastUpdatedAt: globalSummary.lastUpdatedAt,
                      lastUpdatedAtSource: globalSummary.lastUpdatedAtSource,
                      messageCount: globalSummary.messageCount,
                      workspaceId: 'global',
                      workspacePath: globalWorkspacePath
                        ? contractPath(globalWorkspacePath)
                        : '(global)',
                      preview: globalSummary.preview || '(Empty session)',
                    });
                  } else {
                    failedGlobalComposerIds.add(composerId);
                  }
                } else {
                  omittedGlobalComposerIds.add(composerId);
                }
              }
            }
          }
          const globalComposerRecords = activeWorkspacePath
            ? []
            : loadGlobalComposerRecords(
                globalDb,
                globalCatalogBudget,
                options.signal ?? context.signal
              );
          if (activeWorkspacePath) {
            for (const candidate of globalFallbackCandidates) {
              candidate.composerIds.push(
                ...loadGlobalComposerMembershipIds(
                  globalDb,
                  candidate.workspace,
                  globalCatalogBudget,
                  options.signal ?? context.signal
                )
              );
            }
          }
          const summaryCache = new Map<string, GlobalComposerSummary | null>();
          // Dedup recovered sessions across candidates even under `--workspace`
          // (where the shared `seenIds` is intentionally null), so a single global
          // composer matching multiple workspace dirs is listed at most once.
          const recoveredIds = new Set<string>(scopedStoreComposerIds);
          for (const candidate of globalFallbackCandidates) {
            for (const composerId of candidate.composerIds) {
              if (candidate.existingIds.has(composerId)) continue;
              if (seenIds?.has(composerId)) continue;
              if (recoveredIds.has(composerId)) continue;

              if (!summaryCache.has(composerId)) {
                summaryCache.set(
                  composerId,
                  getGlobalComposerSummary(
                    globalDb,
                    composerId,
                    globalBubbleCounts,
                    globalCatalogBudget,
                    options.signal ?? context.signal
                  )
                );
              }

              const summary = summaryCache.get(composerId);
              if (!summary) {
                continue;
              }

              candidate.existingIds.add(summary.id);
              seenIds?.add(summary.id);
              recoveredIds.add(summary.id);
              allSessions.push({
                id: summary.id,
                index: 0,
                title: summary.title,
                createdAt: summary.createdAt,
                createdAtSource: summary.createdAtSource,
                lastUpdatedAt: summary.lastUpdatedAt,
                lastUpdatedAtSource: summary.lastUpdatedAtSource,
                messageCount: summary.messageCount,
                workspaceId: candidate.workspace.id,
                workspacePath: contractPath(candidate.workspace.path),
                preview: summary.preview || '(Empty session)',
              });
            }

            if (candidate.includeWorkspaceLinked && !activeWorkspacePath) {
              for (const summary of getGlobalComposerSummariesForWorkspace(
                globalDb,
                candidate.workspace,
                globalComposerRecords,
                globalBubbleCounts,
                globalCatalogBudget,
                options.signal ?? context.signal
              )) {
                if (candidate.existingIds.has(summary.id)) continue;
                if (seenIds?.has(summary.id)) continue;
                if (recoveredIds.has(summary.id)) continue;

                candidate.existingIds.add(summary.id);
                seenIds?.add(summary.id);
                recoveredIds.add(summary.id);
                allSessions.push({
                  id: summary.id,
                  index: 0,
                  title: summary.title,
                  createdAt: summary.createdAt,
                  createdAtSource: summary.createdAtSource,
                  lastUpdatedAt: summary.lastUpdatedAt,
                  lastUpdatedAtSource: summary.lastUpdatedAtSource,
                  messageCount: summary.messageCount,
                  workspaceId: candidate.workspace.id,
                  workspacePath: contractPath(candidate.workspace.path),
                  preview: summary.preview || '(Empty session)',
                });
              }
            }
          }

          // Catch-all: surface global composers that could not be attributed to any
          // workspace (modern Cursor frequently stores no workspace stamp on the
          // global record). Only on the unfiltered listing, where `seenIds` tracks
          // everything already shown.
          if (seenIds && !activeWorkspacePath) {
            for (const record of globalComposerRecords) {
              if (seenIds.has(record.id) || recoveredIds.has(record.id)) continue;

              // Use the precomputed bubble counts and skip the per-composer
              // first-bubble preview query so the catch-all stays ~one scan total
              // even when hundreds of composers are unattributed.
              const summary = buildGlobalComposerSummary(
                globalDb,
                record.id,
                record.data,
                {
                  bubbleCount: globalBubbleCounts.get(record.id) ?? 0,
                  includePreview: false,
                },
                globalCatalogBudget,
                options.signal ?? context.signal
              );
              if (!summary) continue;

              seenIds.add(summary.id);
              recoveredIds.add(summary.id);
              const derivedPath = workspacePathFromComposer(record.data);
              allSessions.push({
                id: summary.id,
                index: 0,
                title: summary.title,
                createdAt: summary.createdAt,
                createdAtSource: summary.createdAtSource,
                lastUpdatedAt: summary.lastUpdatedAt,
                lastUpdatedAtSource: summary.lastUpdatedAtSource,
                messageCount: summary.messageCount,
                workspaceId: 'global',
                workspacePath: derivedPath ? contractPath(derivedPath) : '(global)',
                preview: summary.preview || '(Empty session)',
              });
            }
          }
        }
      } catch (error) {
        if (shouldPropagateReadFailure(error)) throw error;
        debugLogStorage(`Failed to load global fallback sessions: ${getErrorMessage(error)}`);
      } finally {
        closeDatabase(globalDb);
      }
    }
  }

  // Backups carry the Composer global database as a separate archive entry.
  // Its UUID/bubble presence is metadata needed to classify an already
  // selected workspace row; inspect it before replica arbitration without
  // decoding conversation content.
  if (backupPath && composerCandidatesById.size > 0) {
    let backupGlobalDb: Database | null = null;
    let backupGlobalReadError: unknown;
    try {
      backupGlobalDb = await openBackupDatabase(backupPath, 'globalStorage/state.vscdb', {
        sourceReadLimits: context.sourceReadLimits,
        signal: options.signal ?? context.signal,
        sqliteDriver: context.sqliteDriver,
        io: context.io,
      });
      const tableCheck = backupGlobalDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
        .get();
      if (tableCheck) {
        const backupCatalogBudget = createComposerSqliteBudget(
          context.sourceReadLimits ?? SOURCE_READ_LIMITS_V1_DEFAULTS
        );
        for (const composerId of composerCandidatesById.keys()) {
          if (
            countGlobalComposerBubbles(
              backupGlobalDb,
              composerId,
              backupCatalogBudget,
              options.signal ?? context.signal
            ) > 0
          ) {
            globalPrimaryIds.add(composerId);
          }
        }
      }
    } catch (error) {
      backupGlobalReadError = error;
      if (!(error instanceof BackupEntryNotFoundError)) throw error;
      debugLogStorage('Global DB not present in backup; using workspace fallback summaries.');
    } finally {
      closeDatabaseOrThrow(backupGlobalDb, backupGlobalReadError);
    }
  }

  // v0.16 sorted sessions by createdAt alone and relied on the stable Array.sort
  // contract to retain Composer discovery order for equal timestamps. Capture
  // that order before replica reconciliation reshapes the physical rows. This
  // keeps existing Composer numeric addresses compatible without making the
  // order of newly introduced Store-only rows depend on physical discovery.
  const v016ComposerDiscoveryOrder = new Map<string, number>();
  for (const summary of allSessions) {
    if (!v016ComposerDiscoveryOrder.has(summary.id)) {
      v016ComposerDiscoveryOrder.set(summary.id, v016ComposerDiscoveryOrder.size);
    }
  }

  const composerReplicaIds = new Set(composerCandidatesById.keys());
  const nonReplicaComposerRows = allSessions.filter(({ id }) => !composerReplicaIds.has(id));
  const composerRows = await reconcileComposerRows(
    composerCandidatesById,
    globalPrimaryIds,
    context.includeCrossWorkspaceSources ? new Map() : omittedComposerWorkspacesById,
    activeWorkspacePath ? 'workspace' : 'global',
    activeWorkspacePath,
    workspaceScopeResult?.kind === 'matched' ? workspaceScopeResult.matchKind : undefined,
    `${context.io.dataSourceIdentity}:${activeWorkspacePath ?? 'global'}`
  );
  const boundComposerWorkspaces = privateReadState(context).boundComposerWorkspaceBySession;
  boundComposerWorkspaces.clear();
  for (const [sessionId, workspace] of composerRows.selectedWorkspaces) {
    boundComposerWorkspaces.set(sessionId, workspace);
  }
  allSessions.splice(0, allSessions.length, ...nonReplicaComposerRows, ...composerRows.resolved);
  const storeAmbiguousRows: AmbiguousSessionSummary[] = [];

  // Merge Cursor Store-stack sessions (~/.cursor/{chats,projects}).
  // Independent from Composer customDataPath; discovered via getStoreStackRoot().
  // Falls back to [] when ~/.cursor is absent (pure-Composer users unaffected).
  // Skipped in backup mode: backups capture vscdb, not the live ~/.cursor tree.
  if (!backupPath) {
    const selectedLogicalIds = new Set([
      ...allSessions.map((session) => session.id),
      ...selectedStoreIds,
    ]);
    bindStoreOccurrences(context, storeCatalogSessions, selectedLogicalIds, activeWorkspacePath);
    await hydrateSelectedStoreDisplayMetadata(context, storeCatalogSessions, customDataPath);
    for (const session of storeCatalogSessions) {
      if (selectedLogicalIds.has(session.id)) {
        projectBoundStoreScope(context, session, activeWorkspacePath);
      }
    }
    // Store discovery is metadata-only here. Conversation payload for one UUID
    // is hydrated later by getSession(), never retained by the listing context.
    const storeSessions = storeCatalogSessions;
    const storeAmbiguousIds = new Set<string>();
    for (const session of storeSessions) {
      const bound = privateReadState(context).boundStoreOccurrencesBySession.get(session.id) ?? [];
      const dbCount = bound.filter(({ representation }) => representation === 'store-db').length;
      const transcriptCount = bound.filter(
        ({ representation }) => representation === 'store-transcript'
      ).length;
      if (dbCount < 2 && transcriptCount < 2) continue;
      try {
        const reconciled = (
          await getStoreSessionsCached(
            context,
            customDataPath,
            backupPath,
            new Set([session.id]),
            'payload'
          )
        ).find(({ id }) => id === session.id);
        if (!reconciled) continue;
        session.sourceInstances = reconciled.sourceInstances;
        session.workspaceMemberships = reconciled.workspaceMemberships;
        session.resolution = reconciled.resolution;
        session.resolvedSource = reconciled.resolvedSource;
      } catch (error) {
        if (!(error instanceof SessionAmbiguityError)) throw error;
        storeAmbiguousIds.add(session.id);
        const composer = allSessions.find(({ id }) => id === session.id);
        allSessions.splice(
          0,
          allSessions.length,
          ...allSessions.filter(({ id }) => id !== session.id)
        );
        storeAmbiguousRows.push({
          id: session.id,
          index: 0,
          indexScope: activeWorkspacePath ? 'workspace' : 'global',
          ...(activeWorkspacePath ? { indexWorkspacePath: activeWorkspacePath } : {}),
          resolutionState: 'ambiguous',
          sourceRoles: ['store'],
          occurrenceCount: error.details.occurrenceCount,
          diagnosticOccurrenceRefs: [...error.details.occurrenceRefs],
          ...(composer?.canonicalWorkspacePath
            ? { canonicalWorkspacePath: composer.canonicalWorkspacePath }
            : session.workspacePath
              ? { canonicalWorkspacePath: normalizeWorkspacePath(session.workspacePath) }
              : {}),
          ...(activeWorkspacePath ? { matchedWorkspacePath: activeWorkspacePath } : {}),
        });
      }
    }
    const storeSeenIds = new Set(allSessions.map((session) => session.id));
    // Conflict priority for sessions present in BOTH stacks (same ID).
    const preferredSource = detectPreferredStackSource(customDataPath);
    for (const ss of storeSessions) {
      if (storeAmbiguousIds.has(ss.id)) continue;
      const storeMatchesScope = activeWorkspacePath
        ? storeMatchesWorkspace(ss, activeWorkspacePath)
        : true;
      const composerSelected = storeSeenIds.has(ss.id);
      if (activeWorkspacePath && !storeMatchesScope && !composerSelected) continue;

      // Same ID in both stacks → merge scalar metadata and mark merged instead
      // of discarding the lower-priority representation. The full
      // field/message merge happens in getSession(). Do this before applying
      // the Store path filter: the Composer half has already matched the
      // requested workspace, while transcript-only Store metadata may not
      // contain a cwd at all.
      if (composerSelected) {
        const existingSummaries = allSessions.filter((s) => s.id === ss.id);
        for (const existing of existingSummaries) {
          if (!activeWorkspacePath || storeMatchesScope || context.includeCrossWorkspaceSources) {
            applyStoreMergeToSummary(
              existing,
              {
                id: ss.id,
                title: ss.title,
                createdAt: ss.createdAt,
                createdAtSource: ss.createdAtSource,
                lastUpdatedAt: ss.lastUpdatedAt,
                lastUpdatedAtSource: ss.lastUpdatedAtSource,
                directMessages: ss.messages,
                workspacePath: ss.workspacePath,
                messageCount: ss.messages.length,
                source: ss.source,
                resolution: ss.resolution,
                transcriptState: ss.transcriptState,
                sourceInstances: ss.sourceInstances,
                workspaceMemberships: ss.workspaceMemberships,
              },
              preferredSource
            );
          } else {
            markStoreContributorOmittedByScope(existing, ss);
          }
        }
        continue;
      }
      storeSeenIds.add(ss.id);
      const storeSummary: ChatSessionSummary = {
        id: ss.id,
        index: 0,
        title: ss.title,
        createdAt: ss.createdAt,
        createdAtSource: ss.createdAtSource,
        lastUpdatedAt: ss.lastUpdatedAt,
        lastUpdatedAtSource: ss.lastUpdatedAtSource,
        messageCount: ss.messages.length,
        workspaceId: 'store',
        workspacePath: ss.workspacePath ? contractPath(ss.workspacePath) : '(unknown workspace)',
        preview:
          ss.resolvedSource === 'store-metadata'
            ? '(Messages not loaded)'
            : (ss.messages[0]?.content.slice(0, 100) ?? '(Empty session)'),
        // Metadata-only discovery cannot prove that an inventoried payload is
        // complete. Keep the released field as the replacement-safety signal;
        // representation/provenance lives in the additive fields below.
        source: ss.resolution?.state === 'complete' ? 'global' : 'workspace-fallback',
        resolvedSource: ss.resolvedSource,
        resolutionState:
          ss.resolution?.state ?? (ss.resolvedSource === 'store-metadata' ? 'partial' : undefined),
        resolution: ss.resolution,
        messageIdentityVersion: 1,
        ...(ss.workspaceMemberships
          ? {
              workspaceMemberships: ss.workspaceMemberships.map((membership) => ({
                ...membership,
                sourceRoles: [...membership.sourceRoles],
              })),
            }
          : {}),
        ...(ss.sourceInstances
          ? {
              sourceInstances: ss.sourceInstances.map((instance) => ({
                ...instance,
                workspacePaths: [...instance.workspacePaths],
              })),
            }
          : {}),
        ...(ss.resolvedSource === 'store-metadata' ? {} : { transcriptState: ss.transcriptState }),
      };
      markComposerContributorOmittedByScope(
        storeSummary,
        omittedComposerWorkspacesById.get(ss.id) ?? []
      );
      if (omittedGlobalComposerIds.has(ss.id)) {
        markGlobalComposerContributorUnavailable(
          storeSummary,
          'omitted-by-scope',
          globalComposerWorkspacePaths.get(ss.id)
        );
      }
      if (failedGlobalComposerIds.has(ss.id)) {
        markGlobalComposerContributorUnavailable(
          storeSummary,
          'failed',
          globalComposerWorkspacePaths.get(ss.id)
        );
      }
      allSessions.push(storeSummary);
    }
  }

  for (const summary of allSessions) {
    projectSummaryAddressing(
      summary,
      activeWorkspacePath,
      workspaceScopeResult?.kind === 'matched' ? workspaceScopeResult.matchKind : undefined
    );
  }

  // Sort and index the logical catalog before omitting ambiguity rows from the
  // legacy full-session listing. Resolved presentation indices may therefore
  // contain intentional gaps and must never be backfilled.
  const ambiguityTimes = new Map(
    [...composerCandidatesById.entries()].map(([id, candidates]) => [
      id,
      Math.max(...candidates.map(({ summary }) => summary.createdAt.getTime())),
    ])
  );
  const logicalRows: Array<{ row: LogicalSessionSummary; timestamp: number }> = [
    ...allSessions.map((row) => ({ row, timestamp: row.createdAt.getTime() })),
    ...composerRows.ambiguous.map((row) => ({
      row,
      timestamp: ambiguityTimes.get(row.id) ?? 0,
    })),
    ...storeAmbiguousRows.map((row) => ({
      row,
      timestamp: storeCatalogSessions.find(({ id }) => id === row.id)?.createdAt.getTime() ?? 0,
    })),
  ];
  logicalRows.sort((left, right) => {
    const byTimestamp = right.timestamp - left.timestamp;
    if (byTimestamp !== 0) return byTimestamp;

    const leftComposerOrder = v016ComposerDiscoveryOrder.get(left.row.id);
    const rightComposerOrder = v016ComposerDiscoveryOrder.get(right.row.id);
    if (leftComposerOrder !== undefined && rightComposerOrder !== undefined) {
      return leftComposerOrder - rightComposerOrder;
    }
    if (leftComposerOrder !== undefined) return -1;
    if (rightComposerOrder !== undefined) return 1;

    // Rows that did not exist in the v0.16 Composer catalog still need a
    // canonical tie-break independent of Store/diagnostic discovery order.
    return compareCodePoints(left.row.id, right.row.id);
  });
  const indexedLogicalRows = logicalRows.map(({ row, timestamp }, index) => ({
    row: { ...row, index: index + 1 } as LogicalSessionSummary,
    timestamp,
  }));
  allSessions.splice(
    0,
    allSessions.length,
    ...indexedLogicalRows
      .map(({ row }) => row)
      .filter((row): row is ChatSessionSummary => row.resolutionState !== 'ambiguous')
  );

  // Keep the exact listing scope. In particular, a workspace-filtered operation
  // must resolve duplicate IDs against the same workspace it listed.
  if (context) {
    context.summaries = allSessions;
    context.logicalSummaries = indexedLogicalRows.map(({ row }) => row);
  }

  return applySessionListLimit(allSessions, options);
}

/**
 * List one message-free row per logical UUID, including divergent replica
 * rows. Indices share the one-based core/CLI catalog with `listSessions()`.
 */
export async function listSessionSummaries(
  options: ListOptions,
  customDataPath?: string,
  backupPath?: string,
  context?: SessionReadContext
): Promise<LogicalSessionSummary[]> {
  if (!context) {
    const ownedContext = createSessionReadContext({
      dataPath: customDataPath,
      backupPath,
      workspacePath: options.workspacePath,
      includeCrossWorkspaceSources: options.includeCrossWorkspaceSources,
      sourceReadLimits: options.sourceReadLimits,
      signal: options.signal,
    });
    try {
      return await listSessionSummaries(options, customDataPath, backupPath, ownedContext);
    } finally {
      await ownedContext.dispose();
    }
  }
  await listSessions(options, customDataPath, backupPath, context);
  const rows = context.logicalSummaries ?? [];
  const selected = !options.all && options.limit > 0 ? rows.slice(0, options.limit) : rows;
  return structuredClone(selected);
}

function canonicalWorkspaceAggregationKey(workspacePath: string): string {
  let normalized = normalizePath(workspacePath).replace(/\\/g, '/');
  if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
  const wsl = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (wsl) normalized = `${wsl[1]}:/${wsl[2] ?? ''}`;
  if (/^[a-z]:$/i.test(normalized)) normalized += '/';
  if (
    /^[a-z]:\//i.test(normalized) ||
    normalized.startsWith('//') ||
    process.platform === 'win32'
  ) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * List all workspaces with chat history. Composer discovery remains the
 * inventory of record so its workspace rows and counts retain their historical
 * behavior. Store-only sessions are then added to an equivalent Composer row,
 * or to a stable Store row when no Composer workspace matches.
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function listWorkspaces(
  customDataPath?: string,
  backupPath?: string,
  readOptions: StorageReadOperationOptions = {}
): Promise<Workspace[]> {
  const context = createSessionReadContext({
    dataPath: customDataPath,
    backupPath,
    sourceReadLimits: readOptions.sourceReadLimits,
    signal: readOptions.signal,
    sqliteDriver: readOptions.sqliteDriver,
    ioObserver: readOptions.ioObserver,
    io: readOptions.io,
    onDiagnostic: readOptions.onDiagnostic,
    testOnlyOnOwnershipChange: readOptions.testOnlyOnOwnershipChange,
  });
  try {
    const composerWorkspaces = await getWorkspacesCached(context, customDataPath, backupPath);
    await listSessions(
      {
        limit: 0,
        all: true,
        sourceReadLimits: readOptions.sourceReadLimits,
        signal: readOptions.signal,
      },
      customDataPath,
      backupPath,
      context
    );
    const workspaces = composerWorkspaces.map((workspace) => ({
      ...workspace,
      path: contractPath(workspace.path),
    }));
    const countedStoreMemberships = new Set<string>();

    for (const storeSession of context.storeSessions ?? []) {
      const storeMembershipPaths = (storeSession.workspaceMemberships ?? [])
        .filter(({ sourceRoles }) => sourceRoles.includes('store'))
        .map(({ workspacePath }) => workspacePath);
      if (storeMembershipPaths.length === 0) {
        storeMembershipPaths.push(
          storeSession.workspacePath?.trim() ? storeSession.workspacePath : UNKNOWN_WORKSPACE_PATH
        );
      }
      for (const rawPath of new Set(storeMembershipPaths)) {
        const key = canonicalWorkspaceAggregationKey(rawPath);
        const logicalMembershipKey = `${storeSession.id}\0${key}`;
        if (countedStoreMemberships.has(logicalMembershipKey)) continue;
        countedStoreMemberships.add(logicalMembershipKey);

        const composerWorkspace = composerWorkspaces.find(
          (workspace) => canonicalWorkspaceAggregationKey(workspace.path) === key
        );
        if (
          composerWorkspace &&
          getCountedComposerSessionIds(composerWorkspace)?.has(storeSession.id)
        ) {
          continue;
        }
        const existing = workspaces.find(
          (workspace) => canonicalWorkspaceAggregationKey(workspace.path) === key
        );
        if (existing) {
          existing.sessionCount++;
          continue;
        }
        workspaces.push({
          id: rawPath === UNKNOWN_WORKSPACE_PATH ? 'store:unknown' : `store:${key}`,
          path: contractPath(rawPath),
          dbPath: '',
          sessionCount: 1,
        });
      }
    }

    const nonEmptyWorkspaces = workspaces.filter((workspace) => workspace.sessionCount > 0);
    nonEmptyWorkspaces.sort(
      (a, b) =>
        b.sessionCount - a.sessionCount ||
        compareCodePoints(
          canonicalWorkspaceAggregationKey(a.path),
          canonicalWorkspaceAggregationKey(b.path)
        )
    );
    return nonEmptyWorkspaces;
  } finally {
    await context.dispose();
  }
}

/**
 * Get a specific session by index (1-based) or composer ID
 * Tries global storage first for complete AI responses, falls back to workspace storage
 * @param identifier - Session index (1-based number) or composer ID (string)
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 * @param context - Optional operation-scoped read context for caching
 * @param summaryIndexHint - Internal exact-summary selector for stable-ID bulk reads
 * @returns The session or null (identifier not found).
 */
export async function getSession(
  identifier: number | string,
  customDataPath?: string,
  backupPath?: string,
  context?: SessionReadContext,
  summaryIndexHint?: number
): Promise<ChatSession | null> {
  if (!context) {
    const ownedContext = createSessionReadContext({ dataPath: customDataPath, backupPath });
    try {
      return await getSession(
        identifier,
        customDataPath,
        backupPath,
        ownedContext,
        summaryIndexHint
      );
    } finally {
      await ownedContext.dispose();
    }
  }
  const operationContext = context;
  throwIfReadAborted(operationContext.signal);
  assertContextSource(operationContext, customDataPath, backupPath);
  bindContextWorkspaceScope(
    operationContext,
    operationContext.workspaceScope === null ? undefined : operationContext.workspaceScope
  );
  // Resolve the summary from the cached listing when available; otherwise
  // list once (and populate the context for downstream lookups).
  let summary: ChatSessionSummary | undefined;
  if (operationContext.summaries) {
    summary =
      typeof identifier === 'string'
        ? operationContext.summaries.find(
            (s) =>
              s.id === identifier &&
              (summaryIndexHint === undefined || s.index === summaryIndexHint)
          )
        : operationContext.summaries.find((s) => s.index === identifier);
  } else {
    const summaries = await listSessions(
      {
        limit: 0,
        all: true,
        workspacePath: operationContext.workspaceScope ?? undefined,
        includeCrossWorkspaceSources: operationContext.includeCrossWorkspaceSources,
        sourceReadLimits: operationContext.sourceReadLimits,
        signal: operationContext.signal,
      },
      customDataPath,
      backupPath,
      operationContext
    );
    summary =
      typeof identifier === 'string'
        ? summaries.find(
            (s) =>
              s.id === identifier &&
              (summaryIndexHint === undefined || s.index === summaryIndexHint)
          )
        : summaries.find((s) => s.index === identifier);
  }
  if (!summary) {
    const ambiguous = operationContext.logicalSummaries?.find(
      (row): row is AmbiguousSessionSummary =>
        row.resolutionState === 'ambiguous' &&
        (typeof identifier === 'string' ? row.id === identifier : row.index === identifier)
    );
    if (ambiguous) {
      throw new SessionAmbiguityError(ambiguous.id, ambiguous.diagnosticOccurrenceRefs);
    }
    return null;
  }

  const index = summary.index;
  const resolutionKey = `${summary.id}\0${summary.index}`;
  if (operationContext.completedSessions.has(resolutionKey)) {
    const completed = operationContext.completedSessions.get(resolutionKey) ?? null;
    operationContext.completedSessions.delete(resolutionKey);
    operationContext.completedSessions.set(resolutionKey, completed);
    return completed ? structuredClone(completed) : null;
  }

  let resolution = operationContext.activeResolutions.get(resolutionKey);
  if (!resolution) {
    operationContext.resolutionStarts++;
    const tracked: Promise<ChatSession | null> = resolveFinalSession(
      summary,
      index,
      customDataPath,
      backupPath,
      operationContext
    ).then(
      (session) => {
        if (operationContext.activeResolutions.get(resolutionKey) === tracked) {
          operationContext.activeResolutions.delete(resolutionKey);
        }
        if (!operationContext.disposed && operationContext.resolvedSessionCapacity > 0) {
          operationContext.completedSessions.delete(resolutionKey);
          operationContext.completedSessions.set(resolutionKey, session);
          while (
            operationContext.completedSessions.size > operationContext.resolvedSessionCapacity
          ) {
            const oldest = operationContext.completedSessions.keys().next().value as
              string | undefined;
            if (oldest === undefined) break;
            operationContext.completedSessions.delete(oldest);
          }
        }
        emitContextOwnership(operationContext);
        return session;
      },
      (error: unknown) => {
        if (operationContext.activeResolutions.get(resolutionKey) === tracked) {
          operationContext.activeResolutions.delete(resolutionKey);
        }
        operationContext.completedSessions.delete(resolutionKey);
        emitContextOwnership(operationContext);
        throw error;
      }
    );
    resolution = tracked;
    operationContext.activeResolutions.set(resolutionKey, resolution);
    emitContextOwnership(operationContext);
  }

  const session = await resolution;
  return session ? structuredClone(session) : null;
}

/**
 * Resolve one canonical session for the operation cache. Callers receive a
 * deep clone from getSession(), so mutations cannot leak back into the cache.
 */
async function resolveFinalSession(
  summary: ChatSessionSummary,
  index: number,
  customDataPath: string | undefined,
  backupPath: string | undefined,
  context: SessionReadContext
): Promise<ChatSession | null> {
  throwIfReadAborted(context.signal);
  let resolved: ChatSession | null;
  // Merged: same ID exists in both stacks, so field-merge the two representations.
  if (summary.source === 'merged' || summary.resolvedSource === 'merged') {
    resolved = await loadMergedSession(summary, index, customDataPath, backupPath, context);
  } else if (
    // Store-stack sessions (transcript/store*) don't live in vscdb; resolve via
    // the cached Store discovery when available.
    summary.workspaceId === 'store' ||
    summary.resolvedSource === 'store-db' ||
    summary.resolvedSource === 'store-transcript' ||
    summary.resolvedSource === 'store-metadata' ||
    summary.source === 'transcript' ||
    summary.source === 'store' ||
    summary.source === 'store-complete' ||
    summary.source === 'store-partial'
  ) {
    const storeSession = (
      await getStoreSessionsCached(
        context,
        customDataPath,
        backupPath,
        new Set([summary.id]),
        'payload'
      )
    ).find((s) => s.id === summary.id);
    resolved = storeSession ? mapStoreSession(storeSession, index) : null;
  } else {
    // Composer stack: global storage (full bubbles) with workspace fallback.
    resolved = await loadComposerSession(summary, index, customDataPath, backupPath, context);
  }
  if (!resolved) return null;
  return projectSessionAddressing(resolved, summary);
}

/** Copy safe summary scope/provenance onto the hydrated session. */
function projectSessionAddressing(session: ChatSession, summary: ChatSessionSummary): ChatSession {
  type SourceInstance = NonNullable<ChatSession['sourceInstances']>[number];
  const sourceInstanceKey = (instance: SourceInstance): string =>
    [
      instance.sourceRole,
      instance.representation,
      [...instance.workspacePaths].sort(compareCodePoints).join('\0'),
      instance.state,
    ].join('\0');
  const projectedSourceInstances: SourceInstance[] = (session.sourceInstances ?? []).map(
    (instance) => ({
      ...instance,
      workspacePaths: [...instance.workspacePaths],
    })
  );
  const hydratedMultiplicity = new Map<string, number>();
  for (const instance of projectedSourceInstances) {
    const key = sourceInstanceKey(instance);
    hydratedMultiplicity.set(key, (hydratedMultiplicity.get(key) ?? 0) + 1);
  }
  const summaryMultiplicity = new Map<string, number>();
  for (const instance of summary.sourceInstances ?? []) {
    const key = sourceInstanceKey(instance);
    const occurrence = (summaryMultiplicity.get(key) ?? 0) + 1;
    summaryMultiplicity.set(key, occurrence);
    if (occurrence <= (hydratedMultiplicity.get(key) ?? 0)) continue;
    projectedSourceInstances.push({
      ...instance,
      workspacePaths: [...instance.workspacePaths],
    });
  }
  projectedSourceInstances.sort((left, right) => {
    if (left.sourceRole !== right.sourceRole) return left.sourceRole === 'composer' ? -1 : 1;
    const representationOrder = [
      'composer-global',
      'composer-workspace',
      'store-db',
      'store-transcript',
      'store-metadata',
    ];
    const byRepresentation =
      representationOrder.indexOf(left.representation) -
      representationOrder.indexOf(right.representation);
    if (byRepresentation !== 0) return byRepresentation;
    const byPaths = compareStringArrays(left.workspacePaths, right.workspacePaths);
    if (byPaths !== 0) return byPaths;
    const stateOrder: SourceInstance['state'][] = [
      'contributed',
      'equivalent-replica',
      'omitted-by-scope',
      'failed',
      'superseded',
    ];
    return stateOrder.indexOf(left.state) - stateOrder.indexOf(right.state);
  });
  const projected: ChatSession = {
    ...session,
    ...(session.resolvedSource
      ? {}
      : summary.resolvedSource
        ? { resolvedSource: summary.resolvedSource }
        : {}),
    ...(session.sources ? {} : summary.sources ? { sources: [...summary.sources] } : {}),
    ...(session.preferredSource
      ? {}
      : summary.preferredSource
        ? { preferredSource: summary.preferredSource }
        : {}),
    ...(session.resolutionState
      ? {}
      : summary.resolutionState
        ? { resolutionState: summary.resolutionState }
        : {}),
    ...(summary.indexScope ? { indexScope: summary.indexScope } : {}),
    ...(summary.indexWorkspacePath ? { indexWorkspacePath: summary.indexWorkspacePath } : {}),
    ...(summary.canonicalWorkspacePath
      ? { canonicalWorkspacePath: summary.canonicalWorkspacePath }
      : {}),
    ...(summary.matchedWorkspacePath ? { matchedWorkspacePath: summary.matchedWorkspacePath } : {}),
    ...(summary.workspaceMatchKind ? { workspaceMatchKind: summary.workspaceMatchKind } : {}),
    ...(summary.workspaceMemberships
      ? {
          workspaceMemberships: summary.workspaceMemberships.map((membership) => ({
            ...membership,
            sourceRoles: [...membership.sourceRoles],
          })),
        }
      : {}),
    ...(projectedSourceInstances.length > 0
      ? {
          sourceInstances: projectedSourceInstances.map((instance) => ({
            ...instance,
            workspacePaths: [...instance.workspacePaths],
          })),
        }
      : {}),
  };
  const summaryScopeIsAuthoritative =
    summary.resolution?.reasonCodes.includes('workspace-scope-omitted') ?? false;
  const effectiveResolution = summaryScopeIsAuthoritative
    ? mergeSessionResolutions(session.resolution, summary.resolution)
    : (session.resolution ?? summary.resolution);
  if (effectiveResolution) {
    projected.resolution = {
      ...effectiveResolution,
      expectedSourceRoles: [...effectiveResolution.expectedSourceRoles],
      loadedSourceRoles: [...effectiveResolution.loadedSourceRoles],
      omittedSourceRoles: [...effectiveResolution.omittedSourceRoles],
      failedSourceRoles: [...effectiveResolution.failedSourceRoles],
      reasonCodes: [...effectiveResolution.reasonCodes],
    };
    projected.resolutionState = effectiveResolution.state;
    projected.source = effectiveResolution.state === 'complete' ? 'global' : 'workspace-fallback';
  }
  projected.resolvedSource ??= projected.workspaceId === 'store' ? 'store-metadata' : 'composer';
  projected.sources = projected.sources
    ? (['composer', 'store'] as const).filter((role) => projected.sources!.includes(role))
    : projected.resolvedSource === 'merged'
      ? ['composer', 'store']
      : projected.workspaceId === 'store'
        ? ['store']
        : ['composer'];
  projected.resolution ??= {
    state: projected.source === 'global' ? 'complete' : 'partial',
    expectedSourceRoles: [...projected.sources],
    loadedSourceRoles: [...projected.sources],
    omittedSourceRoles: [],
    failedSourceRoles: [],
    reasonCodes: projected.source === 'global' ? [] : ['source-unavailable'],
  };
  projected.resolutionState = projected.resolution.state;
  projected.source = projected.resolution.state === 'complete' ? 'global' : 'workspace-fallback';
  projected.messageIdentityVersion = 1;
  projected.workspaceMemberships ??= [];
  projected.sourceInstances ??= [];
  if (projected.canonicalWorkspacePath) {
    projected.workspacePath = contractPath(projected.canonicalWorkspacePath);
  }
  return projected;
}

/**
 * Load a Composer-stack session (global bubbles, falling back to workspace
 * storage). Extracted from getSession so the merged path can reuse it.
 */
async function loadComposerSession(
  summary: ChatSessionSummary,
  index: number,
  customDataPath?: string,
  backupPath?: string,
  context?: SessionReadContext
): Promise<ChatSession | null> {
  const composerSessionBudget = createComposerSqliteBudget(
    context?.sourceReadLimits ?? SOURCE_READ_LIMITS_V1_DEFAULTS
  );
  // Try to get full session from global storage (has AI responses)
  // This works for both live data and backup (if backup includes globalStorage)
  let globalDb: Database | null = null;
  let globalLifecycleError: unknown;
  let globalLoadFailed = false;
  const globalDbPath = join(getGlobalStoragePath(customDataPath), 'state.vscdb');

  try {
    throwIfReadAborted(context?.signal);
    if (backupPath) {
      try {
        globalDb = await openBackupDatabase(backupPath, 'globalStorage/state.vscdb', {
          sourceReadLimits: context?.sourceReadLimits,
          signal: context?.signal,
          sqliteDriver: context?.sqliteDriver,
          io: context?.io,
          logicalSessionId: summary.id,
        });
      } catch (error) {
        globalLifecycleError = error;
        if (error instanceof BackupEntryNotFoundError) {
          globalLoadFailed = true;
          debugLogStorage('Global DB not present in backup; using workspace fallback.');
        } else {
          throw error;
        }
      }
    } else {
      observeStorageAdapterIo(context, {
        adapter: 'filesystem',
        operation: 'open',
        resourceClass: 'global-session-index',
        logicalSessionId: summary.id,
        sourceRole: 'composer',
        representation: 'composer-global',
      });
      if (!existsSync(globalDbPath)) {
        globalLoadFailed = true;
        debugLogStorage(`Global DB not found at ${globalDbPath}`);
      } else {
        try {
          globalDb = await openDatabase(
            globalDbPath,
            withDatabaseIo(context, {
              resourceClass: 'global-composer',
              logicalSessionId: summary.id,
              sourceRole: 'composer',
              representation: 'composer-global',
            })
          );
        } catch (error) {
          globalLifecycleError = error;
          if (shouldPropagateReadFailure(error)) throw error;
          globalLoadFailed = true;
          debugLogStorage(`Failed to open global DB at ${globalDbPath}: ${getErrorMessage(error)}`);
        }
      }
    }

    if (globalDb) {
      const bubbleRows: BubbleRow[] = [];
      let composerDataRow: { value: string } | undefined;
      let globalQueryFailure: unknown;
      let globalCloseFailure: unknown;

      try {
        throwIfReadAborted(context?.signal);
        const tableCheck = globalDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
          .get();

        if (!tableCheck) {
          globalLoadFailed = true;
          debugLogStorage('cursorDiskKV table not found');
        } else {
          forEachBoundedComposerBubbleValue(
            globalDb,
            `bubbleId:${sqliteLikeLiteralPrefix(summary.id)}:%`,
            composerSessionBudget,
            (row) => bubbleRows.push({ key: row.key, value: row.value }),
            context?.signal
          );

          try {
            const composerDataValue = readBoundedComposerValueByKey(
              globalDb,
              'cursorDiskKV',
              `composerData:${summary.id}`,
              composerSessionBudget,
              context?.signal
            );
            composerDataRow = composerDataValue ? { value: composerDataValue } : undefined;
          } catch (error) {
            // A genuinely absent row is represented by `undefined`; adapter,
            // observer, and SQLite failures are not optional metadata.
            if (shouldPropagateReadFailure(error)) throw error;
            throwOwningDatabaseReadFailure(error);
          }

          if (bubbleRows.length === 0) {
            globalLoadFailed = true;
            debugLogStorage(`No bubbles for composer ${summary.id}`);
          }
        }
      } catch (error) {
        globalLifecycleError = error;
        if (shouldPropagateReadFailure(error)) {
          globalQueryFailure = error;
        } else {
          globalLoadFailed = true;
          debugLogStorage(
            `Failed to load global bubbles for composer ${summary.id}: ${getErrorMessage(error)}`
          );
        }
      } finally {
        try {
          closeDatabaseOrThrow(globalDb, globalLifecycleError);
        } catch (closeError) {
          globalLifecycleError = closeError;
          globalCloseFailure = closeError;
        } finally {
          globalDb = null;
        }
      }
      if (globalCloseFailure !== undefined) throw globalCloseFailure;
      if (globalQueryFailure !== undefined) throw globalQueryFailure;

      if (bubbleRows.length > 0) {
        const projection = resolveBubbleMessages(
          bubbleRows,
          composerMetadataTimestampsForSummary(composerDataRow?.value, summary)
        );
        const resolvedMessages = projection.messages;
        const sessionUsage = parseComposerSessionUsage(composerDataRow?.value, resolvedMessages);
        const activeBranchBubbleIds = extractActiveBranchBubbleIds(composerDataRow?.value);

        return {
          id: summary.id,
          index,
          title: summary.title,
          createdAt: projection.createdAt,
          createdAtSource: projection.createdAtSource,
          lastUpdatedAt: projection.lastUpdatedAt,
          lastUpdatedAtSource: projection.lastUpdatedAtSource,
          messageCount: resolvedMessages.length,
          messages: resolvedMessages,
          workspaceId: summary.workspaceId,
          workspacePath: summary.workspacePath,
          usage: sessionUsage,
          activeBranchBubbleIds,
          source: 'global',
          resolvedSource: 'composer',
          sources: ['composer'],
          resolutionState: 'complete',
          resolution: {
            state: 'complete',
            expectedSourceRoles: ['composer'],
            loadedSourceRoles: ['composer'],
            omittedSourceRoles: [],
            failedSourceRoles: [],
            reasonCodes: [],
          },
          messageIdentityVersion: 1,
        };
      }
    }
  } catch (error) {
    if (backupPath || error === globalLifecycleError || shouldPropagateReadFailure(error)) {
      throw error;
    }
    globalLoadFailed = true;
    debugLogStorage(
      `Unexpected global load failure for composer ${summary.id}: ${getErrorMessage(error)}`
    );
  }

  // Fall back to workspace storage (or use backup for backup mode)
  const boundWorkspace = context
    ? privateReadState(context).boundComposerWorkspaceBySession.get(summary.id)
    : undefined;
  const workspaces = boundWorkspace
    ? []
    : await getWorkspacesCached(context, customDataPath, backupPath);
  const workspace = boundWorkspace ?? workspaces.find((w) => w.id === summary.workspaceId);

  if (!workspace) {
    return null;
  }

  let workspaceDb: Database | null = null;
  let workspaceReadError: unknown;
  try {
    // Open database from live or backup source
    workspaceDb = backupPath
      ? await openBackupDatabase(backupPath, workspace.dbPath, {
          sourceReadLimits: context?.sourceReadLimits,
          signal: context?.signal,
          sqliteDriver: context?.sqliteDriver,
          io: context?.io,
          logicalSessionId: summary.id,
        })
      : await openDatabase(
          workspace.dbPath,
          withDatabaseIo(context, {
            resourceClass: 'workspace-conversation',
            logicalSessionId: summary.id,
            sourceRole: 'composer',
            representation: 'composer-workspace',
          })
        );
    throwIfReadAborted(context?.signal);
    const result = getChatDataFromDb(workspaceDb, composerSessionBudget, context?.signal);

    if (!result) return null;

    const sessions = parseChatData(result.data, result.bundle);
    const session = sessions.find((s) => s.id === summary.id);

    if (!session) return null;

    return {
      ...session,
      index,
      workspaceId: workspace.id,
      workspacePath: summary.workspacePath,
      createdAtSource: session.createdAtSource,
      lastUpdatedAtSource: session.lastUpdatedAtSource,
      source: globalLoadFailed ? 'workspace-fallback' : session.source,
      activeBranchBubbleIds: undefined,
    };
  } catch (error) {
    workspaceReadError = error;
    if (backupPath || shouldPropagateReadFailure(error)) throw error;
    return null;
  } finally {
    closeDatabaseOrThrow(workspaceDb, workspaceReadError);
  }
}

/**
 * Load and field-merge a session whose ID exists in both stacks. Falls
 * back to whichever single stack is available if the other cannot be loaded.
 */
async function loadMergedSession(
  summary: ChatSessionSummary,
  index: number,
  customDataPath?: string,
  backupPath?: string,
  context?: SessionReadContext
): Promise<ChatSession | null> {
  const preferredSource = summary.preferredSource ?? detectPreferredStackSource(customDataPath);

  const storeRaw = (
    await getStoreSessionsCached(
      context,
      customDataPath,
      backupPath,
      new Set([summary.id]),
      'payload'
    )
  ).find((s) => s.id === summary.id);
  const store = storeRaw ? mapStoreSession(storeRaw, index) : null;
  const composer = await loadComposerSession(summary, index, customDataPath, backupPath, context);

  if (composer && store) {
    return mergeCrossStackSessions(composer, store, preferredSource, index);
  }
  const surviving = composer ?? store;
  if (!surviving) return null;

  // The listing selected a merged logical session, so losing either bound
  // contributor during hydration must be visible. Returning the survivor as a
  // complete single-source session would silently change the selected object.
  const missingRole: SourceRole = composer ? 'store' : 'composer';
  const loadedRole: SourceRole = composer ? 'composer' : 'store';
  const prior = surviving.resolution;
  return {
    ...surviving,
    source: 'workspace-fallback',
    sources: ['composer', 'store'],
    resolutionState: 'partial',
    resolution: {
      state: 'partial',
      expectedSourceRoles: orderedSourceRoles([
        ...(prior?.expectedSourceRoles ?? []),
        'composer',
        'store',
      ]),
      loadedSourceRoles: orderedSourceRoles([
        ...(prior?.loadedSourceRoles ?? []).filter((role) => role !== missingRole),
        loadedRole,
      ]),
      omittedSourceRoles: orderedSourceRoles(
        (prior?.omittedSourceRoles ?? []).filter((role) => role !== missingRole)
      ),
      failedSourceRoles: orderedSourceRoles([...(prior?.failedSourceRoles ?? []), missingRole]),
      reasonCodes: orderedResolutionReasons([...(prior?.reasonCodes ?? []), 'source-unavailable']),
    },
  };
}

/**
 * Search across all chat sessions
 * @param query - Search query string
 * @param options - Search options (limit, contextChars, workspacePath)
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function searchSessions(
  query: string,
  options: SearchOptions,
  customDataPath?: string,
  backupPath?: string,
  readContext?: SessionReadContext
): Promise<SearchResult[]> {
  const ownsContext = readContext === undefined;
  const context =
    readContext ??
    createSessionReadContext({
      dataPath: customDataPath,
      backupPath,
      workspacePath: options.workspacePath,
      includeCrossWorkspaceSources: options.includeCrossWorkspaceSources,
      resolvedSessionCapacity: 0,
      sourceReadLimits: options.sourceReadLimits,
      signal: options.signal,
    });
  try {
    resolveSourceReadLimits(options.sourceReadLimits ?? context.sourceReadLimits);
    throwIfReadAborted(options.signal ?? context.signal);
    assertContextSource(context, customDataPath, backupPath);
    const summaries = await listSessionSummaries(
      {
        limit: 0,
        all: true,
        workspacePath: options.workspacePath,
        includeCrossWorkspaceSources: options.includeCrossWorkspaceSources,
        sourceReadLimits: options.sourceReadLimits,
        signal: options.signal,
      },
      customDataPath,
      backupPath,
      context
    );
    const results: SearchResult[] = [];
    for (const summary of summaries) {
      throwIfReadAborted(options.signal ?? context.signal);
      if (summary.resolutionState === 'ambiguous') {
        reportSessionAmbiguity(context, summary.id, summary.diagnosticOccurrenceRefs);
        continue;
      }
      try {
        const session = await getSession(
          summary.id,
          customDataPath,
          backupPath,
          context,
          summary.index
        );
        if (!session) continue;

        const snippets = getSearchSnippets(session.messages, query, options.contextChars);

        if (snippets.length > 0) {
          const matchCount = snippets.reduce((sum, s) => sum + s.matchPositions.length, 0);

          results.push({
            sessionId: summary.id,
            index: summary.index,
            workspacePath: summary.workspacePath,
            canonicalWorkspacePath: summary.canonicalWorkspacePath,
            matchedWorkspacePath: summary.matchedWorkspacePath,
            createdAt: summary.createdAt,
            matchCount,
            snippets,
          });
        }
      } catch (error) {
        if (!(error instanceof SessionAmbiguityError)) throw error;
        reportSessionAmbiguity(context, error.details.sessionId, error.details.occurrenceRefs);
      } finally {
        context.releaseSession(summary.id);
      }
    }

    results.sort((a, b) => b.matchCount - a.matchCount);

    if (options.limit > 0) {
      return results.slice(0, options.limit);
    }
    return results;
  } finally {
    if (ownsContext) await context.dispose();
  }
}

/**
 * List sessions from global Cursor storage (cursorDiskKV table)
 * This is where Cursor stores full conversation data including AI responses
 */
export async function listGlobalSessions(customDataPath?: string): Promise<ChatSessionSummary[]> {
  const globalPath = getGlobalStoragePath(customDataPath);
  const dbPath = join(globalPath, 'state.vscdb');

  if (!existsSync(dbPath)) {
    return [];
  }

  let db: Database | null = null;
  let readError: unknown;
  try {
    db = await openDatabase(dbPath);

    // Check if cursorDiskKV table exists
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();

    if (!tableCheck) {
      return [];
    }

    const catalogBudget = createComposerSqliteBudget();
    const composerRecords = loadGlobalComposerRecords(db, catalogBudget);
    const bubbleCounts = loadGlobalBubbleCounts(db, catalogBudget);
    const sessions: ChatSessionSummary[] = [];
    for (const record of composerRecords) {
      const summary = buildGlobalComposerSummary(
        db,
        record.id,
        record.data,
        { bubbleCount: bubbleCounts.get(record.id) ?? 0 },
        catalogBudget
      );
      if (!summary) continue;
      sessions.push({
        ...summary,
        index: 0,
        workspaceId: 'global',
        workspacePath: contractPath(workspacePathFromComposer(record.data) ?? 'Global'),
      });
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Assign indexes
    sessions.forEach((session, i) => {
      session.index = i + 1;
    });

    return sessions;
  } catch (error) {
    readError = error;
    if (shouldPropagateReadFailure(error)) throw error;
    throwOwningDatabaseReadFailure(error);
  } finally {
    closeDatabaseOrThrow(db, readError);
  }
}

/**
 * Get a session from global storage by index
 */
export async function getGlobalSession(
  index: number,
  customDataPath?: string
): Promise<ChatSession | null> {
  const summaries = await listGlobalSessions(customDataPath);
  const summary = summaries.find((s) => s.index === index);

  if (!summary) {
    return null;
  }

  const globalPath = getGlobalStoragePath(customDataPath);
  const dbPath = join(globalPath, 'state.vscdb');
  let db: Database | null = null;
  let readError: unknown;

  try {
    db = await openDatabase(dbPath);

    const sessionBudget = createComposerSqliteBudget();
    const bubbleRows: BubbleRow[] = [];
    forEachBoundedComposerBubbleValue(
      db,
      `bubbleId:${sqliteLikeLiteralPrefix(summary.id)}:%`,
      sessionBudget,
      (row) => bubbleRows.push({ key: row.key, value: row.value })
    );

    if (bubbleRows.length === 0) {
      debugLogStorage(`No bubbles for composer ${summary.id}`);
      return null;
    }

    const composerValue = readBoundedComposerValueByKey(
      db,
      'cursorDiskKV',
      `composerData:${summary.id}`,
      sessionBudget
    );
    const projection = resolveBubbleMessages(
      bubbleRows,
      composerMetadataTimestampsForSummary(composerValue, summary)
    );
    const resolvedMessages = projection.messages;
    const sessionUsage = parseComposerSessionUsage(composerValue, resolvedMessages);
    const activeBranchBubbleIds = extractActiveBranchBubbleIds(composerValue);

    return {
      id: summary.id,
      index,
      title: summary.title,
      createdAt: projection.createdAt,
      createdAtSource: projection.createdAtSource,
      lastUpdatedAt: projection.lastUpdatedAt,
      lastUpdatedAtSource: projection.lastUpdatedAtSource,
      messageCount: resolvedMessages.length,
      messages: resolvedMessages,
      workspaceId: 'global',
      usage: sessionUsage,
      activeBranchBubbleIds,
      source: 'global',
    };
  } catch (error) {
    readError = error;
    if (shouldPropagateReadFailure(error)) throw error;
    throwOwningDatabaseReadFailure(error);
  } finally {
    closeDatabaseOrThrow(db, readError);
  }
}

/**
 * Format a tool call for display
 */
function formatToolCall(
  toolData: ToolFormerData,
  codeBlocks?: Array<{ content?: unknown }>
): string {
  const lines: string[] = [];
  const toolName = toolData.name ?? 'unknown';
  const parsedParams = parseToolParams(toolData.params, toolData.rawArgs);
  const params = parsedParams ?? {};
  const firstCodeBlockContent = codeBlocks?.[0]?.content;
  const pickContent = (candidates: Array<{ value: unknown }>): string | null => {
    let stringifyCandidate: unknown;

    for (const { value } of candidates) {
      if (typeof value === 'string') {
        if (value.trim().length > 0) {
          return value;
        }
        continue;
      }

      if (value !== undefined && value !== null && stringifyCandidate === undefined) {
        stringifyCandidate = value;
      }
    }

    if (stringifyCandidate === undefined) {
      return null;
    }

    const stringified = JSON.stringify(stringifyCandidate);
    return typeof stringified === 'string' && stringified.length > 0 ? stringified : null;
  };

  // Format based on tool type
  if (toolName === 'read_file') {
    lines.push(`[Tool: Read File]`);
    const file = getParam(params, 'targetFile', 'path', 'file');
    if (file) lines.push(`File: ${file}`);

    // Show file content
    try {
      const result = JSON.parse(toolData.result ?? '{}');
      if (result.contents) {
        lines.push(`Content: ${result.contents}`);
      }
    } catch {
      // Ignore
    }
  } else if (toolName === 'read_file_v2') {
    lines.push(`[Tool: Read File v2]`);
    const file = getParam(params, 'targetFile', 'path', 'file', 'effectiveUri');
    if (file) lines.push(`File: ${file}`);

    let primaryContent: string | null = null;
    let diffText: string | null = null;
    let resultContents: unknown;

    try {
      const result = JSON.parse(toolData.result ?? '{}') as Record<string, unknown>;
      resultContents = result['contents'];
      if (result['diff'] && typeof result['diff'] === 'object') {
        diffText = formatDiffBlock(result['diff'] as { chunks?: Array<{ diffString?: string }> });
      }
    } catch (error) {
      if (toolData.result) {
        debugLogStorage(`Failed to parse read_file_v2 result: ${getErrorMessage(error)}`);
      }
    }

    primaryContent = pickContent([{ value: resultContents }, { value: firstCodeBlockContent }]);
    if (primaryContent) {
      lines.push(`Content: ${primaryContent}`);
    }
    if (diffText) {
      if (primaryContent) {
        lines.push('');
      }
      lines.push(diffText);
    }
  } else if (toolName === 'list_dir') {
    lines.push(`[Tool: List Directory]`);
    const dir = getParam(params, 'targetDirectory', 'path', 'directory');
    if (dir) lines.push(`Directory: ${dir}`);
  } else if (toolName === 'grep' || toolName === 'search' || toolName === 'codebase_search') {
    lines.push(`[Tool: ${toolName === 'grep' ? 'Grep' : 'Search'}]`);
    const pattern = getParam(params, 'pattern', 'query', 'searchQuery', 'regex');
    const path = getParam(params, 'path', 'directory', 'targetDirectory');
    if (pattern) lines.push(`Pattern: ${pattern}`);
    if (path) lines.push(`Path: ${path}`);
  } else if (
    toolName === 'run_terminal_command' ||
    toolName === 'run_terminal_cmd' ||
    toolName === 'execute_command'
  ) {
    lines.push(`[Tool: Terminal Command]`);
    const cmd = getParam(params, 'command', 'cmd');
    if (cmd) lines.push(`Command: ${cmd}`);

    // Show command output from result
    if (toolData.result) {
      try {
        const result = JSON.parse(toolData.result);
        if (result.output && typeof result.output === 'string') {
          if (result.output.trim()) {
            lines.push(`Output: ${result.output}`);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  } else if (toolName === 'edit_file' || toolName === 'search_replace') {
    lines.push(`[Tool: ${toolName === 'search_replace' ? 'Search & Replace' : 'Edit File'}]`);
    const file = getParam(
      params,
      'targetFile',
      'path',
      'file',
      'filePath',
      'relativeWorkspacePath'
    );
    if (file) lines.push(`File: ${file}`);

    // Show edit details
    const oldString = getParam(params, 'oldString', 'old_string', 'search', 'searchString');
    const newString = getParam(params, 'newString', 'new_string', 'replace', 'replaceString');
    if (oldString || newString) {
      if (oldString)
        lines.push(`Old: ${oldString.slice(0, 100)}${oldString.length > 100 ? '...' : ''}`);
      if (newString)
        lines.push(`New: ${newString.slice(0, 100)}${newString.length > 100 ? '...' : ''}`);
    }
  } else if (toolName === 'edit_file_v2') {
    lines.push(`[Tool: Edit File v2]`);
    const file = getParam(params, 'targetFile', 'path', 'file', 'relativeWorkspacePath');
    if (file) lines.push(`File: ${file}`);

    if (
      parsedParams &&
      Object.prototype.hasOwnProperty.call(parsedParams, '_raw') &&
      typeof parsedParams['_raw'] === 'string'
    ) {
      debugLogStorage(`Failed to parse edit_file_v2 params: ${parsedParams['_raw']}`);
    }

    const content = pickContent([
      { value: params['streamingContent'] },
      { value: firstCodeBlockContent },
      { value: params['content'] },
      { value: params['fileContent'] },
    ]);
    if (content) {
      lines.push(`Content: ${content}`);
    }
  } else if (toolName === 'create_file' || toolName === 'write_file' || toolName === 'write') {
    lines.push(`[Tool: ${toolName === 'create_file' ? 'Create File' : 'Write File'}]`);
    const file = getParam(params, 'targetFile', 'path', 'file', 'relativeWorkspacePath');
    if (file) lines.push(`File: ${file}`);
    // Note: Content is extracted from bubble's codeBlocks field in extractBubbleText(), not from params
  } else {
    // Generic tool - show all string params
    lines.push(`[Tool: ${toolName}]`);
    for (const [key, val] of Object.entries(params)) {
      if (typeof val === 'string' && val.trim()) {
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        lines.push(`${label}: ${val}`);
      }
    }

    // Try to extract result for generic tools
    if (toolData.result) {
      try {
        const result = JSON.parse(toolData.result);
        // Check for common result fields
        const resultText = result.output || result.result || result.content || result.text;
        if (resultText && typeof resultText === 'string' && resultText.trim()) {
          lines.push(`Result: ${resultText}`);
        }
      } catch {
        // If result is not JSON, show it directly if it's a string
        if (
          typeof toolData.result === 'string' &&
          toolData.result.length > 0 &&
          toolData.result.length < 1000
        ) {
          lines.push(`Result: ${toolData.result}`);
        }
      }
    }
  }

  // Add status indicator (for all tools)
  if (toolData.status) {
    const statusEmoji = toolData.status === 'completed' ? '✓' : '❌';
    lines.push(`Status: ${statusEmoji} ${toolData.status}`);
  }

  // Add user decision if present (accepted/rejected/pending)
  const userDecision = toolData.additionalData?.userDecision;
  if (userDecision && typeof userDecision === 'string') {
    const decisionEmoji =
      userDecision === 'accepted' ? '✓' : userDecision === 'rejected' ? '✗' : '⏳';
    lines.push(`User Decision: ${decisionEmoji} ${userDecision}`);
  }

  return lines.join('\n');
}

/**
 * Format a diff block for display
 */
function formatDiffBlock(diffData: {
  chunks?: Array<{ diffString?: string }>;
  editor?: string;
}): string | null {
  if (!diffData.chunks || !Array.isArray(diffData.chunks)) {
    return null;
  }

  const lines: string[] = [];

  for (const chunk of diffData.chunks) {
    if (chunk.diffString && typeof chunk.diffString === 'string') {
      // Show the full diff with fences
      lines.push('```diff');
      lines.push(chunk.diffString);
      lines.push('```');
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Format tool call data that includes result with diff
 */
function formatToolCallWithResult(toolData: ToolFormerData): string | null {
  const lines: string[] = [];

  // Parse params to get file path first
  const params = parseToolParams(toolData.params, toolData.rawArgs);
  const filePath = getParam(params, 'relativeWorkspacePath', 'file_path');

  // Parse the result for diff information
  try {
    const result = JSON.parse(toolData.result ?? '{}');

    // Check if result has diff - this function only handles diff results
    if (!(result.diff && typeof result.diff === 'object')) {
      return null;
    }

    // Format as tool call header
    const toolName = toolData.name ?? 'write';
    lines.push(
      `[Tool: ${toolName === 'write' || toolName === 'write_file' ? 'Write File' : 'Edit File'}]`
    );

    if (filePath) {
      lines.push(`File: ${filePath}`);
    }

    // Add the diff blocks
    const diffText = formatDiffBlock(result.diff);
    if (diffText) {
      lines.push('');
      lines.push(diffText);
    }

    // Add result summary if available
    if (result.resultForModel && typeof result.resultForModel === 'string') {
      lines.push('');
      lines.push(`Result: ${result.resultForModel}`);
    }
  } catch {
    // Not JSON or no diff
    return null;
  }

  // Add status indicator (only if we have diff content)
  if (toolData.status) {
    const statusEmoji = toolData.status === 'completed' ? '✓' : '❌';
    lines.push('');
    lines.push(`Status: ${statusEmoji} ${toolData.status}`);
  }

  // Add user decision if present
  const userDecision = toolData.additionalData?.userDecision;
  if (userDecision && typeof userDecision === 'string') {
    const decisionEmoji =
      userDecision === 'accepted' ? '✓' : userDecision === 'rejected' ? '✗' : '⏳';
    lines.push(`User Decision: ${decisionEmoji} ${userDecision}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Extract thinking/reasoning text from bubble
 */
function extractThinkingText(data: Record<string, unknown>): string | null {
  const thinking = data['thinking'] as { text?: string; signature?: string } | undefined;
  if (thinking?.text && typeof thinking.text === 'string' && thinking.text.trim()) {
    return thinking.text;
  }
  return null;
}

/**
 * Extract text content from a bubble object
 *
 * Key insight from Cursor storage analysis:
 * - `text` field contains the natural language explanation ("Based on my analysis...")
 * - `codeBlocks[].content` contains code/mermaid artifacts
 * - Both should be COMBINED, not one chosen over the other
 *
 * Priority for assistant messages:
 * 1. text (main natural language) + codeBlocks (code artifacts) - COMBINED
 * 2. thinking.text (reasoning)
 * 3. toolFormerData.result (tool output)
 *
 * Priority for user messages:
 * 1. codeBlocks (user-pasted code/content)
 * 2. text, content, etc. (user typed message)
 */
function extractBubbleText(data: Record<string, unknown>): string {
  const bubbleType = data['type'] as number | undefined;
  const isAssistant = bubbleType === 2;

  // Check for tool call in toolFormerData (with name = tool action)
  const toolFormerData = data['toolFormerData'] as ToolFormerData | undefined;
  const toolName = toolFormerData?.name;
  const codeBlocks = data['codeBlocks'] as Array<{ content?: unknown }> | undefined;

  // Check if it's an error - but don't return yet, mark it and continue extraction
  const isError = toolFormerData?.additionalData?.status === 'error';

  // Priority 1: Check if toolFormerData has result with diff (write/edit operations)
  if (toolFormerData?.result && toolName !== 'read_file_v2') {
    const toolResult = formatToolCallWithResult(toolFormerData);
    if (toolResult) {
      return toolResult;
    }
  }

  // Priority 2: Check if it's a tool call with name (completed, cancelled, or error)
  if (toolFormerData?.name) {
    const toolInfo = formatToolCall(toolFormerData, codeBlocks);

    // Extract content from codeBlocks if available (for ANY tool type)
    if (
      toolName !== 'read_file_v2' &&
      toolName !== 'edit_file_v2' &&
      codeBlocks &&
      codeBlocks.length > 0 &&
      typeof codeBlocks[0]?.content === 'string'
    ) {
      const content = codeBlocks[0].content;
      const preview = content.slice(0, 200).replace(/\n/g, '\\n');
      return toolInfo + `\nContent: ${preview}${content.length > 200 ? '...' : ''}`;
    }

    return toolInfo;
  }

  // Extract codeBlocks content
  const messageCodeBlocks = data['codeBlocks'] as
    Array<{ content?: string; languageId?: string }> | undefined;
  const codeBlockParts: string[] = [];
  if (messageCodeBlocks && Array.isArray(messageCodeBlocks)) {
    for (const cb of messageCodeBlocks) {
      if (typeof cb.content === 'string' && cb.content.trim().length > 0) {
        const lang = cb.languageId ?? '';
        // Wrap code blocks in markdown fences for display
        if (lang) {
          codeBlockParts.push(`\`\`\`${lang}\n${cb.content}\n\`\`\``);
        } else {
          codeBlockParts.push(cb.content);
        }
      }
    }
  }

  // For ASSISTANT messages: prioritize `text` field (natural language), combine with codeBlocks
  if (isAssistant) {
    const textField = data['text'];
    if (typeof textField === 'string' && textField.trim().length > 0) {
      // Check if text is a JSON diff block (backup check if toolFormerData didn't catch it)
      if (textField.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(textField);
          // Check for diff structure
          if (parsed.diff && typeof parsed.diff === 'object') {
            const diffText = formatDiffBlock(parsed.diff);
            if (diffText) {
              // Add result message if available
              if (parsed.resultForModel) {
                return diffText + `\n\nResult: ${parsed.resultForModel}`;
              }
              return diffText;
            }
          }
        } catch {
          // Not JSON, treat as regular text
        }
      }

      // Regular text - combine with code artifacts
      if (codeBlockParts.length > 0) {
        return textField + '\n\n' + codeBlockParts.join('\n\n');
      }
      return textField;
    }

    // Fall back to thinking.text
    const thinkingText = extractThinkingText(data);
    if (thinkingText) {
      if (codeBlockParts.length > 0) {
        return `[Thinking]\n${thinkingText}\n\n` + codeBlockParts.join('\n\n');
      }
      return `[Thinking]\n${thinkingText}`;
    }

    // Fall back to toolFormerData.result
    if (toolFormerData?.result) {
      try {
        const result = JSON.parse(toolFormerData.result);
        if (result.contents && typeof result.contents === 'string') {
          return result.contents;
        }
        if (result.content && typeof result.content === 'string') {
          return result.content;
        }
        if (result.text && typeof result.text === 'string') {
          return result.text;
        }
      } catch {
        if (toolFormerData.result.length > 50 && !toolFormerData.result.startsWith('{')) {
          return toolFormerData.result;
        }
      }
    }

    // Fall back to codeBlocks alone
    if (codeBlockParts.length > 0) {
      return codeBlockParts.join('\n\n');
    }
  }

  // For USER messages: codeBlocks first (user-pasted content), then text fields
  if (codeBlockParts.length > 0) {
    return codeBlockParts.join('\n\n');
  }

  // Common text fields
  for (const key of ['text', 'content', 'finalText', 'message', 'markdown', 'textDescription']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  // Fallback: thinking.text
  const thinkingText = extractThinkingText(data);
  if (thinkingText) {
    return `[Thinking]\n${thinkingText}`;
  }

  // Last resort: find longest string with markdown features
  let best = '';
  const walk = (obj: unknown): void => {
    if (typeof obj === 'object' && obj !== null) {
      if (Array.isArray(obj)) {
        obj.forEach(walk);
      } else {
        Object.values(obj).forEach(walk);
      }
    } else if (typeof obj === 'string') {
      if (
        obj.length > best.length &&
        (obj.includes('\n') || obj.includes('```') || obj.includes('# '))
      ) {
        best = obj;
      }
    }
  };
  walk(data);

  // If this was marked as an error, prefix with [Error] marker
  if (isError && best) {
    return `[Error]\n${best}`;
  }

  return best;
}

// ============================================================================
// Token Usage Extraction Functions
// ============================================================================

/**
 * Raw bubble data structure with token-related fields
 */
interface RawBubbleData {
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  modelInfo?: {
    modelName?: string;
  };
  timingInfo?: {
    clientStartTime?: number;
    clientEndTime?: number;
    /** Unix ms - when RPC request was sent (old format, assistant only) */
    clientRpcSendTime?: number;
    /** Unix ms - when response settled (old format, sometimes present) */
    clientSettleTime?: number;
  };
  contextWindowStatusAtCreation?: {
    tokensUsed?: number;
    tokenLimit?: number;
    percentageRemaining?: number;
    percentageRemainingFloat?: number;
  };
  promptDryRunInfo?: string;
}

/**
 * Raw composer data structure with session-level token fields
 */
interface RawComposerData {
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  contextUsagePercent?: number;
  fullConversationHeadersOnly?: unknown;
}

/**
 * Extract token usage from a raw bubble.
 * Tries multiple sources with fallbacks:
 * 1. tokenCount.inputTokens/outputTokens (camelCase - primary)
 * 2. usage.input_tokens/output_tokens (snake_case - fallback)
 * 3. contextWindowStatusAtCreation.tokensUsed (for input estimate on user messages)
 * 4. promptDryRunInfo.fullConversationTokenCount (client-side estimate)
 *
 * @param data - Raw bubble data object
 * @returns TokenUsage if valid non-zero data exists, undefined otherwise
 */
export function extractTokenUsage(data: RawBubbleData): TokenUsage | undefined {
  // Priority 1: camelCase format (tokenCount.inputTokens/outputTokens)
  const tokenCount = data.tokenCount;
  if (tokenCount) {
    const inputTokens = tokenCount.inputTokens ?? 0;
    const outputTokens = tokenCount.outputTokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      return { inputTokens, outputTokens };
    }
  }

  // Priority 2: snake_case format (usage.input_tokens/output_tokens)
  const usage = data.usage;
  if (usage) {
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      return { inputTokens, outputTokens };
    }
  }

  // Priority 3: contextWindowStatusAtCreation.tokensUsed (user messages)
  // This gives us the context window usage at message creation - use as input estimate
  const contextStatus = data.contextWindowStatusAtCreation;
  if (contextStatus?.tokensUsed && contextStatus.tokensUsed > 0) {
    return { inputTokens: contextStatus.tokensUsed, outputTokens: 0 };
  }

  // Priority 4: promptDryRunInfo (client-side estimate, double-encoded JSON)
  if (data.promptDryRunInfo && typeof data.promptDryRunInfo === 'string') {
    try {
      const parsed = JSON.parse(data.promptDryRunInfo) as {
        fullConversationTokenCount?: { numTokens?: number };
        userMessageTokenCount?: { numTokens?: number };
      };
      const fullConvTokens = parsed.fullConversationTokenCount?.numTokens ?? 0;
      const userMsgTokens = parsed.userMessageTokenCount?.numTokens ?? 0;
      // Use fullConversationTokenCount as input estimate
      if (fullConvTokens > 0) {
        return { inputTokens: fullConvTokens, outputTokens: 0 };
      }
      if (userMsgTokens > 0) {
        return { inputTokens: userMsgTokens, outputTokens: 0 };
      }
    } catch {
      // Ignore parse errors
    }
  }

  return undefined;
}

/**
 * Extract model info from a raw bubble.
 *
 * @param data - Raw bubble data object
 * @returns Model name string if present, undefined otherwise
 */
export function extractModelInfo(data: RawBubbleData): string | undefined {
  const modelName = data.modelInfo?.modelName;
  if (modelName && typeof modelName === 'string' && modelName.trim()) {
    return modelName;
  }
  return undefined;
}

/**
 * Extract timing info and calculate duration from a raw bubble.
 *
 * @param data - Raw bubble data object
 * @returns Duration in milliseconds if both start/end times exist, undefined otherwise
 */
export function extractTimingInfo(data: RawBubbleData): number | undefined {
  const timingInfo = data.timingInfo;
  if (!timingInfo) return undefined;

  const startTime = timingInfo.clientStartTime;
  const endTime = timingInfo.clientEndTime;

  if (typeof startTime !== 'number' || typeof endTime !== 'number') {
    return undefined;
  }

  const duration = endTime - startTime;
  return duration > 0 ? duration : undefined;
}

/** Minimum valid Unix millisecond timestamp (Sep 9, 2001) */
const MIN_VALID_UNIX_MS = 1_000_000_000_000;

/**
 * Extract the best available timestamp from a single bubble's data.
 *
 * Priority chain:
 * 1. `createdAt` (ISO string, new Cursor format >= 2025-09)
 * 2. `timingInfo.clientRpcSendTime` (Unix ms, old format assistant only)
 * 3. `timingInfo.clientSettleTime` (Unix ms, old format, sometimes present)
 * 4. `timingInfo.clientEndTime` (Unix ms, old format)
 * 5. `null` (no direct timestamp available, needs interpolation)
 *
 * All timingInfo values are validated against MIN_VALID_UNIX_MS (> 1e12)
 * to distinguish milliseconds from seconds and reject invalid values.
 *
 * @param data - Raw bubble data object with optional createdAt
 * @returns Date if a direct timestamp is found, null if interpolation is needed
 */
export function extractTimestamp(data: RawBubbleData & { createdAt?: string }): Date | null {
  // 1. createdAt (new Cursor format, >= 2025-09)
  if (data.createdAt) {
    return new Date(data.createdAt);
  }

  const timingInfo = data.timingInfo;
  if (!timingInfo) return null;

  // 2. clientRpcSendTime (old format, assistant only)
  const rpc = timingInfo.clientRpcSendTime;
  if (typeof rpc === 'number' && rpc > MIN_VALID_UNIX_MS) {
    return new Date(rpc);
  }

  // 3. clientSettleTime (old format, sometimes present)
  const settle = timingInfo.clientSettleTime;
  if (typeof settle === 'number' && settle > MIN_VALID_UNIX_MS) {
    return new Date(settle);
  }

  // 4. clientEndTime (old format)
  const end = timingInfo.clientEndTime;
  if (typeof end === 'number' && end > MIN_VALID_UNIX_MS) {
    return new Date(end);
  }

  return null;
}

/**
 * Provenance of a directly-stored per-message timestamp. Mirrors the priority
 * chain in `extractTimestamp` — the two MUST stay in sync. Returns undefined
 * when no directly-stored time exists (the timestamp would be absent/gap-filled).
 */
export function extractTimestampSource(
  data: RawBubbleData & { createdAt?: string }
): MessageTimestampSource | undefined {
  if (data.createdAt) return 'composer-created-at';
  const timingInfo = data.timingInfo;
  if (!timingInfo) return undefined;
  const rpc = timingInfo.clientRpcSendTime;
  if (typeof rpc === 'number' && rpc > MIN_VALID_UNIX_MS) return 'composer-timing';
  const settle = timingInfo.clientSettleTime;
  if (typeof settle === 'number' && settle > MIN_VALID_UNIX_MS) return 'composer-timing';
  const end = timingInfo.clientEndTime;
  if (typeof end === 'number' && end > MIN_VALID_UNIX_MS) return 'composer-timing';
  return undefined;
}

/**
 * Resolve message timestamp gaps through the shared deterministic projection.
 * Direct source values remain anchors; inferred/unknown values never become
 * anchors. The final fallback is Unix epoch rather than the read-time clock.
 *
 * Mutates the array in place.
 *
 * @param messages - Array of messages with potentially null timestamps
 * @param sessionCreatedAt - Session creation time for final fallback
 */
export function fillTimestampGaps(
  messages: Array<{
    timestamp: Date | null | undefined;
    timestampSource?: MessageTimestampSource;
    [key: string]: unknown;
  }>,
  sessionCreatedAt?: Date
): void {
  resolveMessageTimestamps(
    messages,
    isValidTimestamp(sessionCreatedAt)
      ? { timestamp: sessionCreatedAt, source: 'composer-metadata' }
      : undefined
  );
}

/**
 * Extract context window status from a raw bubble.
 * Only applicable to user messages (type 1).
 *
 * @param data - Raw bubble data object
 * @returns ContextWindowStatus if data exists, undefined otherwise
 */
export function extractContextWindowStatus(data: RawBubbleData): ContextWindowStatus | undefined {
  const status = data.contextWindowStatusAtCreation;
  if (!status) return undefined;

  const tokensUsed = status.tokensUsed;
  const tokenLimit = status.tokenLimit;

  if (typeof tokensUsed !== 'number' || typeof tokenLimit !== 'number') {
    return undefined;
  }

  // Prefer float percentage if available, else use integer
  const percentageRemaining = status.percentageRemainingFloat ?? status.percentageRemaining;
  if (typeof percentageRemaining !== 'number') {
    return undefined;
  }

  return { tokensUsed, tokenLimit, percentageRemaining };
}

/**
 * Parsed promptDryRunInfo data
 */
interface PromptDryRunInfo {
  fullConversationTokenCount?: number;
  userMessageTokenCount?: number;
}

/**
 * Extract promptDryRunInfo from a raw bubble.
 * Parses the double-encoded JSON string.
 *
 * @param data - Raw bubble data object
 * @returns Parsed info with token counts, undefined if not available
 */
export function extractPromptDryRunInfo(data: RawBubbleData): PromptDryRunInfo | undefined {
  const promptDryRunInfo = data.promptDryRunInfo;
  if (!promptDryRunInfo || typeof promptDryRunInfo !== 'string') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(promptDryRunInfo) as {
      fullConversationTokenCount?: { numTokens?: number };
      userMessageTokenCount?: { numTokens?: number };
    };

    const fullConversationTokenCount = parsed.fullConversationTokenCount?.numTokens;
    const userMessageTokenCount = parsed.userMessageTokenCount?.numTokens;

    if (
      typeof fullConversationTokenCount !== 'number' &&
      typeof userMessageTokenCount !== 'number'
    ) {
      return undefined;
    }

    return {
      fullConversationTokenCount:
        typeof fullConversationTokenCount === 'number' ? fullConversationTokenCount : undefined,
      userMessageTokenCount:
        typeof userMessageTokenCount === 'number' ? userMessageTokenCount : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Extract session-level usage summary from composer data.
 *
 * @param composerData - Raw composer data object
 * @param messages - Array of messages with token usage (for aggregation)
 * @returns SessionUsage with available fields populated
 */
export function extractSessionUsage(
  composerData: RawComposerData | undefined,
  messages: Array<{ tokenUsage?: TokenUsage }>
): SessionUsage | undefined {
  let hasData = false;
  const result: SessionUsage = {};

  // Extract from composer data
  if (composerData) {
    if (typeof composerData.contextTokensUsed === 'number') {
      result.contextTokensUsed = composerData.contextTokensUsed;
      hasData = true;
    }
    if (typeof composerData.contextTokenLimit === 'number') {
      result.contextTokenLimit = composerData.contextTokenLimit;
      hasData = true;
    }
    if (typeof composerData.contextUsagePercent === 'number') {
      // Normalize to float (may be int or float)
      result.contextUsagePercent = composerData.contextUsagePercent;
      hasData = true;
    }
  }

  // Aggregate token usage from messages
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hasTokenData = false;

  for (const msg of messages) {
    if (msg.tokenUsage) {
      totalInputTokens += msg.tokenUsage.inputTokens;
      totalOutputTokens += msg.tokenUsage.outputTokens;
      hasTokenData = true;
    }
  }

  if (hasTokenData) {
    result.totalInputTokens = totalInputTokens;
    result.totalOutputTokens = totalOutputTokens;
    hasData = true;
  }

  return hasData ? result : undefined;
}

// ============================================================================
// Migration Support Functions
// ============================================================================

/**
 * Find the workspace that contains a specific session by ID
 * Returns workspace info including the dbPath for read-write access
 */
export async function findWorkspaceForSession(
  sessionId: string,
  customDataPath?: string
): Promise<{ workspace: Workspace; dbPath: string } | null> {
  const workspaces = await findWorkspaces(customDataPath);

  for (const workspace of workspaces) {
    try {
      const db = await openDatabase(workspace.dbPath);
      const result = getChatDataFromDb(db);
      db.close();

      if (!result) continue;

      const composerRefs = extractComposerIdsFromData(result.bundle.composerData ?? result.data);
      const composers = composerRefs.map((ref) => ({ composerId: ref.composerId }));

      const found = composers.some((session) => session.composerId === sessionId);

      if (found) {
        return { workspace, dbPath: workspace.dbPath };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Find a workspace by its path (exact match)
 * Returns workspace info including the dbPath
 */
export async function findWorkspaceByPath(
  workspacePath: string,
  customDataPath?: string
): Promise<{ workspace: Workspace; dbPath: string } | null> {
  const workspaces = await findWorkspaces(customDataPath);

  // Normalize path for comparison
  const normalizedPath = normalizePath(workspacePath);

  for (const workspace of workspaces) {
    if (pathsEqual(workspace.path, normalizedPath)) {
      return { workspace, dbPath: workspace.dbPath };
    }
  }

  // Fallback: include workspaces with zero sessions so migrations can target empty destinations.
  const basePath = getCursorDataPath(customDataPath);
  if (!existsSync(basePath)) {
    return null;
  }

  try {
    const entries = readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspaceDir = join(basePath, entry.name);
      const dbPath = join(workspaceDir, 'state.vscdb');
      if (!existsSync(dbPath)) continue;

      const workspacePathFromJson = readWorkspaceJson(workspaceDir);
      if (!workspacePathFromJson) continue;

      if (pathsEqual(workspacePathFromJson, normalizedPath)) {
        return {
          workspace: {
            id: entry.name,
            path: workspacePathFromJson,
            dbPath,
            sessionCount: 0,
          },
          dbPath,
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Result from getComposerData containing both raw data and extracted composers
 */
export interface ComposerDataResult {
  /** The composers array (from allComposers or direct array) */
  composers: Array<{ composerId?: string; [key: string]: unknown }>;
  /** The full raw data object (for preserving structure on update) */
  rawData: unknown;
  /** Whether this uses the new allComposers format */
  isNewFormat: boolean;
}

/**
 * Get the composer data from a workspace database
 * Handles both new format (with allComposers) and legacy format (direct array)
 */
export function getComposerData(db: Database): ComposerDataResult | null {
  try {
    const value = readBoundedComposerValueByKey(
      db,
      'ItemTable',
      'composer.composerData',
      createComposerSqliteBudget()
    );

    if (!value) {
      return null;
    }

    const rawData = JSON.parse(value) as unknown;

    // Check if new format with allComposers
    if (rawData && typeof rawData === 'object' && 'allComposers' in rawData) {
      const data = rawData as {
        allComposers: Array<{ composerId?: string; [key: string]: unknown }>;
        selectedComposerIds?: unknown[];
      };
      const selectedComposers = Array.isArray(data.selectedComposerIds)
        ? data.selectedComposerIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => ({ composerId: id }))
        : [];
      const allComposers = Array.isArray(data.allComposers) ? data.allComposers : [];
      const seenIds = new Set(
        allComposers
          .map((composer) => composer.composerId)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      );
      const missingSelectedComposers = selectedComposers.filter((composer) => {
        if (!composer.composerId || seenIds.has(composer.composerId)) {
          return false;
        }
        seenIds.add(composer.composerId);
        return true;
      });

      return {
        composers: [...allComposers, ...missingSelectedComposers],
        rawData,
        isNewFormat: true,
      };
    }

    // Newer workspace shape: selectedComposerIds only (no allComposers list)
    if (
      rawData &&
      typeof rawData === 'object' &&
      'selectedComposerIds' in rawData &&
      Array.isArray((rawData as { selectedComposerIds?: unknown }).selectedComposerIds)
    ) {
      const selectedComposers = (rawData as { selectedComposerIds: unknown[] }).selectedComposerIds
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => ({ composerId: id }));

      return {
        composers: selectedComposers,
        rawData,
        isNewFormat: true,
      };
    }

    // Legacy format - direct array
    if (Array.isArray(rawData)) {
      return {
        composers: rawData as Array<{ composerId?: string; [key: string]: unknown }>,
        rawData,
        isNewFormat: false,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Update the composer data in a workspace database
 * Preserves the original structure (allComposers wrapper or direct array)
 */
export function updateComposerData(
  db: Database,
  composers: Array<{ composerId?: string; [key: string]: unknown }>,
  isNewFormat: boolean,
  originalRawData?: unknown
): void {
  let dataToWrite: unknown;

  if (isNewFormat) {
    // Preserve the original structure, just update allComposers
    if (originalRawData && typeof originalRawData === 'object') {
      const original = originalRawData as Record<string, unknown>;
      const selectedOnly =
        Array.isArray(original['selectedComposerIds']) &&
        (!Array.isArray(original['allComposers']) || original['allComposers'].length === 0);
      // Only persist composers that carry real metadata. Synthetic `{ composerId }`
      // stubs (surfaced by getComposerData's union of selectedComposerIds) would
      // otherwise be written back and parse to phantom sessions on the next list.
      const nextData: Record<string, unknown> = {
        ...original,
        allComposers: composers.filter(isHydratedComposer),
      };

      if (Array.isArray(original['selectedComposerIds'])) {
        const composerIds = composers
          .map((composer) => composer.composerId)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
        const composerIdSet = new Set(composerIds);
        const originalSelected = original['selectedComposerIds'].filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0
        );
        const selectedComposerIds = selectedOnly
          ? composerIds
          : originalSelected.filter((id) => composerIdSet.has(id));
        nextData['selectedComposerIds'] = selectedComposerIds;

        if (Array.isArray(original['lastFocusedComposerIds'])) {
          const originalFocused = original['lastFocusedComposerIds'].filter(
            (id): id is string => typeof id === 'string' && id.trim().length > 0
          );
          // Keep the previously focused tab whenever it survives the change;
          // only fall back to the first surviving composer when it does not.
          const survivingFocused = originalFocused.filter((id) => composerIdSet.has(id));
          const focusedComposerIds =
            survivingFocused.length > 0
              ? survivingFocused
              : selectedOnly
                ? selectedComposerIds.slice(0, 1)
                : [];
          nextData['lastFocusedComposerIds'] = focusedComposerIds;
        }
      }

      dataToWrite = nextData;
    } else {
      // No original shape to preserve: write only real composers, but keep any
      // id-only stubs referenced via selectedComposerIds so they remain listable.
      const hydrated = composers.filter(isHydratedComposer);
      const stubIds = composers
        .filter((composer) => !isHydratedComposer(composer))
        .map((composer) => composer.composerId)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
      dataToWrite =
        stubIds.length > 0
          ? { allComposers: hydrated, selectedComposerIds: stubIds }
          : { allComposers: hydrated };
    }
  } else {
    // Legacy format - direct array
    dataToWrite = composers;
  }

  const jsonValue = JSON.stringify(dataToWrite);
  db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(
    jsonValue,
    'composer.composerData'
  );
}

/**
 * Resolve session identifiers (index or ID) to actual session IDs
 * Supports: single index (number), single ID (string), comma-separated, or array
 *
 * @param input - Session identifier(s): number, string, or array
 * @param customDataPath - Optional custom Cursor data path
 * @returns Array of resolved session IDs
 * @throws SessionNotFoundError if any identifier cannot be resolved
 */
export async function resolveSessionIdentifiers(
  input: string | number | (string | number)[],
  customDataPath?: string
): Promise<string[]> {
  // Normalize input to array
  let identifiers: (string | number)[];

  if (Array.isArray(input)) {
    identifiers = input;
  } else if (typeof input === 'string' && input.includes(',')) {
    // Comma-separated string
    identifiers = input.split(',').map((s) => s.trim());
  } else {
    identifiers = [input];
  }

  // Get all sessions for lookup
  const summaries = await listSessions({ limit: 0, all: true }, customDataPath);

  const resolvedIds: string[] = [];

  for (const identifier of identifiers) {
    let sessionId: string | undefined;

    if (typeof identifier === 'number' || /^\d+$/.test(String(identifier))) {
      // It's an index (1-based)
      const index = typeof identifier === 'number' ? identifier : parseInt(String(identifier), 10);
      const session = summaries.find((s) => s.index === index);
      sessionId = session?.id;
    } else {
      // It's a session ID (UUID-like)
      const session = summaries.find((s) => s.id === String(identifier));
      sessionId = session?.id;
    }

    if (!sessionId) {
      throw new SessionNotFoundError(identifier);
    }

    resolvedIds.push(sessionId);
  }

  return resolvedIds;
}
