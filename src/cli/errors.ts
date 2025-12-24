/**
 * Error handling utilities and exit codes
 */

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

/**
 * Custom error class for CLI errors with exit codes
 */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode = ExitCode.GENERAL_ERROR
  ) {
    super(message);
    this.name = 'CliError';
  }
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

/**
 * Error for invalid session index
 */
export class SessionNotFoundError extends CliError {
  constructor(index: number, maxIndex: number) {
    const message =
      maxIndex > 0
        ? `Session #${index} not found. Valid range: 1-${maxIndex}`
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
export function handleError(error: unknown): never {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }

  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(ExitCode.GENERAL_ERROR);
  }

  console.error('An unexpected error occurred');
  process.exit(ExitCode.GENERAL_ERROR);
}
