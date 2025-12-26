/**
 * CLI command for migrating all sessions between workspaces
 *
 * Usage:
 *   cursor-history migrate <source> <destination>
 *   cursor-history migrate /old/project /new/project
 *   cursor-history migrate --copy /project /backup/project
 *   cursor-history migrate --dry-run /old/path /new/path
 *   cursor-history migrate --force /old/path /existing/path
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { migrateWorkspace } from '../../core/migrate.js';
import { expandPath } from '../../lib/platform.js';
import {
  isWorkspaceNotFoundError,
  isSameWorkspaceError,
  isNoSessionsFoundError,
  isDestinationHasSessionsError,
  isNestedPathError,
} from '../../lib/errors.js';
import type { MigrationMode, WorkspaceMigrationResult } from '../../core/types.js';

interface MigrateOptions {
  dryRun?: boolean;
  copy?: boolean;
  force?: boolean;
  debug?: boolean;
  dataPath?: string;
  json?: boolean;
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Move or copy all sessions from one workspace to another')
    .argument('<source>', 'Source workspace path')
    .argument('<destination>', 'Destination workspace path')
    .option('--dry-run', 'Preview migration without making changes')
    .option('--copy', 'Copy sessions instead of moving (keeps originals)')
    .option('-f, --force', 'Proceed even if destination has existing sessions')
    .option('--debug', 'Show detailed path transformation logs')
    .action(async (sourceArg: string, destinationArg: string, options: MigrateOptions) => {
      const globalOptions = program.opts() as { dataPath?: string; json?: boolean };
      const dataPath = globalOptions.dataPath;
      const jsonOutput = globalOptions.json || options.json;

      try {
        // Expand ~ in paths
        const source = expandPath(sourceArg);
        const destination = expandPath(destinationArg);

        // Determine mode
        const mode: MigrationMode = options.copy ? 'copy' : 'move';

        // Perform migration
        const result = migrateWorkspace({
          source,
          destination,
          mode,
          dryRun: options.dryRun ?? false,
          force: options.force ?? false,
          dataPath,
          debug: options.debug ?? false,
        });

        // Output results
        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          outputResult(result);
        }

        // Exit with error code if any failures
        if (!result.success) {
          process.exit(1);
        }
      } catch (error) {
        if (jsonOutput) {
          console.log(JSON.stringify({ error: formatError(error) }, null, 2));
        } else {
          console.error(pc.red(formatError(error)));
        }
        process.exit(1);
      }
    });
}

function outputResult(result: WorkspaceMigrationResult): void {
  if (result.dryRun) {
    console.log(pc.yellow('Dry run - no changes made\n'));
  }

  const action = result.dryRun ? 'Would migrate' : 'Migrated';
  const modeLabel = result.mode === 'copy' ? 'copied' : 'moved';

  console.log(`${action} ${pc.bold(result.totalSessions)} session(s) from:`);
  console.log(`  ${pc.cyan(result.source)}`);
  console.log(`to:`);
  console.log(`  ${pc.cyan(result.destination)}\n`);

  if (result.successCount > 0) {
    const actionLabel = result.dryRun ? `would be ${modeLabel}` : modeLabel;
    console.log(pc.green(`✓ ${result.successCount} session(s) ${actionLabel} successfully`));
  }

  if (result.failureCount > 0) {
    console.log(pc.red(`✗ ${result.failureCount} session(s) failed to migrate:\n`));

    for (const r of result.results.filter((r) => !r.success)) {
      console.log(`  ${pc.red('✗')} ${pc.cyan(r.sessionId.slice(0, 8))}...`);
      console.log(`    ${pc.red(r.error ?? 'Unknown error')}\n`);
    }
  }

  // Overall status
  if (result.success) {
    console.log(pc.green('\n✓ Migration completed successfully'));
  } else {
    console.log(pc.red('\n✗ Migration completed with errors'));
  }
}

function formatError(error: unknown): string {
  if (isWorkspaceNotFoundError(error)) {
    return `Workspace not found: ${error.path}\nPlease open the project in Cursor first to create the workspace.`;
  }

  if (isSameWorkspaceError(error)) {
    return `Source and destination are the same: ${error.path}\nSpecify different source and destination paths.`;
  }

  if (isNoSessionsFoundError(error)) {
    return `No sessions found for workspace: ${error.path}\nRun 'cursor-history list --workspace "${error.path}"' to verify.`;
  }

  if (isDestinationHasSessionsError(error)) {
    return `Destination already has ${error.sessionCount} session(s): ${error.path}\nUse --force to proceed (will add sessions alongside existing ones).`;
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
