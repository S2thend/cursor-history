import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mock node:fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
  };
});

// Mock database registry
vi.mock('../../src/core/database/registry.js', () => ({
  registry: {
    openSync: vi.fn(() => ({
      prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() })),
      close: vi.fn(),
    })),
  },
}));

// Mock database index
vi.mock('../../src/core/database/index.js', () => ({
  backupDatabase: vi.fn().mockResolvedValue(undefined),
  ensureDriver: vi.fn().mockResolvedValue(undefined),
}));

// Mock jszip - vi.hoisted ensures variables are available in hoisted vi.mock
const { mockZipFile, mockZipGenerateAsync, mockZipLoadAsync } = vi.hoisted(() => ({
  mockZipFile: vi.fn(),
  mockZipGenerateAsync: vi.fn(),
  mockZipLoadAsync: vi.fn(),
}));

vi.mock('jszip', () => {
  function MockJSZip() {
    return {
      file: mockZipFile,
      generateAsync: mockZipGenerateAsync,
    };
  }
  MockJSZip.loadAsync = mockZipLoadAsync;
  return { default: MockJSZip };
});

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  getDefaultBackupDir,
  computeChecksum,
  generateBackupFilename,
  scanDatabaseFiles,
  createManifest,
  checkDiskSpace,
  readBackupManifest,
  listBackups,
  validateBackup,
  createBackup,
  restoreBackup,
  openBackupDatabase,
} from '../../src/core/backup.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// getDefaultBackupDir
// =============================================================================
describe('getDefaultBackupDir', () => {
  it('returns path under home directory', () => {
    const result = getDefaultBackupDir();
    expect(result).toBe(join(homedir(), 'cursor-history-backups'));
  });
});

// =============================================================================
// computeChecksum
// =============================================================================
describe('computeChecksum', () => {
  it('returns sha256 prefixed checksum', () => {
    const buffer = Buffer.from('hello world');
    const result = computeChecksum(buffer);
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces consistent results for same input', () => {
    const buffer = Buffer.from('test data');
    expect(computeChecksum(buffer)).toBe(computeChecksum(buffer));
  });

  it('produces different results for different input', () => {
    expect(computeChecksum(Buffer.from('a'))).not.toBe(computeChecksum(Buffer.from('b')));
  });
});

// =============================================================================
// generateBackupFilename
// =============================================================================
describe('generateBackupFilename', () => {
  it('returns filename with correct format', () => {
    const filename = generateBackupFilename();
    expect(filename).toMatch(/^cursor_history_backup_\d{4}-\d{2}-\d{2}_\d{6}\.zip$/);
  });
});

// =============================================================================
// scanDatabaseFiles
// =============================================================================
describe('scanDatabaseFiles', () => {
  it('returns empty when no files exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = scanDatabaseFiles('/data/workspaceStorage');
    expect(result).toEqual([]);
  });

  it('finds globalStorage and workspace databases', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'ws1', isDirectory: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as ReturnType<typeof statSync>);

    const result = scanDatabaseFiles('/data/User/workspaceStorage');
    // Should find globalStorage/state.vscdb + workspace db + workspace.json
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((f) => f.type === 'global-db')).toBe(true);
  });

  it('skips non-directory entries', () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      return !path.includes('globalStorage') && path.includes('workspaceStorage');
    });
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'file.txt', isDirectory: () => false } as unknown as ReturnType<
        typeof readdirSync
      >[0],
    ]);

    const result = scanDatabaseFiles('/data/workspaceStorage');
    expect(result.filter((f) => f.type === 'workspace-db')).toHaveLength(0);
  });
});

// =============================================================================
// createManifest
// =============================================================================
describe('createManifest', () => {
  it('creates manifest with correct fields', () => {
    const files = [
      { path: 'test.db', size: 100, checksum: 'sha256:abc', type: 'global-db' as const },
    ];
    const stats = { totalSize: 100, sessionCount: 5, workspaceCount: 2 };
    const manifest = createManifest(files, stats);

    expect(manifest.version).toBe('1.0.0');
    expect(manifest.createdAt).toBeDefined();
    // Platform should match the actual OS
    const expectedPlatform =
      process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
    expect(manifest.sourcePlatform).toBe(expectedPlatform);
    expect(manifest.files).toEqual(files);
    expect(manifest.stats).toEqual(stats);
  });
});

// =============================================================================
// checkDiskSpace
// =============================================================================
describe('checkDiskSpace', () => {
  it('returns sufficient when directory can be created', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const result = checkDiskSpace('/output/backup.zip', 1024);
    expect(result.sufficient).toBe(true);
    expect(result.required).toBe(1024);
  });

  it('returns insufficient when directory creation fails', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = checkDiskSpace('/noperm/backup.zip', 1024);
    expect(result.sufficient).toBe(false);
  });
});

// =============================================================================
// readBackupManifest
// =============================================================================
describe('readBackupManifest', () => {
  it('returns manifest from valid backup', async () => {
    const manifest = { version: '1.0.0', files: [] };
    const manifestBuffer = Buffer.from(JSON.stringify(manifest));

    vi.mocked(readFile).mockResolvedValue(Buffer.from('zipdata'));
    mockZipLoadAsync.mockResolvedValue({
      file: vi.fn((name: string) => {
        if (name === 'manifest.json') {
          return { async: vi.fn().mockResolvedValue(manifestBuffer) };
        }
        return null;
      }),
    });

    const result = await readBackupManifest('/backup.zip');
    expect(result).not.toBeNull();
    expect(result!.version).toBe('1.0.0');
  });

  it('returns null when manifest missing', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('zipdata'));
    mockZipLoadAsync.mockResolvedValue({
      file: vi.fn(() => null),
    });

    const result = await readBackupManifest('/backup.zip');
    expect(result).toBeNull();
  });

  it('returns null on error', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('file not found'));
    const result = await readBackupManifest('/nonexistent.zip');
    expect(result).toBeNull();
  });
});

