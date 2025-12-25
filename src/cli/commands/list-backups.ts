/**
 * List-backups command - list available backup files
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { existsSync } from 'node:fs';
import { listBackups, getDefaultBackupDir } from '../../core/backup.js';
import type { BackupInfo } from '../../core/types.js';
import { handleError, ExitCode } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';

interface ListBackupsCommandOptions {
  directory?: string;
  json?: boolean;
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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * T062: Format backup list as a table
 */
function formatBackupsTable(backups: BackupInfo[]): string {
  const lines: string[] = [];

  // Header
  lines.push(
    pc.dim('  #') +
      '  ' +
      pc.dim('Filename'.padEnd(45)) +
      pc.dim('Created'.padEnd(22)) +
      pc.dim('Size'.padEnd(10)) +
      pc.dim('Sessions'.padEnd(10)) +
      pc.dim('Status')
  );
  lines.push(pc.dim('─'.repeat(110)));

  // Rows
  for (let i = 0; i < backups.length; i++) {
    const backup = backups[i]!;
    const index = String(i + 1).padStart(3);
    const filename = backup.filename.length > 44
      ? backup.filename.slice(0, 41) + '...'
      : backup.filename.padEnd(45);

    // Use manifest date if available, otherwise file modification time
    const createdAt = backup.manifest?.createdAt
      ? formatDate(new Date(backup.manifest.createdAt))
      : formatDate(backup.modifiedAt);

    const size = formatSize(backup.fileSize).padEnd(10);
    const sessions = backup.manifest
      ? String(backup.manifest.stats.sessionCount).padEnd(10)
      : pc.dim('N/A'.padEnd(10));

    // Status indicator
    let status: string;
    if (backup.error) {
      status = pc.red('Invalid');
    } else if (backup.manifest) {
      status = pc.green('Valid');
    } else {
      status = pc.yellow('Unknown');
    }

    lines.push(`${pc.dim(index)}  ${filename}${createdAt.padEnd(22)}${size}${sessions}${status}`);
  }

  // Summary
  lines.push('');
  const invalidCount = backups.filter((b) => b.error).length;
  lines.push(
    pc.dim(`Total: ${backups.length} backup(s)`) +
      (invalidCount > 0 ? pc.dim(` (${invalidCount} invalid)`) : '')
  );

  return lines.join('\n');
}

/**
 * Format backup list for JSON output
 */
function formatBackupsJson(backups: BackupInfo[], directory: string): string {
  return JSON.stringify(
    {
      directory,
      count: backups.length,
      backups: backups.map((backup) => ({
        filename: backup.filename,
        filePath: backup.filePath,
        fileSize: backup.fileSize,
        modifiedAt: backup.modifiedAt.toISOString(),
        ...(backup.manifest && {
          createdAt: backup.manifest.createdAt,
          sessionCount: backup.manifest.stats.sessionCount,
          workspaceCount: backup.manifest.stats.workspaceCount,
          totalSize: backup.manifest.stats.totalSize,
        }),
        ...(backup.error && { error: backup.error }),
      })),
    },
    null,
    2
  );
}

/**
 * Register the list-backups command
 */
export function registerListBackupsCommand(program: Command): void {
  program
    .command('list-backups')
    .alias('backups')
    .description('List available backup files')
    .option('-d, --directory <path>', 'Directory to scan (default: ~/cursor-history-backups)')
    .action((options: ListBackupsCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as { json?: boolean };
      const useJson = options.json ?? globalOptions?.json ?? false;

      try {
        // Resolve directory path
        const directory = options.directory
          ? expandPath(options.directory)
          : getDefaultBackupDir();

        // T064: Check if directory exists
        if (!existsSync(directory)) {
          if (useJson) {
            console.log(JSON.stringify({
              error: 'Directory not found',
              directory,
              count: 0,
              backups: []
            }));
          } else {
            console.error(pc.yellow('Backup directory not found:'));
            console.error(pc.dim(`  ${contractPath(directory)}`));
            console.error('');
            console.error(pc.dim('Create a backup first with: cursor-history backup'));
          }
          process.exit(ExitCode.USAGE_ERROR);
        }

        // List backups
        const backups = listBackups(directory);

        // T063: Handle no backups found
        if (backups.length === 0) {
          if (useJson) {
            console.log(JSON.stringify({
              directory: contractPath(directory),
              count: 0,
              backups: []
            }));
          } else {
            console.log(pc.dim('No backups found in:'));
            console.log(pc.dim(`  ${contractPath(directory)}`));
            console.log('');
            console.log(pc.dim('Create a backup with: cursor-history backup'));
          }
          return; // Exit code 0 - this is informational, not an error
        }

        // Output results
        if (useJson) {
          console.log(formatBackupsJson(backups, contractPath(directory)));
        } else {
          console.log(pc.dim(`Backups in: ${contractPath(directory)}\n`));
          console.log(formatBackupsTable(backups));
        }
      } catch (error) {
        handleError(error);
      }
    });
}
