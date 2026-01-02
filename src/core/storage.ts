/**
 * Storage discovery and database access for Cursor chat history
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import AdmZip from 'adm-zip';
import {
  openDatabase as openDatabaseAsync,
  openDatabaseReadWrite as openDatabaseReadWriteAsync,
  ensureDriver,
  type Database,
} from './database/index.js';
import type {
  Workspace,
  ChatSession,
  ChatSessionSummary,
  ListOptions,
  SearchOptions,
  SearchResult,
} from './types.js';
import { getCursorDataPath, contractPath, normalizePath, pathsEqual } from '../lib/platform.js';
import { SessionNotFoundError } from '../lib/errors.js';
import { parseChatData, getSearchSnippets, type CursorChatBundle } from './parser.js';
import { openBackupDatabase, readBackupManifest } from './backup.js';

/**
 * Known SQLite keys for chat data (in priority order)
 */
const CHAT_DATA_KEYS = [
  'composer.composerData', // New Cursor format
  'workbench.panel.aichat.view.aichat.chatdata', // Legacy format
  'workbench.panel.chat.view.chat.chatdata', // Legacy format
];

/**
 * Keys for prompts and generations (new Cursor format)
 */
const PROMPTS_KEY = 'aiService.prompts';
const GENERATIONS_KEY = 'aiService.generations';

/**
 * Get the global Cursor storage path
 */
function getGlobalStoragePath(): string {
  const platform = process.platform;
  const home = homedir();

  if (platform === 'win32') {
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage');
  } else if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  } else {
    return join(home, '.config', 'Cursor', 'User', 'globalStorage');
  }
}

/**
 * Open a SQLite database file (read-only)
 * @deprecated Use openDatabaseAsync for new code
 */
export async function openDatabase(dbPath: string): Promise<Database> {
  return openDatabaseAsync(dbPath);
}

/**
 * Open a SQLite database file for read-write operations
 * IMPORTANT: Only use for migration operations. Requires Cursor to be closed.
 * @deprecated Use openDatabaseReadWriteAsync for new code
 */
export async function openDatabaseReadWrite(dbPath: string): Promise<Database> {
  return openDatabaseReadWriteAsync(dbPath);
}

// ============================================================================
// Backup Data Source (T027)
// ============================================================================

/**
 * Read workspace.json from a backup zip file
 */
