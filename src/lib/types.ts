/**
 * Public TypeScript type definitions for cursor-history library
 *
 * IMPORTANT: This is a library interface for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API. Functions are imported directly:
 * `import { Session, Message } from 'cursor-history'`
 */

import type {
  IndexScope,
  MessageIdentityOrigin,
  MessageTimestampSource,
  ResolvedSource,
  ResolutionState,
  SessionDiagnostic,
  SessionResolution,
  SessionSourceInstance,
  SessionTimestampSource,
  SourceReadLimitsOverride,
  SourceRole,
  ToolIdentityOrigin,
  WorkspaceMatchKind,
  WorkspaceMembership,
} from '../core/types.js';

export type {
  IndexScope,
  MessageIdentityOrigin,
  MessageTimestampSource,
  ResolvedSource,
  ResolutionReasonCode,
  ResolutionState,
  SessionDiagnostic,
  SessionResolution,
  SessionSourceInstance,
  SessionTimestampSource,
  SourceBoundKind,
  SourceReadLimitsOverride,
  SourceReadLimitsV1,
  SourceRepresentation,
  SourceRole,
  ToolIdentityOrigin,
  WorkspaceMatchKind,
  WorkspaceMembership,
} from '../core/types.js';

/**
 * Represents a complete chat conversation with metadata and messages.
 */
export interface Session {
  /** Native Cursor UUID; workspace, source, and presentation indices never alter it. */
  id: string;

  /** Absolute path to workspace directory */
  workspace: string;

  /** ISO 8601 timestamp of session creation */
  timestamp: string;

  /** Array of messages in chronological order */
  messages: Message[];

  /** Total number of messages in session */
  messageCount: number;

  /** Zero-based presentation index for public read APIs. */
  index?: number;

  /** Scope in which `index` is reusable. */
  indexScope?: IndexScope;

  /** Full matched workspace path when `indexScope` is `workspace`. */
  indexWorkspacePath?: string;

  /**
   * Source data completeness:
   * - 'global': full global bubbles (Composer stack)
   * - 'workspace-fallback': degraded, workspace storage only (Composer stack)
   * - 'transcript': Store stack; the transcript supplies the messages (sole source when no store.db
   *   exists, or fallback when store.db is unreadable/yields no messages)
   * - 'store-complete' / 'store-partial': Store stack, store.db supplies the messages (primary
   *   source); full or partial parse
   * - 'store': legacy alias (pre-rework)
   * - 'merged': resolved from BOTH Composer and Store stacks by session ID
   */
  source?:
    | 'global'
    | 'workspace-fallback'
    | 'transcript'
    | 'store'
    | 'store-complete'
    | 'store-partial'
    | 'merged';

  /**
   * Cross-stack provenance. Present only when `source === 'merged'`:
   * the contributing stacks and the stack that supplies canonical order /
   * wins true scalar conflicts.
   */
  sources?: Array<'composer' | 'store'>;
  preferredSource?: 'composer' | 'store';

  /** Actual selected representation, separate from the compatibility fidelity signal. */
  resolvedSource?: ResolvedSource;

  /** Replacement-safety and contributor state. */
  resolution?: SessionResolution;

  /** Stable canonical workspace path, absent for pathless sessions. */
  canonicalWorkspacePath?: string;

  /** Full workspace path selected by the active filter. */
  matchedWorkspacePath?: string;

  /** Exact or unique component-suffix workspace match. */
  workspaceMatchKind?: WorkspaceMatchKind;

  /** Deterministically ordered historical workspace memberships. */
  workspaceMemberships?: WorkspaceMembership[];

  /** Safe source-instance provenance without physical locators. */
  sourceInstances?: SessionSourceInstance[];

  /** Version of stable message identity allocation. */
  messageIdentityVersion?: 1;

  /** Provenance for the existing `timestamp` creation time. */
  createdAtSource?: SessionTimestampSource;

  /** Provenance for the existing `metadata.lastModified` value. */
  lastUpdatedAtSource?: SessionTimestampSource;

  /** Parse state of the Store transcript when the Store stack contributed. */
  transcriptState?:
    'missing' | 'parsed' | 'partial' | 'empty' | 'error-only' | 'unsupported' | 'unreadable';

  /** Session-level token usage summary (optional, when available) */
  usage?: SessionUsage;

  /** Ordered bubble UUIDs of the active conversation branch */
  activeBranchBubbleIds?: string[];

  /** Active branch rewritten through resolved stable message identities. */
  activeBranchMessageIds?: string[];

  /** Metadata about session origin (optional) */
  metadata?: {
    /** Cursor version that created this session */
    cursorVersion?: string;

    /** Last modified timestamp */
    lastModified?: string;
  };
}

