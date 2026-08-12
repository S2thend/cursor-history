#!/usr/bin/env node

/**
 * CLI entry point for cursor-history
 */

import { Command, CommanderError } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CliError, handleError, ExitCode } from './errors.js';
import { parseSourceLimitOption, validateCliSourceLimitArguments } from './source-limit-option.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as {
  version: string;
};

/** Closed command inventory used by fatal/source-limit coverage gates. */
export const CLI_COMMAND_REGISTRY = Object.freeze({
  list: Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['notFound', 'io', 'unexpected'] as const),
  }),
  show: Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['usage', 'notFound', 'io', 'unexpected'] as const),
  }),
  search: Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['notFound', 'io', 'unexpected'] as const),
  }),
  export: Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['usage', 'notFound', 'io', 'unexpected'] as const),
  }),
  migrate: Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['general', 'usage', 'io', 'unexpected'] as const),
  }),
  'migrate-session': Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['general', 'usage', 'notFound', 'io', 'unexpected'] as const),
  }),
  backup: Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['general', 'usage', 'notFound', 'io', 'unexpected'] as const),
  }),
  restore: Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze([
      'general',
      'usage',
      'notFound',
      'io',
      'integrity',
      'unexpected',
    ] as const),
  }),
  'list-backups': Object.freeze({
    sourceReadLimits: true,
    fatalCategories: Object.freeze(['usage', 'io', 'unexpected'] as const),
  }),
});

/** Root-only failure paths covered independently of subcommand handlers. */
export const CLI_ROOT_FATAL_CATEGORIES = Object.freeze([
  'usage',
  'commandLoading',
  'unexpected',
  'sourceLimitConfiguration',
  'sourceEncoding',
  'sourceLimitExceeded',
  'databaseCapability',
  'temporaryArtifactCleanup',
] as const);

// Create main program
export const program = new Command();

program
  .name('cursor-history')
  .description('View and search Cursor IDE chat history')
  .version(packageJson.version, '-v, --version', 'Show version number')
  .option('--json', 'Write successful structured results to stdout and fatal JSON to stderr')
  .option('--data-path <path>', 'Read one custom Cursor workspaceStorage data source')
  .option(
    '--source-limit <field=value>',
    'Override one Source Read Limits v1 field=value for this operation (repeatable by field)',
    parseSourceLimitOption
  )
  .option(
    '--include-cross-workspace-sources',
    'Read complementary sources only for session UUIDs already selected by --workspace'
  )
  .option(
    '-w, --workspace <path>',
    'Select an exact-first, unambiguous component-suffix workspace and payload-I/O scope'
  )
  .addHelpText(
    'after',
    `\nAddressing and safety:\n` +
      `  CLI indices are one-based, ephemeral, and scoped to the same data source and --workspace.\n` +
      `  --workspace is an exact-first, unambiguous component-suffix membership and payload-I/O boundary.\n` +
      `  An ambiguous suffix fails with candidates; use a longer path. For an empty scope, run list --workspaces.\n` +
      `  Scoped results can be explicitly partial. Cross-workspace reads require the opt-in and remain UUID-selected.\n` +
      `  migrate-session binds one Composer-only target; Store, merged, or ambiguous occurrences are refused.\n` +
      `  --source-limit uses FIELD=positive-integer or byte FIELD=number{KiB|MiB|GiB}; repeat fields are refused.\n` +
      `  Raising a source bound increases resource exposure and never changes session or message identity.\n` +
      `  Backup archives are private by default; use backup --shared only when shared access is intended.\n\n` +
      `Examples:\n` +
      `  cursor-history --json --workspace /work/a list --all\n` +
      `  cursor-history --json --workspace /work/a show 1\n` +
      `  cursor-history --json --workspace /work/a search needle-a\n` +
      `  cursor-history --workspace /work/a --include-cross-workspace-sources show 1\n` +
      `  cursor-history --workspace /work/a migrate-session 1 /work/destination --dry-run\n` +
      `  cursor-history backup --shared\n`
  );

// Lazy-load commands to avoid circular dependencies
export async function loadCommands(target: Command = program): Promise<void> {
  const { registerListCommand } = await import('./commands/list.js');
  const { registerShowCommand } = await import('./commands/show.js');
  const { registerSearchCommand } = await import('./commands/search.js');
  const { registerExportCommand } = await import('./commands/export.js');
  const { registerMigrateSessionCommand } = await import('./commands/migrate-session.js');
  const { registerMigrateCommand } = await import('./commands/migrate.js');
  const { registerBackupCommand } = await import('./commands/backup.js');
  const { registerRestoreCommand } = await import('./commands/restore.js');
  const { registerListBackupsCommand } = await import('./commands/list-backups.js');

  registerListCommand(target);
  registerShowCommand(target);
  registerSearchCommand(target);
  registerExportCommand(target);
  registerMigrateSessionCommand(target);
  registerMigrateCommand(target);
  registerBackupCommand(target);
  registerRestoreCommand(target);
  registerListBackupsCommand(target);
}

function jsonRequested(argv: readonly string[]): boolean {
  return argv.some((argument) => argument === '--json');
}

function commandLineError(error: CommanderError): CliError {
  // Commander v0.17 parsing failures used its general-error exit category (1). Keep that category;
  // typed Source Read Limits validation is the documented usage-category (2) exception.
  return new CliError(error.message, ExitCode.GENERAL_ERROR, LegacyCommanderCode.GENERAL);
}

const LegacyCommanderCode = Object.freeze({ GENERAL: 'CLI_GENERAL_ERROR' });

// Main execution
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const useJson = jsonRequested(argv);
  try {
    // Preserve typed source-policy failures and validate cross-field constraints before even lazy
    // command loading, which in turn guarantees rejection before source payload I/O.
    validateCliSourceLimitArguments(argv.slice(2));
    await loadCommands();

    program.exitOverride();
    program.configureOutput({
      writeErr: (text) => {
        if (!useJson) process.stderr.write(text);
      },
      outputError: (text, write) => {
        if (!useJson) write(text);
      },
    });

    // If no arguments, show help
    if (argv.length === 2) {
      program.help();
    }

    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    handleError(error instanceof CommanderError ? commandLineError(error) : error, {
      json: useJson,
    });
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    handleError(error, { json: jsonRequested(process.argv) });
  });
}
