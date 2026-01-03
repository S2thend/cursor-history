/**
 * Library API for backup and restore operations
 *
 * IMPORTANT: This is a library interface for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API.
 */

import {
  createBackup as coreCreateBackup,
  restoreBackup as coreRestoreBackup,
  validateBackup as coreValidateBackup,
  listBackups as coreListBackups,
  getDefaultBackupDir as coreGetDefaultBackupDir,
} from '../core/backup.js';

import type {
  BackupConfig,
  BackupResult,
  RestoreConfig,
  RestoreResult,
  BackupValidation,
  BackupInfo,
} from './types.js';

/**
 * Create a full backup of Cursor chat history.
 *
 * @param config - Optional backup configuration
 * @returns Promise resolving to backup result
 *
 * @example
 * ```typescript
 * import { createBackup } from 'cursor-history';
 *
 * // Basic usage
 * const result = await createBackup();
 * console.log(`Backup created: ${result.backupPath}`);
 *
 * // With options
 * const result = await createBackup({
 *   outputPath: '/path/to/backup.zip',
 *   force: true,
 *   onProgress: (progress) => {
 *     console.log(`${progress.phase}: ${progress.filesCompleted}/${progress.totalFiles}`);
 *   }
 * });
 * ```
 */
export async function createBackup(config?: BackupConfig): Promise<BackupResult> {
  return coreCreateBackup(config);
}

/**
 * Restore Cursor chat history from a backup file.
 *
 * @param config - Restore configuration (backupPath required)
 * @returns Promise resolving to restore result
 *
 * @example
 * ```typescript
 * import { restoreBackup } from 'cursor-history';
 *
 * const result = await restoreBackup({
 *   backupPath: '/path/to/backup.zip',
 *   force: true
 * });
 * ```
 */
export async function restoreBackup(config: RestoreConfig): Promise<RestoreResult> {
  return coreRestoreBackup(config);
}

/**
 * Validate a backup file's integrity without restoring.
 *
 * @param backupPath - Path to backup zip file
 * @returns Promise resolving to validation result with status and details
 *
 * @example
 * ```typescript
 * import { validateBackup } from 'cursor-history';
 *
 * const validation = await validateBackup('/path/to/backup.zip');
 * if (validation.status === 'valid') {
 *   console.log('Backup is valid');
 * }
 * ```
 */
export async function validateBackup(backupPath: string): Promise<BackupValidation> {
  return coreValidateBackup(backupPath);
}

/**
 * List available backup files in a directory.
 *
 * @param directory - Directory to scan (default: ~/cursor-history-backups)
 * @returns Promise resolving to array of backup info objects
 *
 * @example
 * ```typescript
 * import { listBackups } from 'cursor-history';
 *
 * const backups = await listBackups();
 * for (const backup of backups) {
 *   console.log(`${backup.filename}: ${backup.manifest?.stats.sessionCount} sessions`);
 * }
 * ```
 */
export async function listBackups(directory?: string): Promise<BackupInfo[]> {
  return coreListBackups(directory);
}

/**
 * Get the default backup directory path.
 *
 * @returns Default backup directory path (~/cursor-history-backups)
 *
 * @example
 * ```typescript
 * import { getDefaultBackupDir } from 'cursor-history';
 *
 * const dir = getDefaultBackupDir();
 * // Returns: /home/user/cursor-history-backups (Linux)
 * ```
 */
export function getDefaultBackupDir(): string {
  return coreGetDefaultBackupDir();
}
