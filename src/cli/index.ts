#!/usr/bin/env node

/**
 * CLI entry point for cursor-history
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleError, ExitCode } from '../lib/errors.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as {
  version: string;
};

// Create main program
const program = new Command();

program
  .name('cursor-history')
  .description('View and search Cursor IDE chat history')
  .version(packageJson.version, '-v, --version', 'Show version number')
  .option('--json', 'Output in JSON format')
  .option('--data-path <path>', 'Custom Cursor data directory')
  .option('-w, --workspace <path>', 'Filter by workspace path');

// Lazy-load commands to avoid circular dependencies
async function loadCommands() {
  const { registerListCommand } = await import('./commands/list.js');
  const { registerShowCommand } = await import('./commands/show.js');
  const { registerSearchCommand } = await import('./commands/search.js');
  const { registerExportCommand } = await import('./commands/export.js');

  registerListCommand(program);
  registerShowCommand(program);
  registerSearchCommand(program);
  registerExportCommand(program);
}

// Main execution
async function main() {
  try {
    await loadCommands();

    // If no arguments, show help
    if (process.argv.length === 2) {
      program.help();
    }

    await program.parseAsync(process.argv);
  } catch (error) {
    handleError(error);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(ExitCode.GENERAL_ERROR);
});
