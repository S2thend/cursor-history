/**
 * Export command - export chat sessions to files
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSession, listSessions, findWorkspaces } from '../../core/storage.js';
import { validateBackup } from '../../core/backup.js';
import { exportToMarkdown, exportToJson } from '../../core/parser.js';
import { formatExportSuccess, formatExportResultJson } from '../formatters/index.js';
import {
  SessionNotFoundError,
  FileExistsError,
  handleError,
  CliError,
  ExitCode,
} from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';

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
    .description('Export chat session(s) to file')
    .option('-o, --output <path>', 'Output file or directory')
    .option('-f, --format <format>', 'Output format: md or json', 'md')
    .option('--force', 'Overwrite existing files')
    .option('-a, --all', 'Export all sessions')
    .option('-b, --backup <path>', 'Export from backup file instead of live data')
    .action(
      async (indexArg: string | undefined, options: ExportCommandOptions, command: Command) => {
        const globalOptions = command.parent?.opts() as { json?: boolean; dataPath?: string };
        const useJson = options.json ?? globalOptions?.json ?? false;
        const customPath = options.dataPath ?? globalOptions?.dataPath;
        const format = options.format === 'json' ? 'json' : 'md';
        const backupPath = options.backup ? expandPath(options.backup) : undefined;

        // T037: Validate backup if exporting from backup
        if (backupPath) {
          const validation = validateBackup(backupPath);
          if (validation.status === 'invalid') {
            if (useJson) {
              console.log(JSON.stringify({ error: 'Invalid backup', errors: validation.errors }));
            } else {
              console.error(pc.red('Invalid backup file:'));
              for (const err of validation.errors) {
                console.error(pc.dim(`  ${err}`));
              }
            }
            process.exit(3);
          }
          if (validation.status === 'warnings' && !useJson) {
            console.error(pc.yellow(`Warning: Backup has integrity issues (${validation.corruptedFiles.length} corrupted files)`));
            console.error(pc.dim('Continuing with intact files...\n'));
          }
        }

        try {
          // Validate arguments
          if (!options.all && !indexArg) {
            throw new CliError(
              'Please specify a session index or use --all to export all sessions.',
              ExitCode.USAGE_ERROR
            );
          }

          const exported: { index: number; path: string }[] = [];

          if (options.all) {
            // Export all sessions
            const sessions = await listSessions(
              { limit: 0, all: true },
              customPath ? expandPath(customPath) : undefined,
              backupPath
            );

            if (sessions.length === 0) {
              throw new CliError('No sessions to export.', ExitCode.NOT_FOUND);
            }

            // Determine output directory
            const outputDir = options.output ? expandPath(options.output) : process.cwd();

            // Create directory if needed
            if (!existsSync(outputDir)) {
              mkdirSync(outputDir, { recursive: true });
            }

            const workspaces = await findWorkspaces(
              customPath ? expandPath(customPath) : undefined,
              backupPath
            );

            // Show backup source indicator if exporting from backup
            if (backupPath && !useJson) {
              console.log(pc.dim(`Exporting from backup: ${contractPath(backupPath)}\n`));
            }

            for (const summary of sessions) {
              const session = await getSession(
                summary.index,
                customPath ? expandPath(customPath) : undefined,
                backupPath
              );
              if (!session) continue;

              const workspace = workspaces.find((w) => w.id === session.workspaceId);
              const workspacePath = workspace?.path;

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
                format === 'json'
                  ? exportToJson(session, workspacePath)
                  : exportToMarkdown(session, workspacePath);

              writeFileSync(filePath, content, 'utf-8');
              exported.push({ index: session.index, path: contractPath(filePath) });
            }
          } else {
            // Export single session
            const index = parseInt(indexArg!, 10);

            if (isNaN(index) || index < 1) {
              throw new CliError(
                `Invalid index: ${indexArg}. Must be a positive number.`,
                ExitCode.USAGE_ERROR
              );
            }

            const session = await getSession(
              index,
              customPath ? expandPath(customPath) : undefined,
              backupPath
            );

            if (!session) {
              const sessions = await listSessions(
                { limit: 0, all: true },
                customPath ? expandPath(customPath) : undefined,
                backupPath
              );
              throw new SessionNotFoundError(index, sessions.length);
            }

            const workspaces = await findWorkspaces(
              customPath ? expandPath(customPath) : undefined,
              backupPath
            );
            const workspace = workspaces.find((w) => w.id === session.workspaceId);
            const workspacePath = workspace?.path;

            // Determine output path
            let outputPath: string;
            if (options.output) {
              outputPath = expandPath(options.output);
            } else {
              const dateStr = session.createdAt.toISOString().split('T')[0];
              const safeTitle = (session.title ?? 'untitled')
                .replace(/[^a-zA-Z0-9-_]/g, '_')
                .slice(0, 30);
              outputPath = `${dateStr}-${index}-${safeTitle}.${format}`;
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
            const content =
              format === 'json'
                ? exportToJson(session, workspacePath)
                : exportToMarkdown(session, workspacePath);

            writeFileSync(outputPath, content, 'utf-8');
            exported.push({ index, path: contractPath(outputPath) });
          }

          // Output result
          if (useJson) {
            console.log(formatExportResultJson(exported));
          } else {
            console.log(formatExportSuccess(exported));
          }
        } catch (error) {
          handleError(error);
        }
      }
    );
}
