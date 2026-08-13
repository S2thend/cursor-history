/**
 * Core migration logic for Cursor chat history
 *
 * This module provides session-level migration as the core primitive.
 * Workspace-level migration is built on top of session migration.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createSessionReadContext,
  listSessions,
  listSessionSummaries,
  openDatabase,
  openDatabaseReadWrite,
  updateComposerData,
  getWorkspaceLinkedComposerIds,
  readWorkspaceJson,
  type ComposerDataResult,
  type SessionReadContext,
} from './storage.js';
import {
  getCursorDataPath,
  getGlobalStoragePath,
  getStoreStackRoot,
  normalizePath,
  pathsEqual,
} from '../lib/platform.js';
import {
  SessionNotFoundError,
  WorkspaceNotFoundError,
  SameWorkspaceError,
  NoSessionsFoundError,
  DestinationHasSessionsError,
  NestedPathError,
} from '../lib/errors.js';
import {
  MigrationTargetChangedError,
  SessionAmbiguityError,
  SessionScopeMismatchError,
  UnsupportedSessionMigrationError,
  isSessionIntegrityError,
} from './errors.js';
import { ensureDriver, selectDatabaseDriver, type DriverName } from './database/index.js';
import type { Database } from './database/types.js';
import { resolveSourceReadLimits, SqliteSourceReadBudget } from './source-read-limits.js';
import {
  forEachBoundedComposerBubbleMetadata,
  forEachBoundedComposerMetadata,
  forEachBoundedComposerValue,
  getBoundedComposerMetadataByKey,
  readBoundedComposerValueByKey,
} from './composer-sqlite.js';
import { resolveWorkspaceScope } from './workspace-scope.js';
import { isNativeCursorUuid, logicalSessionIdKey, sessionIdsEqual } from './session-id.js';
import type {
  ChatSessionSummary,
  LogicalSessionSummary,
  MigrateSessionOptions,
  MigrateWorkspaceOptions,
  MigrationMode,
  SessionMigrationResult,
  SourceReadLimitsOverride,
  SourceReadLimitsV1,
  WorkspaceMigrationResult,
} from './types.js';

/**
 * Generate a new unique session ID (UUID v4 format)
 */
function generateSessionId(): string {
  return randomUUID();
}

// ============================================================================
// Path Transformation Functions (for migration file path updates)
// ============================================================================

/**
 * Result of transforming paths in a single bubble
 */
interface PathTransformResult {
  /** Number of paths that were transformed */
  transformed: number;
  /** Number of paths that were skipped (outside source workspace) */
  skipped: number;
}

/**
 * T004: Transform a single path by replacing source prefix with destination prefix.
 * Returns null if path doesn't start with source prefix (external path).
 *
 * @param path - The path to transform
 * @param sourcePrefix - Source workspace path prefix
 * @param destPrefix - Destination workspace path prefix
 * @returns Transformed path or null if path is external
 */
function transformPath(path: string, sourcePrefix: string, destPrefix: string): string | null {
  // Normalize for comparison (handle trailing slashes)
  const normalizedSource = sourcePrefix.replace(/\/+$/, '');
  const normalizedPath = path;

  // Check if path starts with source prefix
  if (normalizedPath.startsWith(normalizedSource + '/') || normalizedPath === normalizedSource) {
    // Replace the prefix
    return destPrefix + normalizedPath.slice(normalizedSource.length);
  }

  // Path is outside source workspace
  return null;
}

/**
 * T005: Transform file paths in toolFormerData.params.
 * Updates: relativeWorkspacePath, targetFile, filePath, path
 *
 * @param params - Parsed params object (will be mutated)
 * @param sourcePrefix - Source workspace path prefix
 * @param destPrefix - Destination workspace path prefix
 * @param debug - Whether to log transformations
 * @returns Count of transformed and skipped paths
 */
function transformToolFormerParams(
  params: Record<string, unknown>,
  sourcePrefix: string,
  destPrefix: string,
  debug: boolean
): PathTransformResult {
  const result: PathTransformResult = { transformed: 0, skipped: 0 };
  const pathFields = ['relativeWorkspacePath', 'targetFile', 'filePath', 'path'];

  for (const field of pathFields) {
    const value = params[field];
    if (typeof value !== 'string') continue;

    const transformed = transformPath(value, sourcePrefix, destPrefix);
    if (transformed !== null) {
      if (debug) {
        console.error(`[DEBUG] toolFormerData.params.${field}: ${value} -> ${transformed}`);
      }
      params[field] = transformed;
      result.transformed++;
    } else {
      if (debug) {
        console.error(`[SKIP] toolFormerData.params.${field}: ${value} (outside workspace)`);
      }
      result.skipped++;
    }
  }

  return result;
}

/**
 * T006: Transform file paths in codeBlocks[].uri.
 * Updates: path, _formatted, _fsPath
 *
 * @param uri - URI object (will be mutated)
 * @param sourcePrefix - Source workspace path prefix
 * @param destPrefix - Destination workspace path prefix
 * @param debug - Whether to log transformations
 * @param blockIndex - Index of code block for logging
 * @returns Count of transformed and skipped paths
 */
function transformCodeBlockUri(
  uri: Record<string, unknown>,
  sourcePrefix: string,
  destPrefix: string,
  debug: boolean,
  blockIndex: number
): PathTransformResult {
  const result: PathTransformResult = { transformed: 0, skipped: 0 };

  // Transform uri.path
  if (typeof uri.path === 'string') {
    const transformed = transformPath(uri.path, sourcePrefix, destPrefix);
    if (transformed !== null) {
      if (debug) {
        console.error(`[DEBUG] codeBlocks[${blockIndex}].uri.path: ${uri.path} -> ${transformed}`);
      }
      uri.path = transformed;
      result.transformed++;
    } else {
      if (debug) {
        console.error(`[SKIP] codeBlocks[${blockIndex}].uri.path: ${uri.path} (outside workspace)`);
      }
      result.skipped++;
    }
  }

  // Transform uri._fsPath
  if (typeof uri._fsPath === 'string') {
    const transformed = transformPath(uri._fsPath, sourcePrefix, destPrefix);
    if (transformed !== null) {
      if (debug) {
        console.error(
          `[DEBUG] codeBlocks[${blockIndex}].uri._fsPath: ${uri._fsPath} -> ${transformed}`
        );
      }
      uri._fsPath = transformed;
      result.transformed++;
    } else {
      if (debug) {
        console.error(
          `[SKIP] codeBlocks[${blockIndex}].uri._fsPath: ${uri._fsPath} (outside workspace)`
        );
      }
      result.skipped++;
    }
  }

  // Transform uri._formatted (file:// URL format)
  if (typeof uri._formatted === 'string') {
    // Extract path from file:// URL
    const fileUrlPrefix = 'file://';
    if (uri._formatted.startsWith(fileUrlPrefix)) {
      const urlPath = uri._formatted.slice(fileUrlPrefix.length);
      const transformed = transformPath(urlPath, sourcePrefix, destPrefix);
      if (transformed !== null) {
        const newFormatted = fileUrlPrefix + transformed;
        if (debug) {
          console.error(
            `[DEBUG] codeBlocks[${blockIndex}].uri._formatted: ${uri._formatted} -> ${newFormatted}`
          );
        }
        uri._formatted = newFormatted;
        result.transformed++;
      } else {
        if (debug) {
          console.error(
            `[SKIP] codeBlocks[${blockIndex}].uri._formatted: ${uri._formatted} (outside workspace)`
          );
        }
        result.skipped++;
      }
    }
  }

  return result;
}

/**
 * T007: Transform all file paths in a bubble's data.
 * Updates toolFormerData.params and codeBlocks[].uri
 *
 * @param bubbleData - Bubble data object (will be mutated)
 * @param sourcePrefix - Source workspace path prefix
 * @param destPrefix - Destination workspace path prefix
 * @param debug - Whether to log transformations
 * @returns Total count of transformed and skipped paths
 */
function transformBubblePaths(
  bubbleData: Record<string, unknown>,
  sourcePrefix: string,
  destPrefix: string,
  debug: boolean
): PathTransformResult {
  const result: PathTransformResult = { transformed: 0, skipped: 0 };

  // Transform toolFormerData.params
  const toolFormerData = bubbleData.toolFormerData as Record<string, unknown> | undefined;
  if (toolFormerData?.params) {
    try {
      // params is stored as JSON string
      const params = JSON.parse(toolFormerData.params as string) as Record<string, unknown>;
      const paramsResult = transformToolFormerParams(params, sourcePrefix, destPrefix, debug);
      result.transformed += paramsResult.transformed;
      result.skipped += paramsResult.skipped;

      // Update params back to JSON string if any paths were transformed
      if (paramsResult.transformed > 0) {
        toolFormerData.params = JSON.stringify(params);
      }
    } catch {
      // params is not valid JSON, skip
    }
  }

  // Transform codeBlocks[].uri
  const codeBlocks = bubbleData.codeBlocks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(codeBlocks)) {
    for (let i = 0; i < codeBlocks.length; i++) {
      const block = codeBlocks[i];
      if (block?.uri && typeof block.uri === 'object') {
        const uriResult = transformCodeBlockUri(
          block.uri as Record<string, unknown>,
          sourcePrefix,
          destPrefix,
          debug,
          i
        );
        result.transformed += uriResult.transformed;
        result.skipped += uriResult.skipped;
      }
    }
  }

  return result;
}

/**
 * T008: Check if destination path is nested within source path.
 * This would cause infinite replacement loops during path transformation.
 *
 * @param source - Source workspace path
 * @param destination - Destination workspace path
 * @returns true if destination is nested within source
 */
function isNestedPath(source: string, destination: string): boolean {
  const normalizedSource = normalizePath(source).replace(/\/+$/, '');
  const normalizedDest = normalizePath(destination).replace(/\/+$/, '');

  // Destination is nested if it starts with source + separator
  return normalizedDest.startsWith(normalizedSource + '/');
}

function toFileUri(path: string): string {
  const normalized = normalizePath(path);
  const windowsDrivePath = normalized.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windowsDrivePath) {
    const drive = windowsDrivePath[1]!.toLowerCase();
    const rest = windowsDrivePath[2]!
      .replace(/\\/g, '/')
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    return `file:///${drive}:/${rest}`;
  }

  return pathToFileURL(normalized).href;
}

function toFileUriPath(workspacePath: string): string {
  try {
    // In the VS Code URI model `uri.path` is the DECODED path (it must match
    // fsPath); only `external`/`workspaceUri` carry percent-encoding.
    return decodeURIComponent(new URL(toFileUri(workspacePath)).pathname);
  } catch {
    return normalizePath(workspacePath);
  }
}

function updateComposerWorkspaceMetadata(
  composerData: Record<string, unknown>,
  workspacePath: string,
  workspaceId?: string
): void {
  const normalizedPath = normalizePath(workspacePath);
  const fileUri = toFileUri(normalizedPath);
  composerData['workspaceUri'] = fileUri;

  const existingIdentifier =
    composerData['workspaceIdentifier'] &&
    typeof composerData['workspaceIdentifier'] === 'object' &&
    !Array.isArray(composerData['workspaceIdentifier'])
      ? (composerData['workspaceIdentifier'] as Record<string, unknown>)
      : {};
  const existingUri =
    existingIdentifier['uri'] && typeof existingIdentifier['uri'] === 'object'
      ? (existingIdentifier['uri'] as Record<string, unknown>)
      : {};

  composerData['workspaceIdentifier'] = {
    ...existingIdentifier,
    ...(workspaceId ? { id: workspaceId } : {}),
    uri: {
      ...existingUri,
      fsPath: normalizedPath,
      external: fileUri,
      path: toFileUriPath(normalizedPath),
      scheme: 'file',
    },
  };
}

// ============================================================================
// Bound migration target preparation
// ============================================================================

/** Migration eligibility is decided before any writable database is opened. */
export type MigrationEligibility =
  | 'eligible-composer'
  | 'multiple-composer-occurrences'
  | 'shared-membership'
  | 'ambiguous'
  | 'store-only'
  | 'merged';

/** Private physical address used only by the core migration state machine. */
export interface InternalComposerLocator {
  readonly workspaceId: string;
  readonly databasePath: string;
  /** Compatibility alias retained for internal callers written against the original draft. */
  readonly dbPath: string;
  readonly sessionId: string;
  /** Exact case-preserving ID spelling bound in global cursorDiskKV, when present. */
  readonly globalSessionId?: string;
  /** Position in the decoded workspace Composer array, or -1 for a global-only record. */
  readonly composerIndex: number;
  /** Fingerprint of the exact Composer record at composerIndex. */
  readonly recordFingerprint: string;
}

/** Exact immutable target produced from one scoped logical selection. */
export interface BoundMigrationTarget {
  readonly logicalSessionId: string;
  readonly composerLocator: InternalComposerLocator;
  readonly sourceWorkspacePath: string;
  /** Capable SQLite provider selected once for the complete migration operation. */
  readonly sqliteDriver: DriverName;
  /** Store root captured with the operation; environment changes cannot retarget collision checks. */
  readonly storeRootPath: string;
  readonly dataSourceIdentity: string;
  readonly occurrenceFingerprint: string;
  readonly eligibility: MigrationEligibility;
  readonly dataPath?: string;
  readonly sourceReadLimits: Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
}

/** Options for binding CLI/core one-based or library-specific migration selectors. */
export interface MigrationBindingOptions {
  readonly numericBase?: 0 | 1;
  /** Internal compatibility mode for legacy APIs that already resolved IDs. */
  readonly treatStringSelectorsAsIds?: boolean;
  /** Internal operation binding; public migration configuration does not expose this field. */
  readonly sqliteDriver?: DriverName;
  /** Internal Store-root snapshot captured by a containing workspace operation. */
  readonly storeRootPath?: string;
  readonly workspacePath?: string;
  readonly dataPath?: string;
  readonly sourceReadLimits?: SourceReadLimitsOverride | Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
}

/** Options frozen into a prepared migration before the first write. */
export interface MigrationOptions {
  readonly mode: MigrationMode;
  readonly force?: boolean;
  readonly dataPath?: string;
  readonly debug?: boolean;
  readonly sourceReadLimits?: SourceReadLimitsOverride | Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
  /** Internal deterministic injection used by collision regression fixtures. */
  readonly uuidFactory?: () => string;
}

/** Private prepared state. It deliberately contains locators and is never public JSON. */
export interface PreparedSessionMigration {
  readonly target: BoundMigrationTarget;
  readonly destinationWorkspacePath: string;
  readonly destinationWorkspaceId?: string;
  readonly destinationDatabasePath: string;
  /** Physical identity captured at prepare time; content equality cannot mask file replacement. */
  readonly destinationDataSourceIdentity: string;
  readonly mode: MigrationMode;
  readonly sourceFingerprint: string;
  readonly destinationFingerprint: string;
  readonly proposedCopySessionId?: string;
  readonly dataPath?: string;
  readonly debug: boolean;
  readonly sourceReadLimits: Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
}

interface ComposerOccurrence {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly databasePath: string;
  readonly composerIndex: number;
  readonly composer: Record<string, unknown>;
  readonly fingerprint: string;
}

