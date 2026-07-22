import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Mock storage functions used by migrate
const mockFindWorkspaceForSession = vi.fn();
const mockFindWorkspaceByPath = vi.fn();
const mockOpenDatabaseReadWrite = vi.fn();
const mockGetComposerData = vi.fn();
const mockUpdateComposerData = vi.fn();
const mockGetWorkspaceLinkedComposerIds = vi.fn();

vi.mock('../../src/core/storage.js', () => ({
  findWorkspaceForSession: (...args: unknown[]) => mockFindWorkspaceForSession(...args),
  findWorkspaceByPath: (...args: unknown[]) => mockFindWorkspaceByPath(...args),
  openDatabaseReadWrite: (...args: unknown[]) => mockOpenDatabaseReadWrite(...args),
  getComposerData: (...args: unknown[]) => mockGetComposerData(...args),
  updateComposerData: (...args: unknown[]) => mockUpdateComposerData(...args),
  getWorkspaceLinkedComposerIds: (...args: unknown[]) => mockGetWorkspaceLinkedComposerIds(...args),
}));

// Mock platform functions
vi.mock('../../src/lib/platform.js', () => ({
  getGlobalStoragePath: (customDataPath?: string) =>
    customDataPath
      ? customDataPath.replace(/\/[^/]+$/, '/globalStorage')
      : '/default/globalStorage',
  normalizePath: (p: string) => p.replace(/\/+$/, ''),
  pathsEqual: (a: string, b: string) => a === b,
}));

// Mock node:fs for copyBubbleDataInGlobalStorage
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(() => false) };
});

// Mock better-sqlite3 (used directly by copy/move bubble functions)
vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
    close: vi.fn(),
  })),
}));

import { migrateSession, migrateSessions, migrateWorkspace } from '../../src/core/migrate.js';
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';

function createMockDb() {
  return {
    prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
    close: vi.fn(),
    runSQL: vi.fn(),
  };
}

beforeEach(() => {
  mockFindWorkspaceForSession.mockReset();
  mockFindWorkspaceByPath.mockReset();
  mockOpenDatabaseReadWrite.mockReset();
  mockGetComposerData.mockReset();
  mockUpdateComposerData.mockReset();
  mockGetWorkspaceLinkedComposerIds.mockReset();
  mockGetWorkspaceLinkedComposerIds.mockResolvedValue([]);
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(BetterSqlite3).mockReset();
  vi.mocked(BetterSqlite3).mockImplementation(function () {
    return {
      prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
      close: vi.fn(),
    } as any;
  } as any);
});

