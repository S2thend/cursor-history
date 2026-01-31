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

/**
 * Thrown when invalid message filter types are provided.
 *
 * Recovery: Use valid message types: 'user', 'assistant', 'tool', 'thinking', 'error'.
 */
export class InvalidFilterError extends Error {
  name = 'InvalidFilterError' as const;

  /** The invalid filter types provided */
  invalidTypes: string[];

  /** The valid filter types */
  validTypes: readonly string[];

  constructor(invalidTypes: string[], validTypes: readonly string[]) {
    super(
      `Invalid message type(s): ${invalidTypes.join(', ')}. ` +
        `Valid types: ${validTypes.join(', ')}`
    );
    this.invalidTypes = invalidTypes;
    this.validTypes = validTypes;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidFilterError);
    }
  }
}

/**
 * Type guard to check if an error is an InvalidFilterError.
 */
export function isInvalidFilterError(error: unknown): error is InvalidFilterError {
  return error instanceof InvalidFilterError;
}

// ============================================================================
// Migration Errors
// ============================================================================

/**
 * Thrown when a session ID or index cannot be resolved.
 *
 * Recovery: Check session exists with `listSessions()`, use valid ID or index.
 */
export class SessionNotFoundError extends Error {
  name = 'SessionNotFoundError' as const;

  /** The identifier that was not found (index or UUID) */
  identifier: string | number;

  constructor(identifier: string | number) {
    super(`Session not found: ${identifier}. Use 'cursor-history list' to see available sessions.`);
    this.identifier = identifier;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SessionNotFoundError);
    }
  }
}

/**
 * Thrown when destination workspace path has no workspace directory.
 *
 * Recovery: Open the project in Cursor first to create the workspace directory.
 */
export class WorkspaceNotFoundError extends Error {
  name = 'WorkspaceNotFoundError' as const;

  /** The workspace path that was not found */
  path: string;

  constructor(path: string) {
    super(`No workspace found for path: ${path}. Please open the project in Cursor first.`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WorkspaceNotFoundError);
    }
  }
}

/**
 * Thrown when source and destination paths are the same.
 *
 * Recovery: Specify different source and destination paths.
 */
export class SameWorkspaceError extends Error {
  name = 'SameWorkspaceError' as const;

  /** The path that was specified for both source and destination */
  path: string;

  constructor(path: string) {
    super(`Source and destination are the same: ${path}`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SameWorkspaceError);
    }
  }
}

/**
 * Thrown when no sessions are found for the specified source workspace.
 *
 * Recovery: Check the source path is correct, verify sessions exist with `list --workspace`.
 */
export class NoSessionsFoundError extends Error {
  name = 'NoSessionsFoundError' as const;

  /** The source workspace path */
  path: string;

  constructor(path: string) {
    super(`No sessions found for workspace: ${path}. Use 'cursor-history list --workspace "${path}"' to verify.`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, NoSessionsFoundError);
    }
  }
}

/**
 * Thrown when destination has existing sessions and --force not specified.
 *
 * Recovery: Use --force flag to proceed with additive merge.
 */
export class DestinationHasSessionsError extends Error {
  name = 'DestinationHasSessionsError' as const;

  /** The destination workspace path */
  path: string;

  /** Number of existing sessions at destination */
  sessionCount: number;

  constructor(path: string, sessionCount: number) {
    super(
      `Destination already has ${sessionCount} session(s): ${path}. ` +
        `Use --force to proceed (will add sessions alongside existing ones).`
    );
    this.path = path;
    this.sessionCount = sessionCount;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DestinationHasSessionsError);
    }
  }
}

/**
 * Type guard to check if an error is a SessionNotFoundError.
 */
export function isSessionNotFoundError(error: unknown): error is SessionNotFoundError {
  return error instanceof SessionNotFoundError;
}

/**
 * Type guard to check if an error is a WorkspaceNotFoundError.
 */
export function isWorkspaceNotFoundError(error: unknown): error is WorkspaceNotFoundError {
  return error instanceof WorkspaceNotFoundError;
}

/**
 * Type guard to check if an error is a SameWorkspaceError.
 */
export function isSameWorkspaceError(error: unknown): error is SameWorkspaceError {
  return error instanceof SameWorkspaceError;
}

/**
 * Type guard to check if an error is a NoSessionsFoundError.
 */
export function isNoSessionsFoundError(error: unknown): error is NoSessionsFoundError {
  return error instanceof NoSessionsFoundError;
}

/**
 * Type guard to check if an error is a DestinationHasSessionsError.
 */
export function isDestinationHasSessionsError(error: unknown): error is DestinationHasSessionsError {
  return error instanceof DestinationHasSessionsError;
}

/**
 * Thrown when destination workspace path is nested within source workspace.
 *
 * Recovery: Choose a destination that is not a subdirectory of the source.
 */
export class NestedPathError extends Error {
  name = 'NestedPathError' as const;

  /** The source workspace path */
  source: string;

  /** The destination workspace path (nested in source) */
  destination: string;

  constructor(source: string, destination: string) {
    super(
      `Destination path is nested within source: ${destination} is inside ${source}. ` +
        `This would cause infinite path replacement loops. Choose a different destination.`
    );
    this.source = source;
    this.destination = destination;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, NestedPathError);
    }
  }
}

/**
 * Type guard to check if an error is a NestedPathError.
 */
export function isNestedPathError(error: unknown): error is NestedPathError {
  return error instanceof NestedPathError;
}

// ============================================================================
// Backup Errors
// ============================================================================

