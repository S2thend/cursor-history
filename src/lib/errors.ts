/**
 * Custom error classes for library API
 *
 * IMPORTANT: This is a library interface for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API.
 */

import {
  BackupPublishedPermissionError,
  BackupPublishedCleanupError,
  DatabaseCapabilityError,
  MigrationTargetChangedError,
  NoCapableDriverError,
  ReadContextDisposedError,
  ReadContextError,
  ReadContextOptionsMismatchError,
  ReadContextScopeMismatchError,
  ReadContextSourceMismatchError,
  RestoreRollbackError,
  SessionAmbiguityError,
  SessionIntegrityError,
  SessionScopeMismatchError,
  SourceEncodingError,
  SourceLimitConfigurationError,
  SourceLimitExceededError,
  TemporaryArtifactCleanupError,
  UnsupportedSessionMigrationError,
  WorkspaceAmbiguityError,
  isSessionIntegrityError,
} from '../core/errors.js';

/**
 * Thrown when database is locked by Cursor or another process.
 *
 * Recovery: Close Cursor IDE and retry, or implement custom retry logic.
 *
 * @param path - Path to the locked database.
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
 *
 * @param path - Path that could not be found.
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
 *
 * @param field - Public configuration field that failed validation.
 * @param value - Invalid caller value.
 * @param reason - Stable explanation of the violated constraint.
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
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link DatabaseLockedError}.
 */
export function isDatabaseLockedError(error: unknown): error is DatabaseLockedError {
  return error instanceof DatabaseLockedError;
}

/**
 * Type guard to check if an error is a DatabaseNotFoundError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link DatabaseNotFoundError}.
 */
export function isDatabaseNotFoundError(error: unknown): error is DatabaseNotFoundError {
  return error instanceof DatabaseNotFoundError;
}

/**
 * Type guard to check if an error is an InvalidConfigError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is an {@link InvalidConfigError}.
 */
export function isInvalidConfigError(error: unknown): error is InvalidConfigError {
  return error instanceof InvalidConfigError;
}

/**
 * Thrown when invalid message filter types are provided.
 *
 * Recovery: Use valid message types: 'user', 'assistant', 'tool', 'thinking', 'error'.
 *
 * @param invalidTypes - Unsupported message filter names supplied by the caller.
 * @param validTypes - Complete read-only set of accepted message filter names.
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
 *
 * @param error - Unknown caught value.
 * @returns True when the value is an {@link InvalidFilterError}.
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
 *
 * @param identifier - Unresolved zero-based library index or native session ID.
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
 *
 * @param path - Destination workspace path that has not been initialized by Cursor.
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
 *
 * @param path - Normalized path shared by source and destination.
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
 *
 * @param path - Normalized source workspace path with no sessions.
 */
export class NoSessionsFoundError extends Error {
  name = 'NoSessionsFoundError' as const;

  /** The source workspace path */
  path: string;

  constructor(path: string) {
    super(
      `No sessions found for workspace: ${path}. Use 'cursor-history list --workspace "${path}"' to verify.`
    );
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
 *
 * @param path - Destination workspace containing existing sessions.
 * @param sessionCount - Existing logical session count at the destination.
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
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SessionNotFoundError}.
 */
export function isSessionNotFoundError(error: unknown): error is SessionNotFoundError {
  return error instanceof SessionNotFoundError;
}

/**
 * Type guard to check if an error is a WorkspaceNotFoundError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link WorkspaceNotFoundError}.
 */
export function isWorkspaceNotFoundError(error: unknown): error is WorkspaceNotFoundError {
  return error instanceof WorkspaceNotFoundError;
}

/**
 * Type guard to check if an error is a SameWorkspaceError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SameWorkspaceError}.
 */
export function isSameWorkspaceError(error: unknown): error is SameWorkspaceError {
  return error instanceof SameWorkspaceError;
}

/**
 * Type guard to check if an error is a NoSessionsFoundError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link NoSessionsFoundError}.
 */
export function isNoSessionsFoundError(error: unknown): error is NoSessionsFoundError {
  return error instanceof NoSessionsFoundError;
}

/**
 * Type guard to check if an error is a DestinationHasSessionsError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link DestinationHasSessionsError}.
 */
export function isDestinationHasSessionsError(
  error: unknown
): error is DestinationHasSessionsError {
  return error instanceof DestinationHasSessionsError;
}

/**
 * Thrown when destination workspace path is nested within source workspace.
 *
 * Recovery: Choose a destination that is not a subdirectory of the source.
 *
 * @param source - Normalized source workspace path.
 * @param destination - Normalized destination nested inside the source.
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
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link NestedPathError}.
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
 *
 * @param message - Safe human-readable backup failure summary.
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
 *
 * @param path - Source path checked for Cursor data.
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
 *
 * @param path - Existing output path that was protected from overwrite.
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
 *
 * @param required - Required free space in bytes.
 * @param available - Available free space in bytes.
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
 *
 * @param message - Safe human-readable restore failure summary.
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
 *
 * @param path - Requested backup path that could not be found.
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
 *
 * @param path - Backup archive that failed validation.
 * @param reason - Safe explanation of the validation failure.
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
 *
 * @param path - Existing restore target protected from overwrite.
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
 *
 * @param failedFiles - Archive-relative files that failed integrity checks.
 */
export class IntegrityError extends RestoreError {
  override name = 'IntegrityError';