interface ComposerOccurrenceMetadata {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly databasePath: string;
  readonly composerIndex: number;
  readonly sessionId: string;
}

interface GlobalSessionRow {
  readonly key: string;
  readonly value: string;
}

interface MigrationReadGuard {
  readonly limits: Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
  readonly sqliteDriver?: DriverName;
}

function throwIfMigrationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw new DOMException('The migration operation was aborted.', 'AbortError');
}

function isMissingMigrationTableError(
  error: unknown,
  table: 'ItemTable' | 'cursorDiskKV'
): boolean {
  if (!(error instanceof Error) || !/(?:no such table|does not exist)/iu.test(error.message)) {
    return false;
  }
  return table === 'ItemTable'
    ? /\bItemTable\b/iu.test(error.message)
    : /\bcursorDiskKV\b/iu.test(error.message);
}

function createMigrationReadGuard(
  limits: Readonly<SourceReadLimitsV1>,
  signal?: AbortSignal,
  sqliteDriver?: DriverName
): MigrationReadGuard {
  return {
    limits,
    signal,
    sqliteDriver,
  };
}

function physicalPathIdentity(label: string, path: string): string {
  const normalized = normalizedPathKey(path);
  if (!existsSync(path)) return `${label}:${normalized}|missing`;
  try {
    const stat = statSync(path);
    return `${label}:${normalized}|dev:${String(stat.dev)}|ino:${String(stat.ino)}`;
  } catch {
    return `${label}:${normalized}|unavailable`;
  }
}

function currentDataSourceIdentity(
  dataPath: string | undefined,
  databasePath: string,
  storeRootPath: string
): string {
  const workspaceRoot = getCursorDataPath(dataPath);
  const globalDatabasePath = join(getGlobalStoragePath(dataPath), 'state.vscdb');
  return [
    physicalPathIdentity('workspace-root', workspaceRoot),
    physicalPathIdentity('workspace-db', databasePath),
    physicalPathIdentity('global-db', globalDatabasePath),
    physicalPathIdentity('store-root', storeRootPath),
  ].join('|');
}

function decodeComposerDataValue(value: string | undefined): ComposerDataResult | null {
  if (!value) return null;
  try {
    const rawData = JSON.parse(value) as unknown;
    if (rawData && typeof rawData === 'object' && 'allComposers' in rawData) {
      const data = rawData as {
        allComposers?: Array<{ composerId?: string; [key: string]: unknown }>;
        selectedComposerIds?: unknown[];
      };
      const allComposers = Array.isArray(data.allComposers) ? data.allComposers : [];
      const seenIds = new Set(
        allComposers
          .map((composer) => composer.composerId)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      );
      const missingSelectedComposers = (
        Array.isArray(data.selectedComposerIds) ? data.selectedComposerIds : []
      )
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .filter((id) => {
          if (seenIds.has(id)) return false;
          seenIds.add(id);
          return true;
        })
        .map((composerId) => ({ composerId }));
      return {
        composers: [...allComposers, ...missingSelectedComposers],
        rawData,
        isNewFormat: true,
      };
    }
    if (
      rawData &&
      typeof rawData === 'object' &&
      'selectedComposerIds' in rawData &&
      Array.isArray((rawData as { selectedComposerIds?: unknown }).selectedComposerIds)
    ) {
      return {
        composers: (rawData as { selectedComposerIds: unknown[] }).selectedComposerIds
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((composerId) => ({ composerId })),
        rawData,
        isNewFormat: true,
      };
    }
    if (Array.isArray(rawData)) {
      return {
        composers: rawData as Array<{ composerId?: string; [key: string]: unknown }>,
        rawData,
        isNewFormat: false,
      };
    }
  } catch {
    // Preserve getComposerData()'s historical malformed-row behavior while
    // ensuring no uncharged retry occurs.
  }
  return null;
}

function getComposerDataBounded(
  db: Awaited<ReturnType<typeof openDatabase>>,
  guard: MigrationReadGuard,
  budget = new SqliteSourceReadBudget(guard.limits, 'fatal')
): ComposerDataResult | null {
  throwIfMigrationAborted(guard.signal);
  const value = readBoundedComposerValueByKey(
    db,
    'ItemTable',
    'composer.composerData',
    budget,
    guard.signal
  );
  return decodeComposerDataValue(value);
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member !== undefined) result[key] = canonicalizeForHash(member);
  }
  return result;
}

function migrationFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(value)))
    .digest('hex');
}

function contextMigrationOptions(context: SessionReadContext | undefined): {
  dataPath?: string;
  workspacePath?: string;
  sourceReadLimits?: SourceReadLimitsOverride | Readonly<SourceReadLimitsV1>;
  signal?: AbortSignal;
  sqliteDriver?: DriverName;
} {
  if (!context) return {};
  const raw = context as unknown as Record<string, unknown>;
  // During the context API transition, accept both the released positional
  // shape and the additive immutable options/binding shapes.
  const positional = raw['customDataPath'];
  if (positional && typeof positional === 'object') {
    const options = positional as Record<string, unknown>;
    return {
      dataPath: typeof options['dataPath'] === 'string' ? options['dataPath'] : undefined,
      workspacePath:
        typeof options['workspacePath'] === 'string'
          ? options['workspacePath']
          : typeof options['workspace'] === 'string'
            ? options['workspace']
            : undefined,
      sourceReadLimits: options['sourceReadLimits'] as SourceReadLimitsOverride | undefined,
      signal: options['signal'] instanceof AbortSignal ? options['signal'] : undefined,
      sqliteDriver:
        options['sqliteDriver'] === 'node:sqlite' || options['sqliteDriver'] === 'better-sqlite3'
          ? options['sqliteDriver']
          : undefined,
    };
  }
  const scope = raw['scope'] as Record<string, unknown> | undefined;
  const binding = raw['binding'] as Record<string, unknown> | undefined;
  return {
    dataPath:
      typeof positional === 'string'
        ? positional
        : typeof binding?.['dataPath'] === 'string'
          ? binding['dataPath']
          : undefined,
    workspacePath:
      typeof raw['workspaceScope'] === 'string'
        ? raw['workspaceScope']
        : typeof scope?.['workspacePath'] === 'string'
          ? scope['workspacePath']
          : undefined,
    sourceReadLimits: raw['sourceReadLimits'] as
      SourceReadLimitsOverride | Readonly<SourceReadLimitsV1> | undefined,
    signal: raw['signal'] instanceof AbortSignal ? raw['signal'] : undefined,
    sqliteDriver:
      raw['sqliteDriver'] === 'node:sqlite' || raw['sqliteDriver'] === 'better-sqlite3'
        ? raw['sqliteDriver']
        : undefined,
  };
}

function normalizedPathKey(value: string): string {
  return normalizePath(value).replace(/\\/g, '/').replace(/\/+$/, '');
}

async function resolveMigrationWorkspacePath(
  requested: string | undefined,
  dataPath: string | undefined,
  guard: MigrationReadGuard
): Promise<string | undefined> {
  if (!requested) return undefined;
  const basePath = getCursorDataPath(dataPath);
  const workspacePaths: string[] = [];
  if (existsSync(basePath)) {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(basePath, { withFileTypes: true });
    } catch (error) {
      if (
        isSessionIntegrityError(error) ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw error;
      }
      // The subsequent occurrence inventory is the authority for destructive
      // eligibility and will convert an incomplete corpus into the typed
      // incomplete-composer-inventory refusal. Do not decode session/pointer
      // payload merely to normalize a workspace selector.
      const fallback = resolveWorkspaceScope(requested, []);
      return fallback.kind === 'not-found' ? fallback.normalizedRequest : fallback.path;
    }

    for (const entry of entries) {
      throwIfMigrationAborted(guard.signal);
      if (!entry.isDirectory()) continue;
      const workspaceDirectory = join(basePath, entry.name);
      if (!existsSync(join(workspaceDirectory, 'state.vscdb'))) continue;
      const workspacePath = readWorkspaceJson(workspaceDirectory);
      if (workspacePath) workspacePaths.push(normalizePath(workspacePath));
    }
  }

  const resolution = resolveWorkspaceScope(requested, workspacePaths);
  return resolution.kind === 'matched' ? resolution.path : resolution.normalizedRequest;
}

async function findMigrationWorkspaceByPath(
  requested: string,
  dataPath: string | undefined,
  guard: MigrationReadGuard
): Promise<{
  workspace: { id: string; path: string; dbPath: string; sessionCount: number };
  dbPath: string;
} | null> {
  throwIfMigrationAborted(guard.signal);
  const normalizedRequest = normalizePath(requested);
  // Destructive target discovery is deliberately workspace.json-only. Calling
  // findWorkspaces() here would decode every Composer catalog before the active
  // scope is bound, including unrelated conversation metadata.
  const basePath = getCursorDataPath(dataPath);
  if (!existsSync(basePath)) return null;
  for (const entry of readdirSync(basePath, { withFileTypes: true })) {
    throwIfMigrationAborted(guard.signal);
    if (!entry.isDirectory()) continue;
    const workspaceDirectory = join(basePath, entry.name);
    const databasePath = join(workspaceDirectory, 'state.vscdb');
    if (!existsSync(databasePath)) continue;
    const path = readWorkspaceJson(workspaceDirectory);
    if (!path || !pathsEqual(path, normalizedRequest)) continue;
    return {
      workspace: {
        id: entry.name,
        path: normalizePath(path),
        dbPath: databasePath,
        sessionCount: 0,
      },
      dbPath: databasePath,
    };
  }
  return null;
}

interface WorkspaceComposerAddressInventory {
  readonly materialized: Array<{ sessionId: string; composerIndex: number }>;
  readonly selectedIds: string[];
}

/** Project only Composer IDs/array positions from a workspace catalog. */
function loadWorkspaceComposerAddressInventory(
  db: Database,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): WorkspaceComposerAddressInventory {
  const source = getBoundedComposerMetadataByKey(
    db,
    'ItemTable',
    'composer.composerData',
    budget,
    signal
  );
  if (!source) return { materialized: [], selectedIds: [] };

  const root = db
    .prepare('SELECT json_type(value) AS rootType FROM ItemTable WHERE rowid = ?')
    .get(source.rowId) as { rootType?: unknown } | undefined;
  const rootType = root?.rootType;
  if (rootType !== 'array' && rootType !== 'object') {
    throw new TypeError('Composer workspace catalog is not a JSON array or object.');
  }

  const scanIds = (
    path: '$' | '$.allComposers' | '$.selectedComposerIds',
    objectIds: boolean
  ): Array<{ sessionId: string; itemIndex: number }> => {
    // Each independently addressable JSON catalog has its own aggregate
    // budget, matching the established per-catalog source-limit contract.
    // The enclosing row was separately admitted above before any projection.
    const scanBudget = new SqliteSourceReadBudget(budget.limits, budget.outcome);
    const results: Array<{ sessionId: string; itemIndex: number }> = [];
    const pageRows = scanBudget.limits.sqlitePageRows;
    let afterIndex = -1;
    const valueExpression = objectIds ? "json_extract(j.value, '$.composerId')" : 'j.value';
    const typePredicate = objectIds
      ? "json_type(j.value, '$.composerId') = 'text'"
      : "j.type = 'text'";
    while (true) {
      throwIfMigrationAborted(signal);
      const rows = db
        .prepare(
          `SELECT CAST(j.key AS INTEGER) AS itemIndex,
             length(CAST(${valueExpression} AS BLOB)) AS byteLength
           FROM ItemTable AS i, json_each(i.value, '${path}') AS j
           WHERE i.rowid = ?
             AND ${typePredicate}
             AND CAST(j.key AS INTEGER) > ?
           ORDER BY itemIndex ASC LIMIT ?`
        )
        .all(source.rowId, afterIndex, pageRows) as Array<{
        itemIndex?: number | bigint;
        byteLength?: number | bigint;
      }>;
      if (rows.length === 0) break;
      const metadata = rows.map((row) => {
        const itemIndex = Number(row.itemIndex);
        const byteLength = Number(row.byteLength);
        if (
          !Number.isSafeInteger(itemIndex) ||
          itemIndex < 0 ||
          !Number.isSafeInteger(byteLength) ||
          byteLength < 0
        ) {
          throw new TypeError('SQLite returned invalid Composer ID projection metadata.');
        }
        return { itemIndex, byteLength };
      });
      scanBudget.admitMetadataPage(metadata.map(({ byteLength }) => byteLength));
      for (const item of metadata) {
        throwIfMigrationAborted(signal);
        const projected = db
          .prepare(
            `SELECT ${valueExpression} AS sessionId
             FROM ItemTable AS i, json_each(i.value, '${path}') AS j
             WHERE i.rowid = ? AND CAST(j.key AS INTEGER) = ?`
          )
          .get(source.rowId, item.itemIndex) as { sessionId?: unknown } | undefined;
        if (typeof projected?.sessionId !== 'string') {
          throw new Error('Composer ID projection changed after metadata admission.');
        }
        const actualBytes = Buffer.byteLength(projected.sessionId);
        if (actualBytes !== item.byteLength) {
          throw new Error('Composer ID projection length changed after metadata admission.');
        }
        scanBudget.admitDecodedValue(actualBytes);
        results.push({ sessionId: projected.sessionId, itemIndex: item.itemIndex });
      }
      afterIndex = metadata[metadata.length - 1]!.itemIndex;
      if (rows.length < pageRows) break;
    }
    return results;
  };

  const materialized = scanIds(rootType === 'array' ? '$' : '$.allComposers', true).map(
    ({ sessionId, itemIndex }) => ({ sessionId, composerIndex: itemIndex })
  );
  const selectedIds =
    rootType === 'object'
      ? scanIds('$.selectedComposerIds', false).map(({ sessionId }) => sessionId)
      : [];
  return { materialized, selectedIds };
}

function pointerReferencesSession(key: string, value: string, sessionId: string): boolean {
  for (const text of [key, value]) {
    for (const candidate of text.match(
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gu
    ) ?? []) {
      if (sessionIdsEqual(candidate, sessionId)) return true;
    }
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { composerId?: unknown }).composerId === 'string'
    ) {
      return sessionIdsEqual((parsed as { composerId: string }).composerId, sessionId);
    }
  } catch {
    // Pointer UI state is often not JSON; canonical UUIDs in the key/value remain sufficient.
  }
  return false;
}

