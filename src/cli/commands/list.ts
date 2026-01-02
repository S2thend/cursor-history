/**
 * List command - display chat sessions and workspaces
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { listSessions, listWorkspaces } from '../../core/storage.js';
import { validateBackup } from '../../core/backup.js';
import {
  formatSessionsTable,
  formatSessionsJson,
  formatWorkspacesTable,
  formatWorkspacesJson,
  formatNoHistory,
  formatCursorNotFound,
} from '../formatters/index.js';
import { getCursorDataPath, expandPath, contractPath } from '../../lib/platform.js';
import { existsSync } from 'node:fs';

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
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const workspaceFilter = options.workspace ?? globalOptions?.workspace;
      const backupPath = options.backup ? expandPath(options.backup) : undefined;

      // T034: Validate backup if reading from backup
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

      if (options.workspaces) {
        // For backup mode, skip Cursor data check - we read from backup
        if (!backupPath) {
          // Verify Cursor data exists for workspaces listing
          const dataPath = getCursorDataPath(customPath ? expandPath(customPath) : undefined);
          if (!existsSync(dataPath)) {
            if (useJson) {
              console.log(JSON.stringify({ error: 'Cursor data not found', path: dataPath }));
            } else {
              console.log(formatCursorNotFound(dataPath));
            }
            process.exit(3);
          }
        }
        // List workspaces
        const workspaces = await listWorkspaces(
          customPath ? expandPath(customPath) : undefined,
          backupPath
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
        const sessions = await listSessions(
          { limit, all: options.all ?? false, workspacePath: workspaceFilter },
          customPath ? expandPath(customPath) : undefined,
          backupPath
        );

        if (sessions.length === 0) {
          if (useJson) {
            console.log(JSON.stringify({ count: 0, sessions: [] }));
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
          console.log(formatSessionsJson(sessions));
        } else {
          console.log(formatSessionsTable(sessions, options.ids ?? false));
        }
      }
    });
}
