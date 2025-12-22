/**
 * Show command - display a single chat session in detail
 */

import type { Command } from 'commander';
import { getSession, listSessions } from '../../core/storage.js';
import { formatSessionDetail, formatSessionJson } from '../formatters/index.js';
import { SessionNotFoundError, handleError } from '../../lib/errors.js';
import { expandPath } from '../../lib/platform.js';

interface ShowCommandOptions {
  json?: boolean;
  dataPath?: string;
  short?: boolean;
  think?: boolean;
  tool?: boolean;
  error?: boolean;
}

/**
 * Register the show command
 */
export function registerShowCommand(program: Command): void {
  program
    .command('show <index>')
    .description('Show a chat session by index')
    .option('-s, --short', 'Truncate user and assistant messages')
    .option('-t, --think', 'Show full thinking/reasoning text')
    .option('--tool', 'Show full tool call details (commands, content, results)')
    .option('-e, --error', 'Show full error messages (default: truncated)')
    .action(async (indexArg: string, options: ShowCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as { json?: boolean; dataPath?: string };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;

      const index = parseInt(indexArg, 10);

      if (isNaN(index) || index < 1) {
        handleError(new Error(`Invalid index: ${indexArg}. Must be a positive number.`));
      }

      try {
        const session = getSession(index, customPath ? expandPath(customPath) : undefined);

        if (!session) {
          // Get max index for error message
          const sessions = listSessions(
            { limit: 0, all: true },
            customPath ? expandPath(customPath) : undefined
          );
          throw new SessionNotFoundError(index, sessions.length);
        }

        if (useJson) {
          console.log(formatSessionJson(session, session.workspacePath));
        } else {
          console.log(
            formatSessionDetail(session, session.workspacePath, {
              short: options.short ?? false,
              fullThinking: options.think ?? false,
              fullTool: options.tool ?? false,
              fullError: options.error ?? false,
            })
          );
        }
      } catch (error) {
        handleError(error);
      }
    });
}
