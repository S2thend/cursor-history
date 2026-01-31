/**
 * Public TypeScript type definitions for cursor-history library
 *
 * IMPORTANT: This is a library interface for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API. Functions are imported directly:
 * `import { Session, Message } from 'cursor-history'`
 */

/**
 * Represents a complete chat conversation with metadata and messages.
 */
export interface Session {
  /** Unique identifier (database row ID or composite key) */
  id: string;

  /** Absolute path to workspace directory */
  workspace: string;

  /** ISO 8601 timestamp of session creation */
  timestamp: string;

  /** Array of messages in chronological order */
  messages: Message[];

  /** Total number of messages in session */
  messageCount: number;

  /** Metadata about session origin (optional) */
  metadata?: {
    /** Cursor version that created this session */
    cursorVersion?: string;

    /** Last modified timestamp */
    lastModified?: string;
  };
}

/**
 * Represents a single message within a session (user or assistant).
 */
export interface Message {
  /** Message role: 'user' or 'assistant' */
  role: 'user' | 'assistant';

  /** Message content (text, code blocks, or structured data) */
  content: string;

  /** ISO 8601 timestamp when message was created */
  timestamp: string;

  /** Tool calls executed by assistant (optional, assistant-only) */
  toolCalls?: ToolCall[];

  /** AI reasoning/thinking text (optional, assistant-only) */
  thinking?: string;

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
