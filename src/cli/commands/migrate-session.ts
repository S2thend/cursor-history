/**
 * CLI command for migrating individual sessions between workspaces
 *
 * Usage:
 *   cursor-history migrate-session <session> <destination>
 *   cursor-history migrate-session 3 /path/to/new/project
 *   cursor-history migrate-session 1,3,5 /path/to/new/project
 *   cursor-history migrate-session --dry-run 3 /path/to/new/project
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { migrateSessions } from '../../core/migrate.js';
import { expandPath } from '../../lib/platform.js';
import {
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isSameWorkspaceError,
  isNestedPathError,
} from '../../lib/errors.js';
import type { MigrationMode } from '../../core/types.js';
import type { SourceReadLimitsOverride } from '../../core/types.js';
import { handleCommandError } from '../errors.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';

interface MigrateSessionOptions {
  dryRun?: boolean;
  copy?: boolean;
  force?: boolean;
  debug?: boolean;
  dataPath?: string;
  json?: boolean;
}

export function registerMigrateSessionCommand(program: Command): void {
  program
    .command('migrate-session')
    .description('Move or copy sessions to a different workspace')
    .argument('<session>', 'Session index or ID (comma-separated for multiple)')
    .argument('<destination>', 'Destination workspace path')
    .option('--dry-run', 'Preview migration without making changes')
    .option('--copy', 'Copy sessions instead of moving (keeps originals)')
    .option('-f, --force', 'Proceed even if destination has existing sessions')
    .option('--debug', 'Show detailed path transformation logs')
    .action(async (sessionArg: string, destinationArg: string, options: MigrateSessionOptions) => {
      const globalOptions = program.opts() as {
        dataPath?: string;
        json?: boolean;
        workspace?: string;
        sourceLimit?: SourceReadLimitsOverride;
      };
      const dataPath = globalOptions.dataPath ? expandPath(globalOptions.dataPath) : undefined;
      const jsonOutput = globalOptions.json || options.json;

      try {
        const sourceReadLimits = validateCliSourceLimitOverrides(globalOptions.sourceLimit);
        // Expand ~ in destination path
        const destination = expandPath(destinationArg);

        const selectors = sessionArg.includes(',')
          ? sessionArg.split(',').map((value) => value.trim())
          : [sessionArg];

        // Determine mode
        const mode: MigrationMode = options.copy ? 'copy' : 'move';

        // Perform migration
        const results = await migrateSessions({
          selectors,
          workspacePath: globalOptions.workspace,
          destination,
          mode,
          dryRun: options.dryRun ?? false,
          force: options.force ?? false,
          dataPath,
          debug: options.debug ?? false,
          sourceReadLimits,
        });

        // Output results
        if (jsonOutput) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          outputResults(results, options.dryRun ?? false);
        }

        // Exit with error code if any failures
        const hasFailures = results.some((r) => !r.success);
        if (hasFailures) {
          process.exit(1);
        }
      } catch (error) {
        const message = formatError(error);
        handleCommandError(error, {
          json: jsonOutput,
          message,
          legacyJson: { error: message },
        });
      }
    });
}

function outputResults(
  results: Array<{
    success: boolean;
    sessionId: string;
    sourceWorkspace: string;
    destinationWorkspace: string;
    mode: MigrationMode;
    newSessionId?: string;
    error?: string;
    dryRun: boolean;
    pathsWillBeUpdated?: boolean;
  }>,
  isDryRun: boolean
): void {
  if (isDryRun) {
    console.log(pc.yellow('Dry run - no changes made\n'));
  }

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length > 0) {
    const action = isDryRun ? 'Would migrate' : 'Migrated';
    console.log(pc.green(`${action} ${successful.length} session(s):\n`));

    for (const result of successful) {
      const modeLabel = result.mode === 'copy' ? 'copied' : 'moved';
      const actionLabel = isDryRun ? `would be ${modeLabel}` : modeLabel;
      console.log(`  ${pc.cyan(result.sessionId.slice(0, 8))}...`);
      console.log(`    From: ${result.sourceWorkspace}`);
      console.log(`    To:   ${result.destinationWorkspace}`);
      if (isDryRun && result.pathsWillBeUpdated) {
        console.log(`    ${pc.blue('File paths will be updated to destination workspace')}`);
      }
      console.log(`    ${pc.dim(`(${actionLabel})`)}\n`);
    }
  }

  if (failed.length > 0) {
    console.log(pc.red(`Failed to migrate ${failed.length} session(s):\n`));

    for (const result of failed) {
      console.log(`  ${pc.red('✗')} ${pc.cyan(result.sessionId.slice(0, 8))}...`);
      console.log(`    ${pc.red(result.error ?? 'Unknown error')}\n`);
    }
  }

  // Summary
  if (results.length > 1) {
    console.log(pc.dim(`Summary: ${successful.length} succeeded, ${failed.length} failed`));
  }
}

function formatError(error: unknown): string {
  if (isSessionNotFoundError(error)) {
    return `Session not found: ${error.identifier}\nRun 'cursor-history list' to see available sessions.`;
  }

  if (isWorkspaceNotFoundError(error)) {
    return `Workspace not found: ${error.path}\nPlease open the project in Cursor first to create the workspace.`;
  }

  if (isSameWorkspaceError(error)) {
    return `Source and destination are the same: ${error.path}\nSpecify a different destination path.`;
  }

  if (isNestedPathError(error)) {
    return `Destination is nested within source: ${error.destination} is inside ${error.source}\nThis would cause infinite path replacement loops. Choose a different destination.`;
  }

  if (error instanceof Error) {
    // Check for database lock error
    if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
      return 'Database is locked. Please close Cursor and try again.';
    }
    return error.message;
  }

  return String(error);
}
