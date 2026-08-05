/**
 * Public API for Cursor Chat History
 */

// Types
export type {
  Platform,
  MessageRole,
  CursorDataStore,
  Workspace,
  ChatSession,
  ChatSessionSummary,
  Message,
  CodeBlock,
  SearchResult,
  SearchSnippet,
  ListOptions,
  SearchOptions,
  ExportOptions,
  SourceRole,
  SourceRepresentation,
  ResolvedSource,
  ResolutionState,
  ResolutionReasonCode,
  IndexScope,
  WorkspaceMatchKind,
  MessageIdentityOrigin,
  ToolIdentityOrigin,
  MessageTimestampSource,
  SessionTimestampSource,
  WorkspaceMembership,
  SessionSourceInstance,
  SessionResolution,
  SessionDiagnostic,
  SourceReadLimitsV1,
  SourceReadLimitsOverride,
  SourceBoundKind,
  AmbiguousSessionSummary,
  LogicalSessionSummary,
} from './types.js';
export type { SessionReadContext } from './storage.js';

// Storage operations
export {
  findWorkspaces,
  listWorkspaces,
  listSessions,
  getSession,
  createSessionReadContext,
  searchSessions,
  openDatabase,
  readWorkspaceJson,
} from './storage.js';

// Parsing utilities
export {
  parseChatData,
  extractCodeBlocks,
  extractPreview,
  getSearchSnippets,
  exportToMarkdown,
  exportToJson,
} from './parser.js';

export {
  SessionIntegrityError,
  WorkspaceAmbiguityError,
  SessionAmbiguityError,
  SessionScopeMismatchError,
  UnsupportedSessionMigrationError,
  MigrationTargetChangedError,
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

export {
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  SOURCE_READ_LIMIT_FIELDS,
  resolveSourceReadLimits,
  sourceLimitDimension,
  exceedsInclusiveLimit,
} from './source-read-limits.js';
