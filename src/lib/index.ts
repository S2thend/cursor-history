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
  MigrationMode,
  MigrateSessionConfig,
  MigrateWorkspaceConfig,
  SessionMigrationResult,
  WorkspaceMigrationResult,
  // Backup types
  BackupManifest,
  BackupFileEntry,
  BackupStats,
  BackupConfig,
  BackupProgress,
  BackupResult,
  RestoreConfig,
  RestoreProgress,
  RestoreResult,
  BackupValidation,
  BackupInfo,
  // SQLite driver type
  SqliteDriverName,
  // Message filter type
  MessageType,
} from './types.js';

// Export MESSAGE_TYPES constant
export { MESSAGE_TYPES } from './types.js';

// Export error classes
export {
  DatabaseLockedError,
  DatabaseNotFoundError,
  InvalidConfigError,
  InvalidFilterError,
  SessionNotFoundError,
  WorkspaceNotFoundError,
  SameWorkspaceError,
  NoSessionsFoundError,
  DestinationHasSessionsError,
  // Backup errors
  BackupError,
  NoDataError,
  FileExistsError,
  InsufficientSpaceError,
  RestoreError,
  BackupNotFoundError,
  InvalidBackupError,
  TargetExistsError,
  IntegrityError,
  // Type guards
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isInvalidConfigError,
  isInvalidFilterError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isSameWorkspaceError,
  isNoSessionsFoundError,
  isDestinationHasSessionsError,
  // Backup type guards
  isBackupError,
  isNoDataError,
  isFileExistsError,
  isInsufficientSpaceError,
  isRestoreError,
  isBackupNotFoundError,
  isInvalidBackupError,
  isTargetExistsError,
  isIntegrityError,
} from './errors.js';

// Export utility functions
export { getDefaultDataPath } from './utils.js';

// Export filter functions from formatters
export {
  getMessageType,
  filterMessages,
  validateMessageTypes,
} from '../cli/formatters/table.js';

// API Functions (to be implemented in Phase 3+)
import type { LibraryConfig, PaginatedResult, Session, SearchResult, MigrateSessionConfig, MigrateWorkspaceConfig, SessionMigrationResult, WorkspaceMigrationResult, SqliteDriverName } from './types.js';
import { mergeWithDefaults } from './config.js';
import { DatabaseLockedError, DatabaseNotFoundError, InvalidFilterError } from './errors.js';
import { filterMessages as filterMessagesImpl, validateMessageTypes as validateMessageTypesImpl } from '../cli/formatters/table.js';
import { MESSAGE_TYPES as MESSAGE_TYPES_CONST } from '../core/types.js';
import * as storage from '../core/storage.js';
import * as migrate from '../core/migrate.js';
import { exportToJson, exportToMarkdown } from '../core/parser.js';
import { expandPath } from './platform.js';
import type { ChatSession as CoreSession } from '../core/types.js';
import { setDriver as coreSetDriver, getActiveDriver as coreGetActiveDriver } from '../core/database/index.js';

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
 * const result = await listSessions();
 * console.log(result.data); // Session[]
 *
 * @example
 * // List sessions with pagination
 * const page1 = await listSessions({ limit: 10, offset: 0 });
 * const page2 = await listSessions({ limit: 10, offset: 10 });
 *
 * @example
 * // List sessions for specific workspace
 * const result = await listSessions({ workspace: '/path/to/project' });
 */
