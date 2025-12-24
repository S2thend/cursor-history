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
