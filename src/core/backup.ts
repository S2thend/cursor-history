/**
 * Core backup and restore functionality
 *
 * This module provides low-level backup operations:
 * - SQLite database backup using pluggable driver system
 * - Zip creation/extraction using jszip
 * - Manifest generation with checksums
 * - Integrity validation
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  Database as DatabaseInterface,
  DatabaseCapability,
  DatabaseOperationRequest,
  DriverName,
  Statement,
} from './database/types.js';
import { registry } from './database/registry.js';
import { backupDatabase, openDatabase } from './database/index.js';
import { createPrivateTempWorkspace, type PrivateTempWorkspace } from './private-temp.js';
import { PACKAGE_VERSION } from './package-version.generated.js';
import {
  BoundedZipArchive,
  ZipArchiveFormatError,
  openBoundedZipArchive,
  prepareZipFileInputs,
  writeBoundedZipArchive,
  type BoundedZipWriteInput,
  type PreparedZipFileInput,
} from './zip-stream.js';
import { resolveSourceReadLimits } from './source-read-limits.js';
import {
  createComposerSqliteBudget,
  forEachBoundedComposerValue,
  readBoundedComposerValueByKey,
} from './composer-sqlite.js';
import { IoObserverError, type OperationIoContext } from './io-observer.js';
import {
  RestoreRollbackError,
  SourceLimitConfigurationError,
  SourceLimitExceededError,
  TemporaryArtifactCleanupError,
} from './errors.js';
import {
  enforcePublishedArchiveMode,
  type PublishedArchiveIdentity,
} from './backup-publication.js';
import { publishBackupArchiveStage } from './backup-archive-publication.js';
import { commitRestorePublication } from './restore-publication.js';
import {
  groupSessionIdSpellings,
  logicalSessionIdKey,
  selectNativeSessionIdSpelling,
} from './session-id.js';
import { parseChatData, type CursorChatBundle } from './parser.js';
import type {
  BackupManifest,
  BackupComposerWorkspaceInventory,
  BackupComposerWorkspaceInventoryEntry,
  BackupFileEntry,
  BackupStats,
  BackupConfig,
  BackupResult,
  RestoreConfig,
  RestoreResult,
  BackupValidation,
  BackupInfo,
  SourceReadOptions,
} from './types.js';

const MANIFEST_VERSION = '1.0.0';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BACKUP_METADATA_MEMORY_LIMIT = 16 * 1024 * 1024;
const BACKUP_DATABASE_READ_CAPABILITIES = new Set<DatabaseCapability>(['read']);
const BACKUP_CHAT_DATA_KEYS = [
  'composer.composerData',
  'workbench.panel.aichat.view.aichat.chatdata',
  'workbench.panel.chat.view.chat.chatdata',
] as const;

/** Internal options for opening one database carried by a bounded backup archive. */
export interface BackupDatabaseReadOptions extends SourceReadOptions {
  /** Strict provider preference for the extracted database open. */
  sqliteDriver?: DriverName;
  /** Internal operation-bound I/O audit context. */
  io?: OperationIoContext;
  /** Stable logical identity only; never an archive path. */
  logicalSessionId?: string;
}

/** Runtime-only extension used by core readers without expanding public read options. */
type InternalSourceReadOptions = SourceReadOptions & { readonly io?: OperationIoContext };

/** Internal signal that an optional or manifest-referenced archive entry is absent. */
export class BackupEntryNotFoundError extends Error {
  override readonly name = 'BackupEntryNotFoundError';

  constructor(readonly entryPath: string) {
    super(`Database not found in backup: ${entryPath}`);
  }
}

function backupDatabaseReadRequest(
  sqliteDriver: DriverName | undefined,
  io: OperationIoContext | undefined,
  dbPath: string,
  logicalSessionId?: string
): DatabaseOperationRequest {
  const global = dbPath === 'globalStorage/state.vscdb';
  return {
    operation: 'read-session',
    required: BACKUP_DATABASE_READ_CAPABILITIES,
    ...(sqliteDriver ? { forcedDriver: sqliteDriver } : {}),
    ...(io ? { io } : {}),
    ioResource: {
      resourceClass: 'sqlite-snapshot',
      sourceRole: 'composer',
      representation: global ? 'composer-global' : 'composer-workspace',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    },
  };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error('The backup operation was aborted.', {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function freezeSourceReadOptions(
  options: SourceReadOptions = {}
): Readonly<InternalSourceReadOptions> {
  const internal = options as InternalSourceReadOptions;
  const sourceReadLimits = resolveSourceReadLimits(options.sourceReadLimits);
  return Object.freeze({
    sourceReadLimits,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(internal.io ? { io: internal.io } : {}),
  });
}

// ============================================================================
// Foundational Utilities (T005-T009)
// ============================================================================

/**
 * T005: Get the default backup directory path
 * Returns ~/cursor-history-backups/
 */
export function getDefaultBackupDir(): string {
  return join(homedir(), 'cursor-history-backups');
}

/**
 * T006: Compute SHA-256 checksum of a buffer
 */
export function computeChecksum(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

/**
 * T007: Generate a timestamped backup filename
 * Format: cursor_history_backup_YYYY-MM-DD_HHMMSS.zip
 */
export function generateBackupFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `cursor_history_backup_${year}-${month}-${day}_${hours}${minutes}${seconds}.zip`;
}

/**
 * Information about a discovered database file
 */
export interface DatabaseFileInfo {
  /** Absolute path to the database file */
  absolutePath: string;
  /** Path relative to the Cursor data directory (for zip storage) */
  relativePath: string;
  /** File size in bytes */
  size: number;
  /** File type */
  type: 'global-db' | 'workspace-db' | 'workspace-json';
  /** Workspace ID (for workspace DBs) */
  workspaceId?: string;
}

/**
 * T008: Scan for all database files in the Cursor data directory
 * Discovers globalStorage/state.vscdb and workspaceStorage/{id}/state.vscdb
 */
export function scanDatabaseFiles(dataPath: string): DatabaseFileInfo[] {
  const files: DatabaseFileInfo[] = [];

  // The dataPath typically points to workspaceStorage directory
  // We need to go up one level to find both globalStorage and workspaceStorage
  const userDir = dirname(dataPath);

  // Check for globalStorage/state.vscdb
  const globalDbPath = join(userDir, 'globalStorage', 'state.vscdb');
  if (existsSync(globalDbPath)) {
    const stat = statSync(globalDbPath);
    files.push({
      absolutePath: globalDbPath,
      relativePath: 'globalStorage/state.vscdb',
      size: stat.size,
      type: 'global-db',
    });
  }

  // Scan workspaceStorage for all workspace databases and workspace.json files
  const workspaceStorageDir = dataPath;
  if (existsSync(workspaceStorageDir)) {
    try {
      const entries = readdirSync(workspaceStorageDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const workspaceDir = join(workspaceStorageDir, entry.name);

          // Add state.vscdb if exists
          const workspaceDbPath = join(workspaceDir, 'state.vscdb');
          if (existsSync(workspaceDbPath)) {
            const stat = statSync(workspaceDbPath);
            files.push({
              absolutePath: workspaceDbPath,
              relativePath: `workspaceStorage/${entry.name}/state.vscdb`,
              size: stat.size,
              type: 'workspace-db',
              workspaceId: entry.name,
            });
          }

          // Add workspace.json if exists (contains workspace path metadata)
          const workspaceJsonPath = join(workspaceDir, 'workspace.json');
          if (existsSync(workspaceJsonPath)) {
            const stat = statSync(workspaceJsonPath);
            files.push({
              absolutePath: workspaceJsonPath,
              relativePath: `workspaceStorage/${entry.name}/workspace.json`,
              size: stat.size,
              type: 'workspace-json',
              workspaceId: entry.name,
            });
          }
        }
      }
    } catch {
      // Directory might not be accessible
    }
  }

  return files;
}

/**
 * T009: Create a manifest object from file entries and stats
 */
export function createManifest(
  files: BackupFileEntry[],
  stats: BackupStats,
  composerWorkspaceInventory?: BackupComposerWorkspaceInventory
): BackupManifest {
  const platform = process.platform as 'darwin' | 'win32' | 'linux';

  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    sourcePlatform: platform,
    producer: PACKAGE_VERSION,
    cursorHistoryVersion: PACKAGE_VERSION,
    files,
    ...(composerWorkspaceInventory ? { composerWorkspaceInventory } : {}),
    stats,
  };
}

/** Serialize one manifest exactly as archived and reject metadata this reader cannot reopen. */
export function serializeBackupManifest(manifest: BackupManifest): Buffer {
  const buffer = Buffer.from(JSON.stringify(manifest, null, 2));
  if (buffer.byteLength > BACKUP_METADATA_MEMORY_LIMIT) {
    throw new ZipArchiveFormatError(
      `Backup manifest exceeds the ${BACKUP_METADATA_MEMORY_LIMIT}-byte metadata limit.`
    );
  }
  return buffer;
}

/**
 * Count sessions in a database file
 * Uses the pluggable driver system (requires driver to be pre-selected)
 */
function closeSessionCountDatabase(db: DatabaseInterface, operationError: unknown): void {
  try {
    db.close();
  } catch (closeError) {
    if (
      closeError instanceof Error &&
      operationError !== undefined &&
      !Object.prototype.hasOwnProperty.call(closeError, 'cause')
    ) {
      Object.defineProperty(closeError, 'cause', { configurable: true, value: operationError });
    }
    throw closeError;
  }
}

interface ComposerDatabaseInventory {
  readonly sessionCount: number;
  readonly sessionIds: readonly string[];
  readonly linkedSessionCandidates: readonly string[];
}

const COMPOSER_GUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gu;

function compareCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      return leftPoint.done === rightPoint.done ? 0 : leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0)! - rightPoint.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

