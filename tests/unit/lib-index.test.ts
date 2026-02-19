import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core modules
const mockListSessions = vi.fn();
const mockGetSession = vi.fn();
const mockSearchSessions = vi.fn();
const mockResolveSessionIdentifiers = vi.fn();

vi.mock('../../src/core/storage.js', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  searchSessions: (...args: unknown[]) => mockSearchSessions(...args),
  resolveSessionIdentifiers: (...args: unknown[]) => mockResolveSessionIdentifiers(...args),
  findWorkspaces: vi.fn().mockResolvedValue([]),
  findWorkspaceForSession: vi.fn().mockResolvedValue(null),
  findWorkspaceByPath: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/core/parser.js', () => ({
  exportToJson: vi.fn((_session: unknown, _ws: unknown) => '{"test": true}'),
  exportToMarkdown: vi.fn((_session: unknown, _ws: unknown) => '# Test'),
  parseChatData: vi.fn(() => []),
}));

vi.mock('../../src/core/migrate.js', () => ({
  migrateSessions: vi.fn().mockResolvedValue([]),
  migrateWorkspace: vi.fn().mockResolvedValue({ success: true }),
}));

const mockCoreSetDriver = vi.fn();
const mockCoreGetActiveDriver = vi.fn();

vi.mock('../../src/core/database/index.js', () => ({
  setDriver: (...args: unknown[]) => mockCoreSetDriver(...args),
  getActiveDriver: (...args: unknown[]) => mockCoreGetActiveDriver(...args),
  ensureDriver: vi.fn().mockResolvedValue(undefined),
  openDatabase: vi.fn(),
}));

vi.mock('../../src/lib/platform.js', () => ({
  getCursorDataPath: vi.fn(() => '/cursor/data'),
  expandPath: (p: string) => p,
  contractPath: (p: string) => p,
  normalizePath: (p: string) => p,
  pathsEqual: (a: string, b: string) => a === b,
}));

// Mock backup module
vi.mock('../../src/lib/backup.js', () => ({
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  validateBackup: vi.fn(),
  listBackups: vi.fn(),
  getDefaultBackupDir: vi.fn(),
}));

import {
  listSessions,
  getSession,
  searchSessions,
  exportSessionToJson,
  exportSessionToMarkdown,
  setDriver,
  getActiveDriver,
} from '../../src/lib/index.js';
import {
  DatabaseLockedError,
  DatabaseNotFoundError,
  InvalidFilterError,
} from '../../src/lib/errors.js';

const now = new Date('2024-01-15T10:00:00Z');
const later = new Date('2024-01-15T11:00:00Z');

function makeCoreSession(id = 'c1', index = 1) {
  return {
    id,
    index,
    title: 'Test',
    createdAt: now,
    lastUpdatedAt: later,
    messageCount: 1,
    workspaceId: 'ws1',
    workspacePath: '~/proj',
    messages: [{ id: 'm1', role: 'user', content: 'Hello', timestamp: now, codeBlocks: [] }],
  };
}

