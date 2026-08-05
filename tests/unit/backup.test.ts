import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import packageJson from '../../package.json';

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
    chmodSync: vi.fn(),
    closeSync: vi.fn(),
    copyFileSync: vi.fn(),
    fsyncSync: vi.fn(),
    linkSync: vi.fn(),
    lstatSync: vi.fn(),
    openSync: vi.fn(() => 42),
    renameSync: vi.fn(),
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

const {
  createPrivateTempWorkspaceMock,
  disposePrivateTempWorkspaceMock,
  openBoundedZipArchiveMock,
  prepareZipFileInputsMock,
  writeBoundedZipArchiveMock,
} = vi.hoisted(() => ({
  createPrivateTempWorkspaceMock: vi.fn(),
  disposePrivateTempWorkspaceMock: vi.fn(),
  openBoundedZipArchiveMock: vi.fn(),
  prepareZipFileInputsMock: vi.fn(),
  writeBoundedZipArchiveMock: vi.fn(),
}));

vi.mock('../../src/core/private-temp.js', () => ({
  createPrivateTempWorkspace: createPrivateTempWorkspaceMock,
}));

vi.mock('../../src/core/zip-stream.js', () => {
  class MockZipArchiveFormatError extends Error {
    override readonly name = 'ZipArchiveFormatError';
  }
  return {
    BoundedZipArchive: class {},
    ZipArchiveFormatError: MockZipArchiveFormatError,
    openBoundedZipArchive: openBoundedZipArchiveMock,
    prepareZipFileInputs: prepareZipFileInputsMock,
    writeBoundedZipArchive: writeBoundedZipArchiveMock,
  };
});

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
} from '../../src/core/backup.js';

beforeEach(() => {
  vi.clearAllMocks();
  createPrivateTempWorkspaceMock.mockReturnValue({
    path: '/private-workspace',
    marker: {},
    state: 'open',
    createFile: vi.fn((name: string) => `/private-workspace/${name}`),
    register: vi.fn(),
    dispose: disposePrivateTempWorkspaceMock,
  });
  prepareZipFileInputsMock.mockImplementation(
    async (inputs: Array<{ name: string; sourcePath: string }>) =>
      inputs.map((input, index) => ({
        ...input,
        size: index + 1,
        crc32: index + 1,
        checksum: `sha256:${String(index + 1).padStart(64, '0')}`,
      }))
  );
  writeBoundedZipArchiveMock.mockResolvedValue({ archiveSize: 1, entryCount: 1 });
  const missing = Object.assign(new Error('missing archive'), { code: 'ENOENT' });
  openBoundedZipArchiveMock.mockRejectedValue(missing);
});