// =============================================================================
// migrateSession
// =============================================================================
describe('migrateSession', () => {
  it('throws SessionNotFoundError when session not found', async () => {
    mockFindWorkspaceForSession.mockResolvedValue(null);

    await expect(
      migrateSession('unknown-id', { destination: '/dest', mode: 'move', dryRun: false })
    ).rejects.toThrow('Session not found');
  });

  it('throws SameWorkspaceError when source equals destination', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/same', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });

    await expect(
      migrateSession('sid', { destination: '/same', mode: 'move', dryRun: false })
    ).rejects.toThrow('Source and destination are the same');
  });

  it('throws NestedPathError when destination is nested in source', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/parent', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });

    await expect(
      migrateSession('sid', { destination: '/parent/child', mode: 'move', dryRun: false })
    ).rejects.toThrow();
  });

  it('throws WorkspaceNotFoundError when destination not found', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue(null);

    await expect(
      migrateSession('sid', { destination: '/dest', mode: 'move', dryRun: false })
    ).rejects.toThrow('No workspace found');
  });

  it('returns dry run result without DB writes', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const result = await migrateSession('sid', {
      destination: '/dest',
      mode: 'move',
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.mode).toBe('move');
    expect(result.pathsWillBeUpdated).toBe(true);
    expect(mockOpenDatabaseReadWrite).not.toHaveBeenCalled();
  });

  it('move mode: removes from source, adds to destination', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [
          { composerId: 'sid', name: 'Session' },
          { composerId: 'other', name: 'Other' },
        ],
        isNewFormat: true,
        rawData: { selectedComposerIds: [] },
      })
      .mockReturnValueOnce({
        composers: [],
        isNewFormat: true,
        rawData: {},
      });

    const result = await migrateSession('sid', {
      destination: '/dest',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('move');
    // Source should be updated (session removed)
    expect(mockUpdateComposerData).toHaveBeenCalledTimes(2);
    // First call: source DB with session removed
    const sourceComposers = mockUpdateComposerData.mock.calls[0]![1] as unknown[];
    expect(sourceComposers).toHaveLength(1);
    expect((sourceComposers[0] as { composerId: string }).composerId).toBe('other');
    // Second call: dest DB with session added
    const destComposers = mockUpdateComposerData.mock.calls[1]![1] as unknown[];
    expect(destComposers).toHaveLength(1);
    expect((destComposers[0] as { composerId: string }).composerId).toBe('sid');
  });

  it('copy mode: generates new ID and keeps source intact', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid', name: 'Session' }],
        isNewFormat: true,
        rawData: {},
      })
      .mockReturnValueOnce({
        composers: [],
        isNewFormat: true,
        rawData: {},
      });

    const result = await migrateSession('sid', {
      destination: '/dest',
      mode: 'copy',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('copy');
    expect(result.newSessionId).toBeDefined();
    // Only dest DB should be updated (source untouched in copy mode)
    expect(mockUpdateComposerData).toHaveBeenCalledTimes(1);
  });

  it('move mode hydrates composer headers from global composerData', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid' }],
        isNewFormat: true,
        rawData: { selectedComposerIds: ['sid'] },
      })
      .mockReturnValueOnce({
        composers: [],
        isNewFormat: true,
        rawData: {},
      });

    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('globalStorage'));
    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn((sql: string) => ({
          get: vi.fn((...args: unknown[]) => {
            if (
              sql.includes('SELECT value FROM cursorDiskKV') &&
              String(args[0]).startsWith('composerData:')
            ) {
              return {
                value: JSON.stringify({
                  name: 'Hydrated Session',
                  createdAt: 1777583348738,
                  lastUpdatedAt: 1777584322685,
                }),
              };
            }
            return undefined;
          }),
          all: vi.fn(() => []),
          run: vi.fn(),
        })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateSession('sid', {
      destination: '/dest',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    const destComposers = mockUpdateComposerData.mock.calls[1]![1] as Array<
      Record<string, unknown>
    >;
    expect(destComposers[0]?.['name']).toBe('Hydrated Session');
    expect(destComposers[0]?.['createdAt']).toBe(1777583348738);
    expect(destComposers[0]?.['lastUpdatedAt']).toBe(1777584322685);
  });

  it('move mode migrates a session that exists only in global storage (not in source composers)', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({
      workspace: { id: 'dest-ws', path: '/dest', dbPath: '/db2', sessionCount: 0 },
      dbPath: '/db2',
    });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    // Source workspace composer list does NOT contain 'global-sid'.
    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'other' }],
        isNewFormat: true,
        rawData: { selectedComposerIds: ['other'] },
      })
      .mockReturnValueOnce({ composers: [], isNewFormat: true, rawData: {} });

    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('globalStorage'));
    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn((sql: string) => ({
          get: vi.fn((...args: unknown[]) => {
            const key = String(args[0]);
            if (sql.includes('SELECT 1 FROM cursorDiskKV') && key.startsWith('composerData:')) {
              return { 1: 1 };
            }
            if (sql.includes('SELECT value FROM cursorDiskKV') && key.startsWith('composerData:')) {
              return {
                value: JSON.stringify({ name: 'Global Only', createdAt: 1, lastUpdatedAt: 2 }),
              };
            }
            return undefined;
          }),
          all: vi.fn(() => []),
          run: vi.fn(),
        })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateSession('global-sid', {
      destination: '/dest',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    // Source has no composer entry to remove, so updateComposerData runs only for dest.
    expect(mockUpdateComposerData).toHaveBeenCalledTimes(1);
    const destComposers = mockUpdateComposerData.mock.calls[0]![1] as Array<
      Record<string, unknown>
    >;
    expect(destComposers[0]?.['composerId']).toBe('global-sid');
    expect(destComposers[0]?.['name']).toBe('Global Only');
  });

  it('returns failure result when DB operation throws', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });
    mockOpenDatabaseReadWrite.mockRejectedValue(new Error('DB locked'));

    const result = await migrateSession('sid', {
      destination: '/dest',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('DB locked');
  });
});