function inspectComposerDatabase(
  dbPath: string,
  readOptions: Readonly<InternalSourceReadOptions>
): ComposerDatabaseInventory {
  throwIfAborted(readOptions.signal);
  const db = registry.openSync(dbPath, { readonly: true });
  let operationError: unknown;
  try {
    const budget = createComposerSqliteBudget(
      resolveSourceReadLimits(readOptions.sourceReadLimits)
    );
    const candidates: Array<{ key: (typeof BACKUP_CHAT_DATA_KEYS)[number]; value: string }> = [];
    try {
      for (const key of BACKUP_CHAT_DATA_KEYS) {
        const value = readBoundedComposerValueByKey(
          db,
          'ItemTable',
          key,
          budget,
          readOptions.signal
        );
        if (value) candidates.push({ key, value });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:no such table|does not exist).*\bItemTable\b/iu.test(error.message)
      ) {
        return { sessionCount: 0, sessionIds: [], linkedSessionCandidates: [] };
      }
      throw error;
    }
    const composerValue = candidates.find(({ key }) => key === 'composer.composerData')?.value;
    const bundle: CursorChatBundle = composerValue ? { composerData: composerValue } : {};
    let selectedSessions = [] as ReturnType<typeof parseChatData>;
    for (const candidate of candidates) {
      const parsed = parseChatData(
        candidate.value,
        candidate.key === 'composer.composerData'
          ? { ...bundle, composerData: candidate.value }
          : bundle
      );
      if (parsed.length > selectedSessions.length) selectedSessions = parsed;
    }
    const sessionIds = new Set<string>();
    const linkedSessionCandidates = new Set<string>();
    for (const session of selectedSessions) {
      if (session.id.length > 0) sessionIds.add(session.id);
    }
    if (composerValue) {
      try {
        const data = JSON.parse(composerValue) as { selectedComposerIds?: unknown } | unknown[];
        if (!Array.isArray(data) && Array.isArray(data.selectedComposerIds)) {
          for (const candidate of data.selectedComposerIds) {
            if (typeof candidate === 'string' && candidate.length > 0) {
              linkedSessionCandidates.add(candidate);
            }
          }
        }
      } catch {
        // A malformed/stale modern candidate does not suppress a valid legacy chat carrier.
      }
    }
    forEachBoundedComposerValue(
      db,
      'ItemTable',
      '%composerChatViewPane%',
      budget,
      ({ key, value: pointerValue }) => {
        for (const source of [key, pointerValue]) {
          for (const match of source.matchAll(COMPOSER_GUID_RE)) {
            if (match[0]) linkedSessionCandidates.add(match[0]);
          }
        }
      },
      readOptions.signal
    );
    return {
      sessionCount: sessionIds.size,
      sessionIds: [...sessionIds].sort(compareCodePoints),
      linkedSessionCandidates: [...linkedSessionCandidates].sort(compareCodePoints),
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    closeSessionCountDatabase(db, operationError);
  }
}

/**
 * Project only stable Composer IDs that have at least one global bubble. Values
 * (titles/messages/tools) are never decoded for manifest membership. A composerData-only record is
 * metadata, not a complete global conversation, and must not make a scoped backup invent an empty
 * addressable session that live discovery would reject. Key bytes remain bounded and paginated by
 * Source Read Limits.
 */
function inspectGlobalComposerPayloadIds(
  dbPath: string,
  readOptions: Readonly<InternalSourceReadOptions>
): ReadonlySet<string> {
  throwIfAborted(readOptions.signal);
  const db = registry.openSync(dbPath, { readonly: true });
  let operationError: unknown;
  try {
    const budget = createComposerSqliteBudget(
      resolveSourceReadLimits(readOptions.sourceReadLimits)
    );
    const ids = new Set<string>();
    const pageRows = budget.limits.sqlitePageRows;
    let afterRowId: string | null = null;
    while (true) {
      throwIfAborted(readOptions.signal);
      let rows: Array<{ rowId?: unknown; keyByteLength?: unknown }>;
      try {
        rows = db
          .prepare(
            `SELECT CAST(rowid AS TEXT) AS rowId,
               length(CAST(key AS BLOB)) AS keyByteLength
             FROM cursorDiskKV
             WHERE key LIKE 'bubbleId:%'
               AND (? IS NULL OR rowid > ?)
             ORDER BY rowid ASC LIMIT ?`
          )
          .all(afterRowId, afterRowId, pageRows) as Array<{
          rowId?: unknown;
          keyByteLength?: unknown;
        }>;
      } catch (error) {
        if (
          error instanceof Error &&
          /(?:no such table|does not exist).*\bcursorDiskKV\b/iu.test(error.message)
        ) {
          return ids;
        }
        throw error;
      }
      if (rows.length === 0) break;
      const metadata = rows.map((row) => {
        const rowId = typeof row.rowId === 'string' ? row.rowId : String(row.rowId ?? '');
        const keyByteLength = Number(row.keyByteLength);
        if (!/^-?\d+$/u.test(rowId) || !Number.isSafeInteger(keyByteLength) || keyByteLength < 0) {
          throw new TypeError('SQLite returned invalid global Composer key metadata.');
        }
        return { rowId, keyByteLength };
      });
      budget.admitMetadataPage(metadata.map(({ keyByteLength }) => keyByteLength));
      for (const row of metadata) {
        throwIfAborted(readOptions.signal);
        const projected = db
          .prepare('SELECT key FROM cursorDiskKV WHERE rowid = ?')
          .get(row.rowId) as { key?: unknown } | undefined;
        if (typeof projected?.key !== 'string') {
          throw new Error('Global Composer key changed after metadata admission.');
        }
        const keyBytes = Buffer.byteLength(projected.key);
        if (keyBytes !== row.keyByteLength) {
          throw new Error('Global Composer key length changed after metadata admission.');
        }
        budget.admitDecodedValue(keyBytes);
        const bubble = /^bubbleId:([^:]+):/u.exec(projected.key)?.[1];
        if (bubble) ids.add(bubble);
      }
      afterRowId = metadata[metadata.length - 1]!.rowId;
      if (rows.length < pageRows) break;
    }
    return ids;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    closeSessionCountDatabase(db, operationError);
  }
}

