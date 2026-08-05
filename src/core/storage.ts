/**
 * Storage discovery and database access for Cursor chat history
 */

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
import { discoverStoreSessions } from './store-stack/discover.js';
import type { StoreSession } from './store-stack/types.js';
import { mergeCrossStackSessions, applyStoreMergeToSummary } from './store-stack/merge.js';
import { resolveSourceReadLimits } from './source-read-limits.js';
import { isSessionIntegrityError } from './errors.js';
import {
  isValidTimestamp,
  resolveMessageTimestamps,
  resolveSessionTimestamps,
  type ResolvedSessionTimestamps,
  type SessionMetadataTimestamps,
} from './timestamps.js';

interface StorageReadOperationOptions {
  readonly sqliteDriver?: DriverName;
  readonly sourceReadLimits?: SourceReadLimitsOverride | Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
}

const SESSION_READ_CAPABILITIES = new Set<DatabaseCapability>(['read']);
const MIGRATION_CAPABILITIES = new Set<DatabaseCapability>(['readWrite']);
const OWNING_DATABASE_READ_FAILURES = new WeakSet<object>();

function sessionReadRequest(sqliteDriver?: DriverName): DatabaseOperationRequest {
  return {
    operation: 'read-session',
    required: SESSION_READ_CAPABILITIES,
    ...(sqliteDriver ? { forcedDriver: sqliteDriver } : {}),
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
  });
}

/** Infrastructure/cancellation failures must never become empty or partial reads. */
function shouldPropagateReadFailure(error: unknown): boolean {
  const code =
    error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined;
  return (
    isSessionIntegrityError(error) ||
    (typeof error === 'object' &&
      error !== null &&
      OWNING_DATABASE_READ_FAILURES.has(error)) ||
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
  const db = await openDatabaseAsync(dbPath, sessionReadRequest(options.sqliteDriver));
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
  value: string;
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
    lastUpdatedAt:
      parseDateValue(data['lastUpdatedAt']) ?? parseDateValue(data['updatedAt']),
  };
}

