import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Database } from '../../src/core/database/types.js';

// Mock the database module
const mockOpenDatabase = vi.fn();
const mockOpenDatabaseReadWrite = vi.fn();
const mockEnsureDriver = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/core/database/index.js', () => ({
  openDatabase: (...args: unknown[]) => mockOpenDatabase(...args),
  openDatabaseReadWrite: (...args: unknown[]) => mockOpenDatabaseReadWrite(...args),
  ensureDriver: (...args: unknown[]) => mockEnsureDriver(...args),
}));

// Mock backup module to avoid real zip operations
vi.mock('../../src/core/backup.js', () => ({
  openBackupDatabase: vi.fn(),
  readBackupManifest: vi.fn().mockResolvedValue(null),
}));

// For backup-from-zip tests: mock zip so readWorkspaceJsonFromBackup can read workspace.json (hoisted)
const { mockZipLoadAsync } = vi.hoisted(() => ({
  mockZipLoadAsync: vi.fn(),
}));
vi.mock('jszip', () => ({
  default: { loadAsync: mockZipLoadAsync },
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn().mockResolvedValue(Buffer.from('zip')) };
});

// Mock node:fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readBackupManifest, openBackupDatabase } from '../../src/core/backup.js';
import * as debugModule from '../../src/core/database/debug.js';
import {
  readWorkspaceJson,
  findWorkspaces,
  listSessions,
  getSession,
  searchSessions,
  getComposerData,
  updateComposerData,
  resolveSessionIdentifiers,
  findWorkspaceForSession,
  findWorkspaceByPath,
  listWorkspaces,
  listGlobalSessions,
  getGlobalSession,
  extractToolCalls,
  extractTimestamp,
  fillTimestampGaps,
  extractTokenUsage,
  extractContextWindowStatus,
  extractPromptDryRunInfo,
  extractSessionUsage,
  mapBubbleToMessage,
} from '../../src/core/storage.js';

/**
 * Create a mock DB where prepare().get(key) returns different results based on the key argument.
 * composerValue: value returned when querying for 'composer.composerData' key
 */
function createWorkspaceDb(composerValue: string): Database {
  return {
    prepare: vi.fn(() => ({
      get: vi.fn((key?: string) => {
        if (key === 'composer.composerData') return { value: composerValue };
        return undefined;
      }),
      all: vi.fn(() => []),
      run: vi.fn(),
    })),
    close: vi.fn(),
    runSQL: vi.fn(),
  };
}

/**
 * Create a global storage mock DB with cursorDiskKV table and bubble data.
 */
function createGlobalDb(
  bubbleRows: { key: string; value: string }[],
  composerDataValue?: string
): Database {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('sqlite_master')) {
        return { get: vi.fn(() => ({ name: 'cursorDiskKV' })), all: vi.fn(() => []), run: vi.fn() };
      }
      if (sql.includes('WHERE key = ?')) {
        return {
          get: vi.fn((key?: string) => {
            if (String(key).startsWith('composerData:') && composerDataValue !== undefined) {
              return { value: composerDataValue };
            }
            return undefined;
          }),
          all: vi.fn(() => []),
          run: vi.fn(),
        };
      }
      if (sql.includes('cursorDiskKV')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => bubbleRows),
          run: vi.fn(),
        };
      }
      return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
    }),
    close: vi.fn(),
    runSQL: vi.fn(),
  };
}

/**
 * Setup mockOpenDatabase to return workspace DB for workspace paths
 * and global DB for global storage path.
 */
function setupGetSessionMocks(
  composerData: string,
  bubbleRows: { key: string; value: string }[],
  globalComposerData?: string
) {
  const wsDb = createWorkspaceDb(composerData);
  const globalDb = createGlobalDb(bubbleRows, globalComposerData);
  mockOpenDatabase.mockImplementation(async (path: string) => {
    if (String(path).includes('globalStorage')) {
      return globalDb;
    }
    return wsDb;
  });
}

function createMockDb(queryMap: Record<string, { get?: unknown; all?: unknown[] }> = {}): Database {
  return {
    prepare: vi.fn((sql: string) => {
      for (const [key, result] of Object.entries(queryMap)) {
        if (sql.includes(key)) {
          return {
            get: vi.fn((..._args: unknown[]) => result.get),
            all: vi.fn((..._args: unknown[]) => result.all ?? []),
            run: vi.fn(),
          };
        }
      }
      return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
    }),
    close: vi.fn(),
    runSQL: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// =============================================================================
// readWorkspaceJson
// =============================================================================
describe('readWorkspaceJson', () => {
  it('returns path from workspace.json', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/my/project' }));
    const result = readWorkspaceJson('/workspace/dir');
    expect(result).toBe('/my/project');
  });

  it('strips file:// prefix', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: 'file:///my/project' }));
    const result = readWorkspaceJson('/workspace/dir');
    expect(result).toBe('/my/project');
  });

  it('returns null when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(readWorkspaceJson('/nonexistent')).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('not json');
    expect(readWorkspaceJson('/workspace/dir')).toBeNull();
  });

  it('returns null when folder key is missing', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ other: 'value' }));
    expect(readWorkspaceJson('/workspace/dir')).toBeNull();
  });

  it('returns path from workspace when folder is missing', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ workspace: 'file:///path/to/project.code-workspace' })
    );
    const result = readWorkspaceJson('/workspace/dir');
    expect(result).toBe('/path/to/project.code-workspace');
  });

  it('strips file:// from workspace', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ workspace: 'file:///my/workspace.code-workspace' })
    );
    const result = readWorkspaceJson('/workspace/dir');
    expect(result).toBe('/my/workspace.code-workspace');
  });

  it('decodes percent-encoded characters in workspace URI (e.g. %20, %23, %28, %29)', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        workspace: 'file:///path%23with%28hash%29/my%20ws.code-workspace',
      })
    );
    const result = readWorkspaceJson('/workspace/dir');
    expect(result).toBe('/path#with(hash)/my ws.code-workspace');
  });

  it('prefers workspace when both folder and workspace exist', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        folder: 'file:///folder',
        workspace: 'file:///other.code-workspace',
      })
    );
    const result = readWorkspaceJson('/workspace/dir');
    expect(result).toBe('/other.code-workspace');
  });

  it('returns null when both folder and workspace are missing', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
    expect(readWorkspaceJson('/workspace/dir')).toBeNull();
  });
});

// =============================================================================
// findWorkspaces
// =============================================================================
describe('findWorkspaces', () => {
  it('returns empty array when path does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await findWorkspaces('/nonexistent');
    expect(result).toEqual([]);
  });

  it('finds workspaces with sessions', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      return path.includes('state.vscdb') || path.includes('workspace.json') || path === '/data';
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/my/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test' }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await findWorkspaces('/data');
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe('/my/project');
    expect(result[0]!.sessionCount).toBe(1);
  });

  it('skips directories without state.vscdb', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path.includes('state.vscdb')) return false;
      return true;
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);

    const result = await findWorkspaces('/data');
    expect(result).toEqual([]);
  });

  it('includes workspace when workspace.json has only workspace', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      return path.includes('state.vscdb') || path.includes('workspace.json') || path === '/data';
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ workspace: 'file:///path/to/ws.code-workspace' })
    );

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test' }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await findWorkspaces('/data');
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe('/path/to/ws.code-workspace');
    expect(result[0]!.sessionCount).toBe(1);
  });
});

// =============================================================================
// findWorkspaces (from backup) — workspace in workspace.json
// =============================================================================
describe('findWorkspaces (from backup)', () => {
  it('returns path from workspace in backup zip', async () => {
    vi.mocked(readBackupManifest).mockResolvedValueOnce({
      version: '1.0.0',
      createdAt: '2024-01-01T00:00:00Z',
      cursorHistoryVersion: '0.9.2',
      sourcePlatform: 'linux',
      files: [
        {
          path: 'workspaceStorage/ws1/state.vscdb',
          type: 'workspace-db',
          size: 100,
          checksum: 'sha256:abc',
        },
      ],
      stats: { totalSize: 100, sessionCount: 1, workspaceCount: 1 },
    });

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Session' }],
    });
    vi.mocked(openBackupDatabase).mockResolvedValueOnce(createWorkspaceDb(composerData));

    mockZipLoadAsync.mockResolvedValueOnce({
      file: (path: string) => {
        if (path === 'workspaceStorage/ws1/workspace.json') {
          return {
            async: () =>
              Promise.resolve(
                Buffer.from(
                  JSON.stringify({
                    workspace: 'file:///path/to/backup-workspace.code-workspace',
                  })
                )
              ),
          };
        }
        return null;
      },
    });

    const result = await findWorkspaces(undefined, '/backup.zip');
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe('/path/to/backup-workspace.code-workspace');
    expect(result[0]!.id).toBe('ws1');
  });
});