function decodeWorkspacePathForManifest(snapshotPath: string): string | null {
  try {
    // This is metadata, not an authorization to materialize an arbitrarily large sidecar. The
    // same hard ceiling bounds manifest and workspace-metadata buffers during archive reads.
    if (statSync(snapshotPath).size > BACKUP_METADATA_MEMORY_LIMIT) return null;
    const content = readFileSync(snapshotPath, 'utf8');
    const parsed = JSON.parse(content) as { folder?: unknown; workspace?: unknown };
    const uri =
      typeof parsed.workspace === 'string'
        ? parsed.workspace
        : typeof parsed.folder === 'string'
          ? parsed.folder
          : undefined;
    if (uri === undefined || uri.length === 0) return null;
    try {
      return decodeURIComponent(uri.replace(/^file:\/\//u, ''));
    } catch {
      return uri.replace(/^file:\/\//u, '');
    }
  } catch {
    // Preserve the historical ability to archive missing/malformed workspace metadata. The
    // archive remains addressable through its stable workspace ID placeholder.
    return null;
  }
}

// ============================================================================
// Backup Operations (T011-T016)
// ============================================================================

/**
 * T013: Check if there's enough disk space for the backup
 * Returns { available, required, sufficient }
 */
export function checkDiskSpace(
  outputPath: string,
  requiredBytes: number
): { available: number; required: number; sufficient: boolean } {
  // Node.js doesn't have a built-in way to check disk space
  // We'll use a simple heuristic: check if we can write a small file
  // For a proper implementation, we could use the 'check-disk-space' package
  // For now, we'll estimate available space is sufficient if the directory exists/can be created

  const dir = dirname(outputPath);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // Simplified check - assume sufficient space
    // In production, use 'check-disk-space' or similar package
    return {
      available: Number.MAX_SAFE_INTEGER,
      required: requiredBytes,
      sufficient: true,
    };
  } catch {
    return {
      available: 0,
      required: requiredBytes,
      sufficient: false,
    };
  }
}

function syncParentDirectory(path: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // The complete archive has already been fsynced. Some filesystems do not permit directory
    // fsync through Node; publication remains atomic even when that extra durability step is absent.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Directory sync is explicitly best-effort; a close failure after publication must not
        // turn a complete atomic replacement into a reported creation failure.
      }
    }
  }
}

function removePrivateArchiveStage(path: string, operationError?: unknown): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    const cleanupError = new TemporaryArtifactCleanupError([path]);
    attachCleanupCause(cleanupError, operationError ?? error);
    throw cleanupError;
  }
}

async function writeAndPublishBackupArchive(
  outputPath: string,
  entries: readonly BoundedZipWriteInput[],
  config: Pick<BackupConfig, 'force' | 'sharedPermissions' | 'sourceReadLimits' | 'signal'>
): Promise<void> {
  throwIfAborted(config.signal);
  let existingMode: number | undefined;
  if (existsSync(outputPath)) {
    const existing = lstatSync(outputPath);
    if (!existing.isFile()) {
      throw new Error(`Backup destination is not a regular file: ${basename(outputPath)}`);
    }
    if (!config.force) {
      const error = new Error(`Backup destination already exists: ${basename(outputPath)}`);
      Object.defineProperty(error, 'code', { value: 'EEXIST' });
      throw error;
    }
    existingMode = existing.mode & 0o777;
  }

  const stagePath = join(dirname(outputPath), `.cursor-history-backup-${randomUUID()}.tmp`);
  let operationError: unknown;
  let publicationCommitted = false;
  try {
    await writeBoundedZipArchive(stagePath, entries, {
      ...(config.sourceReadLimits ? { sourceReadLimits: config.sourceReadLimits } : {}),
      ...(config.signal ? { signal: config.signal } : {}),
    });
    throwIfAborted(config.signal);

    const requestedMode = config.sharedPermissions
      ? 0o666 & ~process.umask()
      : (existingMode ?? 0o600);
    const stagedArchive = lstatSync(stagePath, { bigint: true });
    if (!stagedArchive.isFile()) {
      throw new Error('Completed backup stage is not a regular file.');
    }
    const publishedIdentity: PublishedArchiveIdentity = {
      device: stagedArchive.dev,
      inode: stagedArchive.ino,
    };

    publishBackupArchiveStage(
      stagePath,
      outputPath,
      Boolean(config.force),
      publishedIdentity,
      () => {
        publicationCommitted = true;
      }
    );
    // Rename/link is the publication commit point. Keep the unpublished sibling owner-only and
    // apply broader or inherited permissions only after the complete inode is visible. A redundant
    // chmod is skipped; a post-publication failure reports that the valid archive already exists.
    try {
      if (process.platform !== 'win32') {
        enforcePublishedArchiveMode(outputPath, requestedMode, publishedIdentity);
      }
    } finally {
      // The final directory durability attempt still belongs to the completed publication even
      // when applying its requested permissions fails afterward.
      syncParentDirectory(outputPath);
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    // Once rename/link commits, `stagePath` either no longer exists or is owned by the publication
    // helper's identity-bound cleanup. Never remove a later pathname occupant by name alone.
    if (!publicationCommitted) removePrivateArchiveStage(stagePath, operationError);
  }
}

/**
 * T012-T016: Create a full backup of all Cursor chat history
 */
export async function createBackup(config?: BackupConfig): Promise<BackupResult> {
  const startTime = Date.now();
  // Validate the immutable operation policy before touching a source or destination. Archive
  // creation consumes these bounds in T069; validating them here prevents a configuration from
  // being silently ignored during snapshot preparation.
  const readOptions = freezeSourceReadOptions({
    sourceReadLimits: config?.sourceReadLimits,
    signal: config?.signal,
  });
  const signal = readOptions.signal;
  throwIfAborted(signal);

  // Determine paths
  const sourcePath = config?.sourcePath ?? getDefaultCursorDataPath();
  const outputDir = config?.outputPath ? dirname(config.outputPath) : getDefaultBackupDir();
  const outputPath = config?.outputPath ?? join(outputDir, generateBackupFilename());
  const force = config?.force ?? false;
  const sharedPermissions = config?.sharedPermissions ?? false;
  const onProgress = config?.onProgress;

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // T016: Check if output file exists
  if (existsSync(outputPath) && !force) {
    return {
      success: false,
      backupPath: outputPath,
      manifest: createManifest([], { totalSize: 0, sessionCount: 0, workspaceCount: 0 }),
      durationMs: Date.now() - startTime,
      error: `File already exists: ${outputPath}. Use --force to overwrite.`,
    };
  }

  // Phase: Scanning
  onProgress?.({
    phase: 'scanning',
    filesCompleted: 0,
    totalFiles: 0,
    bytesCompleted: 0,
    totalBytes: 0,
  });

  // T008: Scan for database files
  const dbFiles = scanDatabaseFiles(sourcePath);
  throwIfAborted(signal);

  if (dbFiles.length === 0) {
    return {
      success: false,
      backupPath: outputPath,
      manifest: createManifest([], { totalSize: 0, sessionCount: 0, workspaceCount: 0 }),
      durationMs: Date.now() - startTime,
      error: `No Cursor data found at: ${sourcePath}`,
    };
  }

  const totalBytes = dbFiles.reduce((sum, f) => sum + f.size, 0);

  // T013: Check disk space
  const spaceCheck = checkDiskSpace(outputPath, totalBytes * 2); // 2x for temp + zip
  if (!spaceCheck.sufficient) {
    return {
      success: false,
      backupPath: outputPath,
      manifest: createManifest([], { totalSize: 0, sessionCount: 0, workspaceCount: 0 }),
      durationMs: Date.now() - startTime,
      error: `Insufficient disk space`,
    };
  }

  // Snapshot plaintext into flat, exclusive files inside one private workspace. ZIP entry paths
  // remain logical metadata and are never reused as temporary filesystem paths.
  const workspace = createPrivateTempWorkspace({
    prefix: 'cursor-history-backup-create-',
  });
  const stagedFiles: string[] = [];
  let operationError: unknown;

  try {
    // Phase: Backing up databases
    let bytesCompleted = 0;
    let sessionCount = 0;
    const workspaceIds = new Set<string>();
    const workspaceInventory = new Map<string, BackupComposerWorkspaceInventoryEntry>();
    const linkedSessionCandidatesByWorkspace = new Map<string, readonly string[]>();
    const globalComposerIds = new Set<string>();

    for (let i = 0; i < dbFiles.length; i++) {
      throwIfAborted(signal);
      const dbFile = dbFiles[i]!;

      onProgress?.({
        phase: 'backing-up',
        currentFile: dbFile.relativePath,
        filesCompleted: i,
        totalFiles: dbFiles.length,
        bytesCompleted,
        totalBytes,
      });

      const extension = dbFile.type === 'workspace-json' ? '.json' : '.vscdb';
      const tempFilePath = workspace.createFile(`snapshot-${i}${extension}`);
      stagedFiles.push(tempFilePath);

      // For SQLite databases, use backup API; for other files, just copy
      if (dbFile.type === 'global-db' || dbFile.type === 'workspace-db') {
        // T011: Backup database using SQLite backup API
        await backupDatabase(dbFile.absolutePath, tempFilePath);
      } else {
        // For non-DB files (like workspace.json), retain streaming archive behavior by copying the
        // private snapshot without materializing it as one aggregate buffer.
        copyFileSync(dbFile.absolutePath, tempFilePath);
      }
      if (process.platform !== 'win32') chmodSync(tempFilePath, 0o600);

      // Count sessions (only for DB files)
      if (dbFile.type === 'global-db' || dbFile.type === 'workspace-db') {
        const databaseInventory = inspectComposerDatabase(tempFilePath, readOptions);
        sessionCount += databaseInventory.sessionCount;
        if (dbFile.type === 'global-db') {
          for (const id of inspectGlobalComposerPayloadIds(tempFilePath, readOptions)) {
            globalComposerIds.add(id);
          }
        }
        if (dbFile.type === 'workspace-db' && dbFile.workspaceId) {
          workspaceInventory.set(dbFile.workspaceId, {
            workspaceId: dbFile.workspaceId,
            workspacePath: null,
            sessionIds: [...databaseInventory.sessionIds],
            globalCounterpartSessionIds: [],
            linkedGlobalSessionIds: [],
          });
          linkedSessionCandidatesByWorkspace.set(
            dbFile.workspaceId,
            databaseInventory.linkedSessionCandidates
          );
        }
      } else if (dbFile.type === 'workspace-json' && dbFile.workspaceId) {
        const existing = workspaceInventory.get(dbFile.workspaceId);
        if (existing) {
          workspaceInventory.set(dbFile.workspaceId, {
            ...existing,
            workspacePath: decodeWorkspacePathForManifest(tempFilePath),
          });
        }
      }
      if (dbFile.workspaceId) {
        workspaceIds.add(dbFile.workspaceId);
      }

      bytesCompleted += dbFile.size;
    }

    // Phase: Compressing
    onProgress?.({
      phase: 'compressing',
      filesCompleted: dbFiles.length,
      totalFiles: dbFiles.length,
      bytesCompleted: totalBytes,
      totalBytes,
    });

    const preparedFiles: readonly PreparedZipFileInput[] = await prepareZipFileInputs(
      dbFiles.map((dbFile, index) => ({
        name: dbFile.relativePath.split(sep).join('/'),
        sourcePath: stagedFiles[index]!,
      })),
      readOptions
    );
    const fileEntries: BackupFileEntry[] = preparedFiles.map((prepared, index) => ({
      path: prepared.name,
      size: prepared.size,
      checksum: prepared.checksum,
      type: dbFiles[index]!.type,
    }));

    // T015: Create and add manifest
    const stats: BackupStats = {
      totalSize: fileEntries.reduce((sum, f) => sum + f.size, 0),
      sessionCount,
      workspaceCount: workspaceIds.size,
    };
    const composerWorkspaceInventory: BackupComposerWorkspaceInventory = {
      schemaVersion: 1,
      workspaces: [...workspaceInventory.values()]
        .map((entry) => {
          const materializedByLogicalId = groupSessionIdSpellings(entry.sessionIds);
          const globalByLogicalId = groupSessionIdSpellings(globalComposerIds);
          const materializedLogicalIds = new Set(materializedByLogicalId.keys());
          // A materialized workspace spelling is the public identity authority for its own row.
          // The global counterpart relationship is logical, but its inventory value stays the
          // real workspace-native spelling so the lists remain subset-compatible.
          const globalCounterpartSessionIds = entry.sessionIds.filter((sessionId) =>
            globalByLogicalId.has(logicalSessionIdKey(sessionId))
          );
          const linkedGlobalSessionIds = [
            ...new Set(
              (linkedSessionCandidatesByWorkspace.get(entry.workspaceId) ?? []).flatMap(
                (candidate) => {
                  const logicalId = logicalSessionIdKey(candidate);
                  if (materializedLogicalIds.has(logicalId)) return [];
                  const verified = selectNativeSessionIdSpelling(
                    globalByLogicalId.get(logicalId) ?? []
                  );
                  return verified ? [verified] : [];
                }
              )
            ),
          ].sort(compareCodePoints);
          return { ...entry, globalCounterpartSessionIds, linkedGlobalSessionIds };
        })
        .sort((left, right) => compareCodePoints(left.workspaceId, right.workspaceId)),
    };
    const manifest = createManifest(fileEntries, stats, composerWorkspaceInventory);
    const manifestBuffer = serializeBackupManifest(manifest);
    const archiveEntries: BoundedZipWriteInput[] = [
      ...preparedFiles,
      { name: 'manifest.json', data: manifestBuffer },
    ];

    // Phase: Finalizing
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: dbFiles.length,
      totalFiles: dbFiles.length,
      bytesCompleted: totalBytes,
      totalBytes,
    });

    await writeAndPublishBackupArchive(outputPath, archiveEntries, {
      force,
      sharedPermissions,
      sourceReadLimits: readOptions.sourceReadLimits,
      signal,
    });

    return {
      success: true,
      backupPath: outputPath,
      manifest,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    disposePrivateWorkspace(workspace, operationError);
  }
}

