/**
 * Type definitions for Cursor Chat History CLI
 * Maps Cursor's SQLite storage format to TypeScript types
 */

export type Platform = 'windows' | 'macos' | 'linux';
export type MessageRole = 'user' | 'assistant';

/**
 * Which Cursor storage stack a piece of data came from.
 * - 'composer': the vscdb Composer stack (workspaceStorage / globalStorage)
 * - 'store': the ~/.cursor Store stack (transcript JSONL / store.db)
 */
export type SessionStackSource = 'composer' | 'store';

/** Logical source role participating in a resolved Cursor session. */
export type SourceRole = 'composer' | 'store';

/** Physical representation used by one source contribution. */
export type SourceRepresentation =
  'composer-global' | 'composer-workspace' | 'store-db' | 'store-transcript' | 'store-metadata';

/** Actual representation selected for a resolved logical session. */
export type ResolvedSource =
  'composer' | 'store-db' | 'store-transcript' | 'store-metadata' | 'merged';

/** Whether a resolved view is replacement-safe or degraded. */
export type ResolutionState = 'complete' | 'partial';

/** Why a source contribution did not produce a complete view. */
export type ResolutionReasonCode =
  | 'workspace-scope-omitted'
  | 'source-unavailable'
  | 'source-read-failed'
  | 'source-partial'
  | 'expected-store-db-unavailable'
  | 'store-db-expectation-unknown'
  | 'store-conversation-unavailable';

/** Scope of a reusable presentation index. */
export type IndexScope = 'global' | 'workspace';

/** How a workspace filter matched a historical workspace path. */
export type WorkspaceMatchKind = 'exact' | 'unique-suffix';

/** Stable identity origin for a resolved message. */
export type MessageIdentityOrigin =
  'composer-native' | 'composer-v0.16-index' | 'store-db-v1' | 'store-transcript-v1';

/** Stable identity origin for a resolved tool call. */
export type ToolIdentityOrigin = 'source-native' | 'tool-v1';

/** Deterministic provenance for resolved session timestamps. */
export type SessionTimestampSource =
  'composer-metadata' | 'store-db-metadata' | 'store-meta' | 'direct-message' | 'epoch-unknown';

/** Membership of one logical UUID in a historical workspace. */
export interface WorkspaceMembership {
  workspacePath: string;
  sourceRoles: SourceRole[];
  contributingInstanceCount: number;
}

/** Safe public provenance for a physical source occurrence. */
export interface SessionSourceInstance {
  sourceRole: SourceRole;
  representation: SourceRepresentation;
  workspacePaths: string[];
  state: 'contributed' | 'equivalent-replica' | 'omitted-by-scope' | 'failed' | 'superseded';
}

/** Completeness and contributor state of a resolved logical session. */
export interface SessionResolution {
  state: ResolutionState;
  expectedSourceRoles: SourceRole[];
  loadedSourceRoles: SourceRole[];
  omittedSourceRoles: SourceRole[];
  failedSourceRoles: SourceRole[];
  reasonCodes: ResolutionReasonCode[];
}

/** General safe diagnostic codes emitted by session resolution. */
export type GeneralSessionDiagnosticCode =
  | 'WORKSPACE_AMBIGUOUS'
  | 'SESSION_AMBIGUOUS'
  | 'SESSION_SCOPE_MISMATCH'
  | 'UNSUPPORTED_SESSION_MIGRATION'
  | 'DATABASE_CAPABILITY_MISSING'
  | 'TEMPORARY_ARTIFACT_CLEANUP_FAILED';

/** A diagnostic that never exposes content or a physical locator. */
export interface GeneralSessionDiagnostic {
  code: GeneralSessionDiagnosticCode;
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  occurrenceCount?: number;
  occurrenceRefs?: string[];
  remedy?: string;
}

/** Inclusive source-reading bounds, versioned as one immutable policy. */
export interface SourceReadLimitsV1 {
  readonly policyVersion: 'source-read-limits/v1';
  readonly jsonlRecordBytes: number;
  readonly jsonlSourceBytes: number;
  readonly jsonlRecordCount: number;
  readonly sqlitePageRows: number;
  readonly sqlitePageBytes: number;
  readonly sqliteValueBytes: number;
  readonly sqliteRowCount: number;
  readonly sqliteDecodedBytes: number;
  readonly zipCompressedBytes: number;
  readonly zipEntryCount: number;
  readonly zipEntryBytes: number;
  readonly zipAggregateBytes: number;
  readonly zipCompressionRatio: number;
}