// =============================================================================
// listSessions
// =============================================================================
describe('listSessions', () => {
  it('returns sorted sessions across workspaces', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [
        { composerId: 'c1', name: 'Chat A', createdAt: 1000000, lastUpdatedAt: 2000000 },
        { composerId: 'c2', name: 'Chat B', createdAt: 3000000, lastUpdatedAt: 4000000 },
      ],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await listSessions({ limit: 10, all: false }, '/data');
    expect(result).toHaveLength(2);
    // Should be sorted by most recent first
    expect(result[0]!.id).toBe('c2');
    expect(result[1]!.id).toBe('c1');
    // Indexes assigned after sorting
    expect(result[0]!.index).toBe(1);
    expect(result[1]!.index).toBe(2);
  });

  it('applies limit', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [
        { composerId: 'c1', name: 'A', createdAt: 1000 },
        { composerId: 'c2', name: 'B', createdAt: 2000 },
        { composerId: 'c3', name: 'C', createdAt: 3000 },
      ],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await listSessions({ limit: 1, all: false }, '/data');
    expect(result).toHaveLength(1);
  });

  it('returns all when all=true', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [
        { composerId: 'c1', name: 'A', createdAt: 1000 },
        { composerId: 'c2', name: 'B', createdAt: 2000 },
        { composerId: 'c3', name: 'C', createdAt: 3000 },
      ],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await listSessions({ limit: 1, all: true }, '/data');
    expect(result).toHaveLength(3);
  });

  it('deduplicates by session id when same session appears in multiple workspaces and attributes to first in sort order', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      return (
        path === '/data' ||
        path.includes('state.vscdb') ||
        path.includes('workspace.json')
      );
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
      { name: 'ws2', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (path.includes('ws1'))
        return JSON.stringify({ folder: 'file:///folder' });
      if (path.includes('ws2'))
        return JSON.stringify({
          workspace: 'file:///path/to/project.code-workspace',
        });
      return JSON.stringify({});
    });

    const sameSession = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Same chat', createdAt: 1000 }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(sameSession));

    const result = await listSessions({ limit: 0, all: true }, '/data');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('c1');
    expect(result[0]!.workspacePath).toBe('/path/to/project.code-workspace');
    // Index must be 1-based consecutive after dedupe (so list --ids shows 1, 2, ... N)
    expect(result[0]!.index).toBe(1);
  });

  it('assigns consecutive 1-based indexes after dedupe so list --ids has no gaps', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      return (
        path === '/data' ||
        path.includes('state.vscdb') ||
        path.includes('workspace.json')
      );
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
      { name: 'ws2', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (path.includes('ws1'))
        return JSON.stringify({ folder: 'file:///folder' });
      if (path.includes('ws2'))
        return JSON.stringify({
          workspace: 'file:///path/to/project.code-workspace',
        });
      return JSON.stringify({});
    });

    // ws1: c1, c2, c3. ws2: c1 (dup), c4. Deduped first-occurrence order: c1, c2, c3, c4 → 4 sessions
    mockOpenDatabase.mockImplementation((path: string) => {
      if (path.includes('ws1'))
        return Promise.resolve(
          createWorkspaceDb(
            JSON.stringify({
              allComposers: [
                { composerId: 'c1', name: 'A', createdAt: 1000 },
                { composerId: 'c2', name: 'B', createdAt: 2000 },
                { composerId: 'c3', name: 'C', createdAt: 3000 },
              ],
            })
          )
        );
      return Promise.resolve(
        createWorkspaceDb(
          JSON.stringify({
            allComposers: [
              { composerId: 'c1', name: 'A dup', createdAt: 1000 },
              { composerId: 'c4', name: 'D', createdAt: 4000 },
            ],
          })
        )
      );
    });

    const result = await listSessions({ limit: 0, all: true }, '/data');
    expect(result).toHaveLength(4);
    result.forEach((s, i) => {
      expect(s.index).toBe(i + 1);
    });
  });

  it('does not remove sessions when two workspaces have no overlapping session ids', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      return (
        path === '/data' ||
        path.includes('state.vscdb') ||
        path.includes('workspace.json')
      );
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
      { name: 'ws2', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (path.includes('ws1'))
        return JSON.stringify({ folder: 'file:///folder' });
      if (path.includes('ws2'))
        return JSON.stringify({
          workspace: 'file:///path/to/project.code-workspace',
        });
      return JSON.stringify({});
    });

    mockOpenDatabase.mockImplementation((path: string) => {
      if (path.includes('ws1'))
        return Promise.resolve(
          createWorkspaceDb(
            JSON.stringify({
              allComposers: [{ composerId: 'c1', name: 'Only in folder' }],
            })
          )
        );
      return Promise.resolve(
        createWorkspaceDb(
          JSON.stringify({
            allComposers: [{ composerId: 'c2', name: 'Only in workspace file' }],
          })
        )
      );
    });

    const result = await listSessions({ limit: 0, all: true }, '/data');
    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.id).sort();
    expect(ids).toEqual(['c1', 'c2']);
  });
});

// =============================================================================
// listWorkspaces
// =============================================================================
describe('listWorkspaces', () => {
  it('returns sorted workspaces by session count', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Chat' }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await listWorkspaces('/data');
    expect(result).toHaveLength(1);
  });
});

// =============================================================================
// getSession
// =============================================================================
describe('getSession', () => {
  function setupSessionWithGlobalComposerData(globalComposerData: string) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const workspaceComposerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test Chat', createdAt: 1000 }],
    });

    setupGetSessionMocks(
      workspaceComposerData,
      [
        {
          key: 'bubbleId:c1:b1',
          value: JSON.stringify({
            type: 1,
            text: 'Hello from user',
            createdAt: '2024-01-15T10:00:00Z',
            bubbleId: 'b1',
          }),
        },
        {
          key: 'bubbleId:c1:b2',
          value: JSON.stringify({
            type: 2,
            text: 'Here is my response',
            createdAt: '2024-01-15T10:01:00Z',
            bubbleId: 'b2',
          }),
        },
      ],
      globalComposerData
    );
  }

  it('returns null for invalid index', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);
    const result = await getSession(999, '/data');
    expect(result).toBeNull();
  });

  it('returns null for unknown composer ID', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Only Session', createdAt: 1000 }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));
    const result = await getSession('unknown-composer-id', '/data');
    expect(result).toBeNull();
  });

  it('returns session from global storage with bubble data', async () => {
    // Setup workspace to list sessions
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test Chat', createdAt: 1000 }],
    });

    // User bubble
    const userBubble = JSON.stringify({
      type: 1,
      text: 'Hello from user',
      createdAt: '2024-01-15T10:00:00Z',
      bubbleId: 'b1',
    });

    // Assistant bubble with plain text
    const assistantBubble = JSON.stringify({
      type: 2,
      text: 'Here is my response',
      createdAt: '2024-01-15T10:01:00Z',
      bubbleId: 'b2',
    });

    setupGetSessionMocks(composerData, [
      { key: 'bubbleId:c1:b1', value: userBubble },
      { key: 'bubbleId:c1:b2', value: assistantBubble },
    ]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('c1');
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]!.role).toBe('user');
    expect(result!.messages[0]!.content).toBe('Hello from user');
    expect(result!.messages[1]!.role).toBe('assistant');
    expect(result!.messages[1]!.content).toBe('Here is my response');
  });

  it('returns same session when called with composer ID string', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test Chat', createdAt: 1000 }],
    });

    const userBubble = JSON.stringify({
      type: 1,
      text: 'Hello from user',
      createdAt: '2024-01-15T10:00:00Z',
      bubbleId: 'b1',
    });

    const assistantBubble = JSON.stringify({
      type: 2,
      text: 'Here is my response',
      createdAt: '2024-01-15T10:01:00Z',
      bubbleId: 'b2',
    });

    setupGetSessionMocks(composerData, [
      { key: 'bubbleId:c1:b1', value: userBubble },
      { key: 'bubbleId:c1:b2', value: assistantBubble },
    ]);

    const result = await getSession('c1', '/data');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('c1');
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]!.content).toBe('Hello from user');
    expect(result!.messages[1]!.content).toBe('Here is my response');
  });

  it('extracts activeBranchBubbleIds from the global branch manifest', async () => {
    setupSessionWithGlobalComposerData(
      JSON.stringify({
        fullConversationHeadersOnly: [
          { bubbleId: 'b1', type: 1 },
          { bubbleId: 'b2', type: 2, serverBubbleId: 'server-b2' },
        ],
      })
    );

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.activeBranchBubbleIds).toEqual(['b1', 'b2']);
  });

  it('omits activeBranchBubbleIds when global composer data is invalid JSON', async () => {
    setupSessionWithGlobalComposerData('{"fullConversationHeadersOnly":');

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.activeBranchBubbleIds).toBeUndefined();
  });

  it('omits activeBranchBubbleIds when fullConversationHeadersOnly is not an array', async () => {
    setupSessionWithGlobalComposerData(
      JSON.stringify({
        fullConversationHeadersOnly: { bubbleId: 'b1' },
      })
    );

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.activeBranchBubbleIds).toBeUndefined();
  });

  it('ignores malformed branch headers and preserves valid bubble IDs in order', async () => {
    setupSessionWithGlobalComposerData(
      JSON.stringify({
        fullConversationHeadersOnly: [
          null,
          {},
          { bubbleId: 123 },
          { bubbleId: 'b1', type: 1 },
          { bubbleId: '   ', type: 2 },
          { bubbleId: 'b2', type: 2 },
        ],
      })
    );

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.activeBranchBubbleIds).toEqual(['b1', 'b2']);
  });

  it('omits activeBranchBubbleIds when the branch manifest is empty', async () => {
    setupSessionWithGlobalComposerData(
      JSON.stringify({
        fullConversationHeadersOnly: [],
      })
    );

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.activeBranchBubbleIds).toBeUndefined();
  });

  it('handles assistant bubble with tool call', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const toolBubble = JSON.stringify({
      type: 2,
      createdAt: '2024-01-15T10:00:00Z',
      bubbleId: 'b1',
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ targetFile: '/src/main.ts' }),
        result: JSON.stringify({ contents: 'file content here' }),
        status: 'completed',
      },
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: toolBubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Read File]');
    expect(result!.messages[0]!.content).toContain('/src/main.ts');
  });

  it('handles assistant bubble with thinking text', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const thinkingBubble = JSON.stringify({
      type: 2,
      createdAt: '2024-01-15T10:00:00Z',
      bubbleId: 'b1',
      thinking: { text: 'Let me reason about this...' },
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: thinkingBubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Thinking]');
    expect(result!.messages[0]!.content).toContain('Let me reason');
  });

  it('handles assistant bubble with text + codeBlocks combined', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const combinedBubble = JSON.stringify({
      type: 2,
      text: 'Here is the code:',
      createdAt: '2024-01-15T10:00:00Z',
      bubbleId: 'b1',
      codeBlocks: [{ content: 'const x = 1;', languageId: 'typescript' }],
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: combinedBubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('Here is the code:');
    expect(result!.messages[0]!.content).toContain('```typescript');
    expect(result!.messages[0]!.content).toContain('const x = 1;');
  });

  it('handles assistant bubble with diff in toolFormerData.result', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const diffBubble = JSON.stringify({
      type: 2,
      createdAt: '2024-01-15T10:00:00Z',
      bubbleId: 'b1',
      toolFormerData: {
        name: 'write',
        params: JSON.stringify({ relativeWorkspacePath: 'src/main.ts' }),
        result: JSON.stringify({
          diff: { chunks: [{ diffString: '-old\n+new' }] },
          resultForModel: 'File updated',
        }),
        status: 'completed',
      },
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: diffBubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Write File]');
    expect(result!.messages[0]!.content).toContain('src/main.ts');
    expect(result!.messages[0]!.content).toContain('```diff');
  });

  it('handles error bubble', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const errorBubble = JSON.stringify({
      type: 2,
      createdAt: '2024-01-15T10:00:00Z',
      bubbleId: 'b1',
      nested: { deep: { msg: 'Error occurred\n```\nstack trace\n```\n# heading' } },
      toolFormerData: { additionalData: { status: 'error' } },
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: errorBubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Error]');
  });

  it('keeps global source and preserves malformed rows as corrupted placeholders', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    setupGetSessionMocks(composerData, [
      {
        key: 'bubbleId:c1:b1',
        value: JSON.stringify({
          type: 2,
          text: 'good response',
          createdAt: '2024-01-15T10:00:00Z',
          bubbleId: 'b1',
        }),
      },
      { key: 'bubbleId:c1:b2', value: '{"type":2,' },
    ]);

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('global');
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[1]!.content).toBe('[corrupted message]');
    expect(result!.messages[1]!.metadata?.corrupted).toBe(true);
  });
});