// ============================================================================
// Backup Viewing (T025-T026)
// ============================================================================

function attachCleanupCause(cleanupError: unknown, operationError: unknown): void {
  if (
    cleanupError instanceof Error &&
    operationError !== undefined &&
    !Object.prototype.hasOwnProperty.call(cleanupError, 'cause')
  ) {
    Object.defineProperty(cleanupError, 'cause', {
      configurable: true,
      value: operationError,
    });
  }
}

function combineTemporaryCleanupErrors(
  first: TemporaryArtifactCleanupError,
  second: TemporaryArtifactCleanupError
): TemporaryArtifactCleanupError {
  const unverifiedResiduePaths = [
    ...new Set([...first.details.unverifiedResiduePaths, ...second.details.unverifiedResiduePaths]),
  ];
  const unverifiedResidueSet = new Set(unverifiedResiduePaths);
  const residuePaths = [
    ...new Set([...first.details.residuePaths, ...second.details.residuePaths]),
  ].filter((path) => !unverifiedResidueSet.has(path));
  const combined = new TemporaryArtifactCleanupError(residuePaths, unverifiedResiduePaths);
  Object.defineProperty(combined, 'cause', { configurable: true, value: first });
  return combined;
}

function disposePrivateWorkspace(workspace: PrivateTempWorkspace, operationError?: unknown): void {
  try {
    workspace.dispose();
  } catch (cleanupError) {
    if (
      operationError instanceof RestoreRollbackError &&
      cleanupError instanceof TemporaryArtifactCleanupError
    ) {
      const originalCause = Object.prototype.hasOwnProperty.call(operationError, 'cause')
        ? (operationError as Error & { cause: unknown }).cause
        : undefined;
      throw new RestoreRollbackError(
        operationError.details.publishedFileCount,
        operationError.details.residualFiles,
        originalCause,
        [
          new TemporaryArtifactCleanupError(
            operationError.details.residuePaths,
            operationError.details.unverifiedResiduePaths
          ),
          cleanupError,
        ]
      );
    }
    if (
      operationError instanceof TemporaryArtifactCleanupError &&
      cleanupError instanceof TemporaryArtifactCleanupError
    ) {
      throw combineTemporaryCleanupErrors(operationError, cleanupError);
    }
    attachCleanupCause(cleanupError, operationError);
    throw cleanupError;
  }
}

