/**
 * API Contract: Library API for Cursor History Access
 *
 * This file defines the complete TypeScript API surface for the cursor-history library.
 * All types and functions exported from src/lib/index.ts must conform to this contract.
 *
 * IMPORTANT: This is a **library interface** for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API. Functions are imported directly:
 * `import { listSessions } from 'cursor-history'`
 *
 * Feature: 002-library-api
 * Date: 2025-12-22
 */

// ============================================================================
// Core Data Types
// ============================================================================

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
// Error Types
// ============================================================================

/**
 * Thrown when database is locked by Cursor or another process.
 *
 * Recovery: Close Cursor IDE and retry, or implement custom retry logic.
 */
export class DatabaseLockedError extends Error {
  name: 'DatabaseLockedError';
  /** Path to locked database file */
  path: string;
}

/**
 * Thrown when database file or directory does not exist.
 *
 * Recovery: Verify Cursor is installed, check dataPath configuration.
 */
export class DatabaseNotFoundError extends Error {
  name: 'DatabaseNotFoundError';
  /** Path that was not found */
  path: string;
}

/**
 * Thrown when configuration parameters are invalid.
 *
 * Recovery: Fix configuration values per LibraryConfig validation rules.
 */
export class InvalidConfigError extends Error {
  name: 'InvalidConfigError';
  /** Name of invalid config field */
  field: string;
  /** Invalid value provided */
  value: unknown;
}

// ============================================================================
// API Functions
// ============================================================================

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
 * const result = listSessions();
 * console.log(result.data); // Session[]
 *
 * @example
 * // List sessions with pagination
 * const page1 = listSessions({ limit: 10, offset: 0 });
 * const page2 = listSessions({ limit: 10, offset: 10 });
 *
 * @example
 * // List sessions for specific workspace
 * const result = listSessions({ workspace: '/path/to/project' });
 */
export function listSessions(config?: LibraryConfig): PaginatedResult<Session>;

/**
 * Get a specific session by index.
 *
 * @param index - Zero-based session index (from listSessions result)
 * @param config - Optional configuration (dataPath)
 * @returns Complete session with all messages
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {InvalidConfigError} If index is out of bounds
 *
 * @example
 * const session = getSession(0);
 * console.log(session.messages); // Message[]
 *
 * @example
 * // Get session from custom data path
 * const session = getSession(5, { dataPath: '/custom/cursor/data' });
 */
export function getSession(index: number, config?: LibraryConfig): Session;

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
 * const results = searchSessions('authentication');
 *
 * @example
 * // Search with context lines
 * const results = searchSessions('error', { context: 2 });
 * results.forEach(r => {
 *   console.log(r.contextBefore); // 2 lines before match
 *   console.log(r.match);          // matched line
 *   console.log(r.contextAfter);   // 2 lines after match
 * });
 *
 * @example
 * // Search within specific workspace
 * const results = searchSessions('bug', { workspace: '/path/to/project' });
 */
export function searchSessions(query: string, config?: LibraryConfig): SearchResult[];

/**
 * Export a session to JSON format.
 *
 * @param index - Zero-based session index (from listSessions result)
 * @param config - Optional configuration (dataPath)
 * @returns JSON string representation of session
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {InvalidConfigError} If index is out of bounds
 *
 * @example
 * const json = exportSessionToJson(0);
 * fs.writeFileSync('session.json', json);
 */
export function exportSessionToJson(index: number, config?: LibraryConfig): string;

/**
 * Export a session to Markdown format.
 *
 * @param index - Zero-based session index (from listSessions result)
 * @param config - Optional configuration (dataPath)
 * @returns Markdown formatted string
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {InvalidConfigError} If index is out of bounds
 *
 * @example
 * const markdown = exportSessionToMarkdown(0);
 * fs.writeFileSync('session.md', markdown);
 */
export function exportSessionToMarkdown(index: number, config?: LibraryConfig): string;

/**
 * Export all sessions to JSON format.
 *
 * @param config - Optional configuration (dataPath, workspace filter)
 * @returns JSON string with array of all sessions
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 *
 * @example
 * const json = exportAllSessionsToJson();
 * fs.writeFileSync('all-sessions.json', json);
 *
 * @example
 * // Export sessions from specific workspace
 * const json = exportAllSessionsToJson({ workspace: '/path/to/project' });
 */
export function exportAllSessionsToJson(config?: LibraryConfig): string;

/**
 * Export all sessions to Markdown format.
 *
 * @param config - Optional configuration (dataPath, workspace filter)
 * @returns Markdown formatted string with all sessions
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 *
 * @example
 * const markdown = exportAllSessionsToMarkdown();
 * fs.writeFileSync('all-sessions.md', markdown);
 */
export function exportAllSessionsToMarkdown(config?: LibraryConfig): string;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get the platform-specific default Cursor data path.
 *
 * @returns Absolute path to Cursor data directory
 *
 * @example
 * const defaultPath = getDefaultDataPath();
 * console.log(defaultPath);
 * // macOS: ~/Library/Application Support/Cursor/User
 * // Linux: ~/.config/Cursor/User
 * // Windows: %APPDATA%\Cursor\User
 */
export function getDefaultDataPath(): string;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if an error is a DatabaseLockedError.
 *
 * @param error - Error to check
 * @returns True if error is DatabaseLockedError
 *
 * @example
 * try {
 *   const sessions = listSessions();
 * } catch (err) {
 *   if (isDatabaseLockedError(err)) {
 *     console.error('Database locked, please close Cursor');
 *   }
 * }
 */
export function isDatabaseLockedError(error: unknown): error is DatabaseLockedError;

/**
 * Type guard to check if an error is a DatabaseNotFoundError.
 *
 * @param error - Error to check
 * @returns True if error is DatabaseNotFoundError
 *
 * @example
 * try {
 *   const sessions = listSessions({ dataPath: '/invalid/path' });
 * } catch (err) {
 *   if (isDatabaseNotFoundError(err)) {
 *     console.error('Database not found at', err.path);
 *   }
 * }
 */
export function isDatabaseNotFoundError(error: unknown): error is DatabaseNotFoundError;

/**
 * Type guard to check if an error is an InvalidConfigError.
 *
 * @param error - Error to check
 * @returns True if error is InvalidConfigError
 *
 * @example
 * try {
 *   const sessions = listSessions({ limit: -1 });
 * } catch (err) {
 *   if (isInvalidConfigError(err)) {
 *     console.error(`Invalid ${err.field}: ${err.value}`);
 *   }
 * }
 */
export function isInvalidConfigError(error: unknown): error is InvalidConfigError;
