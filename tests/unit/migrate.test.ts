import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage functions used by migrate
const mockFindWorkspaceForSession = vi.fn();
const mockFindWorkspaceByPath = vi.fn();
const mockOpenDatabaseReadWrite = vi.fn();
const mockGetComposerData = vi.fn();
const mockUpdateComposerData = vi.fn();

vi.mock('../../src/core/storage.js', () => ({
  findWorkspaceForSession: (...args: unknown[]) => mockFindWorkspaceForSession(...args),
  findWorkspaceByPath: (...args: unknown[]) => mockFindWorkspaceByPath(...args),
  openDatabaseReadWrite: (...args: unknown[]) => mockOpenDatabaseReadWrite(...args),
  getComposerData: (...args: unknown[]) => mockGetComposerData(...args),
  updateComposerData: (...args: unknown[]) => mockUpdateComposerData(...args),
}));

// Mock platform functions
vi.mock('../../src/lib/platform.js', () => ({
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
  vi.clearAllMocks();
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
  it('copy mode: transforms file paths in global storage', async () => {
    // Setup workspace mocks
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

    // Make existsSync return true for global storage path
    vi.mocked(existsSync).mockImplementation((p) => {
      return String(p).includes('globalStorage');
    });

    // Setup BetterSqlite3 mock with bubble data containing paths
    const composerDataValue = JSON.stringify({
      composerId: 'sid',
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