async function closeBoundedArchive(
  archive: BoundedZipArchive,
  operationError?: unknown
): Promise<void> {
  try {
    await archive.close();
  } catch (closeError) {
    attachCleanupCause(closeError, operationError);
    throw closeError;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function shouldPropagateBoundedReadError(error: unknown): boolean {
  return (
    error instanceof SourceLimitExceededError ||
    error instanceof SourceLimitConfigurationError ||
    error instanceof TemporaryArtifactCleanupError ||
    error instanceof IoObserverError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function withBoundedArchive<T>(
  backupPath: string,
  options: InternalSourceReadOptions,
  operation: (archive: BoundedZipArchive) => Promise<T>
): Promise<T> {
  let archive: BoundedZipArchive | undefined;
  let operationError: unknown;
  try {
    archive = await openBoundedZipArchive(backupPath, options);
    return await operation(archive);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (archive) {
      await closeBoundedArchive(archive, operationError);
    }
  }
}

function decodeManifest(buffer: Buffer): BackupManifest {
  let bytes = buffer;
  if (bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    bytes = bytes.subarray(UTF8_BOM.length);
  }
  if (bytes.indexOf(UTF8_BOM) >= 0) {
    throw new ZipArchiveFormatError('Backup manifest contains an unexpected UTF-8 BOM.');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ZipArchiveFormatError('Backup manifest is not deterministic UTF-8.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ZipArchiveFormatError(
      `Backup manifest JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ZipArchiveFormatError('Backup manifest root must be an object.');
  }
  const manifest = parsed as BackupManifest;
  // Discovery consumes manifest.files directly, so validate its complete
  // structural contract here rather than allowing malformed iterable shapes
  // or invalid references to masquerade as an empty archive.
  const files = validatedManifestFiles(manifest);
  validateComposerWorkspaceInventory(manifest, files);
  return manifest;
}

async function readManifestFromArchive(archive: BoundedZipArchive): Promise<BackupManifest | null> {
  if (!archive.getEntry('manifest.json')) return null;
  return decodeManifest(
    await archive.readEntryBuffer('manifest.json', BACKUP_METADATA_MEMORY_LIMIT)
  );
}

function validatedManifestFiles(manifest: BackupManifest): BackupFileEntry[] {
  if (!Array.isArray(manifest.files)) {
    throw new ZipArchiveFormatError('Backup manifest files must be an array.');
  }
  const destinationKeys = new Set<string>();
  return manifest.files.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ZipArchiveFormatError(`Backup manifest file ${index + 1} must be an object.`);
    }
    const entry = value as unknown as Record<string, unknown>;
    if (typeof entry['path'] !== 'string' || entry['path'].length === 0) {
      throw new ZipArchiveFormatError(`Backup manifest file ${index + 1} has an invalid path.`);
    }
    if (!Number.isSafeInteger(entry['size']) || Number(entry['size']) < 0) {
      throw new ZipArchiveFormatError(`Backup manifest file ${index + 1} has an invalid size.`);
    }
    if (
      typeof entry['checksum'] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/iu.test(entry['checksum'])
    ) {
      throw new ZipArchiveFormatError(`Backup manifest file ${index + 1} has an invalid checksum.`);
    }
    const type = entry['type'];
    if (
      type !== 'global-db' &&
      type !== 'workspace-db' &&
      type !== 'workspace-json' &&
      type !== 'manifest'
    ) {
      throw new ZipArchiveFormatError(`Backup manifest file ${index + 1} has an invalid type.`);
    }

    const path = entry['path'];
    const expectedType = backupEntryTypeForCanonicalPath(path);
    if (expectedType === undefined || type !== expectedType) {
      throw new ZipArchiveFormatError(
        `Backup manifest file ${index + 1} has an unsupported path/type combination.`
      );
    }

    // ZIP readers reject portable-name aliases too, but enforce destination uniqueness at the
    // manifest boundary so restore never depends on host case sensitivity or extraction order.
    const destinationKey = path.normalize('NFC').toLowerCase();
    if (destinationKeys.has(destinationKey)) {
      throw new ZipArchiveFormatError(
        `Backup manifest contains a duplicate restore destination: ${path}`
      );
    }
    destinationKeys.add(destinationKey);

    return {
      path,
      size: Number(entry['size']),
      checksum: entry['checksum'].toLowerCase(),
      type,
    };
  });
}

function isCanonicalBackupPathSegment(value: string): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value !== value.normalize('NFC') ||
    value.includes(':') ||
    /[\\/\0]/u.test(value) ||
    hasControlCharacter ||
    /[. ]$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    return false;
  }
  return true;
}

function backupEntryTypeForCanonicalPath(
  path: string
): Exclude<BackupFileEntry['type'], 'manifest'> | undefined {
  if (path === 'globalStorage/state.vscdb') return 'global-db';

  const match = /^workspaceStorage\/([^/]+)\/(state\.vscdb|workspace\.json)$/u.exec(path);
  if (!match || !isCanonicalBackupPathSegment(match[1]!)) return undefined;
  return match[2] === 'state.vscdb' ? 'workspace-db' : 'workspace-json';
}

function validateComposerWorkspaceInventory(
  manifest: BackupManifest,
  files: readonly BackupFileEntry[]
): void {
  const value = (manifest as unknown as Record<string, unknown>)['composerWorkspaceInventory'];
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZipArchiveFormatError(
      'Backup manifest Composer workspace inventory must be an object.'
    );
  }
  const inventory = value as Record<string, unknown>;
  if (inventory['schemaVersion'] !== 1) {
    throw new ZipArchiveFormatError(
      'Backup manifest Composer workspace inventory has an unsupported schema version.'
    );
  }
  if (!Array.isArray(inventory['workspaces'])) {
    throw new ZipArchiveFormatError(
      'Backup manifest Composer workspace inventory workspaces must be an array.'
    );
  }

  const expectedWorkspaceIds = files
    .filter(({ type }) => type === 'workspace-db')
    .map(({ path }) => /^workspaceStorage\/([^/]+)\/state\.vscdb$/u.exec(path)?.[1])
    .filter((workspaceId): workspaceId is string => workspaceId !== undefined)
    .sort(compareCodePoints);
  const containsGlobalDatabase = files.some(
    ({ type, path }) => type === 'global-db' && path === 'globalStorage/state.vscdb'
  );
  if (inventory['workspaces'].length !== expectedWorkspaceIds.length) {
    throw new ZipArchiveFormatError(
      'Backup manifest Composer workspace inventory does not cover every workspace database.'
    );
  }

  let previousWorkspaceId: string | undefined;
  for (let index = 0; index < inventory['workspaces'].length; index++) {
    const candidate = inventory['workspaces'][index];
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new ZipArchiveFormatError(
        `Backup manifest Composer workspace inventory entry ${index + 1} must be an object.`
      );
    }
    const entry = candidate as Record<string, unknown>;
    const workspaceId = entry['workspaceId'];
    if (
      typeof workspaceId !== 'string' ||
      workspaceId.length === 0 ||
      !isCanonicalBackupPathSegment(workspaceId)
    ) {
      throw new ZipArchiveFormatError(
        `Backup manifest Composer workspace inventory entry ${index + 1} has an invalid workspace ID.`
      );
    }
    if (
      previousWorkspaceId !== undefined &&
      compareCodePoints(previousWorkspaceId, workspaceId) >= 0
    ) {
      throw new ZipArchiveFormatError(
        'Backup manifest Composer workspace inventory entries are not canonically ordered and unique.'
      );
    }
    if (workspaceId !== expectedWorkspaceIds[index]) {
      throw new ZipArchiveFormatError(
        'Backup manifest Composer workspace inventory does not match its workspace databases.'
      );
    }
    previousWorkspaceId = workspaceId;

    const workspacePath = entry['workspacePath'];
    if (
      workspacePath !== null &&
      (typeof workspacePath !== 'string' || workspacePath.length === 0)
    ) {
      throw new ZipArchiveFormatError(
        `Backup manifest Composer workspace inventory entry ${index + 1} has an invalid workspace path.`
      );
    }
    const validateSessionIds = (
      field: 'sessionIds' | 'globalCounterpartSessionIds' | 'linkedGlobalSessionIds'
    ): string[] => {
      const sessionIds = entry[field];
      const label =
        field === 'sessionIds'
          ? 'session IDs'
          : field === 'globalCounterpartSessionIds'
            ? 'global counterpart session IDs'
            : 'linked global session IDs';
      if (!Array.isArray(sessionIds)) {
        throw new ZipArchiveFormatError(
          `Backup manifest Composer workspace inventory entry ${index + 1} ${label} must be an array.`
        );
      }
      let previousSessionId: string | undefined;
      for (const sessionId of sessionIds) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new ZipArchiveFormatError(
            `Backup manifest Composer workspace inventory entry ${index + 1} has an invalid ${label.slice(0, -1)}.`
          );
        }
        if (
          previousSessionId !== undefined &&
          compareCodePoints(previousSessionId, sessionId) >= 0
        ) {
          throw new ZipArchiveFormatError(
            `Backup manifest Composer workspace inventory entry ${index + 1} ${label} are not canonically ordered and unique.`
          );
        }
        previousSessionId = sessionId;
      }
      return sessionIds as string[];
    };
    const sessionIds = validateSessionIds('sessionIds');
    const globalCounterpartSessionIds = validateSessionIds('globalCounterpartSessionIds');
    const linkedGlobalSessionIds = validateSessionIds('linkedGlobalSessionIds');
    const materializedIds = new Set(sessionIds.map(logicalSessionIdKey));
    if (
      globalCounterpartSessionIds.some(
        (sessionId) => !materializedIds.has(logicalSessionIdKey(sessionId))
      )
    ) {
      throw new ZipArchiveFormatError(
        `Backup manifest Composer workspace inventory entry ${index + 1} has a global counterpart without a materialized workspace session.`
      );
    }
    if (
      linkedGlobalSessionIds.some((sessionId) =>
        materializedIds.has(logicalSessionIdKey(sessionId))
      )
    ) {
      throw new ZipArchiveFormatError(
        `Backup manifest Composer workspace inventory entry ${index + 1} overlaps materialized and linked global session IDs.`
      );
    }
    if (
      !containsGlobalDatabase &&
      (globalCounterpartSessionIds.length > 0 || linkedGlobalSessionIds.length > 0)
    ) {
      throw new ZipArchiveFormatError(
        `Backup manifest Composer workspace inventory entry ${index + 1} declares global sessions without a global database entry.`
      );
    }
  }
}

interface StagedBackupFile {
  readonly manifestEntry: BackupFileEntry;
  readonly archiveEntryName: string;
  readonly temporaryPath?: string;
}

interface PlannedRestoreFile extends StagedBackupFile {
  readonly trustedRoot: string;
  readonly destinationPath: string;
}

interface ArchiveInspection {
  readonly validation: BackupValidation;
  readonly stagedFiles: StagedBackupFile[];
}

async function inspectArchive(
  archive: BoundedZipArchive,
  options: SourceReadOptions,
  workspace?: PrivateTempWorkspace
): Promise<ArchiveInspection> {
  const manifest = await readManifestFromArchive(archive);
  if (!manifest) {
    return {
      validation: {
        status: 'invalid',
        validFiles: [],
        corruptedFiles: [],
        missingFiles: [],
        errors: ['Manifest file not found in backup'],
      },
      stagedFiles: [],
    };
  }

  const manifestFiles = validatedManifestFiles(manifest);
  const validFiles: string[] = [];
  const corruptedFiles: string[] = [];
  const missingFiles: string[] = [];
  const stagedFiles: StagedBackupFile[] = [];
  const representedNames = new Set<string>();

  for (let index = 0; index < manifestFiles.length; index++) {
    throwIfAborted(options.signal);
    const fileEntry = manifestFiles[index]!;
    const archiveEntry = archive.getEntry(fileEntry.path);
    if (!archiveEntry || archiveEntry.isDirectory) {
      missingFiles.push(fileEntry.path);
      continue;
    }
    if (archiveEntry.name !== fileEntry.path.normalize('NFC')) {
      throw new ZipArchiveFormatError('Manifest path is not the canonical ZIP entry name.');
    }
    if (representedNames.has(archiveEntry.name)) {
      throw new ZipArchiveFormatError(`Manifest contains a duplicate file: ${archiveEntry.name}`);
    }
    representedNames.add(archiveEntry.name);

    let checksum: string;
    let temporaryPath: string | undefined;
    if (workspace) {
      temporaryPath = workspace.createFile(`restore-${index}.bin`);
      checksum = (await archive.extractEntryToFileWithChecksum(archiveEntry.name, temporaryPath))
        .checksum;
    } else {
      checksum = (await archive.checksumEntry(archiveEntry.name)).checksum;
    }

    if (archiveEntry.uncompressedSize === fileEntry.size && checksum === fileEntry.checksum) {
      validFiles.push(fileEntry.path);
      stagedFiles.push({
        manifestEntry: fileEntry,
        archiveEntryName: archiveEntry.name,
        ...(temporaryPath ? { temporaryPath } : {}),
      });
    } else {
      corruptedFiles.push(fileEntry.path);
    }
  }

  for (const archiveEntry of archive.entries) {
    if (
      !archiveEntry.isDirectory &&
      archiveEntry.name !== 'manifest.json' &&
      !representedNames.has(archiveEntry.name)
    ) {
      throw new ZipArchiveFormatError(
        `Backup contains an unmanifested file entry: ${archiveEntry.name}`
      );
    }
  }

  const errors: string[] = [];
  if (missingFiles.length > 0) errors.push(`Missing files: ${missingFiles.join(', ')}`);
  if (corruptedFiles.length > 0) errors.push(`Corrupted files: ${corruptedFiles.join(', ')}`);
  if (validFiles.length === 0) errors.push('No intact restorable files found in backup');
  const status =
    missingFiles.length > 0 || validFiles.length === 0
      ? 'invalid'
      : corruptedFiles.length > 0
        ? 'warnings'
        : 'valid';

  return {
    validation: {
      status,
      manifest,
      validFiles,
      corruptedFiles,
      missingFiles,
      errors,
    },
    stagedFiles,
  };
}

/** Wrapper that always disposes the private plaintext snapshot workspace. */
class TempFileCleanupWrapper implements DatabaseInterface {
  private closed = false;

  constructor(
    private innerDb: DatabaseInterface,
    private workspace: PrivateTempWorkspace
  ) {}

  prepare(sql: string): Statement {
    return this.innerDb.prepare(sql);
  }

  runSQL(sql: string): void {
    this.innerDb.runSQL(sql);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let closeError: unknown;
    try {
      this.innerDb.close();
    } catch (error) {
      closeError = error;
    }

    try {
      this.workspace.dispose();
    } catch (cleanupError) {
      attachCleanupCause(cleanupError, closeError);
      throw cleanupError;
    }

    if (closeError !== undefined) throw closeError;
  }
}

/**
 * T025: Open a database from a backup zip file
 * Uses the pluggable driver system to open the database.
 * Extracts to a temp file since SQLite needs file access.
 * Returns a Database interface compatible with the pluggable driver system.
 */
export async function openBackupDatabase(
  backupPath: string,
  dbPath: string,
  options: BackupDatabaseReadOptions = {}
): Promise<DatabaseInterface> {
  const sqliteDriver = options.sqliteDriver;
  const readOptions = freezeSourceReadOptions(options);
  throwIfAborted(readOptions.signal);
  let workspace: PrivateTempWorkspace | undefined;
  let db: DatabaseInterface | undefined;
  let operationError: unknown;
  try {
    const tempFile = await withBoundedArchive(backupPath, readOptions, async (archive) => {
      const manifest = await readManifestFromArchive(archive);
      if (!manifest) {
        throw new ZipArchiveFormatError('Manifest file not found in backup.');
      }
      const manifestFiles = validatedManifestFiles(manifest);
      const entry = archive.getEntry(dbPath);
      if (!entry || entry.isDirectory) {
        throw new BackupEntryNotFoundError(dbPath);
      }
      const manifestEntry = manifestFiles.find(({ path }) => path === dbPath);
      if (!manifestEntry) {
        throw new ZipArchiveFormatError(
          `Backup database is not declared by the manifest: ${dbPath}`
        );
      }
      if (entry.name !== manifestEntry.path.normalize('NFC')) {
        throw new ZipArchiveFormatError('Manifest path is not the canonical ZIP entry name.');
      }
      if (entry.uncompressedSize !== manifestEntry.size) {
        throw new ZipArchiveFormatError(
          `Backup database size does not match its manifest: ${dbPath}`
        );
      }
      workspace = createPrivateTempWorkspace({
        prefix: 'cursor-history-backup-read-',
      });
      const snapshotPath = workspace.createFile('state.vscdb');
      const extracted = await archive.extractEntryToFileWithChecksum(entry.name, snapshotPath);
      if (extracted.checksum !== manifestEntry.checksum) {
        throw new ZipArchiveFormatError(
          `Backup database checksum does not match its manifest: ${dbPath}`
        );
      }
      return snapshotPath;
    });

    throwIfAborted(readOptions.signal);
    db = await openDatabase(
      tempFile,
      backupDatabaseReadRequest(sqliteDriver, readOptions.io, dbPath, options.logicalSessionId)
    );
    throwIfAborted(readOptions.signal);
    return new TempFileCleanupWrapper(db, workspace!);
  } catch (error) {
    operationError = error;
    let closeError: unknown;
    if (db) {
      try {
        db.close();
      } catch (candidate) {
        closeError = candidate;
        attachCleanupCause(closeError, operationError);
      }
    }
    if (workspace) {
      try {
        workspace.dispose();
      } catch (cleanupError) {
        attachCleanupCause(cleanupError, closeError ?? operationError);
        throw cleanupError;
      }
    }
    if (closeError !== undefined) throw closeError;
    throw error;
  }
}

/**
 * Read one small metadata entry through the bounded ZIP reader.
 *
 * Missing entries return `null`; malformed archives, source-limit failures,
 * cancellation, and I/O failures remain fatal to the owning read operation.
 */
export async function readBackupEntryBuffer(
  backupPath: string,
  entryPath: string,
  options: SourceReadOptions = {},
  maxBytes = BACKUP_METADATA_MEMORY_LIMIT
): Promise<Buffer | null> {
  const readOptions = freezeSourceReadOptions(options);
  return withBoundedArchive(backupPath, readOptions, async (archive) => {
    throwIfAborted(readOptions.signal);
    const manifest = await readManifestFromArchive(archive);
    if (!manifest) throw new ZipArchiveFormatError('Manifest file not found in backup.');
    const manifestEntry = validatedManifestFiles(manifest).find(({ path }) => path === entryPath);
    const entry = archive.getEntry(entryPath);
    if (!entry || entry.isDirectory) {
      if (manifestEntry) {
        throw new ZipArchiveFormatError(`Manifest-declared backup entry is missing: ${entryPath}`);
      }
      return null;
    }
    if (!manifestEntry) {
      throw new ZipArchiveFormatError(`Backup entry is not declared by the manifest: ${entryPath}`);
    }
    if (entry.name !== manifestEntry.path.normalize('NFC')) {
      throw new ZipArchiveFormatError('Manifest path is not the canonical ZIP entry name.');
    }
    if (entry.uncompressedSize !== manifestEntry.size) {
      throw new ZipArchiveFormatError(
        `Backup entry size does not match its manifest: ${entryPath}`
      );
    }
    const value = await archive.readEntryBuffer(entry.name, maxBytes);
    if (computeChecksum(value) !== manifestEntry.checksum) {
      throw new ZipArchiveFormatError(
        `Backup entry checksum does not match its manifest: ${entryPath}`
      );
    }
    throwIfAborted(readOptions.signal);
    return value;
  });
}

/**
 * Read manifest from a backup file
 */
export async function readBackupManifest(
  backupPath: string,
  options: SourceReadOptions = {}
): Promise<BackupManifest | null> {
  const readOptions = freezeSourceReadOptions(options);
  try {
    return await withBoundedArchive(backupPath, readOptions, readManifestFromArchive);
  } catch (error) {
    // A present but malformed archive/manifest is not the same as a missing
    // optional manifest. Owning reads must not turn CRC, encoding, or JSON
    // integrity failures into an apparently empty backup.
    if (error instanceof ZipArchiveFormatError) throw error;
    if (shouldPropagateBoundedReadError(error)) throw error;
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * T026: Validate backup integrity
 */
export async function validateBackup(
  backupPath: string,
  options: SourceReadOptions = {}
): Promise<BackupValidation> {
  const readOptions = freezeSourceReadOptions(options);
  try {
    return await withBoundedArchive(
      backupPath,
      readOptions,
      async (archive) => (await inspectArchive(archive, readOptions)).validation
    );
  } catch (error) {
    if (shouldPropagateBoundedReadError(error)) throw error;
    const prefix = errorCode(error) === 'ENOENT' ? 'Backup file not found' : 'Invalid zip file';
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [`${prefix}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

type RestoreLeafKind = 'directory' | 'file';

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Inspect every existing component without following links.
 *
 * Node 20 does not expose portable openat-style directory descriptors, so restore validates the
 * complete chain before publication and repeats the check immediately before each copy. This
 * rejects static symlinks/junctions and dangling links instead of letting existsSync hide them.
 */
function assertNoLinkedRestorePath(
  trustedRoot: string,
  path: string,
  leafKind: RestoreLeafKind
): boolean {
  const absoluteRoot = resolve(trustedRoot);
  const absolutePath = resolve(path);
  const suffix = relative(absoluteRoot, absolutePath);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`Restore destination escapes the Cursor data directory: ${absolutePath}`);
  }
  const components = suffix === '' ? [] : suffix.split(sep);
  let currentPath = absoluteRoot;
  let missingAncestor = false;

  const rootStats = lstatIfPresent(absoluteRoot);
  if (rootStats && !rootStats.isDirectory()) {
    throw new Error(`Restore target root is not a directory: ${absoluteRoot}`);
  }

  for (let index = 0; index < components.length; index++) {
    currentPath = join(currentPath, components[index]!);
    const stats = lstatIfPresent(currentPath);
    if (!stats) {
      missingAncestor = true;
      continue;
    }
    if (missingAncestor) {
      throw new Error(`Restore target has an inconsistent filesystem path: ${currentPath}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Restore target traverses an unsafe filesystem link: ${currentPath}`);
    }

    const isLeaf = index === components.length - 1;
    if (!isLeaf || leafKind === 'directory') {
      if (!stats.isDirectory()) {
        throw new Error(`Restore target ancestor is not a directory: ${currentPath}`);
      }
    } else if (!stats.isFile()) {
      throw new Error(`Restore destination is not a regular file: ${currentPath}`);
    }
  }

  return !missingAncestor;
}

function isConfinedRestoreDestination(userDir: string, destinationPath: string): boolean {
  const relativePath = relative(userDir, destinationPath);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function planRestoreFiles(
  userDir: string,
  stagedFiles: readonly StagedBackupFile[]
): PlannedRestoreFile[] {
  const requestedUserDir = resolve(userDir);
  const rootStats = lstatIfPresent(requestedUserDir);
  let absoluteUserDir = requestedUserDir;
  if (rootStats?.isDirectory()) {
    absoluteUserDir = realpathSync(requestedUserDir);
  }
  assertNoLinkedRestorePath(absoluteUserDir, absoluteUserDir, 'directory');
  const destinationKeys = new Set<string>();

  return stagedFiles.map((staged) => {
    // The manifest schema has already admitted only fixed-depth canonical Cursor data paths.
    // Resolve again at the filesystem boundary so a future schema extension cannot accidentally
    // turn an archive locator into an unconstrained destination.
    const destinationPath = resolve(absoluteUserDir, ...staged.archiveEntryName.split('/'));
    if (!isConfinedRestoreDestination(absoluteUserDir, destinationPath)) {
      throw new Error(`Restore destination escapes the Cursor data directory: ${destinationPath}`);
    }
    const destinationKey = destinationPath.normalize('NFC').toLowerCase();
    if (destinationKeys.has(destinationKey)) {
      throw new Error(`Backup resolves to a duplicate restore destination: ${destinationPath}`);
    }
    destinationKeys.add(destinationKey);
    assertNoLinkedRestorePath(absoluteUserDir, destinationPath, 'file');
    return { ...staged, trustedRoot: absoluteUserDir, destinationPath };
  });
}

function existingRestoreDestinations(plans: readonly PlannedRestoreFile[]): string[] {
  return plans
    .filter(({ trustedRoot, destinationPath }) =>
      assertNoLinkedRestorePath(trustedRoot, destinationPath, 'file')
    )
    .map(({ manifestEntry }) => manifestEntry.path);
}

function restoreReadFlags(): number {
  let flags = constants.O_RDONLY;
  if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW;
  return flags;
}

function restoreStageFlags(): number {
  let flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW;
  return flags;
}

function copyOpenFileContents(sourceDescriptor: number, targetDescriptor: number): void {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    let offset = 0;
    while (offset < bytesRead) {
      const bytesWritten = writeSync(targetDescriptor, buffer, offset, bytesRead - offset, null);
      if (bytesWritten <= 0) throw new Error('Unable to copy restore data safely.');
      offset += bytesWritten;
    }
  }
}

/**
 * Copy one private validated entry into a new same-directory inode and atomically replace the
 * destination directory entry. Existing destinations are never opened for writing, so force mode
 * cannot truncate a hard-linked inode outside the selected Cursor tree.
 */
function publishRestoreFile(
  trustedRoot: string,
  sourcePath: string,
  destinationPath: string,
  replaceExisting: boolean,
  onCommit?: (identity: PublishedArchiveIdentity) => void,
  mode = 0o600
): void {
  assertNoLinkedRestorePath(trustedRoot, dirname(destinationPath), 'directory');
  assertNoLinkedRestorePath(trustedRoot, destinationPath, 'file');

  const publicationPath = join(
    dirname(destinationPath),
    `.cursor-history-restore-${randomUUID()}.tmp`
  );
  let sourceDescriptor: number | undefined;
  let publicationDescriptor: number | undefined;
  let publicationIdentity: PublishedArchiveIdentity | undefined;
  let publicationCommitted = false;
  let operationError: unknown;
  let cleanupError: TemporaryArtifactCleanupError | undefined;
  try {
    sourceDescriptor = openSync(sourcePath, restoreReadFlags());
    if (!fstatSync(sourceDescriptor).isFile()) {
      throw new Error('Private restore staging is not a regular file.');
    }
    publicationDescriptor = openSync(publicationPath, restoreStageFlags(), mode);
    const publicationStats = fstatSync(publicationDescriptor, { bigint: true });
    if (!publicationStats.isFile()) {
      throw new Error('Private restore publication staging is not a regular file.');
    }
    publicationIdentity = { device: publicationStats.dev, inode: publicationStats.ino };
    if (process.platform !== 'win32') fchmodSync(publicationDescriptor, mode);

    copyOpenFileContents(sourceDescriptor, publicationDescriptor);
    fsyncSync(publicationDescriptor);
    closeSync(publicationDescriptor);
    publicationDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;

    // Recheck after the complete inode is durable and immediately before the directory-entry
    // commit. Node 20 still cannot bind the ancestor chain through openat-style descriptors; that
    // owner-controlled-tree limitation is documented on the public restore contract.
    assertNoLinkedRestorePath(trustedRoot, dirname(destinationPath), 'directory');
    assertNoLinkedRestorePath(trustedRoot, destinationPath, 'file');
    commitRestorePublication(
      publicationPath,
      destinationPath,
      replaceExisting,
      publicationIdentity!,
      () => {
        publicationCommitted = true;
        onCommit?.(publicationIdentity!);
      }
    );
    syncParentDirectory(destinationPath);
  } catch (error) {
    operationError = error;
  } finally {
    for (const descriptor of [publicationDescriptor, sourceDescriptor]) {
      if (descriptor === undefined) continue;
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the publication failure; the private path cleanup below remains mandatory.
      }
    }
    if (!publicationCommitted) {
      try {
        unlinkSync(publicationPath);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          cleanupError = new TemporaryArtifactCleanupError([publicationPath]);
          attachCleanupCause(cleanupError, operationError ?? error);
        }
      }
    }
  }
  if (cleanupError) throw cleanupError;
  if (operationError !== undefined) throw operationError;
}

// ============================================================================
// Restore Operations (T040-T045)
// ============================================================================

/**
 * T040-T045: Restore backup to Cursor data directory
 */
export async function restoreBackup(config: RestoreConfig): Promise<RestoreResult> {
  const startTime = Date.now();
  const backupPath = config.backupPath;
  const targetPath = config.targetPath ?? getDefaultCursorDataPath();
  const force = config.force ?? false;
  const onProgress = config.onProgress;
  const readOptions = freezeSourceReadOptions({
    sourceReadLimits: config.sourceReadLimits,
    signal: config.signal,
  });
  const signal = readOptions.signal;
  throwIfAborted(signal);

  // Phase: Validating
  onProgress?.({
    phase: 'validating',
    filesCompleted: 0,
    totalFiles: 0,
    integrityStatus: 'pending',
  });
  throwIfAborted(signal);

  const workspace = createPrivateTempWorkspace({
    prefix: 'cursor-history-restore-',
  });
  const restoredFiles: Array<{ manifestPath: string }> = [];
  let operationError: unknown;
  try {
    const inspection = await withBoundedArchive(backupPath, readOptions, (archive) =>
      inspectArchive(archive, readOptions, workspace)
    );
    throwIfAborted(signal);
    const validation = inspection.validation;
    if (validation.status === 'invalid') {
      return {
        success: false,
        targetPath,
        filesRestored: 0,
        warnings: [],
        durationMs: Date.now() - startTime,
        error: validation.errors.join('; '),
      };
    }

    const manifest = validation.manifest!;
    const userDir = resolve(dirname(targetPath));
    const restorePlan = planRestoreFiles(userDir, inspection.stagedFiles);
    const existingDestinations = existingRestoreDestinations(restorePlan);
    if (!force && existingDestinations.length > 0) {
      return {
        success: false,
        targetPath,
        filesRestored: 0,
        warnings: [],
        durationMs: Date.now() - startTime,
        error: `Target already has Cursor data at: ${existingDestinations.join(', ')}. Use --force to overwrite.`,
      };
    }

    onProgress?.({
      phase: 'validating',
      filesCompleted: 0,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
      corruptedFiles: validation.corruptedFiles,
    });
    throwIfAborted(signal);

    const warnings = validation.corruptedFiles.map(
      (file) => `Integrity mismatch (size or checksum); skipped: ${file}`
    );

    // Create every required directory and then revalidate the complete target set before the first
    // file publication. This makes a late-path collision or static link fail with zero file writes.
    for (const planned of restorePlan) {
      assertNoLinkedRestorePath(planned.trustedRoot, dirname(planned.destinationPath), 'directory');
      mkdirSync(dirname(planned.destinationPath), { recursive: true });
    }
    const trustedRoot = restorePlan[0]?.trustedRoot ?? resolve(userDir);
    assertNoLinkedRestorePath(trustedRoot, trustedRoot, 'directory');
    const postCreationDestinations = existingRestoreDestinations(restorePlan);
    if (!force && postCreationDestinations.length > 0) {
      throw new Error(
        `Target already has Cursor data at: ${postCreationDestinations.join(', ')}. Use --force to overwrite.`
      );
    }

    for (let index = 0; index < restorePlan.length; index++) {
      throwIfAborted(signal);
      const staged = restorePlan[index]!;
      if (!staged.temporaryPath) {
        throw new Error(`Private restore staging is missing: ${staged.manifestEntry.path}`);
      }

      onProgress?.({
        phase: 'extracting',
        currentFile: staged.manifestEntry.path,
        filesCompleted: index,
        totalFiles: inspection.stagedFiles.length,
        integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
        corruptedFiles: validation.corruptedFiles,
      });
      throwIfAborted(signal);

      throwIfAborted(signal);
      const destinationExists = assertNoLinkedRestorePath(
        staged.trustedRoot,
        staged.destinationPath,
        'file'
      );
      if (!force && destinationExists) {
        throw new Error(
          `Target already has Cursor data at: ${staged.manifestEntry.path}. Use --force to overwrite.`
        );
      }
      throwIfAborted(signal);
      publishRestoreFile(
        staged.trustedRoot,
        staged.temporaryPath,
        staged.destinationPath,
        force,
        () => {
          restoredFiles.push({ manifestPath: staged.manifestEntry.path });
        }
      );
    }

    // Phase: Finalizing
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: inspection.stagedFiles.length,
      totalFiles: inspection.stagedFiles.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    });
    throwIfAborted(signal);

    return {
      success: true,
      targetPath,
      filesRestored: restoredFiles.length,
      warnings,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    operationError = error;
    // Portable Node filesystem APIs cannot atomically prove that a pathname still names the inode
    // published above and then replace or unlink that same directory entry. A check followed by a
    // mutation therefore has an unavoidable leaf TOCTOU window. Once any entry has crossed its
    // publication commit point, fail closed: leave every destination pathname untouched, report
    // every published entry as residual, and let the owner-private workspace cleanup run in the
    // outer finally block.
    if (restoredFiles.length > 0) {
      const restoreError = new RestoreRollbackError(
        restoredFiles.length,
        restoredFiles.map(({ manifestPath }) => manifestPath),
        error
      );
      operationError = restoreError;
      throw restoreError;
    }

    if (shouldPropagateBoundedReadError(error)) throw error;

    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings: [],
      durationMs: Date.now() - startTime,
      error: `${errorCode(error) === 'ENOENT' ? 'Backup file not found' : 'Restore failed'}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    disposePrivateWorkspace(workspace, operationError);
  }
}

// ============================================================================
// Backup Listing (T055-T057)
// ============================================================================

/**
 * T055-T057: List all backup files in a directory
 */
export async function listBackups(
  directory?: string,
  options: SourceReadOptions = {}
): Promise<BackupInfo[]> {
  // Invalid policy input is rejected before touching the directory, even when it does not exist.
  const readOptions = freezeSourceReadOptions(options);
  const signal = readOptions.signal;
  throwIfAborted(signal);
  const dir = directory ?? getDefaultBackupDir();

  if (!existsSync(dir)) {
    return [];
  }

  const backups: BackupInfo[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.isFile() || !entry.name.endsWith('.zip')) {
        continue;
      }

      const filePath = join(dir, entry.name);
      const stat = statSync(filePath);

      const info: BackupInfo = {
        filePath,
        filename: entry.name,
        fileSize: stat.size,
        modifiedAt: stat.mtime,
      };

      // Try to read manifest
      try {
        const manifest = await readBackupManifest(filePath, readOptions);
        if (manifest) {
          info.manifest = manifest;
        } else {
          info.error = 'No manifest found';
        }
      } catch (e) {
        if (shouldPropagateBoundedReadError(e)) throw e;
        info.error = e instanceof Error ? e.message : String(e);
      }

      backups.push(info);
    }
  } catch (error) {
    if (shouldPropagateBoundedReadError(error)) throw error;
    // Directory might not be readable
  }

  // Sort by modification time, newest first
  backups.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  return backups;
}

// ============================================================================
// Helper to get default Cursor data path (imported from platform)
// ============================================================================

function getDefaultCursorDataPath(): string {
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return join(
        process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'workspaceStorage'
      );
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    default:
      return join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
  }
}
