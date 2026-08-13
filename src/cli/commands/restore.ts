/**
 * Restore command - restore chat history from a backup file
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { existsSync } from 'node:fs';
import { restoreBackup, validateBackup } from '../../core/backup.js';
import type { RestoreProgress, RestoreResult, SourceReadLimitsOverride } from '../../core/types.js';
import { CliError, handleError, ExitCode } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';

interface RestoreCommandOptions {
  target?: string;
  force?: boolean;
  json?: boolean;
  dataPath?: string;
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
 * T050: Progress display for restore command
 */
function displayProgress(progress: RestoreProgress): void {
  const phases: Record<RestoreProgress['phase'], string> = {
    validating: '🔍 Validating backup integrity...',
    extracting: '📦 Extracting files...',
    finalizing: '✨ Finalizing restore...',
  };

  const phaseText = phases[progress.phase];
  const fileProgress =
    progress.totalFiles > 0 ? ` [${progress.filesCompleted}/${progress.totalFiles}]` : '';
  const currentFile = progress.currentFile ? ` ${pc.dim(progress.currentFile)}` : '';

  // Show integrity status during validation
  const integrityText =
    progress.phase === 'validating' && progress.integrityStatus === 'warnings'
      ? pc.yellow(' (some files have warnings)')
      : '';

  // Clear line and print progress
  process.stdout.write(`\r${phaseText}${fileProgress}${currentFile}${integrityText}`.padEnd(80));
}

/**
 * Format restore result for JSON output
 */
function formatRestoreResultJson(result: RestoreResult): string {
  return JSON.stringify(
    {
      success: result.success,
      targetPath: result.targetPath,
      filesRestored: result.filesRestored,
      durationMs: result.durationMs,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
      ...(result.error && { error: result.error }),
    },
    null,
    2
  );
}

/**
 * Format restore result for human-readable output
 */
function formatRestoreResult(result: RestoreResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(pc.green('✓ Backup restored successfully!'));
    lines.push('');
    lines.push(`  ${pc.bold('Target:')} ${contractPath(result.targetPath)}`);
    lines.push(`  ${pc.bold('Files restored:')} ${result.filesRestored}`);
    lines.push(`  ${pc.bold('Duration:')} ${formatDuration(result.durationMs)}`);

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push(pc.yellow('  Warnings:'));
      for (const warning of result.warnings) {
        lines.push(`    ${pc.dim('•')} ${warning}`);
      }
    }
  } else {
    lines.push(pc.red('✗ Restore failed'));
    lines.push('');
    if (result.error) {
      lines.push(`  ${pc.bold('Error:')} ${result.error}`);
    }
  }

  return lines.join('\n');
}

/**
 * Register the restore command
 */
export function registerRestoreCommand(program: Command): void {
  program
    .command('restore <backup>')
    .description('Restore chat history from a backup file')
    .option(
      '-t, --target <path>',
      'Target Cursor data path (default: platform-specific Cursor data directory)'
    )
    .option('-f, --force', 'Overwrite existing data without prompting')
    .action(async (backupArg: string, options: RestoreCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as {
        json?: boolean;
        dataPath?: string;
        sourceLimit?: SourceReadLimitsOverride;
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;

      // Resolve backup path
      const backupPath = expandPath(backupArg);

      try {
        const sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);
        // T051: Check if backup file exists
        if (!existsSync(backupPath)) {
          if (useJson) {
            throw new CliError(
              'Backup file not found',
              ExitCode.USAGE_ERROR,
              undefined,
              undefined,
              { error: 'Backup file not found', path: backupPath }
            );
          } else {
            console.error(pc.red('Backup file not found:'));
            console.error(pc.dim(`  ${backupPath}`));
          }
          process.exit(ExitCode.USAGE_ERROR);
        }

        // T052: Validate backup before attempting restore
        const validation = await validateBackup(backupPath, {
          sourceReadLimits,
        });
        if (validation.status === 'invalid') {
          if (useJson) {
            throw new CliError(
              'Invalid or corrupted backup',
              ExitCode.NOT_FOUND,
              undefined,
              undefined,
              { error: 'Invalid or corrupted backup', errors: validation.errors }
            );
          } else {
            console.error(pc.red('Invalid or corrupted backup file:'));
            for (const err of validation.errors) {
              console.error(pc.dim(`  ${err}`));
            }
          }
          process.exit(ExitCode.NOT_FOUND);
        }

        // Show warning for backups with integrity issues
        if (validation.status === 'warnings' && !useJson) {
          console.log(
            pc.yellow(
              `Warning: Backup has ${validation.corruptedFiles.length} file(s) with checksum mismatches.`
            )
          );
          console.log(pc.dim('These files will be skipped; only intact files will be restored.\n'));
        }

        // Resolve target path if provided
        const targetPath = options.target
          ? expandPath(options.target)
          : customPath
            ? expandPath(customPath)
            : undefined;

        // Show progress if not JSON mode
        const onProgress = useJson ? undefined : displayProgress;

        // Perform restore
        const result = await restoreBackup({
          backupPath,
          targetPath,
          force: options.force ?? false,
          sourceReadLimits,
          onProgress,
        });

        // Clear progress line
        if (!useJson) {
          process.stdout.write('\r'.padEnd(80) + '\r');
        }

        // Handle different error cases with appropriate exit codes
        if (!result.success) {
          // T053: Target exists without --force
          if (result.error?.includes('already has Cursor data')) {
            if (useJson) {
              throw new CliError(
                result.error ?? 'Target directory already has Cursor data.',
                ExitCode.IO_ERROR,
                undefined,
                undefined,
                JSON.parse(formatRestoreResultJson(result)) as Record<string, unknown>
              );
            } else {
              console.error(pc.red('Target directory already has Cursor data.'));
              console.error(pc.dim('Use --force to overwrite existing data.'));
            }
            process.exit(ExitCode.IO_ERROR);
          }

          // T054: Integrity check failures
          if (result.error?.includes('integrity') || result.error?.includes('checksum')) {
            if (useJson) {
              throw new CliError(
                result.error ?? 'Backup integrity check failed.',
                ExitCode.INTEGRITY_ERROR,
                undefined,
                undefined,
                JSON.parse(formatRestoreResultJson(result)) as Record<string, unknown>
              );
            } else {
              console.error(pc.red('Backup integrity check failed.'));
              console.error(pc.dim(result.error));
            }
            process.exit(5); // Special exit code for integrity failures
          }

          // Generic error
          if (useJson) {
            throw new CliError(
              result.error ?? 'Restore failed.',
              ExitCode.GENERAL_ERROR,
              undefined,
              undefined,
              JSON.parse(formatRestoreResultJson(result)) as Record<string, unknown>
            );
          } else {
            console.error(formatRestoreResult(result));
          }
          process.exit(ExitCode.GENERAL_ERROR);
        }

        // Success
        if (useJson) {
          console.log(formatRestoreResultJson(result));
        } else {
          console.log(formatRestoreResult(result));
        }
      } catch (error) {
        handleError(error, { json: useJson });
      }
    });
}
