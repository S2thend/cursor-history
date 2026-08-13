/**
 * Search command - search across chat sessions
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { createSessionReadContext, searchSessions } from '../../core/storage.js';
import type { SourceReadLimitsOverride } from '../../core/types.js';
import { validateBackup } from '../../core/backup.js';
import {
  formatSearchResultsTable,
  formatSearchResultsJson,
  formatOperationDiagnostics,
} from '../formatters/index.js';
import { NoSearchResultsError, handleCommandError, ExitCode } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';
import { createCliDiagnosticCollector } from '../diagnostics.js';
import { adaptScopedBackupReadError } from '../backup-read-error.js';

interface SearchCommandOptions {
  limit?: string;
  context?: string;
  json?: boolean;
  dataPath?: string;
  workspace?: string;
  backup?: string;
}

/**
 * Register the search command
 */
export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Search chat history for a keyword')
    .option('-n, --limit <number>', 'Maximum results to show', '10')
    .option('-c, --context <chars>', 'Context characters around match', '50')
    .option('-b, --backup <path>', 'Search in backup file instead of live data')
    .action(async (query: string, options: SearchCommandOptions, command: Command) => {
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
      const expandedPath = customPath ? expandPath(customPath) : undefined;
      const includeCrossWorkspaceSources = globalOptions?.includeCrossWorkspaceSources ?? false;

      const limit = parseInt(options.limit ?? '10', 10);
      const contextChars = parseInt(options.context ?? '50', 10);

      try {
        const sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);

        // T036: Validate backup if searching from backup. The CLI policy is frozen before this
        // first carrier read and then reused by every nested operation.
        if (backupPath && !workspaceFilter) {
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
            process.exit(3);
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
        try {
          const results = await searchSessions(
            query,
            {
              limit,
              contextChars,
              workspacePath: workspaceFilter,
              ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
              ...(sourceReadLimits ? { sourceReadLimits } : {}),
            },
            expandedPath,
            backupPath,
            context
          );

          const indexScope = workspaceFilter ? 'workspace' : 'global';
          const indexWorkspacePath = workspaceFilter
            ? (context.logicalSummaries?.find((summary) => summary.resolutionState !== 'ambiguous')
                ?.indexWorkspacePath ??
              context.workspaceScope ??
              expandPath(workspaceFilter))
            : undefined;
          const jsonOptions = {
            indexScope,
            ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
            diagnostics: diagnosticCollector.diagnostics,
          } as const;

          if (results.length === 0) {
            if (useJson) {
              console.log(formatSearchResultsJson([], query, jsonOptions));
            } else if (diagnosticCollector.diagnostics.length > 0) {
              console.log(
                [
                  formatSearchResultsTable([], query),
                  formatOperationDiagnostics(diagnosticCollector.diagnostics),
                ].join('\n\n')
              );
            } else {
              throw new NoSearchResultsError(query);
            }
            return;
          }

          // Show backup source indicator if searching from backup
          if (backupPath && !useJson) {
            console.log(pc.dim(`Searching in backup: ${contractPath(backupPath)}\n`));
          }

          if (useJson) {
            console.log(formatSearchResultsJson(results, query, jsonOptions));
          } else {
            console.log(
              [
                formatSearchResultsTable(results, query),
                formatOperationDiagnostics(diagnosticCollector.diagnostics),
              ]
                .filter(Boolean)
                .join('\n\n')
            );
          }
        } finally {
          await context.dispose();
        }
      } catch (error) {
        handleCommandError(
          adaptScopedBackupReadError(error, Boolean(backupPath && workspaceFilter)),
          { json: useJson }
        );
      }
    });
}