/**
 * Base error for backup operations.
 *
 * Recovery: Check specific subclass for targeted recovery actions.
 */
export class BackupError extends Error {
  override name: string = 'BackupError';

  constructor(message: string) {
    super(message);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BackupError);
    }
  }
}

/**
 * Thrown when there is no Cursor data to backup.
 *
 * Recovery: Verify Cursor is installed and has been used.
 */
export class NoDataError extends BackupError {
  override name = 'NoDataError';

  /** Path that was checked for data */
  path: string;

  constructor(path: string) {
    super(`No Cursor data found at: ${path}. Verify Cursor is installed and has been used.`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, NoDataError);
    }
  }
}

/**
 * Thrown when output file already exists.
 *
 * Recovery: Use force: true to overwrite, or specify different output path.
 */
export class FileExistsError extends BackupError {
  override name = 'FileExistsError';

  /** Path to existing file */
  path: string;

  constructor(path: string) {
    super(`File already exists: ${path}. Use --force to overwrite.`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FileExistsError);
    }
  }
}

/**
 * Thrown when there is insufficient disk space for backup.
 *
 * Recovery: Free up disk space or specify different output location.
 */
export class InsufficientSpaceError extends BackupError {
  override name = 'InsufficientSpaceError';

  /** Required space in bytes */
  required: number;

  /** Available space in bytes */
  available: number;

  constructor(required: number, available: number) {
    const reqMB = (required / 1024 / 1024).toFixed(1);
    const avaMB = (available / 1024 / 1024).toFixed(1);
    super(`Insufficient disk space: need ${reqMB} MB, only ${avaMB} MB available.`);
    this.required = required;
    this.available = available;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InsufficientSpaceError);
    }
  }
}

/**
 * Base error for restore operations.
 *
 * Recovery: Check specific subclass for targeted recovery actions.
 */
export class RestoreError extends Error {
  override name: string = 'RestoreError';

  constructor(message: string) {
    super(message);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RestoreError);
    }
  }
}

/**
 * Thrown when backup file is not found.
 *
 * Recovery: Verify backup file path is correct.
 */
export class BackupNotFoundError extends RestoreError {
  override name = 'BackupNotFoundError';

  /** Path to backup file that was not found */
  path: string;

  constructor(path: string) {
    super(`Backup file not found: ${path}`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BackupNotFoundError);
    }
  }
}

/**
 * Thrown when backup file is invalid or corrupted.
 *
 * Recovery: Use a different backup file, or attempt to repair with external tools.
 */
export class InvalidBackupError extends RestoreError {
  override name = 'InvalidBackupError';

  /** Path to invalid backup file */
  path: string;

  /** Reason for invalidity */
  reason: string;

  constructor(path: string, reason: string) {
    super(`Invalid backup file: ${path}. ${reason}`);
    this.path = path;
    this.reason = reason;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidBackupError);
    }
  }
}

/**
 * Thrown when target directory already has Cursor data.
 *
 * Recovery: Use force: true to overwrite, or specify different target path.
 */
export class TargetExistsError extends RestoreError {
  override name = 'TargetExistsError';

  /** Path to existing target */
  path: string;

  constructor(path: string) {
    super(`Target already has Cursor data: ${path}. Use --force to overwrite.`);
    this.path = path;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TargetExistsError);
    }
  }
}

/**
 * Thrown when backup integrity check fails critically.
 *
 * Recovery: Backup may be corrupted beyond repair; try a different backup.
 */
export class IntegrityError extends RestoreError {
  override name = 'IntegrityError';

  /** Files that failed integrity check */
  failedFiles: string[];

  constructor(failedFiles: string[]) {
    super(`Backup integrity check failed for ${failedFiles.length} file(s): ${failedFiles.join(', ')}`);
    this.failedFiles = failedFiles;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IntegrityError);
    }
  }
}

/**
 * Type guard to check if an error is a BackupError or subclass.
 */
export function isBackupError(error: unknown): error is BackupError {
  return error instanceof BackupError;
}

/**
 * Type guard to check if an error is a RestoreError or subclass.
 */
export function isRestoreError(error: unknown): error is RestoreError {
  return error instanceof RestoreError;
}

/**
 * Type guard to check if an error is an InvalidBackupError.
 */
export function isInvalidBackupError(error: unknown): error is InvalidBackupError {
  return error instanceof InvalidBackupError;
}

/**
 * Type guard to check if an error is a NoDataError.
 */
export function isNoDataError(error: unknown): error is NoDataError {
  return error instanceof NoDataError;
}

/**
 * Type guard to check if an error is a FileExistsError.
 */
export function isFileExistsError(error: unknown): error is FileExistsError {
  return error instanceof FileExistsError;
}

/**
 * Type guard to check if an error is an InsufficientSpaceError.
 */
export function isInsufficientSpaceError(error: unknown): error is InsufficientSpaceError {
  return error instanceof InsufficientSpaceError;
}

/**
 * Type guard to check if an error is a BackupNotFoundError.
 */
export function isBackupNotFoundError(error: unknown): error is BackupNotFoundError {
  return error instanceof BackupNotFoundError;
}

/**
 * Type guard to check if an error is a TargetExistsError.
 */
export function isTargetExistsError(error: unknown): error is TargetExistsError {
  return error instanceof TargetExistsError;
}

/**
 * Type guard to check if an error is an IntegrityError.
 */
export function isIntegrityError(error: unknown): error is IntegrityError {
  return error instanceof IntegrityError;
}