/** Per-operation overrides; policyVersion is deliberately not caller-settable. */
export type SourceReadLimitsOverride = Partial<Omit<SourceReadLimitsV1, 'policyVersion'>>;

export type JsonlSourceBoundKind =
  'jsonl-record-bytes' | 'jsonl-source-bytes' | 'jsonl-record-count';
export type SqliteSourceBoundKind =
  | 'sqlite-page-rows'
  | 'sqlite-page-bytes'
  | 'sqlite-value-bytes'
  | 'sqlite-row-count'
  | 'sqlite-decoded-bytes';
export type ZipSourceBoundKind =
  | 'zip-compressed-bytes'
  | 'zip-entry-count'
  | 'zip-entry-bytes'
  | 'zip-aggregate-bytes'
  | 'zip-compression-ratio';
export type SourceBoundKind = JsonlSourceBoundKind | SqliteSourceBoundKind | ZipSourceBoundKind;

export type JsonlSourceLimitDimension =
  | {
      sourceKind: 'jsonl';
      bound: 'jsonl-record-bytes' | 'jsonl-source-bytes';
      unit: 'bytes';
    }
  | { sourceKind: 'jsonl'; bound: 'jsonl-record-count'; unit: 'records' };
export type SqliteSourceLimitDimension =
  | {
      sourceKind: 'sqlite';
      bound: 'sqlite-page-rows' | 'sqlite-row-count';
      unit: 'rows';
    }
  | {
      sourceKind: 'sqlite';
      bound: 'sqlite-page-bytes' | 'sqlite-value-bytes' | 'sqlite-decoded-bytes';
      unit: 'bytes';
    };
export type ZipSourceLimitDimension =
  | {
      sourceKind: 'zip';
      bound: 'zip-compressed-bytes' | 'zip-entry-bytes' | 'zip-aggregate-bytes';
      unit: 'bytes';
    }
  | { sourceKind: 'zip'; bound: 'zip-entry-count'; unit: 'records' }
  | { sourceKind: 'zip'; bound: 'zip-compression-ratio'; unit: 'ratio' };

export interface SourceEncodingDiagnostic {
  code: 'SOURCE_ENCODING_INVALID';
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  sourceKind: 'jsonl' | 'sqlite';
  outcome: 'partial';
  remedy: string;
}

export type SourceLimitExceededDiagnostic = {
  code: 'SOURCE_LIMIT_EXCEEDED';
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  policyVersion: 'source-read-limits/v1';
  limit: number;
  observedAtLeast: number;
  outcome: 'partial';
  retryableWithOverride: true;
  remedy: string;
} & (JsonlSourceLimitDimension | SqliteSourceLimitDimension);

export type SessionDiagnostic =
  GeneralSessionDiagnostic | SourceEncodingDiagnostic | SourceLimitExceededDiagnostic;

/** Parse state of the Store transcript associated with a resolved session. */
export type TranscriptState =
  'missing' | 'parsed' | 'partial' | 'empty' | 'error-only' | 'unsupported' | 'unreadable';

/**
 * Origin of a resolved message after cross-stack merge.
 * - 'composer' / 'store': the message came from only that stack
 * - 'both': the two stacks produced an equivalent message that was merged
 */
export type MessageSource = 'composer' | 'store' | 'both';

/**
 * Provenance of a directly-stored per-message timestamp. Only attached when a
 * timestamp is directly stored and can be mapped to that message/turn. Inferred
 * or session-level times are never tagged; Composer may still interpolate an
 * untagged timestamp for compatibility, while Store core messages remain
 * untimed unless Cursor stored a turn timestamp.
 */
export type MessageTimestampSource =
  | 'composer-created-at'
  | 'composer-timing'
  | 'store-turn-timing'
  | 'inferred-previous'
  | 'inferred-next'
  | 'session-fallback'
  | 'unknown';

/**
 * Valid message type filter values for filtering displayed messages
 */
export type MessageType = 'user' | 'assistant' | 'tool' | 'thinking' | 'error';

