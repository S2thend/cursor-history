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
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, dirname, sep } from 'node:path';
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
import { createComposerSqliteBudget, readBoundedComposerValueByKey } from './composer-sqlite.js';
import { IoObserverError, type OperationIoContext } from './io-observer.js';
import {
  SourceLimitConfigurationError,
  SourceLimitExceededError,
  TemporaryArtifactCleanupError,
} from './errors.js';
import {
  enforcePublishedArchiveMode,
  type PublishedArchiveIdentity,
} from './backup-publication.js';
import type {
  BackupManifest,
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
export function createManifest(files: BackupFileEntry[], stats: BackupStats): BackupManifest {
  const platform = process.platform as 'darwin' | 'win32' | 'linux';

  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    sourcePlatform: platform,
    producer: PACKAGE_VERSION,
    cursorHistoryVersion: PACKAGE_VERSION,
    files,
    stats,
  };
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

function countSessions(dbPath: string, readOptions: Readonly<InternalSourceReadOptions>): number {
  throwIfAborted(readOptions.signal);
  const db = registry.openSync(dbPath, { readonly: true });
  let operationError: unknown;
  try {
    let value: string | undefined;
    try {
      value = readBoundedComposerValueByKey(
        db,
        'ItemTable',
        'composer.composerData',
        createComposerSqliteBudget(resolveSourceReadLimits(readOptions.sourceReadLimits)),
        readOptions.signal
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:no such table|does not exist).*\bItemTable\b/iu.test(error.message)
      ) {
        return 0;
      }
      throw error;
    }
    if (!value) return 0;

    const data = JSON.parse(value) as { allComposers?: unknown[] } | unknown[];
    if (Array.isArray(data)) return data.length;
    if (data.allComposers && Array.isArray(data.allComposers)) {
      return data.allComposers.length;
    }
    return 0;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    closeSessionCountDatabase(db, operationError);
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

    if (config.force) {
      renameSync(stagePath, outputPath);
    } else {
      // A same-directory hard link publishes without replacing a target created by a racing
      // process. Unlinking the private sibling leaves the final path on the complete inode.
      linkSync(stagePath, outputPath);
      unlinkSync(stagePath);
    }
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
    removePrivateArchiveStage(stagePath, operationError);
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
        sessionCount += countSessions(tempFilePath, readOptions);
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
    const manifest = createManifest(fileEntries, stats);
    const archiveEntries: BoundedZipWriteInput[] = [
      ...preparedFiles,
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
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

function disposePrivateWorkspace(workspace: PrivateTempWorkspace, operationError?: unknown): void {
  try {
    workspace.dispose();
  } catch (cleanupError) {
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
  validatedManifestFiles(manifest);
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
  const allowedTypes = new Set<BackupFileEntry['type']>([
    'global-db',
    'workspace-db',
    'workspace-json',
    'manifest',
  ]);
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
    if (!allowedTypes.has(entry['type'] as BackupFileEntry['type'])) {
      throw new ZipArchiveFormatError(`Backup manifest file ${index + 1} has an invalid type.`);
    }
    return {
      path: entry['path'],
      size: Number(entry['size']),
      checksum: entry['checksum'].toLowerCase(),
      type: entry['type'] as BackupFileEntry['type'],
    };
  });
}

interface StagedBackupFile {
  readonly manifestEntry: BackupFileEntry;
  readonly archiveEntryName: string;
  readonly temporaryPath?: string;
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
    } else {
      corruptedFiles.push(fileEntry.path);
    }
    stagedFiles.push({
      manifestEntry: fileEntry,
      archiveEntryName: archiveEntry.name,
      ...(temporaryPath ? { temporaryPath } : {}),
    });
  }

  const errors: string[] = [];
  if (missingFiles.length > 0) errors.push(`Missing files: ${missingFiles.join(', ')}`);
  if (corruptedFiles.length > 0) errors.push(`Corrupted files: ${corruptedFiles.join(', ')}`);
  const status =
    missingFiles.length > 0 || (corruptedFiles.length > 0 && validFiles.length === 0)
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
      const entry = archive.getEntry(dbPath);
      if (!entry || entry.isDirectory) {
        throw new BackupEntryNotFoundError(dbPath);
      }
      workspace = createPrivateTempWorkspace({
        prefix: 'cursor-history-backup-read-',
      });
      const snapshotPath = workspace.createFile('state.vscdb');
      await archive.extractEntryToFile(entry.name, snapshotPath);
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
    const entry = archive.getEntry(entryPath);
    if (!entry || entry.isDirectory) return null;
    const value = await archive.readEntryBuffer(entry.name, maxBytes);
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
  const restoredFiles: Array<{
    manifestPath: string;
    destinationPath: string;
    previousPath?: string;
  }> = [];
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
    const userDir = dirname(targetPath);
    const globalDbPath = join(userDir, 'globalStorage', 'state.vscdb');
    if (!force && existsSync(globalDbPath)) {
      return {
        success: false,
        targetPath,
        filesRestored: 0,
        warnings: [],
        durationMs: Date.now() - startTime,
        error: `Target already has Cursor data: ${userDir}. Use --force to overwrite.`,
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

    const warnings = validation.corruptedFiles.map((file) => `Checksum mismatch: ${file}`);
    for (let index = 0; index < inspection.stagedFiles.length; index++) {
      throwIfAborted(signal);
      const staged = inspection.stagedFiles[index]!;
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

      const platformPath = staged.archiveEntryName.split('/').join(sep);
      const destPath = join(userDir, platformPath);
      throwIfAborted(signal);
      mkdirSync(dirname(destPath), { recursive: true });
      let previousPath: string | undefined;
      if (existsSync(destPath)) {
        previousPath = workspace.createFile(`previous-${index}.bin`);
        copyFileSync(destPath, previousPath);
      }
      restoredFiles.push({
        manifestPath: staged.manifestEntry.path,
        destinationPath: destPath,
        ...(previousPath ? { previousPath } : {}),
      });
      throwIfAborted(signal);
      copyFileSync(staged.temporaryPath, destPath);
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
    for (const restored of [...restoredFiles].reverse()) {
      try {
        if (restored.previousPath) {
          copyFileSync(restored.previousPath, restored.destinationPath);
        } else if (existsSync(restored.destinationPath)) {
          unlinkSync(restored.destinationPath);
        }
      } catch {
        // Preserve the primary operation failure; rollback residue remains at the explicit target.
      }
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