async function collectComposerOccurrences(
  sessionId: string,
  dataPath?: string,
  guard: MigrationReadGuard = createMigrationReadGuard(resolveSourceReadLimits()),
  hydrationWorkspacePath?: string
): Promise<{
  occurrences: ComposerOccurrence[];
  physicalOccurrences: ComposerOccurrenceMetadata[];
  pointerMembershipPaths: string[];
  complete: boolean;
}> {
  const occurrences: ComposerOccurrence[] = [];
  const physicalOccurrences: ComposerOccurrenceMetadata[] = [];
  const pointerMembershipPaths = new Set<string>();
  const basePath = getCursorDataPath(dataPath);
  if (!existsSync(basePath)) {
    return { occurrences, physicalOccurrences, pointerMembershipPaths: [], complete: true };
  }

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(basePath, { withFileTypes: true });
  } catch (error) {
    if (isSessionIntegrityError(error) || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    return { occurrences, physicalOccurrences, pointerMembershipPaths: [], complete: false };
  }

  let complete = true;
  for (const entry of entries) {
    throwIfMigrationAborted(guard.signal);
    if (!entry.isDirectory()) continue;
    const workspaceDir = join(basePath, entry.name);
    const databasePath = join(workspaceDir, 'state.vscdb');
    if (!existsSync(databasePath)) continue;
    const resolvedWorkspacePath = readWorkspaceJson(workspaceDir);
    if (!resolvedWorkspacePath) complete = false;
    const workspacePath = normalizePath(
      resolvedWorkspacePath ?? `(unresolved workspace: ${entry.name})`
    );
    let db: Awaited<ReturnType<typeof openDatabase>> | null = null;
    try {
      db = await openDatabase(databasePath, {
        sqliteDriver: guard.sqliteDriver,
        sourceReadLimits: guard.limits,
        signal: guard.signal,
      });
      const inventoryBudget = new SqliteSourceReadBudget(guard.limits, 'fatal');
      let inventory: WorkspaceComposerAddressInventory;
      try {
        inventory = loadWorkspaceComposerAddressInventory(db, inventoryBudget, guard.signal);
      } catch (error) {
        if (isMissingMigrationTableError(error, 'ItemTable')) continue;
        throw error;
      }
      const matchingMetadata = inventory.materialized.filter(({ sessionId: candidate }) =>
        sessionIdsEqual(candidate, sessionId)
      );
      for (const candidate of matchingMetadata) {
        physicalOccurrences.push({
          workspaceId: entry.name,
          workspacePath,
          databasePath,
          composerIndex: candidate.composerIndex,
          sessionId: candidate.sessionId,
        });
      }
      if (inventory.selectedIds.some((candidate) => sessionIdsEqual(candidate, sessionId))) {
        pointerMembershipPaths.add(workspacePath);
      }

      const pointerBudget = new SqliteSourceReadBudget(guard.limits, 'fatal');
      forEachBoundedComposerValue(
        db,
        'ItemTable',
        '%composerChatViewPane%',
        pointerBudget,
        (row) => {
          if (pointerReferencesSession(row.key, row.value, sessionId)) {
            pointerMembershipPaths.add(workspacePath);
          }
        },
        guard.signal
      );

      const hydrateWorkspace =
        matchingMetadata.length > 0 &&
        (!hydrationWorkspacePath || pathsEqual(workspacePath, hydrationWorkspacePath));
      if (hydrateWorkspace) {
        const result = getComposerDataBounded(
          db,
          createMigrationReadGuard(guard.limits, guard.signal, guard.sqliteDriver)
        );
        for (const metadata of matchingMetadata) {
          const composer = result?.composers[metadata.composerIndex];
          if (
            !composer?.composerId ||
            composer.composerId !== metadata.sessionId ||
            !sessionIdsEqual(composer.composerId, sessionId)
          ) {
            complete = false;
            continue;
          }
          const record = composer as Record<string, unknown>;
          occurrences.push({
            workspaceId: entry.name,
            workspacePath,
            databasePath,
            composerIndex: metadata.composerIndex,
            composer: structuredClone(record),
            fingerprint: migrationFingerprint(record),
          });
        }
      }
    } catch (error) {
      if (
        isSessionIntegrityError(error) ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw error;
      }
      complete = false;
    } finally {
      try {
        db?.close();
      } catch {
        complete = false;
      }
    }
  }
  return {
    occurrences,
    physicalOccurrences,
    pointerMembershipPaths: [...pointerMembershipPaths].sort(),
    complete,
  };
}

async function readGlobalSessionRows(
  exactSessionId: string,
  dataPath?: string,
  guard: MigrationReadGuard = createMigrationReadGuard(resolveSourceReadLimits())
): Promise<GlobalSessionRow[]> {
  throwIfMigrationAborted(guard.signal);
  const globalDbPath = join(getGlobalStoragePath(dataPath), 'state.vscdb');
  if (!existsSync(globalDbPath)) return [];
  const db = await openDatabase(globalDbPath, {
    sqliteDriver: guard.sqliteDriver,
    sourceReadLimits: guard.limits,
    signal: guard.signal,
  });
  try {
    try {
      return readGlobalSessionRowsFromDatabase(exactSessionId, db, guard);
    } catch (error) {
      if (isMissingMigrationTableError(error, 'cursorDiskKV')) return [];
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Discover exact global key spellings without reading any Composer payload value. */
async function findGlobalSessionIdSpellings(
  sessionId: string,
  dataPath?: string,
  guard: MigrationReadGuard = createMigrationReadGuard(resolveSourceReadLimits())
): Promise<string[]> {
  throwIfMigrationAborted(guard.signal);
  const globalDbPath = join(getGlobalStoragePath(dataPath), 'state.vscdb');
  if (!existsSync(globalDbPath)) return [];
  const db = await openDatabase(globalDbPath, {
    sqliteDriver: guard.sqliteDriver,
    sourceReadLimits: guard.limits,
    signal: guard.signal,
  });
  try {
    const spellings = new Set<string>();
    const budget = new SqliteSourceReadBudget(guard.limits, 'fatal');
    try {
      forEachBoundedComposerMetadata(
        db,
        'cursorDiskKV',
        'composerData:%',
        budget,
        ({ key }) => {
          const candidate = key.startsWith('composerData:')
            ? key.slice('composerData:'.length)
            : '';
          if (candidate && sessionIdsEqual(candidate, sessionId)) spellings.add(candidate);
        },
        guard.signal
      );
      forEachBoundedComposerBubbleMetadata(
        db,
        'bubbleId:%',
        budget,
        ({ key }) => {
          const candidate = key.split(':')[1] ?? '';
          if (candidate && sessionIdsEqual(candidate, sessionId)) spellings.add(candidate);
        },
        guard.signal
      );
    } catch (error) {
      if (isMissingMigrationTableError(error, 'cursorDiskKV')) return [];
      throw error;
    }
    return [...spellings].sort();
  } finally {
    db.close();
  }
}

function readGlobalSessionRowsFromDatabase(
  sessionId: string,
  db: Database,
  guard: MigrationReadGuard
): GlobalSessionRow[] {
  const rows: GlobalSessionRow[] = [];
  const budget = new SqliteSourceReadBudget(guard.limits, 'fatal');
  let afterKey = '';
  const composerKey = `composerData:${sessionId}`;
  const bubblePrefix = `bubbleId:${sessionId}:`;
  while (true) {
    throwIfMigrationAborted(guard.signal);
    const metadata = db
      .prepare(
        `SELECT key FROM cursorDiskKV WHERE (CAST(key AS BLOB) = CAST(? AS BLOB) OR (key IS NOT NULL AND substr(CAST(key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB))) AND CAST(key AS BLOB) > CAST(? AS BLOB) ORDER BY CAST(key AS BLOB) LIMIT 1`
      )
      .get(composerKey, bubblePrefix, bubblePrefix, afterKey) as { key: string } | undefined;
    if (!metadata) break;
    throwIfMigrationAborted(guard.signal);
    const value = readBoundedComposerValueByKey(
      db,
      'cursorDiskKV',
      metadata.key,
      budget,
      guard.signal
    );
    if (value === undefined) throw new MigrationTargetChangedError(sessionId);
    rows.push({ key: metadata.key, value });
    afterKey = metadata.key;
  }
  return rows;
}

function globalWorkspaceMembershipPaths(
  sessionId: string,
  rows: readonly GlobalSessionRow[]
): string[] {
  const composerRow = rows.find((row) => row.key === `composerData:${sessionId}`);
  if (!composerRow) return [];
  let composer: Record<string, unknown>;
  try {
    composer = JSON.parse(composerRow.value) as Record<string, unknown>;
  } catch {
    throw new SyntaxError(`Malformed global Composer metadata for ${sessionId}.`);
  }

  const candidates: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    let candidate = value;
    if (candidate.startsWith('file:')) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname);
      } catch {
        return;
      }
    }
    candidates.push(normalizePath(candidate));
  };
  add(composer['workspaceUri']);
  add(composer['cwd']);
  const identifier = composer['workspaceIdentifier'];
  if (identifier && typeof identifier === 'object' && !Array.isArray(identifier)) {
    const uri = (identifier as Record<string, unknown>)['uri'];
    if (uri && typeof uri === 'object' && !Array.isArray(uri)) {
      const uriRecord = uri as Record<string, unknown>;
      add(uriRecord['fsPath']);
      add(uriRecord['external']);
      add(uriRecord['path']);
    }
  }
  return [...new Set(candidates.map(normalizedPathKey))].sort();
}

function sourceFingerprint(
  target: BoundMigrationTarget,
  sourceResult: ComposerDataResult | null,
  globalRows: readonly GlobalSessionRow[]
): string {
  const record =
    target.composerLocator.composerIndex >= 0
      ? (sourceResult?.composers[target.composerLocator.composerIndex] ?? null)
      : null;
  return migrationFingerprint({
    logicalSessionId: target.logicalSessionId,
    globalSessionId: target.composerLocator.globalSessionId ?? null,
    workspaceId: target.composerLocator.workspaceId,
    workspacePath: normalizedPathKey(target.sourceWorkspacePath),
    databasePath: normalizedPathKey(target.composerLocator.databasePath),
    composerIndex: target.composerLocator.composerIndex,
    record,
    globalRows,
  });
}

/** Exact physical global-key spelling captured while the logical target is bound. */
function targetGlobalSessionId(target: BoundMigrationTarget): string {
  return target.composerLocator.globalSessionId ?? target.logicalSessionId;
}

function destinationFingerprint(result: ComposerDataResult | null): string {
  return migrationFingerprint({
    composers: result?.composers ?? [],
    rawData: result?.rawData ?? null,
    isNewFormat: result?.isNewFormat ?? null,
  });
}

function destinationDataSourceIdentity(databasePath: string): string {
  return physicalPathIdentity('destination-db', databasePath);
}

function assertPreparedDestinationIdentity(prepared: PreparedSessionMigration): void {
  if (
    destinationDataSourceIdentity(prepared.destinationDatabasePath) !==
    prepared.destinationDataSourceIdentity
  ) {
    throw new MigrationTargetChangedError(prepared.target.logicalSessionId);
  }
}

function freezeBoundMigrationTarget(target: BoundMigrationTarget): BoundMigrationTarget {
  Object.freeze(target.composerLocator);
  return Object.freeze(target);
}

function assertExactBoundOccurrence(
  target: BoundMigrationTarget,
  dataPath: string | undefined,
  sourceResult: ComposerDataResult | null,
  globalRows: readonly GlobalSessionRow[]
): Record<string, unknown> {
  const locator = target.composerLocator;
  if (
    target.dataSourceIdentity !==
      currentDataSourceIdentity(dataPath, locator.databasePath, target.storeRootPath) ||
    locator.databasePath !== locator.dbPath ||
    !sessionIdsEqual(locator.sessionId, target.logicalSessionId) ||
    !Number.isSafeInteger(locator.composerIndex) ||
    locator.composerIndex < -1
  ) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }

  const matchingIndices: number[] = [];
  sourceResult?.composers.forEach((composer, index) => {
    if (composer.composerId && sessionIdsEqual(composer.composerId, target.logicalSessionId)) {
      matchingIndices.push(index);
    }
  });

  let record: Record<string, unknown>;
  let recordFingerprint: string;
  if (locator.composerIndex === -1) {
    if (matchingIndices.length !== 0 || globalRows.length === 0) {
      throw new MigrationTargetChangedError(target.logicalSessionId);
    }
    record = { composerId: locator.sessionId };
    recordFingerprint = migrationFingerprint({
      composerId: locator.sessionId,
      globalOnly: true,
    });
  } else {
    if (matchingIndices.length !== 1 || matchingIndices[0] !== locator.composerIndex) {
      throw new MigrationTargetChangedError(target.logicalSessionId);
    }
    const candidate = sourceResult?.composers[locator.composerIndex];
    if (
      !candidate?.composerId ||
      candidate.composerId !== locator.sessionId ||
      !sessionIdsEqual(candidate.composerId, target.logicalSessionId)
    ) {
      throw new MigrationTargetChangedError(target.logicalSessionId);
    }
    record = candidate as Record<string, unknown>;
    recordFingerprint = migrationFingerprint(record);
  }

  if (
    locator.recordFingerprint !== recordFingerprint ||
    target.occurrenceFingerprint !==
      migrationFingerprint({ occurrence: recordFingerprint, globalRows })
  ) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }
  return record;
}

async function assertBoundInventoryStillExclusive(
  target: BoundMigrationTarget,
  dataPath: string | undefined,
  globalRows: readonly GlobalSessionRow[],
  guard: MigrationReadGuard
): Promise<void> {
  const storeInventory = inspectStoreSessionIdMetadataOnly(
    target.logicalSessionId,
    target.storeRootPath,
    guard.signal
  );
  if (!storeInventory.complete || storeInventory.exists) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }

  const composerInventory = await collectComposerOccurrences(
    target.logicalSessionId,
    dataPath,
    guard,
    target.sourceWorkspacePath
  );
  if (!composerInventory.complete) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }
  const expectedComposerOccurrences = target.composerLocator.composerIndex === -1 ? 0 : 1;
  if (
    composerInventory.physicalOccurrences.length !== expectedComposerOccurrences ||
    composerInventory.occurrences.length !== expectedComposerOccurrences
  ) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }
  if (expectedComposerOccurrences === 1) {
    const [occurrence] = composerInventory.occurrences;
    if (
      !occurrence ||
      occurrence.databasePath !== target.composerLocator.databasePath ||
      occurrence.workspaceId !== target.composerLocator.workspaceId ||
      occurrence.composerIndex !== target.composerLocator.composerIndex ||
      occurrence.fingerprint !== target.composerLocator.recordFingerprint
    ) {
      throw new MigrationTargetChangedError(target.logicalSessionId);
    }
  }

  const membershipPaths = new Set([
    ...composerInventory.occurrences.map((occurrence) =>
      normalizedPathKey(occurrence.workspacePath)
    ),
    ...composerInventory.pointerMembershipPaths.map(normalizedPathKey),
    ...(target.composerLocator.globalSessionId
      ? globalWorkspaceMembershipPaths(target.composerLocator.globalSessionId, globalRows)
      : []),
  ]);
  if (
    membershipPaths.size !== 1 ||
    !membershipPaths.has(normalizedPathKey(target.sourceWorkspacePath))
  ) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }

  const globalSpellings = await findGlobalSessionIdSpellings(
    target.logicalSessionId,
    dataPath,
    guard
  );
  const expectedGlobalSpellings = target.composerLocator.globalSessionId
    ? [target.composerLocator.globalSessionId]
    : [];
  if (
    globalSpellings.length !== expectedGlobalSpellings.length ||
    globalSpellings.some((value, index) => value !== expectedGlobalSpellings[index])
  ) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }
}

/**
 * Check the Store stack's addressing metadata without opening a transcript,
 * meta.json, or store.db payload. Copy IDs share one logical UUID namespace
 * across Composer and Store, so a Store-only occurrence is a real collision.
 */
