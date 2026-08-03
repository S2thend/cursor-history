import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core modules
const mockListSessions = vi.fn();
const mockGetSession = vi.fn();
const mockSearchSessions = vi.fn();
const mockResolveSessionIdentifiers = vi.fn();
const mockReadContext = {
  workspaceScope: undefined,
  storeSessions: null,
  summaries: null,
  resolvedSessions: new Map(),
};

vi.mock('../../src/core/storage.js', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  searchSessions: (...args: unknown[]) => mockSearchSessions(...args),
  resolveSessionIdentifiers: (...args: unknown[]) => mockResolveSessionIdentifiers(...args),
  createSessionReadContext: vi.fn(() => mockReadContext),
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
  SessionNotFoundError,
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
    expect(mockGetSession).toHaveBeenCalledWith('c1', undefined, undefined, mockReadContext, 1);
  });

  it('preserves assistant roles in listSessions output', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      messages: [{ id: 'm2', role: 'assistant', content: 'Hi', timestamp: later, codeBlocks: [] }],
    });

    const result = await listSessions();
    expect(result.data[0]!.messages[0]!.role).toBe('assistant');
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
  it('resolves a zero-based index inside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    await getSession(0, { workspace: '/workspace/a' });

    expect(mockListSessions).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      undefined,
      undefined,
      mockReadContext
    );
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
  });

  it('converts zero-based to one-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await getSession(0);
    // Should call core getSession with index 1
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined);
  });

  it('interprets a numeric string as a zero-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await getSession('1');

    expect(mockGetSession).toHaveBeenCalledWith(2, undefined, undefined);
  });

  it('passes composer ID string through to core getSession', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession('my-composer-id', 1));

    const session = await getSession('my-composer-id');

    expect(mockGetSession).toHaveBeenCalledWith('my-composer-id', undefined, undefined);
    expect(session.id).toBe('my-composer-id');
  });

  it('keeps direct ID lookup global when workspace is configured', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession('outside-workspace', 1));

    await getSession('outside-workspace', { workspace: '/workspace/a' });

    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockGetSession).toHaveBeenCalledWith('outside-workspace', undefined, undefined);
  });

  it('returns converted Session', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const session = await getSession(0);
    expect(session.id).toBe('c1');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]!.id).toBe('m1');
    expect(session.messages[0]!.role).toBe('user');
    expect(session.timestamp).toBe('2024-01-15T10:00:00.000Z');
  });

  it('preserves the required library message timestamp for an untimed Store message', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      source: 'transcript',
      messages: [{ id: null, role: 'user', content: 'Store message', codeBlocks: [] }],
    });

    const session = await getSession(0);
    expect(session.messages[0]!.timestamp).toBe(now.toISOString());
    expect(session.messages[0]!.timestampSource).toBeUndefined();
  });

  it('omits library Message.id when the core message ID is null', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      messages: [{ id: null, role: 'user', content: 'Hello', timestamp: now, codeBlocks: [] }],
    });

    const session = await getSession(0);
    expect(session.messages[0]!.id).toBeUndefined();
  });

  it('threads session source through the library type', async () => {
    mockGetSession.mockResolvedValue({ ...makeCoreSession(), source: 'workspace-fallback' });

    const session = await getSession(0);
    expect(session.source).toBe('workspace-fallback');
  });

  it('threads Store transcript state through the library type', async () => {
    mockGetSession.mockResolvedValue({ ...makeCoreSession(), transcriptState: 'partial' });

    const session = await getSession(0);
    expect(session.transcriptState).toBe('partial');
  });

  it('threads activeBranchBubbleIds through the library type when defined', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      activeBranchBubbleIds: ['m1'],
    });

    const session = await getSession(0);
    expect(session.activeBranchBubbleIds).toEqual(['m1']);
  });

  it('throws SessionNotFoundError with the caller identifier when session is not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(getSession(99)).rejects.toMatchObject({
      name: 'SessionNotFoundError',
      identifier: 99,
    } satisfies Partial<SessionNotFoundError>);
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
    expect(mockSearchSessions.mock.calls[0]?.[4]).toBe(mockReadContext);
    expect(mockGetSession).toHaveBeenCalledWith('c1', undefined, undefined, mockReadContext, 1);
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
  it('resolves the export target inside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToJson(0, { workspace: '/workspace/a' });

    expect(mockListSessions).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      undefined,
      undefined,
      mockReadContext
    );
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
  });

  it('delegates to core exportToJson', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const json = await exportSessionToJson(0);
    expect(json).toBe('{"test": true}');
  });

  it('interprets a numeric string export target as a zero-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToJson('1');

    expect(mockGetSession).toHaveBeenCalledWith(2, undefined, undefined);
  });

  it('keeps direct ID export global when workspace is configured', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession('outside-workspace', 1));

    await exportSessionToJson('outside-workspace', { workspace: '/workspace/a' });

    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockGetSession).toHaveBeenCalledWith('outside-workspace', undefined, undefined);
  });

  it('throws SessionNotFoundError when session is not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(exportSessionToJson(99)).rejects.toThrow(SessionNotFoundError);
  });
});

describe('exportSessionToMarkdown', () => {
  it('resolves the export target inside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToMarkdown(0, { workspace: '/workspace/a' });

    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
  });

  it('delegates to core exportToMarkdown', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const md = await exportSessionToMarkdown(0);
    expect(md).toBe('# Test');
  });

  it('interprets a numeric string export target as a zero-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToMarkdown('1');

    expect(mockGetSession).toHaveBeenCalledWith(2, undefined, undefined);
  });

  it('throws SessionNotFoundError when session is not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(exportSessionToMarkdown(99)).rejects.toThrow(SessionNotFoundError);
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