// =============================================================================
// validateBackup
// =============================================================================
describe('validateBackup', () => {
  it('returns invalid when file does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await validateBackup('/nonexistent.zip');
    expect(result.status).toBe('invalid');
    expect(result.errors).toHaveLength(1);
  });

  it('returns invalid when zip is corrupt', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(Buffer.from('not a zip'));
    mockZipLoadAsync.mockRejectedValue(new Error('Bad zip'));

    const result = await validateBackup('/bad.zip');
    expect(result.status).toBe('invalid');
    expect(result.errors[0]).toContain('Invalid zip');
  });

  it('returns invalid when manifest is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(Buffer.from('zipdata'));
    mockZipLoadAsync.mockResolvedValue({
      file: vi.fn(() => null),
    });

    const result = await validateBackup('/no-manifest.zip');
    expect(result.status).toBe('invalid');
    expect(result.errors[0]).toContain('Manifest');
  });

  it('returns valid when all checksums match', async () => {
    const fileContent = Buffer.from('database content');
    const checksum = computeChecksum(fileContent);
    const manifest = {
      version: '1.0.0',
      files: [{ path: 'test.db', size: fileContent.length, checksum, type: 'global-db' }],
    };

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(Buffer.from('zipdata'));
    mockZipLoadAsync.mockResolvedValue({
      file: vi.fn((name: string) => {
        if (name === 'manifest.json') {
          return { async: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(manifest))) };
        }
        if (name === 'test.db') {
          return { async: vi.fn().mockResolvedValue(fileContent) };
        }
        return null;
      }),
    });

    const result = await validateBackup('/valid.zip');
    expect(result.status).toBe('valid');
    expect(result.validFiles).toContain('test.db');
  });
});

// =============================================================================
// listBackups
// =============================================================================
describe('listBackups', () => {
  it('returns empty when directory does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await listBackups('/nonexistent');
    expect(result).toEqual([]);
  });

  it('lists zip files in directory', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'backup1.zip', isFile: () => true } as unknown as ReturnType<typeof readdirSync>[0],
      { name: 'readme.txt', isFile: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(statSync).mockReturnValue({
      size: 5000,
      mtime: new Date('2024-01-15'),
    } as ReturnType<typeof statSync>);
    vi.mocked(readFile).mockRejectedValue(new Error('mock'));

    const result = await listBackups('/backups');
    expect(result).toHaveLength(1);
    expect(result[0]!.filename).toBe('backup1.zip');
    expect(result[0]!.fileSize).toBe(5000);
  });
});

// =============================================================================
// createBackup
// =============================================================================
describe('createBackup', () => {
  it('returns failure when file exists and force is false', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const result = await createBackup({ outputPath: '/existing.zip', force: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('returns failure when no database files found', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      // Output dir exists, output file does not, no DB files
      if (path.endsWith('.zip')) return false;
      if (path.includes('globalStorage')) return false;
      if (path.includes('workspaceStorage') && path.endsWith('workspaceStorage')) return false;
      return true; // output dir exists
    });

    const result = await createBackup({ outputPath: '/backups/test.zip' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No Cursor data found');
  });

  it('calls progress callback during backup', async () => {
    const progress = vi.fn();
    // Make it find no DB files quickly
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('.zip')) return false;
      if (path.includes('globalStorage')) return false;
      return !path.includes('state.vscdb');
    });

    await createBackup({ outputPath: '/backups/test.zip', onProgress: progress });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'scanning' }));
  });

  it('creates backup with database files', async () => {
    vi.mocked(mkdirSync).mockImplementation(() => undefined as unknown as string);
    // Setup: global DB exists, 1 workspace
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('.zip')) return false; // output doesn't exist yet
      return true; // everything else exists
    });
    vi.mocked(readdirSync).mockImplementation((_p, _opts) => {
      return [
        { name: 'ws1', isDirectory: () => true, isFile: () => false } as unknown as ReturnType<
          typeof readdirSync
        >[0],
      ];
    });
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue(Buffer.from('database-content'));

    const { writeFile: mockWriteFile } = await import('node:fs/promises');
    vi.mocked(mockWriteFile).mockResolvedValue(undefined);
    mockZipGenerateAsync.mockResolvedValue(Buffer.from('zipdata'));

    const result = await createBackup({ outputPath: '/backups/test.zip' });
    expect(result.success).toBe(true);
    expect(result.manifest.files.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// restoreBackup
// =============================================================================
describe('restoreBackup', () => {
  it('returns failure for invalid backup', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // backup file doesn't exist

    const result = await restoreBackup({ backupPath: '/nonexistent.zip' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Backup file not found');
  });

  it('returns failure when target has existing data and force is false', async () => {
    const fileContent = Buffer.from('database content');
    const checksum = computeChecksum(fileContent);
    const manifest = {
      version: '1.0.0',
      files: [
        {
          path: 'globalStorage/state.vscdb',
          size: fileContent.length,
          checksum,
          type: 'global-db',
        },
      ],
    };

    vi.mocked(existsSync).mockReturnValue(true); // both backup and target exist
    vi.mocked(readFile).mockResolvedValue(Buffer.from('zipdata'));
    mockZipLoadAsync.mockResolvedValue({
      file: vi.fn((name: string) => {
        if (name === 'manifest.json') {
          return { async: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(manifest))) };
        }
        if (name === 'globalStorage/state.vscdb') {
          return { async: vi.fn().mockResolvedValue(fileContent) };
        }
        return null;
      }),
    });

    const result = await restoreBackup({ backupPath: '/backup.zip', force: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already has Cursor data');
  });
});
