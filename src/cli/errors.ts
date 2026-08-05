/**
 * Error handling utilities and exit codes
 */

import { SessionIntegrityError, type SafeErrorDetails } from '../core/errors.js';

/**
 * CLI exit codes following Unix conventions
 */
export const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  USAGE_ERROR: 2, // Invalid arguments
  NOT_FOUND: 3, // Resource not found
  IO_ERROR: 4, // File/database access error
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Stable fallback codes for legacy CLI failures that did not expose a code in v0.17. */
export const LegacyCliErrorCode = {
  GENERAL_ERROR: 'CLI_GENERAL_ERROR',
  USAGE_ERROR: 'CLI_USAGE_ERROR',
  NOT_FOUND: 'CLI_NOT_FOUND',
  IO_ERROR: 'CLI_IO_ERROR',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

export type LegacyCliErrorCode = (typeof LegacyCliErrorCode)[keyof typeof LegacyCliErrorCode];

/** Existing command-specific JSON fields retained during the v0.17 stderr transition. */
export type LegacyFatalJson = Readonly<Record<string, unknown>>;

/** Options controlling fatal CLI presentation. */
export interface HandleErrorOptions {
  /** Emit one machine-readable fatal object to stderr instead of human text. */
  readonly json?: boolean;
}

/**
 * Custom error class for CLI errors with exit codes
 */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode = ExitCode.GENERAL_ERROR,
    public readonly code?: string,
    public readonly details?: SafeErrorDetails,
    /** Locked v0.17 fields that must remain at the top level of fatal JSON. */
    public readonly legacyJson?: LegacyFatalJson
  ) {
    super(message);
    this.name = 'CliError';
  }
}

function fallbackCode(exitCode: ExitCode): LegacyCliErrorCode {
  switch (exitCode) {
    case ExitCode.USAGE_ERROR:
      return LegacyCliErrorCode.USAGE_ERROR;
    case ExitCode.NOT_FOUND:
      return LegacyCliErrorCode.NOT_FOUND;
    case ExitCode.IO_ERROR:
      return LegacyCliErrorCode.IO_ERROR;
    default:
      return LegacyCliErrorCode.GENERAL_ERROR;
  }
}

/**
 * Convert any fatal value to the single safe JSON object written by `--json` commands.
 *
 * Existing command fields are copied first so the corrective release preserves their
 * names, types, and values. `code` and safe typed `details` are additive.
 */
export function formatFatalJson(error: unknown): string {
  const cliError = error instanceof SessionIntegrityError ? mapSessionIntegrityError(error) : error;

  if (cliError instanceof CliError) {
    const envelope: Record<string, unknown> = {
      ...(cliError.legacyJson ?? { error: cliError.message }),
      code: cliError.code ?? fallbackCode(cliError.exitCode),
    };
    // A malformed legacy envelope must not suppress the required human-safe error field.
    if (typeof envelope['error'] !== 'string' || envelope['error'].length === 0) {
      envelope['error'] = cliError.message;
    }
    if (cliError.details && Object.keys(cliError.details).length > 0) {
      envelope['details'] = cliError.details;
    }
    return JSON.stringify(envelope, null, 2);
  }

  if (cliError instanceof Error) {
    return JSON.stringify(
      {
        error: cliError.message || 'An unexpected error occurred',
        code: LegacyCliErrorCode.UNEXPECTED_ERROR,
      },
      null,
      2
    );
  }

  return JSON.stringify(
    { error: 'An unexpected error occurred', code: LegacyCliErrorCode.UNEXPECTED_ERROR },
    null,
    2
  );
}

/** Map a typed core failure to the stable CLI exit category without adding unsafe details. */
export function mapSessionIntegrityError(error: SessionIntegrityError): CliError {
  const exitCode =
    error.code === 'SOURCE_LIMIT_CONFIGURATION_INVALID' ||
    error.code === 'READ_CONTEXT_OPTIONS_MISMATCH'
      ? ExitCode.USAGE_ERROR
      : error.code === 'SOURCE_ENCODING_INVALID' ||
          error.code === 'SOURCE_LIMIT_EXCEEDED' ||
          error.code === 'TEMPORARY_ARTIFACT_CLEANUP_FAILED' ||
          error.code === 'DATABASE_CAPABILITY_MISSING' ||
          error.code === 'NO_CAPABLE_DATABASE_DRIVER'
        ? ExitCode.IO_ERROR
        : error.code === 'SESSION_SCOPE_MISMATCH'
          ? ExitCode.NOT_FOUND
          : ExitCode.GENERAL_ERROR;
  return new CliError(error.message, exitCode, error.code, error.details);
}

/**
 * Error for when no Cursor installation is found
 */
export class CursorNotFoundError extends CliError {
  constructor(searchPath: string) {
    super(
      `Cursor data not found at: ${searchPath}\n` +
        'Make sure Cursor is installed and has been used at least once.\n' +
        'You can specify a custom path with --data-path or CURSOR_DATA_PATH env var.',
      ExitCode.NOT_FOUND
    );
    this.name = 'CursorNotFoundError';
  }
}

/**
 * Error for when no chat history exists
 */
export class NoHistoryError extends CliError {
  constructor() {
    super(
      'No chat history found.\n' + 'Start a conversation in Cursor to create chat history.',
      ExitCode.NOT_FOUND
    );
    this.name = 'NoHistoryError';
  }
}

type SessionNotFoundErrorArgs = { composerId: string } | { index: number; maxIndex: number };

/**
 * Error when session is not found by index or composer ID.
 */
export class SessionNotFoundError extends CliError {
  constructor(args: SessionNotFoundErrorArgs) {
    const message =
      'composerId' in args
        ? `Session not found: ${args.composerId}`
        : args.maxIndex > 0
          ? `Session #${args.index} not found. Valid range: 1-${args.maxIndex}`
          : 'No sessions found.';
    super(message, ExitCode.NOT_FOUND);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Error for file already exists
 */
export class FileExistsError extends CliError {
  constructor(path: string) {
    super(`File already exists: ${path}\nUse --force to overwrite.`, ExitCode.IO_ERROR);
    this.name = 'FileExistsError';
  }
}

/**
 * Error for search with no results
 */
export class NoSearchResultsError extends CliError {
  constructor(query: string) {
    super(`No results found for: "${query}"`, ExitCode.NOT_FOUND);
    this.name = 'NoSearchResultsError';
  }
}

/**
 * Handle an error and exit with appropriate code
 */
export function handleError(error: unknown, options: HandleErrorOptions = {}): never {
  if (error instanceof SessionIntegrityError) {
    return handleError(mapSessionIntegrityError(error), options);
  }
  if (error instanceof CliError) {
    if (options.json) {
      process.stderr.write(`${formatFatalJson(error)}\n`);
    } else {
      console.error(error.message);
    }
    return process.exit(error.exitCode);
  }

  if (error instanceof Error) {
    if (options.json) {
      process.stderr.write(`${formatFatalJson(error)}\n`);
    } else {
      console.error(`Error: ${error.message}`);
    }
    return process.exit(ExitCode.GENERAL_ERROR);
  }

  if (options.json) {
    process.stderr.write(`${formatFatalJson(error)}\n`);
  } else {
    console.error('An unexpected error occurred');
  }
  return process.exit(ExitCode.GENERAL_ERROR);
}
