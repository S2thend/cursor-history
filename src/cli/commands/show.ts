/**
 * Show command - display a single chat session in detail
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { getSession, listSessions } from '../../core/storage.js';
import { validateBackup } from '../../core/backup.js';
import {
  formatSessionDetail,
  formatSessionJson,
  filterMessages,
  validateMessageTypes,
} from '../formatters/index.js';
import { SessionNotFoundError, handleError } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';
import type { MessageType } from '../../core/types.js';
import { MESSAGE_TYPES } from '../../core/types.js';

interface ShowCommandOptions {
  json?: boolean;
  dataPath?: string;
  short?: boolean;
  think?: boolean;
  tool?: boolean;
  error?: boolean;
  backup?: string;
  only?: string;
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
    .option('-b, --backup <path>', 'Read from backup file instead of live data')
    .option(
      '-o, --only <types>',
      'Show only specified message types (user,assistant,tool,thinking,error)'
    )
    .action(async (indexArg: string, options: ShowCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as { json?: boolean; dataPath?: string };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;
      const backupPath = options.backup ? expandPath(options.backup) : undefined;

      const index = parseInt(indexArg, 10);

      if (isNaN(index) || index < 1) {
        handleError(new Error(`Invalid index: ${indexArg}. Must be a positive number.`));
      }

      // Parse and validate message type filter
      let messageFilter: MessageType[] | undefined;
      if (options.only) {
        const types = options.only.split(',').map((t) => t.trim().toLowerCase());
        const invalidTypes = validateMessageTypes(types);
        if (invalidTypes.length > 0) {
          console.error(pc.red(`Invalid message type(s): ${invalidTypes.join(', ')}`));
          console.error(`Valid types: ${MESSAGE_TYPES.join(', ')}`);
          process.exit(1);
        }
        messageFilter = types as MessageType[];
      }

      // T035: Validate backup if reading from backup
      if (backupPath) {
        const validation = await validateBackup(backupPath);
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
        const session = await getSession(
          index,
          customPath ? expandPath(customPath) : undefined,
          backupPath
        );

        if (!session) {
          // Get max index for error message
          const sessions = await listSessions(
            { limit: 0, all: true },
            customPath ? expandPath(customPath) : undefined,
            backupPath
          );
          throw new SessionNotFoundError(index, sessions.length);
        }

        // Show backup source indicator if reading from backup
        if (backupPath && !useJson) {
          console.log(pc.dim(`Reading from backup: ${contractPath(backupPath)}\n`));
        }

        // Apply message type filter if specified
        const originalMessageCount = session.messages.length;
        if (messageFilter && messageFilter.length > 0) {
          session.messages = filterMessages(session.messages, messageFilter);
        }

        if (useJson) {
          console.log(
            formatSessionJson(session, session.workspacePath, messageFilter, originalMessageCount)
          );
        } else {
          console.log(
            formatSessionDetail(session, session.workspacePath, {
              short: options.short ?? false,
              fullThinking: options.think ?? false,
              fullTool: options.tool ?? false,
              fullError: options.error ?? false,
              messageFilter,
              originalMessageCount,
            })
          );
        }
      } catch (error) {
        handleError(error);
      }
    });
}