// =============================================================================
// migrateSessions
// =============================================================================
describe('migrateSessions', () => {
  it('migrates multiple sessions', async () => {
    // First session succeeds
    mockFindWorkspaceForSession
      .mockResolvedValueOnce({
        workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 2 },
        dbPath: '/db1',
      })
      .mockResolvedValueOnce(null); // Second session not found

    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const results = await migrateSessions({
      sessionIds: ['s1', 's2'],
      destination: '/dest',
      mode: 'move',
      dryRun: true,
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true); // dry run success
    expect(results[1]!.success).toBe(false); // not found → caught as failure
  });
});

// =============================================================================
// migrateWorkspace
// =============================================================================
describe('migrateWorkspace', () => {
  it('throws SameWorkspaceError when source equals destination', async () => {
    await expect(
      migrateWorkspace({
        source: '/same',
        destination: '/same',
        mode: 'move',
        dryRun: false,
      })
    ).rejects.toThrow('Source and destination are the same');
  });

  it('throws WorkspaceNotFoundError when source not found', async () => {
    mockFindWorkspaceByPath.mockResolvedValue(null);

    await expect(
      migrateWorkspace({
        source: '/source',
        destination: '/dest',
        mode: 'move',
        dryRun: false,
      })
    ).rejects.toThrow('No workspace found');
  });

  it('throws NoSessionsFoundError when source has no sessions', async () => {
    mockFindWorkspaceByPath
      .mockResolvedValueOnce({ dbPath: '/db1' })
      .mockResolvedValueOnce({ dbPath: '/db2' });
    const db = createMockDb();
    mockOpenDatabaseReadWrite.mockResolvedValue(db);
    mockGetComposerData.mockReturnValue(null);

    await expect(
      migrateWorkspace({
        source: '/source',
        destination: '/dest',
        mode: 'move',
        dryRun: false,
      })
    ).rejects.toThrow('No sessions found');
  });

  it('throws DestinationHasSessionsError when dest has sessions and force not set', async () => {
    mockFindWorkspaceByPath
      .mockResolvedValueOnce({ dbPath: '/db1' })
      .mockResolvedValueOnce({ dbPath: '/db2' });

    const db = createMockDb();
    mockOpenDatabaseReadWrite.mockResolvedValue(db);

    // Source has sessions
    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 's1' }],
        isNewFormat: true,
        rawData: {},
      })
      // Dest has sessions
      .mockReturnValueOnce({
        composers: [{ composerId: 'd1' }],
        isNewFormat: true,
        rawData: {},
      });

    await expect(
      migrateWorkspace({
        source: '/source',
        destination: '/dest',
        mode: 'move',
        dryRun: false,
        force: false,
      })
    ).rejects.toThrow('already has');
  });

  it('migrates all sessions in dry run mode', async () => {
    mockFindWorkspaceByPath
      .mockResolvedValueOnce({ dbPath: '/db1' }) // source lookup
      .mockResolvedValueOnce({ dbPath: '/db2' }); // dest lookup

    const db = createMockDb();
    mockOpenDatabaseReadWrite.mockResolvedValue(db);

    // Source has sessions (for migrateWorkspace check)
    mockGetComposerData.mockReturnValueOnce({
      composers: [{ composerId: 's1' }, { composerId: 's2' }],
      isNewFormat: true,
      rawData: {},
    });

    // Each migrateSession call in dry run needs source+dest lookup
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 2 },
      dbPath: '/db1',
    });
    // For the internal migrateSessions → migrateSession calls:
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const result = await migrateWorkspace({
      source: '/source',
      destination: '/dest',
      mode: 'move',
      dryRun: true,
    });

    expect(result.totalSessions).toBe(2);
    expect(result.source).toBe('/source');
    expect(result.destination).toBe('/dest');
    expect(result.dryRun).toBe(true);
  });

  it('does not silently filter bubble-less header-only sessions', async () => {
    mockFindWorkspaceByPath.mockImplementation(async (path: string) => {
      if (path === '/source') {
        return {
          workspace: { id: 'source-ws', path: '/source', dbPath: '/db1', sessionCount: 2 },
          dbPath: '/db1',
        };
      }
      return {
        workspace: { id: 'dest-ws', path: '/dest', dbPath: '/db2', sessionCount: 0 },
        dbPath: '/db2',
      };
    });

    const db = createMockDb();
    mockOpenDatabaseReadWrite.mockResolvedValue(db);
    mockGetComposerData.mockReturnValueOnce({
      composers: [{ composerId: 's1' }, { composerId: 's2' }],
      isNewFormat: true,
      rawData: { selectedComposerIds: ['s1', 's2'] },
    });

    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('globalStorage'));
    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn(() => ({
          get: vi.fn((pattern?: string) => ({
            count: String(pattern).includes('s1') ? 1 : 0,
          })),
          all: vi.fn(() => []),
          run: vi.fn(),
        })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateWorkspace({
      source: '/source',
      destination: '/dest',
      mode: 'move',
      dryRun: true,
      force: true,
    });

    expect(result.totalSessions).toBe(2);
    expect(result.results.map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });

  it('migrates sessions discoverable only via global storage (workspaceIdentifier-linked)', async () => {
    mockFindWorkspaceByPath.mockImplementation(async (path: string) => {
      if (path === '/source') {
        return {
          workspace: { id: 'source-ws', path: '/source', dbPath: '/db1', sessionCount: 1 },
          dbPath: '/db1',
        };
      }
      return {
        workspace: { id: 'dest-ws', path: '/dest', dbPath: '/db2', sessionCount: 0 },
        dbPath: '/db2',
      };
    });
    mockOpenDatabaseReadWrite.mockResolvedValue(createMockDb());
    mockGetComposerData.mockReturnValueOnce({
      composers: [{ composerId: 's1' }],
      isNewFormat: true,
      rawData: { selectedComposerIds: ['s1'] },
    });
    // Global storage links an extra session ('global-only-1') to the source workspace.
    mockGetWorkspaceLinkedComposerIds.mockResolvedValue(['s1', 'global-only-1']);

    const result = await migrateWorkspace({
      source: '/source',
      destination: '/dest',
      mode: 'move',
      dryRun: true,
      force: true,
    });

    expect(result.totalSessions).toBe(2);
    expect([...result.results.map((r) => r.sessionId)].sort()).toEqual(['global-only-1', 's1']);
  });

  it('throws NestedPathError for nested paths', async () => {
    await expect(
      migrateWorkspace({
        source: '/parent/project',
        destination: '/parent/project/subdir',
        mode: 'move',
        dryRun: false,
      })
    ).rejects.toThrow();
  });

  it('throws WorkspaceNotFoundError when destination workspace not found', async () => {
    mockFindWorkspaceByPath
      .mockResolvedValueOnce({ dbPath: '/db1' }) // source found
      .mockResolvedValueOnce(null); // dest not found

    await expect(
      migrateWorkspace({
        source: '/source',
        destination: '/dest',
        mode: 'move',
        dryRun: false,
      })
    ).rejects.toThrow('No workspace found');
  });
});