export async function listSessions(config?: LibraryConfig): Promise<PaginatedResult<Session>> {
  try {
    const resolved = mergeWithDefaults(config);

    // Get all sessions using core storage layer
    const coreSessions = await storage.listSessions(
      {
        limit: -1, // Get all, we'll paginate ourselves
        all: true,
        workspacePath: resolved.workspace,
      },
      resolved.dataPath,
      resolved.backupPath
    );

    // Total count before pagination
    const total = coreSessions.length;

    // Apply offset and limit
    const start = resolved.offset;
    const end = Math.min(start + resolved.limit, total);
    const paginatedSessions = coreSessions.slice(start, end);

    // Convert to library Session format
    // We need full sessions, not summaries, so we'll fetch each one
    const sessions: Session[] = [];
    for (const summary of paginatedSessions) {
      const fullSession = await storage.getSession(summary.index, resolved.dataPath, resolved.backupPath);
      if (!fullSession) {
        throw new DatabaseNotFoundError(`Session ${summary.index} not found`);
      }
      sessions.push(convertToLibrarySession(fullSession));
    }

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
 * @param config - Optional configuration (dataPath, messageFilter)
 * @returns Complete session with all messages (filtered if messageFilter specified)
 * @throws {DatabaseLockedError} If database is locked by Cursor
 * @throws {DatabaseNotFoundError} If database path does not exist
 * @throws {InvalidConfigError} If index is out of bounds
 * @throws {InvalidFilterError} If messageFilter contains invalid types
 *
 * @example
 * const session = await getSession(0);
 * console.log(session.messages); // Message[]
 *
 * @example
 * // Get session from custom data path
 * const session = await getSession(5, { dataPath: '/custom/cursor/data' });
 *
 * @example
 * // Get session with only user messages
 * const session = await getSession(0, { messageFilter: ['user'] });
 */
export async function getSession(index: number, config?: LibraryConfig): Promise<Session> {
  try {
    const resolved = mergeWithDefaults(config);

    // Validate message filter if provided
    if (config?.messageFilter && config.messageFilter.length > 0) {
      const invalidTypes = validateMessageTypesImpl(config.messageFilter);
      if (invalidTypes.length > 0) {
        throw new InvalidFilterError(invalidTypes, MESSAGE_TYPES_CONST);
      }
    }

    // Core storage uses 1-based indexing, so we add 1
    const coreIndex = index + 1;

    const coreSession = await storage.getSession(coreIndex, resolved.dataPath, resolved.backupPath);
    if (!coreSession) {
      throw new DatabaseNotFoundError(`Session at index ${index} not found`);
    }

    // Apply message filter if provided
    if (config?.messageFilter && config.messageFilter.length > 0) {
      coreSession.messages = filterMessagesImpl(coreSession.messages, config.messageFilter);
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
    if (err instanceof DatabaseLockedError || err instanceof DatabaseNotFoundError || err instanceof InvalidFilterError) {
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
 * const results = await searchSessions('authentication');
 *
 * @example
 * // Search with context lines
 * const results = await searchSessions('error', { context: 2 });
 * results.forEach(r => {
 *   console.log(r.contextBefore); // 2 lines before match
 *   console.log(r.match);          // matched line
 *   console.log(r.contextAfter);   // 2 lines after match
 * });
 *
 * @example
 * // Search within specific workspace
 * const results = await searchSessions('bug', { workspace: '/path/to/project' });
 */
export async function searchSessions(query: string, config?: LibraryConfig): Promise<SearchResult[]> {
  try {
    const resolved = mergeWithDefaults(config);

    // Search using core storage layer
    const coreResults = await storage.searchSessions(
      query,
      {
        limit: resolved.limit === Number.MAX_SAFE_INTEGER ? 0 : resolved.limit,
        contextChars: resolved.context * 80, // Rough estimate: 1 line = 80 chars
        workspacePath: resolved.workspace,
      },
      resolved.dataPath,
      resolved.backupPath
    );

    // Convert core results to library format
    const results: SearchResult[] = [];
    for (const coreResult of coreResults) {
      // Get full session for reference
      const fullSession = await storage.getSession(coreResult.index, resolved.dataPath, resolved.backupPath);
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

      results.push({
        session: convertToLibrarySession(fullSession),
        match: lines[matchLineIndex] ?? match,
        messageIndex: 0, // Would need to track which message contains the match
        offset,
        contextBefore: contextBefore.length > 0 ? contextBefore : undefined,
        contextAfter: contextAfter.length > 0 ? contextAfter : undefined,
      });
    }

    return results;
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
 * const json = await exportSessionToJson(0);
 * fs.writeFileSync('session.json', json);
 */
export async function exportSessionToJson(index: number, config?: LibraryConfig): Promise<string> {
  try {
    const resolved = mergeWithDefaults(config);
    const coreIndex = index + 1; // Convert to 1-based indexing

    const coreSession = await storage.getSession(coreIndex, resolved.dataPath, resolved.backupPath);
    if (!coreSession) {
      throw new DatabaseNotFoundError(`Session at index ${index} not found`);
    }

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
 * const markdown = await exportSessionToMarkdown(0);
 * fs.writeFileSync('session.md', markdown);
 */
export async function exportSessionToMarkdown(index: number, config?: LibraryConfig): Promise<string> {
  try {
    const resolved = mergeWithDefaults(config);
    const coreIndex = index + 1; // Convert to 1-based indexing

    const coreSession = await storage.getSession(coreIndex, resolved.dataPath, resolved.backupPath);
    if (!coreSession) {
      throw new DatabaseNotFoundError(`Session at index ${index} not found`);
    }

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
 * const json = await exportAllSessionsToJson();
 * fs.writeFileSync('all-sessions.json', json);
 *
 * @example
 * // Export sessions from specific workspace
 * const json = await exportAllSessionsToJson({ workspace: '/path/to/project' });
 */
export async function exportAllSessionsToJson(config?: LibraryConfig): Promise<string> {
  try {
    const resolved = mergeWithDefaults(config);

    // Get all sessions
    const coreSessions = await storage.listSessions(
      {
        limit: -1,
        all: true,
        workspacePath: resolved.workspace,
      },
      resolved.dataPath,
      resolved.backupPath
    );

    // Export each session
    const exportedSessions: Record<string, unknown>[] = [];
    for (const summary of coreSessions) {
      const session = await storage.getSession(summary.index, resolved.dataPath, resolved.backupPath);
      if (!session) continue;
      exportedSessions.push(JSON.parse(exportToJson(session, session.workspacePath)) as Record<string, unknown>);
    }

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
 * const markdown = await exportAllSessionsToMarkdown();
 * fs.writeFileSync('all-sessions.md', markdown);
 */
export async function exportAllSessionsToMarkdown(config?: LibraryConfig): Promise<string> {
  try {
    const resolved = mergeWithDefaults(config);

    // Get all sessions
    const coreSessions = await storage.listSessions(
      {
        limit: -1,
        all: true,
        workspacePath: resolved.workspace,
      },
      resolved.dataPath,
      resolved.backupPath
    );

    // Export each session
    const parts: string[] = [];

    for (const summary of coreSessions) {
      const session = await storage.getSession(summary.index, resolved.dataPath, resolved.backupPath);
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

// ============================================================================
// Migration Functions
// ============================================================================

/**
 * Migrate one or more sessions to a different workspace.
 *
 * This is the primary migration function for session-level operations.
 * Supports moving (removing from source) or copying (keeping source intact).
 *
 * @param config - Migration configuration
 * @returns Array of results for each session migrated
 * @throws {SessionNotFoundError} If a session cannot be found
 * @throws {WorkspaceNotFoundError} If destination workspace doesn't exist
 * @throws {SameWorkspaceError} If source and destination are the same
 * @throws {DatabaseLockedError} If database is locked by Cursor
 *
 * @example
 * // Move a single session by index
 * const results = await migrateSession({
 *   sessions: 3,
 *   destination: '/path/to/new/project'
 * });
 *
 * @example
 * // Copy multiple sessions
 * const results = await migrateSession({
 *   sessions: [1, 3, 5],
 *   destination: '/path/to/project',
 *   mode: 'copy'
 * });
 *
 * @example
 * // Dry run to preview what would happen
 * const results = await migrateSession({
 *   sessions: '1,3,5',
 *   destination: '/path/to/project',
 *   dryRun: true
 * });
 */
export async function migrateSession(config: MigrateSessionConfig): Promise<SessionMigrationResult[]> {
  // Resolve session identifiers to IDs
  const sessionIds = await storage.resolveSessionIdentifiers(config.sessions, config.dataPath);

  // Expand ~ in destination path
  const destination = expandPath(config.destination);

  // Call core migration function
  return await migrate.migrateSessions({
    sessionIds,
    destination,
    mode: config.mode ?? 'move',
    dryRun: config.dryRun ?? false,
    force: config.force ?? false,
    dataPath: config.dataPath,
  });
}

/**
 * Migrate all sessions from one workspace to another.
 *
 * This is a convenience function for workspace-level migration.
 * Uses migrateSession internally for each session in the source workspace.
 *
 * @param config - Workspace migration configuration
 * @returns Aggregate result with per-session details
 * @throws {WorkspaceNotFoundError} If source or destination workspace doesn't exist
 * @throws {SameWorkspaceError} If source and destination are the same
 * @throws {NoSessionsFoundError} If source workspace has no sessions
 * @throws {DestinationHasSessionsError} If destination has sessions and force not set
 * @throws {DatabaseLockedError} If database is locked by Cursor
 *
 * @example
 * // Move all sessions from old to new project
 * const result = await migrateWorkspace({
 *   source: '/old/project',
 *   destination: '/new/project'
 * });
 * console.log(`Migrated ${result.successCount} sessions`);
 *
 * @example
 * // Create backup copy of all sessions
 * const result = await migrateWorkspace({
 *   source: '/project',
 *   destination: '/backup/project',
 *   mode: 'copy'
 * });
 *
 * @example
 * // Force merge with existing destination sessions
 * const result = await migrateWorkspace({
 *   source: '/old/project',
 *   destination: '/existing/project',
 *   force: true
 * });
 */
export async function migrateWorkspace(config: MigrateWorkspaceConfig): Promise<WorkspaceMigrationResult> {
  // Expand ~ in paths
  const source = expandPath(config.source);
  const destination = expandPath(config.destination);

  // Call core migration function
  return await migrate.migrateWorkspace({
    source,
    destination,
    mode: config.mode ?? 'move',
    dryRun: config.dryRun ?? false,
    force: config.force ?? false,
    dataPath: config.dataPath,
  });
}

// ============================================================================
// Backup Functions
// ============================================================================

// Re-export backup functions from backup module
export {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir,
} from './backup.js';

// ============================================================================
// SQLite Driver Functions
// ============================================================================

/**
 * Set the SQLite driver to use for database operations.
 *
 * This allows explicit control over which SQLite driver is used.
 * By default, the library auto-detects: tries node:sqlite first (Node.js 22.5+),
 * then falls back to better-sqlite3.
 *
 * @param name - Driver name: 'better-sqlite3' or 'node:sqlite'
 * @throws {Error} If the specified driver is not available
 *
 * @example
 * // Force use of better-sqlite3
 * setDriver('better-sqlite3');
 *
 * @example
 * // Force use of Node.js built-in sqlite
 * setDriver('node:sqlite');
 */
export function setDriver(name: SqliteDriverName): void {
  coreSetDriver(name);
}

/**
 * Get the name of the currently active SQLite driver.
 *
 * Returns undefined if no driver has been selected yet (auto-selection
 * happens on first database operation).
 *
 * @returns Current driver name or undefined
 *
 * @example
 * const driver = getActiveDriver();
 * console.log(`Using ${driver ?? 'auto-detect'}`);
 */
export function getActiveDriver(): SqliteDriverName | undefined {
  return coreGetActiveDriver() as SqliteDriverName | undefined;
}