function mockArchive(entries: Readonly<Record<string, Buffer>>) {
  return {
    entries: Object.entries(entries).map(([name, data]) => ({
      name,
      isDirectory: false,
      uncompressedSize: data.length,
    })),
    getEntry: vi.fn((name: string) => {
      const data = entries[name];
      return data ? { name, isDirectory: false, uncompressedSize: data.length } : undefined;
    }),
    readEntryBuffer: vi.fn(async (name: string) => entries[name]),
    checksumEntry: vi.fn(async (name: string) => ({
      entry: { name, isDirectory: false, uncompressedSize: entries[name]!.length },
      checksum: computeChecksum(entries[name]!),
    })),
    extractEntryToFile: vi.fn(),
    extractEntryToFileWithChecksum: vi.fn(async (name: string) => ({
      entry: { name, isDirectory: false, uncompressedSize: entries[name]!.length },
      checksum: computeChecksum(entries[name]!),
    })),
    close: vi.fn(),
  };
}

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
    expect(manifest.producer).toBe(packageJson.version);
    expect(manifest.cursorHistoryVersion).toBe(packageJson.version);
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
    openBoundedZipArchiveMock.mockResolvedValue(mockArchive({ 'manifest.json': manifestBuffer }));

    const result = await readBackupManifest('/backup.zip');
    expect(result).not.toBeNull();
    expect(result!.version).toBe('1.0.0');
    expect(result!.producer).toBeUndefined();
  });

  it('returns null when manifest missing', async () => {
    openBoundedZipArchiveMock.mockResolvedValue(mockArchive({}));

    const result = await readBackupManifest('/backup.zip');
    expect(result).toBeNull();
  });

  it('returns null on error', async () => {
    const result = await readBackupManifest('/nonexistent.zip');
    expect(result).toBeNull();
  });

  it('propagates immutable source-read options to the bounded ZIP open', async () => {
    const controller = new AbortController();
    const archive = mockArchive({});
    openBoundedZipArchiveMock.mockResolvedValue(archive);
    const options = {
      sourceReadLimits: { zipEntryCount: 7 },
      signal: controller.signal,
    };

    await readBackupManifest('/backup.zip', options);
    expect(openBoundedZipArchiveMock).toHaveBeenCalledWith(
      '/backup.zip',
      expect.objectContaining({
        signal: controller.signal,
        sourceReadLimits: expect.objectContaining({ zipEntryCount: 7 }),
      })
    );
    expect(Object.isFrozen(openBoundedZipArchiveMock.mock.calls[0]![1]!.sourceReadLimits)).toBe(
      true
    );
    expect(archive.close).toHaveBeenCalledOnce();
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
    openBoundedZipArchiveMock.mockRejectedValue(new Error('Bad zip'));

    const result = await validateBackup('/bad.zip');
    expect(result.status).toBe('invalid');
    expect(result.errors[0]).toContain('Invalid zip');
  });

  it('returns invalid when manifest is missing', async () => {
    openBoundedZipArchiveMock.mockResolvedValue(mockArchive({}));

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

    openBoundedZipArchiveMock.mockResolvedValue(
      mockArchive({
        'manifest.json': Buffer.from(JSON.stringify(manifest)),
        'test.db': fileContent,
      })
    );

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
    vi.mocked(readdirSync).mockImplementation(() => {
      return [
        { name: 'ws1', isDirectory: () => true, isFile: () => false } as unknown as ReturnType<
          typeof readdirSync
        >[0],
      ];
    });
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as ReturnType<typeof statSync>);

    const sourceReadLimits = { zipEntryCount: 10 };
    const result = await createBackup({
      outputPath: '/backups/test.zip',
      sourceReadLimits,
      sharedPermissions: true,
    });
    expect(result.success).toBe(true);
    expect(result.manifest.files.length).toBeGreaterThan(0);
    expect(result.manifest.producer).toBe(packageJson.version);
    expect(prepareZipFileInputsMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        sourceReadLimits: expect.objectContaining(sourceReadLimits),
      })
    );
    const preparedPolicy = prepareZipFileInputsMock.mock.calls[0]![1]!.sourceReadLimits;
    expect(Object.isFrozen(preparedPolicy)).toBe(true);
    expect(writeBoundedZipArchiveMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.cursor-history-backup-/u),
      expect.arrayContaining([expect.objectContaining({ name: 'manifest.json' })]),
      expect.objectContaining({ sourceReadLimits: preparedPolicy })
    );
  });

  it('copies and freezes one effective source policy before progress callbacks can mutate input', async () => {
    vi.mocked(mkdirSync).mockImplementation(() => undefined as unknown as string);
    vi.mocked(existsSync).mockImplementation((path) => !String(path).endsWith('.zip'));
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(statSync).mockReturnValue({ size: 1 } as ReturnType<typeof statSync>);
    const sourceReadLimits = { zipEntryCount: 10 };

    const result = await createBackup({
      outputPath: '/backups/frozen.zip',
      sourceReadLimits,
      onProgress: () => {
        sourceReadLimits.zipEntryCount = 1;
      },
    });

    expect(result.success).toBe(true);
    const preparePolicy = prepareZipFileInputsMock.mock.calls[0]![1]!.sourceReadLimits;
    const writePolicy = writeBoundedZipArchiveMock.mock.calls[0]![2]!.sourceReadLimits;
    expect(preparePolicy).toBe(writePolicy);
    expect(Object.isFrozen(preparePolicy)).toBe(true);
    expect(preparePolicy?.zipEntryCount).toBe(10);
    expect(sourceReadLimits.zipEntryCount).toBe(1);
  });

  it('rejects invalid source limits before filesystem discovery or archive output', async () => {
    await expect(
      createBackup({
        outputPath: '/backups/test.zip',
        sourceReadLimits: { zipEntryBytes: 2, zipAggregateBytes: 1 },
      })
    ).rejects.toMatchObject({ code: 'SOURCE_LIMIT_CONFIGURATION_INVALID' });
    expect(existsSync).not.toHaveBeenCalled();
    expect(prepareZipFileInputsMock).not.toHaveBeenCalled();
    expect(writeBoundedZipArchiveMock).not.toHaveBeenCalled();
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
    openBoundedZipArchiveMock.mockResolvedValue(
      mockArchive({
        'manifest.json': Buffer.from(JSON.stringify(manifest)),
        'globalStorage/state.vscdb': fileContent,
      })
    );

    const sourceReadLimits = { zipEntryCount: 8 };
    const result = await restoreBackup({
      backupPath: '/backup.zip',
      force: false,
      sourceReadLimits,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already has Cursor data');
    expect(openBoundedZipArchiveMock).toHaveBeenCalledWith(
      '/backup.zip',
      expect.objectContaining({
        sourceReadLimits: expect.objectContaining(sourceReadLimits),
      })
    );
  });

  it('freezes the restore policy before a validating callback mutates the caller override', async () => {
    const fileContent = Buffer.from('database content');
    const manifest = {
      version: '1.0.0',
      files: [
        {
          path: 'globalStorage/state.vscdb',
          size: fileContent.length,
          checksum: computeChecksum(fileContent),
          type: 'global-db',
        },
      ],
    };
    vi.mocked(existsSync).mockReturnValue(false);
    openBoundedZipArchiveMock.mockResolvedValue(
      mockArchive({
        'manifest.json': Buffer.from(JSON.stringify(manifest)),
        'globalStorage/state.vscdb': fileContent,
      })
    );
    const sourceReadLimits = { zipEntryCount: 8 };

    const result = await restoreBackup({
      backupPath: '/backup.zip',
      targetPath: '/target/User/workspaceStorage',
      sourceReadLimits,
      onProgress: () => {
        sourceReadLimits.zipEntryCount = 1;
      },
    });

    expect(result.success).toBe(true);
    const policy = openBoundedZipArchiveMock.mock.calls[0]![1]!.sourceReadLimits;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy?.zipEntryCount).toBe(8);
    expect(sourceReadLimits.zipEntryCount).toBe(1);
  });
});