// =============================================================================
// Path transformation in global storage (copy mode)
// =============================================================================
describe('migrateSession - global storage path transformation (copy mode)', () => {
  it('copy mode: uses the sibling globalStorage for a custom dataPath', async () => {
    const expectedGlobalDbPath = join('/custom/globalStorage', 'state.vscdb');
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: {
        id: 'ws1',
        path: '/source/project',
        dbPath: '/custom/workspaceStorage/ws1/state.vscdb',
        sessionCount: 1,
      },
      dbPath: '/custom/workspaceStorage/ws1/state.vscdb',
    });
    mockFindWorkspaceByPath.mockResolvedValue({
      workspace: {
        id: 'dest-ws',
        path: '/dest/project',
        dbPath: '/custom/workspaceStorage/ws2/state.vscdb',
        sessionCount: 0,
      },
      dbPath: '/custom/workspaceStorage/ws2/state.vscdb',
    });

    mockOpenDatabaseReadWrite.mockResolvedValue(createMockDb());
    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid', name: 'Session' }],
        isNewFormat: true,
        rawData: {},
      })
      .mockReturnValueOnce({ composers: [], isNewFormat: true, rawData: {} });

    vi.mocked(existsSync).mockImplementation((p) => String(p) === expectedGlobalDbPath);

    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateSession('sid', {
      destination: '/dest/project',
      mode: 'copy',
      dryRun: false,
      dataPath: '/custom/workspaceStorage',
    });

    expect(result.success).toBe(true);
    const openedPaths = vi.mocked(BetterSqlite3).mock.calls.map((call) => String(call[0]));
    expect(openedPaths.length).toBeGreaterThan(0);
    expect(openedPaths.every((path) => path === expectedGlobalDbPath)).toBe(true);
  });

  it('copy mode: transforms file paths in global storage', async () => {
    // Setup workspace mocks
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source/project', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({
      workspace: { id: 'dest-ws', path: '/dest/project', dbPath: '/db2', sessionCount: 0 },
      dbPath: '/db2',
    });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid', name: 'Session' }],
        isNewFormat: true,
        rawData: {},
      })
      .mockReturnValueOnce({
        composers: [],
        isNewFormat: true,
        rawData: {},
      });

    // Make existsSync return true for global storage path
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).includes('globalStorage');
    });

    // Setup BetterSqlite3 mock with bubble data containing paths
    const composerDataValue = JSON.stringify({
      composerId: 'sid',
      workspaceIdentifier: {
        id: 'source-ws',
        uri: {
          fsPath: '/source/project',
          external: 'file:///source/project',
          path: '/source/project',
          scheme: 'file',
        },
      },
      fullConversationHeadersOnly: [
        { bubbleId: 'b1', type: 2 },
        { bubbleId: 'b2', type: 1 },
      ],
    });

    const bubbleWithPaths = JSON.stringify({
      bubbleId: 'b1',
      type: 2,
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ targetFile: '/source/project/src/main.ts' }),
      },
      codeBlocks: [
        {
          uri: {
            path: '/source/project/src/main.ts',
            _fsPath: '/source/project/src/main.ts',
            _formatted: 'file:///source/project/src/main.ts',
          },
        },
      ],
    });

    const mockRun = vi.fn();

    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn((sql: string) => ({
          get: vi.fn((...args: unknown[]) => {
            if (
              sql.includes('SELECT value FROM cursorDiskKV') &&
              String(args[0]).startsWith('composerData:')
            ) {
              return { value: composerDataValue };
            }
            return undefined;
          }),
          all: vi.fn((...args: unknown[]) => {
            if (
              sql.includes('SELECT key, value FROM cursorDiskKV') &&
              String(args[0]).includes('bubbleId:')
            ) {
              return [{ key: 'bubbleId:sid:b1', value: bubbleWithPaths }];
            }
            return [];
          }),
          run: mockRun,
        })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateSession('sid', {
      destination: '/dest/project',
      mode: 'copy',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('copy');
    // Verify BetterSqlite3 was instantiated (for global storage operations)
    expect(BetterSqlite3).toHaveBeenCalled();
    // Verify INSERT was called (for composerData + bubble copy)
    expect(mockRun).toHaveBeenCalled();

    // Check that the run calls include transformed paths
    const insertCalls = mockRun.mock.calls;
    // There should be at least 2 INSERT calls (composerData + bubble)
    expect(insertCalls.length).toBeGreaterThanOrEqual(2);

    const composerInsertCall = insertCalls.find((call: unknown[]) => {
      return String(call[0] || '').startsWith('composerData:');
    });
    expect(composerInsertCall).toBeDefined();
    const insertedComposer = JSON.parse(String(composerInsertCall![1]));
    const expectedDestinationUri = pathToFileURL('/dest/project').href;
    expect(insertedComposer.workspaceUri).toBe(expectedDestinationUri);
    expect(insertedComposer.workspaceIdentifier.id).toBe('dest-ws');
    expect(insertedComposer.workspaceIdentifier.uri.fsPath).toBe('/dest/project');
    expect(insertedComposer.workspaceIdentifier.uri.external).toBe(expectedDestinationUri);

    // Check bubble insert has transformed paths
    // run() is called as run(key, value) - find the call where key starts with 'bubbleId:'
    const bubbleInsertCall = insertCalls.find((call: unknown[]) => {
      return String(call[0] || '').startsWith('bubbleId:');
    });
    expect(bubbleInsertCall).toBeDefined();
    const insertedValue = JSON.parse(String(bubbleInsertCall![1]));
    // toolFormerData.params should have transformed path
    const params = JSON.parse(insertedValue.toolFormerData.params);
    expect(params.targetFile).toBe('/dest/project/src/main.ts');
    // codeBlocks uri should have transformed paths
    expect(insertedValue.codeBlocks[0].uri.path).toBe('/dest/project/src/main.ts');
    expect(insertedValue.codeBlocks[0].uri._fsPath).toBe('/dest/project/src/main.ts');
    expect(insertedValue.codeBlocks[0].uri._formatted).toBe('file:///dest/project/src/main.ts');
  });

  it('copy mode: preserves external paths (outside source workspace)', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source/project', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid', name: 'Session' }],
        isNewFormat: true,
        rawData: {},
      })
      .mockReturnValueOnce({
        composers: [],
        isNewFormat: true,
        rawData: {},
      });

    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).includes('globalStorage');
    });

    // Bubble has paths OUTSIDE the source workspace - should NOT be transformed
    const composerDataValue = JSON.stringify({
      composerId: 'sid',
      fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 2 }],
    });

    const bubbleWithExternalPaths = JSON.stringify({
      bubbleId: 'b1',
      type: 2,
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ targetFile: '/other/project/src/lib.ts' }),
      },
      codeBlocks: [
        {
          uri: {
            path: '/other/project/src/lib.ts',
            _fsPath: '/other/project/src/lib.ts',
            _formatted: 'file:///other/project/src/lib.ts',
          },
        },
      ],
    });

    const mockRun = vi.fn();

    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn((sql: string) => ({
          get: vi.fn((...args: unknown[]) => {
            if (
              sql.includes('SELECT value FROM cursorDiskKV') &&
              String(args[0]).startsWith('composerData:')
            ) {
              return { value: composerDataValue };
            }
            return undefined;
          }),
          all: vi.fn((...args: unknown[]) => {
            if (
              sql.includes('SELECT key, value FROM cursorDiskKV') &&
              String(args[0]).includes('bubbleId:')
            ) {
              return [{ key: 'bubbleId:sid:b1', value: bubbleWithExternalPaths }];
            }
            return [];
          }),
          run: mockRun,
        })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateSession('sid', {
      destination: '/dest/project',
      mode: 'copy',
      dryRun: false,
    });

    expect(result.success).toBe(true);

    // Find the bubble INSERT call (key starts with 'bubbleId:')
    const bubbleInsertCall = mockRun.mock.calls.find((call: unknown[]) => {
      return String(call[0] || '').startsWith('bubbleId:');
    });
    expect(bubbleInsertCall).toBeDefined();
    const insertedValue = JSON.parse(String(bubbleInsertCall![1]));
    // External paths should be preserved (NOT transformed)
    const params = JSON.parse(insertedValue.toolFormerData.params);
    expect(params.targetFile).toBe('/other/project/src/lib.ts');
    expect(insertedValue.codeBlocks[0].uri.path).toBe('/other/project/src/lib.ts');
    expect(insertedValue.codeBlocks[0].uri._fsPath).toBe('/other/project/src/lib.ts');
    expect(insertedValue.codeBlocks[0].uri._formatted).toBe('file:///other/project/src/lib.ts');
  });
});

