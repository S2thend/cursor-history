/** Stable machine-readable error codes for session integrity operations. */
export type SessionIntegrityErrorCode =
  | 'WORKSPACE_AMBIGUOUS'
  | 'SESSION_AMBIGUOUS'
  | 'SESSION_SCOPE_MISMATCH'
  | 'UNSUPPORTED_SESSION_MIGRATION'
  | 'MIGRATION_TARGET_CHANGED'
  | 'DATABASE_CAPABILITY_MISSING'
  | 'NO_CAPABLE_DATABASE_DRIVER'
  | 'TEMPORARY_ARTIFACT_CLEANUP_FAILED'
  | 'READ_CONTEXT_SOURCE_MISMATCH'
  | 'READ_CONTEXT_SCOPE_MISMATCH'
  | 'READ_CONTEXT_OPTIONS_MISMATCH'
  | 'READ_CONTEXT_DISPOSED'
  | 'SOURCE_ENCODING_INVALID'
  | 'SOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_LIMIT_CONFIGURATION_INVALID';

/** JSON-safe primitive values accepted in public error details. */
export type SafeErrorDetailValue = string | number | boolean | null | string[] | number[];

/** Safe details never contain conversation content or physical source locators. */
export type SafeErrorDetails = Readonly<Record<string, SafeErrorDetailValue | undefined>>;

/** Base class for typed failures exposed by core, CLI, and library adapters. */
export class SessionIntegrityError<
  TCode extends SessionIntegrityErrorCode = SessionIntegrityErrorCode,
  TDetails extends SafeErrorDetails = SafeErrorDetails,
> extends Error {
  override readonly name: string = 'SessionIntegrityError';

  constructor(
    public readonly code: TCode,
    message: string,
    public readonly details: TDetails
  ) {
    super(message);
    if (Error.captureStackTrace) Error.captureStackTrace(this, SessionIntegrityError);
  }
}

export class WorkspaceAmbiguityError extends SessionIntegrityError<
  'WORKSPACE_AMBIGUOUS',
  { requestedWorkspace: string; candidateCount: number; candidates: string[]; remedy: string }
> {
  override readonly name = 'WorkspaceAmbiguityError';

  constructor(requestedWorkspace: string, candidates: string[]) {
    const ordered = [...new Set(candidates)].sort();
    super(
      'WORKSPACE_AMBIGUOUS',
      `Workspace suffix is ambiguous: ${requestedWorkspace}`,
      {
        requestedWorkspace,
        candidateCount: ordered.length,
        candidates: ordered,
        remedy: 'Use a longer component-aligned suffix or the complete historical workspace path.',
      }
    );
  }
}

export class SessionAmbiguityError extends SessionIntegrityError<
  'SESSION_AMBIGUOUS',
  { sessionId: string; occurrenceCount: number; occurrenceRefs: string[]; remedy: string }
> {
  override readonly name = 'SessionAmbiguityError';

  constructor(sessionId: string, occurrenceRefs: string[]) {
    const ordered = [...new Set(occurrenceRefs)].sort();
    super('SESSION_AMBIGUOUS', 'The logical session has divergent source replicas.', {
      sessionId,
      occurrenceCount: ordered.length,
      occurrenceRefs: ordered,
      remedy: 'Inspect or reconcile the divergent Cursor source occurrences before retrying.',
    });
  }
}

export class SessionScopeMismatchError extends SessionIntegrityError<
  'SESSION_SCOPE_MISMATCH',
  { sessionId: string; workspacePath?: string; remedy: string }
> {
  override readonly name = 'SessionScopeMismatchError';

  constructor(sessionId: string, workspacePath?: string) {
    super('SESSION_SCOPE_MISMATCH', 'The session is not a member of the active workspace scope.', {
      sessionId,
      workspacePath,
      remedy: 'List sessions in the same workspace scope and reuse that scoped index or ID.',
    });
  }
}

