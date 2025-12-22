/**
 * Search command - search across chat sessions
 */

import type { Command } from 'commander';
import { searchSessions } from '../../core/storage.js';
import { formatSearchResultsTable, formatSearchResultsJson } from '../formatters/index.js';
import { NoSearchResultsError, handleError } from '../../lib/errors.js';
import { expandPath } from '../../lib/platform.js';

interface SearchCommandOptions {
  limit?: string;
  context?: string;
  json?: boolean;
  dataPath?: string;
  workspace?: string;
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
    .action(async (query: string, options: SearchCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as {
        json?: boolean;
        dataPath?: string;
        workspace?: string;
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const workspaceFilter = options.workspace ?? globalOptions?.workspace;

      const limit = parseInt(options.limit ?? '10', 10);
      const contextChars = parseInt(options.context ?? '50', 10);

      try {
        const results = searchSessions(
          query,
          { limit, contextChars, workspacePath: workspaceFilter },
          customPath ? expandPath(customPath) : undefined
        );

        if (results.length === 0) {
          if (useJson) {
            console.log(JSON.stringify({ query, count: 0, totalMatches: 0, results: [] }));
          } else {
            throw new NoSearchResultsError(query);
          }
          return;
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