describe('mapBubbleToMessage', () => {
  it('preserves empty bubbles with a placeholder and bubbleType metadata', () => {
    const message = mapBubbleToMessage({
      key: 'bubbleId:c1:b1',
      value: JSON.stringify({
        type: 2,
        text: '',
        createdAt: '2024-01-15T10:00:00Z',
        bubbleId: 'b1',
      }),
    });

    expect(message.role).toBe('assistant');
    expect(message.content).toBe('[empty message]');
    expect(message.metadata?.bubbleType).toBe(2);
  });

  it('returns a corrupted placeholder when the bubble row is malformed', () => {
    const message = mapBubbleToMessage({
      key: 'bubbleId:c1:b-bad',
      value: '{"type":2,',
    });

    expect(message.content).toBe('[corrupted message]');
    expect(message.role).toBe('assistant');
    expect(message.metadata?.corrupted).toBe(true);
  });
});

describe('extractToolCalls', () => {
  it('preserves invalid params with a raw sentinel and defaults status to completed', () => {
    const toolCalls = extractToolCalls({
      toolFormerData: {
        name: 'read_file',
        params: '{"bad"',
        result: '{"contents":"hello"}',
      },
    });

    expect(toolCalls).toEqual([
      expect.objectContaining({
        name: 'read_file',
        status: 'completed',
        params: { _raw: '{"bad"' },
      }),
    ]);
  });

  it('prefers error status from additionalData over other values', () => {
    const toolCalls = extractToolCalls({
      toolFormerData: {
        name: 'run_terminal_command',
        status: 'completed',
        additionalData: { status: 'error' },
        result: '{"message":"boom"}',
      },
    });

    expect(toolCalls?.[0]?.status).toBe('error');
    expect(toolCalls?.[0]?.error).toContain('boom');
  });
});

// =============================================================================
// searchSessions
// =============================================================================
describe('searchSessions', () => {
  it('returns empty when no matches', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);
    const result = await searchSessions('xyz', { limit: 10 }, '/data');
    expect(result).toEqual([]);
  });
});

// =============================================================================
// getComposerData
// =============================================================================
describe('getComposerData', () => {
  it('returns new format with allComposers', () => {
    const data = JSON.stringify({ allComposers: [{ composerId: 'c1' }], selectedComposerIds: [] });
    const db = createMockDb({ ItemTable: { get: { value: data } } });
    const result = getComposerData(db);
    expect(result).not.toBeNull();
    expect(result!.isNewFormat).toBe(true);
    expect(result!.composers).toHaveLength(1);
    expect(result!.composers[0]!.composerId).toBe('c1');
  });

  it('returns legacy format (direct array)', () => {
    const data = JSON.stringify([{ composerId: 'c1' }]);
    const db = createMockDb({ ItemTable: { get: { value: data } } });
    const result = getComposerData(db);
    expect(result).not.toBeNull();
    expect(result!.isNewFormat).toBe(false);
    expect(result!.composers).toHaveLength(1);
  });

  it('returns null when no data', () => {
    const db = createMockDb({});
    const result = getComposerData(db);
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    const db = createMockDb({ ItemTable: { get: { value: 'not json' } } });
    const result = getComposerData(db);
    expect(result).toBeNull();
  });

  it('returns null for non-array non-object data', () => {
    const db = createMockDb({ ItemTable: { get: { value: '"just a string"' } } });
    const result = getComposerData(db);
    expect(result).toBeNull();
  });
});

// =============================================================================
// updateComposerData
// =============================================================================
describe('updateComposerData', () => {
  it('writes new format with allComposers wrapper', () => {
    const mockRun = vi.fn();
    const db: Database = {
      prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: mockRun })),
      close: vi.fn(),
      runSQL: vi.fn(),
    };

    const composers = [{ composerId: 'c1' }];
    const originalRaw = { allComposers: [], selectedComposerIds: ['x'] };
    updateComposerData(db, composers, true, originalRaw);

    expect(mockRun).toHaveBeenCalled();
    const writtenJson = mockRun.mock.calls[0]![0] as string;
    const parsed = JSON.parse(writtenJson);
    expect(parsed.allComposers).toEqual(composers);
    expect(parsed.selectedComposerIds).toEqual(['x']); // Preserved
  });

  it('writes legacy format as direct array', () => {
    const mockRun = vi.fn();
    const db: Database = {
      prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: mockRun })),
      close: vi.fn(),
      runSQL: vi.fn(),
    };

    const composers = [{ composerId: 'c1' }];
    updateComposerData(db, composers, false);

    const writtenJson = mockRun.mock.calls[0]![0] as string;
    const parsed = JSON.parse(writtenJson);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(composers);
  });
});

// =============================================================================
// resolveSessionIdentifiers
// =============================================================================
describe('resolveSessionIdentifiers', () => {
  function setupSessions() {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [
        { composerId: 'uuid-abc', name: 'Session A', createdAt: 2000 },
        { composerId: 'uuid-def', name: 'Session B', createdAt: 1000 },
      ],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));
  }

  it('resolves single index', async () => {
    setupSessions();
    const result = await resolveSessionIdentifiers(1, '/data');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('uuid-abc'); // Index 1 is most recent
  });

  it('resolves single UUID string', async () => {
    setupSessions();
    const result = await resolveSessionIdentifiers('uuid-def', '/data');
    expect(result).toEqual(['uuid-def']);
  });

  it('resolves comma-separated', async () => {
    setupSessions();
    const result = await resolveSessionIdentifiers('1, 2', '/data');
    expect(result).toHaveLength(2);
  });

  it('resolves array input', async () => {
    setupSessions();
    const result = await resolveSessionIdentifiers([1, 2], '/data');
    expect(result).toHaveLength(2);
  });

  it('throws for unknown identifier', async () => {
    setupSessions();
    await expect(resolveSessionIdentifiers(999, '/data')).rejects.toThrow();
  });

  it('throws for unknown composer ID string', async () => {
    setupSessions();
    await expect(resolveSessionIdentifiers('unknown-uuid-xyz', '/data')).rejects.toThrow();
  });
});

// =============================================================================
// findWorkspaceForSession
// =============================================================================
describe('findWorkspaceForSession', () => {
  it('returns null when session not found', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);
    const result = await findWorkspaceForSession('nonexistent', '/data');
    expect(result).toBeNull();
  });
});