/**
 * Array of all valid message types (for validation)
 */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'user',
  'assistant',
  'tool',
  'thinking',
  'error',
] as const;

/**
 * Root storage location containing all workspace data
 */
export interface CursorDataStore {
  basePath: string;
  platform: Platform;
}

/**
 * A directory/project that was open in Cursor
 * Maps to a state.vscdb file
 */
export interface Workspace {
  id: string;
  path: string;
  dbPath: string;
  sessionCount: number;
}

/**
 * A single conversation with the AI assistant within a workspace
 */
export interface ChatSession {
  id: string;
  index: number;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  messages: Message[];
  workspaceId: string;
  workspacePath?: string;
  /**
   * Source data completeness:
   * - 'global': full global bubbles (Composer stack, highest fidelity)
   * - 'workspace-fallback': degraded, workspace storage only (Composer stack)
   * - 'transcript': Cursor Store stack; the transcript supplies the messages
   *   (sole source when no store.db exists, or fallback when store.db is
   *   unreadable/yields no messages; store.db metadata may still contribute
   *   title/createdAt)
   * - 'store-complete': Cursor Store stack, store.db supplied the messages
   *   (primary source), fully parsed
   * - 'store-partial': Cursor Store stack, store.db supplied the messages
   *   (primary source) but partially parsed (missing/corrupt leaf, JSON
   *   failure, orphan tool result) — degraded
   * - 'store': legacy alias (pre-rework); avoid in new code
   */
  source?:
    | 'global'
    | 'workspace-fallback'
    | 'transcript'
    | 'store'
    | 'store-complete'
    | 'store-partial'
    | 'merged';
  /** Actual selected source representation; `source` remains the fidelity signal. */
  resolvedSource?: ResolvedSource;
  /**
   * Cross-stack provenance. Present when `resolvedSource === 'merged'`: lists
   * the stacks that contributed and which stack supplies canonical rendering /
   * wins true scalar conflicts. Additive — absent for single-source sessions.
   */
  sources?: SessionStackSource[];
  preferredSource?: SessionStackSource;
  /** Replacement-safety and contributor diagnostics. */
  resolution?: SessionResolution;
  /** Scope of this one-based core/CLI presentation index. */
  indexScope?: IndexScope;
  /** Full matched path when `indexScope` is `workspace`. */
  indexWorkspacePath?: string;
  /** Stable canonical workspace path, independent of active filtering. */
  canonicalWorkspacePath?: string;
  /** Full normalized workspace path selected by the active filter. */
  matchedWorkspacePath?: string;
  /** Whether the active workspace matched exactly or by unique suffix. */
  workspaceMatchKind?: WorkspaceMatchKind;
  /** Deterministically ordered historical workspace memberships. */
  workspaceMemberships?: WorkspaceMembership[];
  /** Safe source provenance without physical locators. */
  sourceInstances?: SessionSourceInstance[];
  /** Version of the resolved message identity contract. */
  messageIdentityVersion?: 1;
  /** Provenance of the existing createdAt field. */
  createdAtSource?: SessionTimestampSource;
  /** Provenance of the existing lastUpdatedAt field. */
  lastUpdatedAtSource?: SessionTimestampSource;
  /** Store transcript state, retained even when store.db supplies the messages. */
  transcriptState?: TranscriptState;
  /** Session-level token usage summary (optional, when available) */
  usage?: SessionUsage;
  /** Ordered bubble IDs of the current active conversation branch */
  activeBranchBubbleIds?: string[];
  /** Active branch rewritten through resolved stable message identities. */
  activeBranchMessageIds?: string[];
}

/**
 * A single exchange within a chat session
 */
