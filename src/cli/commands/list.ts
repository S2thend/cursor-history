/**
 * List command - display chat sessions and workspaces
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import {
  createSessionReadContext,
  listSessionSummaries,
  listWorkspaces,
} from '../../core/storage.js';
import { validateBackup } from '../../core/backup.js';
import {
  formatSessionsTable,
  formatSessionsJson,
  formatWorkspacesTable,
  formatWorkspacesJson,
  formatNoHistory,
  formatCursorNotFound,
  formatOperationDiagnostics,
} from '../formatters/index.js';
import {
  getCursorDataPath,
  getStoreStackRoot,
  expandPath,
  contractPath,
} from '../../lib/platform.js';
import { existsSync } from 'node:fs';
import type { LogicalSessionSummary, SourceReadLimitsOverride } from '../../core/types.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';
import { ExitCode, handleCommandError } from '../errors.js';
import { createAmbiguousSessionDiagnostic, createCliDiagnosticCollector } from '../diagnostics.js';

interface ListCommandOptions {
  limit?: string;
  all?: boolean;
  workspaces?: boolean;
  ids?: boolean;
  json?: boolean;
  dataPath?: string;
  workspace?: string;
  backup?: string;
}

/**
 * Register the list command
 */
export function registerListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List chat sessions')
    .option('-n, --limit <number>', 'Maximum sessions to show', '20')
    .option('-a, --all', 'Show all sessions (ignore limit)')
    .option('--workspaces', 'List workspaces instead of sessions')
    .option('--ids', 'Show composer IDs (for external export tools)')
    .option('-b, --backup <path>', 'Read from backup file instead of live data')
    .action(async (options: ListCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as {
        json?: boolean;
        dataPath?: string;
        workspace?: string;
        includeCrossWorkspaceSources?: boolean;
        sourceLimit?: SourceReadLimitsOverride;
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const workspaceFilter = options.workspace ?? globalOptions?.workspace;
      const backupPath = options.backup ? expandPath(options.backup) : undefined;
      const includeCrossWorkspaceSources = globalOptions?.includeCrossWorkspaceSources ?? false;
      let sourceReadLimits;
      try {
        sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);
      } catch (error) {
        handleCommandError(error, { json: useJson });
      }

      // T034: Validate backup if reading from backup
      if (backupPath) {
        const validation = await validateBackup(backupPath, { sourceReadLimits });
        if (validation.status === 'invalid') {
          if (useJson) {
            handleCommandError(new Error('Invalid backup'), {
              json: true,
              exitCode: ExitCode.NOT_FOUND,
              legacyJson: { error: 'Invalid backup', errors: validation.errors },
            });
          } else {
            console.error(pc.red('Invalid backup file:'));
            for (const err of validation.errors) {
              console.error(pc.dim(`  ${err}`));
            }
          }
          process.exit(ExitCode.NOT_FOUND);
        }
        if (validation.status === 'warnings' && !useJson) {
          console.error(
            pc.yellow(
              `Warning: Backup has integrity issues (${validation.corruptedFiles.length} corrupted files)`
            )
          );
          console.error(pc.dim('Continuing with intact files...\n'));
        }
      }

      if (options.workspaces) {
        // For backup mode, skip Cursor data check - we read from backup
        if (!backupPath) {
          // Workspace listing succeeds when either the Composer root or the
          // resolved Store root exists (so Store-only machines are not rejected).
          const expanded = customPath ? expandPath(customPath) : undefined;
          const composerRoot = getCursorDataPath(expanded);
          const storeRoot = getStoreStackRoot(expanded);
          if (!existsSync(composerRoot) && !existsSync(storeRoot)) {
            if (useJson) {
              handleCommandError(new Error('Cursor data not found'), {
                json: true,
                exitCode: ExitCode.NOT_FOUND,
                legacyJson: { error: 'Cursor data not found', path: composerRoot },
              });
            } else {
              console.log(formatCursorNotFound(composerRoot));
            }
            process.exit(ExitCode.NOT_FOUND);
          }
        }
        // List workspaces
        const workspaces = await listWorkspaces(
          customPath ? expandPath(customPath) : undefined,
          backupPath,
          { sourceReadLimits }
        );

        if (workspaces.length === 0) {
          if (useJson) {
            console.log(JSON.stringify({ count: 0, workspaces: [] }));
          } else {
            console.log(formatNoHistory());
          }
          return;
        }

        // Show backup source indicator if reading from backup
        if (backupPath && !useJson) {
          console.log(pc.dim(`Reading from backup: ${contractPath(backupPath)}\n`));
        }

        if (useJson) {
          console.log(formatWorkspacesJson(workspaces));
        } else {
          console.log(formatWorkspacesTable(workspaces));
        }
      } else {
        // List sessions
        const limit = options.all ? 0 : parseInt(options.limit ?? '20', 10);
        const expandedPath = customPath ? expandPath(customPath) : undefined;
        const diagnosticCollector = createCliDiagnosticCollector();
        const context = createSessionReadContext({
          dataPath: expandedPath,
          backupPath,
          workspacePath: workspaceFilter,
          ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
          resolvedSessionCapacity: 0,
          sourceReadLimits,
          onDiagnostic: diagnosticCollector.onDiagnostic,
        });
        let sessions: LogicalSessionSummary[];
        try {
          sessions = await listSessionSummaries(
            {
              limit,
              all: options.all ?? false,
              workspacePath: workspaceFilter,
              ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
              ...(sourceReadLimits ? { sourceReadLimits } : {}),
            },
            expandedPath,
            backupPath,
            context
          );
        } finally {
          await context.dispose();
        }
        for (const summary of sessions) {
          if (summary.resolutionState === 'ambiguous') {
            diagnosticCollector.onDiagnostic(createAmbiguousSessionDiagnostic(summary));
          }
        }

        if (sessions.length === 0) {
          if (useJson) {
            console.log(
              formatSessionsJson([], {
                indexScope: workspaceFilter ? 'workspace' : 'global',
                ...(workspaceFilter ? { indexWorkspacePath: expandPath(workspaceFilter) } : {}),
                diagnostics: diagnosticCollector.diagnostics,
              })
            );
          } else {
            console.log(
              [
                formatNoHistory(workspaceFilter),
                formatOperationDiagnostics(diagnosticCollector.diagnostics),
              ]
                .filter(Boolean)
                .join('\n\n')
            );
          }
          return;
        }

        // Show backup source indicator if reading from backup
        if (backupPath && !useJson) {
          console.log(pc.dim(`Reading from backup: ${contractPath(backupPath)}\n`));
        }

        if (useJson) {
          console.log(
            formatSessionsJson(sessions, {
              indexScope: workspaceFilter ? 'workspace' : 'global',
              ...(workspaceFilter
                ? {
                    indexWorkspacePath:
                      sessions[0]?.indexWorkspacePath ?? expandPath(workspaceFilter),
                  }
                : {}),
              diagnostics: diagnosticCollector.diagnostics,
            })
          );
        } else {
          console.log(
            [
              formatSessionsTable(sessions, options.ids ?? false),
              formatOperationDiagnostics(diagnosticCollector.diagnostics),
            ]
              .filter(Boolean)
              .join('\n\n')
          );
        }
      }
    });
}