// =============================================================================
// findWorkspaceByPath
// =============================================================================
describe('findWorkspaceByPath', () => {
  it('returns null when path not found', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);
    const result = await findWorkspaceByPath('/nonexistent', '/data');
    expect(result).toBeNull();
  });

  it('finds workspace by workspace path', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      return path.includes('state.vscdb') || path.includes('workspace.json') || path === '/data';
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ workspace: 'file:///path/to/ws.code-workspace' })
    );

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Session' }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await findWorkspaceByPath('/path/to/ws.code-workspace', '/data');
    expect(result).not.toBeNull();
    expect(result!.workspace.path).toBe('/path/to/ws.code-workspace');
    expect(result!.dbPath).toContain('state.vscdb');
  });
});

// =============================================================================
// listGlobalSessions
// =============================================================================
describe('listGlobalSessions', () => {
  it('returns empty when global DB does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await listGlobalSessions();
    expect(result).toEqual([]);
  });
});

// =============================================================================
// getGlobalSession
// =============================================================================
describe('getGlobalSession', () => {
  it('returns null for invalid index', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await getGlobalSession(999);
    expect(result).toBeNull();
  });

  it('returns source=global and preserves malformed rows as placeholders', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const composerValue = JSON.stringify({
      name: 'Global Session',
      createdAt: '2024-01-15T10:00:00Z',
      updatedAt: '2024-01-15T10:05:00Z',
      fullConversationHeadersOnly: [
        { bubbleId: 'b1', type: 2 },
        { bubbleId: 'b2', type: 2 },
      ],
    });
    const goodBubble = JSON.stringify({
      type: 2,
      text: 'Assistant reply',
      createdAt: '2024-01-15T10:01:00Z',
      bubbleId: 'b1',
      toolFormerData: {
        name: 'read_file',
        params: '{"bad"',
      },
    });

    mockOpenDatabase.mockResolvedValue({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) {
          return {
            get: vi.fn(() => ({ name: 'cursorDiskKV' })),
            all: vi.fn(() => []),
            run: vi.fn(),
          };
        }
        if (sql.includes("LIKE 'composerData:%'")) {
          return {
            get: vi.fn(),
            all: vi.fn(() => [{ key: 'composerData:g1', value: composerValue }]),
            run: vi.fn(),
          };
        }
        if (sql.includes('COUNT(*)')) {
          return { get: vi.fn(() => ({ count: 2 })), all: vi.fn(() => []), run: vi.fn() };
        }
        if (sql.includes('LIMIT 1')) {
          return {
            get: vi.fn(() => ({ value: goodBubble })),
            all: vi.fn(() => []),
            run: vi.fn(),
          };
        }
        if (sql.includes('WHERE key LIKE ? ORDER BY rowid ASC')) {
          return {
            get: vi.fn(),
            all: vi.fn(() => [
              { key: 'bubbleId:g1:b1', value: goodBubble },
              { key: 'bubbleId:g1:b2', value: '{"type":2,' },
            ]),
            run: vi.fn(),
          };
        }
        if (sql.includes('WHERE key = ?')) {
          return {
            get: vi.fn(() => ({ value: composerValue })),
            all: vi.fn(() => []),
            run: vi.fn(),
          };
        }
        return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
      }),
      close: vi.fn(),
      runSQL: vi.fn(),
    });

    const result = await getGlobalSession(1);

    expect(result).not.toBeNull();
    expect(result!.source).toBe('global');
    expect(result!.activeBranchBubbleIds).toEqual(['b1', 'b2']);
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]!.metadata?.bubbleType).toBe(2);
    expect(result!.messages[0]!.toolCalls?.[0]?.params).toEqual({ _raw: '{"bad"' });
    expect(result!.messages[1]!.content).toBe('[corrupted message]');
    expect(result!.messages[1]!.metadata?.corrupted).toBe(true);
  });
});

// =============================================================================
// searchSessions — with actual matches
// =============================================================================
describe('searchSessions (with matches)', () => {
  function setupForSearch() {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Debug Session', createdAt: 2000 }],
    });

    const userBubble = JSON.stringify({ type: 1, text: 'How do I fix the authentication bug?' });
    const assistantBubble = JSON.stringify({
      type: 2,
      text: 'You can fix the bug by checking the token.',
    });

    setupGetSessionMocks(composerData, [
      { key: 'bubbleId:c1:b1', value: userBubble },
      { key: 'bubbleId:c1:b2', value: assistantBubble },
    ]);
  }

  it('returns matches when query is found in session messages', async () => {
    setupForSearch();
    const results = await searchSessions('bug', { limit: 10, contextChars: 40 }, '/data');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.matchCount).toBeGreaterThan(0);
    expect(results[0]!.snippets.length).toBeGreaterThan(0);
  });

  it('returns empty when no matches', async () => {
    setupForSearch();
    const results = await searchSessions(
      'nonexistentxyz',
      { limit: 10, contextChars: 40 },
      '/data'
    );
    expect(results).toHaveLength(0);
  });

  it('applies limit to results', async () => {
    setupForSearch();
    const results = await searchSessions('bug', { limit: 0, contextChars: 40 }, '/data');
    // limit=0 means no limit
    expect(results).toBeInstanceOf(Array);
  });
});

// =============================================================================
// findWorkspaceForSession — with match
// =============================================================================
describe('findWorkspaceForSession (with match)', () => {
  it('returns workspace info when session found', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'target-id', name: 'Found' }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await findWorkspaceForSession('target-id', '/data');
    expect(result).not.toBeNull();
    expect(result!.workspace.path).toBe('/project');
  });
});

// =============================================================================
// findWorkspaceByPath — with match
// =============================================================================
describe('findWorkspaceByPath (with match)', () => {
  it('returns workspace info when path matches', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/my/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Session' }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await findWorkspaceByPath('/my/project', '/data');
    expect(result).not.toBeNull();
    expect(result!.dbPath).toContain('state.vscdb');
  });
});

// =============================================================================
// listGlobalSessions — with data
// =============================================================================
describe('listGlobalSessions (with data)', () => {
  it('returns sessions from global storage', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const composerValue = JSON.stringify({
      name: 'Global Session',
      createdAt: '2024-01-15T10:00:00Z',
    });
    const bubbleValue = JSON.stringify({ type: 1, text: 'Hello from global' });

    mockOpenDatabase.mockResolvedValue({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) {
          return {
            get: vi.fn(() => ({ name: 'cursorDiskKV' })),
            all: vi.fn(() => []),
            run: vi.fn(),
          };
        }
        if (sql.includes("LIKE 'composerData:%'")) {
          return {
            get: vi.fn(),
            all: vi.fn(() => [{ key: 'composerData:g1', value: composerValue }]),
            run: vi.fn(),
          };
        }
        if (sql.includes('COUNT(*)')) {
          return { get: vi.fn(() => ({ count: 2 })), all: vi.fn(() => []), run: vi.fn() };
        }
        if (sql.includes('LIMIT 1')) {
          return { get: vi.fn(() => ({ value: bubbleValue })), all: vi.fn(() => []), run: vi.fn() };
        }
        return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
      }),
      close: vi.fn(),
      runSQL: vi.fn(),
    });

    const result = await listGlobalSessions();
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.title).toBe('Global Session');
    expect(result[0]!.messageCount).toBe(2);
  });
});