interface StoreMetadataInventoryResult {
  readonly exists: boolean;
  readonly complete: boolean;
}

function inspectStoreSessionIdMetadataOnly(
  sessionId: string,
  storeRoot: string,
  signal?: AbortSignal
): StoreMetadataInventoryResult {
  throwIfMigrationAborted(signal);

  try {
    const chats = join(storeRoot, 'chats');
    if (existsSync(chats)) {
      const compactSessionId = isNativeCursorUuid(sessionId)
        ? sessionId.replaceAll('-', '').toLowerCase()
        : undefined;
      for (const hash of readdirSync(chats, { withFileTypes: true })) {
        throwIfMigrationAborted(signal);
        if (!hash.isDirectory()) continue;
        const hashPath = join(chats, hash.name);
        if (
          compactSessionId !== undefined &&
          /^[0-9a-f]{32}$/iu.test(hash.name) &&
          hash.name.toLowerCase() === compactSessionId &&
          existsSync(join(hashPath, 'store.db'))
        ) {
          return { exists: true, complete: true };
        }
        const sessionEntries = readdirSync(hashPath, { withFileTypes: true });
        if (
          sessionEntries.some(
            (entry) => entry.isDirectory() && sessionIdsEqual(entry.name, sessionId)
          )
        ) {
          return { exists: true, complete: true };
        }
      }
    }

    const acp = join(storeRoot, 'acp-sessions');
    if (existsSync(acp)) {
      const sessionEntries = readdirSync(acp, { withFileTypes: true });
      if (
        sessionEntries.some(
          (entry) => entry.isDirectory() && sessionIdsEqual(entry.name, sessionId)
        )
      ) {
        return { exists: true, complete: true };
      }
    }

    const projects = join(storeRoot, 'projects');
    if (existsSync(projects)) {
      for (const project of readdirSync(projects, { withFileTypes: true })) {
        throwIfMigrationAborted(signal);
        if (!project.isDirectory()) continue;
        const transcripts = join(projects, project.name, 'agent-transcripts');
        if (!existsSync(transcripts)) continue;
        const transcriptEntries = readdirSync(transcripts, { withFileTypes: true });
        const direct = transcriptEntries.some(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.jsonl') &&
            sessionIdsEqual(entry.name.slice(0, -'.jsonl'.length), sessionId)
        );
        const nested = transcriptEntries.some(
          (entry) => entry.isDirectory() && sessionIdsEqual(entry.name, sessionId)
        );
        if (direct || nested) {
          return { exists: true, complete: true };
        }
      }
    }
    return { exists: false, complete: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { exists: false, complete: false };
  }
}

async function sessionIdExistsForCopy(
  sessionId: string,
  sourceResult: ComposerDataResult | null,
  destinationResult: ComposerDataResult | null,
  dataPath: string | undefined,
  guard: MigrationReadGuard,
  storeRootPath: string,
  owningSessionId: string
): Promise<boolean> {
  throwIfMigrationAborted(guard.signal);
  const storeInventory = inspectStoreSessionIdMetadataOnly(sessionId, storeRootPath, guard.signal);
  if (!storeInventory.complete) {
    throw new UnsupportedSessionMigrationError(owningSessionId, 'incomplete-store-inventory');
  }
  if (storeInventory.exists) return true;
  if (
    sourceResult?.composers.some(
      (composer) => composer.composerId && sessionIdsEqual(composer.composerId, sessionId)
    ) ||
    destinationResult?.composers.some(
      (composer) => composer.composerId && sessionIdsEqual(composer.composerId, sessionId)
    )
  ) {
    return true;
  }
  const composerInventory = await collectComposerOccurrences(sessionId, dataPath, guard);
  if (!composerInventory.complete) {
    throw new UnsupportedSessionMigrationError(owningSessionId, 'incomplete-composer-inventory');
  }
  if (composerInventory.physicalOccurrences.length > 0) {
    return true;
  }
  return (await findGlobalSessionIdSpellings(sessionId, dataPath, guard)).length > 0;
}

async function allocateUniqueCopySessionId(
  sourceResult: ComposerDataResult | null,
  destinationResult: ComposerDataResult | null,
  dataPath: string | undefined,
  guard: MigrationReadGuard,
  storeRootPath: string,
  owningSessionId: string,
  uuidFactory: () => string = generateSessionId
): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt++) {
    throwIfMigrationAborted(guard.signal);
    const candidate = uuidFactory();
    if (
      !(await sessionIdExistsForCopy(
        candidate,
        sourceResult,
        destinationResult,
        dataPath,
        guard,
        storeRootPath,
        owningSessionId
      ))
    ) {
      return candidate;
    }
  }
  throw new MigrationTargetChangedError('copy-session-id');
}

function opaqueOccurrenceRefs(occurrences: readonly ComposerOccurrence[]): string[] {
  return occurrences
    .map((occurrence) => `occurrence:${occurrence.fingerprint.slice(0, 24)}`)
    .sort();
}

/** Bind selectors once against the same immutable scope that produced their indices. */
export async function bindMigrationTargets(
  selectors: readonly (number | string)[],
  options: MigrationBindingOptions,
  context?: SessionReadContext
): Promise<BoundMigrationTarget[]> {
  const contextOptions = contextMigrationOptions(context);
  const dataPath = options.dataPath ?? contextOptions.dataPath;
  const signal = options.signal ?? contextOptions.signal;
  const sourceReadLimitsOverride = options.sourceReadLimits ?? contextOptions.sourceReadLimits;
  // Policy validation and cancellation are intentionally the first operations
  // that can fail. Workspace resolution itself is workspace.json-only.
  const sourceReadLimits = resolveSourceReadLimits(sourceReadLimitsOverride);
  throwIfMigrationAborted(signal);
  const storeRootPath = normalizePath(options.storeRootPath ?? getStoreStackRoot(dataPath));
  const selectedDriver = await selectDatabaseDriver({
    operation: 'migrate',
    required: new Set(['readWrite']),
    ...((options.sqliteDriver ?? contextOptions.sqliteDriver)
      ? { forcedDriver: options.sqliteDriver ?? contextOptions.sqliteDriver }
      : {}),
  });
  const sqliteDriver = selectedDriver.name as DriverName;
  const readGuard = createMigrationReadGuard(sourceReadLimits, signal, sqliteDriver);
  const workspacePath = await resolveMigrationWorkspacePath(
    options.workspacePath ?? contextOptions.workspacePath,
    dataPath,
    readGuard
  );
  throwIfMigrationAborted(signal);

  // Never reuse a caller context whose cache/options may have been created
  // under a different operation. Capture one provider, signal, and branded
  // effective limits map for every nested catalog read performed by binding.
  const operationContext = createSessionReadContext({
    dataPath,
    workspacePath,
    sqliteDriver,
    sourceReadLimits,
    signal,
  });
  let summariesPromise: Promise<ChatSessionSummary[]> | undefined;
  const scopedSummaries = (): Promise<ChatSessionSummary[]> => {
    summariesPromise ??= listSessions(
      { limit: 0, all: true, workspacePath },
      dataPath,
      undefined,
      operationContext
    );
    return summariesPromise;
  };
  const logicalCatalog = async () => {
    await scopedSummaries();
    return operationContext.logicalSummaries ?? [];
  };
  const ambiguityOccurrenceRefs = async (sessionId: string): Promise<string[] | undefined> => {
    const row = (await logicalCatalog()).find(
      (candidate) =>
        sessionIdsEqual(candidate.id, sessionId) && candidate.resolutionState === 'ambiguous'
    );
    return row?.resolutionState === 'ambiguous' ? [...row.diagnosticOccurrenceRefs] : undefined;
  };
  const numericBase = options.numericBase ?? 1;
  const targets: BoundMigrationTarget[] = [];

  try {
    for (const selector of selectors) {
      throwIfMigrationAborted(signal);
      if (typeof selector === 'string' && selector.startsWith('occurrence:')) {
        throw new UnsupportedSessionMigrationError(selector, 'diagnostic-occurrence-reference');
      }
      const numeric =
        typeof selector === 'number' ||
        (!options.treatStringSelectorsAsIds && /^\d+$/.test(String(selector)))
          ? Number(selector)
          : undefined;
      let sessionId: string;
      if (numeric === undefined) {
        const requestedId = String(selector);
        const logicalRow = (await logicalCatalog()).find((candidate) =>
          sessionIdsEqual(candidate.id, requestedId)
        );
        if (logicalRow?.resolutionState === 'ambiguous') {
          throw new SessionAmbiguityError(logicalRow.id, logicalRow.diagnosticOccurrenceRefs);
        }
        if (workspacePath && !logicalRow) {
          throw new SessionScopeMismatchError(requestedId, workspacePath);
        }
        sessionId = logicalRow?.id ?? requestedId;
      } else {
        const summary = (await logicalCatalog()).find(
          (candidate) => candidate.index === numeric + (numericBase === 0 ? 1 : 0)
        );
        if (!summary) throw new SessionNotFoundError(selector);
        if (summary.resolutionState === 'ambiguous') {
          throw new SessionAmbiguityError(summary.id, summary.diagnosticOccurrenceRefs);
        }
        sessionId = summary.id;
      }

      const composerInventory = await collectComposerOccurrences(
        sessionId,
        dataPath,
        readGuard,
        workspacePath
      );
      if (!composerInventory.complete) {
        throw new UnsupportedSessionMigrationError(sessionId, 'incomplete-composer-inventory');
      }
      const occurrences = [...composerInventory.occurrences];
      const globalSpellings = await findGlobalSessionIdSpellings(sessionId, dataPath, readGuard);
      if (globalSpellings.length > 1) {
        throw new UnsupportedSessionMigrationError(sessionId, 'multiple-composer-occurrences');
      }
      const globalSessionId = globalSpellings[0];
      const globalRows = globalSessionId
        ? await readGlobalSessionRows(globalSessionId, dataPath, readGuard)
        : [];
      const membershipPaths = new Set([
        ...composerInventory.physicalOccurrences.map((occurrence) =>
          normalizedPathKey(occurrence.workspacePath)
        ),
        ...composerInventory.pointerMembershipPaths.map(normalizedPathKey),
        ...(globalSessionId ? globalWorkspaceMembershipPaths(globalSessionId, globalRows) : []),
      ]);

      const fallbackSource =
        membershipPaths.size === 1
          ? await findMigrationWorkspaceByPath([...membershipPaths][0]!, dataPath, readGuard)
          : undefined;

      const storeInventory = inspectStoreSessionIdMetadataOnly(sessionId, storeRootPath, signal);
      if (!storeInventory.complete) {
        throw new UnsupportedSessionMigrationError(sessionId, 'incomplete-store-inventory');
      }
      if (storeInventory.exists && (occurrences.length > 0 || globalRows.length > 0)) {
        const occurrenceRefs = await ambiguityOccurrenceRefs(sessionId);
        if (occurrenceRefs) throw new SessionAmbiguityError(sessionId, occurrenceRefs);
        throw new UnsupportedSessionMigrationError(sessionId, 'merged');
      }
      if (storeInventory.exists) {
        const occurrenceRefs = await ambiguityOccurrenceRefs(sessionId);
        if (occurrenceRefs) throw new SessionAmbiguityError(sessionId, occurrenceRefs);
        throw new UnsupportedSessionMigrationError(sessionId, 'store-only');
      }

      if (membershipPaths.size > 1) {
        throw new UnsupportedSessionMigrationError(sessionId, 'shared-membership');
      }
      if (composerInventory.physicalOccurrences.length > 1) {
        const fingerprints = new Set(occurrences.map((occurrence) => occurrence.fingerprint));
        if (
          occurrences.length === composerInventory.physicalOccurrences.length &&
          fingerprints.size > 1
        ) {
          throw new SessionAmbiguityError(
            sessionId,
            (await ambiguityOccurrenceRefs(sessionId)) ?? opaqueOccurrenceRefs(occurrences)
          );
        }
        throw new UnsupportedSessionMigrationError(sessionId, 'multiple-composer-occurrences');
      }

      let occurrence = occurrences[0];
      if (!occurrence) {
        if (globalRows.length === 0) {
          throw new SessionNotFoundError(sessionId);
        }
        if (!fallbackSource) {
          throw new UnsupportedSessionMigrationError(sessionId, 'unbound-global-occurrence');
        }
        membershipPaths.add(normalizedPathKey(fallbackSource.workspace.path));
        occurrence = {
          workspaceId: fallbackSource.workspace.id,
          workspacePath: normalizePath(fallbackSource.workspace.path),
          databasePath: fallbackSource.dbPath,
          composerIndex: -1,
          composer: { composerId: sessionId },
          fingerprint: migrationFingerprint({ composerId: sessionId, globalOnly: true }),
        };
      }

      if (workspacePath && !pathsEqual(occurrence.workspacePath, workspacePath)) {
        throw new SessionScopeMismatchError(sessionId, workspacePath);
      }

      const composerLocator = Object.freeze({
        workspaceId: occurrence.workspaceId,
        databasePath: occurrence.databasePath,
        dbPath: occurrence.databasePath,
        sessionId:
          typeof occurrence.composer['composerId'] === 'string'
            ? occurrence.composer['composerId']
            : sessionId,
        ...(globalSessionId ? { globalSessionId } : {}),
        composerIndex: occurrence.composerIndex,
        recordFingerprint: occurrence.fingerprint,
      });

      const target: BoundMigrationTarget = {
        logicalSessionId: sessionId,
        composerLocator,
        sourceWorkspacePath: normalizePath(occurrence.workspacePath),
        sqliteDriver,
        storeRootPath,
        dataSourceIdentity: currentDataSourceIdentity(
          dataPath,
          occurrence.databasePath,
          storeRootPath
        ),
        occurrenceFingerprint: migrationFingerprint({
          occurrence: occurrence.fingerprint,
          globalRows,
        }),
        eligibility: 'eligible-composer',
        dataPath,
        sourceReadLimits,
        signal,
      };
      targets.push(freezeBoundMigrationTarget(target));
    }

    return targets;
  } finally {
    await operationContext.dispose();
  }
}

