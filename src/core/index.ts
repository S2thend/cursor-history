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
} from './types.js';

// Storage operations
export {
  findWorkspaces,
  listWorkspaces,
  listSessions,
  getSession,
  resolveSessionIndex,
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
