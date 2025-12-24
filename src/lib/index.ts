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
} from './types.js';

// Export error classes (will be created in Phase 2)
export {
  DatabaseLockedError,
  DatabaseNotFoundError,
  InvalidConfigError,
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isInvalidConfigError,
} from './errors.js';

// Export utility functions
export { getDefaultDataPath } from './utils.js';

// API Functions (to be implemented in Phase 3+)
import type { LibraryConfig, PaginatedResult, Session, SearchResult } from './types.js';
import { mergeWithDefaults } from './config.js';
import { DatabaseLockedError, DatabaseNotFoundError } from './errors.js';
import * as storage from '../core/storage.js';
import type { ChatSession as CoreSession } from '../core/types.js';

/**
 * Convert core ChatSession to library Session
 */
function convertToLibrarySession(coreSession: CoreSession): Session {
  return {
    id: coreSession.id,
    workspace: coreSession.workspacePath ?? 'unknown',
    timestamp: coreSession.createdAt.toISOString(),
    messages: coreSession.messages.map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
      timestamp: msg.timestamp.toISOString(),
      toolCalls: msg.toolCalls,
      thinking: msg.thinking,
      metadata: msg.metadata,
    })),
    messageCount: coreSession.messageCount,
    metadata: {
      lastModified: coreSession.lastUpdatedAt.toISOString(),
    },
  };
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
export function listSessions(config?: LibraryConfig): PaginatedResult<Session> {
  try {
    const resolved = mergeWithDefaults(config);

    // Get all sessions using core storage layer
    const coreSessions = storage.listSessions(
      {
        limit: -1, // Get all, we'll paginate ourselves
        all: true,
        workspacePath: resolved.workspace,
      },
      resolved.dataPath
    );

    // Total count before pagination
    const total = coreSessions.length;

    // Apply offset and limit
    const start = resolved.offset;
    const end = Math.min(start + resolved.limit, total);
    const paginatedSessions = coreSessions.slice(start, end);

    // Convert to library Session format
    // We need full sessions, not summaries, so we'll fetch each one
    const sessions: Session[] = paginatedSessions.map((summary) => {
      const fullSession = storage.getSession(summary.index, resolved.dataPath);
      if (!fullSession) {
        throw new DatabaseNotFoundError(`Session ${summary.index} not found`);
      }
      return convertToLibrarySession(fullSession);
    });

    return {
      data: sessions,
      pagination: {
        total,
        limit: resolved.limit,
        offset: resolved.offset,
        hasMore: end < total,
      },
    };
  } catch (err) {
    // Check for SQLite BUSY error (database locked)
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      throw new DatabaseLockedError(config?.dataPath ?? 'default path');
    }
    // Check for file not found errors
    if (err instanceof Error && (err.message.includes('ENOENT') || err.message.includes('no such file'))) {
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
export function getSession(index: number, config?: LibraryConfig): Session {
  try {
    const resolved = mergeWithDefaults(config);

    // Core storage uses 1-based indexing, so we add 1
    const coreIndex = index + 1;

    const coreSession = storage.getSession(coreIndex, resolved.dataPath);
    if (!coreSession) {
      throw new DatabaseNotFoundError(`Session at index ${index} not found`);
    }

    return convertToLibrarySession(coreSession);
  } catch (err) {
    // Check for SQLite BUSY error (database locked)
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      throw new DatabaseLockedError(config?.dataPath ?? 'default path');
    }
    // Check for file not found errors
    if (err instanceof Error && (err.message.includes('ENOENT') || err.message.includes('no such file'))) {
      throw new DatabaseNotFoundError(config?.dataPath ?? 'default path');
    }
    // Re-throw library errors as-is
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
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
export function searchSessions(query: string, config?: LibraryConfig): SearchResult[] {
  try {
    const resolved = mergeWithDefaults(config);

    // Search using core storage layer
    const coreResults = storage.searchSessions(
      query,
      {
        limit: resolved.limit === Number.MAX_SAFE_INTEGER ? 0 : resolved.limit,
        contextChars: resolved.context * 80, // Rough estimate: 1 line = 80 chars
        workspacePath: resolved.workspace,
      },
      resolved.dataPath
    );

    // Convert core results to library format
    return coreResults.map((coreResult) => {
      // Get full session for reference
      const fullSession = storage.getSession(coreResult.index, resolved.dataPath);
      if (!fullSession) {
        throw new DatabaseNotFoundError(`Session ${coreResult.index} not found`);
      }

      // Find the first match to get offset and context
      const firstSnippet = coreResult.snippets[0];
      const match = firstSnippet?.text ?? '';
      const offset = firstSnippet?.matchPositions[0]?.[0] ?? 0;

      // Extract context lines (split by newlines)
      const lines = match.split('\n');
      const contextBefore: string[] = [];
      const contextAfter: string[] = [];

      // Find the line containing the match
      let matchLineIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line && line.includes(query)) {
          matchLineIndex = i;
          break;
        }
      }

      // Get context lines before and after
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

      return {
        session: convertToLibrarySession(fullSession),
        match: lines[matchLineIndex] ?? match,
        messageIndex: 0, // Would need to track which message contains the match
        offset,
        contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
        contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
      };
    });
  } catch (err) {
    // Check for SQLite BUSY error (database locked)
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      throw new DatabaseLockedError(config?.dataPath ?? 'default path');
    }
    // Check for file not found errors
    if (err instanceof Error && (err.message.includes('ENOENT') || err.message.includes('no such file'))) {
      throw new DatabaseNotFoundError(config?.dataPath ?? 'default path');
    }
    // Re-throw library errors as-is
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    // Wrap other errors
    throw new Error(`Failed to search sessions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
export function exportSessionToJson(index: number, config?: LibraryConfig): string {
  try {
    const resolved = mergeWithDefaults(config);
    const coreIndex = index + 1; // Convert to 1-based indexing

    const coreSession = storage.getSession(coreIndex, resolved.dataPath);
    if (!coreSession) {
      throw new DatabaseNotFoundError(`Session at index ${index} not found`);
    }

    const { exportToJson } = require('../core/parser.js');
    return exportToJson(coreSession, coreSession.workspacePath);
  } catch (err) {
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    throw new Error(`Failed to export session to JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
export function exportSessionToMarkdown(index: number, config?: LibraryConfig): string {
  try {
    const resolved = mergeWithDefaults(config);
    const coreIndex = index + 1; // Convert to 1-based indexing

    const coreSession = storage.getSession(coreIndex, resolved.dataPath);
    if (!coreSession) {
      throw new DatabaseNotFoundError(`Session at index ${index} not found`);
    }

    const { exportToMarkdown } = require('../core/parser.js');
    return exportToMarkdown(coreSession, coreSession.workspacePath);
  } catch (err) {
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    throw new Error(`Failed to export session to Markdown: ${err instanceof Error ? err.message : String(err)}`);
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
 * const json = exportAllSessionsToJson();
 * fs.writeFileSync('all-sessions.json', json);
 *
 * @example
 * // Export sessions from specific workspace
 * const json = exportAllSessionsToJson({ workspace: '/path/to/project' });
 */
export function exportAllSessionsToJson(config?: LibraryConfig): string {
  try {
    const resolved = mergeWithDefaults(config);

    // Get all sessions
    const coreSessions = storage.listSessions(
      {
        limit: -1,
        all: true,
        workspacePath: resolved.workspace,
      },
      resolved.dataPath
    );

    // Export each session
    const { exportToJson } = require('../core/parser.js');
    const exportedSessions = coreSessions.map((summary) => {
      const session = storage.getSession(summary.index, resolved.dataPath);
      if (!session) return null;
      return JSON.parse(exportToJson(session, session.workspacePath));
    }).filter((s): s is Record<string, unknown> => s !== null);

    return JSON.stringify(exportedSessions, null, 2);
  } catch (err) {
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    throw new Error(`Failed to export all sessions to JSON: ${err instanceof Error ? err.message : String(err)}`);
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
 * const markdown = exportAllSessionsToMarkdown();
 * fs.writeFileSync('all-sessions.md', markdown);
 */
export function exportAllSessionsToMarkdown(config?: LibraryConfig): string {
  try {
    const resolved = mergeWithDefaults(config);

    // Get all sessions
    const coreSessions = storage.listSessions(
      {
        limit: -1,
        all: true,
        workspacePath: resolved.workspace,
      },
      resolved.dataPath
    );

    // Export each session
    const { exportToMarkdown } = require('../core/parser.js');
    const parts: string[] = [];

    for (const summary of coreSessions) {
      const session = storage.getSession(summary.index, resolved.dataPath);
      if (!session) continue;

      parts.push(exportToMarkdown(session, session.workspacePath));
      parts.push('\n\n---\n\n'); // Separator between sessions
    }

    return parts.join('');
  } catch (err) {
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError) {
      throw err;
    }
    throw new Error(`Failed to export all sessions to Markdown: ${err instanceof Error ? err.message : String(err)}`);
  }
}