/** Resolve destination/capability/source state and freeze it before preview or application. */
export async function prepareSessionMigration(
  target: BoundMigrationTarget,
  destination: string,
  options: MigrationOptions
): Promise<PreparedSessionMigration> {
  const dataPath = options.dataPath ?? target.dataPath;
  const signal = options.signal ?? target.signal;
  const sourceReadLimits = options.sourceReadLimits
    ? resolveSourceReadLimits(options.sourceReadLimits)
    : (target.sourceReadLimits ?? resolveSourceReadLimits());
  const readGuard = createMigrationReadGuard(sourceReadLimits, signal, target.sqliteDriver);
  const frozenTarget = freezeBoundMigrationTarget(target);
  throwIfMigrationAborted(signal);
  if (frozenTarget.eligibility !== 'eligible-composer') {
    throw new UnsupportedSessionMigrationError(
      frozenTarget.logicalSessionId,
      frozenTarget.eligibility
    );
  }
  const normalizedDest = normalizePath(destination);
  if (pathsEqual(frozenTarget.sourceWorkspacePath, normalizedDest)) {
    throw new SameWorkspaceError(normalizedDest);
  }
  if (isNestedPath(frozenTarget.sourceWorkspacePath, normalizedDest)) {
    throw new NestedPathError(frozenTarget.sourceWorkspacePath, normalizedDest);
  }

  await ensureDriver({
    operation: 'migrate',
    required: new Set(['readWrite']),
    forcedDriver: frozenTarget.sqliteDriver,
  });
  const destinationInfo = await findMigrationWorkspaceByPath(normalizedDest, dataPath, readGuard);
  if (!destinationInfo) throw new WorkspaceNotFoundError(normalizedDest);

  const sourceDb = await openDatabaseReadWrite(frozenTarget.composerLocator.databasePath, {
    sqliteDriver: frozenTarget.sqliteDriver,
    signal,
  });
  let destinationDb: Awaited<ReturnType<typeof openDatabaseReadWrite>> | null = null;
  try {
    destinationDb = await openDatabaseReadWrite(destinationInfo.dbPath, {
      sqliteDriver: frozenTarget.sqliteDriver,
      signal,
    });
    const sourceResult = getComposerDataBounded(sourceDb, readGuard);
    const destinationResult = getComposerDataBounded(destinationDb, readGuard);
    const destinationSessionCount = destinationResult?.composers.length ?? 0;
    if (!options.force && destinationSessionCount > 0) {
      throw new DestinationHasSessionsError(normalizedDest, destinationSessionCount);
    }
    const globalRows = await readGlobalSessionRows(
      targetGlobalSessionId(frozenTarget),
      dataPath,
      readGuard
    );
    await assertBoundInventoryStillExclusive(frozenTarget, dataPath, globalRows, readGuard);
    assertExactBoundOccurrence(frozenTarget, dataPath, sourceResult, globalRows);
    const proposedCopySessionId =
      options.mode === 'copy'
        ? await allocateUniqueCopySessionId(
            sourceResult,
            destinationResult,
            dataPath,
            readGuard,
            frozenTarget.storeRootPath,
            frozenTarget.logicalSessionId,
            options.uuidFactory
          )
        : undefined;

    const prepared: PreparedSessionMigration = {
      target: frozenTarget,
      destinationWorkspacePath: normalizedDest,
      destinationWorkspaceId: destinationInfo.workspace?.id,
      destinationDatabasePath: destinationInfo.dbPath,
      destinationDataSourceIdentity: destinationDataSourceIdentity(destinationInfo.dbPath),
      mode: options.mode,
      sourceFingerprint: sourceFingerprint(frozenTarget, sourceResult, globalRows),
      destinationFingerprint: destinationFingerprint(destinationResult),
      proposedCopySessionId,
      dataPath,
      debug: options.debug ?? false,
      sourceReadLimits,
      signal,
    };
    return Object.freeze(prepared);
  } finally {
    sourceDb.close();
    destinationDb?.close();
  }
}

interface StagedGlobalMutation {
  readonly mode: MigrationMode;
  readonly sessionId: string;
  readonly databasePath: string;
  readonly rows: readonly GlobalSessionRow[];
}

function hydrateComposerFromGlobalRows(
  composer: Record<string, unknown>,
  exactGlobalSessionId: string,
  outputSessionId: string,
  rows: readonly GlobalSessionRow[]
): Record<string, unknown> {
  const row = rows.find((candidate) => candidate.key === `composerData:${exactGlobalSessionId}`);
  if (!row) return composer;
  const globalComposer = JSON.parse(row.value) as {
    name?: string;
    createdAt?: number | string;
    updatedAt?: number | string;
    lastUpdatedAt?: number | string;
    unifiedMode?: string;
  };
  const lastUpdatedAt = globalComposer.lastUpdatedAt ?? globalComposer.updatedAt;
  return {
    ...composer,
    composerId: outputSessionId,
    ...(typeof globalComposer.name === 'string' ? { name: globalComposer.name } : {}),
    ...(globalComposer.createdAt !== undefined && globalComposer.createdAt !== null
      ? { createdAt: globalComposer.createdAt }
      : {}),
    ...(lastUpdatedAt !== undefined && lastUpdatedAt !== null ? { lastUpdatedAt } : {}),
    ...(typeof globalComposer.unifiedMode === 'string'
      ? { unifiedMode: globalComposer.unifiedMode }
      : {}),
  };
}

function stageMoveGlobalMutation(
  composerId: string,
  rows: readonly GlobalSessionRow[],
  sourceWorkspace: string,
  destinationWorkspace: string,
  destinationWorkspaceId: string | undefined,
  debug: boolean,
  dataPath: string | undefined,
  signal?: AbortSignal
): StagedGlobalMutation {
  const sourcePrefix = normalizePath(sourceWorkspace).replace(/\/+$/, '');
  const destinationPrefix = normalizePath(destinationWorkspace).replace(/\/+$/, '');
  const stagedRows = rows.map((row): GlobalSessionRow => {
    throwIfMigrationAborted(signal);
    if (row.key === `composerData:${composerId}`) {
      const composerData = JSON.parse(row.value) as Record<string, unknown>;
      updateComposerWorkspaceMetadata(composerData, destinationWorkspace, destinationWorkspaceId);
      return { key: row.key, value: JSON.stringify(composerData) };
    }
    if (row.key.startsWith(`bubbleId:${composerId}:`)) {
      const bubbleData = JSON.parse(row.value) as Record<string, unknown>;
      const bubbleId = typeof bubbleData['bubbleId'] === 'string' ? bubbleData['bubbleId'] : null;
      if (debug && bubbleId) console.error(`[DEBUG] Processing bubble: ${bubbleId}`);
      transformBubblePaths(bubbleData, sourcePrefix, destinationPrefix, debug);
      return { key: row.key, value: JSON.stringify(bubbleData) };
    }
    return { ...row };
  });
  return {
    mode: 'move',
    sessionId: composerId,
    databasePath: join(getGlobalStoragePath(dataPath), 'state.vscdb'),
    rows: stagedRows,
  };
}

function stageCopyGlobalMutation(
  sourceComposerId: string,
  copyComposerId: string,
  rows: readonly GlobalSessionRow[],
  sourceWorkspace: string,
  destinationWorkspace: string,
  destinationWorkspaceId: string | undefined,
  debug: boolean,
  dataPath: string | undefined,
  signal?: AbortSignal
): StagedGlobalMutation {
  const sourcePrefix = normalizePath(sourceWorkspace).replace(/\/+$/, '');
  const destinationPrefix = normalizePath(destinationWorkspace).replace(/\/+$/, '');
  const bubbleIdMap = new Map<string, string>();
  const composerRow = rows.find((row) => row.key === `composerData:${sourceComposerId}`);
  let stagedComposerRow: GlobalSessionRow | undefined;

  if (composerRow) {
    throwIfMigrationAborted(signal);
    const composerData = JSON.parse(composerRow.value) as Record<string, unknown>;
    composerData['composerId'] = copyComposerId;
    updateComposerWorkspaceMetadata(composerData, destinationWorkspace, destinationWorkspaceId);
    const headers = Array.isArray(composerData['fullConversationHeadersOnly'])
      ? (composerData['fullConversationHeadersOnly'] as Array<Record<string, unknown>>)
      : [];
    composerData['fullConversationHeadersOnly'] = headers.flatMap((header) => {
      const oldBubbleId = header['bubbleId'];
      if (typeof oldBubbleId !== 'string' || oldBubbleId.length === 0) return [];
      const newBubbleId = generateSessionId();
      bubbleIdMap.set(oldBubbleId, newBubbleId);
      return [{ ...header, bubbleId: newBubbleId }];
    });
    stagedComposerRow = {
      key: `composerData:${copyComposerId}`,
      value: JSON.stringify(composerData),
    };
  }

  const stagedBubbleRows: GlobalSessionRow[] = [];
  for (const row of rows) {
    throwIfMigrationAborted(signal);
    if (!row.key.startsWith(`bubbleId:${sourceComposerId}:`)) continue;
    const oldBubbleId = row.key.slice(`bubbleId:${sourceComposerId}:`.length);
    if (!oldBubbleId) continue;
    const newBubbleId = bubbleIdMap.get(oldBubbleId) ?? generateSessionId();
    bubbleIdMap.set(oldBubbleId, newBubbleId);
    const bubbleData = JSON.parse(row.value) as Record<string, unknown>;
    bubbleData['bubbleId'] = newBubbleId;
    if (debug) console.error(`[DEBUG] Processing bubble: ${oldBubbleId} -> ${newBubbleId}`);
    transformBubblePaths(bubbleData, sourcePrefix, destinationPrefix, debug);
    stagedBubbleRows.push({
      key: `bubbleId:${copyComposerId}:${newBubbleId}`,
      value: JSON.stringify(bubbleData),
    });
  }

  return {
    mode: 'copy',
    sessionId: copyComposerId,
    databasePath: join(getGlobalStoragePath(dataPath), 'state.vscdb'),
    rows: [...(stagedComposerRow ? [stagedComposerRow] : []), ...stagedBubbleRows],
  };
}

/** Apply an already-decoded mutation inside the caller's locked transaction. */
function applyStagedGlobalMutation(
  db: Database,
  mutation: StagedGlobalMutation,
  expectedRows: readonly GlobalSessionRow[]
): void {
  if (mutation.rows.length === 0) return;
  if (mutation.mode === 'copy') {
    const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const row of mutation.rows) {
      const result = insert.run(row.key, row.value);
      if (result.changes !== 1) throw new MigrationTargetChangedError(mutation.sessionId);
    }
    return;
  }

  const expectedByKey = new Map(expectedRows.map((row) => [row.key, row.value] as const));
  if (expectedByKey.size !== mutation.rows.length) {
    throw new MigrationTargetChangedError(mutation.sessionId);
  }
  const update = db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ? AND value = ?');
  for (const row of mutation.rows) {
    const expectedValue = expectedByKey.get(row.key);
    if (expectedValue === undefined) throw new MigrationTargetChangedError(mutation.sessionId);
    const result = update.run(row.value, row.key, expectedValue);
    if (result.changes !== 1) throw new MigrationTargetChangedError(mutation.sessionId);
  }
}

interface CompensationAction {
  readonly label: string;
  readonly restore: () => void | Promise<void>;
}

async function rethrowAfterCompensation(
  originalError: unknown,
  actions: readonly CompensationAction[]
): Promise<never> {
  const failures: Error[] = [];
  for (const action of actions) {
    try {
      await action.restore();
    } catch (error) {
      failures.push(
        new Error(`Migration compensation failed for ${action.label}.`, { cause: error })
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [originalError, ...failures],
      `Migration failed and ${String(failures.length)} compensation action(s) also failed.`,
      { cause: originalError }
    );
  }
  throw originalError;
}

async function snapshotGlobalSessionRows(
  sessionId: string,
  dataPath?: string,
  guard: MigrationReadGuard = createMigrationReadGuard(resolveSourceReadLimits())
): Promise<GlobalSessionRow[]> {
  return (await readGlobalSessionRows(sessionId, dataPath, guard)).map((row) => ({ ...row }));
}

async function restoreGlobalSessionRows(
  sessionId: string,
  rows: readonly GlobalSessionRow[],
  dataPath: string | undefined,
  sqliteDriver: DriverName
): Promise<void> {
  const globalDbPath = join(getGlobalStoragePath(dataPath), 'state.vscdb');
  if (!existsSync(globalDbPath)) return;
  const db = await openDatabaseReadWrite(globalDbPath, { sqliteDriver });
  try {
    db.runSQL('BEGIN IMMEDIATE');
    const composerKey = `composerData:${sessionId}`;
    const bubblePrefix = `bubbleId:${sessionId}:`;
    db.prepare(
      'DELETE FROM cursorDiskKV WHERE CAST(key AS BLOB) = CAST(? AS BLOB) OR (key IS NOT NULL AND substr(CAST(key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB))'
    ).run(composerKey, bubblePrefix, bubblePrefix);
    const insert = db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const row of rows) insert.run(row.key, row.value);
    db.runSQL('COMMIT');
  } catch (error) {
    try {
      db.runSQL('ROLLBACK');
    } catch {
      // The original restore failure remains authoritative.
    }
    throw error;
  } finally {
    db.close();
  }
}

interface WorkspaceComposerRowSnapshot {
  readonly databasePath: string;
  readonly sqliteDriver?: DriverName;
  readonly value?: string;
}

function snapshotWorkspaceComposerRowFromDatabase(
  databasePath: string,
  db: Database,
  guard: MigrationReadGuard
): WorkspaceComposerRowSnapshot {
  throwIfMigrationAborted(guard.signal);
  const budget = new SqliteSourceReadBudget(guard.limits, 'fatal');
  const value = readBoundedComposerValueByKey(
    db,
    'ItemTable',
    'composer.composerData',
    budget,
    guard.signal
  );
  return Object.freeze({
    databasePath,
    sqliteDriver: guard.sqliteDriver,
    ...(value === undefined ? {} : { value }),
  });
}

async function snapshotWorkspaceComposerRow(
  databasePath: string,
  guard: MigrationReadGuard
): Promise<WorkspaceComposerRowSnapshot> {
  throwIfMigrationAborted(guard.signal);
  const db = await openDatabaseReadWrite(databasePath, {
    sqliteDriver: guard.sqliteDriver,
    signal: guard.signal,
  });
  try {
    return snapshotWorkspaceComposerRowFromDatabase(databasePath, db, guard);
  } finally {
    db.close();
  }
}

function serializeComposerDataForMigration(
  composers: Array<{ composerId?: string; [key: string]: unknown }>,
  isNewFormat: boolean,
  originalRawData?: unknown
): string {
  let serialized: string | undefined;
  const captureDatabase: Database = {
    prepare() {
      return {
        get: () => undefined,
        all: () => [],
        run: (...params: unknown[]) => {
          serialized = typeof params[0] === 'string' ? params[0] : undefined;
          return { changes: 1, lastInsertRowid: 0 };
        },
      };
    },
    runSQL() {},
    close() {},
  };
  updateComposerData(captureDatabase, composers, isNewFormat, originalRawData);
  if (serialized === undefined) {
    throw new Error('Failed to serialize Composer workspace state.');
  }
  return serialized;
}

function compareAndSwapComposerData(
  db: Database,
  expectedValue: string | undefined,
  nextValue: string,
  sessionId: string
): void {
  const result =
    expectedValue === undefined
      ? db
          .prepare(
            'INSERT INTO ItemTable (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = ?)'
          )
          .run('composer.composerData', nextValue, 'composer.composerData')
      : db
          .prepare('UPDATE ItemTable SET value = ? WHERE key = ? AND value = ?')
          .run(nextValue, 'composer.composerData', expectedValue);
  if (result.changes !== 1) throw new MigrationTargetChangedError(sessionId);
}

interface MigrationTransactionState {
  readonly orderedPaths: readonly string[];
  readonly databases: ReadonlyMap<string, Database>;
  readonly activePaths: Set<string>;
  readonly committedPaths: Set<string>;
}