function readWorkspaceJsonFromBackup(
  backupPath: string,
  workspaceId: string
): string | null {
  try {
    const zip = new AdmZip(backupPath);
    const jsonPath = `workspaceStorage/${workspaceId}/workspace.json`;
    const buffer = zip.readFile(jsonPath);

    if (!buffer) {
      return null;
    }

    const content = buffer.toString('utf-8');
    const data = JSON.parse(content) as { folder?: string };
    if (data.folder) {
      // Convert file:// URL to path
      return data.folder.replace(/^file:\/\//, '').replace(/%20/g, ' ');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find workspaces from a backup file
 * Note: This is async to ensure driver auto-selection happens first
 */
async function findWorkspacesFromBackup(backupPath: string): Promise<Workspace[]> {
  const manifest = readBackupManifest(backupPath);
  if (!manifest) {
    return [];
  }

  // Ensure driver is selected before proceeding (needed for openBackupDatabase's openSync)
  await ensureDriver();

  const workspaces: Workspace[] = [];

  // Find all workspace databases
  for (const file of manifest.files) {
    if (file.type !== 'workspace-db') continue;

    // Extract workspace ID from path: workspaceStorage/{id}/state.vscdb
    const match = file.path.match(/^workspaceStorage\/([^/]+)\/state\.vscdb$/);
    if (!match) continue;

    const workspaceId = match[1]!;
    // Try to get workspace path from workspace.json, fall back to workspace ID
    const workspacePath = readWorkspaceJsonFromBackup(backupPath, workspaceId) ?? `(workspace: ${workspaceId})`;

    // Count sessions in this workspace
    let sessionCount = 0;
    try {
      const db = openBackupDatabase(backupPath, file.path);
      const result = getChatDataFromDb(db);
      if (result) {
        const parsed = parseChatData(result.data, result.bundle);
        sessionCount = parsed.length;
      }
      db.close();
    } catch {
      continue;
    }

    if (sessionCount > 0) {
      workspaces.push({
        id: workspaceId,
        path: workspacePath,
        dbPath: file.path, // Relative path within backup
        sessionCount,
      });
    }
  }

  return workspaces;
}

/**
 * Read workspace.json to get the original workspace path
 */
export function readWorkspaceJson(workspaceDir: string): string | null {
  const jsonPath = join(workspaceDir, 'workspace.json');
  if (!existsSync(jsonPath)) {
    return null;
  }

  try {
    const content = readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(content) as { folder?: string };
    if (data.folder) {
      // Convert file:// URL to path
      return data.folder.replace(/^file:\/\//, '').replace(/%20/g, ' ');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find all workspaces with chat history
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function findWorkspaces(customDataPath?: string, backupPath?: string): Promise<Workspace[]> {
  // T028: Support reading from backup
  if (backupPath) {
    return await findWorkspacesFromBackup(backupPath);
  }

  const basePath = getCursorDataPath(customDataPath);

  if (!existsSync(basePath)) {
    return [];
  }

  const workspaces: Workspace[] = [];

  try {
    const entries = readdirSync(basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspaceDir = join(basePath, entry.name);
      const dbPath = join(workspaceDir, 'state.vscdb');

      if (!existsSync(dbPath)) continue;

      const workspacePath = readWorkspaceJson(workspaceDir);
      if (!workspacePath) continue;

      // Count sessions in this workspace
      let sessionCount = 0;
      try {
        const db = await openDatabase(dbPath);
        const result = getChatDataFromDb(db);
        if (result) {
          const parsed = parseChatData(result.data, result.bundle);
          sessionCount = parsed.length;
        }
        db.close();
      } catch {
        // Skip workspaces with unreadable databases
        continue;
      }

      if (sessionCount > 0) {
        workspaces.push({
          id: entry.name,
          path: workspacePath,
          dbPath,
          sessionCount,
        });
      }
    }
  } catch {
    return [];
  }

  return workspaces;
}

/**
 * Get chat data JSON from database
 * Returns both the main chat data and the bundle for new format
 */
function getChatDataFromDb(db: Database): { data: string; bundle: CursorChatBundle } | null {
  let mainData: string | null = null;
  const bundle: CursorChatBundle = {};

  // Try to get the main chat data
  for (const key of CHAT_DATA_KEYS) {
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (row?.value) {
        mainData = row.value;
        if (key === 'composer.composerData') {
          bundle.composerData = row.value;
        }
        break;
      }
    } catch {
      continue;
    }
  }

  if (!mainData) {
    return null;
  }

  // For new format, also get prompts and generations
  try {
    const promptsRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(PROMPTS_KEY) as
      | { value: string }
      | undefined;
    if (promptsRow?.value) {
      bundle.prompts = promptsRow.value;
    }
  } catch {
    // Ignore
  }

  try {
    const gensRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(GENERATIONS_KEY) as
      | { value: string }
      | undefined;
    if (gensRow?.value) {
      bundle.generations = gensRow.value;
    }
  } catch {
    // Ignore
  }

  return { data: mainData, bundle };
}

/**
 * List chat sessions with optional filtering
 * Uses workspace storage for listing (has correct paths and complete list)
 * @param options - List options (limit, all, workspacePath)
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function listSessions(options: ListOptions, customDataPath?: string, backupPath?: string): Promise<ChatSessionSummary[]> {
  // T029: Support reading from backup
  const workspaces = await findWorkspaces(customDataPath, backupPath);

  // Filter by workspace if specified
  const filteredWorkspaces = options.workspacePath
    ? workspaces.filter(
        (w) => w.path === options.workspacePath || w.path.endsWith(options.workspacePath ?? '')
      )
    : workspaces;

  const allSessions: ChatSessionSummary[] = [];

  for (const workspace of filteredWorkspaces) {
    try {
      // Open database from live or backup source
      const db = backupPath
        ? openBackupDatabase(backupPath, workspace.dbPath)
        : await openDatabase(workspace.dbPath);
      const result = getChatDataFromDb(db);
      db.close();

      if (!result) continue;

      const sessions = parseChatData(result.data, result.bundle);

      for (const session of sessions) {
        allSessions.push({
          id: session.id,
          index: 0, // Will be assigned after sorting
          title: session.title,
          createdAt: session.createdAt,
          lastUpdatedAt: session.lastUpdatedAt,
          messageCount: session.messageCount,
          workspaceId: workspace.id,
          workspacePath: contractPath(workspace.path),
          preview: session.messages[0]?.content.slice(0, 100) ?? '(Empty session)',
        });
      }
    } catch {
      continue;
    }
  }

  // Sort by most recent first
  allSessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // Assign indexes
  allSessions.forEach((session, i) => {
    session.index = i + 1;
  });

  // Apply limit
  if (!options.all && options.limit > 0) {
    return allSessions.slice(0, options.limit);
  }

  return allSessions;
}

/**
 * List all workspaces with chat history
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function listWorkspaces(customDataPath?: string, backupPath?: string): Promise<Workspace[]> {
  const workspaces = await findWorkspaces(customDataPath, backupPath);

  // Sort by session count descending
  workspaces.sort((a, b) => b.sessionCount - a.sessionCount);

  return workspaces.map((w) => ({
    ...w,
    path: contractPath(w.path),
  }));
}

/**
 * Get a specific session by index
 * Tries global storage first for complete AI responses, falls back to workspace storage
 * @param index - Session index (1-based)
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function getSession(index: number, customDataPath?: string, backupPath?: string): Promise<ChatSession | null> {
  // T030: Support reading from backup
  const summaries = await listSessions({ limit: 0, all: true }, customDataPath, backupPath);
  const summary = summaries.find((s) => s.index === index);

  if (!summary) {
    return null;
  }

  // Try to get full session from global storage (has AI responses)
  // This works for both live data and backup (if backup includes globalStorage)
  try {
    let db: Database | null = null;

    if (backupPath) {
      // Try to open globalStorage from backup
      try {
        db = openBackupDatabase(backupPath, 'globalStorage/state.vscdb');
      } catch {
        // Backup might not have globalStorage, fall through to workspace storage
        db = null;
      }
    } else {
      // Live data - open from filesystem
      const globalPath = getGlobalStoragePath();
      const globalDbPath = join(globalPath, 'state.vscdb');
      if (existsSync(globalDbPath)) {
        db = await openDatabase(globalDbPath);
      }
    }

    if (db) {
      // Check if cursorDiskKV table exists
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'"
      ).get();

      if (tableCheck) {
        // Get all bubbles for this composer
        const bubbleRows = db
          .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC")
          .all(`bubbleId:${summary.id}:%`) as { key: string; value: string }[];

        db.close();

        if (bubbleRows.length > 0) {
          const messages = bubbleRows.map((row) => {
            try {
              const data = JSON.parse(row.value) as {
                type?: number;
                createdAt?: string;
                bubbleId?: string;
              };

              const text = extractBubbleText(data);
              const role = data.type === 2 ? 'assistant' : 'user';

              return {
                id: data.bubbleId ?? row.key.split(':').pop() ?? null,
                role: role as 'user' | 'assistant',
                content: text,
                timestamp: data.createdAt ? new Date(data.createdAt) : new Date(),
                codeBlocks: [],
              };
            } catch {
              return null;
            }
          }).filter((m): m is NonNullable<typeof m> => m !== null && m.content.length > 0);

          if (messages.length > 0) {
            return {
              id: summary.id,
              index,
              title: summary.title,
              createdAt: summary.createdAt,
              lastUpdatedAt: summary.lastUpdatedAt,
              messageCount: messages.length,
              messages,
              workspaceId: summary.workspaceId,
              workspacePath: summary.workspacePath,
            };
          }
        }
      } else {
        db.close();
      }
    }
  } catch {
    // Fall through to workspace storage
  }

  // Fall back to workspace storage (or use backup for backup mode)
  const workspaces = await findWorkspaces(customDataPath, backupPath);
  const workspace = workspaces.find((w) => w.id === summary.workspaceId);

  if (!workspace) {
    return null;
  }

  try {
    // Open database from live or backup source
    const db = backupPath
      ? openBackupDatabase(backupPath, workspace.dbPath)
      : await openDatabase(workspace.dbPath);
    const result = getChatDataFromDb(db);
    db.close();

    if (!result) return null;

    const sessions = parseChatData(result.data, result.bundle);
    const session = sessions.find((s) => s.id === summary.id);

    if (!session) return null;

    return {
      ...session,
      index,
      workspaceId: workspace.id,
      workspacePath: summary.workspacePath,
    };
  } catch {
    return null;
  }
}

/**
 * Search across all chat sessions
 * @param query - Search query string
 * @param options - Search options (limit, contextChars, workspacePath)
 * @param customDataPath - Custom Cursor data path (for live data)
 * @param backupPath - Path to backup zip file (if reading from backup)
 */
export async function searchSessions(
  query: string,
  options: SearchOptions,
  customDataPath?: string,
  backupPath?: string
): Promise<SearchResult[]> {
  // T031: Support reading from backup
  const summaries = await listSessions(
    { limit: 0, all: true, workspacePath: options.workspacePath },
    customDataPath,
    backupPath
  );
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const summary of summaries) {
    const session = await getSession(summary.index, customDataPath, backupPath);
    if (!session) continue;

    const snippets = getSearchSnippets(session.messages, lowerQuery, options.contextChars);

    if (snippets.length > 0) {
      const matchCount = snippets.reduce((sum, s) => sum + s.matchPositions.length, 0);

      results.push({
        sessionId: summary.id,
        index: summary.index,
        workspacePath: summary.workspacePath,
        createdAt: summary.createdAt,
        matchCount,
        snippets,
      });
    }
  }

  // Sort by match count descending
  results.sort((a, b) => b.matchCount - a.matchCount);

  // Apply limit
  if (options.limit > 0) {
    return results.slice(0, options.limit);
  }

  return results;
}

/**
 * List sessions from global Cursor storage (cursorDiskKV table)
 * This is where Cursor stores full conversation data including AI responses
 */
export async function listGlobalSessions(): Promise<ChatSessionSummary[]> {
  const globalPath = getGlobalStoragePath();
  const dbPath = join(globalPath, 'state.vscdb');

  if (!existsSync(dbPath)) {
    return [];
  }

  try {
    const db = await openDatabase(dbPath);

    // Check if cursorDiskKV table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'"
    ).get();

    if (!tableCheck) {
      db.close();
      return [];
    }

    // Get all composerData entries
    const composerRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as { key: string; value: string }[];

    const sessions: ChatSessionSummary[] = [];

    for (const row of composerRows) {
      const composerId = row.key.replace('composerData:', '');

      try {
        const data = JSON.parse(row.value) as {
          name?: string;
          title?: string;
          createdAt?: string;
          updatedAt?: string;
          workspaceUri?: string;
        };

        // Count bubbles for this composer
        const bubbleCount = db
          .prepare("SELECT COUNT(*) as count FROM cursorDiskKV WHERE key LIKE ?")
          .get(`bubbleId:${composerId}:%`) as { count: number };

        if (bubbleCount.count === 0) continue;

        // Get first bubble for preview
        const firstBubble = db
          .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC LIMIT 1")
          .get(`bubbleId:${composerId}:%`) as { value: string } | undefined;

        let preview = '';
        if (firstBubble) {
          try {
            const bubbleData = JSON.parse(firstBubble.value);
            preview = extractBubbleText(bubbleData).slice(0, 100);
          } catch {
            // Ignore
          }
        }

        const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
        const workspacePath = data.workspaceUri
          ? data.workspaceUri.replace(/^file:\/\//, '').replace(/%20/g, ' ')
          : 'Global';

        sessions.push({
          id: composerId,
          index: 0,
          title: data.name ?? data.title ?? null,
          createdAt,
          lastUpdatedAt: data.updatedAt ? new Date(data.updatedAt) : createdAt,
          messageCount: bubbleCount.count,
          workspaceId: 'global',
          workspacePath: contractPath(workspacePath),
          preview,
        });
      } catch {
        continue;
      }
    }

    db.close();

    // Sort by most recent first
    sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Assign indexes
    sessions.forEach((session, i) => {
      session.index = i + 1;
    });

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Get a session from global storage by index
 */
export async function getGlobalSession(index: number): Promise<ChatSession | null> {
  const summaries = await listGlobalSessions();
  const summary = summaries.find((s) => s.index === index);

  if (!summary) {
    return null;
  }

  const globalPath = getGlobalStoragePath();
  const dbPath = join(globalPath, 'state.vscdb');

  try {
    const db = await openDatabase(dbPath);

    // Get all bubbles for this composer
    const bubbleRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC")
      .all(`bubbleId:${summary.id}:%`) as { key: string; value: string }[];

    db.close();

    const messages = bubbleRows.map((row) => {
      try {
        const data = JSON.parse(row.value) as {
          type?: number;
          createdAt?: string;
          bubbleId?: string;
        };

        const text = extractBubbleText(data);
        const role = data.type === 2 ? 'assistant' : 'user';

        return {
          id: data.bubbleId ?? row.key.split(':').pop() ?? null,
          role: role as 'user' | 'assistant',
          content: text,
          timestamp: data.createdAt ? new Date(data.createdAt) : new Date(),
          codeBlocks: [],
        };
      } catch {
        return null;
      }
    }).filter((m): m is NonNullable<typeof m> => m !== null && m.content.length > 0);

    return {
      id: summary.id,
      index,
      title: summary.title,
      createdAt: summary.createdAt,
      lastUpdatedAt: summary.lastUpdatedAt,
      messageCount: messages.length,
      messages,
      workspaceId: 'global',
    };
  } catch {
    return null;
  }
}

/**
 * Format a tool call for display
 */
function formatToolCall(
  toolData: {
    name?: string;
    params?: string;
    result?: string;
    status?: string;
    additionalData?: { status?: string; userDecision?: string };
  }
): string {
  const lines: string[] = [];
  const toolName = toolData.name ?? 'unknown';

  // Parse params
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(toolData.params ?? '{}') as Record<string, unknown>;
  } catch {
    // Ignore parse errors
  }

  // Helper to get string param
  const getParam = (...keys: string[]): string => {
    for (const key of keys) {
      const val = params[key];
      if (typeof val === 'string' && val.trim()) return val;
    }
    return '';
  };

  // Format based on tool type
  if (toolName === 'read_file') {
    lines.push(`[Tool: Read File]`);
    const file = getParam('targetFile', 'path', 'file');
    if (file) lines.push(`File: ${file}`);

    // Show abbreviated content
    try {
      const result = JSON.parse(toolData.result ?? '{}');
      if (result.contents) {
        const preview = result.contents.slice(0, 300).replace(/\n/g, '\\n');
        lines.push(`Content: ${preview}${result.contents.length > 300 ? '...' : ''}`);
      }
    } catch {
      // Ignore
    }
  } else if (toolName === 'list_dir') {
    lines.push(`[Tool: List Directory]`);
    const dir = getParam('targetDirectory', 'path', 'directory');
    if (dir) lines.push(`Directory: ${dir}`);
  } else if (toolName === 'grep' || toolName === 'search' || toolName === 'codebase_search') {
    lines.push(`[Tool: ${toolName === 'grep' ? 'Grep' : 'Search'}]`);
    const pattern = getParam('pattern', 'query', 'searchQuery', 'regex');
    const path = getParam('path', 'directory', 'targetDirectory');
    if (pattern) lines.push(`Pattern: ${pattern}`);
    if (path) lines.push(`Path: ${path}`);
  } else if (toolName === 'run_terminal_command' || toolName === 'run_terminal_cmd' || toolName === 'execute_command') {
    lines.push(`[Tool: Terminal Command]`);
    const cmd = getParam('command', 'cmd');
    if (cmd) lines.push(`Command: ${cmd}`);

    // Show command output from result
    if (toolData.result) {
      try {
        const result = JSON.parse(toolData.result);
        if (result.output && typeof result.output === 'string') {
          const output = result.output.trim();
          if (output) {
            const preview = output.slice(0, 500);
            lines.push(`Output: ${preview}${output.length > 500 ? '...' : ''}`);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  } else if (toolName === 'edit_file' || toolName === 'search_replace') {
    lines.push(`[Tool: ${toolName === 'search_replace' ? 'Search & Replace' : 'Edit File'}]`);
    const file = getParam('targetFile', 'path', 'file', 'filePath', 'relativeWorkspacePath');
    if (file) lines.push(`File: ${file}`);

    // Show edit details
    const oldString = getParam('oldString', 'old_string', 'search', 'searchString');
    const newString = getParam('newString', 'new_string', 'replace', 'replaceString');
    if (oldString || newString) {
      if (oldString) lines.push(`Old: ${oldString.slice(0, 100)}${oldString.length > 100 ? '...' : ''}`);
      if (newString) lines.push(`New: ${newString.slice(0, 100)}${newString.length > 100 ? '...' : ''}`);
    }
  } else if (toolName === 'create_file' || toolName === 'write_file' || toolName === 'write') {
    lines.push(`[Tool: ${toolName === 'create_file' ? 'Create File' : 'Write File'}]`);
    const file = getParam('targetFile', 'path', 'file', 'relativeWorkspacePath');
    if (file) lines.push(`File: ${file}`);
    // Note: Content is extracted from bubble's codeBlocks field in extractBubbleText(), not from params
  } else {
    // Generic tool - show all string params
    lines.push(`[Tool: ${toolName}]`);
    for (const [key, val] of Object.entries(params)) {
      if (typeof val === 'string' && val.trim()) {
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        lines.push(`${label}: ${val.length > 100 ? val.slice(0, 100) + '...' : val}`);
      }
    }

    // Try to extract result for generic tools
    if (toolData.result) {
      try {
        const result = JSON.parse(toolData.result);
        // Check for common result fields
        const resultText = result.output || result.result || result.content || result.text;
        if (resultText && typeof resultText === 'string' && resultText.trim()) {
          const preview = resultText.slice(0, 500);
          lines.push(`Result: ${preview}${resultText.length > 500 ? '...' : ''}`);
        }
      } catch {
        // If result is not JSON, show it directly if it's a string
        if (typeof toolData.result === 'string' && toolData.result.length > 0 && toolData.result.length < 1000) {
          lines.push(`Result: ${toolData.result}`);
        }
      }
    }
  }

  // Add status indicator (for all tools)
  if (toolData.status) {
    const statusEmoji = toolData.status === 'completed' ? '✓' : '❌';
    lines.push(`Status: ${statusEmoji} ${toolData.status}`);
  }

  // Add user decision if present (accepted/rejected/pending)
  const userDecision = toolData.additionalData?.userDecision;
  if (userDecision && typeof userDecision === 'string') {
    const decisionEmoji = userDecision === 'accepted' ? '✓' : userDecision === 'rejected' ? '✗' : '⏳';
    lines.push(`User Decision: ${decisionEmoji} ${userDecision}`);
  }

  return lines.join('\n');
}

/**
 * Format a diff block for display
 */
function formatDiffBlock(diffData: {
  chunks?: Array<{ diffString?: string }>;
  editor?: string;
}): string | null {
  if (!diffData.chunks || !Array.isArray(diffData.chunks)) {
    return null;
  }

  const lines: string[] = [];

  for (const chunk of diffData.chunks) {
    if (chunk.diffString && typeof chunk.diffString === 'string') {
      // Show the full diff with fences
      lines.push('```diff');
      lines.push(chunk.diffString);
      lines.push('```');
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Format tool call data that includes result with diff
 */
function formatToolCallWithResult(toolData: {
  name?: string;
  params?: string;
  result?: string;
  rawArgs?: string;
  status?: string;
  additionalData?: { status?: string; userDecision?: string };
}): string | null {
  const lines: string[] = [];

  // Parse params to get file path first
  let filePath = '';
  if (toolData.params || toolData.rawArgs) {
    try {
      const params = JSON.parse(toolData.params ?? toolData.rawArgs ?? '{}');
      filePath = params.relativeWorkspacePath ?? params.file_path ?? '';
    } catch {
      // Ignore parse errors
    }
  }

  // Parse the result for diff information
  try {
    const result = JSON.parse(toolData.result ?? '{}');

    // Check if result has diff - this function only handles diff results
    if (!(result.diff && typeof result.diff === 'object')) {
      return null;
    }

    // Format as tool call header
    const toolName = toolData.name ?? 'write';
    lines.push(`[Tool: ${toolName === 'write' || toolName === 'write_file' ? 'Write File' : 'Edit File'}]`);

    if (filePath) {
      lines.push(`File: ${filePath}`);
    }

    // Add the diff blocks
    const diffText = formatDiffBlock(result.diff);
    if (diffText) {
      lines.push('');
      lines.push(diffText);
    }

    // Add result summary if available
    if (result.resultForModel && typeof result.resultForModel === 'string') {
      lines.push('');
      lines.push(`Result: ${result.resultForModel}`);
    }
  } catch {
    // Not JSON or no diff
    return null;
  }

  // Add status indicator (only if we have diff content)
  if (toolData.status) {
    const statusEmoji = toolData.status === 'completed' ? '✓' : '❌';
    lines.push('');
    lines.push(`Status: ${statusEmoji} ${toolData.status}`);
  }

  // Add user decision if present
  const userDecision = toolData.additionalData?.userDecision;
  if (userDecision && typeof userDecision === 'string') {
    const decisionEmoji = userDecision === 'accepted' ? '✓' : userDecision === 'rejected' ? '✗' : '⏳';
    lines.push(`User Decision: ${decisionEmoji} ${userDecision}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Extract thinking/reasoning text from bubble
 */
function extractThinkingText(data: Record<string, unknown>): string | null {
  const thinking = data['thinking'] as { text?: string; signature?: string } | undefined;
  if (thinking?.text && typeof thinking.text === 'string' && thinking.text.trim()) {
    return thinking.text;
  }
  return null;
}

/**
 * Extract text content from a bubble object
 *
 * Key insight from Cursor storage analysis:
 * - `text` field contains the natural language explanation ("Based on my analysis...")
 * - `codeBlocks[].content` contains code/mermaid artifacts
 * - Both should be COMBINED, not one chosen over the other
 *
 * Priority for assistant messages:
 * 1. text (main natural language) + codeBlocks (code artifacts) - COMBINED
 * 2. thinking.text (reasoning)
 * 3. toolFormerData.result (tool output)
 *
 * Priority for user messages:
 * 1. codeBlocks (user-pasted code/content)
 * 2. text, content, etc. (user typed message)
 */
function extractBubbleText(data: Record<string, unknown>): string {
  const bubbleType = data['type'] as number | undefined;
  const isAssistant = bubbleType === 2;

  // Check for tool call in toolFormerData (with name = tool action)
  const toolFormerData = data['toolFormerData'] as {
    name?: string;
    params?: string;
    result?: string;
    rawArgs?: string;
    status?: string;
    additionalData?: {
      status?: string;
    };
  } | undefined;

  // Check if it's an error - but don't return yet, mark it and continue extraction
  const isError = toolFormerData?.additionalData?.status === 'error';

  // Priority 1: Check if toolFormerData has result with diff (write/edit operations)
  if (toolFormerData?.result) {
    const toolResult = formatToolCallWithResult(toolFormerData);
    if (toolResult) {
      return toolResult;
    }
  }

  // Priority 2: Check if it's a tool call with name (completed, cancelled, or error)
  if (toolFormerData?.name) {
    const toolInfo = formatToolCall(toolFormerData);

    // Extract content from codeBlocks if available (for ANY tool type)
    const codeBlocks = data['codeBlocks'] as Array<{ content?: string }> | undefined;
    if (codeBlocks && codeBlocks.length > 0 && codeBlocks[0]?.content) {
      const content = codeBlocks[0].content;
      const preview = content.slice(0, 200).replace(/\n/g, '\\n');
      return toolInfo + `\nContent: ${preview}${content.length > 200 ? '...' : ''}`;
    }

    return toolInfo;
  }

  // Extract codeBlocks content
  const codeBlocks = data['codeBlocks'] as Array<{ content?: string; languageId?: string }> | undefined;
  const codeBlockParts: string[] = [];
  if (codeBlocks && Array.isArray(codeBlocks)) {
    for (const cb of codeBlocks) {
      if (typeof cb.content === 'string' && cb.content.trim().length > 0) {
        const lang = cb.languageId ?? '';
        // Wrap code blocks in markdown fences for display
        if (lang) {
          codeBlockParts.push(`\`\`\`${lang}\n${cb.content}\n\`\`\``);
        } else {
          codeBlockParts.push(cb.content);
        }
      }
    }
  }

  // For ASSISTANT messages: prioritize `text` field (natural language), combine with codeBlocks
  if (isAssistant) {
    const textField = data['text'];
    if (typeof textField === 'string' && textField.trim().length > 0) {
      // Check if text is a JSON diff block (backup check if toolFormerData didn't catch it)
      if (textField.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(textField);
          // Check for diff structure
          if (parsed.diff && typeof parsed.diff === 'object') {
            const diffText = formatDiffBlock(parsed.diff);
            if (diffText) {
              // Add result message if available
              if (parsed.resultForModel) {
                return diffText + `\n\nResult: ${parsed.resultForModel}`;
              }
              return diffText;
            }
          }
        } catch {
          // Not JSON, treat as regular text
        }
      }

      // Regular text - combine with code artifacts
      if (codeBlockParts.length > 0) {
        return textField + '\n\n' + codeBlockParts.join('\n\n');
      }
      return textField;
    }

    // Fall back to thinking.text
    const thinkingText = extractThinkingText(data);
    if (thinkingText) {
      if (codeBlockParts.length > 0) {
        return `[Thinking]\n${thinkingText}\n\n` + codeBlockParts.join('\n\n');
      }
      return `[Thinking]\n${thinkingText}`;
    }

    // Fall back to toolFormerData.result
    if (toolFormerData?.result) {
      try {
        const result = JSON.parse(toolFormerData.result);
        if (result.contents && typeof result.contents === 'string') {
          return result.contents;
        }
        if (result.content && typeof result.content === 'string') {
          return result.content;
        }
        if (result.text && typeof result.text === 'string') {
          return result.text;
        }
      } catch {
        if (toolFormerData.result.length > 50 && !toolFormerData.result.startsWith('{')) {
          return toolFormerData.result;
        }
      }
    }

    // Fall back to codeBlocks alone
    if (codeBlockParts.length > 0) {
      return codeBlockParts.join('\n\n');
    }
  }

  // For USER messages: codeBlocks first (user-pasted content), then text fields
  if (codeBlockParts.length > 0) {
    return codeBlockParts.join('\n\n');
  }

  // Common text fields
  for (const key of ['text', 'content', 'finalText', 'message', 'markdown', 'textDescription']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  // Fallback: thinking.text
  const thinkingText = extractThinkingText(data);
  if (thinkingText) {
    return `[Thinking]\n${thinkingText}`;
  }

  // Last resort: find longest string with markdown features
  let best = '';
  const walk = (obj: unknown): void => {
    if (typeof obj === 'object' && obj !== null) {
      if (Array.isArray(obj)) {
        obj.forEach(walk);
      } else {
        Object.values(obj).forEach(walk);
      }
    } else if (typeof obj === 'string') {
      if (obj.length > best.length && (obj.includes('\n') || obj.includes('```') || obj.includes('# '))) {
        best = obj;
      }
    }
  };
  walk(data);

  // If this was marked as an error, prefix with [Error] marker
  if (isError && best) {
    return `[Error]\n${best}`;
  }

  return best;
}

// ============================================================================
// Migration Support Functions
// ============================================================================

/**
 * Find the workspace that contains a specific session by ID
 * Returns workspace info including the dbPath for read-write access
 */
export async function findWorkspaceForSession(
  sessionId: string,
  customDataPath?: string
): Promise<{ workspace: Workspace; dbPath: string } | null> {
  const workspaces = await findWorkspaces(customDataPath);

  for (const workspace of workspaces) {
    try {
      const db = await openDatabase(workspace.dbPath);
      const result = getChatDataFromDb(db);
      db.close();

      if (!result) continue;

      // Parse the composerData - could be new format with allComposers or legacy format
      const parsed = JSON.parse(result.data) as { allComposers?: Array<{ composerId?: string }> } | Array<{ composerId?: string }>;

      // Handle new format with allComposers array
      let composers: Array<{ composerId?: string }>;
      if ('allComposers' in parsed && Array.isArray(parsed.allComposers)) {
        composers = parsed.allComposers;
      } else if (Array.isArray(parsed)) {
        composers = parsed;
      } else {
        continue;
      }

      const found = composers.some((session) => session.composerId === sessionId);

      if (found) {
        return { workspace, dbPath: workspace.dbPath };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Find a workspace by its path (exact match)
 * Returns workspace info including the dbPath
 */
export async function findWorkspaceByPath(
  workspacePath: string,
  customDataPath?: string
): Promise<{ workspace: Workspace; dbPath: string } | null> {
  const workspaces = await findWorkspaces(customDataPath);

  // Normalize path for comparison
  const normalizedPath = normalizePath(workspacePath);

  for (const workspace of workspaces) {
    if (pathsEqual(workspace.path, normalizedPath)) {
      return { workspace, dbPath: workspace.dbPath };
    }
  }

  return null;
}

/**
 * Result from getComposerData containing both raw data and extracted composers
 */
export interface ComposerDataResult {
  /** The composers array (from allComposers or direct array) */
  composers: Array<{ composerId?: string; [key: string]: unknown }>;
  /** The full raw data object (for preserving structure on update) */
  rawData: unknown;
  /** Whether this uses the new allComposers format */
  isNewFormat: boolean;
}

/**
 * Get the composer data from a workspace database
 * Handles both new format (with allComposers) and legacy format (direct array)
 */
export function getComposerData(db: Database): ComposerDataResult | null {
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('composer.composerData') as
      | { value: string }
      | undefined;

    if (!row?.value) {
      return null;
    }

    const rawData = JSON.parse(row.value) as unknown;

    // Check if new format with allComposers
    if (rawData && typeof rawData === 'object' && 'allComposers' in rawData) {
      const data = rawData as { allComposers: Array<{ composerId?: string; [key: string]: unknown }> };
      return {
        composers: data.allComposers ?? [],
        rawData,
        isNewFormat: true,
      };
    }

    // Legacy format - direct array
    if (Array.isArray(rawData)) {
      return {
        composers: rawData as Array<{ composerId?: string; [key: string]: unknown }>,
        rawData,
        isNewFormat: false,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Update the composer data in a workspace database
 * Preserves the original structure (allComposers wrapper or direct array)
 */
export function updateComposerData(
  db: Database,
  composers: Array<{ composerId?: string; [key: string]: unknown }>,
  isNewFormat: boolean,
  originalRawData?: unknown
): void {
  let dataToWrite: unknown;

  if (isNewFormat) {
    // Preserve the original structure, just update allComposers
    if (originalRawData && typeof originalRawData === 'object') {
      dataToWrite = { ...originalRawData as object, allComposers: composers };
    } else {
      dataToWrite = { allComposers: composers };
    }
  } else {
    // Legacy format - direct array
    dataToWrite = composers;
  }

  const jsonValue = JSON.stringify(dataToWrite);
  db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(jsonValue, 'composer.composerData');
}

/**
 * Resolve session identifiers (index or ID) to actual session IDs
 * Supports: single index (number), single ID (string), comma-separated, or array
 *
 * @param input - Session identifier(s): number, string, or array
 * @param customDataPath - Optional custom Cursor data path
 * @returns Array of resolved session IDs
 * @throws SessionNotFoundError if any identifier cannot be resolved
 */
export async function resolveSessionIdentifiers(
  input: string | number | (string | number)[],
  customDataPath?: string
): Promise<string[]> {

  // Normalize input to array
  let identifiers: (string | number)[];

  if (Array.isArray(input)) {
    identifiers = input;
  } else if (typeof input === 'string' && input.includes(',')) {
    // Comma-separated string
    identifiers = input.split(',').map((s) => s.trim());
  } else {
    identifiers = [input];
  }

  // Get all sessions for lookup
  const summaries = await listSessions({ limit: 0, all: true }, customDataPath);

  const resolvedIds: string[] = [];

  for (const identifier of identifiers) {
    let sessionId: string | undefined;

    if (typeof identifier === 'number' || /^\d+$/.test(String(identifier))) {
      // It's an index (1-based)
      const index = typeof identifier === 'number' ? identifier : parseInt(String(identifier), 10);
      const session = summaries.find((s) => s.index === index);
      sessionId = session?.id;
    } else {
      // It's a session ID (UUID-like)
      const session = summaries.find((s) => s.id === String(identifier));
      sessionId = session?.id;
    }

    if (!sessionId) {
      throw new SessionNotFoundError(identifier);
    }

    resolvedIds.push(sessionId);
  }

  return resolvedIds;
}