// =============================================================================
// Path transformation in global storage (move mode)
// =============================================================================
describe('migrateSession - global storage path transformation (move mode)', () => {
  it('move mode: transforms file paths in global storage via UPDATE', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source/project', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid', name: 'Session' }],
        isNewFormat: true,
        rawData: { selectedComposerIds: [] },
      })
      .mockReturnValueOnce({
        composers: [],
        isNewFormat: true,
        rawData: {},
      });

    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).includes('globalStorage');
    });

    const bubbleWithPaths = JSON.stringify({
      bubbleId: 'b1',
      type: 2,
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ targetFile: '/source/project/src/app.ts' }),
      },
      codeBlocks: [
        {
          uri: {
            path: '/source/project/src/app.ts',
            _fsPath: '/source/project/src/app.ts',
            _formatted: 'file:///source/project/src/app.ts',
          },
        },
      ],
    });

    const mockRun = vi.fn();

    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn((sql: string) => ({
          get: vi.fn(),
          all: vi.fn((..._args: unknown[]) => {
            if (sql.includes('SELECT key, value FROM cursorDiskKV')) {
              return [{ key: 'bubbleId:sid:b1', value: bubbleWithPaths }];
            }
            return [];
          }),
          run: mockRun,
        })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateSession('sid', {
      destination: '/dest/project',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('move');
    expect(BetterSqlite3).toHaveBeenCalled();
    // For move mode, UPDATE should be called (not INSERT)
    expect(mockRun).toHaveBeenCalled();

    // Check that the UPDATE call has transformed paths
    // UPDATE statement: run(value, key) - so call[1] is the key, call[0] is the JSON value
    const updateCall = mockRun.mock.calls.find((call: unknown[]) => {
      return String(call[1] || '').startsWith('bubbleId:');
    });
    expect(updateCall).toBeDefined();
    const updatedValue = JSON.parse(String(updateCall![0]));
    const params = JSON.parse(updatedValue.toolFormerData.params);
    expect(params.targetFile).toBe('/dest/project/src/app.ts');
    expect(updatedValue.codeBlocks[0].uri.path).toBe('/dest/project/src/app.ts');
    expect(updatedValue.codeBlocks[0].uri._fsPath).toBe('/dest/project/src/app.ts');
    expect(updatedValue.codeBlocks[0].uri._formatted).toBe('file:///dest/project/src/app.ts');
  });

  it('move mode: updates global composerData workspaceUri to destination', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source/project', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({
      workspace: { id: 'dest-ws', path: '/dest/project', dbPath: '/db2', sessionCount: 0 },
      dbPath: '/db2',
    });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid', name: 'Session' }],
        isNewFormat: true,
        rawData: { selectedComposerIds: [] },
      })
      .mockReturnValueOnce({
        composers: [],
        isNewFormat: true,
        rawData: {},
      });

    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).includes('globalStorage');
    });

    const composerDataValue = JSON.stringify({
      composerId: 'sid',
      workspaceUri: 'file:///source/project',
      workspaceIdentifier: {
        id: 'source-ws',
        uri: {
          fsPath: '/source/project',
          external: 'file:///source/project',
          path: '/source/project',
          scheme: 'file',
        },
      },
      fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 2 }],
    });
    const bubbleWithPaths = JSON.stringify({
      bubbleId: 'b1',
      type: 2,
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ targetFile: '/source/project/src/app.ts' }),
      },
    });

    const mockRun = vi.fn();
    vi.mocked(BetterSqlite3).mockImplementation(function () {
      return {
        prepare: vi.fn((sql: string) => ({
          get: vi.fn((...args: unknown[]) => {
            if (
              sql.includes('SELECT value FROM cursorDiskKV') &&
              String(args[0]).startsWith('composerData:')
            ) {
              return { value: composerDataValue };
            }
            return undefined;
          }),
          all: vi.fn((..._args: unknown[]) => {
            if (sql.includes('SELECT key, value FROM cursorDiskKV')) {
              return [{ key: 'bubbleId:sid:b1', value: bubbleWithPaths }];
            }
            return [];
          }),
          run: mockRun,
        })),
        close: vi.fn(),
      } as any;
    } as any);

    const result = await migrateSession('sid', {
      destination: '/dest/project',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    const composerUpdateCall = mockRun.mock.calls.find((call: unknown[]) => {
      return String(call[1] || '') === 'composerData:sid';
    });
    expect(composerUpdateCall).toBeDefined();
    const updatedComposer = JSON.parse(String(composerUpdateCall![0]));
    const expectedDestinationUri = pathToFileURL('/dest/project').href;
    expect(updatedComposer.workspaceUri).toBe(expectedDestinationUri);
    expect(updatedComposer.workspaceIdentifier.id).toBe('dest-ws');
    expect(updatedComposer.workspaceIdentifier.uri.fsPath).toBe('/dest/project');
    expect(updatedComposer.workspaceIdentifier.uri.external).toBe(expectedDestinationUri);
  });
});