function beginMigrationTransactions(
  databases: ReadonlyMap<string, Database>
): MigrationTransactionState {
  const orderedPaths = [...databases.keys()].sort((left, right) =>
    normalizedPathKey(left).localeCompare(normalizedPathKey(right))
  );
  const state: MigrationTransactionState = {
    orderedPaths,
    databases,
    activePaths: new Set<string>(),
    committedPaths: new Set<string>(),
  };
  try {
    for (const databasePath of orderedPaths) {
      databases.get(databasePath)!.runSQL('BEGIN IMMEDIATE');
      state.activePaths.add(databasePath);
    }
    return state;
  } catch (error) {
    rollbackMigrationTransactions(state);
    throw error;
  }
}

function rollbackMigrationTransactions(state: MigrationTransactionState): void {
  for (const databasePath of [...state.orderedPaths].reverse()) {
    if (!state.activePaths.has(databasePath)) continue;
    try {
      state.databases.get(databasePath)?.runSQL('ROLLBACK');
    } catch {
      // The original operation failure remains authoritative.
    } finally {
      state.activePaths.delete(databasePath);
    }
  }
}

function commitMigrationTransactions(state: MigrationTransactionState): void {
  for (const databasePath of state.orderedPaths) {
    if (!state.activePaths.has(databasePath)) continue;
    // A provider can surface an acknowledgement error after SQLite has
    // already committed. Mark the path conservatively before the attempt so
    // callers always compensate an indeterminate commit outcome.
    state.committedPaths.add(databasePath);
    try {
      state.databases.get(databasePath)!.runSQL('COMMIT');
    } finally {
      state.activePaths.delete(databasePath);
    }
  }
}

function assertMigrationPhysicalIdentity(prepared: PreparedSessionMigration): void {
  assertPreparedDestinationIdentity(prepared);
  if (
    prepared.target.dataSourceIdentity !==
    currentDataSourceIdentity(
      prepared.dataPath,
      prepared.target.composerLocator.databasePath,
      prepared.target.storeRootPath
    )
  ) {
    throw new MigrationTargetChangedError(prepared.target.logicalSessionId);
  }
}

function assertStoreStillAbsent(target: BoundMigrationTarget): void {
  // Store metadata is ordinary filesystem state and Cursor does not honor a
  // cursor-history lock. This is therefore a best-effort boundary check: drift
  // observed before return is compensated; a Store write after return belongs
  // to a later external operation and cannot be serialized by this process.
  const inventory = inspectStoreSessionIdMetadataOnly(
    target.logicalSessionId,
    target.storeRootPath,
    target.signal
  );
  if (!inventory.complete || inventory.exists) {
    throw new MigrationTargetChangedError(target.logicalSessionId);
  }
}

async function restoreWorkspaceComposerRow(snapshot: WorkspaceComposerRowSnapshot): Promise<void> {
  const db = await openDatabaseReadWrite(snapshot.databasePath, {
    sqliteDriver: snapshot.sqliteDriver,
  });
  try {
    if (snapshot.value === undefined) {
      db.prepare("DELETE FROM ItemTable WHERE key = 'composer.composerData'").run();
    } else {
      db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
        'composer.composerData',
        snapshot.value
      );
    }
  } finally {
    db.close();
  }
}

async function revalidatePreparedMigration(
  prepared: PreparedSessionMigration,
  expectedDestinationFingerprint = prepared.destinationFingerprint
): Promise<void> {
  const guard = createMigrationReadGuard(
    prepared.sourceReadLimits,
    prepared.signal,
    prepared.target.sqliteDriver
  );
  throwIfMigrationAborted(prepared.signal);
  assertPreparedDestinationIdentity(prepared);
  const sourceDb = await openDatabaseReadWrite(prepared.target.composerLocator.databasePath, {
    sqliteDriver: prepared.target.sqliteDriver,
    signal: prepared.signal,
  });
  let destinationDb: Awaited<ReturnType<typeof openDatabaseReadWrite>> | null = null;
  try {
    destinationDb = await openDatabaseReadWrite(prepared.destinationDatabasePath, {
      sqliteDriver: prepared.target.sqliteDriver,
      signal: prepared.signal,
    });
    const sourceResult = getComposerDataBounded(sourceDb, guard);
    const destinationResult = getComposerDataBounded(destinationDb, guard);
    const globalRows = await readGlobalSessionRows(
      targetGlobalSessionId(prepared.target),
      prepared.dataPath,
      guard
    );
    await assertBoundInventoryStillExclusive(prepared.target, prepared.dataPath, globalRows, guard);
    assertExactBoundOccurrence(prepared.target, prepared.dataPath, sourceResult, globalRows);
    if (
      sourceFingerprint(prepared.target, sourceResult, globalRows) !== prepared.sourceFingerprint ||
      destinationFingerprint(destinationResult) !== expectedDestinationFingerprint
    ) {
      throw new MigrationTargetChangedError(prepared.target.logicalSessionId);
    }
    if (
      prepared.proposedCopySessionId &&
      (await sessionIdExistsForCopy(
        prepared.proposedCopySessionId,
        sourceResult,
        destinationResult,
        prepared.dataPath,
        guard,
        prepared.target.storeRootPath,
        prepared.target.logicalSessionId
      ))
    ) {
      throw new MigrationTargetChangedError(prepared.target.logicalSessionId);
    }
  } finally {
    sourceDb.close();
    destinationDb?.close();
  }
}

async function applyPreparedMigrationBatch(
  prepared: readonly PreparedSessionMigration[]
): Promise<SessionMigrationResult[]> {
  if (prepared.length === 0) return [];
  const first = prepared[0]!;
  if (
    prepared.some(
      (item) =>
        item.target.sqliteDriver !== first.target.sqliteDriver ||
        item.sourceReadLimits !== first.sourceReadLimits ||
        item.signal !== first.signal ||
        item.dataPath !== first.dataPath ||
        item.target.storeRootPath !== first.target.storeRootPath
    )
  ) {
    throw new MigrationTargetChangedError(first.target.logicalSessionId);
  }
  await ensureDriver({
    operation: 'migrate',
    required: new Set(['readWrite']),
    forcedDriver: first.target.sqliteDriver,
  });

  const copyIds = prepared
    .map((item) => item.proposedCopySessionId)
    .filter((value): value is string => value !== undefined);
  if (new Set(copyIds).size !== copyIds.length) {
    throw new MigrationTargetChangedError(prepared[0]!.target.logicalSessionId);
  }

  // Every precondition is checked against the common pre-write state before
  // any member of the batch is allowed to mutate a database.
  for (const item of prepared) await revalidatePreparedMigration(item);

  const databasePaths = [
    ...new Set(
      prepared.flatMap((item) => [
        item.target.composerLocator.databasePath,
        item.destinationDatabasePath,
      ])
    ),
  ];
  const workspaceSnapshots: WorkspaceComposerRowSnapshot[] = [];
  for (const databasePath of databasePaths) {
    workspaceSnapshots.push(
      await snapshotWorkspaceComposerRow(
        databasePath,
        createMigrationReadGuard(first.sourceReadLimits, first.signal, first.target.sqliteDriver)
      )
    );
  }
  // Revalidation and snapshotting are separate reads. The destination may be
  // changed after the former but before the latter, so the immutable snapshot
  // that will actually seed staging must still match every prepared plan.
  const workspaceSnapshotByPath = new Map(
    workspaceSnapshots.map((snapshot) => [snapshot.databasePath, snapshot] as const)
  );
  for (const item of prepared) {
    assertPreparedDestinationIdentity(item);
    const snapshot = workspaceSnapshotByPath.get(item.destinationDatabasePath);
    if (
      !snapshot ||
      destinationFingerprint(decodeComposerDataValue(snapshot.value)) !==
        item.destinationFingerprint
    ) {
      throw new MigrationTargetChangedError(item.target.logicalSessionId);
    }
  }
  const globalSnapshots = new Map<string, GlobalSessionRow[]>();
  for (const sessionId of [
    ...new Set(
      prepared.flatMap((item) => [
        targetGlobalSessionId(item.target),
        ...(item.proposedCopySessionId ? [item.proposedCopySessionId] : []),
      ])
    ),
  ]) {
    globalSnapshots.set(
      sessionId,
      await snapshotGlobalSessionRows(
        sessionId,
        first.dataPath,
        createMigrationReadGuard(first.sourceReadLimits, first.signal, first.target.sqliteDriver)
      )
    );
  }

  throwIfMigrationAborted(first.signal);
  const ordered = prepared
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((left, right) => {
      const sourceOrder = left.item.target.composerLocator.databasePath.localeCompare(
        right.item.target.composerLocator.databasePath
      );
      if (sourceOrder !== 0) return sourceOrder;
      if (left.item.mode !== right.item.mode) return left.item.mode === 'copy' ? -1 : 1;
      if (left.item.mode === 'move') {
        return (
          right.item.target.composerLocator.composerIndex -
          left.item.target.composerLocator.composerIndex
        );
      }
      return left.originalIndex - right.originalIndex;
    });
  const destinationFingerprints = new Map<string, string>();
  for (const item of prepared) {
    const existing = destinationFingerprints.get(item.destinationDatabasePath);
    if (existing !== undefined && existing !== item.destinationFingerprint) {
      throw new MigrationTargetChangedError(item.target.logicalSessionId);
    }
    destinationFingerprints.set(item.destinationDatabasePath, item.destinationFingerprint);
  }

  interface MutableWorkspaceState {
    result: ComposerDataResult | null;
    rawValue?: string;
  }
  interface StagedBatchOperation {
    item: PreparedSessionMigration;
    originalIndex: number;
    sourceResult: ComposerDataResult | null;
    destinationResult: ComposerDataResult | null;
    sourceNext: Array<{ composerId?: string; [key: string]: unknown }>;
    destinationNext: Array<{ composerId?: string; [key: string]: unknown }>;
    sourceExpectedValue?: string;
    sourceNextValue?: string;
    destinationExpectedValue?: string;
    destinationNextValue: string;
    globalMutation: StagedGlobalMutation;
  }

  const workspaceStates = new Map<string, MutableWorkspaceState>();
  for (const snapshot of workspaceSnapshots) {
    workspaceStates.set(snapshot.databasePath, {
      result: decodeComposerDataValue(snapshot.value),
      rawValue: snapshot.value,
    });
  }

  // Build the complete mutation program from admitted snapshots. This stage
  // performs every parse, path transform, collision-dependent allocation, and
  // cancellation check before any database is writable by this batch.
  const stagedOperations: StagedBatchOperation[] = [];
  for (const { item, originalIndex } of ordered) {
    throwIfMigrationAborted(item.signal);
    const sourceState = workspaceStates.get(item.target.composerLocator.databasePath);
    const destinationState = workspaceStates.get(item.destinationDatabasePath);
    if (!sourceState || !destinationState) {
      throw new MigrationTargetChangedError(item.target.logicalSessionId);
    }
    const sourceResult = sourceState.result;
    const destinationResult = destinationState.result;
    const globalRows = globalSnapshots.get(targetGlobalSessionId(item.target)) ?? [];
    const sourceComposer = assertExactBoundOccurrence(
      item.target,
      item.dataPath,
      sourceResult,
      globalRows
    );
    if (sourceFingerprint(item.target, sourceResult, globalRows) !== item.sourceFingerprint) {
      throw new MigrationTargetChangedError(item.target.logicalSessionId);
    }

    const hydrated = hydrateComposerFromGlobalRows(
      sourceComposer,
      targetGlobalSessionId(item.target),
      item.target.logicalSessionId,
      globalRows
    );
    const sourceOriginal = sourceResult?.composers ?? [];
    const destinationOriginal = destinationResult?.composers ?? [];
    const sourceIndex = item.target.composerLocator.composerIndex;
    const sourceNext = sourceOriginal.filter((_, index) => index !== sourceIndex);
    let destinationNext: Array<{ composerId?: string; [key: string]: unknown }>;
    let globalMutation: StagedGlobalMutation;
    if (item.mode === 'move') {
      destinationNext = [
        ...destinationOriginal.filter(
          (composer) =>
            !composer.composerId ||
            !sessionIdsEqual(composer.composerId, item.target.logicalSessionId)
        ),
        hydrated,
      ];
      globalMutation = stageMoveGlobalMutation(
        targetGlobalSessionId(item.target),
        globalRows,
        item.target.sourceWorkspacePath,
        item.destinationWorkspacePath,
        item.destinationWorkspaceId,
        item.debug,
        item.dataPath,
        item.signal
      );
    } else {
      const copyId = item.proposedCopySessionId;
      if (!copyId) throw new MigrationTargetChangedError(item.target.logicalSessionId);
      const copied = structuredClone(hydrated) as Record<string, unknown>;
      copied['composerId'] = copyId;
      destinationNext = [...destinationOriginal, copied];
      globalMutation = stageCopyGlobalMutation(
        targetGlobalSessionId(item.target),
        copyId,
        globalRows,
        item.target.sourceWorkspacePath,
        item.destinationWorkspacePath,
        item.destinationWorkspaceId,
        item.debug,
        item.dataPath,
        item.signal
      );
    }

    const destinationNextValue = serializeComposerDataForMigration(
      destinationNext,
      destinationResult?.isNewFormat ?? sourceResult?.isNewFormat ?? true,
      destinationResult?.rawData
    );
    const sourceNextValue =
      item.mode === 'move' && sourceIndex !== -1
        ? serializeComposerDataForMigration(
            sourceNext,
            sourceResult?.isNewFormat ?? true,
            sourceResult?.rawData
          )
        : undefined;
    stagedOperations.push({
      item,
      originalIndex,
      sourceResult,
      destinationResult,
      sourceNext,
      destinationNext,
      sourceExpectedValue: sourceState.rawValue,
      sourceNextValue,
      destinationExpectedValue: destinationState.rawValue,
      destinationNextValue,
      globalMutation,
    });
    destinationState.result = {
      composers: destinationNext,
      rawData: destinationResult?.rawData ?? null,
      isNewFormat: destinationResult?.isNewFormat ?? sourceResult?.isNewFormat ?? true,
    };
    destinationState.rawValue = destinationNextValue;
    if (item.mode === 'move' && sourceIndex !== -1) {
      sourceState.result = {
        composers: sourceNext,
        rawData: sourceResult?.rawData ?? null,
        isNewFormat: sourceResult?.isNewFormat ?? true,
      };
      sourceState.rawValue = sourceNextValue;
    }
  }

  for (const item of prepared) throwIfMigrationAborted(item.signal);
  const globalDatabasePath = join(getGlobalStoragePath(first.dataPath), 'state.vscdb');
  const transactionPaths = [
    ...databasePaths,
    ...(existsSync(globalDatabasePath) ? [globalDatabasePath] : []),
  ];
  const writableDatabases = new Map<string, Awaited<ReturnType<typeof openDatabaseReadWrite>>>();
  try {
    for (const databasePath of [...new Set(transactionPaths)]) {
      writableDatabases.set(
        databasePath,
        await openDatabaseReadWrite(databasePath, {
          sqliteDriver: first.target.sqliteDriver,
          signal: first.signal,
        })
      );
    }
  } catch (error) {
    for (const db of writableDatabases.values()) db.close();
    throw error;
  }

  const results = new Array<SessionMigrationResult>(prepared.length);
  let transactionState: MigrationTransactionState | undefined;
  try {
    throwIfMigrationAborted(first.signal);
    transactionState = beginMigrationTransactions(writableDatabases);

    // Recheck the exact admitted bytes while every database that can be
    // mutated is protected by a deterministic BEGIN IMMEDIATE lock.
    for (const snapshot of workspaceSnapshots) {
      const database = writableDatabases.get(snapshot.databasePath);
      if (!database) throw new MigrationTargetChangedError(first.target.logicalSessionId);
      const current = snapshotWorkspaceComposerRowFromDatabase(
        snapshot.databasePath,
        database,
        createMigrationReadGuard(first.sourceReadLimits, first.signal, first.target.sqliteDriver)
      );
      if (current.value !== snapshot.value) {
        throw new MigrationTargetChangedError(first.target.logicalSessionId);
      }
    }
    const globalDatabase = writableDatabases.get(globalDatabasePath);
    for (const [sessionId, expectedRows] of globalSnapshots) {
      const currentRows = globalDatabase
        ? readGlobalSessionRowsFromDatabase(
            sessionId,
            globalDatabase,
            createMigrationReadGuard(
              first.sourceReadLimits,
              first.signal,
              first.target.sqliteDriver
            )
          )
        : [];
      if (migrationFingerprint(currentRows) !== migrationFingerprint(expectedRows)) {
        throw new MigrationTargetChangedError(sessionId);
      }
    }
    for (const item of prepared) {
      assertMigrationPhysicalIdentity(item);
      await assertBoundInventoryStillExclusive(
        item.target,
        item.dataPath,
        globalSnapshots.get(targetGlobalSessionId(item.target)) ?? [],
        createMigrationReadGuard(item.sourceReadLimits, item.signal, item.target.sqliteDriver)
      );
    }

    for (const operation of stagedOperations) {
      const { item } = operation;
      const sourceDb = writableDatabases.get(item.target.composerLocator.databasePath);
      const destinationDb = writableDatabases.get(item.destinationDatabasePath);
      if (!sourceDb || !destinationDb) {
        throw new MigrationTargetChangedError(item.target.logicalSessionId);
      }
      compareAndSwapComposerData(
        destinationDb,
        operation.destinationExpectedValue,
        operation.destinationNextValue,
        item.target.logicalSessionId
      );
      if (item.mode === 'move' && item.target.composerLocator.composerIndex !== -1) {
        if (operation.sourceNextValue === undefined) {
          throw new MigrationTargetChangedError(item.target.logicalSessionId);
        }
        compareAndSwapComposerData(
          sourceDb,
          operation.sourceExpectedValue,
          operation.sourceNextValue,
          item.target.logicalSessionId
        );
      }
      if (operation.globalMutation.rows.length > 0) {
        if (!globalDatabase) throw new MigrationTargetChangedError(item.target.logicalSessionId);
        applyStagedGlobalMutation(
          globalDatabase,
          operation.globalMutation,
          globalSnapshots.get(operation.globalMutation.sessionId) ?? []
        );
      }
      results[operation.originalIndex] = {
        success: true,
        sessionId: item.target.logicalSessionId,
        sourceWorkspace: item.target.sourceWorkspacePath,
        destinationWorkspace: item.destinationWorkspacePath,
        mode: item.mode,
        ...(item.proposedCopySessionId ? { newSessionId: item.proposedCopySessionId } : {}),
        dryRun: false,
        eligibility: 'eligible-composer',
        targetFingerprint: item.target.occurrenceFingerprint,
      };
    }

    // Store metadata is not part of SQLite's locking domain. Recheck it while
    // the SQLite mutations remain invisible, then once again after commit.
    for (const item of prepared) {
      await assertBoundInventoryStillExclusive(
        item.target,
        item.dataPath,
        globalSnapshots.get(targetGlobalSessionId(item.target)) ?? [],
        createMigrationReadGuard(item.sourceReadLimits, item.signal, item.target.sqliteDriver)
      );
      assertMigrationPhysicalIdentity(item);
    }
    commitMigrationTransactions(transactionState);
    for (const item of prepared) {
      assertStoreStillAbsent(item.target);
      assertMigrationPhysicalIdentity(item);
    }
    return results;
  } catch (error) {
    if (transactionState) rollbackMigrationTransactions(transactionState);
    if (transactionState && transactionState.committedPaths.size > 0) {
      const compensation: CompensationAction[] = [
        ...[...workspaceSnapshots].reverse().map((snapshot) => ({
          label: 'workspace batch snapshot',
          restore: () => restoreWorkspaceComposerRow(snapshot),
        })),
        ...[...globalSnapshots].map(([sessionId, rows]) => ({
          label: 'global batch snapshot',
          restore: () =>
            restoreGlobalSessionRows(sessionId, rows, first.dataPath, first.target.sqliteDriver),
        })),
      ];
      await rethrowAfterCompensation(error, compensation);
    }
    throw error;
  } finally {
    for (const db of writableDatabases.values()) db.close();
  }
}