export class UnsupportedSessionMigrationError extends SessionIntegrityError<
  'UNSUPPORTED_SESSION_MIGRATION',
  { sessionId: string; eligibility: string; remedy: string }
> {
  override readonly name = 'UnsupportedSessionMigrationError';

  constructor(sessionId: string, eligibility: string) {
    super('UNSUPPORTED_SESSION_MIGRATION', 'The selected logical session cannot be migrated safely.', {
      sessionId,
      eligibility,
      remedy: 'Select one unambiguous Composer-only physical session occurrence.',
    });
  }
}

export class MigrationTargetChangedError extends SessionIntegrityError<
  'MIGRATION_TARGET_CHANGED',
  { sessionId: string; remedy: string }
> {
  override readonly name = 'MigrationTargetChangedError';

  constructor(sessionId: string) {
    super('MIGRATION_TARGET_CHANGED', 'The bound migration target changed after preview.', {
      sessionId,
      remedy: 'Run the migration preview again and review the newly bound target.',
    });
  }
}

export type DatabaseCapability = 'read' | 'readWrite' | 'onlineBackup';

export class DatabaseCapabilityMissingError extends SessionIntegrityError<
  'DATABASE_CAPABILITY_MISSING',
  { driver: string; missingCapabilities: string[]; remedy: string }
> {
  override readonly name = 'DatabaseCapabilityMissingError';

  constructor(driver: string, missingCapabilities: DatabaseCapability[]) {
    super('DATABASE_CAPABILITY_MISSING', `Database driver ${driver} lacks required capabilities.`, {
      driver,
      missingCapabilities: [...missingCapabilities].sort(),
      remedy: 'Select a capable SQLite driver or use automatic driver selection.',
    });
  }
}

export class NoCapableDatabaseDriverError extends SessionIntegrityError<
  'NO_CAPABLE_DATABASE_DRIVER',
  { requiredCapabilities: string[]; remedy: string }
> {
  override readonly name = 'NoCapableDatabaseDriverError';

  constructor(requiredCapabilities: DatabaseCapability[]) {
    super('NO_CAPABLE_DATABASE_DRIVER', 'No installed SQLite driver supports this operation.', {
      requiredCapabilities: [...requiredCapabilities].sort(),
      remedy: 'Install a supported better-sqlite3 version or use a Node runtime with the required node:sqlite APIs.',
    });
  }
}

export class TemporaryArtifactCleanupError extends SessionIntegrityError<
  'TEMPORARY_ARTIFACT_CLEANUP_FAILED',
  { residueCount: number; residuePaths: string[]; remedy: string }
> {
  override readonly name = 'TemporaryArtifactCleanupError';

  constructor(residuePaths: string[]) {
    const ordered = [...new Set(residuePaths)].sort();
    super('TEMPORARY_ARTIFACT_CLEANUP_FAILED', 'Private temporary artifacts could not be removed.', {
      residueCount: ordered.length,
      residuePaths: ordered,
      remedy: 'Remove the listed private temporary paths after confirming no operation is active.',
    });
  }
}

type ContextMismatchCode =
  | 'READ_CONTEXT_SOURCE_MISMATCH'
  | 'READ_CONTEXT_SCOPE_MISMATCH'
  | 'READ_CONTEXT_OPTIONS_MISMATCH'
  | 'READ_CONTEXT_DISPOSED';

export class ReadContextError extends SessionIntegrityError<
  ContextMismatchCode,
  { remedy: string; field?: string }
> {
  override readonly name: string = 'ReadContextError';

  constructor(code: ContextMismatchCode, message: string, field?: string) {
    super(code, message, {
      field,
      remedy:
        code === 'READ_CONTEXT_DISPOSED'
          ? 'Create a new read context.'
          : 'Create a new read context with one immutable source, scope, and option binding.',
    });
  }
}

