/**
 * Backup command - create full backup of all chat history
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { createBackup } from '../../core/backup.js';
import type { BackupProgress, BackupResult } from '../../core/types.js';
import { handleError, ExitCode } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';

interface BackupCommandOptions {
  output?: string;
  force?: boolean;
  json?: boolean;
  dataPath?: string;
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format duration for display
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * T021: Progress display for backup command
 */
function displayProgress(progress: BackupProgress): void {
  const phases: Record<BackupProgress['phase'], string> = {
    scanning: '🔍 Scanning for database files...',
    'backing-up': '📦 Backing up databases...',
    compressing: '🗜️  Compressing into zip...',
    finalizing: '✨ Finalizing backup...',
  };

  const phaseText = phases[progress.phase];
  const fileProgress =
    progress.totalFiles > 0 ? ` [${progress.filesCompleted}/${progress.totalFiles}]` : '';
  // Compressing a multi-GB database takes a while, show how far along it is
  const percent =
    progress.phase === 'compressing' && progress.totalBytes > 0
      ? ` ${Math.min(100, Math.round((progress.bytesCompleted / progress.totalBytes) * 100))}%`
      : '';
  const currentFile = progress.currentFile ? ` ${pc.dim(progress.currentFile)}` : '';

  // Clear line and print progress
  process.stdout.write(`\r${phaseText}${fileProgress}${percent}${currentFile}`.padEnd(80));
}

/**
 * Format backup result for JSON output
 */
function formatBackupResultJson(result: BackupResult): string {
  return JSON.stringify(
    {
      success: result.success,
      backupPath: result.backupPath,
      durationMs: result.durationMs,
      ...(result.error && { error: result.error }),
      manifest: result.manifest,
    },
    null,
    2
  );
}

/**
 * Format backup result for human-readable output
 */
function formatBackupResult(result: BackupResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(pc.green('✓ Backup created successfully!'));
    lines.push('');
    lines.push(`  ${pc.bold('Location:')} ${contractPath(result.backupPath)}`);
    lines.push(`  ${pc.bold('Size:')} ${formatSize(result.manifest.stats.totalSize)}`);
    lines.push(`  ${pc.bold('Sessions:')} ${result.manifest.stats.sessionCount}`);
    lines.push(`  ${pc.bold('Workspaces:')} ${result.manifest.stats.workspaceCount}`);
    lines.push(`  ${pc.bold('Files:')} ${result.manifest.files.length} database files`);
    lines.push(`  ${pc.bold('Duration:')} ${formatDuration(result.durationMs)}`);
  } else {
    lines.push(pc.red('✗ Backup failed'));
    lines.push('');
    if (result.error) {
      lines.push(`  ${pc.bold('Error:')} ${result.error}`);
    }
  }

  return lines.join('\n');
}

/**
 * Register the backup command
 */
export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Create a full backup of all Cursor chat history')
    .option(
      '-o, --output <path>',
      'Output file path (default: ~/cursor-history-backups/<timestamp>.zip)'
    )
    .option('-f, --force', 'Overwrite existing backup file')
    .action(async (options: BackupCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as { json?: boolean; dataPath?: string };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;

      try {
        // Resolve output path if provided
        const outputPath = options.output ? expandPath(options.output) : undefined;

        // Show progress if not JSON mode
        const onProgress = useJson ? undefined : displayProgress;

        // Create backup
        const result = await createBackup({
          sourcePath: customPath ? expandPath(customPath) : undefined,
          outputPath,
          force: options.force ?? false,
          onProgress,
        });

        // Clear progress line
        if (!useJson) {
          process.stdout.write('\r'.padEnd(80) + '\r');
        }

        // Handle different error cases with appropriate exit codes
        if (!result.success) {
          // T022: No data to backup
          if (result.error?.includes('No Cursor data found')) {
            if (useJson) {
              console.log(formatBackupResultJson(result));
            } else {
              console.error(pc.yellow('No Cursor data found to backup.'));
              console.error(pc.dim('Make sure Cursor has been used and has chat history.'));
            }
            process.exit(ExitCode.USAGE_ERROR);
          }

          // T023: File exists without --force
          if (result.error?.includes('already exists')) {
            if (useJson) {
              console.log(formatBackupResultJson(result));
            } else {
              console.error(pc.red('Backup file already exists.'));
              console.error(pc.dim('Use --force to overwrite.'));
            }
            process.exit(ExitCode.NOT_FOUND);
          }

          // T024: Insufficient disk space
          if (result.error?.includes('Insufficient disk space')) {
            if (useJson) {
              console.log(formatBackupResultJson(result));
            } else {
              console.error(pc.red('Insufficient disk space for backup.'));
            }
            process.exit(ExitCode.IO_ERROR);
          }

          // Generic error
          if (useJson) {
            console.log(formatBackupResultJson(result));
          } else {
            console.error(formatBackupResult(result));
          }
          process.exit(ExitCode.GENERAL_ERROR);
        }

        // Success
        if (useJson) {
          console.log(formatBackupResultJson(result));
        } else {
          console.log(formatBackupResult(result));
        }
      } catch (error) {
        handleError(error);
      }
    });
}