/** Revalidate the prepared locator/fingerprints, then cross the first-write boundary once. */
async function applySessionMigrationInternal(
  prepared: PreparedSessionMigration,
  onFirstWrite?: () => void
): Promise<SessionMigrationResult> {
  const { target } = prepared;
  const readGuard = createMigrationReadGuard(
    prepared.sourceReadLimits,
    prepared.signal,
    target.sqliteDriver
  );
  throwIfMigrationAborted(prepared.signal);
  assertPreparedDestinationIdentity(prepared);
  await ensureDriver({
    operation: 'migrate',
    required: new Set(['readWrite']),
    forcedDriver: target.sqliteDriver,
  });
  const sourceDb = await openDatabaseReadWrite(target.composerLocator.databasePath, {
    sqliteDriver: target.sqliteDriver,
    signal: prepared.signal,
  });
  let destinationDb: Awaited<ReturnType<typeof openDatabaseReadWrite>> | null = null;
  try {
    destinationDb = await openDatabaseReadWrite(prepared.destinationDatabasePath, {
      sqliteDriver: target.sqliteDriver,
      signal: prepared.signal,
    });
    const sourceSnapshot = snapshotWorkspaceComposerRowFromDatabase(
      target.composerLocator.databasePath,
      sourceDb,
      readGuard
    );
    const destinationSnapshot = snapshotWorkspaceComposerRowFromDatabase(
      prepared.destinationDatabasePath,
      destinationDb,
      readGuard
    );
    const sourceResult = decodeComposerDataValue(sourceSnapshot.value);
    const destinationResult = decodeComposerDataValue(destinationSnapshot.value);
    assertPreparedDestinationIdentity(prepared);
    if (
      destinationFingerprint(decodeComposerDataValue(destinationSnapshot.value)) !==
      prepared.destinationFingerprint
    ) {
      throw new MigrationTargetChangedError(target.logicalSessionId);
    }
    const globalRows = await readGlobalSessionRows(
      targetGlobalSessionId(target),
      prepared.dataPath,
      readGuard
    );
    await assertBoundInventoryStillExclusive(target, prepared.dataPath, globalRows, readGuard);
    const sourceComposer = assertExactBoundOccurrence(
      target,
      prepared.dataPath,
      sourceResult,
      globalRows
    );
    if (
      sourceFingerprint(target, sourceResult, globalRows) !== prepared.sourceFingerprint ||
      destinationFingerprint(destinationResult) !== prepared.destinationFingerprint
    ) {
      throw new MigrationTargetChangedError(target.logicalSessionId);
    }
    const sourceIndex = target.composerLocator.composerIndex;
    const globalOnly = sourceIndex === -1;
    const sourceOriginal = sourceResult?.composers ?? [];
    const hydrated = hydrateComposerFromGlobalRows(
      sourceComposer,
      targetGlobalSessionId(target),
      target.logicalSessionId,
      globalRows
    );
    const destinationOriginal = destinationResult?.composers ?? [];
    const oldGlobalRows = globalRows.map((row) => ({ ...row }));
    const copyId = prepared.proposedCopySessionId;
    if (
      copyId &&
      (await sessionIdExistsForCopy(
        copyId,
        sourceResult,
        destinationResult,
        prepared.dataPath,
        readGuard,
        target.storeRootPath,
        target.logicalSessionId
      ))
    ) {
      throw new MigrationTargetChangedError(target.logicalSessionId);
    }
    // A proposed copy ID was admitted only after proving that every logical
    // namespace was empty, so its compensation snapshot is deterministically
    // empty and does not require another global payload read.
    const copyGlobalRows: GlobalSessionRow[] = [];
    const destinationNext =
      prepared.mode === 'move'
        ? [
            ...destinationOriginal.filter(
              (composer) =>
                !composer.composerId ||
                !sessionIdsEqual(composer.composerId, target.logicalSessionId)
            ),
            hydrated,
          ]
        : (() => {
            if (!copyId) throw new MigrationTargetChangedError(target.logicalSessionId);
            const copied = structuredClone(hydrated) as Record<string, unknown>;
            copied['composerId'] = copyId;
            return [...destinationOriginal, copied];
          })();
    const sourceNext = sourceOriginal.filter((_, index) => index !== sourceIndex);
    // Parse, transform, allocate bubble IDs, and observe cancellation before
    // crossing the first-write boundary. Applying this plan is write-only.
    const stagedGlobalMutation =
      prepared.mode === 'move'
        ? stageMoveGlobalMutation(
            targetGlobalSessionId(target),
            globalRows,
            target.sourceWorkspacePath,
            prepared.destinationWorkspacePath,
            prepared.destinationWorkspaceId,
            prepared.debug,
            prepared.dataPath,
            prepared.signal
          )
        : stageCopyGlobalMutation(
            targetGlobalSessionId(target),
            copyId!,
            globalRows,
            target.sourceWorkspacePath,
            prepared.destinationWorkspacePath,
            prepared.destinationWorkspaceId,
            prepared.debug,
            prepared.dataPath,
            prepared.signal
          );
    const destinationNextValue = serializeComposerDataForMigration(
      destinationNext,
      destinationResult?.isNewFormat ?? sourceResult?.isNewFormat ?? true,
      destinationResult?.rawData
    );
    const sourceNextValue = globalOnly
      ? undefined
      : serializeComposerDataForMigration(
          sourceNext,
          sourceResult?.isNewFormat ?? true,
          sourceResult?.rawData
        );

    const globalDatabasePath = join(getGlobalStoragePath(prepared.dataPath), 'state.vscdb');
    let globalDatabase: Awaited<ReturnType<typeof openDatabaseReadWrite>> | null = null;
    const transactionDatabases = new Map<string, Database>([
      [target.composerLocator.databasePath, sourceDb],
      [prepared.destinationDatabasePath, destinationDb],
    ]);
    if (existsSync(globalDatabasePath)) {
      globalDatabase = await openDatabaseReadWrite(globalDatabasePath, {
        sqliteDriver: target.sqliteDriver,
        signal: prepared.signal,
      });
      transactionDatabases.set(globalDatabasePath, globalDatabase);
    }

    let transactionState: MigrationTransactionState | undefined;
    try {
      throwIfMigrationAborted(prepared.signal);
      transactionState = beginMigrationTransactions(transactionDatabases);

      const lockedSourceSnapshot = snapshotWorkspaceComposerRowFromDatabase(
        target.composerLocator.databasePath,
        sourceDb,
        readGuard
      );
      const lockedDestinationSnapshot = snapshotWorkspaceComposerRowFromDatabase(
        prepared.destinationDatabasePath,
        destinationDb,
        readGuard
      );
      if (
        lockedSourceSnapshot.value !== sourceSnapshot.value ||
        lockedDestinationSnapshot.value !== destinationSnapshot.value
      ) {
        throw new MigrationTargetChangedError(target.logicalSessionId);
      }
      const lockedGlobalRows = globalDatabase
        ? readGlobalSessionRowsFromDatabase(
            targetGlobalSessionId(target),
            globalDatabase,
            readGuard
          )
        : [];
      if (migrationFingerprint(lockedGlobalRows) !== migrationFingerprint(globalRows)) {
        throw new MigrationTargetChangedError(target.logicalSessionId);
      }
      if (copyId) {
        const lockedCopyRows = globalDatabase
          ? readGlobalSessionRowsFromDatabase(copyId, globalDatabase, readGuard)
          : [];
        if (lockedCopyRows.length !== 0) {
          throw new MigrationTargetChangedError(target.logicalSessionId);
        }
      }
      assertMigrationPhysicalIdentity(prepared);
      await assertBoundInventoryStillExclusive(
        target,
        prepared.dataPath,
        lockedGlobalRows,
        readGuard
      );

      // This hook is deliberately before the atomic CAS statements and after
      // all locks/revalidation, so fault-injection writers must either block or
      // cause the guarded update to report MIGRATION_TARGET_CHANGED.
      throwIfMigrationAborted(prepared.signal);
      onFirstWrite?.();
      compareAndSwapComposerData(
        destinationDb,
        lockedDestinationSnapshot.value,
        destinationNextValue,
        target.logicalSessionId
      );
      if (prepared.mode === 'move' && !globalOnly) {
        if (sourceNextValue === undefined) {
          throw new MigrationTargetChangedError(target.logicalSessionId);
        }
        compareAndSwapComposerData(
          sourceDb,
          lockedSourceSnapshot.value,
          sourceNextValue,
          target.logicalSessionId
        );
      }
      if (stagedGlobalMutation.rows.length > 0) {
        if (!globalDatabase) throw new MigrationTargetChangedError(target.logicalSessionId);
        applyStagedGlobalMutation(
          globalDatabase,
          stagedGlobalMutation,
          prepared.mode === 'move' ? lockedGlobalRows : copyGlobalRows
        );
      }

      // Other workspace databases and Store metadata do not share these
      // SQLite locks. Recheck while our writes are still uncommitted, then
      // recheck Store/physical identity after commit and compensate on drift.
      await assertBoundInventoryStillExclusive(
        target,
        prepared.dataPath,
        lockedGlobalRows,
        readGuard
      );
      assertMigrationPhysicalIdentity(prepared);
      commitMigrationTransactions(transactionState);
      assertStoreStillAbsent(target);
      assertMigrationPhysicalIdentity(prepared);
    } catch (error) {
      if (transactionState) rollbackMigrationTransactions(transactionState);
      if (transactionState && transactionState.committedPaths.size > 0) {
        const compensation: CompensationAction[] = [
          {
            label: 'destination workspace state',
            restore: () => restoreWorkspaceComposerRow(destinationSnapshot),
          },
          ...(globalOnly
            ? []
            : [
                {
                  label: 'source workspace state',
                  restore: () => restoreWorkspaceComposerRow(sourceSnapshot),
                },
              ]),
          {
            label: 'source global state',
            restore: () =>
              restoreGlobalSessionRows(
                targetGlobalSessionId(target),
                oldGlobalRows,
                prepared.dataPath,
                target.sqliteDriver
              ),
          },
          ...(copyId
            ? [
                {
                  label: 'copy global state',
                  restore: () =>
                    restoreGlobalSessionRows(
                      copyId,
                      copyGlobalRows,
                      prepared.dataPath,
                      target.sqliteDriver
                    ),
                },
              ]
            : []),
        ];
        await rethrowAfterCompensation(error, compensation);
      }
      throw error;
    } finally {
      globalDatabase?.close();
    }

    return {
      success: true,
      sessionId: target.logicalSessionId,
      sourceWorkspace: target.sourceWorkspacePath,
      destinationWorkspace: prepared.destinationWorkspacePath,
      mode: prepared.mode,
      ...(copyId ? { newSessionId: copyId } : {}),
      dryRun: false,
      eligibility: 'eligible-composer',
      targetFingerprint: target.occurrenceFingerprint,
    };
  } finally {
    sourceDb.close();
    destinationDb?.close();
  }
}