function composerMetadataTimestampsFromJson(
  value: string | undefined
): SessionMetadataTimestamps {
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
      (summary.lastUpdatedAtSource === 'composer-metadata'
        ? summary.lastUpdatedAt
        : undefined),
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
function getWorkspaceComposerPointerIds(db: Database): string[] {
  try {
    const rows = db
      .prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%composerChatViewPane%'")
      .all() as { key: string; value: string }[];
    const ids = new Set<string>();
    for (const row of rows) {
      for (const source of [row.key, row.value]) {
        if (typeof source !== 'string') continue;
        const matches = source.match(COMPOSER_GUID_RE);
        if (matches) {
          for (const match of matches) {
            ids.add(match.toLowerCase());
          }
        }
      }
    }
    return [...ids];
  } catch {
    return [];
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
  let rawData: Record<string, unknown>;

  try {
    rawData = JSON.parse(row.value) as Record<string, unknown>;
  } catch (error) {
    debugLogStorage(`Malformed bubble row ${row.key}: ${getErrorMessage(error)}`);
    return {
      id: getBubbleRowId(row.key),
      role: 'assistant',
      content: '[corrupted message]',
      timestamp: null,
      codeBlocks: [],
      metadata: { corrupted: true },
      source: 'composer',
    };
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
    return {
      id: getBubbleRowId(row.key),
      role: 'assistant',
      content: '[corrupted message]',
      timestamp: null,
      codeBlocks: [],
      metadata: { corrupted: true },
      source: 'composer',
    };
  }
}

interface ComposerBubbleProjection extends ResolvedSessionTimestamps {
  messages: Message[];
}

function resolveBubbleMessages(
  bubbleRows: BubbleRow[],
  composerMetadata: SessionMetadataTimestamps = {}
): ComposerBubbleProjection {
  const messages = bubbleRows.map((row) => mapBubbleToMessage(row)) as Message[];
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

    // Count sessions in this workspace
    let sessionCount = 0;
    let db: Database | null = null;
    let readError: unknown;
    try {
      db = await openBackupDatabase(backupPath, file.path, readOptions);
      throwIfReadAborted(readOptions.signal);
      const result = getChatDataFromDb(db);
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
 * Read workspace.json to get the original workspace path.
 * Supports single-folder workspaces (folder) and .code-workspace files (configuration).
 */
export function readWorkspaceJson(workspaceDir: string): string | null {
  const jsonPath = join(workspaceDir, 'workspace.json');
  if (!existsSync(jsonPath)) {
    return null;
  }

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

  if (!existsSync(basePath)) {
    return [];
  }

  const workspaces: Workspace[] = [];
  let globalDb: Database | null = null;
  let globalDbChecked = false;
  let globalDbAvailable = false;
  let globalComposerRecords: GlobalComposerRecord[] = [];
  let globalBubbleCounts = new Map<string, number>();
  // Run-level set so a global composer is counted for at most one workspace,
  // keeping `list --workspaces` counts consistent with the deduped `list` output.
  const attributedComposerIds = new Set<string>();

  try {
    const entries = readdirSync(basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspaceDir = join(basePath, entry.name);
      const dbPath = join(workspaceDir, 'state.vscdb');

      if (!existsSync(dbPath)) continue;

      const workspacePath = readWorkspaceJson(workspaceDir) ?? `(workspace: ${entry.name})`;
      if (workspacePath.startsWith('(workspace:')) {
        debugLogStorage(
          `Using workspace ID fallback path for ${entry.name} (workspace.json missing/unknown)`
        );
      }

      // Count sessions in this workspace
      let sessionCount = 0;
      const seenComposerIds = new Set<string>();
      const selectedIds: string[] = [];
      const pointerIds: string[] = [];
      let workspaceDb: Database | null = null;
      try {
        throwIfReadAborted(operationOptions.signal);
        workspaceDb = await openDatabase(dbPath, operationOptions);
        throwIfReadAborted(operationOptions.signal);
        const result = getChatDataFromDb(workspaceDb);
        if (result) {
          const parsed = parseChatData(result.data, result.bundle);
          sessionCount = parsed.length;
          for (const session of parsed) {
            seenComposerIds.add(session.id);
            attributedComposerIds.add(session.id);
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
        pointerIds.push(...getWorkspaceComposerPointerIds(workspaceDb));
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
        if (existsSync(globalDbPath)) {
          try {
            throwIfReadAborted(operationOptions.signal);
            globalDb = await openDatabase(globalDbPath, operationOptions);
            throwIfReadAborted(operationOptions.signal);
            const tableCheck = globalDb
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
              .get();
            globalDbAvailable = Boolean(tableCheck);
            if (globalDbAvailable) {
              globalComposerRecords = loadGlobalComposerRecords(globalDb);
              globalBubbleCounts = loadGlobalBubbleCounts(globalDb);
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
        // Selected + pointer IDs are only counted when they resolve to a real
        // global composer with bubbles, so non-composer GUIDs never inflate counts.
        for (const composerId of [...selectedIds, ...pointerIds]) {
          if (seenComposerIds.has(composerId) || attributedComposerIds.has(composerId)) continue;
          if ((globalBubbleCounts.get(composerId) ?? 0) > 0) {
            seenComposerIds.add(composerId);
            attributedComposerIds.add(composerId);
            sessionCount++;
          }
        }

        const workspaceForGlobalMatch: Workspace = {
          id: entry.name,
          path: workspacePath,
          dbPath,
          sessionCount,
        };
        for (const summary of getGlobalComposerSummariesForWorkspace(
          globalDb,
          workspaceForGlobalMatch,
          globalComposerRecords,
          globalBubbleCounts
        )) {
          if (seenComposerIds.has(summary.id) || attributedComposerIds.has(summary.id)) continue;
          seenComposerIds.add(summary.id);
          attributedComposerIds.add(summary.id);
          sessionCount++;
        }
      } else {
        // No global storage: pointer GUIDs cannot be confirmed as composers, so
        // only count real selectedComposerIds (avoid phantom session counts).
        for (const composerId of selectedIds) {
          if (seenComposerIds.has(composerId) || attributedComposerIds.has(composerId)) continue;
          seenComposerIds.add(composerId);
          attributedComposerIds.add(composerId);
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
function getChatDataFromDb(db: Database): ChatDataResult | null {
  const candidates: Array<{ key: string; value: string }> = [];
  for (const key of CHAT_DATA_KEYS) {
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
        { value: string } | undefined;
      if (row?.value) {
        candidates.push({ key, value: row.value });
      }
    } catch (error) {
      // A Cursor database without ItemTable simply has no workspace chat
      // payload. Every other query failure is an owning-read failure and must
      // not be converted into an empty session list.
      if (
        error instanceof Error &&
        /(?:no such table|does not exist).*\bItemTable\b/i.test(error.message)
      ) {
        return null;
      }
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
  const promptsRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(PROMPTS_KEY) as
    { value: string } | undefined;
  if (promptsRow?.value) {
    bundle.prompts = promptsRow.value;
  }

  const gensRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(GENERATIONS_KEY) as
    { value: string } | undefined;
  if (gensRow?.value) {
    bundle.generations = gensRow.value;
  }

  return { data: mainData, bundle };
}

/**
 * Count bubbles per composer in a single pass over global storage, instead of one
 * `COUNT(*) ... LIKE 'bubbleId:<id>:%'` full scan per composer. Reused across the
 * recovery passes so listing stays roughly one bubble-table scan rather than O(C).
 */
function loadGlobalBubbleCounts(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    const rows = db.prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all() as {
      key: string;
    }[];
    for (const row of rows) {
      // key form: bubbleId:<composerId>:<bubbleId>
      const composerId = row.key.split(':')[1];
      if (composerId) {
        counts.set(composerId, (counts.get(composerId) ?? 0) + 1);
      }
    }
  } catch {
    // Fall back to per-composer counting when the scan fails.
  }
  return counts;
}

function buildGlobalComposerSummary(
  db: Database,
  composerId: string,
  composerData: Record<string, unknown>,
  options?: { bubbleCount?: number; includePreview?: boolean }
): GlobalComposerSummary | null {
  const messageCount =
    options?.bubbleCount ??
    (
      db
        .prepare('SELECT COUNT(*) as count FROM cursorDiskKV WHERE key LIKE ?')
        .get(`bubbleId:${composerId}:%`) as { count: number }
    ).count;
  if (messageCount <= 0) {
    return null;
  }

  const composerMetadata = composerMetadataTimestamps(composerData);
  let directMessages: Message[] = [];
  if (!composerMetadata.createdAt || !composerMetadata.lastUpdatedAt) {
    const timestampRows = db
      .prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC')
      .all(`bubbleId:${composerId}:%`) as BubbleRow[];
    directMessages = timestampRows.map((row) => mapBubbleToMessage(row)) as Message[];
  }
  const sessionTimestamps = resolveSessionTimestamps({
    view: 'composer-backed',
    composerMetadata,
    directMessages,
  });

  let preview = '';
  if (options?.includePreview !== false) {
    const firstBubble = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC LIMIT 1')
      .get(`bubbleId:${composerId}:%`) as { value: string } | undefined;
    if (firstBubble?.value) {
      try {
        const bubbleData = JSON.parse(firstBubble.value) as Record<string, unknown>;
        preview = extractBubbleText(bubbleData).slice(0, 100);
      } catch {
        preview = '';
      }
    }
  }

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
  };
}

function getGlobalComposerSummary(
  db: Database,
  composerId: string,
  bubbleCounts?: Map<string, number>
): GlobalComposerSummary | null {
  try {
    const composerRow = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${composerId}`) as { value: string } | undefined;
    if (!composerRow?.value) {
      return null;
    }

    const composerData = JSON.parse(composerRow.value) as unknown;
    if (!isRecord(composerData)) {
      return null;
    }

    return buildGlobalComposerSummary(db, composerId, composerData, {
      bubbleCount: bubbleCounts?.get(composerId),
    });
  } catch {
    return null;
  }
}

/**
 * Load and parse every `composerData:%` row from global storage exactly once.
 * Callers reuse the result across all workspaces instead of re-scanning and
 * re-parsing the full composer table per workspace (which made `list` O(W×C)).
 */
function loadGlobalComposerRecords(db: Database): GlobalComposerRecord[] {
  try {
    const rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as { key: string; value: string }[];
    const records: GlobalComposerRecord[] = [];

    for (const row of rows) {
      try {
        const data = JSON.parse(row.value) as unknown;
        if (isRecord(data)) {
          records.push({ id: row.key.replace('composerData:', ''), data });
        }
      } catch {
        continue;
      }
    }

    return records;
  } catch {
    return [];
  }
}

function getGlobalComposerSummariesForWorkspace(
  db: Database,
  workspace: Workspace,
  records: GlobalComposerRecord[],
  bubbleCounts?: Map<string, number>
): GlobalComposerSummary[] {
  const summaries: GlobalComposerSummary[] = [];

  for (const record of records) {
    if (!composerBelongsToWorkspace(record.data, workspace)) {
      continue;
    }

    const summary = buildGlobalComposerSummary(db, record.id, record.data, {
      bubbleCount: bubbleCounts?.get(record.id),
    });
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
      try {
        wsDb = await openDatabase(workspace.dbPath);
        for (const pointerId of getWorkspaceComposerPointerIds(wsDb)) {
          const data = recordById.get(pointerId);
          if (!data) continue;
          if (!composerHasWorkspaceStamp(data) || composerBelongsToWorkspace(data, workspace)) {
            ids.add(pointerId);
          }
        }
      } catch {
        // Ignore unreadable workspace DB; global-linked IDs are still returned.
      } finally {
        closeDatabase(wsDb);
      }
    }

    return [...ids];
  } catch (error) {
    debugLogStorage(`Failed to load workspace-linked composer IDs: ${getErrorMessage(error)}`);
    return [];
  } finally {
    closeDatabase(db);
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
  /**
   * Workspace scope bound to this operation. `null` means an unfiltered
   * listing; `undefined` means no listing has been performed yet.
   */
  workspaceScope: string | null | undefined;
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
  /**
   * Lazily resolved final sessions, after Composer/Store loading and any
   * cross-stack merge. Promises coalesce concurrent reads of the same selected
   * summary; duplicate filtered summaries with one stable ID remain distinct.
   */
  resolvedSessions: Map<string, Promise<ChatSession | null>>;
}

/**
 * Create an empty operation-scoped read context for one storage source.
 * @param customDataPath - Optional live Cursor data path bound to this context.
 * @param backupPath - Optional backup path bound to this context.
 * @returns A context that lazily caches discovery and listing results for that source.
 */
export function createSessionReadContext(
  customDataPath?: string,
  backupPath?: string,
  options: StorageReadOperationOptions = {}
): SessionReadContext {
  // Validate caller policy and cancellation before any later source I/O.
  const sourceReadLimits = resolveSourceReadLimits(options.sourceReadLimits);
  throwIfReadAborted(options.signal);
  return {
    customDataPath,
    backupPath,
    ...(options.sqliteDriver ? { sqliteDriver: options.sqliteDriver } : {}),
    sourceReadLimits,
    ...(options.signal ? { signal: options.signal } : {}),
    workspaceScope: undefined,
    storeSessions: null,
    storeSessionsPromise: null,
    workspaces: null,
    workspacesPromise: null,
    summaries: null,
    resolvedSessions: new Map(),
  };
}

function optionalPathsEqual(left?: string, right?: string): boolean {
  if (left === undefined || right === undefined) return left === right;
  return pathsEqual(left, right);
}

const UNKNOWN_WORKSPACE_PATH = '(unknown workspace)';

/** Workspace filters are exact after cross-platform normalization; suffixes never qualify. */
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
  if (
    !optionalPathsEqual(context.customDataPath, customDataPath) ||
    !optionalPathsEqual(context.backupPath, backupPath)
  ) {
    throw new Error(
      'SessionReadContext source mismatch: create a new context for each dataPath/backupPath pair'
    );
  }
}

function bindContextWorkspaceScope(
  context: SessionReadContext | undefined,
  workspacePath?: string
): void {
  if (!context) return;

  const requestedScope = workspacePath ?? null;
  if (context.workspaceScope === undefined) {
    context.workspaceScope = requestedScope;
    return;
  }

  const sameScope =
    context.workspaceScope === null
      ? requestedScope === null
      : requestedScope !== null && pathsEqual(context.workspaceScope, requestedScope);
  if (!sameScope) {
    throw new Error(
      'SessionReadContext workspace scope mismatch: create a new context for each workspace scope'
    );
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

async function getWorkspacesCached(
  context: SessionReadContext | undefined,
  customDataPath?: string,
  backupPath?: string
): Promise<Workspace[]> {
  assertContextSource(context, customDataPath, backupPath);
  throwIfReadAborted(context?.signal);
  if (context?.workspaces) return context.workspaces;
  if (context?.workspacesPromise) return context.workspacesPromise;

  const discovery = findWorkspaces(customDataPath, backupPath, context);
  if (!context) return discovery;

  context.workspacesPromise = discovery;
  try {
    const workspaces = await discovery;
    context.workspaces = workspaces;
    return workspaces;
  } finally {
    context.workspacesPromise = null;
  }
}

/**
 * Return the Store sessions for the operation, discovering at most once and
 * caching into the context when one is supplied. Backups never carry ~/.cursor.
 */
async function getStoreSessionsCached(
  context: SessionReadContext | undefined,
  customDataPath?: string,
  backupPath?: string
): Promise<StoreSession[]> {
  assertContextSource(context, customDataPath, backupPath);
  throwIfReadAborted(context?.signal);
  if (backupPath) return [];
  if (context?.storeSessions) return context.storeSessions;
  if (context?.storeSessionsPromise) return context.storeSessionsPromise;

  const discovery = discoverStoreSessions(getStoreStackRoot(customDataPath), {
    sourceReadLimits: context?.sourceReadLimits,
    sqliteDriver: context?.sqliteDriver,
    signal: context?.signal,
  });
  if (!context) return discovery;

  context.storeSessionsPromise = discovery;
  try {
    const sessions = await discovery;
    context.storeSessions = sessions;
    return sessions;
  } finally {
    context.storeSessionsPromise = null;
  }
}

/**
 * List chat sessions with optional filtering
 * Uses workspace storage for listing (has correct paths and complete list)
 * When `options.workspacePath` is unset, deduplicates by session ID across workspaces (deterministic order).
 * When `workspacePath` is set, lists that workspace's DB only with no cross-workspace deduplication.
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
  context ??= createSessionReadContext(customDataPath, backupPath, {
    sourceReadLimits: options.sourceReadLimits,
    signal: options.signal,
  });
  resolveSourceReadLimits(options.sourceReadLimits ?? context?.sourceReadLimits);
  throwIfReadAborted(options.signal ?? context?.signal);
  assertContextSource(context, customDataPath, backupPath);
  bindContextWorkspaceScope(context, options.workspacePath);
  if (context?.summaries) {
    return applySessionListLimit(context.summaries, options);
  }

  // T029: Support reading from backup
  const workspaces = await getWorkspacesCached(context, customDataPath, backupPath);

  // Filter by workspace if specified
  // Deterministic order: .code-workspace paths before others, then by path (for stable attribution when deduping)
  const filteredWorkspaces = (
    options.workspacePath
      ? workspaces.filter((w) => workspaceFilterMatches(w.path, options.workspacePath!))
      : workspaces
  ).sort((a, b) => {
    const normA = normalizePath(a.path);
    const normB = normalizePath(b.path);
    const aCode = normA.endsWith('.code-workspace') ? 0 : 1;
    const bCode = normB.endsWith('.code-workspace') ? 0 : 1;
    if (aCode !== bCode) return aCode - bCode;
    return normA.localeCompare(normB);
  });

  const allSessions: ChatSessionSummary[] = [];
  // When listing all workspaces (no filter), dedupe by session id; keep first occurrence (workspace order is already deterministic)
  const seenIds = options.workspacePath ? null : new Set<string>();
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
          })
        : await openDatabase(workspace.dbPath, context);
      throwIfReadAborted(options.signal ?? context?.signal);
      const result = getChatDataFromDb(workspaceDb);
      // Pointer keys (e.g. composerChatViewPane.<guid>) live in ItemTable and link
      // this workspace to its global composers even when no workspace stamp exists.
      const pointerIds = backupPath ? [] : getWorkspaceComposerPointerIds(workspaceDb);

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
        if (seenIds?.has(session.id)) continue;
        seenIds?.add(session.id);
        allSessions.push({
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
        });
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

  if (!backupPath && (globalFallbackCandidates.length > 0 || !options.workspacePath)) {
    const globalDbPath = join(getGlobalStoragePath(customDataPath), 'state.vscdb');
    if (existsSync(globalDbPath)) {
      let globalDb: Database | null = null;
      try {
        throwIfReadAborted(options.signal ?? context?.signal);
        globalDb = await openDatabase(globalDbPath, context);
        const tableCheck = globalDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
          .get();

        if (tableCheck) {
          const globalComposerRecords = loadGlobalComposerRecords(globalDb);
          // One pass over the bubble table instead of two LIKE scans per composer.
          const globalBubbleCounts = loadGlobalBubbleCounts(globalDb);
          const summaryCache = new Map<string, GlobalComposerSummary | null>();
          // Dedup recovered sessions across candidates even under `--workspace`
          // (where the shared `seenIds` is intentionally null), so a single global
          // composer matching multiple workspace dirs is listed at most once.
          const recoveredIds = new Set<string>();
          for (const candidate of globalFallbackCandidates) {
            for (const composerId of candidate.composerIds) {
              if (candidate.existingIds.has(composerId)) continue;
              if (seenIds?.has(composerId)) continue;
              if (recoveredIds.has(composerId)) continue;

              if (!summaryCache.has(composerId)) {
                summaryCache.set(
                  composerId,
                  getGlobalComposerSummary(globalDb, composerId, globalBubbleCounts)
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

            if (candidate.includeWorkspaceLinked) {
              for (const summary of getGlobalComposerSummariesForWorkspace(
                globalDb,
                candidate.workspace,
                globalComposerRecords,
                globalBubbleCounts
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
          if (seenIds && !options.workspacePath) {
            for (const record of globalComposerRecords) {
              if (seenIds.has(record.id) || recoveredIds.has(record.id)) continue;

              // Use the precomputed bubble counts and skip the per-composer
              // first-bubble preview query so the catch-all stays ~one scan total
              // even when hundreds of composers are unattributed.
              const summary = buildGlobalComposerSummary(globalDb, record.id, record.data, {
                bubbleCount: globalBubbleCounts.get(record.id) ?? 0,
                includePreview: false,
              });
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

  // Merge Cursor Store-stack sessions (~/.cursor/{chats,projects}).
  // Independent from Composer customDataPath; discovered via getStoreStackRoot().
  // Falls back to [] when ~/.cursor is absent (pure-Composer users unaffected).
  // Skipped in backup mode: backups capture vscdb, not the live ~/.cursor tree.
  if (!backupPath) {
    const storeSessions = await getStoreSessionsCached(context, customDataPath, backupPath);
    const storeSeenIds = new Set(allSessions.map((session) => session.id));
    // Conflict priority for sessions present in BOTH stacks (same ID).
    const preferredSource = detectPreferredStackSource(customDataPath);
    for (const ss of storeSessions) {
      // Same ID in both stacks → merge scalar metadata and mark merged instead
      // of discarding the lower-priority representation. The full
      // field/message merge happens in getSession(). Do this before applying
      // the Store path filter: the Composer half has already matched the
      // requested workspace, while transcript-only Store metadata may not
      // contain a cwd at all.
      if (storeSeenIds.has(ss.id)) {
        const existingSummaries = allSessions.filter((s) => s.id === ss.id);
        for (const existing of existingSummaries) {
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
            },
            preferredSource
          );
        }
        continue;
      }
      if (
        options.workspacePath &&
        !workspaceFilterMatches(ss.workspacePath, options.workspacePath)
      ) {
        continue;
      }
      storeSeenIds.add(ss.id);
      allSessions.push({
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
        preview: ss.messages[0]?.content.slice(0, 100) ?? '(Empty session)',
        source: ss.source,
        resolvedSource: ss.resolvedSource,
        resolutionState: ss.resolution?.state,
        resolution: ss.resolution,
        messageIdentityVersion: 1,
        transcriptState: ss.transcriptState,
      });
    }
  }

  // Sort by most recent first
  allSessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // Assign indexes
  allSessions.forEach((session, i) => {
    session.index = i + 1;
  });

  // Keep the exact listing scope. In particular, a workspace-filtered operation
  // must resolve duplicate IDs against the same workspace it listed.
  if (context) {
    context.summaries = allSessions;
  }

  return applySessionListLimit(allSessions, options);
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
  backupPath?: string
): Promise<Workspace[]> {
  const context = createSessionReadContext(customDataPath, backupPath);
  const composerWorkspaces = await getWorkspacesCached(context, customDataPath, backupPath);
  const summaries = await listSessions(
    { limit: 0, all: true },
    customDataPath,
    backupPath,
    context
  );
  const workspaces = composerWorkspaces.map((workspace) => ({
    ...workspace,
    path: contractPath(workspace.path),
  }));

  for (const summary of summaries) {
    const storeBacked =
      summary.workspaceId === 'store' ||
      summary.source === 'transcript' ||
      summary.source === 'store' ||
      summary.source === 'store-complete' ||
      summary.source === 'store-partial' ||
      summary.source === 'merged' ||
      summary.resolvedSource === 'merged';
    if (!storeBacked) continue;

    const rawPath = summary.workspacePath?.trim() ? summary.workspacePath : UNKNOWN_WORKSPACE_PATH;
    const key = canonicalWorkspaceAggregationKey(rawPath);

    // A merged session is already included in the Composer inventory. Keep
    // that count when both stacks resolve to the same workspace. If the
    // preferred Store metadata resolves the session elsewhere, move (rather
    // than duplicate) the count to the canonical resolved workspace.
    if (summary.source === 'merged' || summary.resolvedSource === 'merged') {
      const countedComposerWorkspaces = composerWorkspaces.filter(
        (workspace) =>
          getCountedComposerSessionIds(workspace)?.has(summary.id) ??
          workspace.id === summary.workspaceId
      );
      if (
        countedComposerWorkspaces.length === 1 &&
        canonicalWorkspaceAggregationKey(countedComposerWorkspaces[0]!.path) === key
      ) {
        continue;
      }
      for (const composerWorkspace of countedComposerWorkspaces) {
        const countedRow = workspaces.find((workspace) => workspace.id === composerWorkspace.id);
        if (countedRow && countedRow.sessionCount > 0) {
          countedRow.sessionCount--;
        }
      }
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

  const nonEmptyWorkspaces = workspaces.filter((workspace) => workspace.sessionCount > 0);
  nonEmptyWorkspaces.sort((a, b) => b.sessionCount - a.sessionCount);
  return nonEmptyWorkspaces;
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
  const operationContext = context ?? createSessionReadContext(customDataPath, backupPath);
  throwIfReadAborted(operationContext.signal);
  assertContextSource(operationContext, customDataPath, backupPath);
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
      { limit: 0, all: true },
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
    return null;
  }

  const index = summary.index;
  const resolutionKey = `${summary.id}\0${summary.index}`;
  let resolution = operationContext.resolvedSessions.get(resolutionKey);
  if (!resolution) {
    resolution = resolveFinalSession(summary, index, customDataPath, backupPath, operationContext);
    operationContext.resolvedSessions.set(resolutionKey, resolution);
  }

  try {
    const session = await resolution;
    return session ? structuredClone(session) : null;
  } catch (error) {
    if (operationContext.resolvedSessions.get(resolutionKey) === resolution) {
      operationContext.resolvedSessions.delete(resolutionKey);
    }
    throw error;
  }
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
  // Merged: same ID exists in both stacks, so field-merge the two representations.
  if (summary.source === 'merged' || summary.resolvedSource === 'merged') {
    return loadMergedSession(summary, index, customDataPath, backupPath, context);
  }

  // Store-stack sessions (transcript/store*) don't live in vscdb; resolve via
  // the cached Store discovery when available.
  if (
    summary.workspaceId === 'store' ||
    summary.resolvedSource === 'store-db' ||
    summary.resolvedSource === 'store-transcript' ||
    summary.resolvedSource === 'store-metadata' ||
    summary.source === 'transcript' ||
    summary.source === 'store' ||
    summary.source === 'store-complete' ||
    summary.source === 'store-partial'
  ) {
    const storeSession = (await getStoreSessionsCached(context, customDataPath, backupPath)).find(
      (s) => s.id === summary.id
    );
    if (!storeSession) return null;
    return mapStoreSession(storeSession, index);
  }

  // Composer stack: global storage (full bubbles) with workspace fallback.
  return loadComposerSession(summary, index, customDataPath, backupPath, context);
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
    } else if (!existsSync(globalDbPath)) {
      globalLoadFailed = true;
      debugLogStorage(`Global DB not found at ${globalDbPath}`);
    } else {
      try {
        globalDb = await openDatabase(globalDbPath, context);
      } catch (error) {
        globalLifecycleError = error;
        if (shouldPropagateReadFailure(error)) throw error;
        globalLoadFailed = true;
        debugLogStorage(`Failed to open global DB at ${globalDbPath}: ${getErrorMessage(error)}`);
      }
    }

    if (globalDb) {
      let bubbleRows: BubbleRow[] = [];
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
          bubbleRows = globalDb
            .prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC')
            .all(`bubbleId:${summary.id}:%`) as BubbleRow[];

          try {
            composerDataRow = globalDb
              .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
              .get(`composerData:${summary.id}`) as { value: string } | undefined;
          } catch {
            // Ignore composer data errors; message-level recovery still works.
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
  const workspaces = await getWorkspacesCached(context, customDataPath, backupPath);
  const workspace = workspaces.find((w) => w.id === summary.workspaceId);

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
        })
      : await openDatabase(workspace.dbPath, context);
    throwIfReadAborted(context?.signal);
    const result = getChatDataFromDb(workspaceDb);

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

  const storeRaw = (await getStoreSessionsCached(context, customDataPath, backupPath)).find(
    (s) => s.id === summary.id
  );
  const store = storeRaw ? mapStoreSession(storeRaw, index) : null;
  const composer = await loadComposerSession(summary, index, customDataPath, backupPath, context);

  if (composer && store) {
    return mergeCrossStackSessions(composer, store, preferredSource, index);
  }
  // Graceful degradation: one side is unavailable — return the other as-is.
  return composer ?? store;
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
  // Use one Store discovery per search. The context caches store sessions and
  // (after the listing below) the summaries, so each getSession avoids
  // re-discovering and re-listing.
  const context =
    readContext ??
    createSessionReadContext(customDataPath, backupPath, {
      sourceReadLimits: options.sourceReadLimits,
      signal: options.signal,
    });
  resolveSourceReadLimits(options.sourceReadLimits ?? context.sourceReadLimits);
  throwIfReadAborted(options.signal ?? context.signal);
  assertContextSource(context, customDataPath, backupPath);
  // T031: Support reading from backup
  const summaries = await listSessions(
    { limit: 0, all: true, workspacePath: options.workspacePath },
    customDataPath,
    backupPath,
    context
  );
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const summary of summaries) {
    throwIfReadAborted(options.signal ?? context.signal);
    // Resolve by stable ID via the cached context rather than mutable index.
    const session = await getSession(
      summary.id,
      customDataPath,
      backupPath,
      context,
      summary.index
    );
    if (!session) continue;

    const snippets = getSearchSnippets(session.messages, lowerQuery, options.contextChars);

    if (snippets.length > 0) {
      const matchCount = snippets.reduce((sum, s) => sum + s.matchPositions.length, 0);

      results.push({
        sessionId: summary.id,
        index: summary.index,
        workspacePath: summary.workspacePath,
        createdAt: summary.createdAt,
        matchCount,
        snippets,
      });
    }
  }

  // Sort by match count descending
  results.sort((a, b) => b.matchCount - a.matchCount);

  // Apply limit
  if (options.limit > 0) {
    return results.slice(0, options.limit);
  }

  return results;
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

  try {
    const db = await openDatabase(dbPath);

    // Check if cursorDiskKV table exists
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();

    if (!tableCheck) {
      db.close();
      return [];
    }

    // Get all composerData entries
    const composerRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as { key: string; value: string }[];

    const sessions: ChatSessionSummary[] = [];

    for (const row of composerRows) {
      const composerId = row.key.replace('composerData:', '');

      try {
        const data = JSON.parse(row.value) as {
          name?: string;
          title?: string;
          createdAt?: string | number;
          updatedAt?: string | number;
          lastUpdatedAt?: string | number;
          workspaceUri?: string;
          workspaceIdentifier?: {
            uri?: {
              fsPath?: string;
              path?: string;
              external?: string;
            };
          };
        };

        // Count bubbles for this composer
        const bubbleCount = db
          .prepare('SELECT COUNT(*) as count FROM cursorDiskKV WHERE key LIKE ?')
          .get(`bubbleId:${composerId}:%`) as { count: number };

        if (bubbleCount.count === 0) continue;

        // Get first bubble for preview
        const firstBubble = db
          .prepare('SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC LIMIT 1')
          .get(`bubbleId:${composerId}:%`) as { value: string } | undefined;

        let preview = '';
        if (firstBubble) {
          try {
            const bubbleData = JSON.parse(firstBubble.value);
            preview = extractBubbleText(bubbleData).slice(0, 100);
          } catch {
            // Ignore
          }
        }

        const composerMetadata = composerMetadataTimestamps(
          data as unknown as Record<string, unknown>
        );
        let directMessages: Message[] = [];
        if (!composerMetadata.createdAt || !composerMetadata.lastUpdatedAt) {
          const timestampRows = db
            .prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC')
            .all(`bubbleId:${composerId}:%`) as BubbleRow[];
          directMessages = timestampRows.map((bubble) => mapBubbleToMessage(bubble)) as Message[];
        }
        const sessionTimestamps = resolveSessionTimestamps({
          view: 'composer-backed',
          composerMetadata,
          directMessages,
        });
        const workspacePath =
          data.workspaceIdentifier?.uri?.fsPath ??
          data.workspaceIdentifier?.uri?.path ??
          (data.workspaceIdentifier?.uri?.external
            ? uriToPath(data.workspaceIdentifier.uri.external)
            : data.workspaceUri
              ? uriToPath(data.workspaceUri)
              : 'Global');

        sessions.push({
          id: composerId,
          index: 0,
          title: data.name ?? data.title ?? null,
          ...sessionTimestamps,
          messageCount: bubbleCount.count,
          workspaceId: 'global',
          workspacePath: contractPath(workspacePath),
          preview,
        });
      } catch {
        continue;
      }
    }

    db.close();

    // Sort by most recent first
    sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Assign indexes
    sessions.forEach((session, i) => {
      session.index = i + 1;
    });

    return sessions;
  } catch {
    return [];
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

  try {
    db = await openDatabase(dbPath);

    const bubbleRows = db
      .prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC')
      .all(`bubbleId:${summary.id}:%`) as BubbleRow[];

    if (bubbleRows.length === 0) {
      debugLogStorage(`No bubbles for composer ${summary.id}`);
      return null;
    }

    const composerRow = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${summary.id}`) as { value: string } | undefined;
    const projection = resolveBubbleMessages(
      bubbleRows,
      composerMetadataTimestampsForSummary(composerRow?.value, summary)
    );
    const resolvedMessages = projection.messages;
    const sessionUsage = parseComposerSessionUsage(composerRow?.value, resolvedMessages);
    const activeBranchBubbleIds = extractActiveBranchBubbleIds(composerRow?.value);

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
    debugLogStorage(`Failed to load global session ${summary.id}: ${getErrorMessage(error)}`);
    return null;
  } finally {
    closeDatabase(db);
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
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('composer.composerData') as { value: string } | undefined;

    if (!row?.value) {
      return null;
    }

    const rawData = JSON.parse(row.value) as unknown;

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
