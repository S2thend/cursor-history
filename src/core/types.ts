/**
 * Type definitions for Cursor Chat History CLI
 * Maps Cursor's SQLite storage format to TypeScript types
 */

export type Platform = 'windows' | 'macos' | 'linux';
export type MessageRole = 'user' | 'assistant';

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
}

/**
 * A single exchange within a chat session
 */
export interface Message {
  id: string | null;
  role: MessageRole;
  content: string;
  timestamp: Date;
  codeBlocks: CodeBlock[];
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
}

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
}

/**
 * Options for search operations
 */
export interface SearchOptions {
  limit: number;
  contextChars: number;
  workspacePath?: string;
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