export interface Message {
  id: string | null;
  /** Version of the stable resolved identity contract. */
  messageIdentityVersion?: 1;
  /** Source of the resolved identity. */
  identityOrigin?: MessageIdentityOrigin;
  role: MessageRole;
  content: string;
  /**
   * Per-message timestamp. Composer bubble reads preserve the historical gap
   * filling behavior, while Store-only messages may omit this when Cursor does
   * not provide a turn timestamp.
   */
  timestamp?: Date;
  /** Provenance of `timestamp` when it is directly stored (not inferred). */
  timestampSource?: MessageTimestampSource;
  /** Stable parent reference rewritten after merge. */
  parentMessageId?: string;
  /** Whether this message belongs to a sidechain. */
  isSidechain?: boolean;
  codeBlocks: CodeBlock[];
  /**
   * Which stack supplied this resolved message ('composer' | 'store'), or
   * 'both' when an equivalent message was merged across stacks.
   */
  source?: MessageSource;
  /** Tool calls executed by assistant (optional, assistant-only) */
  toolCalls?: ToolCall[];
  /** AI reasoning/thinking text (optional, assistant-only) */
  thinking?: string;
  /** Token usage for this message (optional, when available from bubble data) */
  tokenUsage?: TokenUsage;
  /** AI model name used for this message (optional, assistant-only) */
  model?: string;
  /** Response duration in milliseconds (optional, assistant-only) */
  durationMs?: number;
  /** Metadata about message processing (optional) */
  metadata?: {
    /** Whether message data was partially corrupted */
    corrupted?: boolean;
    /** Original bubble type from database (for debugging) */
    bubbleType?: number;
  };
}

/**
 * Embedded code within a message, extracted from markdown fenced code blocks
 */
export interface CodeBlock {
  language: string | null;
  content: string;
  startLine: number;
}

/**
 * A tool/function call executed by the assistant
 */
export interface ToolCall {
  /** Stable modern tool identity; legacy consumers may retain array ordinals. */
  id?: string;
  /** Source of the stable tool identity. */
  identityOrigin?: ToolIdentityOrigin;
  /** Tool/function name (e.g., 'read_file', 'write', 'grep') */
  name: string;
  /** Tool execution status */
  status: 'completed' | 'cancelled' | 'error';
  /** Tool parameters as JSON object (optional) */
  params?: Record<string, unknown>;
  /** Tool execution result (optional, present if status === 'completed') */
  result?: string;
  /** Error message (optional, present if status === 'error') */
  error?: string;
  /** File paths involved in this tool call (optional) */
  files?: string[];
}

/**
 * Lightweight session summary for list operations (without full messages)
 */
export interface ChatSessionSummary {
  id: string;
  index: number;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  workspaceId: string;
  workspacePath: string;
  preview: string;
  /** Source stack/fidelity (same vocabulary as ChatSession.source) */
  source?:
    | 'global'
    | 'workspace-fallback'
    | 'transcript'
    | 'store'
    | 'store-complete'
    | 'store-partial'
    | 'merged';
  resolvedSource?: ResolvedSource;
  /** Cross-stack provenance (present when `resolvedSource === 'merged'`). */
  sources?: SessionStackSource[];
  preferredSource?: SessionStackSource;
  /** Store transcript state when the Store stack contributes to this session. */
  transcriptState?: TranscriptState;
  indexScope?: IndexScope;
  indexWorkspacePath?: string;
  resolutionState?: ResolutionState;
  resolution?: SessionResolution;
  createdAtSource?: SessionTimestampSource;
  lastUpdatedAtSource?: SessionTimestampSource;
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
  workspaceMatchKind?: WorkspaceMatchKind;
  workspaceMemberships?: WorkspaceMembership[];
  sourceInstances?: SessionSourceInstance[];
  messageIdentityVersion?: 1;
}

/** Message-free summary for a divergent logical UUID. */
export interface AmbiguousSessionSummary {
  id: string;
  index: number;
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  resolutionState: 'ambiguous';
  sourceRoles: SourceRole[];
  occurrenceCount: number;
  diagnosticOccurrenceRefs: string[];
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
}

/** One logical catalog row exposed by summary-only listing APIs. */
export type LogicalSessionSummary = ChatSessionSummary | AmbiguousSessionSummary;

/**
 * Search result with match snippets
 */
export interface SearchResult {
  sessionId: string;
  index: number;
  workspacePath: string;
  createdAt: Date;
  matchCount: number;
  snippets: SearchSnippet[];
}

/**
 * A snippet from a search result with context
 */
export interface SearchSnippet {
  messageRole: MessageRole;
  text: string;
  matchPositions: [number, number][];
}

/**
 * Options for list operations
 */
export interface ListOptions {
  limit: number;
  all: boolean;
  workspacePath?: string;
  includeCrossWorkspaceSources?: boolean;
  sourceReadLimits?: SourceReadLimitsOverride;
  signal?: AbortSignal;
}

/**
 * Options for search operations
 */