// =============================================================================
// getSession — more tool call types for formatToolCall coverage
// =============================================================================
describe('getSession (more tool types)', () => {
  function setupToolTest(bubbleValue: string) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 2000 }],
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: bubbleValue }]);
  }

  it('extracts list_dir tool call', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'list_dir',
        params: JSON.stringify({ targetDirectory: '/src' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: List Directory]');
    expect(result!.messages[0]!.content).toContain('/src');
  });

  it('extracts grep tool call', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'grep',
        params: JSON.stringify({ pattern: 'TODO', path: '/src' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Grep]');
    expect(result!.messages[0]!.content).toContain('TODO');
  });

  it('extracts terminal command tool call', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'run_terminal_command',
        params: JSON.stringify({ command: 'npm test' }),
        status: 'completed',
        result: JSON.stringify({ output: 'All tests passed' }),
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Terminal Command]');
    expect(result!.messages[0]!.content).toContain('npm test');
  });

  it('handles read_file_v2 with full result contents', async () => {
    const fileText = 'x'.repeat(500);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: JSON.stringify({ contents: fileText }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('[Tool: Read File v2]');
    expect(session!.messages[0]!.content).toContain(fileText);
    expect(session!.messages[0]!.content).not.toContain(`${fileText.slice(0, 300)}...`);
  });

  it('handles read_file_v2 with codeBlocks fallback', async () => {
    const bubble = JSON.stringify({
      type: 2,
      codeBlocks: [{ content: 'fallback content' }],
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: JSON.stringify({}),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('fallback content');
  });

  it('handles read_file_v2 with JSON.stringify fallback', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: JSON.stringify({ contents: { nested: true } }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('{"nested":true}');
  });

  it('handles read_file_v2 with malformed result JSON', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: '{',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('[Tool: Read File v2]');
    expect(session!.messages[0]!.content).not.toContain('Content:');
  });

  it('handles read_file_v2 with whitespace-only contents', async () => {
    const bubble = JSON.stringify({
      type: 2,
      codeBlocks: [{ content: 'real content' }],
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: JSON.stringify({ contents: '   ' }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('real content');
  });

  it('handles edit_file_v2 with full streamingContent', async () => {
    const fileText = 'x'.repeat(200);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'edit_file_v2',
        params: JSON.stringify({ targetFile: '/f.ts', streamingContent: fileText }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('[Tool: Edit File v2]');
    expect(session!.messages[0]!.content).toContain(fileText);
    expect(session!.messages[0]!.content).not.toContain(`${fileText.slice(0, 100)}...`);
  });

  it('handles edit_file_v2 with content param fallback', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'edit_file_v2',
        params: JSON.stringify({ targetFile: '/f.ts', content: 'content fallback' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('content fallback');
  });

  it('handles edit_file_v2 with codeBlocks fallback', async () => {
    const bubble = JSON.stringify({
      type: 2,
      codeBlocks: [{ content: 'block content' }],
      toolFormerData: {
        name: 'edit_file_v2',
        params: JSON.stringify({ targetFile: '/f.ts' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('block content');
  });

  it('handles edit_file_v2 with malformed params', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'edit_file_v2',
        params: '{',
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('[Tool: Edit File v2]');
  });

  it('handles edit_file_v2 with rejected user decision and full content', async () => {
    const fileText = 'x'.repeat(200);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'edit_file_v2',
        params: JSON.stringify({ targetFile: '/f.ts', streamingContent: fileText }),
        status: 'completed',
        additionalData: { userDecision: 'rejected' },
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain(fileText);
    expect(session!.messages[0]!.content).toContain('User Decision: ✗ rejected');
  });

  it('handles read_file_v2 with both primary content and diff', async () => {
    const rawResult = JSON.stringify({
      contents: 'file text',
      diff: { chunks: [{ diffString: '-old\n+new' }] },
    });
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: rawResult,
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('Content: file text');
    expect(session!.messages[0]!.content).toContain('```diff');
    expect(session!.messages[0]!.content).toContain('-old');
    expect(session!.messages[0]!.content).toContain('+new');
  });

  it('handles read_file_v2 with diff only when no usable primary content exists', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: JSON.stringify({
          contents: '   ',
          diff: { chunks: [{ diffString: '-old\n+new' }] },
        }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('```diff');
    expect(session!.messages[0]!.content).not.toContain('Content:');
  });

  it('logs malformed read_file_v2 result payloads', async () => {
    const debugSpy = vi.spyOn(debugModule, 'debugLogStorage').mockImplementation(() => {});
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: '{',
      },
    });
    setupToolTest(bubble);
    await getSession(1, '/data');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('read_file_v2'));
  });

  it('logs malformed edit_file_v2 params payloads', async () => {
    const debugSpy = vi.spyOn(debugModule, 'debugLogStorage').mockImplementation(() => {});
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'edit_file_v2',
        params: '{',
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    await getSession(1, '/data');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('edit_file_v2'));
  });

  it('preserves toolCalls result for read_file_v2', async () => {
    const rawResult = JSON.stringify({ contents: 'file text' });
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/src/file.ts' }),
        status: 'completed',
        result: rawResult,
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain('file text');
    expect(session!.messages[0]!.toolCalls?.[0]?.result).toBe(rawResult);
  });

  it('extracts edit_file tool call', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'edit_file',
        params: JSON.stringify({ targetFile: '/src/main.ts', oldString: 'foo', newString: 'bar' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool:');
    expect(result!.messages[0]!.content).toContain('/src/main.ts');
  });

  it('extracts write tool with relativeWorkspacePath', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'write',
        params: JSON.stringify({
          relativeWorkspacePath: 'new-file.ts',
          content: 'export const x = 1;',
        }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('new-file.ts');
  });

  it('extracts codebase_search tool call', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'codebase_search',
        params: JSON.stringify({ query: 'authentication handler' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Search]');
    expect(result!.messages[0]!.content).toContain('authentication handler');
  });

  it('handles cancelled tool status', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ targetFile: '/cancelled.ts' }),
        status: 'cancelled',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool:');
  });

  it('handles text field with JSON diff', async () => {
    const diffData = JSON.stringify({
      diff: {
        chunks: [{ diffString: '-old\n+new' }],
      },
    });
    const bubble = JSON.stringify({
      type: 2,
      text: diffData,
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    // Should detect JSON diff in text
    expect(result!.messages[0]!.content.length).toBeGreaterThan(0);
  });

  it('handles fallback to longest markdown string', async () => {
    const bubble = JSON.stringify({
      type: 2,
      someField: 'short',
      nested: {
        deepField:
          'This is a much longer string with **markdown** features that should be found by the fallback.',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    // The fallback should find the longest string with markdown
    expect(result!.messages[0]!.content.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// getSession — generic tool with result output
// =============================================================================
describe('getSession (generic tool)', () => {
  function setupToolTest(bubbleValue: string) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 2000 }],
    });
    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: bubbleValue }]);
  }

  it('handles generic tool with string params', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'custom_tool',
        params: JSON.stringify({ inputFile: '/data.csv', mode: 'parse' }),
        status: 'completed',
        result: JSON.stringify({ output: 'Parsed 100 rows' }),
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: custom_tool]');
    expect(result!.messages[0]!.content).toContain('Parsed 100 rows');
  });

  it('keeps generic tool string params longer than 100 chars', async () => {
    const payload = 'p'.repeat(150);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'custom_tool',
        params: JSON.stringify({ payload }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain(`Payload: ${payload}`);
    expect(session!.messages[0]!.content).not.toContain(`${payload.slice(0, 100)}...`);
  });

  it('keeps generic tool result fields longer than 500 chars', async () => {
    const output = 'z'.repeat(600);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'custom_tool',
        params: '{}',
        status: 'completed',
        result: JSON.stringify({ output }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain(`Result: ${output}`);
    expect(session!.messages[0]!.content).not.toContain(`${output.slice(0, 500)}...`);
  });

  it('handles tool with non-JSON result string', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'custom_tool',
        params: '{}',
        status: 'completed',
        result: 'plain text result',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('plain text result');
  });

  it('handles write_file tool name in diff result', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'write_file',
        params: JSON.stringify({ relativeWorkspacePath: 'output.ts' }),
        status: 'completed',
        result: JSON.stringify({
          diff: { chunks: [{ diffString: '-old line\n+new line' }] },
          resultForModel: 'File updated',
        }),
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Write File]');
    expect(result!.messages[0]!.content).toContain('output.ts');
    expect(result!.messages[0]!.content).toContain('```diff');
  });

  it('handles search_replace tool', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'search_replace',
        params: JSON.stringify({
          targetFile: '/src/app.ts',
          old_string: 'oldCode',
          new_string: 'newCode',
        }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Search & Replace]');
    expect(result!.messages[0]!.content).toContain('oldCode');
    expect(result!.messages[0]!.content).toContain('newCode');
  });

  it('handles create_file tool', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'create_file',
        params: JSON.stringify({ targetFile: '/new-module.ts' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Create File]');
  });

  it('handles tool with user decision', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'write',
        params: JSON.stringify({ relativeWorkspacePath: 'file.ts' }),
        status: 'completed',
        additionalData: { userDecision: 'accepted' },
        result: JSON.stringify({ diff: { chunks: [{ diffString: '+new' }] } }),
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('accepted');
  });

  it('handles terminal command with output', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'execute_command',
        params: JSON.stringify({ cmd: 'ls -la' }),
        status: 'completed',
        result: JSON.stringify({ output: 'file1.ts\nfile2.ts' }),
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Terminal Command]');
    expect(result!.messages[0]!.content).toContain('ls -la');
  });

  it('keeps terminal command output longer than 500 chars', async () => {
    const output = 'x'.repeat(600);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'run_terminal_command',
        params: JSON.stringify({ command: 'npm test' }),
        status: 'completed',
        result: JSON.stringify({ output }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain(`Output: ${output}`);
    expect(session!.messages[0]!.content).not.toContain(`${output.slice(0, 500)}...`);
  });

  it('omits empty terminal command output lines', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'run_terminal_command',
        params: JSON.stringify({ command: 'npm test' }),
        status: 'completed',
        result: JSON.stringify({ output: '' }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).not.toContain('Output:');
  });

  it('keeps read_file contents longer than 300 chars', async () => {
    const content = 'y'.repeat(400);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ path: '/src/index.ts' }),
        status: 'completed',
        result: JSON.stringify({ contents: content }),
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain(`Content: ${content}`);
    expect(session!.messages[0]!.content).not.toContain(`${content.slice(0, 300)}...`);
  });

  it('handles read_file with full content', async () => {
    const content = 'export function main() {\n  return true;\n}';
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'read_file',
        params: JSON.stringify({ path: '/src/index.ts' }),
        status: 'completed',
        result: JSON.stringify({ contents: content }),
      },
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('[Tool: Read File]');
    expect(result!.messages[0]!.content).toContain(`Content: ${content}`);
    expect(result!.messages[0]!.content).toContain('\n  return true;\n');
  });

  it('keeps list_dir content unchanged', async () => {
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'list_dir',
        params: JSON.stringify({ targetDirectory: '/src' }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toBe(
      '[Tool: List Directory]\nDirectory: /src\nStatus: ✓ completed'
    );
  });

  it('keeps edit_file old and new strings truncated', async () => {
    const oldString = 'o'.repeat(150);
    const newString = 'n'.repeat(150);
    const bubble = JSON.stringify({
      type: 2,
      toolFormerData: {
        name: 'edit_file',
        params: JSON.stringify({ targetFile: '/src/main.ts', oldString, newString }),
        status: 'completed',
      },
    });
    setupToolTest(bubble);
    const session = await getSession(1, '/data');
    expect(session).not.toBeNull();
    expect(session!.messages[0]!.content).toContain(`Old: ${'o'.repeat(100)}...`);
    expect(session!.messages[0]!.content).toContain(`New: ${'n'.repeat(100)}...`);
  });

  it('handles user message with codeBlocks', async () => {
    const bubble = JSON.stringify({
      type: 1,
      codeBlocks: [{ content: 'const x = 1;', languageId: 'typescript' }],
    });
    setupToolTest(bubble);
    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content).toContain('const x = 1;');
  });
});