/**
 * Token usage for a single message (input/output tokens consumed).
 */
export interface TokenUsage {
  /** Number of input tokens (prompt tokens) */
  inputTokens: number;

  /** Number of output tokens (completion tokens) */
  outputTokens: number;
}

/**
 * Session-level usage summary (aggregated from messages and composer data).
 */
export interface SessionUsage {
  /** Context tokens used (from composer data) */
  contextTokensUsed?: number;

  /** Context token limit (from composer data) */
  contextTokenLimit?: number;

  /** Context usage percentage (may be int or float, normalized to float) */
  contextUsagePercent?: number;

  /** Total input tokens across all messages */
  totalInputTokens?: number;

  /** Total output tokens across all messages */
  totalOutputTokens?: number;
}

/**
 * Represents a single message within a session (user or assistant).
 */
export interface Message {
  /** Stable bubble UUID from cursorDiskKV when available */
  id?: string;

  /** Version and origin of the resolved stable identity. */
  messageIdentityVersion?: 1;
  identityOrigin?: MessageIdentityOrigin;

  /** Parent reference rewritten through resolved stable identities. */
  parentMessageId?: string;

  /** Whether the message belongs to a sidechain. */
  isSidechain?: boolean;

  /** Message role: 'user' or 'assistant' */
  role: 'user' | 'assistant';

  /** Message content (text, code blocks, or structured data) */
  content: string;

  /**
   * ISO 8601 timestamp for the message. When Cursor does not store a
   * per-message time, the library preserves its historical contract by using
   * the session creation time.
   */
  timestamp: string;

  /** Provenance of `timestamp` when it is directly stored (not inferred). */
  timestampSource?: MessageTimestampSource;

  /**
   * Which stack supplied this resolved message ('composer' | 'store'), or
   * 'both' when an equivalent message was merged across stacks.
   */
  source?: 'composer' | 'store' | 'both';

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
 * Represents a tool/function call executed by the assistant.
 */
export interface ToolCall {
  /** Stable modern identity; legacy consumers may retain array ordinals. */
  id?: string;

  /** Origin of the stable tool identity. */
  identityOrigin?: ToolIdentityOrigin;
  /** Tool/function name (e.g., 'read_file', 'write', 'grep') */
  name: string;

  /** Tool execution status */
  status: 'completed' | 'cancelled' | 'error';

  /** Tool parameters as JSON object */
  params?: Record<string, unknown>;

  /** Tool execution result (optional, present if status === 'completed') */
  result?: string;

  /** Error message (optional, present if status === 'error') */
  error?: string;

  /** File paths involved in this tool call (optional) */
  files?: string[];
}

/**
 * Represents a search match with context.
 */
export interface SearchResult {
  /** Reference to the session containing this match */
  session: Session;

  /** Matched content snippet */
  match: string;

  /** Message index within session where match was found */
  messageIndex: number;

  /** Context lines before match (optional, based on config) */
  contextBefore?: string[];

  /** Context lines after match (optional, based on config) */
  contextAfter?: string[];

  /** Character offset of match within message content */
  offset?: number;
}

/**
 * Available SQLite driver names for the pluggable driver system.
 */
export type SqliteDriverName = 'better-sqlite3' | 'node:sqlite';

/**
 * Valid message type filter values for filtering displayed messages.
 * Re-exported from core types for library consumers.
 */
export type { MessageType } from '../core/types.js';
export { MESSAGE_TYPES } from '../core/types.js';

/**
 * Configuration options for library functions.
 */
export interface LibraryConfig {
  /** Custom Cursor data path (optional, defaults to platform path) */
  dataPath?: string;

  /** Filter sessions by workspace path (optional) */
  workspace?: string;

  /** Pagination limit (optional, defaults to no limit) */
  limit?: number;

  /** Pagination offset (optional, defaults to 0) */
  offset?: number;

  /** Search context lines (optional, defaults to 0) */
  context?: number;

  /** Read from backup file instead of live data (optional) */
  backupPath?: string;

  /**
   * SQLite driver to use (optional).
   * - 'better-sqlite3': Native bindings, works on most Node.js versions
   * - 'node:sqlite': Built-in (Node.js 22.5+), no native bindings needed
   * If not specified, auto-detects: tries node:sqlite first, then better-sqlite3.
   * Can also be set via CURSOR_HISTORY_SQLITE_DRIVER environment variable.
   */
  sqliteDriver?: SqliteDriverName;

  /**
   * Filter messages by type. When provided, only messages matching
   * these types are included in session results.
   *
   * Valid types: 'user', 'assistant', 'tool', 'thinking', 'error'
   *
   * @example
   * // Show only user messages
   * { messageFilter: ['user'] }
   *
   * @example
   * // Show user messages and tool calls
   * { messageFilter: ['user', 'tool'] }
   */
  messageFilter?: import('../core/types.js').MessageType[];