  /** Files that failed integrity check */
  failedFiles: string[];

  constructor(failedFiles: string[]) {
    super(
      `Backup integrity check failed for ${failedFiles.length} file(s): ${failedFiles.join(', ')}`
    );
    this.failedFiles = failedFiles;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IntegrityError);
    }
  }
}

/**
 * Type guard to check if an error is a BackupError or subclass.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link BackupError}.
 */
export function isBackupError(error: unknown): error is BackupError {
  return error instanceof BackupError;
}

/**
 * Type guard to check if an error is a RestoreError or subclass.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link RestoreError}.
 */
export function isRestoreError(error: unknown): error is RestoreError {
  return error instanceof RestoreError;
}

/**
 * Type guard to check if an error is an InvalidBackupError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is an {@link InvalidBackupError}.
 */
export function isInvalidBackupError(error: unknown): error is InvalidBackupError {
  return error instanceof InvalidBackupError;
}

/**
 * Type guard to check if an error is a NoDataError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link NoDataError}.
 */
export function isNoDataError(error: unknown): error is NoDataError {
  return error instanceof NoDataError;
}

/**
 * Type guard to check if an error is a FileExistsError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link FileExistsError}.
 */
export function isFileExistsError(error: unknown): error is FileExistsError {
  return error instanceof FileExistsError;
}

/**
 * Type guard to check if an error is an InsufficientSpaceError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is an {@link InsufficientSpaceError}.
 */
export function isInsufficientSpaceError(error: unknown): error is InsufficientSpaceError {
  return error instanceof InsufficientSpaceError;
}

/**
 * Type guard to check if an error is a BackupNotFoundError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link BackupNotFoundError}.
 */
export function isBackupNotFoundError(error: unknown): error is BackupNotFoundError {
  return error instanceof BackupNotFoundError;
}

/**
 * Type guard to check if an error is a TargetExistsError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link TargetExistsError}.
 */
export function isTargetExistsError(error: unknown): error is TargetExistsError {
  return error instanceof TargetExistsError;
}

/**
 * Type guard to check if an error is an IntegrityError.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is an {@link IntegrityError}.
 */
export function isIntegrityError(error: unknown): error is IntegrityError {
  return error instanceof IntegrityError;
}

// Additive feature-016 typed errors share one core implementation so CLI and
// library consumers observe identical stable codes and safe details.
export {
  SessionIntegrityError,
  WorkspaceAmbiguityError,
  SessionAmbiguityError,
  SessionScopeMismatchError,
  UnsupportedSessionMigrationError,
  MigrationTargetChangedError,
  DatabaseCapabilityError,
  NoCapableDriverError,
  DatabaseCapabilityError as DatabaseCapabilityMissingError,
  NoCapableDriverError as NoCapableDatabaseDriverError,
  BackupPublishedPermissionError,
  BackupPublishedCleanupError,
  RestoreRollbackError,
  TemporaryArtifactCleanupError,
  ReadContextError,
  ReadContextSourceMismatchError,
  ReadContextScopeMismatchError,
  ReadContextOptionsMismatchError,
  ReadContextDisposedError,
  SourceEncodingError,
  SourceLimitExceededError,
  SourceLimitConfigurationError,
  isSessionIntegrityError,
};

/**
 * Test whether a caught value is a workspace-suffix ambiguity failure.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link WorkspaceAmbiguityError}.
 */
export function isWorkspaceAmbiguityError(error: unknown): error is WorkspaceAmbiguityError {
  return error instanceof WorkspaceAmbiguityError;
}

/**
 * Test whether a caught value represents divergent physical occurrences of one session UUID.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SessionAmbiguityError}.
 */
export function isSessionAmbiguityError(error: unknown): error is SessionAmbiguityError {
  return error instanceof SessionAmbiguityError;
}

/**
 * Test whether a direct session ID falls outside the active workspace scope.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SessionScopeMismatchError}.
 */