function makeCoreSummary(id = 'c1', index = 1) {
  return {
    id,
    index,
    title: 'Test',
    createdAt: now,
    lastUpdatedAt: later,
    messageCount: 1,
    workspaceId: 'ws1',
    workspacePath: '~/proj',
    preview: 'Hello',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// listSessions
// =============================================================================
describe('listSessions', () => {
  it('returns PaginatedResult with sessions', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    const result = await listSessions();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.id).toBe('c1');
    expect(result.pagination.total).toBe(1);
  });

  it('applies pagination with offset and limit', async () => {
    mockListSessions.mockResolvedValue([
      makeCoreSummary('c1', 1),
      makeCoreSummary('c2', 2),
      makeCoreSummary('c3', 3),
    ]);
    mockGetSession.mockResolvedValue(makeCoreSession('c2', 2));

    const result = await listSessions({ limit: 1, offset: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(3);
    expect(result.pagination.offset).toBe(1);
    expect(result.pagination.hasMore).toBe(true);
  });

  it('wraps SQLITE_BUSY as DatabaseLockedError', async () => {
    mockListSessions.mockRejectedValue(new Error('SQLITE_BUSY'));

    await expect(listSessions()).rejects.toThrow(DatabaseLockedError);
  });

  it('wraps ENOENT as DatabaseNotFoundError', async () => {
    mockListSessions.mockRejectedValue(new Error('ENOENT: no such file'));

    await expect(listSessions()).rejects.toThrow(DatabaseNotFoundError);
  });

  it('wraps unknown errors', async () => {
    mockListSessions.mockRejectedValue(new Error('Something else'));

    await expect(listSessions()).rejects.toThrow('Failed to list sessions');
  });
});

// =============================================================================
// getSession
// =============================================================================
describe('getSession', () => {
  it('converts zero-based to one-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await getSession(0);
    // Should call core getSession with index 1
    expect(mockGetSession).toHaveBeenCalledWith(1, expect.anything(), undefined);
  });

  it('returns converted Session', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const session = await getSession(0);
    expect(session.id).toBe('c1');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]!.role).toBe('user');
    expect(session.timestamp).toBe('2024-01-15T10:00:00.000Z');
  });

  it('throws DatabaseNotFoundError when session not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(getSession(99)).rejects.toThrow(DatabaseNotFoundError);
  });

  it('throws InvalidFilterError for invalid message filter', async () => {
    await expect(getSession(0, { messageFilter: ['invalid' as 'user'] })).rejects.toThrow(
      InvalidFilterError
    );
  });

  it('applies valid messageFilter', async () => {
    const session = makeCoreSession();
    session.messages = [
      { id: 'm1', role: 'user', content: 'Hello', timestamp: now, codeBlocks: [] },
      { id: 'm2', role: 'assistant', content: 'Hi', timestamp: later, codeBlocks: [] },
    ];
    mockGetSession.mockResolvedValue(session);

    const result = await getSession(0, { messageFilter: ['user'] });
    // filterMessages should filter to only user messages
    expect(result.messages.length).toBeLessThanOrEqual(2);
  });

  it('wraps SQLITE_BUSY as DatabaseLockedError', async () => {
    mockGetSession.mockRejectedValue(new Error('SQLITE_BUSY'));

    await expect(getSession(0)).rejects.toThrow(DatabaseLockedError);
  });
});

// =============================================================================
// searchSessions
// =============================================================================
describe('searchSessions', () => {
  it('returns search results', async () => {
    mockSearchSessions.mockResolvedValue([
      {
        sessionId: 'c1',
        index: 1,
        workspacePath: '~/proj',
        createdAt: now,
        matchCount: 1,
        snippets: [{ messageRole: 'user', text: 'found the bug', matchPositions: [[10, 13]] }],
      },
    ]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    const results = await searchSessions('bug');
    expect(results).toHaveLength(1);
    expect(results[0]!.session.id).toBe('c1');
  });

  it('returns empty for no matches', async () => {
    mockSearchSessions.mockResolvedValue([]);

    const results = await searchSessions('nonexistent');
    expect(results).toEqual([]);
  });

  it('wraps SQLITE_BUSY as DatabaseLockedError', async () => {
    mockSearchSessions.mockRejectedValue(new Error('SQLITE_BUSY'));

    await expect(searchSessions('test')).rejects.toThrow(DatabaseLockedError);
  });
});

// =============================================================================
// exportSessionToJson / exportSessionToMarkdown
// =============================================================================
describe('exportSessionToJson', () => {
  it('delegates to core exportToJson', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const json = await exportSessionToJson(0);
    expect(json).toBe('{"test": true}');
  });

  it('throws when session not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(exportSessionToJson(99)).rejects.toThrow(DatabaseNotFoundError);
  });
});

describe('exportSessionToMarkdown', () => {
  it('delegates to core exportToMarkdown', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const md = await exportSessionToMarkdown(0);
    expect(md).toBe('# Test');
  });

  it('throws when session not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(exportSessionToMarkdown(99)).rejects.toThrow(DatabaseNotFoundError);
  });
});

// =============================================================================
// setDriver / getActiveDriver
// =============================================================================
describe('setDriver', () => {
  it('delegates to core setDriver', () => {
    setDriver('better-sqlite3');
    expect(mockCoreSetDriver).toHaveBeenCalledWith('better-sqlite3');
  });
});

describe('getActiveDriver', () => {
  it('delegates to core getActiveDriver', () => {
    mockCoreGetActiveDriver.mockReturnValue('node:sqlite');
    expect(getActiveDriver()).toBe('node:sqlite');
  });

  it('returns undefined when no driver selected', () => {
    mockCoreGetActiveDriver.mockReturnValue(undefined);
    expect(getActiveDriver()).toBeUndefined();
  });
});
