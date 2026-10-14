/**
 * UI command - serve a local, read-only web app for browsing chat history.
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { spawn } from 'node:child_process';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';
import { handleCommandError } from '../errors.js';
import type { SourceReadLimitsOverride } from '../../core/types.js';
import { expandPath } from '../../lib/platform.js';
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT, startUiServer } from '../../ui/server.js';

interface UiCommandOptions {
  port?: string;
  host?: string;
  open?: boolean;
  backup?: string;
  json?: boolean;
  dataPath?: string;
  workspace?: string;
}

/** Resolve the platform's browser-opening command. */
function browserCommand(url: string): { command: string; args: string[] } | undefined {
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (process.platform === 'linux') return { command: 'xdg-open', args: [url] };
  return undefined;
}

/** Best-effort browser launch; the URL is always printed regardless. */
function openBrowser(url: string): void {
  const target = browserCommand(url);
  if (!target) return;
  try {
    const child = spawn(target.command, target.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Opening a browser is a convenience; failure is never fatal.
  }
}

/**
 * Register the ui command.
 */
export function registerUiCommand(program: Command): void {
  program
    .command('ui')
    .alias('serve')
    .description('Open a local read-only web app for browsing chat history')
    .option('-p, --port <number>', 'Port to bind', String(DEFAULT_UI_PORT))
    .option('--host <host>', 'Interface to bind (defaults to loopback only)', DEFAULT_UI_HOST)
    .option('--no-open', 'Do not open a browser window')
    .option('-b, --backup <path>', 'Read from backup file instead of live data')
    .addHelpText(
      'after',
      `\nExamples:\n` +
        `  cursor-history ui\n` +
        `  cursor-history ui --port 5000 --no-open\n` +
        `  cursor-history ui --backup ~/cursor-history-backups/latest.zip\n`
    )
    .action(async (options: UiCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as {
        json?: boolean;
        dataPath?: string;
        workspace?: string;
        sourceLimit?: SourceReadLimitsOverride;
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;

      const parsedPort = Number.parseInt(options.port ?? '', 10);
      if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        handleCommandError(
          new Error(`Invalid port "${options.port ?? ''}". Use an integer from 0 to 65535.`),
          { json: useJson }
        );
        return;
      }

      let sourceReadLimits;
      try {
        sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);
      } catch (error) {
        handleCommandError(error, { json: useJson });
        return;
      }

      const host = options.host ?? DEFAULT_UI_HOST;
      let handle;
      try {
        handle = await startUiServer({
          dataPath: customPath ? expandPath(customPath) : undefined,
          backupPath: options.backup ? expandPath(options.backup) : undefined,
          host,
          port: parsedPort,
          sourceReadLimits,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message =
          code === 'EADDRINUSE'
            ? `Port ${parsedPort} is already in use. Try --port ${parsedPort + 1}.`
            : code === 'EACCES'
              ? `Permission denied binding ${host}:${parsedPort}. Try a port above 1024.`
              : error instanceof Error
                ? error.message
                : String(error);
        handleCommandError(new Error(message), { json: useJson });
        return;
      }

      if (host !== DEFAULT_UI_HOST && host !== 'localhost' && host !== '::1') {
        console.error(
          pc.yellow(
            `Warning: binding ${host} exposes your chat history beyond this machine. History reads stay read-only.`
          )
        );
      }

      if (useJson) {
        console.log(
          JSON.stringify({ url: handle.url, host, port: handle.port, dataPath: customPath ?? null })
        );
      } else {
        console.log(pc.bold('cursor-history UI'));
        console.log(`  ${pc.cyan(handle.url)}`);
        console.log(pc.dim('  Read-only. Press Ctrl+C to stop.'));
      }

      if (options.open !== false) openBrowser(handle.url);

      let closing = false;
      const shutdown = async (): Promise<void> => {
        if (closing) return;
        closing = true;
        await handle.close().catch(() => undefined);
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    });
}
