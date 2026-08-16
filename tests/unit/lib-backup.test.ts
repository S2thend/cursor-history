import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core backup module
const mockCoreCreateBackup = vi.fn();
const mockCoreRestoreBackup = vi.fn();
const mockCoreValidateBackup = vi.fn();
const mockCoreListBackups = vi.fn();
const mockCoreGetDefaultBackupDir = vi.fn();

vi.mock('../../src/core/backup.js', () => ({
  createBackup: (...args: unknown[]) => mockCoreCreateBackup(...args),
  restoreBackup: (...args: unknown[]) => mockCoreRestoreBackup(...args),
  validateBackup: (...args: unknown[]) => mockCoreValidateBackup(...args),
  listBackups: (...args: unknown[]) => mockCoreListBackups(...args),
  getDefaultBackupDir: (...args: unknown[]) => mockCoreGetDefaultBackupDir(...args),
}));

import {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir,
} from '../../src/lib/backup.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// createBackup
// =============================================================================
describe('createBackup', () => {
  it('delegates to core createBackup without config', async () => {
    const mockResult = {
      success: true,
      backupPath: '/home/user/cursor-history-backups/2024-01-15.zip',
      manifest: {
        version: '1.0',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        cursorVersion: '0.43.2',
        stats: {
          sessionCount: 5,
          messageCount: 42,
          totalSizeBytes: 1024000,
        },
      },
      durationMs: 5000,
    };
    mockCoreCreateBackup.mockResolvedValue(mockResult);

    const result = await createBackup();

    expect(mockCoreCreateBackup).toHaveBeenCalledWith(undefined);
    expect(result).toEqual(mockResult);
  });

  it('delegates to core createBackup with config', async () => {
    const config = {
      outputPath: '/custom/path/backup.zip',
      force: true,
      sharedPermissions: true,
      sourceReadLimits: { zipEntryCount: 10 },
    };
    const mockResult = {
      success: true,
      backupPath: '/custom/path/backup.zip',
      manifest: {
        version: '1.0',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        cursorVersion: '0.43.2',
        stats: {
          sessionCount: 5,
          messageCount: 42,
          totalSizeBytes: 1024000,
        },
      },
      durationMs: 5000,
    };
    mockCoreCreateBackup.mockResolvedValue(mockResult);

    const result = await createBackup(config);

    expect(mockCoreCreateBackup).toHaveBeenCalledWith(config);
    expect(result).toEqual(mockResult);
  });

  it('passes onProgress callback to core', async () => {
    const onProgress = vi.fn();
    const config = { onProgress };
    const mockResult = {
      success: true,
      backupPath: '/home/user/cursor-history-backups/2024-01-15.zip',
      manifest: {
        version: '1.0',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        cursorVersion: '0.43.2',
        stats: {
          sessionCount: 5,
          messageCount: 42,
          totalSizeBytes: 1024000,
        },
      },
      durationMs: 5000,
    };
    mockCoreCreateBackup.mockResolvedValue(mockResult);

    await createBackup(config);

    expect(mockCoreCreateBackup).toHaveBeenCalledWith(config);
  });
});