  /** Load related contributors outside scope only for UUIDs already selected in scope. */
  includeCrossWorkspaceSources?: boolean;

  /** Receive safe continuation diagnostics such as skipped ambiguity groups. */
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;

  /** Immutable per-operation Source Read Limits v1 overrides. */
  sourceReadLimits?: SourceReadLimitsOverride;

  /** Reuse an explicitly bound opaque read context. */
  readContext?: SessionReadContext;

  /** Cooperatively cancel this operation and nested parsing/snapshot work. */
  signal?: AbortSignal;
}

/** Options for constructing an immutable public read context. */
export interface SessionReadContextOptions {
  dataPath?: string;
  backupPath?: string;
  workspace?: string;
  includeCrossWorkspaceSources?: boolean;
  resolvedSessionCapacity?: number;
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
  sqliteDriver?: SqliteDriverName;
  sourceReadLimits?: SourceReadLimitsOverride;
  signal?: AbortSignal;
}

/** Opaque lifecycle for scope-bound, bounded session reads. */
export interface SessionReadContext {
  readonly resolvedSessionCapacity: number;
  readonly disposed: boolean;
  releaseSession(sessionId: string): void;
  dispose(): Promise<void>;
}

/** Message-free public logical catalog row. */
export interface SessionSummary {
  id: string;
  index: number;
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  resolutionState: ResolutionState | 'ambiguous';
  title?: string | null;
  preview?: string;
  messageCount?: number;
  source?: 'global' | 'workspace-fallback';
  resolvedSource?: ResolvedSource;
  sources?: SourceRole[];
  resolution?: SessionResolution;
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
  workspaceMatchKind?: WorkspaceMatchKind;
  workspaceMemberships?: WorkspaceMembership[];
  sourceInstances?: SessionSourceInstance[];
  sourceRoles?: SourceRole[];
  occurrenceCount?: number;
  diagnosticOccurrenceRefs?: string[];
}

/**
 * Wrapper for paginated API responses.
 */
export interface PaginatedResult<T> {
  /** Array of data items for current page */
  data: T[];

  /** Pagination metadata */
  pagination: {
    /** Total number of items across all pages */
    total: number;

    /** Maximum items per page (from config.limit) */
    limit: number;

    /** Offset of first item in current page (from config.offset) */
    offset: number;

    /** Whether more pages exist after this one */
    hasMore: boolean;
  };
}

// ============================================================================
// Migration Types (Library API)
// ============================================================================

/**
 * Migration mode: move removes from source, copy keeps source intact
 */
export type MigrationMode = 'move' | 'copy';

/**
 * Configuration for session-level migration.
 */
export interface MigrateSessionConfig {
  /**
   * Session identifier(s) to migrate.
   * Can be:
   * - Single session ID (UUID): "abc123-def456"
   * - Single index (1-based): "3" or 3
   * - Multiple comma-separated: "1,3,5" or "abc123,def456"
   * - Array of IDs/indices: ["1", "3"] or [1, 3]
   */
  sessions: string | number | (string | number)[];

  /** Destination workspace path (absolute or relative, resolved to absolute) */
  destination: string;

  /** Migration mode: 'move' (default) or 'copy' */
  mode?: MigrationMode;

  /** If true, preview without making changes */
  dryRun?: boolean;

  /** If true, proceed even if destination has existing history */
  force?: boolean;

  /** Custom Cursor data path (optional, uses default if not specified) */
  dataPath?: string;
}

/**
 * Configuration for workspace-level migration.
 */
export interface MigrateWorkspaceConfig {
  /** Source workspace path to migrate from (exact match) */
  source: string;

  /** Destination workspace path to migrate to */
  destination: string;

  /** Migration mode: 'move' (default) or 'copy' */
  mode?: MigrationMode;

  /** If true, preview without making changes */
  dryRun?: boolean;

  /** If true, proceed even if destination has existing history */
  force?: boolean;

  /** Custom Cursor data path (optional, uses default if not specified) */
  dataPath?: string;
}

/**
 * Result of migrating a single session.
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
}

/**
 * Aggregate result of workspace migration.
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
// Backup Types (Library API)
// ============================================================================

/**
 * Metadata stored in the manifest.json file within the backup zip.
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
 * A single file entry in the backup manifest.
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
 * Aggregate statistics for a backup.
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
 * Configuration for backup creation operation.
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
 * Progress information during backup operation.
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
 * Result of a backup operation.
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
 * Configuration for restore operation.
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
 * Progress information during restore operation.
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
 * Result of a restore operation.
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
 * Result of backup integrity validation.
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
 * Metadata about a backup file for listing purposes.
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