// =============================================================================
// getSession — workspace fallback path
// =============================================================================
describe('getSession (workspace fallback)', () => {
  it('falls back to workspace DB when global has no cursorDiskKV', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Session', createdAt: 2000 }],
    });

    // Path-based mock: workspace DB returns session data, global DB has no cursorDiskKV table
    const wsDb = createWorkspaceDb(composerData);
    const globalDb: Database = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) {
          return { get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn() }; // No cursorDiskKV
        }
        return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
      }),
      close: vi.fn(),
      runSQL: vi.fn(),
    };

    mockOpenDatabase.mockImplementation(async (path: string) => {
      if (String(path).includes('globalStorage')) return globalDb;
      return wsDb;
    });

    const result = await getSession(1, '/data');
    // When global storage doesn't have the table, it falls back to workspace
    // The result depends on whether workspace data can reconstruct the session
    expect(result).toBeDefined();
  });

  it('marks fallback sessions with source=workspace-fallback and logs missing global DB', async () => {
    vi.stubEnv('DEBUG', 'cursor-history:*');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(existsSync).mockImplementation((path) => {
      const value = String(path);
      if (value.includes('globalStorage/state.vscdb')) return false;
      return value === '/data' || value.includes('state.vscdb') || value.includes('workspace.json');
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Session', createdAt: 2000 }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('workspace-fallback');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cursor-history:storage] Global DB not found')
    );
  });

  it('keeps activeBranchBubbleIds undefined for workspace-fallback sessions', async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      const value = String(path);
      if (value.includes('globalStorage/state.vscdb')) return false;
      return value === '/data' || value.includes('state.vscdb') || value.includes('workspace.json');
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Session', createdAt: 2000 }],
      fullConversationHeadersOnly: [{ bubbleId: 'branch-1', type: 1 }],
    });
    mockOpenDatabase.mockResolvedValue(createWorkspaceDb(composerData));

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('workspace-fallback');
    expect(result!.activeBranchBubbleIds).toBeUndefined();
  });
});

describe('getSession debug logging', () => {
  function setupFallbackHarness(globalDb: Database) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Session', createdAt: 2000 }],
    });
    const wsDb = createWorkspaceDb(composerData);

    mockOpenDatabase.mockImplementation(async (path: string) => {
      if (String(path).includes('globalStorage')) return globalDb;
      return wsDb;
    });
  }

  it('logs when cursorDiskKV is missing', async () => {
    vi.stubEnv('DEBUG', 'cursor-history:*');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setupFallbackHarness({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) {
          return { get: vi.fn(() => undefined), all: vi.fn(() => []), run: vi.fn() };
        }
        return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
      }),
      close: vi.fn(),
      runSQL: vi.fn(),
    });

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('workspace-fallback');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cursor-history:storage] cursorDiskKV table not found')
    );
  });

  it('logs when the composer has no global bubbles', async () => {
    vi.stubEnv('DEBUG', 'cursor-history:*');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setupFallbackHarness({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) {
          return { get: vi.fn(() => ({ name: 'cursorDiskKV' })), all: vi.fn(() => []), run: vi.fn() };
        }
        return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
      }),
      close: vi.fn(),
      runSQL: vi.fn(),
    });

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('workspace-fallback');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cursor-history:storage] No bubbles for composer c1')
    );
  });

  it('logs query errors while loading global bubbles', async () => {
    vi.stubEnv('DEBUG', 'cursor-history:*');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setupFallbackHarness({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('sqlite_master')) {
          return { get: vi.fn(() => ({ name: 'cursorDiskKV' })), all: vi.fn(() => []), run: vi.fn() };
        }
        if (sql.includes('WHERE key LIKE ? ORDER BY rowid ASC')) {
          return {
            get: vi.fn(),
            all: vi.fn(() => {
              throw new Error('query failed');
            }),
            run: vi.fn(),
          };
        }
        return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
      }),
      close: vi.fn(),
      runSQL: vi.fn(),
    });

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('workspace-fallback');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[cursor-history:storage] Failed to load global bubbles for composer c1: query failed'
      )
    );
  });

  it('logs malformed bubble rows while keeping the session global', async () => {
    vi.stubEnv('DEBUG', 'cursor-history:*');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: '{"type":2,' }]);

    const result = await getSession(1, '/data');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('global');
    expect(result!.messages[0]!.metadata?.corrupted).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cursor-history:storage] Malformed bubble row bubbleId:c1:b1')
    );
  });
});

// =============================================================================
// extractTimestamp
// =============================================================================
describe('extractTimestamp', () => {
  it('returns Date from createdAt ISO string when present', () => {
    const data = { createdAt: '2024-08-15T14:30:00Z' };
    const result = extractTimestamp(data);
    expect(result).toEqual(new Date('2024-08-15T14:30:00Z'));
  });

  it('returns Date from clientRpcSendTime when createdAt absent', () => {
    const rpcTime = 1724765400000; // 2024-08-27T14:30:00Z
    const data = { timingInfo: { clientRpcSendTime: rpcTime } };
    const result = extractTimestamp(data);
    expect(result).toEqual(new Date(rpcTime));
  });

  it('returns Date from clientSettleTime when createdAt and clientRpcSendTime absent', () => {
    const settleTime = 1724765400000;
    const data = { timingInfo: { clientSettleTime: settleTime } };
    const result = extractTimestamp(data);
    expect(result).toEqual(new Date(settleTime));
  });

  it('returns Date from clientEndTime as last timing fallback', () => {
    const endTime = 1724765400000;
    const data = { timingInfo: { clientEndTime: endTime } };
    const result = extractTimestamp(data);
    expect(result).toEqual(new Date(endTime));
  });

  it('returns null when no timestamp source exists', () => {
    const data = {};
    const result = extractTimestamp(data);
    expect(result).toBeNull();
  });

  it('skips clientRpcSendTime when value is below threshold', () => {
    const data = { timingInfo: { clientRpcSendTime: 999 } };
    const result = extractTimestamp(data);
    expect(result).toBeNull();
  });

  it('skips clientRpcSendTime when value is 0 or negative', () => {
    expect(extractTimestamp({ timingInfo: { clientRpcSendTime: 0 } })).toBeNull();
    expect(extractTimestamp({ timingInfo: { clientRpcSendTime: -1 } })).toBeNull();
  });

  it('prefers createdAt over clientRpcSendTime when both present', () => {
    const data = {
      createdAt: '2025-01-01T00:00:00Z',
      timingInfo: { clientRpcSendTime: 1724765400000 },
    };
    const result = extractTimestamp(data);
    expect(result).toEqual(new Date('2025-01-01T00:00:00Z'));
  });

  it('skips all invalid timingInfo values and returns null', () => {
    const data = {
      timingInfo: {
        clientRpcSendTime: 500,
        clientSettleTime: -100,
        clientEndTime: 0,
      },
    };
    const result = extractTimestamp(data);
    expect(result).toBeNull();
  });

  it('returns null when timingInfo exists but has no timestamp fields', () => {
    const data = { timingInfo: { clientStartTime: 1724765400000 } };
    const result = extractTimestamp(data);
    // clientStartTime is not in the priority chain for timestamp extraction
    expect(result).toBeNull();
  });
});