export function isSessionScopeMismatchError(error: unknown): error is SessionScopeMismatchError {
  return error instanceof SessionScopeMismatchError;
}

/**
 * Test whether a migration target is unsupported by the safe mutation contract.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is an {@link UnsupportedSessionMigrationError}.
 */
export function isUnsupportedSessionMigrationError(
  error: unknown
): error is UnsupportedSessionMigrationError {
  return error instanceof UnsupportedSessionMigrationError;
}

/**
 * Test whether a prepared migration target changed before its first write.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link MigrationTargetChangedError}.
 */
export function isMigrationTargetChangedError(
  error: unknown
): error is MigrationTargetChangedError {
  return error instanceof MigrationTargetChangedError;
}

/**
 * Test whether a forced database driver lacks an operation's required capabilities.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link DatabaseCapabilityError}.
 */
export function isDatabaseCapabilityError(error: unknown): error is DatabaseCapabilityError {
  return error instanceof DatabaseCapabilityError;
}

/**
 * Test whether automatic selection found no capable database driver.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link NoCapableDriverError}.
 */
export function isNoCapableDriverError(error: unknown): error is NoCapableDriverError {
  return error instanceof NoCapableDriverError;
}

/**
 * Test whether a completed backup was published but its requested final permissions failed.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link BackupPublishedPermissionError}.
 */
export function isBackupPublishedPermissionError(
  error: unknown
): error is BackupPublishedPermissionError {
  return error instanceof BackupPublishedPermissionError;
}

/**
 * Test whether archive publication committed but an owner-private sibling could not be removed.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link BackupPublishedCleanupError}.
 */
export function isBackupPublishedCleanupError(
  error: unknown
): error is BackupPublishedCleanupError {
  return error instanceof BackupPublishedCleanupError;
}

/**
 * Test whether restore publication failed and one or more entries could not be rolled back.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link RestoreRollbackError}.
 */
export function isRestoreRollbackError(error: unknown): error is RestoreRollbackError {
  return error instanceof RestoreRollbackError;
}

/**
 * Test whether exhaustive cleanup left owner-private temporary artifacts behind.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link TemporaryArtifactCleanupError}.
 */
export function isTemporaryArtifactCleanupError(
  error: unknown
): error is TemporaryArtifactCleanupError {
  return error instanceof TemporaryArtifactCleanupError;
}

/**
 * Test whether a caught value is any immutable read-context binding or lifecycle failure.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link ReadContextError}.
 */
export function isReadContextError(error: unknown): error is ReadContextError {
  return error instanceof ReadContextError;
}

/**
 * Test whether a read context was reused with a different live or backup source.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link ReadContextSourceMismatchError}.
 */
export function isReadContextSourceMismatchError(
  error: unknown
): error is ReadContextSourceMismatchError {
  return error instanceof ReadContextSourceMismatchError;
}

/**
 * Test whether a read context was reused under a different workspace scope.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link ReadContextScopeMismatchError}.
 */
export function isReadContextScopeMismatchError(
  error: unknown
): error is ReadContextScopeMismatchError {
  return error instanceof ReadContextScopeMismatchError;
}

/**
 * Test whether per-call options conflict with an opaque read context's immutable options.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link ReadContextOptionsMismatchError}.
 */
export function isReadContextOptionsMismatchError(
  error: unknown
): error is ReadContextOptionsMismatchError {
  return error instanceof ReadContextOptionsMismatchError;
}

/**
 * Test whether a read operation attempted to reuse a disposed context.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link ReadContextDisposedError}.
 */
export function isReadContextDisposedError(error: unknown): error is ReadContextDisposedError {
  return error instanceof ReadContextDisposedError;
}

/**
 * Test whether deterministic UTF-8 decoding failed for a supported source carrier.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SourceEncodingError}.
 */
export function isSourceEncodingError(error: unknown): error is SourceEncodingError {
  return error instanceof SourceEncodingError;
}

/**
 * Test whether an inclusive Source Read Limits v1 bound was exceeded.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SourceLimitExceededError}.
 */
export function isSourceLimitExceededError(error: unknown): error is SourceLimitExceededError {
  return error instanceof SourceLimitExceededError;
}

/**
 * Test whether a Source Read Limits v1 override failed validation before payload I/O.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SourceLimitConfigurationError}.
 */
export function isSourceLimitConfigurationError(
  error: unknown
): error is SourceLimitConfigurationError {
  return error instanceof SourceLimitConfigurationError;
}

// Preserve legacy provider-selection classes without wrapping so callers can
// distinguish an unavailable forced provider from a capable-provider failure.
export { DriverNotAvailableError, NoDriverAvailableError } from '../core/database/errors.js';
