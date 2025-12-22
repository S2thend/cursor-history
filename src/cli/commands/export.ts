/**
 * Export command - export chat sessions to files
 */

import type { Command } from 'commander';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSession, listSessions, findWorkspaces } from '../../core/storage.js';
import { exportToMarkdown, exportToJson } from '../../core/parser.js';
import { formatExportSuccess, formatExportResultJson } from '../formatters/index.js';
import {
  SessionNotFoundError,
  FileExistsError,
  handleError,
  CliError,
  ExitCode,
} from '../../lib/errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';

interface ExportCommandOptions {
  output?: string;
  format?: string;
  force?: boolean;
  all?: boolean;
  json?: boolean;
  dataPath?: string;
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
    .action(
      async (indexArg: string | undefined, options: ExportCommandOptions, command: Command) => {
        const globalOptions = command.parent?.opts() as { json?: boolean; dataPath?: string };
        const useJson = options.json ?? globalOptions?.json ?? false;
        const customPath = options.dataPath ?? globalOptions?.dataPath;
        const format = options.format === 'json' ? 'json' : 'md';

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
            const sessions = listSessions(
              { limit: 0, all: true },
              customPath ? expandPath(customPath) : undefined
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

            const workspaces = findWorkspaces(customPath ? expandPath(customPath) : undefined);

            for (const summary of sessions) {
              const session = getSession(
                summary.index,
                customPath ? expandPath(customPath) : undefined
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

            const session = getSession(index, customPath ? expandPath(customPath) : undefined);

            if (!session) {
              const sessions = listSessions(
                { limit: 0, all: true },
                customPath ? expandPath(customPath) : undefined
              );
              throw new SessionNotFoundError(index, sessions.length);
            }

            const workspaces = findWorkspaces(customPath ? expandPath(customPath) : undefined);
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
