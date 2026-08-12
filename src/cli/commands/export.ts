/**
 * Export command - export chat sessions to files
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSession, listSessionSummaries, createSessionReadContext } from '../../core/storage.js';
import { validateBackup } from '../../core/backup.js';
import { exportToMarkdown, exportToJson } from '../../core/parser.js';
import {
  formatExportSuccess,
  formatExportResultJson,
  formatOperationDiagnostics,
} from '../formatters/index.js';
import type { ExportedSessionFile } from '../formatters/index.js';
import { FileExistsError, handleCommandError, handleError, CliError, ExitCode } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';
import { resolveCommandSession } from './session-lookup.js';
import type { ChatSessionSummary, SourceReadLimitsOverride } from '../../core/types.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';
import {
  createAmbiguousSessionDiagnostic,
  createCliDiagnosticCollector,
  createSessionAmbiguityDiagnostic,
} from '../diagnostics.js';
import { SessionAmbiguityError } from '../../core/errors.js';

interface ExportCommandOptions {
  output?: string;
  format?: string;
  force?: boolean;
  all?: boolean;
  json?: boolean;
  dataPath?: string;
  backup?: string;
}

/**
 * Register the export command
 */
export function registerExportCommand(program: Command): void {
  program
    .command('export [index]')
    .description('Export chat session(s) to file (index or composer ID)')
    .option('-o, --output <path>', 'Output file or directory')
    .option('-f, --format <format>', 'Output format: md or json', 'md')
    .option('--force', 'Overwrite existing files')
    .option('-a, --all', 'Export all sessions')
    .option('-b, --backup <path>', 'Export from backup file instead of live data')
    .action(
      async (indexArg: string | undefined, options: ExportCommandOptions, command: Command) => {
        const globalOptions = command.parent?.opts() as {
          json?: boolean;
          dataPath?: string;
          workspace?: string;
          includeCrossWorkspaceSources?: boolean;
          sourceLimit?: SourceReadLimitsOverride;
        };
        const useJson = options.json ?? globalOptions?.json ?? false;
        const customPath = options.dataPath ?? globalOptions?.dataPath;
        const workspaceFilter = globalOptions?.workspace;
        const format = options.format === 'json' ? 'json' : 'md';
        const backupPath = options.backup ? expandPath(options.backup) : undefined;
        const includeCrossWorkspaceSources = globalOptions?.includeCrossWorkspaceSources ?? false;

        try {
          const sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);

          // T037: Validate backup if exporting from backup.
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

          // Validate arguments
          if (!options.all && !indexArg) {
            throw new CliError(
              'Please specify a session index or composer ID, or use --all to export all sessions.',
              ExitCode.USAGE_ERROR
            );
          }

          const exported: ExportedSessionFile[] = [];
          const diagnosticCollector = createCliDiagnosticCollector();

          if (options.all) {
            // Export all sessions with one Store discovery shared across the
            // export-all loop via the read context.
            const expanded = customPath ? expandPath(customPath) : undefined;
            const context = createSessionReadContext({
              dataPath: expanded,
              backupPath,
              workspacePath: workspaceFilter,
              ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
              resolvedSessionCapacity: 0,
              sourceReadLimits,
              onDiagnostic: diagnosticCollector.onDiagnostic,
            });
            try {
              const logicalSessions = await listSessionSummaries(
                {
                  limit: 0,
                  all: true,
                  workspacePath: workspaceFilter,
                  ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
                  ...(sourceReadLimits ? { sourceReadLimits } : {}),
                },
                expanded,
                backupPath,
                context
              );

              if (logicalSessions.length === 0) {
                throw new CliError('No sessions to export.', ExitCode.NOT_FOUND);
              }

              for (const summary of logicalSessions) {
                if (summary.resolutionState === 'ambiguous') {
                  diagnosticCollector.onDiagnostic(createAmbiguousSessionDiagnostic(summary));
                }
              }
              const sessions = logicalSessions.filter(
                (summary): summary is ChatSessionSummary => summary.resolutionState !== 'ambiguous'
              );

              // Determine output directory
              const outputDir = options.output ? expandPath(options.output) : process.cwd();

              // Create directory if needed
              if (!existsSync(outputDir)) {
                mkdirSync(outputDir, { recursive: true });
              }

              // Show backup source indicator if exporting from backup
              if (backupPath && !useJson) {
                console.log(pc.dim(`Exporting from backup: ${contractPath(backupPath)}\n`));
              }

              for (const summary of sessions) {
                try {
                  // Resolve by stable ID through the cached context.
                  const session = await getSession(
                    summary.id,
                    expanded,
                    backupPath,
                    context,
                    summary.index
                  );
                  if (!session) continue;

                  // Generate filename
                  const dateStr = session.createdAt.toISOString().split('T')[0];
                  const safeTitle = (session.title ?? 'untitled')
                    .replace(/[^a-zA-Z0-9-_]/g, '_')
                    .slice(0, 30);
                  const filename = `${dateStr}-${session.index}-${safeTitle}.${format}`;
                  const filePath = join(outputDir, filename);

                  // Check if file exists
                  if (existsSync(filePath) && !options.force) {
                    throw new FileExistsError(filePath);
                  }

                  // Export
                  const content =
                    format === 'json' ? exportToJson(session) : exportToMarkdown(session);

                  writeFileSync(filePath, content, 'utf-8');
                  const indexScope =
                    session.indexScope ?? (workspaceFilter ? 'workspace' : 'global');
                  const indexWorkspacePath =
                    indexScope === 'workspace'
                      ? (session.indexWorkspacePath ??
                        context.workspaceScope ??
                        (workspaceFilter ? expandPath(workspaceFilter) : undefined))
                      : undefined;
                  exported.push({
                    index: session.index,
                    indexScope,
                    ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
                    sessionId: session.id,
                    path: contractPath(filePath),
                  });
                } catch (error) {
                  if (!(error instanceof SessionAmbiguityError)) throw error;
                  diagnosticCollector.onDiagnostic(
                    createSessionAmbiguityDiagnostic(
                      error.details.sessionId,
                      error.details.occurrenceRefs
                    )
                  );
                } finally {
                  context.releaseSession(summary.id);
                }
              }
            } finally {
              await context.dispose();
            }
          } else {
            // Export single session (index or composer ID)

            // Only treat arg as index when the entire string is digits
            const identifier: number | string = /^\d+$/.test(indexArg!)
              ? parseInt(indexArg!, 10)
              : indexArg!;

            // CLI uses 1-based index; 0 is invalid
            if (typeof identifier === 'number' && identifier < 1) {
              throw new CliError(
                `Invalid index: ${indexArg}. Must be a positive number.`,
                ExitCode.USAGE_ERROR
              );
            }

            const expanded = customPath ? expandPath(customPath) : undefined;
            const session = await resolveCommandSession(
              identifier,
              workspaceFilter,
              expanded,
              backupPath,
              { includeCrossWorkspaceSources, sourceReadLimits }
            );

            // Determine output path
            let outputPath: string;
            if (options.output) {
              outputPath = expandPath(options.output);
            } else {
              const dateStr = session.createdAt.toISOString().split('T')[0];
              const safeTitle = (session.title ?? 'untitled')
                .replace(/[^a-zA-Z0-9-_]/g, '_')
                .slice(0, 30);
              outputPath = `${dateStr}-${session.index}-${safeTitle}.${format}`;
            }

            // Check if file exists
            if (existsSync(outputPath) && !options.force) {
              throw new FileExistsError(outputPath);
            }

            // Create directory if needed
            const dir = dirname(outputPath);
            if (dir !== '.' && !existsSync(dir)) {
              mkdirSync(dir, { recursive: true });
            }

            // Show backup source indicator if exporting from backup
            if (backupPath && !useJson) {
              console.log(pc.dim(`Exporting from backup: ${contractPath(backupPath)}\n`));
            }

            // Export
            const content = format === 'json' ? exportToJson(session) : exportToMarkdown(session);

            writeFileSync(outputPath, content, 'utf-8');
            const indexScope = session.indexScope ?? (workspaceFilter ? 'workspace' : 'global');
            const indexWorkspacePath =
              indexScope === 'workspace'
                ? (session.indexWorkspacePath ??
                  (workspaceFilter ? expandPath(workspaceFilter) : undefined))
                : undefined;
            exported.push({
              index: session.index,
              indexScope,
              ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
              sessionId: session.id,
              path: contractPath(outputPath),
            });
          }

          // Output result
          if (useJson) {
            console.log(
              formatExportResultJson(exported, {
                diagnostics: diagnosticCollector.diagnostics,
              })
            );
          } else {
            console.log(
              [
                formatExportSuccess(exported),
                formatOperationDiagnostics(diagnosticCollector.diagnostics),
              ]
                .filter(Boolean)
                .join('\n\n')
            );
          }
        } catch (error) {
          handleError(error, { json: useJson });
        }
      }
    );
}
