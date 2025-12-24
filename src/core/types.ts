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
