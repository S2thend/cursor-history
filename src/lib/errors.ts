/**
 * Custom error classes for library API
 *
 * IMPORTANT: This is a library interface for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API.
 */

/**
 * Thrown when database is locked by Cursor or another process.
 *
 * Recovery: Close Cursor IDE and retry, or implement custom retry logic.
 */
export class DatabaseLockedError extends Error {
  name = 'DatabaseLockedError' as const;

  /** Path to locked database file */
  path: string;

  constructor(path: string) {
    super(`Database is locked: ${path}. Close Cursor or retry later.`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DatabaseLockedError);
    }
  }
}

/**
 * Thrown when database file or directory does not exist.
 *
 * Recovery: Verify Cursor is installed, check dataPath configuration.
 */
export class DatabaseNotFoundError extends Error {
  name = 'DatabaseNotFoundError' as const;

  /** Path that was not found */
  path: string;

  constructor(path: string) {
    super(`Database not found: ${path}. Check dataPath configuration.`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DatabaseNotFoundError);
    }
  }
}

/**
 * Thrown when configuration parameters are invalid.
 *
 * Recovery: Fix configuration values per LibraryConfig validation rules.
 */
export class InvalidConfigError extends Error {
  name = 'InvalidConfigError' as const;

  /** Name of invalid config field */
  field: string;

  /** Invalid value provided */
  value: unknown;

  constructor(field: string, value: unknown, reason: string) {
    super(`Invalid config.${field}: ${reason} (got: ${JSON.stringify(value)})`);
    this.field = field;
    this.value = value;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidConfigError);
    }
  }
}

/**
 * Type guard to check if an error is a DatabaseLockedError.
 */
export function isDatabaseLockedError(error: unknown): error is DatabaseLockedError {
  return error instanceof DatabaseLockedError;
}

/**
 * Type guard to check if an error is a DatabaseNotFoundError.
 */
export function isDatabaseNotFoundError(error: unknown): error is DatabaseNotFoundError {
  return error instanceof DatabaseNotFoundError;
}

/**
 * Type guard to check if an error is an InvalidConfigError.
 */
export function isInvalidConfigError(error: unknown): error is InvalidConfigError {
  return error instanceof InvalidConfigError;
}
