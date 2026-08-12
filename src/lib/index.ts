/**
 * cursor-history Library API
 *
 * IMPORTANT: This is a library interface for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API. Functions are imported directly:
 * `import { listSessions, getSession, searchSessions } from 'cursor-history'`
 */

// Export all public types
export type {
  Session,
  Message,
  ToolCall,
  SearchResult,
  LibraryConfig,
  PaginatedResult,
  MigrationMode,
  MigrateSessionConfig,
  MigrateWorkspaceConfig,
  SessionMigrationResult,
  WorkspaceMigrationResult,
  // Token usage types
  TokenUsage,
  SessionUsage,
  // Backup types
  BackupManifest,
  BackupFileEntry,
  BackupStats,
  BackupConfig,
  BackupProgress,
  BackupResult,
  RestoreConfig,
  RestoreProgress,
  RestoreResult,
  BackupValidation,
  BackupInfo,
  // SQLite driver type
  SqliteDriverName,
  // Message filter type
  MessageType,
  SourceRole,
  SourceRepresentation,
  ResolvedSource,
  ResolutionState,
  ResolutionReasonCode,
  IndexScope,
  WorkspaceMatchKind,
  MessageIdentityOrigin,
  MessageTimestampSource,
  ToolIdentityOrigin,
  SessionTimestampSource,
  SessionResolution,
  GeneralSessionDiagnosticCode,
  GeneralSessionDiagnostic,
  SourceEncodingDiagnostic,
  SourceLimitExceededDiagnostic,
  SessionDiagnostic,
  SessionSourceInstance,
  WorkspaceMembership,
  SourceReadLimitsV1,
  SourceReadLimitsOverride,
  SourceReadOptions,
  JsonlSourceBoundKind,
  SqliteSourceBoundKind,
  ZipSourceBoundKind,
  SourceBoundKind,
  JsonlSourceLimitDimension,
  SqliteSourceLimitDimension,
  ZipSourceLimitDimension,
  SessionReadContextOptions,
  SessionReadContext,
  ResolvedSessionSummary,
  AmbiguousSessionSummary,
  SessionSummary,
} from './types.js';

// Export MESSAGE_TYPES constant
export { MESSAGE_TYPES } from './types.js';

// Export error classes
export {
  DatabaseLockedError,
  DatabaseNotFoundError,
  InvalidConfigError,
  InvalidFilterError,
  SessionNotFoundError,
  WorkspaceNotFoundError,
  SameWorkspaceError,
  NoSessionsFoundError,
  DestinationHasSessionsError,
  // Backup errors
  BackupError,
  NoDataError,
  FileExistsError,
  InsufficientSpaceError,
  RestoreError,
  BackupNotFoundError,
  InvalidBackupError,
  TargetExistsError,
  IntegrityError,
  // Type guards
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isInvalidConfigError,
  isInvalidFilterError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isSameWorkspaceError,
  isNoSessionsFoundError,
  isDestinationHasSessionsError,
  // Backup type guards
  isBackupError,
  isNoDataError,
  isFileExistsError,
  isInsufficientSpaceError,
  isRestoreError,
  isBackupNotFoundError,
  isInvalidBackupError,
  isTargetExistsError,
  isIntegrityError,
  isWorkspaceAmbiguityError,
  isSessionAmbiguityError,
  isSessionScopeMismatchError,
  isUnsupportedSessionMigrationError,
  isMigrationTargetChangedError,
  isDatabaseCapabilityError,
  isNoCapableDriverError,
  isTemporaryArtifactCleanupError,
  isReadContextError,
  isReadContextSourceMismatchError,
  isReadContextScopeMismatchError,
  isReadContextOptionsMismatchError,
  isReadContextDisposedError,
  isSourceEncodingError,
  isSourceLimitExceededError,
  isSourceLimitConfigurationError,
  SessionIntegrityError,
  WorkspaceAmbiguityError,
  SessionAmbiguityError,
  SessionScopeMismatchError,
  UnsupportedSessionMigrationError,
  MigrationTargetChangedError,
  DatabaseCapabilityError,
  NoCapableDriverError,
  DriverNotAvailableError,
  NoDriverAvailableError,
  DatabaseCapabilityMissingError,
  NoCapableDatabaseDriverError,
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
} from './errors.js';

// Export utility functions
export { getDefaultDataPath } from './utils.js';

// Export filter functions from formatters
export { getMessageType, filterMessages, validateMessageTypes } from '../cli/formatters/table.js';

// API Functions (to be implemented in Phase 3+)
import type {
  LibraryConfig,
  PaginatedResult,
  Session,
  SearchResult,
  MigrateSessionConfig,
  MigrateWorkspaceConfig,
  SessionMigrationResult,
  WorkspaceMigrationResult,
  SqliteDriverName,
  SessionReadContext as PublicSessionReadContext,
  SessionReadContextOptions,
  ResolvedSessionSummary,
  SessionSummary,
  SourceRole,
  ResolvedSource,
  SessionResolution,
  SessionSourceInstance,
} from './types.js';
import { mergeWithDefaults, type ResolvedConfig } from './config.js';
import {
  DatabaseLockedError,
  DatabaseNotFoundError,
  InvalidFilterError,
  DriverNotAvailableError,
  NoDriverAvailableError,
  SessionAmbiguityError,
  SessionIntegrityError,
  SessionScopeMismatchError,
  SessionNotFoundError,
  ReadContextOptionsMismatchError,
  ReadContextScopeMismatchError,
  ReadContextSourceMismatchError,
  isSessionAmbiguityError,
} from './errors.js';
import {
  filterMessages as filterMessagesImpl,
  validateMessageTypes as validateMessageTypesImpl,
} from '../cli/formatters/table.js';
import { MESSAGE_TYPES as MESSAGE_TYPES_CONST } from '../core/types.js';
import * as storage from '../core/storage.js';
import * as migrate from '../core/migrate.js';
import { exportToJson, exportToMarkdown } from '../core/parser.js';
import { expandPath, pathsEqual } from './platform.js';
import { normalizePublicWorkspacePath, normalizeWorkspacePath } from '../core/workspace-scope.js';
import type {
  AmbiguousSessionSummary as CoreAmbiguousSessionSummary,
  ChatSession as CoreSession,
  LogicalSessionSummary as CoreLogicalSessionSummary,
} from '../core/types.js';
import {
  setDriver as coreSetDriver,
  getActiveDriver as coreGetActiveDriver,
} from '../core/database/index.js';