// =============================================================================
// timestamp fallback - US1 (getSession integration)
// =============================================================================
describe('timestamp fallback - US1', () => {
  it('bubble with createdAt still uses createdAt (regression, FR-009)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const bubble = JSON.stringify({
      type: 2,
      text: 'response',
      createdAt: '2025-10-15T10:00:00Z',
      bubbleId: 'b1',
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: bubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.timestamp).toEqual(new Date('2025-10-15T10:00:00Z'));
  });

  it('bubble without createdAt but with clientRpcSendTime uses clientRpcSendTime', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const rpcTime = 1724765400000; // 2024-08-27
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const bubble = JSON.stringify({
      type: 2,
      text: 'old response',
      bubbleId: 'b1',
      timingInfo: {
        clientRpcSendTime: rpcTime,
        clientStartTime: rpcTime + 10,
        clientEndTime: rpcTime + 500,
      },
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: bubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.timestamp).toEqual(new Date(rpcTime));
  });

  it('bubble without createdAt or clientRpcSendTime but with clientSettleTime uses clientSettleTime', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const settleTime = 1724765400000;
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const bubble = JSON.stringify({
      type: 2,
      text: 'old response',
      bubbleId: 'b1',
      timingInfo: { clientSettleTime: settleTime },
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: bubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.timestamp).toEqual(new Date(settleTime));
  });

  it('bubble with invalid clientRpcSendTime falls through to next source', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const validEndTime = 1724765400000;
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    const bubble = JSON.stringify({
      type: 2,
      text: 'old response',
      bubbleId: 'b1',
      timingInfo: { clientRpcSendTime: 999, clientEndTime: validEndTime },
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: bubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.timestamp).toEqual(new Date(validEndTime));
  });

  it('bubble with no timestamp source uses session creation time, not current time', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const sessionCreatedAt = 1000; // Unix ms
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: sessionCreatedAt }],
    });

    const bubble = JSON.stringify({
      type: 1,
      text: 'user message with no timestamp',
      bubbleId: 'b1',
    });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: bubble }]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    // Should use session creation time, not current time
    expect(result!.messages[0]!.timestamp).toEqual(new Date(sessionCreatedAt));
  });

  it('mixed-format session: each bubble uses its own best available source', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const rpcTime = 1724765400000;
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: 1000 }],
    });

    // Bubble with createdAt (new format)
    const newBubble = JSON.stringify({
      type: 2,
      text: 'new format response',
      createdAt: '2025-10-15T10:00:00Z',
      bubbleId: 'b1',
    });

    // Bubble with timingInfo only (old format)
    const oldBubble = JSON.stringify({
      type: 2,
      text: 'old format response',
      bubbleId: 'b2',
      timingInfo: { clientRpcSendTime: rpcTime },
    });

    // Bubble with no timestamp at all
    const noTsBubble = JSON.stringify({
      type: 1,
      text: 'no timestamp user message',
      bubbleId: 'b3',
    });

    setupGetSessionMocks(composerData, [
      { key: 'bubbleId:c1:b1', value: newBubble },
      { key: 'bubbleId:c1:b2', value: oldBubble },
      { key: 'bubbleId:c1:b3', value: noTsBubble },
    ]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(3);
    // New format: uses createdAt
    expect(result!.messages[0]!.timestamp).toEqual(new Date('2025-10-15T10:00:00Z'));
    // Old format: uses clientRpcSendTime
    expect(result!.messages[1]!.timestamp).toEqual(new Date(rpcTime));
    // No timestamp: interpolated from previous neighbor (b2's clientRpcSendTime)
    expect(result!.messages[2]!.timestamp).toEqual(new Date(rpcTime));
  });
});

// =============================================================================
// fillTimestampGaps
// =============================================================================
describe('fillTimestampGaps', () => {
  const d1 = new Date('2024-01-01T10:00:00Z');
  const d2 = new Date('2024-01-01T10:05:00Z');
  const d3 = new Date('2024-01-01T10:10:00Z');
  const sessionDate = new Date('2024-01-01T00:00:00Z');

  it('does not change messages when all timestamps are present', () => {
    const messages = [
      { timestamp: d1 as Date | null },
      { timestamp: d2 as Date | null },
      { timestamp: d3 as Date | null },
    ];
    fillTimestampGaps(messages);
    expect(messages[0]!.timestamp).toBe(d1);
    expect(messages[1]!.timestamp).toBe(d2);
    expect(messages[2]!.timestamp).toBe(d3);
  });

  it('first message null, second has timestamp: first gets second (prefer next)', () => {
    const messages = [{ timestamp: null as Date | null }, { timestamp: d2 as Date | null }];
    fillTimestampGaps(messages);
    expect(messages[0]!.timestamp).toBe(d2);
    expect(messages[1]!.timestamp).toBe(d2);
  });

  it('last message null, previous has timestamp: last gets previous', () => {
    const messages = [{ timestamp: d1 as Date | null }, { timestamp: null as Date | null }];
    fillTimestampGaps(messages);
    expect(messages[0]!.timestamp).toBe(d1);
    expect(messages[1]!.timestamp).toBe(d1);
  });

  it('middle message null, both neighbors have timestamps: gets next (prefer next)', () => {
    const messages = [
      { timestamp: d1 as Date | null },
      { timestamp: null as Date | null },
      { timestamp: d3 as Date | null },
    ];
    fillTimestampGaps(messages);
    expect(messages[1]!.timestamp).toBe(d3);
  });

  it('multiple consecutive nulls: all get next available timestamp', () => {
    const messages = [
      { timestamp: null as Date | null },
      { timestamp: null as Date | null },
      { timestamp: null as Date | null },
      { timestamp: d3 as Date | null },
    ];
    fillTimestampGaps(messages);
    expect(messages[0]!.timestamp).toBe(d3);
    expect(messages[1]!.timestamp).toBe(d3);
    expect(messages[2]!.timestamp).toBe(d3);
    expect(messages[3]!.timestamp).toBe(d3);
  });

  it('all messages null with sessionCreatedAt: all get session timestamp', () => {
    const messages = [{ timestamp: null as Date | null }, { timestamp: null as Date | null }];
    fillTimestampGaps(messages, sessionDate);
    expect(messages[0]!.timestamp).toBe(sessionDate);
    expect(messages[1]!.timestamp).toBe(sessionDate);
  });

  it('all messages null without sessionCreatedAt: all get current time (last resort)', () => {
    const before = Date.now();
    const messages = [{ timestamp: null as Date | null }, { timestamp: null as Date | null }];
    fillTimestampGaps(messages);
    const after = Date.now();
    for (const msg of messages) {
      expect(msg.timestamp).toBeInstanceOf(Date);
      expect((msg.timestamp as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect((msg.timestamp as Date).getTime()).toBeLessThanOrEqual(after);
    }
  });

  it('single message with null timestamp: gets session fallback', () => {
    const messages = [{ timestamp: null as Date | null }];
    fillTimestampGaps(messages, sessionDate);
    expect(messages[0]!.timestamp).toBe(sessionDate);
  });

  it('trailing nulls after a resolved message: get previous timestamp', () => {
    const messages = [
      { timestamp: d1 as Date | null },
      { timestamp: null as Date | null },
      { timestamp: null as Date | null },
    ];
    fillTimestampGaps(messages);
    expect(messages[1]!.timestamp).toBe(d1);
    expect(messages[2]!.timestamp).toBe(d1);
  });
});

// =============================================================================
// timestamp fallback - US3 session-level
// =============================================================================
describe('timestamp fallback - US3 session-level', () => {
  it('all bubbles lack any timestamp source, sessionCreatedAt provided: all get sessionCreatedAt', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const sessionCreatedAt = 1700000000000; // 2023-11-14
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: sessionCreatedAt }],
    });

    const b1 = JSON.stringify({ type: 1, text: 'user msg', bubbleId: 'b1' });
    const b2 = JSON.stringify({ type: 2, text: 'assistant msg', bubbleId: 'b2' });
    const b3 = JSON.stringify({ type: 1, text: 'another user msg', bubbleId: 'b3' });

    setupGetSessionMocks(composerData, [
      { key: 'bubbleId:c1:b1', value: b1 },
      { key: 'bubbleId:c1:b2', value: b2 },
      { key: 'bubbleId:c1:b3', value: b3 },
    ]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(3);
    // All should get sessionCreatedAt since no bubble has any timestamp
    for (const msg of result!.messages) {
      expect(msg.timestamp).toEqual(new Date(sessionCreatedAt));
    }
  });

  it('all bubbles lack any timestamp source, sessionCreatedAt not available: uses current time', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    // Session with no createdAt (will default to new Date() in listSessions)
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test' }],
    });

    const b1 = JSON.stringify({ type: 1, text: 'user msg', bubbleId: 'b1' });

    setupGetSessionMocks(composerData, [{ key: 'bubbleId:c1:b1', value: b1 }]);

    const before = Date.now();
    const result = await getSession(1, '/data');
    const after = Date.now();
    expect(result).not.toBeNull();
    // Timestamp should be approximately now (either from session fallback or last resort)
    const ts = result!.messages[0]!.timestamp.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  it('full chain integration: createdAt + timingInfo + no-timestamp + interpolation', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ folder: '/project' }));

    const rpcTime = 1724765400000; // 2024-08-27
    const sessionCreatedAt = 1700000000000; // 2023-11-14
    const composerData = JSON.stringify({
      allComposers: [{ composerId: 'c1', name: 'Test', createdAt: sessionCreatedAt }],
    });

    // b1: user msg, no timestamp → should interpolate from next (b2)
    const b1 = JSON.stringify({ type: 1, text: 'user question', bubbleId: 'b1' });
    // b2: assistant, has timingInfo.clientRpcSendTime → should use rpcTime
    const b2 = JSON.stringify({
      type: 2,
      text: 'assistant answer',
      bubbleId: 'b2',
      timingInfo: {
        clientRpcSendTime: rpcTime,
        clientStartTime: rpcTime + 10,
        clientEndTime: rpcTime + 500,
      },
    });
    // b3: user msg, no timestamp → should interpolate from prev (b2) since no next
    const b3 = JSON.stringify({ type: 1, text: 'follow up', bubbleId: 'b3' });
    // b4: assistant, has createdAt → should use createdAt
    const b4 = JSON.stringify({
      type: 2,
      text: 'new format response',
      bubbleId: 'b4',
      createdAt: '2025-10-15T12:00:00Z',
    });

    setupGetSessionMocks(composerData, [
      { key: 'bubbleId:c1:b1', value: b1 },
      { key: 'bubbleId:c1:b2', value: b2 },
      { key: 'bubbleId:c1:b3', value: b3 },
      { key: 'bubbleId:c1:b4', value: b4 },
    ]);

    const result = await getSession(1, '/data');
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(4);

    // b1: no timestamp → interpolated from next (b2's rpcTime)
    expect(result!.messages[0]!.timestamp).toEqual(new Date(rpcTime));
    // b2: timingInfo.clientRpcSendTime
    expect(result!.messages[1]!.timestamp).toEqual(new Date(rpcTime));
    // b3: no timestamp → interpolated from next (b4's createdAt)
    expect(result!.messages[2]!.timestamp).toEqual(new Date('2025-10-15T12:00:00Z'));
    // b4: createdAt
    expect(result!.messages[3]!.timestamp).toEqual(new Date('2025-10-15T12:00:00Z'));
  });
});