// =============================================================================
// restoreBackup
// =============================================================================
describe('restoreBackup', () => {
  it('delegates to core restoreBackup with config', async () => {
    const config = {
      backupPath: '/path/to/backup.zip',
      force: true,
      sourceReadLimits: { zipEntryCount: 10 },
    };
    const mockResult = {
      success: true,
      targetPath: '/home/user/.cursor',
      filesRestored: 42,
      warnings: [],
      durationMs: 3000,
    };
    mockCoreRestoreBackup.mockResolvedValue(mockResult);

    const result = await restoreBackup(config);

    expect(mockCoreRestoreBackup).toHaveBeenCalledWith(config);
    expect(result).toEqual(mockResult);
  });

  it('handles restore with progress callback', async () => {
    const onProgress = vi.fn();
    const config = {
      backupPath: '/path/to/backup.zip',
      onProgress,
    };
    const mockResult = {
      success: true,
      targetPath: '/home/user/.cursor',
      filesRestored: 42,
      warnings: [],
      durationMs: 3000,
    };
    mockCoreRestoreBackup.mockResolvedValue(mockResult);

    await restoreBackup(config);

    expect(mockCoreRestoreBackup).toHaveBeenCalledWith(config);
  });

  it('returns restore result with warnings', async () => {
    const config = {
      backupPath: '/path/to/backup.zip',
    };
    const mockResult = {
      success: true,
      targetPath: '/home/user/.cursor',
      filesRestored: 40,
      warnings: ['file1.db: checksum mismatch', 'file2.db: size mismatch'],
      durationMs: 3000,
    };
    mockCoreRestoreBackup.mockResolvedValue(mockResult);

    const result = await restoreBackup(config);

    expect(result.warnings).toHaveLength(2);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// validateBackup
// =============================================================================
describe('validateBackup', () => {
  it('delegates to core validateBackup with backupPath', async () => {
    const backupPath = '/path/to/backup.zip';
    const mockValidation = {
      status: 'valid' as const,
      manifest: {
        version: '1.0',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        cursorVersion: '0.43.2',
        stats: {
          sessionCount: 5,
          messageCount: 42,
          totalSizeBytes: 1024000,
        },
      },
      validFiles: ['file1.db', 'file2.db'],
      corruptedFiles: [],
      missingFiles: [],
      errors: [],
    };
    mockCoreValidateBackup.mockResolvedValue(mockValidation);

    const result = await validateBackup(backupPath);

    expect(mockCoreValidateBackup).toHaveBeenCalledWith(backupPath, undefined);
    expect(result).toEqual(mockValidation);
  });

  it('returns valid status with manifest', async () => {
    const backupPath = '/path/to/backup.zip';
    const mockValidation = {
      status: 'valid' as const,
      manifest: {
        version: '1.0',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        cursorVersion: '0.43.2',
        stats: {
          sessionCount: 5,
          messageCount: 42,
          totalSizeBytes: 1024000,
        },
      },
      validFiles: ['file1.db', 'file2.db'],
      corruptedFiles: [],
      missingFiles: [],
      errors: [],
    };
    mockCoreValidateBackup.mockResolvedValue(mockValidation);

    const result = await validateBackup(backupPath);

    expect(result.status).toBe('valid');
    expect(result.manifest).toBeDefined();
    expect(result.corruptedFiles).toHaveLength(0);
  });

  it('returns invalid status with errors', async () => {
    const backupPath = '/path/to/corrupted.zip';
    const mockValidation = {
      status: 'invalid' as const,
      validFiles: [],
      corruptedFiles: ['file1.db', 'file2.db'],
      missingFiles: ['manifest.json'],
      errors: ['Manifest not found', 'Checksum mismatch: file1.db'],
    };
    mockCoreValidateBackup.mockResolvedValue(mockValidation);

    const result = await validateBackup(backupPath);

    expect(result.status).toBe('invalid');
    expect(result.errors).toHaveLength(2);
    expect(result.corruptedFiles).toHaveLength(2);
  });

  it('passes source limits and cancellation through validation unchanged', async () => {
    const controller = new AbortController();
    const options = {
      sourceReadLimits: { zipEntryCount: 5 },
      signal: controller.signal,
    };
    mockCoreValidateBackup.mockResolvedValue({
      status: 'valid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [],
    });

    await validateBackup('/path/to/backup.zip', options);
    expect(mockCoreValidateBackup).toHaveBeenCalledWith('/path/to/backup.zip', options);
  });
});

// =============================================================================
// listBackups
// =============================================================================
describe('listBackups', () => {
  it('delegates to core listBackups without directory', async () => {
    const mockBackups = [
      {
        filePath: '/home/user/cursor-history-backups/backup-1.zip',
        filename: 'backup-1.zip',
        fileSize: 1024000,
        modifiedAt: new Date('2024-01-15T10:00:00Z'),
        manifest: {
          version: '1.0',
          createdAt: new Date('2024-01-15T10:00:00Z'),
          cursorVersion: '0.43.2',
          stats: {
            sessionCount: 5,
            messageCount: 42,
            totalSizeBytes: 1024000,
          },
        },
      },
    ];
    mockCoreListBackups.mockResolvedValue(mockBackups);

    const result = await listBackups();

    expect(mockCoreListBackups).toHaveBeenCalledWith(undefined, undefined);
    expect(result).toEqual(mockBackups);
  });

  it('delegates to core listBackups with custom directory', async () => {
    const directory = '/custom/backups';
    const mockBackups = [
      {
        filePath: '/custom/backups/backup-1.zip',
        filename: 'backup-1.zip',
        fileSize: 1024000,
        modifiedAt: new Date('2024-01-15T10:00:00Z'),
      },
    ];
    mockCoreListBackups.mockResolvedValue(mockBackups);

    const result = await listBackups(directory);

    expect(mockCoreListBackups).toHaveBeenCalledWith(directory, undefined);
    expect(result).toEqual(mockBackups);
  });

  it('returns empty array when no backups found', async () => {
    mockCoreListBackups.mockResolvedValue([]);

    const result = await listBackups();

    expect(result).toEqual([]);
  });

  it('returns backup info with optional manifest', async () => {
    const mockBackups = [
      {
        filePath: '/home/user/cursor-history-backups/valid.zip',
        filename: 'valid.zip',
        fileSize: 2048000,
        modifiedAt: new Date('2024-01-15T10:00:00Z'),
        manifest: {
          version: '1.0',
          createdAt: new Date('2024-01-15T10:00:00Z'),
          cursorVersion: '0.43.2',
          stats: {
            sessionCount: 10,
            messageCount: 100,
            totalSizeBytes: 2048000,
          },
        },
      },
      {
        filePath: '/home/user/cursor-history-backups/invalid.zip',
        filename: 'invalid.zip',
        fileSize: 512000,
        modifiedAt: new Date('2024-01-14T10:00:00Z'),
      },
    ];
    mockCoreListBackups.mockResolvedValue(mockBackups);

    const result = await listBackups();

    expect(result).toHaveLength(2);
    expect(result[0]!.manifest).toBeDefined();
    expect(result[1]!.manifest).toBeUndefined();
  });

  it('passes source limits and cancellation through listing unchanged', async () => {
    const controller = new AbortController();
    const options = {
      sourceReadLimits: { zipCompressedBytes: 1024 },
      signal: controller.signal,
    };
    mockCoreListBackups.mockResolvedValue([]);

    await listBackups('/backups', options);
    expect(mockCoreListBackups).toHaveBeenCalledWith('/backups', options);
  });
});

// =============================================================================
// getDefaultBackupDir
// =============================================================================
describe('getDefaultBackupDir', () => {
  it('delegates to core getDefaultBackupDir', () => {
    const expectedPath = '/home/user/cursor-history-backups';
    mockCoreGetDefaultBackupDir.mockReturnValue(expectedPath);

    const result = getDefaultBackupDir();

    expect(mockCoreGetDefaultBackupDir).toHaveBeenCalled();
    expect(result).toBe(expectedPath);
  });

  it('returns platform-specific default path', () => {
    const linuxPath = '/home/user/cursor-history-backups';
    mockCoreGetDefaultBackupDir.mockReturnValue(linuxPath);

    const result = getDefaultBackupDir();

    expect(result).toBe(linuxPath);
    expect(result).toContain('cursor-history-backups');
  });
});