/** Convert the library's zero-based numeric identifier to the core's one-based index. */
function toCoreSessionIdentifier(identifier: number | string): number | string {
  if (typeof identifier === 'number') return identifier + 1;
  if (/^\d+$/.test(identifier)) return Number.parseInt(identifier, 10) + 1;
  return identifier;
}

interface PublicReadContextRecord {
  readonly core: storage.SessionReadContext;
  readonly dataPath?: string;
  readonly backupPath?: string;
  readonly workspace?: string;
  readonly includeCrossWorkspaceSources: boolean;
  readonly sqliteDriver?: SqliteDriverName;
  readonly signal?: AbortSignal;
  readonly onDiagnostic?: ResolvedConfig['onDiagnostic'];
}

const publicReadContexts = new WeakMap<object, PublicReadContextRecord>();

function hasOwn(object: object | undefined, key: PropertyKey): boolean {
  return object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function unwrapPublicReadContext(value: PublicSessionReadContext): PublicReadContextRecord {
  const issued = publicReadContexts.get(value as object);
  if (issued) return issued;
  // Keep the package declaration opaque while allowing the core integration
  // seam to exercise the exact same lifecycle implementation end to end.
  if (
    typeof value === 'object' &&
    value !== null &&
    'activeResolutions' in value &&
    'completedSessions' in value
  ) {
    const core = value as storage.SessionReadContext;
    return {
      core,
      dataPath: core.customDataPath,
      backupPath: core.backupPath,
      workspace: core.workspaceScope ?? undefined,
      includeCrossWorkspaceSources: core.includeCrossWorkspaceSources,
      sqliteDriver: core.sqliteDriver,
      signal: core.signal,
      onDiagnostic: core.onDiagnostic,
    };
  }
  throw new ReadContextOptionsMismatchError('readContext');
}

interface ConfiguredReadContext {
  readonly context: storage.SessionReadContext;
  readonly ownsContext: boolean;
  readonly dataPath?: string;
  readonly backupPath?: string;
  readonly workspace?: string;
  readonly includeCrossWorkspaceSources: boolean;
  readonly onDiagnostic?: ResolvedConfig['onDiagnostic'];
}

function bindConfiguredReadContext(
  config: LibraryConfig | undefined,
  resolvedSessionCapacity = 1
): ConfiguredReadContext {
  const resolved = mergeWithDefaults(config);
  if (resolved.readContext) {
    if (hasOwn(config, 'sourceReadLimits')) {
      throw new ReadContextOptionsMismatchError('sourceReadLimits');
    }
    const record = unwrapPublicReadContext(resolved.readContext);
    const context = record.core;
    if (
      config?.dataPath !== undefined &&
      (record.dataPath === undefined || !pathsEqual(config.dataPath, record.dataPath))
    ) {
      throw new ReadContextSourceMismatchError();
    }
    if (
      config?.backupPath !== undefined &&
      (record.backupPath === undefined || !pathsEqual(config.backupPath, record.backupPath))
    ) {
      throw new ReadContextSourceMismatchError();
    }
    if (
      config?.workspace !== undefined &&
      (record.workspace === undefined ||
        normalizeWorkspacePath(config.workspace) !== normalizeWorkspacePath(record.workspace))
    ) {
      throw new ReadContextScopeMismatchError();
    }
    if (config?.sqliteDriver !== undefined && config.sqliteDriver !== record.sqliteDriver) {
      throw new ReadContextOptionsMismatchError('sqliteDriver');
    }
    if (config?.signal !== undefined && config.signal !== record.signal) {
      throw new ReadContextOptionsMismatchError('signal');
    }
    if (
      hasOwn(config, 'includeCrossWorkspaceSources') &&
      resolved.includeCrossWorkspaceSources !== record.includeCrossWorkspaceSources
    ) {
      throw new ReadContextOptionsMismatchError('includeCrossWorkspaceSources');
    }
    if (hasOwn(config, 'onDiagnostic') && resolved.onDiagnostic !== record.onDiagnostic) {
      throw new ReadContextOptionsMismatchError('onDiagnostic');
    }
    return {
      context,
      ownsContext: false,
      dataPath: resolved.dataPath ?? record.dataPath,
      backupPath: resolved.backupPath ?? record.backupPath,
      workspace: resolved.workspace ?? record.workspace,
      includeCrossWorkspaceSources: hasOwn(config, 'includeCrossWorkspaceSources')
        ? resolved.includeCrossWorkspaceSources
        : record.includeCrossWorkspaceSources,
      onDiagnostic: resolved.onDiagnostic ?? record.onDiagnostic,
    };
  }

  const context = storage.createSessionReadContext({
    dataPath: resolved.dataPath,
    backupPath: resolved.backupPath,
    workspacePath: resolved.workspace,
    includeCrossWorkspaceSources: resolved.includeCrossWorkspaceSources,
    resolvedSessionCapacity,
    sqliteDriver: resolved.sqliteDriver,
    sourceReadLimits: resolved.sourceReadLimits,
    signal: resolved.signal,
    onDiagnostic: resolved.onDiagnostic,
  });
  return {
    context,
    ownsContext: true,
    dataPath: resolved.dataPath,
    backupPath: resolved.backupPath,
    workspace: resolved.workspace,
    includeCrossWorkspaceSources: resolved.includeCrossWorkspaceSources,
    onDiagnostic: resolved.onDiagnostic,
  };
}

/**
 * Create an opaque, immutable-binding session read context.
 *
 * @param options - Data source, workspace, driver, limits, diagnostics, and cache capacity.
 * @returns A caller-owned bounded context reusable across compatible read operations.
 * @throws {InvalidConfigError} If a public option is invalid.
 * @throws {SourceLimitConfigurationError} If Source Read Limits v1 overrides are invalid.
 * @throws {ReadContextDisposedError} If a lifecycle method is used after disposal.
 */
export function createSessionReadContext(
  options: SessionReadContextOptions = {}
): PublicSessionReadContext {
  const resolved = mergeWithDefaults(options);
  const core = storage.createSessionReadContext({
    dataPath: resolved.dataPath,
    backupPath: resolved.backupPath,
    workspacePath: resolved.workspace,
    includeCrossWorkspaceSources: resolved.includeCrossWorkspaceSources,
    resolvedSessionCapacity: options.resolvedSessionCapacity,
    sqliteDriver: resolved.sqliteDriver,
    sourceReadLimits: resolved.sourceReadLimits,
    signal: resolved.signal,
    onDiagnostic: resolved.onDiagnostic,
  });
  const wrapper: PublicSessionReadContext = {
    get resolvedSessionCapacity() {
      return core.resolvedSessionCapacity;
    },
    get disposed() {
      return core.disposed;
    },
    releaseSession(sessionId: string): void {
      core.releaseSession(sessionId);
    },
    dispose(): Promise<void> {
      return core.dispose();
    },
  };
  publicReadContexts.set(wrapper, {
    core,
    dataPath: resolved.dataPath,
    backupPath: resolved.backupPath,
    workspace: resolved.workspace,
    includeCrossWorkspaceSources: resolved.includeCrossWorkspaceSources,
    sqliteDriver: resolved.sqliteDriver,
    signal: resolved.signal,
    onDiagnostic: resolved.onDiagnostic,
  });
  return Object.freeze(wrapper);
}

function isReadPassThroughError(error: unknown): boolean {
  return (
    error instanceof SessionIntegrityError ||
    error instanceof DriverNotAvailableError ||
    error instanceof NoDriverAvailableError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function getCoreSessionInScope(
  identifier: number | string,
  bound: ConfiguredReadContext
): Promise<CoreSession | null> {
  if (!bound.workspace) {
    return storage.getSession(identifier, bound.dataPath, bound.backupPath, bound.context);
  }

  const scopedSessions = await storage.listSessionSummaries(
    {
      limit: 0,
      all: true,
      workspacePath: bound.workspace,
      includeCrossWorkspaceSources: bound.includeCrossWorkspaceSources,
    },
    bound.dataPath,
    bound.backupPath,
    bound.context
  );
  if (typeof identifier === 'string') {
    const summary = scopedSessions.find(({ id }) => id === identifier);
    if (!summary) {
      throw new SessionScopeMismatchError(identifier, bound.workspace);
    }
    return storage.getSession(
      summary.id,
      bound.dataPath,
      bound.backupPath,
      bound.context,
      summary.index
    );
  }
  return storage.getSession(identifier, bound.dataPath, bound.backupPath, bound.context);
}

type CoreCompatibilitySource = CoreSession['source'];

interface CoreResolutionProjection {
  source?: CoreCompatibilitySource;
  resolvedSource?: ResolvedSource;
  sources?: SourceRole[];
  resolution?: SessionResolution;
  transcriptState?: CoreSession['transcriptState'];
}

/** Map modern provenance to the two-value replacement-safety compatibility signal. */
function compatibilitySourceOf(value: CoreResolutionProjection): 'global' | 'workspace-fallback' {
  if (value.resolution) {
    return value.resolution.state === 'complete' ? 'global' : 'workspace-fallback';
  }
  switch (value.source) {
    case undefined:
    case 'global':
      return 'global';
    case 'workspace-fallback':
      return 'workspace-fallback';
    case 'store-complete':
      return 'global';
    case 'transcript':
      return value.transcriptState === 'parsed' ? 'global' : 'workspace-fallback';
    case 'store':
    case 'store-partial':
    case 'merged':
      // Modern adapters attach an explicit resolution. Conservatively prevent
      // replacement when older/mocked data does not carry one.
      return 'workspace-fallback';
  }
}

/** Resolve the selected representation without changing the compatibility source signal. */
function resolvedSourceOf(value: CoreResolutionProjection): ResolvedSource {
  if (value.resolvedSource) return value.resolvedSource;
  switch (value.source) {
    case 'transcript':
      return 'store-transcript';
    case 'store':
    case 'store-complete':
    case 'store-partial':
      return 'store-db';
    case 'merged':
      return 'merged';
    case undefined:
    case 'global':
    case 'workspace-fallback':
      return 'composer';
  }
}

/** Infer canonical source roles only when older data omitted additive provenance. */
function sourceRolesOf(value: CoreResolutionProjection): SourceRole[] {
  if (value.sources && value.sources.length > 0) {
    const declared = new Set<SourceRole>(value.sources);
    const canonicalOrder: SourceRole[] = ['composer', 'store'];
    return canonicalOrder.filter((role) => declared.has(role));
  }
  switch (resolvedSourceOf(value)) {
    case 'composer':
      return ['composer'];
    case 'merged':
      return ['composer', 'store'];
    case 'store-db':
    case 'store-transcript':
    case 'store-metadata':
      return ['store'];
  }
}

/** Clone resolution arrays so public callers cannot mutate the bound catalog state. */
function cloneResolution(resolution: SessionResolution): SessionResolution {
  return {
    ...resolution,
    expectedSourceRoles: [...resolution.expectedSourceRoles],
    loadedSourceRoles: [...resolution.loadedSourceRoles],
    omittedSourceRoles: [...resolution.omittedSourceRoles],
    failedSourceRoles: [...resolution.failedSourceRoles],
    reasonCodes: [...resolution.reasonCodes],
  };
}

/** Select the first verified path for a public compatibility projection. */
function firstPublicWorkspacePath(...candidates: Array<string | undefined>): string | undefined {
  return candidates
    .map((candidate) => normalizePublicWorkspacePath(candidate))
    .find((candidate) => candidate !== undefined);
}

/**
 * Preserve the released v0.16 spelling of the library `workspace` alias.
 *
 * Composer summaries historically passed their path through `contractPath()`,
 * so a workspace below the process home directory was exposed as `~/...`.
 * `canonicalWorkspacePath` is the additive normalized/full spelling; using it
 * to replace this existing alias would change a value persisted by incremental
 * library consumers.
 */
function releasedWorkspaceAlias(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return normalizePublicWorkspacePath(value) === undefined ? undefined : value;
}

/** Remove display-only workspace labels from public source-instance metadata. */
function publicSourceInstances(
  instances: readonly SessionSourceInstance[] | undefined
): SessionSourceInstance[] {
  return (instances ?? []).map((instance) => ({
    ...instance,
    workspacePaths: instance.workspacePaths.flatMap((workspacePath) => {
      const normalized = normalizePublicWorkspacePath(workspacePath);
      return normalized ? [normalized] : [];
    }),
  }));
}

/** Supply an honest compatibility projection for legacy rows lacking additive resolution fields. */
function resolutionOf(value: CoreResolutionProjection): SessionResolution {
  if (value.resolution) return cloneResolution(value.resolution);
  const roles = sourceRolesOf(value);
  const state = compatibilitySourceOf(value) === 'global' ? 'complete' : 'partial';
  return {
    state,
    expectedSourceRoles: [...roles],
    loadedSourceRoles: [...roles],
    omittedSourceRoles: [],
    failedSourceRoles: [],
    reasonCodes: state === 'partial' ? ['source-partial'] : [],
  };
}

/** Convert core ChatSession to the detached public Session contract. */
function convertToLibrarySession(coreSession: CoreSession): Session {
  const canonicalWorkspacePath = firstPublicWorkspacePath(
    coreSession.canonicalWorkspacePath,
    coreSession.workspacePath
  );
  const compatibilityWorkspacePath =
    releasedWorkspaceAlias(coreSession.workspacePath) ?? canonicalWorkspacePath;
  const indexWorkspacePath = normalizePublicWorkspacePath(coreSession.indexWorkspacePath);
  const matchedWorkspacePath = normalizePublicWorkspacePath(coreSession.matchedWorkspacePath);
  const compatibilitySource = compatibilitySourceOf(coreSession);

  return {
    id: coreSession.id,
    workspace: compatibilityWorkspacePath ?? 'unknown',
    timestamp: coreSession.createdAt.toISOString(),
    messages: coreSession.messages.map((msg) => {
      const hasMessageTimestamp =
        msg.timestamp instanceof Date && !Number.isNaN(msg.timestamp.getTime());
      const timestamp = hasMessageTimestamp ? msg.timestamp! : coreSession.createdAt;
      const timestampSource =
        msg.timestampSource ??
        (hasMessageTimestamp
          ? 'unknown'
          : coreSession.createdAtSource === 'epoch-unknown'
            ? 'unknown'
            : 'session-fallback');
      const m: Record<string, unknown> = {
        id: msg.id ?? undefined,
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
        // Preserve the library's required timestamp contract. Composer
        // messages are filled by the core storage layer; Store-only messages
        // without a turn timestamp use the session creation time and expose
        // that fallback as additive provenance.
        timestamp: timestamp.toISOString(),
        // v0.16 created every optional Message member as an own property even
        // when its value was undefined. Preserve that observable runtime shape
        // while detaching defined arrays/objects from the core result.
        toolCalls: msg.toolCalls
          ? msg.toolCalls.map((call) => ({
              ...call,
              ...(call.params !== undefined ? { params: structuredClone(call.params) } : {}),
              ...(call.files !== undefined ? { files: [...call.files] } : {}),
            }))
          : undefined,
        thinking: msg.thinking,
        tokenUsage: msg.tokenUsage ? { ...msg.tokenUsage } : undefined,
        model: msg.model,
        durationMs: msg.durationMs,
        metadata: msg.metadata ? { ...msg.metadata } : undefined,
        timestampSource,
      };
      if (msg.messageIdentityVersion) m['messageIdentityVersion'] = msg.messageIdentityVersion;
      if (msg.identityOrigin) m['identityOrigin'] = msg.identityOrigin;
      if (msg.parentMessageId) m['parentMessageId'] = msg.parentMessageId;
      if (msg.isSidechain !== undefined) m['isSidechain'] = msg.isSidechain;
      if (msg.source) m['source'] = msg.source;
      return m as unknown as import('./types.js').Message;
    }),
    messageCount: coreSession.messageCount,
    index: Math.max(0, coreSession.index - 1),
    ...(coreSession.indexScope ? { indexScope: coreSession.indexScope } : {}),
    ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
    source: compatibilitySource,
    ...(coreSession.resolvedSource ? { resolvedSource: coreSession.resolvedSource } : {}),
    ...(coreSession.sources ? { sources: [...coreSession.sources] } : {}),
    ...(coreSession.preferredSource ? { preferredSource: coreSession.preferredSource } : {}),
    ...(coreSession.resolution ? { resolution: cloneResolution(coreSession.resolution) } : {}),
    ...(coreSession.resolutionState ? { resolutionState: coreSession.resolutionState } : {}),
    ...(canonicalWorkspacePath ? { canonicalWorkspacePath } : {}),
    ...(matchedWorkspacePath ? { matchedWorkspacePath } : {}),
    ...(coreSession.workspaceMatchKind
      ? { workspaceMatchKind: coreSession.workspaceMatchKind }
      : {}),
    ...(coreSession.workspaceMemberships
      ? {
          workspaceMemberships: coreSession.workspaceMemberships.flatMap((membership) => {
            const workspacePath = normalizePublicWorkspacePath(membership.workspacePath);
            return workspacePath
              ? [{ ...membership, workspacePath, sourceRoles: [...membership.sourceRoles] }]
              : [];
          }),
        }
      : {}),
    ...(coreSession.sourceInstances
      ? { sourceInstances: publicSourceInstances(coreSession.sourceInstances) }
      : {}),
    ...(coreSession.messageIdentityVersion
      ? { messageIdentityVersion: coreSession.messageIdentityVersion }
      : {}),
    ...(coreSession.createdAtSource ? { createdAtSource: coreSession.createdAtSource } : {}),
    ...(coreSession.lastUpdatedAtSource
      ? { lastUpdatedAtSource: coreSession.lastUpdatedAtSource }
      : {}),
    ...(coreSession.transcriptState ? { transcriptState: coreSession.transcriptState } : {}),
    // `usage` has always been an own property, including when undefined.
    // Preserve that observable runtime shape while detaching defined values.
    usage: coreSession.usage ? { ...coreSession.usage } : undefined,
    ...(coreSession.activeBranchBubbleIds
      ? { activeBranchBubbleIds: [...coreSession.activeBranchBubbleIds] }
      : {}),
    ...(coreSession.activeBranchMessageIds
      ? { activeBranchMessageIds: [...coreSession.activeBranchMessageIds] }
      : {}),
    metadata: {
      lastModified: coreSession.lastUpdatedAt.toISOString(),
    },
  };
}

function isCoreAmbiguousSummary(
  summary: CoreLogicalSessionSummary
): summary is CoreAmbiguousSessionSummary {
  return summary.resolutionState === 'ambiguous';
}

/** Convert a message-free core catalog row to the zero-based public contract. */
function convertToLibrarySummary(summary: CoreLogicalSessionSummary): SessionSummary {
  if (isCoreAmbiguousSummary(summary)) {
    const indexWorkspacePath = normalizePublicWorkspacePath(summary.indexWorkspacePath);
    const canonicalWorkspacePath = normalizePublicWorkspacePath(summary.canonicalWorkspacePath);
    const matchedWorkspacePath = normalizePublicWorkspacePath(summary.matchedWorkspacePath);
    return {
      id: summary.id,
      index: summary.index - 1,
      indexScope: summary.indexScope,
      ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
      resolutionState: 'ambiguous',
      sourceRoles: [...summary.sourceRoles],
      occurrenceCount: summary.occurrenceCount,
      diagnosticOccurrenceRefs: [...summary.diagnosticOccurrenceRefs],
      ...(canonicalWorkspacePath ? { canonicalWorkspacePath } : {}),
      ...(matchedWorkspacePath ? { matchedWorkspacePath } : {}),
    };
  }

  const canonicalWorkspacePath = firstPublicWorkspacePath(
    summary.canonicalWorkspacePath,
    summary.workspacePath
  );
  const compatibilityWorkspacePath =
    releasedWorkspaceAlias(summary.workspacePath) ?? canonicalWorkspacePath;
  const indexWorkspacePath = normalizePublicWorkspacePath(summary.indexWorkspacePath);
  const matchedWorkspacePath = normalizePublicWorkspacePath(summary.matchedWorkspacePath);
  const source = compatibilitySourceOf(summary);
  const resolvedSource = resolvedSourceOf(summary);
  const sources = sourceRolesOf(summary);
  const resolution = resolutionOf(summary);
  const workspaceMemberships = summary.workspaceMemberships
    ? summary.workspaceMemberships.flatMap((membership) => {
        const workspacePath = normalizePublicWorkspacePath(membership.workspacePath);
        return workspacePath
          ? [{ ...membership, workspacePath, sourceRoles: [...membership.sourceRoles] }]
          : [];
      })
    : canonicalWorkspacePath
      ? [
          {
            workspacePath: canonicalWorkspacePath,
            sourceRoles: [...sources],
            contributingInstanceCount: 1,
          },
        ]
      : [];
  const sourceInstances = publicSourceInstances(summary.sourceInstances);

  const result: ResolvedSessionSummary = {
    id: summary.id,
    index: summary.index - 1,
    indexScope: summary.indexScope ?? 'global',
    ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
    workspace: compatibilityWorkspacePath ?? 'unknown',
    timestamp: summary.createdAt.toISOString(),
    title: summary.title,
    preview: summary.preview,
    messageCount: summary.messageCount,
    source,
    resolvedSource,
    sources,
    ...(summary.preferredSource ? { preferredSource: summary.preferredSource } : {}),
    resolution,
    resolutionState: resolution.state,
    ...(canonicalWorkspacePath ? { canonicalWorkspacePath } : {}),
    ...(matchedWorkspacePath ? { matchedWorkspacePath } : {}),
    ...(summary.workspaceMatchKind ? { workspaceMatchKind: summary.workspaceMatchKind } : {}),
    workspaceMemberships,
    sourceInstances,
    messageIdentityVersion: summary.messageIdentityVersion ?? 1,
    createdAtSource: summary.createdAtSource ?? 'epoch-unknown',
    lastUpdatedAtSource: summary.lastUpdatedAtSource ?? 'epoch-unknown',
    ...(summary.transcriptState ? { transcriptState: summary.transcriptState } : {}),
    metadata: {
      lastModified: summary.lastUpdatedAt.toISOString(),
    },
  };
  return result;
}

function reportSessionAmbiguity(
  sessionId: string,
  occurrenceRefs: readonly string[],
  onDiagnostic: ConfiguredReadContext['onDiagnostic']
): void {
  const orderedRefs = [...new Set(occurrenceRefs)].sort((left, right) => {
    const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
    const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
    const length = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < length; index += 1) {
      const difference = leftPoints[index]! - rightPoints[index]!;
      if (difference !== 0) return difference;
    }
    return leftPoints.length - rightPoints.length;
  });
  if (!onDiagnostic) {
    throw new SessionAmbiguityError(sessionId, orderedRefs);
  }
  onDiagnostic({
    code: 'SESSION_AMBIGUOUS',
    message: `Session ${sessionId} has divergent physical occurrences.`,
    sessionId,
    occurrenceCount: orderedRefs.length,
    occurrenceRefs: orderedRefs,
    remedy: 'Resolve or remove the divergent replicas, then retry the operation.',
  });
}

function reportAmbiguousSummary(
  summary: CoreAmbiguousSessionSummary,
  onDiagnostic: ConfiguredReadContext['onDiagnostic']
): void {
  reportSessionAmbiguity(summary.id, summary.diagnosticOccurrenceRefs, onDiagnostic);
}

/**
 * List one message-free row for every logical session in the requested catalog window.
 *
 * @param config - Optional immutable data source, workspace, and pagination configuration.
 * @returns A zero-based page containing resolved and ambiguous logical summaries.
 * @throws {DatabaseLockedError} If Cursor holds a database lock that prevents the read.
 * @throws {DatabaseNotFoundError} If the configured data source does not exist.
 * @throws {InvalidConfigError} If a configuration field is invalid.
 * @throws {SessionIntegrityError} If catalog discovery cannot be completed safely.
 */
export async function listSessionSummaries(
  config?: LibraryConfig
): Promise<PaginatedResult<SessionSummary>> {
  const resolved = mergeWithDefaults(config);
  const bound = bindConfiguredReadContext(config);
  try {
    const rows = await storage.listSessionSummaries(
      {
        limit: -1,
        all: true,
        workspacePath: bound.workspace,
        includeCrossWorkspaceSources: bound.includeCrossWorkspaceSources,
      },
      bound.dataPath,
      bound.backupPath,
      bound.context
    );
    const total = rows.length;
    const start = resolved.offset;
    const end = Math.min(start + resolved.limit, total);
    return {
      data: rows.slice(start, end).map(convertToLibrarySummary),
      pagination: {
        total,
        limit: resolved.limit,
        offset: resolved.offset,
        hasMore: end < total,
      },
    };
  } finally {
    if (bound.ownsContext) await bound.context.dispose();
  }
}

/**
 * List all chat sessions, optionally filtered and paginated.
 *
 * @param config - Optional configuration (dataPath, workspace filter, pagination)
 * @returns Paginated result with sessions and metadata
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {InvalidConfigError} If config parameters are invalid
 *
 * @example
 * // List all sessions
 * const result = await listSessions();
 * console.log(result.data); // Session[]
 *
 * @example
 * // List sessions with pagination
 * const page1 = await listSessions({ limit: 10, offset: 0 });
 * const page2 = await listSessions({ limit: 10, offset: 10 });
 *
 * @example
 * // List sessions for specific workspace
 * const result = await listSessions({ workspace: '/path/to/project' });
 */
export async function listSessions(config?: LibraryConfig): Promise<PaginatedResult<Session>> {
  try {
    const resolved = mergeWithDefaults(config);
    const bound = bindConfiguredReadContext(config);
    try {
      const logicalSummaries = await storage.listSessionSummaries(
        {
          limit: -1,
          all: true,
          workspacePath: bound.workspace,
          includeCrossWorkspaceSources: bound.includeCrossWorkspaceSources,
        },
        bound.dataPath,
        bound.backupPath,
        bound.context
      );

      const total = logicalSummaries.length;
      const start = resolved.offset;
      const end = Math.min(start + resolved.limit, total);
      const paginatedRows = logicalSummaries.slice(start, end);

      const sessions: Session[] = [];
      for (const summary of paginatedRows) {
        if (isCoreAmbiguousSummary(summary)) {
          reportAmbiguousSummary(summary, bound.onDiagnostic);
          continue;
        }
        try {
          const fullSession = await storage.getSession(
            summary.id,
            bound.dataPath,
            bound.backupPath,
            bound.context,
            summary.index
          );
          if (!fullSession) {
            throw new DatabaseNotFoundError(`Session ${summary.index} not found`);
          }
          sessions.push(convertToLibrarySession(fullSession));
        } catch (error) {
          if (!isSessionAmbiguityError(error)) throw error;
          reportSessionAmbiguity(
            error.details.sessionId,
            error.details.occurrenceRefs,
            bound.onDiagnostic
          );
        } finally {
          bound.context.releaseSession(summary.id);
        }
      }

      return {
        data: sessions,
        pagination: {
          total,
          limit: resolved.limit,
          offset: resolved.offset,
          hasMore: end < total,
        },
      };
    } finally {
      if (bound.ownsContext) await bound.context.dispose();
    }
  } catch (err) {
    if (isReadPassThroughError(err)) throw err;
    // Check for SQLite BUSY error (database locked)
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      throw new DatabaseLockedError(config?.dataPath ?? 'default path');
    }
    // Check for file not found errors
    if (
      err instanceof Error &&
      (err.message.includes('ENOENT') || err.message.includes('no such file'))
    ) {
      throw new DatabaseNotFoundError(config?.dataPath ?? 'default path');
    }
    // Re-throw library errors as-is
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    // Wrap other errors
    throw new Error(`Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get a specific session by index or session ID.
 *
 * @param index - Zero-based session index (from listSessions result) or session ID string
 * @param config - Optional configuration (dataPath, messageFilter)
 * @returns Complete session with all messages (filtered if messageFilter specified)
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {SessionNotFoundError} If the session ID or index cannot be resolved
 * @throws {InvalidFilterError} If messageFilter contains invalid types
 *
 * @example
 * const session = await getSession(0);
 * console.log(session.messages); // Message[]
 *
 * @example
 * // Get session by session ID
 * const session = await getSession('abc-123-session-id');
 *
 * @example
 * // Get session from custom data path
 * const session = await getSession(5, { dataPath: '/custom/cursor/data' });
 *
 * @example
 * // Get session with only user messages
 * const session = await getSession(0, { messageFilter: ['user'] });
 */
export async function getSession(index: number | string, config?: LibraryConfig): Promise<Session> {
  try {
    const bound = bindConfiguredReadContext(config);

    try {
      // Validate message filter if provided
      if (config?.messageFilter && config.messageFilter.length > 0) {
        const invalidTypes = validateMessageTypesImpl(config.messageFilter);
        if (invalidTypes.length > 0) {
          throw new InvalidFilterError(invalidTypes, MESSAGE_TYPES_CONST);
        }
      }

      const coreIdentifier = toCoreSessionIdentifier(index);
      const coreSession = await getCoreSessionInScope(coreIdentifier, bound);

      if (!coreSession) {
        throw new SessionNotFoundError(index);
      }

      // Apply message filter if provided
      if (config?.messageFilter && config.messageFilter.length > 0) {
        coreSession.messages = filterMessagesImpl(coreSession.messages, config.messageFilter);
      }

      return convertToLibrarySession(coreSession);
    } finally {
      if (bound.ownsContext) await bound.context.dispose();
    }
  } catch (err) {
    if (isReadPassThroughError(err)) throw err;
    // Check for SQLite BUSY error (database locked)
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      throw new DatabaseLockedError(config?.dataPath ?? 'default path');
    }
    // Check for file not found errors
    if (
      err instanceof Error &&
      (err.message.includes('ENOENT') || err.message.includes('no such file'))
    ) {
      throw new DatabaseNotFoundError(config?.dataPath ?? 'default path');
    }
    // Re-throw library errors as-is
    if (
      err instanceof DatabaseLockedError ||
      err instanceof DatabaseNotFoundError ||
      err instanceof InvalidFilterError ||
      err instanceof SessionNotFoundError
    ) {
      throw err;
    }
    // Wrap other errors
    throw new Error(`Failed to get session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Search across all sessions for matching content.
 *
 * @param query - Search query string (case-insensitive substring match)
 * @param config - Optional configuration (dataPath, workspace filter, context lines)
 * @returns Array of search results with context
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 *
 * @example
 * // Basic search
 * const results = await searchSessions('authentication');
 *
 * @example
 * // Search with context lines
 * const results = await searchSessions('error', { context: 2 });
 * results.forEach(r => {
 *   console.log(r.contextBefore); // 2 lines before match
 *   console.log(r.match);          // matched line
 *   console.log(r.contextAfter);   // 2 lines after match
 * });
 *
 * @example
 * // Search within specific workspace
 * const results = await searchSessions('bug', { workspace: '/path/to/project' });
 */
export async function searchSessions(
  query: string,
  config?: LibraryConfig
): Promise<SearchResult[]> {
  try {
    const resolved = mergeWithDefaults(config);
    const bound = bindConfiguredReadContext(config, 0);
    try {
      const coreResults = await storage.searchSessions(
        query,
        {
          limit: resolved.limit === Number.MAX_SAFE_INTEGER ? 0 : resolved.limit,
          contextChars: resolved.context * 80,
          workspacePath: bound.workspace,
          includeCrossWorkspaceSources: bound.includeCrossWorkspaceSources,
        },
        bound.dataPath,
        bound.backupPath,
        bound.context
      );
      const results: SearchResult[] = [];
      for (const coreResult of coreResults) {
        try {
          const fullSession = await storage.getSession(
            coreResult.sessionId,
            bound.dataPath,
            bound.backupPath,
            bound.context,
            coreResult.index
          );
          if (!fullSession) {
            throw new DatabaseNotFoundError(`Session ${coreResult.index} not found`);
          }

          const firstSnippet = coreResult.snippets[0];
          const match = firstSnippet?.text ?? '';
          const offset = firstSnippet?.matchPositions[0]?.[0] ?? 0;
          const lines = match.split('\n');
          const contextBefore: string[] = [];
          const contextAfter: string[] = [];

          let matchLineIndex = 0;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line && line.includes(query)) {
              matchLineIndex = i;
              break;
            }
          }

          if (resolved.context > 0) {
            const start = Math.max(0, matchLineIndex - resolved.context);
            const end = Math.min(lines.length, matchLineIndex + resolved.context + 1);

            for (let i = start; i < matchLineIndex; i++) {
              const line = lines[i];
              if (line) contextBefore.push(line);
            }
            for (let i = matchLineIndex + 1; i < end; i++) {
              const line = lines[i];
              if (line) contextAfter.push(line);
            }
          }

          results.push({
            session: convertToLibrarySession(fullSession),
            match: lines[matchLineIndex] ?? match,
            messageIndex: 0,
            offset,
            contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
            contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
          });
        } finally {
          bound.context.releaseSession(coreResult.sessionId);
        }
      }
      return results;
    } finally {
      if (bound.ownsContext) await bound.context.dispose();
    }
  } catch (err) {
    if (isReadPassThroughError(err)) throw err;
    // Check for SQLite BUSY error (database locked)
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      throw new DatabaseLockedError(config?.dataPath ?? 'default path');
    }
    // Check for file not found errors
    if (
      err instanceof Error &&
      (err.message.includes('ENOENT') || err.message.includes('no such file'))
    ) {
      throw new DatabaseNotFoundError(config?.dataPath ?? 'default path');
    }
    // Re-throw library errors as-is
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    // Wrap other errors
    throw new Error(
      `Failed to search sessions: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Export a session to JSON format.
 *
 * @param index - Zero-based session index or composer ID string
 * @param config - Optional configuration (dataPath)
 * @returns JSON string representation of session
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {SessionNotFoundError} If the session ID or index cannot be resolved
 *
 * @example
 * const json = await exportSessionToJson(0);
 * fs.writeFileSync('session.json', json);
 *
 * @example
 * const json = await exportSessionToJson('composer-id-uuid');
 */
export async function exportSessionToJson(
  index: number | string,
  config?: LibraryConfig
): Promise<string> {
  try {
    const bound = bindConfiguredReadContext(config);
    const coreIdentifier = toCoreSessionIdentifier(index);
    try {
      const coreSession = await getCoreSessionInScope(coreIdentifier, bound);
      if (!coreSession) {
        throw new SessionNotFoundError(index);
      }
      return exportToJson(coreSession, coreSession.workspacePath);
    } finally {
      if (bound.ownsContext) await bound.context.dispose();
    }
  } catch (err) {
    if (isReadPassThroughError(err)) throw err;
    if (
      err instanceof DatabaseLockedError ||
      err instanceof DatabaseNotFoundError ||
      err instanceof SessionNotFoundError
    ) {
      throw err;
    }
    throw new Error(
      `Failed to export session to JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Export a session to Markdown format.
 *
 * @param index - Zero-based session index or composer ID string
 * @param config - Optional configuration (dataPath)
 * @returns Markdown formatted string
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {SessionNotFoundError} If the session ID or index cannot be resolved
 *
 * @example
 * const markdown = await exportSessionToMarkdown(0);
 * fs.writeFileSync('session.md', markdown);
 *
 * @example
 * const markdown = await exportSessionToMarkdown('session-id-uuid');
 */
export async function exportSessionToMarkdown(
  index: number | string,
  config?: LibraryConfig
): Promise<string> {
  try {
    const bound = bindConfiguredReadContext(config);
    const coreIdentifier = toCoreSessionIdentifier(index);
    try {
      const coreSession = await getCoreSessionInScope(coreIdentifier, bound);
      if (!coreSession) {
        throw new SessionNotFoundError(index);
      }
      return exportToMarkdown(coreSession, coreSession.workspacePath);
    } finally {
      if (bound.ownsContext) await bound.context.dispose();
    }
  } catch (err) {
    if (isReadPassThroughError(err)) throw err;
    if (
      err instanceof DatabaseLockedError ||
      err instanceof DatabaseNotFoundError ||
      err instanceof SessionNotFoundError
    ) {
      throw err;
    }
    throw new Error(
      `Failed to export session to Markdown: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Export all sessions to JSON format.
 *
 * @param config - Optional configuration (dataPath, workspace filter)
 * @returns JSON string with array of all sessions
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 *
 * @example
 * const json = await exportAllSessionsToJson();
 * fs.writeFileSync('all-sessions.json', json);
 *
 * @example
 * // Export sessions from specific workspace
 * const json = await exportAllSessionsToJson({ workspace: '/path/to/project' });
 */
export async function exportAllSessionsToJson(config?: LibraryConfig): Promise<string> {
  try {
    const bound = bindConfiguredReadContext(config, 0);
    try {
      const coreSessions = await storage.listSessionSummaries(
        {
          limit: -1,
          all: true,
          workspacePath: bound.workspace,
          includeCrossWorkspaceSources: bound.includeCrossWorkspaceSources,
        },
        bound.dataPath,
        bound.backupPath,
        bound.context
      );

      const exportedSessions: Record<string, unknown>[] = [];
      for (const summary of coreSessions) {
        if (isCoreAmbiguousSummary(summary)) {
          reportAmbiguousSummary(summary, bound.onDiagnostic);
          continue;
        }
        try {
          const session = await storage.getSession(
            summary.id,
            bound.dataPath,
            bound.backupPath,
            bound.context,
            summary.index
          );
          if (!session) continue;
          exportedSessions.push(
            JSON.parse(exportToJson(session, session.workspacePath)) as Record<string, unknown>
          );
        } catch (error) {
          if (!isSessionAmbiguityError(error)) throw error;
          reportSessionAmbiguity(
            error.details.sessionId,
            error.details.occurrenceRefs,
            bound.onDiagnostic
          );
        } finally {
          bound.context.releaseSession(summary.id);
        }
      }
      return JSON.stringify(exportedSessions, null, 2);
    } finally {
      if (bound.ownsContext) await bound.context.dispose();
    }
  } catch (err) {
    if (isReadPassThroughError(err)) throw err;
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    throw new Error(
      `Failed to export all sessions to JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Export all sessions to Markdown format.
 *
 * @param config - Optional configuration (dataPath, workspace filter)
 * @returns Markdown formatted string with all sessions
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 *
 * @example
 * const markdown = await exportAllSessionsToMarkdown();
 * fs.writeFileSync('all-sessions.md', markdown);
 */
export async function exportAllSessionsToMarkdown(config?: LibraryConfig): Promise<string> {
  try {
    const bound = bindConfiguredReadContext(config, 0);
    try {
      const coreSessions = await storage.listSessionSummaries(
        {
          limit: -1,
          all: true,
          workspacePath: bound.workspace,
          includeCrossWorkspaceSources: bound.includeCrossWorkspaceSources,
        },
        bound.dataPath,
        bound.backupPath,
        bound.context
      );

      const parts: string[] = [];
      for (const summary of coreSessions) {
        if (isCoreAmbiguousSummary(summary)) {
          reportAmbiguousSummary(summary, bound.onDiagnostic);
          continue;
        }
        try {
          const session = await storage.getSession(
            summary.id,
            bound.dataPath,
            bound.backupPath,
            bound.context,
            summary.index
          );
          if (!session) continue;

          parts.push(exportToMarkdown(session, session.workspacePath));
          parts.push('\n\n---\n\n');
        } catch (error) {
          if (!isSessionAmbiguityError(error)) throw error;
          reportSessionAmbiguity(
            error.details.sessionId,
            error.details.occurrenceRefs,
            bound.onDiagnostic
          );
        } finally {
          bound.context.releaseSession(summary.id);
        }
      }

      return parts.join('');
    } finally {
      if (bound.ownsContext) await bound.context.dispose();
    }
  } catch (err) {
    if (isReadPassThroughError(err)) throw err;
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    throw new Error(
      `Failed to export all sessions to Markdown: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ============================================================================
// Migration Functions
// ============================================================================

/**
 * Migrate one or more sessions to a different workspace.
 *
 * This is the primary migration function for session-level operations.
 * Supports moving (removing from source) or copying (keeping source intact).
 *
 * @param config - Migration configuration
 * @returns Array of results for each session migrated
 * @throws {SessionNotFoundError} If a session cannot be found
 * @throws {WorkspaceNotFoundError} If destination workspace doesn't exist
 * @throws {SameWorkspaceError} If source and destination are the same
 * @throws {DatabaseLockedError} If database is locked by Cursor
 *
 * @example
 * // Move a single session by index
 * const results = await migrateSession({
 *   sessions: 3,
 *   destination: '/path/to/new/project'
 * });
 *
 * @example
 * // Copy multiple sessions
 * const results = await migrateSession({
 *   sessions: [1, 3, 5],
 *   destination: '/path/to/project',
 *   mode: 'copy'
 * });
 *
 * @example
 * // Dry run to preview what would happen
 * const results = await migrateSession({
 *   sessions: '1,3,5',
 *   destination: '/path/to/project',
 *   dryRun: true
 * });
 */
export async function migrateSession(
  config: MigrateSessionConfig
): Promise<SessionMigrationResult[]> {
  const selectors: Array<string | number> = Array.isArray(config.sessions)
    ? [...config.sessions]
    : typeof config.sessions === 'string' && config.sessions.includes(',')
      ? config.sessions.split(',').map((value) => value.trim())
      : [config.sessions];

  // Expand ~ in destination path
  const destination = expandPath(config.destination);

  // Selectors remain one-based for this released migration API. Core binds
  // them once inside the requested workspace and never reloads by index.
  return await migrate.migrateSessions({
    selectors,
    workspacePath: config.workspace,
    destination,
    mode: config.mode ?? 'move',
    dryRun: config.dryRun ?? false,
    force: config.force ?? false,
    dataPath: config.dataPath,
    sourceReadLimits: config.sourceReadLimits,
    signal: config.signal,
  });
}

/**
 * Migrate all sessions from one workspace to another.
 *
 * This is a convenience function for workspace-level migration.
 * Uses migrateSession internally for each session in the source workspace.
 *
 * @param config - Workspace migration configuration
 * @returns Aggregate result with per-session details
 * @throws {WorkspaceNotFoundError} If source or destination workspace doesn't exist
 * @throws {SameWorkspaceError} If source and destination are the same
 * @throws {NoSessionsFoundError} If source workspace has no sessions
 * @throws {DestinationHasSessionsError} If destination has sessions and force not set
 * @throws {DatabaseLockedError} If database is locked by Cursor
 *
 * @example
 * // Move all sessions from old to new project
 * const result = await migrateWorkspace({
 *   source: '/old/project',
 *   destination: '/new/project'
 * });
 * console.log(`Migrated ${result.successCount} sessions`);
 *
 * @example
 * // Create backup copy of all sessions
 * const result = await migrateWorkspace({
 *   source: '/project',
 *   destination: '/backup/project',
 *   mode: 'copy'
 * });
 *
 * @example
 * // Force merge with existing destination sessions
 * const result = await migrateWorkspace({
 *   source: '/old/project',
 *   destination: '/existing/project',
 *   force: true
 * });
 */
export async function migrateWorkspace(
  config: MigrateWorkspaceConfig
): Promise<WorkspaceMigrationResult> {
  // Expand ~ in paths
  const source = expandPath(config.source);
  const destination = expandPath(config.destination);

  // Call core migration function
  return await migrate.migrateWorkspace({
    source,
    destination,
    mode: config.mode ?? 'move',
    dryRun: config.dryRun ?? false,
    force: config.force ?? false,
    dataPath: config.dataPath,
    sourceReadLimits: config.sourceReadLimits,
    signal: config.signal,
  });
}

// ============================================================================
// Backup Functions
// ============================================================================

// Re-export backup functions from backup module
export {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir,
} from './backup.js';

// ============================================================================
// SQLite Driver Functions
// ============================================================================

/**
 * Set the SQLite driver to use for database operations.
 *
 * This allows explicit control over which SQLite driver is used.
 * By default, the library auto-detects: tries node:sqlite first (Node.js 22.5+),
 * then falls back to better-sqlite3.
 *
 * @param name - Driver name: 'better-sqlite3' or 'node:sqlite'
 * @returns Nothing; the preference is recorded synchronously. The next awaited
 * database operation validates availability and operation-specific capabilities.
 *
 * @example
 * // Force use of better-sqlite3
 * setDriver('better-sqlite3');
 *
 * @example
 * // Force use of Node.js built-in sqlite
 * setDriver('node:sqlite');
 */
export function setDriver(name: SqliteDriverName): void {
  coreSetDriver(name);
}

/**
 * Get the name of the currently active SQLite driver.
 *
 * Returns undefined if no driver has been selected yet (auto-selection
 * happens on first database operation).
 *
 * @returns Current driver name or undefined
 *
 * @example
 * const driver = getActiveDriver();
 * console.log(`Using ${driver ?? 'auto-detect'}`);
 */
export function getActiveDriver(): SqliteDriverName | undefined {
  try {
    return coreGetActiveDriver() as SqliteDriverName;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No driver is currently active.')) {
      return undefined;
    }
    throw error;
  }
}
