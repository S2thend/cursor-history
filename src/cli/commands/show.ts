/**
 * Show command - display a single chat session in detail
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { validateBackup } from '../../core/backup.js';
import {
  formatSessionDetail,
  formatSessionJson,
  filterMessages,
  validateMessageTypes,
} from '../formatters/index.js';
import { CliError, ExitCode, handleCommandError } from '../errors.js';
import { expandPath, contractPath } from '../../lib/platform.js';
import type { MessageType } from '../../core/types.js';
import { MESSAGE_TYPES } from '../../core/types.js';
import { resolveCommandSession } from './session-lookup.js';
import type { SourceReadLimitsOverride } from '../../core/types.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';

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
    .description('Show a chat session by index or composer ID (from list --ids)')
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
      const backupPath = options.backup ? expandPath(options.backup) : undefined;
      const includeCrossWorkspaceSources = globalOptions?.includeCrossWorkspaceSources ?? false;
      let sourceReadLimits;
      try {
        sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);
      } catch (error) {
        handleCommandError(error, { json: useJson });
      }

      // Only treat arg as index when the entire string is digits
      const identifier: number | string = /^\d+$/.test(indexArg!)
        ? parseInt(indexArg!, 10)
        : indexArg!;

      // CLI uses 1-based index; 0 is invalid
      if (typeof identifier === 'number' && identifier < 1) {
        handleCommandError(
          new CliError(
            `Invalid index: ${indexArg}. Must be a positive number.`,
            ExitCode.GENERAL_ERROR
          ),
          { json: useJson }
        );
      }

      // Parse and validate message type filter
      let messageFilter: MessageType[] | undefined;
      if (options.only) {
        const types = options.only.split(',').map((t) => t.trim().toLowerCase());
        const invalidTypes = validateMessageTypes(types);
        if (invalidTypes.length > 0) {
          handleCommandError(
            new CliError(
              `Invalid message type(s): ${invalidTypes.join(', ')}\nValid types: ${MESSAGE_TYPES.join(', ')}`,
              ExitCode.GENERAL_ERROR
            ),
            { json: useJson }
          );
        }
        messageFilter = types as MessageType[];
      }

      // T035: Validate backup if reading from backup
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

      try {
        const expanded = customPath ? expandPath(customPath) : undefined;
        const session = await resolveCommandSession(
          identifier,
          workspaceFilter,
          expanded,
          backupPath,
          { includeCrossWorkspaceSources, sourceReadLimits }
        );

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
        handleCommandError(error, { json: useJson });
      }
    });
}