export interface SearchOptions {
  limit: number;
  contextChars: number;
  workspacePath?: string;
  includeCrossWorkspaceSources?: boolean;
  sourceReadLimits?: SourceReadLimitsOverride;
  signal?: AbortSignal;
}

/**
 * Options for export operations
 */
export interface ExportOptions {
  format: 'md' | 'json';
  outputPath?: string;
  force: boolean;
}

// ============================================================================
// Migration Types
// ============================================================================

/**
 * Migration mode: move removes from source, copy keeps source intact
 */
export type MigrationMode = 'move' | 'copy';

/**
 * Options for migrating one or more sessions
 */
export interface MigrateSessionOptions {
  /** Session ID(s) to migrate (resolved from index or UUID) */
  sessionIds: string[];
  /** Destination workspace path */
  destination: string;
  /** Migration mode: 'move' (default) or 'copy' */
  mode: MigrationMode;
  /** If true, preview without making changes */
  dryRun: boolean;
  /** If true, proceed even if destination has existing history */
  force: boolean;
  /** Custom Cursor data path (optional) */
  dataPath?: string;
  /** If true, log detailed path transformation info to stderr */
  debug?: boolean;
}

/**
 * Options for migrating all sessions from a workspace
 */
export interface MigrateWorkspaceOptions {
  /** Source workspace path */
  source: string;
  /** Destination workspace path */
  destination: string;
  /** Migration mode: 'move' (default) or 'copy' */
  mode: MigrationMode;
  /** If true, preview without making changes */
  dryRun: boolean;
  /** If true, proceed even if destination has existing history */
  force: boolean;
  /** Custom Cursor data path (optional) */
  dataPath?: string;
  /** If true, log detailed path transformation info to stderr */
  debug?: boolean;
}

/**
 * Result of migrating a single session
 */
export interface SessionMigrationResult {
  /** Whether migration succeeded */
  success: boolean;
  /** Original session ID */
  sessionId: string;
  /** Source workspace path */
  sourceWorkspace: string;
  /** Destination workspace path */
  destinationWorkspace: string;
  /** Mode used for migration */
  mode: MigrationMode;
  /** For copy mode: the new session ID created */
  newSessionId?: string;
  /** Error message if success is false */
  error?: string;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Indicates file paths in session data will be updated (dry run preview) */
  pathsWillBeUpdated?: boolean;
}

/**
 * Aggregate result of workspace migration
 */
export interface WorkspaceMigrationResult {
  /** True if all sessions migrated successfully */
  success: boolean;
  /** Normalized source path */
  source: string;
  /** Normalized destination path */
  destination: string;
  /** Mode used for migration */
  mode: MigrationMode;
  /** Total number of sessions attempted */
  totalSessions: number;
  /** Number of successful migrations */
  successCount: number;
  /** Number of failed migrations */
  failureCount: number;
  /** Per-session results */
  results: SessionMigrationResult[];
  /** Whether this was a dry run */
  dryRun: boolean;
}

// ============================================================================
// Backup Types
// ============================================================================

/**
 * Metadata stored in the manifest.json file within the backup zip
 */
export interface BackupManifest {
  /** Manifest schema version for backward compatibility */
  version: string;
  /** ISO 8601 timestamp when backup was created */
  createdAt: string;
  /** Platform where backup was created */
  sourcePlatform: 'darwin' | 'win32' | 'linux';
  /** cursor-history version that created the backup */
  cursorHistoryVersion: string;
  /** List of files in the backup with metadata */
  files: BackupFileEntry[];
  /** Aggregate statistics for quick display */
  stats: BackupStats;
}

/**
 * A single file entry in the backup manifest
 */
export interface BackupFileEntry {
  /** Path within zip (forward slashes, relative to zip root) */
  path: string;
  /** Original file size in bytes */
  size: number;
  /** SHA-256 checksum for integrity verification */
  checksum: string;
  /** File type for categorization */
  type: 'global-db' | 'workspace-db' | 'workspace-json' | 'manifest';
}

/**
 * Aggregate statistics for a backup
 */
export interface BackupStats {
  /** Total uncompressed size of all files */
  totalSize: number;
  /** Number of chat sessions across all workspaces */
  sessionCount: number;
  /** Number of workspaces included */
  workspaceCount: number;
}

