/**
 * Search command - search across chat sessions
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { searchSessions } from '../../core/storage.js';
import { validateBackup } from '../../core/backup.js';
import { formatSearchResultsTable, formatSearchResultsJson } from '../formatters/index.js';
import { NoSearchResultsError, handleError } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';

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
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const workspaceFilter = options.workspace ?? globalOptions?.workspace;
      const backupPath = options.backup ? expandPath(options.backup) : undefined;

      const limit = parseInt(options.limit ?? '10', 10);
      const contextChars = parseInt(options.context ?? '50', 10);

      // T036: Validate backup if searching from backup
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
        const results = await searchSessions(
          query,
          { limit, contextChars, workspacePath: workspaceFilter },
          customPath ? expandPath(customPath) : undefined,
          backupPath
        );

        if (results.length === 0) {
          if (useJson) {
            console.log(JSON.stringify({ query, count: 0, totalMatches: 0, results: [] }));
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
          console.log(formatSearchResultsJson(results, query));
        } else {
          console.log(formatSearchResultsTable(results, query));
        }
      } catch (error) {
        handleError(error);
      }
    });
}