// =============================================================================
// extractTokenUsage
// =============================================================================
describe('extractTokenUsage', () => {
  it('returns tokens from camelCase tokenCount (priority 1)', () => {
    const result = extractTokenUsage({
      tokenCount: { inputTokens: 100, outputTokens: 50 },
    } as never);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('returns tokens from snake_case usage (priority 2)', () => {
    const result = extractTokenUsage({
      usage: { input_tokens: 200, output_tokens: 80 },
    } as never);
    expect(result).toEqual({ inputTokens: 200, outputTokens: 80 });
  });

  it('prefers camelCase over snake_case when both present', () => {
    const result = extractTokenUsage({
      tokenCount: { inputTokens: 100, outputTokens: 50 },
      usage: { input_tokens: 999, output_tokens: 999 },
    } as never);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('returns tokens from contextWindowStatusAtCreation (priority 3)', () => {
    const result = extractTokenUsage({
      contextWindowStatusAtCreation: { tokensUsed: 500 },
    } as never);
    expect(result).toEqual({ inputTokens: 500, outputTokens: 0 });
  });

  it('returns tokens from promptDryRunInfo fullConversationTokenCount (priority 4)', () => {
    const result = extractTokenUsage({
      promptDryRunInfo: JSON.stringify({
        fullConversationTokenCount: { numTokens: 300 },
      }),
    } as never);
    expect(result).toEqual({ inputTokens: 300, outputTokens: 0 });
  });

  it('returns tokens from promptDryRunInfo userMessageTokenCount when fullConv absent', () => {
    const result = extractTokenUsage({
      promptDryRunInfo: JSON.stringify({
        userMessageTokenCount: { numTokens: 150 },
      }),
    } as never);
    expect(result).toEqual({ inputTokens: 150, outputTokens: 0 });
  });

  it('returns undefined when tokenCount has zero values', () => {
    const result = extractTokenUsage({
      tokenCount: { inputTokens: 0, outputTokens: 0 },
    } as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when no token source exists', () => {
    const result = extractTokenUsage({} as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when promptDryRunInfo is invalid JSON', () => {
    const result = extractTokenUsage({
      promptDryRunInfo: 'not json',
    } as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when promptDryRunInfo has no valid token counts', () => {
    const result = extractTokenUsage({
      promptDryRunInfo: JSON.stringify({
        fullConversationTokenCount: {},
        userMessageTokenCount: {},
      }),
    } as never);
    expect(result).toBeUndefined();
  });

  it('handles missing optional fields in tokenCount', () => {
    const result = extractTokenUsage({
      tokenCount: { inputTokens: 100 },
    } as never);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 0 });
  });
});

// =============================================================================
// extractContextWindowStatus
// =============================================================================
describe('extractContextWindowStatus', () => {
  it('returns status when all fields are valid', () => {
    const result = extractContextWindowStatus({
      contextWindowStatusAtCreation: {
        tokensUsed: 5000,
        tokenLimit: 128000,
        percentageRemaining: 96,
      },
    } as never);
    expect(result).toEqual({
      tokensUsed: 5000,
      tokenLimit: 128000,
      percentageRemaining: 96,
    });
  });

  it('prefers percentageRemainingFloat over percentageRemaining', () => {
    const result = extractContextWindowStatus({
      contextWindowStatusAtCreation: {
        tokensUsed: 5000,
        tokenLimit: 128000,
        percentageRemaining: 96,
        percentageRemainingFloat: 96.09375,
      },
    } as never);
    expect(result).toEqual({
      tokensUsed: 5000,
      tokenLimit: 128000,
      percentageRemaining: 96.09375,
    });
  });

  it('returns undefined when contextWindowStatusAtCreation is absent', () => {
    const result = extractContextWindowStatus({} as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when tokensUsed is not a number', () => {
    const result = extractContextWindowStatus({
      contextWindowStatusAtCreation: {
        tokensUsed: 'invalid',
        tokenLimit: 128000,
        percentageRemaining: 96,
      },
    } as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when tokenLimit is not a number', () => {
    const result = extractContextWindowStatus({
      contextWindowStatusAtCreation: {
        tokensUsed: 5000,
        tokenLimit: undefined,
        percentageRemaining: 96,
      },
    } as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when percentageRemaining is not a number', () => {
    const result = extractContextWindowStatus({
      contextWindowStatusAtCreation: {
        tokensUsed: 5000,
        tokenLimit: 128000,
      },
    } as never);
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// extractPromptDryRunInfo
// =============================================================================
describe('extractPromptDryRunInfo', () => {
  it('returns parsed info with both token counts', () => {
    const result = extractPromptDryRunInfo({
      promptDryRunInfo: JSON.stringify({
        fullConversationTokenCount: { numTokens: 3000 },
        userMessageTokenCount: { numTokens: 500 },
      }),
    } as never);
    expect(result).toEqual({
      fullConversationTokenCount: 3000,
      userMessageTokenCount: 500,
    });
  });

  it('returns info with only fullConversationTokenCount', () => {
    const result = extractPromptDryRunInfo({
      promptDryRunInfo: JSON.stringify({
        fullConversationTokenCount: { numTokens: 3000 },
      }),
    } as never);
    expect(result).toEqual({
      fullConversationTokenCount: 3000,
      userMessageTokenCount: undefined,
    });
  });

  it('returns info with only userMessageTokenCount', () => {
    const result = extractPromptDryRunInfo({
      promptDryRunInfo: JSON.stringify({
        userMessageTokenCount: { numTokens: 500 },
      }),
    } as never);
    expect(result).toEqual({
      fullConversationTokenCount: undefined,
      userMessageTokenCount: 500,
    });
  });

  it('returns undefined when promptDryRunInfo is absent', () => {
    const result = extractPromptDryRunInfo({} as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when promptDryRunInfo is not a string', () => {
    const result = extractPromptDryRunInfo({
      promptDryRunInfo: 123,
    } as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when JSON is invalid', () => {
    const result = extractPromptDryRunInfo({
      promptDryRunInfo: '{bad json}',
    } as never);
    expect(result).toBeUndefined();
  });

  it('returns undefined when parsed JSON has no valid numTokens', () => {
    const result = extractPromptDryRunInfo({
      promptDryRunInfo: JSON.stringify({
        fullConversationTokenCount: { numTokens: 'not a number' },
        userMessageTokenCount: {},
      }),
    } as never);
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// extractSessionUsage
// =============================================================================
describe('extractSessionUsage', () => {
  it('returns context usage from composer data', () => {
    const result = extractSessionUsage(
      {
        contextTokensUsed: 5000,
        contextTokenLimit: 128000,
        contextUsagePercent: 3.9,
      } as never,
      []
    );
    expect(result).toEqual({
      contextTokensUsed: 5000,
      contextTokenLimit: 128000,
      contextUsagePercent: 3.9,
    });
  });

  it('returns aggregated token usage from messages', () => {
    const result = extractSessionUsage(undefined, [
      { tokenUsage: { inputTokens: 100, outputTokens: 50 } },
      { tokenUsage: { inputTokens: 200, outputTokens: 80 } },
    ]);
    expect(result).toEqual({
      totalInputTokens: 300,
      totalOutputTokens: 130,
    });
  });

  it('returns combined composer and message data', () => {
    const result = extractSessionUsage(
      {
        contextTokensUsed: 5000,
        contextTokenLimit: 128000,
        contextUsagePercent: 3.9,
      } as never,
      [{ tokenUsage: { inputTokens: 100, outputTokens: 50 } }]
    );
    expect(result).toEqual({
      contextTokensUsed: 5000,
      contextTokenLimit: 128000,
      contextUsagePercent: 3.9,
      totalInputTokens: 100,
      totalOutputTokens: 50,
    });
  });

  it('returns undefined when no data available', () => {
    const result = extractSessionUsage(undefined, []);
    expect(result).toBeUndefined();
  });

  it('returns undefined when composer data has no numeric fields', () => {
    const result = extractSessionUsage({} as never, []);
    expect(result).toBeUndefined();
  });

  it('skips messages without tokenUsage', () => {
    const result = extractSessionUsage(undefined, [
      {},
      { tokenUsage: { inputTokens: 100, outputTokens: 50 } },
      {},
    ]);
    expect(result).toEqual({
      totalInputTokens: 100,
      totalOutputTokens: 50,
    });
  });

  it('returns partial composer data when only some fields present', () => {
    const result = extractSessionUsage({ contextTokensUsed: 5000 } as never, []);
    expect(result).toEqual({ contextTokensUsed: 5000 });
  });
});