// =============================================================================
// Edge cases for migrateSession
// =============================================================================
describe('migrateSession - edge cases', () => {
  it('move mode: returns failure when source has null composer data', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    // Source returns null composer data
    mockGetComposerData.mockReturnValueOnce(null);

    const result = await migrateSession('sid', {
      destination: '/dest',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('no composer data');
  });

  it('move mode: handles destination with null composer data', async () => {
    mockFindWorkspaceForSession.mockResolvedValue({
      workspace: { id: 'ws1', path: '/source', dbPath: '/db1', sessionCount: 1 },
      dbPath: '/db1',
    });
    mockFindWorkspaceByPath.mockResolvedValue({ dbPath: '/db2' });

    const sourceDb = createMockDb();
    const destDb = createMockDb();
    let callCount = 0;
    mockOpenDatabaseReadWrite.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? sourceDb : destDb;
    });

    // Reset existsSync to return false (skip global storage)
    vi.mocked(existsSync).mockReturnValue(false);

    mockGetComposerData
      .mockReturnValueOnce({
        composers: [{ composerId: 'sid', name: 'Session' }],
        isNewFormat: true,
        rawData: { selectedComposerIds: [] },
      })
      // Destination returns null (no existing composer data)
      .mockReturnValueOnce(null);

    const result = await migrateSession('sid', {
      destination: '/dest',
      mode: 'move',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('move');
    // updateComposerData should be called twice
    expect(mockUpdateComposerData).toHaveBeenCalledTimes(2);
    // Dest call should have the session added to empty array
    const destComposers = mockUpdateComposerData.mock.calls[1]![1] as unknown[];
    expect(destComposers).toHaveLength(1);
    expect((destComposers[0] as { composerId: string }).composerId).toBe('sid');
  });
});