/** Revalidate one prepared target and apply it without rediscovery. */
export async function applySessionMigration(
  prepared: PreparedSessionMigration
): Promise<SessionMigrationResult> {
  return applySessionMigrationInternal(prepared);
}

function previewPreparedMigration(prepared: PreparedSessionMigration): SessionMigrationResult {
  return {
    success: true,
    sessionId: prepared.target.logicalSessionId,
    sourceWorkspace: prepared.target.sourceWorkspacePath,
    destinationWorkspace: prepared.destinationWorkspacePath,
    mode: prepared.mode,
    ...(prepared.proposedCopySessionId ? { newSessionId: prepared.proposedCopySessionId } : {}),
    dryRun: true,
    pathsWillBeUpdated: true,
    eligibility: 'eligible-composer',
    targetFingerprint: prepared.target.occurrenceFingerprint,
  };
}

function isFatalMigrationFailure(error: unknown): boolean {
  return (
    isSessionIntegrityError(error) ||
    error instanceof WorkspaceNotFoundError ||
    error instanceof SameWorkspaceError ||
    error instanceof NestedPathError ||
    error instanceof DestinationHasSessionsError ||
    error instanceof AggregateError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * Migrate a single session from its current workspace to a destination workspace.
 *
 * This is the core primitive for all migration operations.
 * Move mode: removes session from source, adds to destination.
 * Copy mode: duplicates session to destination, keeps source intact.
 *
 * @param sessionId - The session ID to migrate
 * @param options - Migration options
 * @returns Migration result for this session
 */
export async function migrateSession(
  sessionId: string,
  options: Omit<MigrateSessionOptions, 'sessionIds'> & {
    sourceWorkspacePath?: string;
    /** @internal Provider already selected by a containing workspace operation. */
    sqliteDriver?: DriverName;
  }
): Promise<SessionMigrationResult> {
  const sourceReadLimits = resolveSourceReadLimits(options.sourceReadLimits);
  throwIfMigrationAborted(options.signal);
  const [target] = await bindMigrationTargets([sessionId], {
    numericBase: 1,
    treatStringSelectorsAsIds: true,
    sqliteDriver: options.sqliteDriver,
    workspacePath: options.sourceWorkspacePath ?? options.workspacePath,
    dataPath: options.dataPath,
    sourceReadLimits,
    signal: options.signal,
  });
  if (!target) throw new SessionNotFoundError(sessionId);
  try {
    const prepared = await prepareSessionMigration(target, options.destination, {
      mode: options.mode,
      force: options.force,
      dataPath: target.dataPath,
      debug: options.debug,
      sourceReadLimits: target.sourceReadLimits,
      signal: target.signal,
    });
    if (options.dryRun) return previewPreparedMigration(prepared);
    return await applySessionMigrationInternal(prepared);
  } catch (error) {
    if (isFatalMigrationFailure(error)) throw error;
    // Preserve the released single-session result shape for ordinary database
    // failures while keeping integrity/cancellation failures typed and atomic.
    return {
      success: false,
      sessionId,
      sourceWorkspace: target.sourceWorkspacePath,
      destinationWorkspace: normalizePath(options.destination),
      mode: options.mode,
      error: error instanceof Error ? error.message : String(error),
      dryRun: false,
    };
  }
}

/**
 * Migrate multiple sessions to a destination workspace.
 *
 * The complete batch is bound and prepared before its first write. A refusal
 * therefore changes no member; failures after the write boundary trigger
 * compensation for every member already touched. The legacy `sessionIds`
 * route retains ordered ordinary-failure result objects without reverting to
 * partial application.
 *
 * @param options - Migration options including session IDs
 * @returns Array of results for each session
 */
export async function migrateSessions(
  options: MigrateSessionOptions
): Promise<SessionMigrationResult[]> {
  const legacyIds = options.selectors === undefined;
  const selectors: readonly (number | string)[] = options.selectors ?? options.sessionIds ?? [];
  if (selectors.length === 0) return [];
  const sourceReadLimits = resolveSourceReadLimits(options.sourceReadLimits);
  throwIfMigrationAborted(options.signal);
  let targets: BoundMigrationTarget[] = [];

  try {
    // Resolve and prepare every member against one provider, one cancellation
    // signal, and the exact same branded limits object before any member can
    // write. This also makes the released sessionIds route batch-atomic.
    targets = await bindMigrationTargets(selectors, {
      numericBase: 1,
      treatStringSelectorsAsIds: legacyIds,
      workspacePath: options.workspacePath,
      dataPath: options.dataPath,
      sourceReadLimits,
      signal: options.signal,
    });
    const duplicateTarget = targets.find(
      (target, index) =>
        targets.findIndex((candidate) =>
          sessionIdsEqual(candidate.logicalSessionId, target.logicalSessionId)
        ) !== index
    );
    if (duplicateTarget) {
      throw new UnsupportedSessionMigrationError(
        duplicateTarget.logicalSessionId,
        'duplicate-batch-selector'
      );
    }
    const prepared: PreparedSessionMigration[] = [];
    for (const target of targets) {
      prepared.push(
        await prepareSessionMigration(target, options.destination, {
          mode: options.mode,
          force: options.force,
          dataPath: target.dataPath,
          debug: options.debug,
          sourceReadLimits: target.sourceReadLimits,
          signal: target.signal,
        })
      );
    }
    if (options.dryRun) return prepared.map(previewPreparedMigration);
    return await applyPreparedMigrationBatch(prepared);
  } catch (error) {
    if (
      isFatalMigrationFailure(error) &&
      !(legacyIds && error instanceof SessionScopeMismatchError)
    ) {
      throw error;
    }
    // The package-root selector API historically resolved every selector
    // before migration. Preserve a fatal lookup/preflight failure when binding
    // never completed, but keep ordinary post-bind database/write failures in
    // the released per-session result envelope.
    if (!legacyIds && targets.length !== selectors.length) throw error;
    // Legacy sessionIds returned result objects for ordinary failures. Keep
    // that same shape for package-root selectors, but abort the whole bound
    // batch so an earlier valid member is never committed before a later
    // member fails preparation/application.
    return selectors.map((selector, index) => {
      const target = targets[index];
      const sessionId = target?.logicalSessionId ?? String(selector);
      return {
        success: false,
        sessionId,
        sourceWorkspace: target?.sourceWorkspacePath ?? 'unknown',
        destinationWorkspace: normalizePath(options.destination),
        mode: options.mode,
        error: error instanceof Error ? error.message : String(error),
        dryRun: options.dryRun,
      };
    });
  }
}

/**
 * Migrate all sessions from one workspace to another.
 *
 * This is a convenience wrapper that finds all sessions in the source workspace
 * and calls migrateSession for each one.
 *
 * @param options - Workspace migration options
 * @returns Aggregate result with per-session details
 */
export async function migrateWorkspace(
  options: MigrateWorkspaceOptions
): Promise<WorkspaceMigrationResult> {
  const {
    source,
    destination,
    mode,
    dryRun,
    force,
    dataPath,
    debug = false,
    sourceReadLimits: sourceReadLimitsOverride,
    signal,
  } = options;
  // Validation is deliberately first: malformed policy never triggers source
  // discovery, and even dry-run proves a readWrite-capable provider exists.
  const sourceReadLimits = resolveSourceReadLimits(sourceReadLimitsOverride);
  throwIfMigrationAborted(signal);
  const storeRootPath = normalizePath(getStoreStackRoot(dataPath));
  const selectedDriver = await selectDatabaseDriver({
    operation: 'migrate',
    required: new Set(['readWrite']),
  });
  const sqliteDriver = selectedDriver.name as DriverName;
  const readGuard = createMigrationReadGuard(sourceReadLimits, signal, sqliteDriver);
  // Normalize paths
  const normalizedSource = normalizePath(source);
  const normalizedDest = normalizePath(destination);

  // Check if source and destination are the same
  if (pathsEqual(normalizedSource, normalizedDest)) {
    throw new SameWorkspaceError(normalizedSource);
  }

  // T015: Check for nested paths (would cause infinite replacement loops)
  if (isNestedPath(normalizedSource, normalizedDest)) {
    throw new NestedPathError(normalizedSource, normalizedDest);
  }

  // Find source workspace
  const sourceInfo = await findMigrationWorkspaceByPath(normalizedSource, dataPath, readGuard);
  if (!sourceInfo) {
    throw new WorkspaceNotFoundError(normalizedSource);
  }

  // Find destination workspace
  const destInfo = await findMigrationWorkspaceByPath(normalizedDest, dataPath, readGuard);
  if (!destInfo) {
    throw new WorkspaceNotFoundError(normalizedDest);
  }

  // Real database-backed workspace migration inventories the complete scoped
  // logical catalog first, including Store-only and merged rows. Binding every
  // unique UUID before applying any target prevents a workspace command from
  // moving only the Composer half of a multi-source session.
  if (existsSync(sourceInfo.dbPath)) {
    const context = createSessionReadContext({
      dataPath,
      workspacePath: normalizedSource,
      sqliteDriver,
      sourceReadLimits,
      signal,
    });
    let summaries: LogicalSessionSummary[];
    try {
      summaries = await listSessionSummaries(
        {
          limit: 0,
          all: true,
          workspacePath: normalizedSource,
        },
        dataPath,
        undefined,
        context
      );
    } finally {
      await context.dispose();
    }
    const ambiguous = summaries.find((summary) => summary.resolutionState === 'ambiguous');
    if (ambiguous?.resolutionState === 'ambiguous') {
      throw new SessionAmbiguityError(ambiguous.id, ambiguous.diagnosticOccurrenceRefs);
    }
    const sessionIdsByLogicalId = new Map<string, string>();
    for (const summary of summaries) {
      const key = logicalSessionIdKey(summary.id);
      if (!sessionIdsByLogicalId.has(key)) sessionIdsByLogicalId.set(key, summary.id);
    }
    const sessionIds = [...sessionIdsByLogicalId.values()];
    if (sessionIds.length === 0) throw new NoSessionsFoundError(normalizedSource);

    // Bind every source target before reading destination conversation payload.
    // Any ambiguous, Store-only, merged, or multiply-addressed row rejects the
    // complete workspace operation before a writable destination is opened.
    const targets = await bindMigrationTargets(sessionIds, {
      numericBase: 1,
      treatStringSelectorsAsIds: true,
      sqliteDriver,
      storeRootPath,
      workspacePath: normalizedSource,
      dataPath,
      sourceReadLimits,
      signal,
    });
    const prepared: PreparedSessionMigration[] = [];
    for (const target of targets) {
      prepared.push(
        await prepareSessionMigration(target, normalizedDest, {
          mode,
          force,
          dataPath: target.dataPath,
          debug,
          sourceReadLimits: target.sourceReadLimits,
          signal: target.signal,
        })
      );
    }
    let results: SessionMigrationResult[];
    if (dryRun) {
      results = prepared.map(previewPreparedMigration);
    } else {
      try {
        results = await applyPreparedMigrationBatch(prepared);
      } catch (error) {
        if (isFatalMigrationFailure(error)) throw error;
        results = prepared.map((item) => ({
          success: false,
          sessionId: item.target.logicalSessionId,
          sourceWorkspace: item.target.sourceWorkspacePath,
          destinationWorkspace: item.destinationWorkspacePath,
          mode: item.mode,
          error: error instanceof Error ? error.message : String(error),
          dryRun: false,
        }));
      }
    }
    const successCount = results.filter((result) => result.success).length;
    const failureCount = results.length - successCount;
    return {
      success: failureCount === 0,
      source: normalizedSource,
      destination: normalizedDest,
      mode,
      totalSessions: results.length,
      successCount,
      failureCount,
      results,
      dryRun,
    };
  }

  // Get sessions from source workspace
  const sourceDb = await openDatabaseReadWrite(sourceInfo.dbPath, { sqliteDriver, signal });
  let sourceResult: ComposerDataResult | null;
  try {
    sourceResult = getComposerDataBounded(sourceDb, readGuard);
  } finally {
    sourceDb.close();
  }

  // Extract session IDs from the workspace composer list, then union in any
  // sessions discoverable only through global storage (linked to this workspace
  // via workspaceIdentifier/workspaceUri) so migration covers everything `list`
  // shows for the source workspace.
  const sessionIds: string[] = sourceResult
    ? sourceResult.composers
        .map((s) => s.composerId)
        .filter((id): id is string => typeof id === 'string')
    : [];
  const sessionIdSet = new Set(sessionIds.map(logicalSessionIdKey));
  for (const linkedId of await getWorkspaceLinkedComposerIds(sourceInfo.workspace, dataPath)) {
    const logicalId = logicalSessionIdKey(linkedId);
    if (!sessionIdSet.has(logicalId)) {
      sessionIdSet.add(logicalId);
      sessionIds.push(linkedId);
    }
  }

  if (sessionIds.length === 0) {
    throw new NoSessionsFoundError(normalizedSource);
  }

  // Check if destination has existing sessions (unless force is set)
  if (!force) {
    const destDb = await openDatabaseReadWrite(destInfo.dbPath, { sqliteDriver, signal });
    let destResult: ComposerDataResult | null;
    try {
      destResult = getComposerDataBounded(destDb, readGuard);
    } finally {
      destDb.close();
    }

    if (destResult && destResult.composers.length > 0) {
      throw new DestinationHasSessionsError(normalizedDest, destResult.composers.length);
    }
  }

  // Migrate all sessions
  const results: SessionMigrationResult[] = [];
  for (const sessionId of sessionIds) {
    try {
      const result = await migrateSession(sessionId, {
        destination: normalizedDest,
        mode,
        dryRun,
        force,
        dataPath,
        debug,
        sourceReadLimits,
        signal,
        sourceWorkspacePath: normalizedSource,
        sqliteDriver,
      });
      results.push(result);
    } catch (error) {
      if (isFatalMigrationFailure(error)) throw error;
      results.push({
        success: false,
        sessionId,
        sourceWorkspace: normalizedSource,
        destinationWorkspace: normalizedDest,
        mode,
        error: error instanceof Error ? error.message : String(error),
        dryRun,
      });
    }
  }

  // Aggregate results
  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  return {
    success: failureCount === 0,
    source: normalizedSource,
    destination: normalizedDest,
    mode,
    totalSessions: results.length,
    successCount,
    failureCount,
    results,
    dryRun,
  };
}
