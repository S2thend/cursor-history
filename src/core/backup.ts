/**
 * Core backup and restore functionality
 *
 * This module provides low-level backup operations:
 * - SQLite database backup using better-sqlite3 backup API
 * - Zip creation/extraction using adm-zip
 * - Manifest generation with checksums
 * - Integrity validation
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync, rmdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename, dirname, sep } from 'node:path';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
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
} from './types.js';

// Package version for manifest
const CURSOR_HISTORY_VERSION = '0.8.0';
const MANIFEST_VERSION = '1.0.0';

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
  stats: BackupStats
): BackupManifest {
  const platform = process.platform as 'darwin' | 'win32' | 'linux';

  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    sourcePlatform: platform,
    cursorHistoryVersion: CURSOR_HISTORY_VERSION,
    files,
    stats,
  };
}

/**
 * Count sessions in a database file
 */
function countSessions(dbPath: string): number {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      // Try to read composer data
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as
        | { value: string }
        | undefined;
      if (row) {
        const data = JSON.parse(row.value) as { allComposers?: unknown[] } | unknown[];
        if (Array.isArray(data)) {
          return data.length;
        }
        if (data.allComposers && Array.isArray(data.allComposers)) {
          return data.allComposers.length;
        }
      }
      return 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

// ============================================================================
// Backup Operations (T011-T016)
// ============================================================================

/**
 * T011: Backup a single database file using SQLite backup API
 * This ensures a consistent snapshot even if Cursor is running
 */
export async function backupDatabase(sourcePath: string, destPath: string): Promise<void> {
  const sourceDb = new Database(sourcePath, { readonly: true });
  try {
    await sourceDb.backup(destPath);
  } finally {
    sourceDb.close();
  }
}

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

/**
 * T012-T016: Create a full backup of all Cursor chat history
 */
export async function createBackup(config?: BackupConfig): Promise<BackupResult> {
  const startTime = Date.now();

  // Determine paths
  const sourcePath = config?.sourcePath ?? getDefaultCursorDataPath();
  const outputDir = config?.outputPath ? dirname(config.outputPath) : getDefaultBackupDir();
  const outputPath = config?.outputPath ?? join(outputDir, generateBackupFilename());
  const force = config?.force ?? false;
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

  // Create temp directory for backed up databases
  const tempDir = join(outputDir, `.backup_temp_${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    // Phase: Backing up databases
    const fileEntries: BackupFileEntry[] = [];
    let bytesCompleted = 0;
    let sessionCount = 0;
    const workspaceIds = new Set<string>();

    for (let i = 0; i < dbFiles.length; i++) {
      const dbFile = dbFiles[i]!;

      onProgress?.({
        phase: 'backing-up',
        currentFile: dbFile.relativePath,
        filesCompleted: i,
        totalFiles: dbFiles.length,
        bytesCompleted,
        totalBytes,
      });

      // Create directory structure in temp
      const tempFilePath = join(tempDir, dbFile.relativePath);
      mkdirSync(dirname(tempFilePath), { recursive: true });

      // For SQLite databases, use backup API; for other files, just copy
      if (dbFile.type === 'global-db' || dbFile.type === 'workspace-db') {
        // T011: Backup database using SQLite backup API
        await backupDatabase(dbFile.absolutePath, tempFilePath);
      } else {
        // For non-DB files (like workspace.json), just copy
        const content = readFileSync(dbFile.absolutePath);
        writeFileSync(tempFilePath, content);
      }

      // Read backed up file and compute checksum
      const buffer = readFileSync(tempFilePath);
      const checksum = computeChecksum(buffer);

      fileEntries.push({
        path: dbFile.relativePath,
        size: buffer.length,
        checksum,
        type: dbFile.type,
      });

      // Count sessions (only for DB files)
      if (dbFile.type === 'global-db' || dbFile.type === 'workspace-db') {
        sessionCount += countSessions(tempFilePath);
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

    // T014: Create zip file
    const zip = new AdmZip();

    // Add all backed up database files
    for (const entry of fileEntries) {
      const filePath = join(tempDir, entry.path);
      // Convert path to use forward slashes for cross-platform compatibility
      const zipPath = entry.path.split(sep).join('/');
      zip.addLocalFile(filePath, dirname(zipPath), basename(zipPath));
    }

    // T015: Create and add manifest
    const stats: BackupStats = {
      totalSize: fileEntries.reduce((sum, f) => sum + f.size, 0),
      sessionCount,
      workspaceCount: workspaceIds.size,
    };
    const manifest = createManifest(fileEntries, stats);
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    // Phase: Finalizing
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: dbFiles.length,
      totalFiles: dbFiles.length,
      bytesCompleted: totalBytes,
      totalBytes,
    });

    // Write zip file
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
    }
    zip.writeZip(outputPath);

    return {
      success: true,
      backupPath: outputPath,
      manifest,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Clean up temp directory
    try {
      const cleanupDir = (dir: string) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanupDir(fullPath);
          } else {
            unlinkSync(fullPath);
          }
        }
        // Remove the directory itself
        try {
          rmdirSync(dir);
        } catch {
          // Ignore
        }
      };
      if (existsSync(tempDir)) {
        cleanupDir(tempDir);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// Backup Viewing (T025-T026)
// ============================================================================

/**
 * T025: Open a database from a backup zip file
 * Note: better-sqlite3 cannot open directly from buffer, so we extract to a temp file
 */
export function openBackupDatabase(backupPath: string, dbPath: string): Database.Database {
  const zip = new AdmZip(backupPath);
  const buffer = zip.readFile(dbPath);

  if (!buffer) {
    throw new Error(`Database not found in backup: ${dbPath}`);
  }

  // better-sqlite3 cannot open from buffer directly - write to temp file
  const tempFile = join(
    tmpdir(),
    `cursor_history_backup_${Date.now()}_${Math.random().toString(36).slice(2)}.vscdb`
  );
  writeFileSync(tempFile, buffer);

  // Open the temp file and set up cleanup on close
  const db = new Database(tempFile, { readonly: true });

  // Store temp file path for cleanup
  (db as Database.Database & { _tempFile?: string })._tempFile = tempFile;

  // Wrap close to clean up temp file
  const originalClose = db.close.bind(db);
  db.close = () => {
    const result = originalClose();
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    return result;
  };

  return db;
}

/**
 * Read manifest from a backup file
 */
export function readBackupManifest(backupPath: string): BackupManifest | null {
  try {
    const zip = new AdmZip(backupPath);
    const manifestBuffer = zip.readFile('manifest.json');
    if (!manifestBuffer) {
      return null;
    }
    return JSON.parse(manifestBuffer.toString('utf-8')) as BackupManifest;
  } catch {
    return null;
  }
}

/**
 * T026: Validate backup integrity
 */
export function validateBackup(backupPath: string): BackupValidation {
  const errors: string[] = [];
  const validFiles: string[] = [];
  const corruptedFiles: string[] = [];
  const missingFiles: string[] = [];

  // Check if file exists
  if (!existsSync(backupPath)) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [`Backup file not found: ${backupPath}`],
    };
  }

  // Try to open as zip
  let zip: AdmZip;
  try {
    zip = new AdmZip(backupPath);
  } catch (e) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [`Invalid zip file: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // Read manifest
  const manifestBuffer = zip.readFile('manifest.json');
  if (!manifestBuffer) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: ['Manifest file not found in backup'],
    };
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf-8')) as BackupManifest;
  } catch (e) {
    return {
      status: 'invalid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [`Invalid manifest JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // Verify each file
  for (const fileEntry of manifest.files) {
    const buffer = zip.readFile(fileEntry.path);
    if (!buffer) {
      missingFiles.push(fileEntry.path);
      continue;
    }

    const actualChecksum = computeChecksum(buffer);
    if (actualChecksum === fileEntry.checksum) {
      validFiles.push(fileEntry.path);
    } else {
      corruptedFiles.push(fileEntry.path);
    }
  }

  // Determine status
  let status: 'valid' | 'warnings' | 'invalid';
  if (missingFiles.length > 0 || (corruptedFiles.length > 0 && validFiles.length === 0)) {
    status = 'invalid';
  } else if (corruptedFiles.length > 0) {
    status = 'warnings';
  } else {
    status = 'valid';
  }

  if (missingFiles.length > 0) {
    errors.push(`Missing files: ${missingFiles.join(', ')}`);
  }
  if (corruptedFiles.length > 0) {
    errors.push(`Corrupted files: ${corruptedFiles.join(', ')}`);
  }

  return {
    status,
    manifest,
    validFiles,
    corruptedFiles,
    missingFiles,
    errors,
  };
}

// ============================================================================
// Restore Operations (T040-T045)
// ============================================================================

/**
 * T040-T045: Restore backup to Cursor data directory
 */
export function restoreBackup(config: RestoreConfig): RestoreResult {
  const startTime = Date.now();
  const backupPath = config.backupPath;
  const targetPath = config.targetPath ?? getDefaultCursorDataPath();
  const force = config.force ?? false;
  const onProgress = config.onProgress;

  // Phase: Validating
  onProgress?.({
    phase: 'validating',
    filesCompleted: 0,
    totalFiles: 0,
    integrityStatus: 'pending',
  });

  // Validate backup
  const validation = validateBackup(backupPath);

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

  // Check target directory
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

  // Phase: Extracting
  const zip = new AdmZip(backupPath);
  const restoredFiles: string[] = [];
  const warnings: string[] = validation.corruptedFiles.map((f) => `Checksum mismatch: ${f}`);

  try {
    for (let i = 0; i < manifest.files.length; i++) {
      const fileEntry = manifest.files[i]!;

      onProgress?.({
        phase: 'extracting',
        currentFile: fileEntry.path,
        filesCompleted: i,
        totalFiles: manifest.files.length,
        integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
        corruptedFiles: validation.corruptedFiles,
      });

      const buffer = zip.readFile(fileEntry.path);
      if (!buffer) {
        continue; // Skip missing files
      }

      // Convert forward slashes to platform-specific separators
      const platformPath = fileEntry.path.split('/').join(sep);
      const destPath = join(userDir, platformPath);

      // Create directory structure
      mkdirSync(dirname(destPath), { recursive: true });

      // Write file
      writeFileSync(destPath, buffer);
      restoredFiles.push(fileEntry.path);
    }

    // Phase: Finalizing
    onProgress?.({
      phase: 'finalizing',
      filesCompleted: manifest.files.length,
      totalFiles: manifest.files.length,
      integrityStatus: validation.status === 'warnings' ? 'warnings' : 'passed',
    });

    return {
      success: true,
      targetPath,
      filesRestored: restoredFiles.length,
      warnings,
      durationMs: Date.now() - startTime,
    };
  } catch (e) {
    // T043: Rollback on failure - delete any files we created
    for (const filePath of restoredFiles) {
      try {
        const platformPath = filePath.split('/').join(sep);
        const destPath = join(userDir, platformPath);
        if (existsSync(destPath)) {
          unlinkSync(destPath);
        }
      } catch {
        // Ignore rollback errors
      }
    }

    return {
      success: false,
      targetPath,
      filesRestored: 0,
      warnings,
      durationMs: Date.now() - startTime,
      error: `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================================================
// Backup Listing (T055-T057)
// ============================================================================

/**
 * T055-T057: List all backup files in a directory
 */
export function listBackups(directory?: string): BackupInfo[] {
  const dir = directory ?? getDefaultBackupDir();

  if (!existsSync(dir)) {
    return [];
  }

  const backups: BackupInfo[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
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
        const manifest = readBackupManifest(filePath);
        if (manifest) {
          info.manifest = manifest;
        } else {
          info.error = 'No manifest found';
        }
      } catch (e) {
        info.error = e instanceof Error ? e.message : String(e);
      }

      backups.push(info);
    }
  } catch {
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