describe('listBackups immutable policy', () => {
  it('reuses one frozen effective policy when caller input mutates between archive awaits', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      { name: 'one.zip', isFile: () => true } as unknown as ReturnType<typeof readdirSync>[0],
      { name: 'two.zip', isFile: () => true } as unknown as ReturnType<typeof readdirSync>[0],
    ]);
    vi.mocked(statSync).mockReturnValue({
      size: 1,
      mtime: new Date('2024-01-01'),
    } as ReturnType<typeof statSync>);
    const sourceReadLimits = { zipEntryCount: 8 };
    const policies: unknown[] = [];
    openBoundedZipArchiveMock.mockImplementation(async () => {
      const policy = openBoundedZipArchiveMock.mock.calls.at(-1)![1]!.sourceReadLimits;
      policies.push(policy);
      sourceReadLimits.zipEntryCount = 1;
      return mockArchive({
        'manifest.json': Buffer.from(
          JSON.stringify({ files: [], stats: { sessionCount: 0, workspaceCount: 0, totalSize: 0 } })
        ),
      });
    });

    expect(await listBackups('/backups', { sourceReadLimits })).toHaveLength(2);
    expect(policies).toHaveLength(2);
    expect(policies[0]).toBe(policies[1]);
    expect(Object.isFrozen(policies[0])).toBe(true);
    expect((policies[0] as { zipEntryCount: number }).zipEntryCount).toBe(8);
    expect(sourceReadLimits.zipEntryCount).toBe(1);
  });
});