/**
 * Configuration for backup creation operation
 */
export interface BackupConfig {
  /** Source Cursor data path (default: platform-specific) */
  sourcePath?: string;
  /** Output file path (default: ~/cursor-history-backups/<timestamp>.zip) */
  outputPath?: string;
  /** Overwrite existing file without prompting */
  force?: boolean;
  /** Progress callback for UI updates */
  onProgress?: (progress: BackupProgress) => void;
}

/**
 * Progress information during backup operation
 */
export interface BackupProgress {
  /** Current operation phase */
  phase: 'scanning' | 'backing-up' | 'compressing' | 'finalizing';
  /** Current file being processed */
  currentFile?: string;
  /** Files completed / total files */
  filesCompleted: number;
  totalFiles: number;
  /** Bytes completed / total bytes */
  bytesCompleted: number;
  totalBytes: number;
}

/**
 * Result of a backup operation
 */
export interface BackupResult {
  /** Whether backup succeeded */
  success: boolean;
  /** Path to created backup file */
  backupPath: string;
  /** Generated manifest */
  manifest: BackupManifest;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Configuration for restore operation
 */
export interface RestoreConfig {
  /** Path to backup zip file */
  backupPath: string;
  /** Target Cursor data path (default: platform-specific) */
  targetPath?: string;
  /** Overwrite existing data without prompting */
  force?: boolean;
  /** Progress callback for UI updates */
  onProgress?: (progress: RestoreProgress) => void;
}

/**
 * Progress information during restore operation
 */
export interface RestoreProgress {
  /** Current operation phase */
  phase: 'validating' | 'extracting' | 'finalizing';
  /** Current file being processed */
  currentFile?: string;
  /** Files completed / total files */
  filesCompleted: number;
  totalFiles: number;
  /** Integrity status */
  integrityStatus: 'pending' | 'passed' | 'warnings' | 'failed';
  /** Files with checksum warnings (if any) */
  corruptedFiles?: string[];
}

/**
 * Result of a restore operation
 */
export interface RestoreResult {
  /** Whether restore succeeded */
  success: boolean;
  /** Path where data was restored */
  targetPath: string;
  /** Number of files restored */
  filesRestored: number;
  /** Files with integrity warnings (still restored) */
  warnings: string[];
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of backup integrity validation
 */
export interface BackupValidation {
  /** Overall validation status */
  status: 'valid' | 'warnings' | 'invalid';
  /** Manifest if parseable */
  manifest?: BackupManifest;
  /** Files that passed checksum verification */
  validFiles: string[];
  /** Files that failed checksum verification */
  corruptedFiles: string[];
  /** Files missing from manifest */
  missingFiles: string[];
  /** Detailed error messages */
  errors: string[];
}

/**
 * Metadata about a backup file for listing purposes
 */
export interface BackupInfo {
  /** Full path to the backup file */
  filePath: string;
  /** Backup filename */
  filename: string;
  /** File size in bytes */
  fileSize: number;
  /** File modification time (from filesystem) */
  modifiedAt: Date;
  /** Parsed manifest (if valid backup) */
  manifest?: BackupManifest;
  /** Error if backup is invalid or corrupted */
  error?: string;
}

// ============================================================================
// Token Usage Types
// ============================================================================

/**
 * Token usage for a single message (input/output tokens consumed)
 */
export interface TokenUsage {
  /** Number of input tokens (prompt tokens) */
  inputTokens: number;
  /** Number of output tokens (completion tokens) */
  outputTokens: number;
}

/**
 * Session-level usage summary (aggregated from messages and composer data)
 */
export interface SessionUsage {
  /** Context tokens used (from composer data) */
  contextTokensUsed?: number;
  /** Context token limit (from composer data) */
  contextTokenLimit?: number;
  /** Context usage percentage (may be int or float, normalize to float) */
  contextUsagePercent?: number;
  /** Total input tokens across all messages */
  totalInputTokens?: number;
  /** Total output tokens across all messages */
  totalOutputTokens?: number;
}

/**
 * Context window status at message creation time
 */
export interface ContextWindowStatus {
  /** Number of tokens used in context window */
  tokensUsed: number;
  /** Maximum token limit for context window */
  tokenLimit: number;
  /** Percentage of context window remaining (0-100) */
  percentageRemaining: number;
}
