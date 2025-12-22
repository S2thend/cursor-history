/**
 * List command - display chat sessions and workspaces
 */

import type { Command } from 'commander';
import { listSessions, listWorkspaces } from '../../core/storage.js';
import {
  formatSessionsTable,
  formatSessionsJson,
  formatWorkspacesTable,
  formatWorkspacesJson,
  formatNoHistory,
  formatCursorNotFound,
} from '../formatters/index.js';
import { getCursorDataPath, expandPath } from '../../lib/platform.js';
import { existsSync } from 'node:fs';

interface ListCommandOptions {
  limit?: string;
  all?: boolean;
  workspaces?: boolean;
  ids?: boolean;
  json?: boolean;
  dataPath?: string;
  workspace?: string;
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
    .action(async (options: ListCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as {
        json?: boolean;
        dataPath?: string;
        workspace?: string;
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const workspaceFilter = options.workspace ?? globalOptions?.workspace;

      if (options.workspaces) {
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
        // List workspaces
        const workspaces = listWorkspaces(customPath ? expandPath(customPath) : undefined);

        if (workspaces.length === 0) {
          if (useJson) {
            console.log(JSON.stringify({ count: 0, workspaces: [] }));
          } else {
            console.log(formatNoHistory());
          }
          return;
        }

        if (useJson) {
          console.log(formatWorkspacesJson(workspaces));
        } else {
          console.log(formatWorkspacesTable(workspaces));
        }
      } else {
        // List sessions
        const limit = options.all ? 0 : parseInt(options.limit ?? '20', 10);
        const sessions = listSessions(
          { limit, all: options.all ?? false, workspacePath: workspaceFilter },
          customPath ? expandPath(customPath) : undefined
        );

        if (sessions.length === 0) {
          if (useJson) {
            console.log(JSON.stringify({ count: 0, sessions: [] }));
          } else {
            console.log(formatNoHistory());
          }
          return;
        }

        if (useJson) {
          console.log(formatSessionsJson(sessions));
        } else {
          console.log(formatSessionsTable(sessions, options.ids ?? false));
        }
      }
    });
}