export class ReadContextSourceMismatchError extends ReadContextError {
  override readonly name = 'ReadContextSourceMismatchError';
  constructor() {
    super('READ_CONTEXT_SOURCE_MISMATCH', 'Read context data source does not match this operation.');
  }
}

export class ReadContextScopeMismatchError extends ReadContextError {
  override readonly name = 'ReadContextScopeMismatchError';
  constructor() {
    super('READ_CONTEXT_SCOPE_MISMATCH', 'Read context workspace scope does not match this operation.');
  }
}

export class ReadContextOptionsMismatchError extends ReadContextError {
  override readonly name = 'ReadContextOptionsMismatchError';
  constructor(field?: string) {
    super(
      'READ_CONTEXT_OPTIONS_MISMATCH',
      'Caller-supplied read context conflicts with per-call options.',
      field
    );
  }
}

export class ReadContextDisposedError extends ReadContextError {
  override readonly name = 'ReadContextDisposedError';
  constructor() {
    super('READ_CONTEXT_DISPOSED', 'Read context has already been disposed.');
  }
}

export class SourceEncodingError extends SessionIntegrityError<
  'SOURCE_ENCODING_INVALID',
  { sourceKind: string; outcome: string; remedy: string }
> {
  override readonly name = 'SourceEncodingError';
  constructor(sourceKind: 'jsonl' | 'sqlite', outcome: 'partial' | 'fatal') {
    super('SOURCE_ENCODING_INVALID', 'Source text is not deterministic UTF-8.', {
      sourceKind,
      outcome,
      remedy: 'Repair or regenerate the Cursor source using UTF-8 without mixed encodings.',
    });
  }
}

export type SourceLimitErrorDetails = {
  policyVersion: 'source-read-limits/v1';
  sourceKind: 'jsonl' | 'sqlite' | 'zip';
  bound: string;
  unit: 'bytes' | 'records' | 'rows' | 'ratio';
  limit: number;
  observedAtLeast: number;
  outcome: 'partial' | 'fatal';
  retryableWithOverride: true;
  remedy: string;
};

export class SourceLimitExceededError extends SessionIntegrityError<
  'SOURCE_LIMIT_EXCEEDED',
  SourceLimitErrorDetails
> {
  override readonly name = 'SourceLimitExceededError';
  constructor(details: Omit<SourceLimitErrorDetails, 'policyVersion' | 'retryableWithOverride' | 'remedy'>) {
    super('SOURCE_LIMIT_EXCEEDED', `Source exceeded ${details.bound}.`, {
      ...details,
      policyVersion: 'source-read-limits/v1',
      retryableWithOverride: true,
      remedy: 'Review the source and explicitly raise only this per-operation bound if it is trusted.',
    });
  }
}

export type SourceLimitConfigurationDetails = {
  invalidField: string;
  invalidValue?: string | number;
  receivedType: string;
  violatedConstraint: string;
  remedy: string;
};

export class SourceLimitConfigurationError extends SessionIntegrityError<
  'SOURCE_LIMIT_CONFIGURATION_INVALID',
  SourceLimitConfigurationDetails
> {
  override readonly name = 'SourceLimitConfigurationError';
  constructor(
    invalidField: string,
    invalidValue: unknown,
    violatedConstraint: string
  ) {
    const safeValue =
      typeof invalidValue === 'string' || typeof invalidValue === 'number'
        ? invalidValue
        : undefined;
    super('SOURCE_LIMIT_CONFIGURATION_INVALID', 'Source read limit configuration is invalid.', {
      invalidField,
      invalidValue: safeValue,
      receivedType: invalidValue === null ? 'null' : typeof invalidValue,
      violatedConstraint,
      remedy: 'Use a documented positive safe-integer bound and preserve the required cross-field relationships.',
    });
  }
}

/** Type guard for all feature-016 typed failures. */
export function isSessionIntegrityError(error: unknown): error is SessionIntegrityError {
  return error instanceof SessionIntegrityError;
}
