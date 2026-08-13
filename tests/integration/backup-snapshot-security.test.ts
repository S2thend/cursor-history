import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';

import type { Database } from '../../src/core/database/types.js';
import {
  BackupPublishedPermissionError,
  RestoreRollbackError,
  SourceLimitConfigurationError,
  SourceLimitExceededError,
  TemporaryArtifactCleanupError,
} from '../../src/core/errors.js';
import type { SourceReadLimitsOverride, ZipSourceBoundKind } from '../../src/core/types.js';

const {
  backupDatabaseMock,
  openDatabaseMock,
  openSyncMock,
  publicationModeFault,
  restorePublicationCleanupFault,
} = vi.hoisted(() => ({
  backupDatabaseMock: vi.fn(),
  openDatabaseMock: vi.fn(),
  openSyncMock: vi.fn(),
  publicationModeFault: { enabled: false },
  restorePublicationCleanupFault: { enabled: false },
}));

vi.mock('../../src/core/database/registry.js', () => ({
  registry: {
    openSync: openSyncMock,
  },
}));

vi.mock('../../src/core/database/index.js', () => ({
  backupDatabase: backupDatabaseMock,
  openDatabase: openDatabaseMock,
}));

vi.mock('../../src/core/backup-publication.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/backup-publication.js')>(
    '../../src/core/backup-publication.js'
  );
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    enforcePublishedArchiveMode: (
      outputPath: string,
      requestedMode: number,
      expectedIdentity: import('../../src/core/backup-publication.js').PublishedArchiveIdentity
    ): void => {
      if (!publicationModeFault.enabled) {
        actual.enforcePublishedArchiveMode(outputPath, requestedMode, expectedIdentity);
        return;
      }
      const descriptorOperations = {
        openNoFollow: (path: string) => fs.openSync(path, fs.constants.O_RDONLY),
        statDescriptor: (descriptor: number) => {
          const stat = fs.fstatSync(descriptor, { bigint: true });
          return {
            device: stat.dev,
            inode: stat.ino,
            mode: Number(stat.mode) & 0o777,
            regularFile: stat.isFile(),
          };
        },
        chmodDescriptor: () => {
          throw new Error('synthetic post-publication chmod failure');
        },
        statPathNoFollow: (path: string) => {
          const stat = fs.lstatSync(path, { bigint: true });
          return {
            device: stat.dev,
            inode: stat.ino,
            mode: Number(stat.mode) & 0o777,
            regularFile: stat.isFile(),
          };
        },
        close: (descriptor: number) => fs.closeSync(descriptor),
      };
      actual.enforcePublishedArchiveMode(
        outputPath,
        requestedMode,
        expectedIdentity,
        descriptorOperations
      );
    },
  };
});

vi.mock('../../src/core/restore-publication.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/restore-publication.js')>(
    '../../src/core/restore-publication.js'
  );
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    commitRestorePublication: (
      ...args: Parameters<typeof actual.commitRestorePublication>
    ): ReturnType<typeof actual.commitRestorePublication> => {
      const [publicationPath, destinationPath, replaceExisting, identity, onCommit, operations] =
        args;
      if (!restorePublicationCleanupFault.enabled || replaceExisting || operations !== undefined) {
        return actual.commitRestorePublication(...args);
      }
      return actual.commitRestorePublication(
        publicationPath,
        destinationPath,
        replaceExisting,
        identity,
        onCommit,
        {
          rename: (sourcePath, targetPath) => fs.renameSync(sourcePath, targetPath),
          link: (sourcePath, targetPath) => fs.linkSync(sourcePath, targetPath),
          unlink: () => {
            throw Object.assign(new Error('synthetic restore publication cleanup failure'), {
              code: 'EACCES',
            });
          },
          statPathNoFollow: (path) => fs.lstatSync(path, { bigint: true }),
        }
      );
    },
  };
});

import {
  computeChecksum,
  createBackup,
  openBackupDatabase,
  readBackupManifest,
  restoreBackup,
  validateBackup,
} from '../../src/core/backup.js';
import { openBoundedZipArchive, ZipArchiveFormatError } from '../../src/core/zip-stream.js';
import { SOURCE_READ_LIMITS_V1_DEFAULTS } from '../../src/core/source-read-limits.js';
import { PRIVATE_TEMP_MARKER_FILENAME } from '../../src/core/private-temp.js';

const ZIP_TEMP_PREFIXES = [
  'cursor-history-backup-create-',
  'cursor-history-backup-read-',
  'cursor-history-restore-',
] as const;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip64Extra(values: readonly bigint[]): Buffer {
  const result = Buffer.alloc(4 + values.length * 8);
  result.writeUInt16LE(0x0001, 0);
  result.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => result.writeBigUInt64LE(value, 4 + index * 8));
  return result;
}

interface ZipFixtureEntry {
  readonly name: string;
  readonly data?: Buffer;
  readonly method?: number;
  readonly flags?: number;
  readonly centralName?: string;
  readonly claimedCrc?: number;
  readonly localCrc?: number;
  readonly centralCrc?: number;
  readonly claimedCompressedSize?: number;
  readonly localCompressedSize?: number;
  readonly centralCompressedSize?: number;
  readonly claimedUncompressedSize?: number;
  readonly localUncompressedSize?: number;
  readonly centralUncompressedSize?: number;
  readonly localCompressedHeaderValue?: number;
  readonly localUncompressedHeaderValue?: number;
  readonly localExtraOverride?: Buffer;
  readonly descriptorSignature?: boolean;
  readonly descriptorCrc?: number;
  readonly descriptorCompressedSize?: number;
  readonly descriptorUncompressedSize?: number;
  readonly descriptorOverride?: Buffer;
}

interface BuiltZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

function buildZip(
  fixtureEntries: readonly ZipFixtureEntry[],
  options: { zip64?: boolean } = {}
): { buffer: Buffer; entries: BuiltZipEntry[] } {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const builtEntries: BuiltZipEntry[] = [];
  let localOffset = 0;

  for (const fixture of fixtureEntries) {
    const data = fixture.data ?? Buffer.alloc(0);
    const method = fixture.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const flags = fixture.flags ?? 0x0800;
    const localName = Buffer.from(fixture.name, 'utf8');
    const centralName = Buffer.from(fixture.centralName ?? fixture.name, 'utf8');
    const actualCrc = crc32(data);
    const claimedCrc = fixture.claimedCrc ?? actualCrc;
    const localCrc = fixture.localCrc ?? claimedCrc;
    const centralCrc = fixture.centralCrc ?? claimedCrc;
    const claimedCompressed = fixture.claimedCompressedSize ?? compressed.length;
    const localCompressed = fixture.localCompressedSize ?? claimedCompressed;
    const centralCompressed = fixture.centralCompressedSize ?? claimedCompressed;
    const claimedUncompressed = fixture.claimedUncompressedSize ?? data.length;
    const localUncompressed = fixture.localUncompressedSize ?? claimedUncompressed;
    const centralUncompressed = fixture.centralUncompressedSize ?? claimedUncompressed;
    const localExtra =
      fixture.localExtraOverride ??
      (options.zip64
        ? zip64Extra([BigInt(localUncompressed), BigInt(localCompressed)])
        : Buffer.alloc(0));
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(options.zip64 ? 45 : 20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(localCrc, 14);
    localHeader.writeUInt32LE(
      fixture.localCompressedHeaderValue ?? (options.zip64 ? 0xffffffff : localCompressed),
      18
    );
    localHeader.writeUInt32LE(
      fixture.localUncompressedHeaderValue ?? (options.zip64 ? 0xffffffff : localUncompressed),
      22
    );
    localHeader.writeUInt16LE(localName.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    const descriptor = (() => {
      if ((flags & 0x0008) === 0) return Buffer.alloc(0);
      if (fixture.descriptorOverride !== undefined) return fixture.descriptorOverride;
      const hasSignature = fixture.descriptorSignature ?? true;
      const value = Buffer.alloc((options.zip64 ? 20 : 12) + (hasSignature ? 4 : 0));
      let cursor = 0;
      if (hasSignature) {
        value.writeUInt32LE(0x08074b50, cursor);
        cursor += 4;
      }
      value.writeUInt32LE(fixture.descriptorCrc ?? centralCrc, cursor);
      cursor += 4;
      if (options.zip64) {
        value.writeBigUInt64LE(
          BigInt(fixture.descriptorCompressedSize ?? centralCompressed),
          cursor
        );
        cursor += 8;
        value.writeBigUInt64LE(
          BigInt(fixture.descriptorUncompressedSize ?? centralUncompressed),
          cursor
        );
      } else {
        value.writeUInt32LE(fixture.descriptorCompressedSize ?? centralCompressed, cursor);
        cursor += 4;
        value.writeUInt32LE(fixture.descriptorUncompressedSize ?? centralUncompressed, cursor);
      }
      return value;
    })();
    localParts.push(localHeader, localName, localExtra, compressed, descriptor);

    const centralExtra = options.zip64
      ? zip64Extra([BigInt(centralUncompressed), BigInt(centralCompressed), BigInt(localOffset)])
      : Buffer.alloc(0);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(options.zip64 ? 45 : 20, 4);
    centralHeader.writeUInt16LE(options.zip64 ? 45 : 20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(centralCrc, 16);
    centralHeader.writeUInt32LE(options.zip64 ? 0xffffffff : centralCompressed, 20);
    centralHeader.writeUInt32LE(options.zip64 ? 0xffffffff : centralUncompressed, 24);
    centralHeader.writeUInt16LE(centralName.length, 28);
    centralHeader.writeUInt16LE(centralExtra.length, 30);
    centralHeader.writeUInt32LE(options.zip64 ? 0xffffffff : localOffset, 42);
    centralParts.push(centralHeader, centralName, centralExtra);

    builtEntries.push({
      name: fixture.centralName ?? fixture.name,
      compressedSize: compressed.length,
      uncompressedSize: data.length,
    });
    localOffset +=
      localHeader.length +
      localName.length +
      localExtra.length +
      compressed.length +
      descriptor.length;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  if (!options.zip64) {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(fixtureEntries.length, 8);
    eocd.writeUInt16LE(fixtureEntries.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    return { buffer: Buffer.concat([local, central, eocd]), entries: builtEntries };
  }

  const zip64EocdOffset = local.length + central.length;
  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(0x06064b50, 0);
  zip64Eocd.writeBigUInt64LE(44n, 4);
  zip64Eocd.writeUInt16LE(45, 12);
  zip64Eocd.writeUInt16LE(45, 14);
  zip64Eocd.writeBigUInt64LE(BigInt(fixtureEntries.length), 24);
  zip64Eocd.writeBigUInt64LE(BigInt(fixtureEntries.length), 32);
  zip64Eocd.writeBigUInt64LE(BigInt(central.length), 40);
  zip64Eocd.writeBigUInt64LE(BigInt(local.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return {
    buffer: Buffer.concat([local, central, zip64Eocd, locator, eocd]),
    entries: builtEntries,
  };
}

function currentPrivateTempPaths(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => ZIP_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .filter((name) => {
      try {
        const marker = JSON.parse(
          readFileSync(join(tmpdir(), name, PRIVATE_TEMP_MARKER_FILENAME), 'utf8')
        ) as { pid?: unknown };
        return marker.pid === process.pid;
      } catch {
        return false;
      }
    })
    .sort();
}

async function openAndCloseZip(
  path: string,
  sourceReadLimits?: SourceReadLimitsOverride
): Promise<void> {
  const archive = await openBoundedZipArchive(path, { sourceReadLimits });
  await archive.close();
}

async function captureLimitError(action: Promise<unknown>): Promise<SourceLimitExceededError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceLimitExceededError);
    return error as SourceLimitExceededError;
  }
  throw new Error('Expected SourceLimitExceededError.');
}

async function captureConfigurationError(
  action: Promise<unknown>
): Promise<SourceLimitConfigurationError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceLimitConfigurationError);
    return error as SourceLimitConfigurationError;
  }
  throw new Error('Expected SourceLimitConfigurationError.');
}

function expectZipLimit(
  error: SourceLimitExceededError,
  bound: ZipSourceBoundKind,
  unit: 'bytes' | 'records' | 'ratio',
  limit: number
): void {
  expect(error.details).toMatchObject({
    policyVersion: 'source-read-limits/v1',
    sourceKind: 'zip',
    bound,
    unit,
    limit,
    outcome: 'fatal',
    retryableWithOverride: true,
  });
}

function databaseWithClose(close: () => void): Database {
  return {
    prepare: vi.fn(() => ({
      get: vi.fn(() => {
        throw new Error('no such table: ItemTable');
      }),
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    })),
    runSQL: vi.fn(),
    close,
  } as unknown as Database;
}

describe.sequential('backup plaintext snapshot isolation', () => {
  let fixtureRoot: string;
  let archivePath: string;
  let snapshotPath: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    publicationModeFault.enabled = false;
    restorePublicationCleanupFault.enabled = false;
    backupDatabaseMock.mockResolvedValue(undefined);
    openSyncMock.mockImplementation(() => databaseWithClose(vi.fn()));
    openDatabaseMock.mockImplementation(() => databaseWithClose(vi.fn()));
    snapshotPath = undefined;
    fixtureRoot = mkdtempSync(join(tmpdir(), 'cursor-history-backup-security-test-'));
    archivePath = join(fixtureRoot, 'fixture.zip');

    const zip = new JSZip();
    zip.file('globalStorage/state.vscdb', Buffer.from('synthetic sqlite bytes'));
    const archive = await zip.generateAsync({ type: 'nodebuffer' });
    writeFileSync(archivePath, archive, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { force: true, recursive: true });
  });

  it.runIf(process.platform !== 'win32')(
    'platform:posix: confines an open snapshot under umask 000 without changing process or parent modes',
    async () => {
      openDatabaseMock.mockImplementation((path: string) => {
        snapshotPath = path;
        return databaseWithClose(vi.fn());
      });

      const originalUmask = process.umask();
      const parentMode = lstatSync(tmpdir()).mode & 0o777;
      let database: Database | undefined;
      try {
        process.umask(0o000);
        database = await openBackupDatabase(archivePath, 'globalStorage/state.vscdb');

        expect(snapshotPath).toBeDefined();
        const privateDirectory = dirname(snapshotPath!);
        expect(basename(privateDirectory)).toMatch(/^cursor-history-backup-read-/u);
        expect(lstatSync(privateDirectory).mode & 0o777).toBe(0o700);
        expect(lstatSync(snapshotPath!).mode & 0o777).toBe(0o600);
        expect(readFileSync(snapshotPath!)).toEqual(Buffer.from('synthetic sqlite bytes'));
      } finally {
        database?.close();
        process.umask(originalUmask);
      }

      expect(process.umask()).toBe(originalUmask);
      expect(lstatSync(tmpdir()).mode & 0o777).toBe(parentMode);
      expect(existsSync(snapshotPath!)).toBe(false);
      expect(existsSync(dirname(snapshotPath!))).toBe(false);
    }
  );

  it('removes the private workspace when opening the snapshot fails', async () => {
    openDatabaseMock.mockImplementation((path: string) => {
      snapshotPath = path;
      throw new Error('synthetic open failure');
    });

    await expect(openBackupDatabase(archivePath, 'globalStorage/state.vscdb')).rejects.toThrow(
      'synthetic open failure'
    );

    expect(snapshotPath).toBeDefined();
    expect(existsSync(snapshotPath!)).toBe(false);
    expect(existsSync(dirname(snapshotPath!))).toBe(false);
  });

  it('binds the forced provider to the extracted database open without global openSync state', async () => {
    openDatabaseMock.mockImplementation((path: string) => {
      snapshotPath = path;
      return databaseWithClose(vi.fn());
    });

    const database = await openBackupDatabase(archivePath, 'globalStorage/state.vscdb', {
      sqliteDriver: 'better-sqlite3',
    });
    expect(openDatabaseMock).toHaveBeenCalledWith(
      snapshotPath,
      expect.objectContaining({
        operation: 'read-session',
        required: new Set(['read']),
        forcedDriver: 'better-sqlite3',
      })
    );
    expect(openSyncMock).not.toHaveBeenCalled();
    database.close();
  });

  it('honors cancellation that arrives during the operation-bound database open', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    openDatabaseMock.mockImplementation(async (path: string) => {
      snapshotPath = path;
      controller.abort();
      return databaseWithClose(close);
    });

    await expect(
      openBackupDatabase(archivePath, 'globalStorage/state.vscdb', {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
    expect(snapshotPath).toBeDefined();
    expect(existsSync(snapshotPath!)).toBe(false);
    expect(existsSync(dirname(snapshotPath!))).toBe(false);
  });

  it('removes the private workspace even when closing the database fails', async () => {
    openDatabaseMock.mockImplementation((path: string) => {
      snapshotPath = path;
      return databaseWithClose(() => {
        throw new Error('synthetic close failure');
      });
    });

    const database = await openBackupDatabase(archivePath, 'globalStorage/state.vscdb');
    expect(() => database.close()).toThrow('synthetic close failure');

    expect(snapshotPath).toBeDefined();
    expect(existsSync(snapshotPath!)).toBe(false);
    expect(existsSync(dirname(snapshotPath!))).toBe(false);
  });

  it('parses and streams the supported ZIP32 and ZIP64 STORE/DEFLATE subset', async () => {
    for (const zip64 of [false, true]) {
      const fixture = buildZip(
        [
          { name: 'stored.bin', data: Buffer.from('stored') },
          { name: 'deflated.bin', data: Buffer.from('deflated payload'.repeat(20)), method: 8 },
        ],
        { zip64 }
      );
      const path = join(fixtureRoot, zip64 ? 'fixture-zip64.zip' : 'fixture-zip32.zip');
      writeFileSync(path, fixture.buffer, { mode: 0o600 });

      const archive = await openBoundedZipArchive(path);
      try {
        expect(archive.entries.map((entry) => entry.name)).toEqual(['stored.bin', 'deflated.bin']);
        expect(await archive.readEntryBuffer('stored.bin')).toEqual(Buffer.from('stored'));
        expect(await archive.readEntryBuffer('deflated.bin')).toEqual(
          Buffer.from('deflated payload'.repeat(20))
        );
      } finally {
        await archive.close();
      }
    }
  });

  it.each([
    ['ZIP32 with signature', false, true],
    ['ZIP32 without signature', false, false],
    ['ZIP64 with signature', true, true],
    ['ZIP64 without signature', true, false],
  ] as const)('accepts an exact matching %s data descriptor', async (_label, zip64, signature) => {
    const content = Buffer.from('matching descriptor payload');
    const path = join(fixtureRoot, `descriptor-valid-${zip64}-${signature}.zip`);
    writeFileSync(
      path,
      buildZip(
        [
          {
            name: 'entry.bin',
            data: content,
            flags: 0x0808,
            descriptorSignature: signature,
            ...(!zip64 ? { localCompressedHeaderValue: 0, localUncompressedHeaderValue: 0 } : {}),
          },
        ],
        { zip64 }
      ).buffer,
      { mode: 0o600 }
    );

    const archive = await openBoundedZipArchive(path);
    try {
      expect(await archive.readEntryBuffer('entry.bin')).toEqual(content);
    } finally {
      await archive.close();
    }
  });

  it.each([
    ['entries-on-disk', 8, 2],
    ['total-entry-count', 10, 2],
    ['central-size', 12, 4],
    ['central-offset', 16, 4],
  ] as const)(
    'rejects a non-sentinel legacy ZIP64 %s that disagrees with the ZIP64 EOCD',
    async (_field, relativeOffset, width) => {
      const fixture = buildZip([{ name: 'entry.bin', data: Buffer.from('zip64') }], {
        zip64: true,
      });
      const mutated = Buffer.from(fixture.buffer);
      const eocdOffset = mutated.length - 22;
      if (width === 2) mutated.writeUInt16LE(0, eocdOffset + relativeOffset);
      else mutated.writeUInt32LE(0, eocdOffset + relativeOffset);
      const path = join(fixtureRoot, `zip64-legacy-${_field}.zip`);
      writeFileSync(path, mutated, { mode: 0o600 });

      await expect(openBoundedZipArchive(path)).rejects.toThrow(
        'ZIP32 legacy metadata disagrees with the ZIP64 end record.'
      );
    }
  );

  it.each([
    ['missing ZIP32 descriptor', false, { descriptorOverride: Buffer.alloc(0) }],
    ['truncated unsigned ZIP32 descriptor', false, { descriptorOverride: Buffer.alloc(11) }],
    ['trailing signed ZIP32 descriptor', false, { descriptorOverride: Buffer.alloc(17) }],
    ['invalid ZIP32 signature', false, { descriptorOverride: Buffer.alloc(16) }],
    ['conflicting signed ZIP32 CRC', false, { descriptorCrc: 1 }],
    [
      'conflicting unsigned ZIP32 compressed size',
      false,
      { descriptorSignature: false, descriptorCompressedSize: 1 },
    ],
    ['truncated signed ZIP64 descriptor', true, { descriptorOverride: Buffer.alloc(23) }],
    ['conflicting signed ZIP64 uncompressed size', true, { descriptorUncompressedSize: 1 }],
    ['conflicting unsigned ZIP64 CRC', true, { descriptorSignature: false, descriptorCrc: 1 }],
  ] as const)('rejects a %s', async (_label, zip64, overrides) => {
    const path = join(fixtureRoot, `descriptor-invalid-${_label.replaceAll(' ', '-')}.zip`);
    writeFileSync(
      path,
      buildZip(
        [{ name: 'entry.bin', data: Buffer.from('descriptor'), flags: 0x0808, ...overrides }],
        { zip64 }
      ).buffer,
      { mode: 0o600 }
    );

    const archive = await openBoundedZipArchive(path);
    try {
      await expect(archive.readEntryBuffer('entry.bin')).rejects.toBeInstanceOf(
        ZipArchiveFormatError
      );
    } finally {
      await archive.close();
    }
  });

  it.each([
    ['uncompressed-size conflict', { localUncompressedSize: 9 }, { zip64: true }],
    ['compressed-size conflict', { localCompressedSize: 9 }, { zip64: true }],
    ['missing local ZIP64 extra', { localExtraOverride: Buffer.alloc(0) }, { zip64: true }],
    [
      'truncated local ZIP64 extra',
      {
        localExtraOverride: Buffer.from([
          0x01, 0x00, 0x10, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]),
      },
      { zip64: true },
    ],
    [
      'conflicting optional local ZIP64 extra',
      { localExtraOverride: zip64Extra([8n, 8n]) },
      { zip64: false },
    ],
  ] as const)(
    'rejects a ZIP64 data-descriptor entry with %s',
    async (_label, overrides, options) => {
      const content = Buffer.from('1234567');
      const path = join(fixtureRoot, `zip64-descriptor-${_label.replaceAll(' ', '-')}.zip`);
      writeFileSync(
        path,
        buildZip([{ name: 'entry.bin', data: content, flags: 0x0808, ...overrides }], options)
          .buffer,
        { mode: 0o600 }
      );

      const archive = await openBoundedZipArchive(path);
      try {
        await expect(archive.readEntryBuffer('entry.bin')).rejects.toBeInstanceOf(
          ZipArchiveFormatError
        );
      } finally {
        await archive.close();
      }
    }
  );

  it.each([
    [
      'compressed-size sentinel',
      {
        localCompressedHeaderValue: 0xffffffff,
        localUncompressedHeaderValue: 7,
        localExtraOverride: zip64Extra([7n, 999n]),
      },
    ],
    [
      'uncompressed-size sentinel',
      {
        localCompressedHeaderValue: 7,
        localUncompressedHeaderValue: 0xffffffff,
        localExtraOverride: zip64Extra([7n, 999n]),
      },
    ],
  ] as const)(
    'rejects surplus/conflicting ZIP64 descriptor values with only a %s',
    async (_label, overrides) => {
      const path = join(fixtureRoot, `zip64-one-sentinel-${_label.replaceAll(' ', '-')}.zip`);
      writeFileSync(
        path,
        buildZip(
          [{ name: 'entry.bin', data: Buffer.from('1234567'), flags: 0x0808, ...overrides }],
          { zip64: true }
        ).buffer,
        { mode: 0o600 }
      );

      const archive = await openBoundedZipArchive(path);
      try {
        await expect(archive.readEntryBuffer('entry.bin')).rejects.toThrow(
          'ZIP64 extra field contains surplus values.'
        );
      } finally {
        await archive.close();
      }
    }
  );

  it('enforces below, equal, and first-unit-above compressed-container limits', async () => {
    const fixture = buildZip([{ name: 'entry.bin', data: Buffer.from('x') }]);
    const path = join(fixtureRoot, 'compressed-limit.zip');
    writeFileSync(path, fixture.buffer, { mode: 0o600 });
    const size = fixture.buffer.length;

    await openAndCloseZip(path, { zipCompressedBytes: size + 1 });
    await openAndCloseZip(path, { zipCompressedBytes: size });
    const error = await captureLimitError(openAndCloseZip(path, { zipCompressedBytes: size - 1 }));
    expectZipLimit(error, 'zip-compressed-bytes', 'bytes', size - 1);
    expect(error.details.observedAtLeast).toBe(size);
    expect(Number.isInteger(error.details.observedAtLeast)).toBe(true);
  });

  it('rejects a sparse first-byte-above-default container before ZIP parsing', async () => {
    const path = join(fixtureRoot, 'sparse-container-limit.zip');
    writeFileSync(path, Buffer.alloc(0), { mode: 0o600 });
    truncateSync(path, SOURCE_READ_LIMITS_V1_DEFAULTS.zipCompressedBytes + 1);

    const error = await captureLimitError(openBoundedZipArchive(path));
    expectZipLimit(
      error,
      'zip-compressed-bytes',
      'bytes',
      SOURCE_READ_LIMITS_V1_DEFAULTS.zipCompressedBytes
    );
    expect(error.details.observedAtLeast).toBe(
      SOURCE_READ_LIMITS_V1_DEFAULTS.zipCompressedBytes + 1
    );
  });

  it('enforces below, equal, and first-unit-above central-entry-count limits', async () => {
    const fixture = buildZip([
      { name: 'one.bin', data: Buffer.from('1') },
      { name: 'two.bin', data: Buffer.from('2') },
    ]);
    const path = join(fixtureRoot, 'entry-count-limit.zip');
    writeFileSync(path, fixture.buffer, { mode: 0o600 });

    await openAndCloseZip(path, { zipEntryCount: 3 });
    await openAndCloseZip(path, { zipEntryCount: 2 });
    const error = await captureLimitError(openAndCloseZip(path, { zipEntryCount: 1 }));
    expectZipLimit(error, 'zip-entry-count', 'records', 1);
    expect(error.details.observedAtLeast).toBe(2);
    expect(Number.isInteger(error.details.observedAtLeast)).toBe(true);
  });

  it('enforces below, equal, and first-unit-above per-entry limits', async () => {
    const fixture = buildZip([{ name: 'entry.bin', data: Buffer.from('12') }]);
    const path = join(fixtureRoot, 'entry-size-limit.zip');
    writeFileSync(path, fixture.buffer, { mode: 0o600 });

    await openAndCloseZip(path, { zipEntryBytes: 3 });
    await openAndCloseZip(path, { zipEntryBytes: 2 });
    const error = await captureLimitError(openAndCloseZip(path, { zipEntryBytes: 1 }));
    expectZipLimit(error, 'zip-entry-bytes', 'bytes', 1);
    expect(error.details.observedAtLeast).toBe(2);
    expect(Number.isInteger(error.details.observedAtLeast)).toBe(true);
  });

  it('enforces below, equal, and first-unit-above aggregate limits', async () => {
    const fixture = buildZip([
      { name: 'one.bin', data: Buffer.from('1') },
      { name: 'two.bin', data: Buffer.from('2') },
    ]);
    const path = join(fixtureRoot, 'aggregate-limit.zip');
    writeFileSync(path, fixture.buffer, { mode: 0o600 });

    await openAndCloseZip(path, { zipEntryBytes: 1, zipAggregateBytes: 3 });
    await openAndCloseZip(path, { zipEntryBytes: 1, zipAggregateBytes: 2 });
    const error = await captureLimitError(
      openAndCloseZip(path, { zipEntryBytes: 1, zipAggregateBytes: 1 })
    );
    expectZipLimit(error, 'zip-aggregate-bytes', 'bytes', 1);
    expect(error.details.observedAtLeast).toBe(2);
    expect(Number.isInteger(error.details.observedAtLeast)).toBe(true);
  });

  it('enforces inclusive ratios and reports the exact fractional first-failing ratio', async () => {
    const equalFixture = buildZip([{ name: 'stored.bin', data: Buffer.from('ratio') }]);
    const equalPath = join(fixtureRoot, 'ratio-equal.zip');
    writeFileSync(equalPath, equalFixture.buffer, { mode: 0o600 });
    await openAndCloseZip(equalPath, { zipCompressionRatio: 2 });
    await openAndCloseZip(equalPath, { zipCompressionRatio: 1 });

    const aboveFixture = buildZip([
      { name: 'deflated.bin', data: Buffer.alloc(4096, 0x61), method: 8 },
    ]);
    const abovePath = join(fixtureRoot, 'ratio-above.zip');
    writeFileSync(abovePath, aboveFixture.buffer, { mode: 0o600 });
    const compressedSize = aboveFixture.entries[0]!.compressedSize;
    expect(compressedSize).toBeGreaterThan(1);
    const error = await captureLimitError(openAndCloseZip(abovePath, { zipCompressionRatio: 1 }));
    expectZipLimit(error, 'zip-compression-ratio', 'ratio', 1);
    expect(error.details.observedAtLeast).toBe((compressedSize + 1) / compressedSize);
    expect(Number.isInteger(error.details.observedAtLeast)).toBe(false);
  });

  it.each([
    ['ZIP32', false],
    ['ZIP64', true],
  ] as const)(
    'rejects %s entries claiming nonempty output from zero compressed bytes during preflight',
    async (label, zip64) => {
      const path = join(fixtureRoot, `zero-compressed-${label.toLowerCase()}.zip`);
      writeFileSync(
        path,
        buildZip(
          [
            {
              name: 'impossible.bin',
              data: Buffer.from('x'),
              method: 8,
              claimedCompressedSize: 0,
              claimedUncompressedSize: 1,
            },
          ],
          { zip64 }
        ).buffer,
        { mode: 0o600 }
      );

      await expect(openBoundedZipArchive(path)).rejects.toMatchObject({
        code: 'SOURCE_LIMIT_EXCEEDED',
        details: {
          sourceKind: 'zip',
          bound: 'zip-compression-ratio',
          unit: 'ratio',
          limit: SOURCE_READ_LIMITS_V1_DEFAULTS.zipCompressionRatio,
          observedAtLeast: SOURCE_READ_LIMITS_V1_DEFAULTS.zipCompressionRatio + 1,
          outcome: 'fatal',
        },
      });
    }
  );

  it('rejects invalid limit overrides before opening source content', async () => {
    const missingPath = join(fixtureRoot, 'does-not-exist.zip');
    const error = await captureConfigurationError(
      openBoundedZipArchive(missingPath, {
        sourceReadLimits: { zipCompressedBytes: 0 },
      })
    );
    expect(error.details).toMatchObject({
      invalidField: 'zipCompressedBytes',
      invalidValue: 0,
    });

    await expect(
      readBackupManifest(missingPath, {
        sourceReadLimits: { zipEntryBytes: 2, zipAggregateBytes: 1 },
      })
    ).rejects.toBeInstanceOf(SourceLimitConfigurationError);
  });

  it.each([
    ['traversal', [{ name: '../state.vscdb', data: Buffer.from('x') }]],
    ['absolute path', [{ name: '/state.vscdb', data: Buffer.from('x') }]],
    ['backslash', [{ name: 'globalStorage\\state.vscdb', data: Buffer.from('x') }]],
    [
      'normalized duplicate',
      [
        { name: 'A/state.vscdb', data: Buffer.from('x') },
        { name: 'a/state.vscdb', data: Buffer.from('y') },
      ],
    ],
    ['encryption', [{ name: 'state.vscdb', data: Buffer.from('x'), flags: 0x0801 }]],
    ['unknown method', [{ name: 'state.vscdb', data: Buffer.from('x'), method: 99 }]],
  ] as const)('rejects unsafe or unsupported ZIP metadata: %s', async (_label, entries) => {
    const path = join(fixtureRoot, `rejected-${_label.replaceAll(' ', '-')}.zip`);
    writeFileSync(path, buildZip(entries).buffer, { mode: 0o600 });
    await expect(openBoundedZipArchive(path)).rejects.toBeInstanceOf(ZipArchiveFormatError);
  });

  it('rejects central/local and central/streamed size or CRC disagreement', async () => {
    const content = Buffer.from('streamed integrity payload'.repeat(20));
    const fixtures: Array<[string, ZipFixtureEntry]> = [
      [
        'local-size',
        {
          name: 'entry.bin',
          data: content,
          method: 8,
          localUncompressedSize: content.length - 1,
        },
      ],
      [
        'stream-size',
        {
          name: 'entry.bin',
          data: content,
          method: 8,
          claimedUncompressedSize: content.length - 1,
        },
      ],
      [
        'stream-crc',
        {
          name: 'entry.bin',
          data: content,
          method: 8,
          claimedCrc: (crc32(content) + 1) >>> 0,
        },
      ],
    ];

    for (const [label, entry] of fixtures) {
      const path = join(fixtureRoot, `${label}.zip`);
      writeFileSync(path, buildZip([entry]).buffer, { mode: 0o600 });
      const archive = await openBoundedZipArchive(path);
      try {
        await expect(archive.checksumEntry('entry.bin')).rejects.toBeInstanceOf(
          ZipArchiveFormatError
        );
      } finally {
        await archive.close();
      }
    }
  });

  it('treats ZIP limit failures as fatal for manifest, validation, and restore and leaves no residue', async () => {
    const file = Buffer.from('db');
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      files: [
        {
          path: 'globalStorage/state.vscdb',
          size: file.length,
          checksum: computeChecksum(file),
          type: 'global-db',
        },
      ],
      stats: { totalSize: file.length, sessionCount: 0, workspaceCount: 0 },
    };
    const fixture = buildZip([
      { name: 'globalStorage/state.vscdb', data: file },
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    ]);
    const path = join(fixtureRoot, 'fatal-limit.zip');
    writeFileSync(path, fixture.buffer, { mode: 0o600 });
    const options = { sourceReadLimits: { zipEntryCount: 1 } };

    await expect(readBackupManifest(path, options)).rejects.toBeInstanceOf(
      SourceLimitExceededError
    );
    await expect(validateBackup(path, options)).rejects.toBeInstanceOf(SourceLimitExceededError);
    const before = currentPrivateTempPaths();
    await expect(
      restoreBackup({
        backupPath: path,
        targetPath: join(fixtureRoot, 'restore', 'workspaceStorage'),
        ...options,
      })
    ).rejects.toBeInstanceOf(SourceLimitExceededError);
    expect(currentPrivateTempPaths()).toEqual(before);
  });

  it('returns explicit invalid outcomes for malformed archives without leaving restore staging', async () => {
    const malformedPath = join(fixtureRoot, 'malformed.zip');
    writeFileSync(malformedPath, Buffer.from('not a zip'), { mode: 0o600 });
    const before = currentPrivateTempPaths();

    await expect(readBackupManifest(malformedPath)).rejects.toBeInstanceOf(ZipArchiveFormatError);
    const validation = await validateBackup(malformedPath);
    expect(validation.status).toBe('invalid');
    const restored = await restoreBackup({
      backupPath: malformedPath,
      targetPath: join(fixtureRoot, 'malformed-restore', 'workspaceStorage'),
    });
    expect(restored.success).toBe(false);
    expect(currentPrivateTempPaths()).toEqual(before);
  });

  it('rejects an empty manifest because it contains no intact restorable entries', async () => {
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.18.0',
      files: [],
      stats: { totalSize: 0, sessionCount: 0, workspaceCount: 0 },
    };
    const path = join(fixtureRoot, 'empty-manifest.zip');
    writeFileSync(
      path,
      buildZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(fixtureRoot, 'empty-manifest', 'User', 'workspaceStorage');

    const validation = await validateBackup(path);
    expect(validation).toMatchObject({
      status: 'invalid',
      validFiles: [],
      errors: ['No intact restorable files found in backup'],
    });
    await expect(restoreBackup({ backupPath: path, targetPath })).resolves.toMatchObject({
      success: false,
      filesRestored: 0,
      error: 'No intact restorable files found in backup',
    });
    expect(existsSync(dirname(targetPath))).toBe(false);
  });

  it('rejects unmanifested file entries instead of silently accepting hidden archive payloads', async () => {
    const payload = Buffer.from('declared database');
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.18.0',
      files: [
        {
          path: 'globalStorage/state.vscdb',
          size: payload.length,
          checksum: computeChecksum(payload),
          type: 'global-db',
        },
      ],
      stats: { totalSize: payload.length, sessionCount: 0, workspaceCount: 0 },
    };
    const path = join(fixtureRoot, 'unmanifested-entry.zip');
    writeFileSync(
      path,
      buildZip([
        { name: 'globalStorage/state.vscdb', data: payload },
        { name: 'unlisted.bin', data: Buffer.from('must be rejected') },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(fixtureRoot, 'unmanifested-entry', 'User', 'workspaceStorage');

    const validation = await validateBackup(path);
    expect(validation.status).toBe('invalid');
    expect(validation.errors.join(' ')).toContain('unmanifested file entry');
    await expect(restoreBackup({ backupPath: path, targetPath })).resolves.toMatchObject({
      success: false,
      filesRestored: 0,
    });
    expect(existsSync(dirname(targetPath))).toBe(false);
  });

  it('streams a valid restore through private staging and publishes exact bytes', async () => {
    const file = Buffer.from('restored sqlite bytes');
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.16.0',
      files: [
        {
          path: 'globalStorage/state.vscdb',
          size: file.length,
          checksum: computeChecksum(file),
          type: 'global-db',
        },
      ],
      stats: { totalSize: file.length, sessionCount: 0, workspaceCount: 0 },
    };
    const path = join(fixtureRoot, 'valid-restore.zip');
    writeFileSync(
      path,
      buildZip([
        { name: 'globalStorage/state.vscdb', data: file, method: 8 },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)), method: 8 },
      ]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(fixtureRoot, 'valid-restore', 'User', 'workspaceStorage');
    const before = currentPrivateTempPaths();

    const result = await restoreBackup({ backupPath: path, targetPath });
    expect(result).toMatchObject({ success: true, filesRestored: 1, warnings: [] });
    const restoredPath = join(dirname(targetPath), 'globalStorage', 'state.vscdb');
    expect(readFileSync(restoredPath)).toEqual(file);
    if (process.platform !== 'win32') {
      expect(lstatSync(restoredPath).mode & 0o777).toBe(0o600);
    }
    expect(
      readdirSync(dirname(restoredPath)).some((name) => name.startsWith('.cursor-history-restore-'))
    ).toBe(false);
    expect(currentPrivateTempPaths()).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'force replaces a hard-linked destination entry without modifying its outside peer',
    async () => {
      const replacement = Buffer.from('validated replacement bytes');
      const original = Buffer.from('outside hard-link peer must survive');
      const file = {
        path: 'globalStorage/state.vscdb',
        size: replacement.length,
        checksum: computeChecksum(replacement),
        type: 'global-db',
      };
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.18.0',
        files: [file],
        stats: { totalSize: replacement.length, sessionCount: 0, workspaceCount: 0 },
      };
      const path = join(fixtureRoot, 'hard-linked-leaf.zip');
      writeFileSync(
        path,
        buildZip([
          { name: file.path, data: replacement },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );
      const targetPath = join(fixtureRoot, 'hard-linked-leaf', 'User', 'workspaceStorage');
      const destination = join(dirname(targetPath), file.path);
      const outside = join(fixtureRoot, 'outside-hard-link-peer.vscdb');
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(outside, original, { mode: 0o600 });
      linkSync(outside, destination);
      const sharedInode = lstatSync(outside).ino;
      expect(lstatSync(destination).ino).toBe(sharedInode);

      const result = await restoreBackup({ backupPath: path, targetPath, force: true });

      expect(result).toMatchObject({ success: true, filesRestored: 1 });
      expect(readFileSync(destination)).toEqual(replacement);
      expect(readFileSync(outside)).toEqual(original);
      expect(lstatSync(destination).ino).not.toBe(sharedInode);
      expect(lstatSync(outside).ino).toBe(sharedInode);
    }
  );

  it.each([
    ['settings.json', 'global-db'],
    ['workspaceStorage/ws/state.vscdb', 'global-db'],
    ['globalStorage/state.vscdb', 'workspace-db'],
  ] as const)(
    'rejects the non-Cursor or mismatched restore mapping %s as %s without touching its target',
    async (manifestPath, type) => {
      const payload = Buffer.from('archive-controlled bytes');
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.18.0',
        files: [
          {
            path: manifestPath,
            size: payload.length,
            checksum: computeChecksum(payload),
            type,
          },
        ],
        stats: { totalSize: payload.length, sessionCount: 0, workspaceCount: 0 },
      };
      const path = join(fixtureRoot, `invalid-restore-${type}-${basename(manifestPath)}.zip`);
      writeFileSync(
        path,
        buildZip([
          { name: manifestPath, data: payload },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );
      const targetPath = join(fixtureRoot, 'invalid-restore', 'User', 'workspaceStorage');
      const userDir = dirname(targetPath);
      const victim = join(userDir, manifestPath);
      mkdirSync(dirname(victim), { recursive: true });
      const original = Buffer.from('pre-existing target');
      writeFileSync(victim, original, { mode: 0o600 });

      const validation = await validateBackup(path);
      expect(validation.status).toBe('invalid');
      expect(validation.errors.join(' ')).toContain('unsupported path/type combination');
      const result = await restoreBackup({ backupPath: path, targetPath, force: true });

      expect(result).toMatchObject({ success: false, filesRestored: 0 });
      expect(readFileSync(victim)).toEqual(original);
    }
  );

  it('rejects duplicate manifest destinations before restoring any bytes', async () => {
    const payload = Buffer.from('duplicate destination bytes');
    const file = {
      path: 'globalStorage/state.vscdb',
      size: payload.length,
      checksum: computeChecksum(payload),
      type: 'global-db',
    };
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.18.0',
      files: [file, { ...file }],
      stats: { totalSize: payload.length * 2, sessionCount: 0, workspaceCount: 0 },
    };
    const path = join(fixtureRoot, 'duplicate-restore-destination.zip');
    writeFileSync(
      path,
      buildZip([
        { name: file.path, data: payload },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(fixtureRoot, 'duplicate-restore', 'User', 'workspaceStorage');
    const destination = join(dirname(targetPath), file.path);

    const validation = await validateBackup(path);
    expect(validation.status).toBe('invalid');
    expect(validation.errors.join(' ')).toContain('duplicate restore destination');
    const result = await restoreBackup({ backupPath: path, targetPath, force: true });

    expect(result).toMatchObject({ success: false, filesRestored: 0 });
    expect(existsSync(destination)).toBe(false);
  });

  it('preflights every valid destination before non-force restore and writes nothing on a later collision', async () => {
    const global = Buffer.from('new global bytes');
    const workspace = Buffer.from('new workspace bytes');
    const files = [
      {
        path: 'globalStorage/state.vscdb',
        size: global.length,
        checksum: computeChecksum(global),
        type: 'global-db',
      },
      {
        path: 'workspaceStorage/ws/state.vscdb',
        size: workspace.length,
        checksum: computeChecksum(workspace),
        type: 'workspace-db',
      },
    ];
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.18.0',
      files,
      stats: {
        totalSize: global.length + workspace.length,
        sessionCount: 0,
        workspaceCount: 1,
      },
    };
    const path = join(fixtureRoot, 'later-restore-collision.zip');
    writeFileSync(
      path,
      buildZip([
        { name: files[0]!.path, data: global },
        { name: files[1]!.path, data: workspace },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(fixtureRoot, 'later-collision', 'User', 'workspaceStorage');
    const userDir = dirname(targetPath);
    const globalDestination = join(userDir, files[0]!.path);
    const workspaceDestination = join(userDir, files[1]!.path);
    const originalWorkspace = Buffer.from('existing later destination');
    mkdirSync(dirname(workspaceDestination), { recursive: true });
    writeFileSync(workspaceDestination, originalWorkspace, { mode: 0o600 });

    const result = await restoreBackup({ backupPath: path, targetPath, force: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already has Cursor data');
    expect(existsSync(globalDestination)).toBe(false);
    expect(readFileSync(workspaceDestination)).toEqual(originalWorkspace);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a linked workspaceStorage ancestor without writing outside the Cursor data directory',
    async () => {
      const payload = Buffer.from('must remain confined');
      const file = {
        path: 'workspaceStorage/ws/state.vscdb',
        size: payload.length,
        checksum: computeChecksum(payload),
        type: 'workspace-db',
      };
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.18.0',
        files: [file],
        stats: { totalSize: payload.length, sessionCount: 0, workspaceCount: 1 },
      };
      const path = join(fixtureRoot, 'linked-workspace-restore.zip');
      writeFileSync(
        path,
        buildZip([
          { name: file.path, data: payload },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );
      const userDir = join(fixtureRoot, 'linked-workspace', 'User');
      const targetPath = join(userDir, 'workspaceStorage');
      const outside = join(fixtureRoot, 'outside-workspace');
      mkdirSync(userDir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, targetPath, 'dir');

      const result = await restoreBackup({ backupPath: path, targetPath, force: true });

      expect(result).toMatchObject({ success: false, filesRestored: 0 });
      expect(result.error).toContain('unsafe filesystem link');
      expect(existsSync(join(outside, 'ws', 'state.vscdb'))).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'accepts an explicitly selected Cursor user root reached through a link above that trust boundary',
    async () => {
      const payload = Buffer.from('valid restore through linked parent');
      const file = {
        path: 'globalStorage/state.vscdb',
        size: payload.length,
        checksum: computeChecksum(payload),
        type: 'global-db',
      };
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.18.0',
        files: [file],
        stats: { totalSize: payload.length, sessionCount: 0, workspaceCount: 0 },
      };
      const path = join(fixtureRoot, 'linked-parent-restore.zip');
      writeFileSync(
        path,
        buildZip([
          { name: file.path, data: payload },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );
      const realParent = join(fixtureRoot, 'real-custom-parent');
      const linkedParent = join(fixtureRoot, 'linked-custom-parent');
      const realUser = join(realParent, 'User');
      mkdirSync(realUser, { recursive: true });
      symlinkSync(realParent, linkedParent, 'dir');
      const targetPath = join(linkedParent, 'User', 'workspaceStorage');

      const result = await restoreBackup({ backupPath: path, targetPath });

      expect(result).toMatchObject({ success: true, filesRestored: 1 });
      expect(readFileSync(join(realUser, file.path))).toEqual(payload);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a linked destination file without modifying the link target',
    async () => {
      const payload = Buffer.from('must not replace link target');
      const file = {
        path: 'workspaceStorage/ws/state.vscdb',
        size: payload.length,
        checksum: computeChecksum(payload),
        type: 'workspace-db',
      };
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.18.0',
        files: [file],
        stats: { totalSize: payload.length, sessionCount: 0, workspaceCount: 1 },
      };
      const path = join(fixtureRoot, 'linked-file-restore.zip');
      writeFileSync(
        path,
        buildZip([
          { name: file.path, data: payload },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );
      const targetPath = join(fixtureRoot, 'linked-file', 'User', 'workspaceStorage');
      const destination = join(dirname(targetPath), file.path);
      const outside = join(fixtureRoot, 'outside-destination.vscdb');
      const original = Buffer.from('outside file must survive');
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(outside, original, { mode: 0o600 });
      symlinkSync(outside, destination, 'file');

      const result = await restoreBackup({ backupPath: path, targetPath, force: true });

      expect(result).toMatchObject({ success: false, filesRestored: 0 });
      expect(result.error).toContain('unsafe filesystem link');
      expect(readFileSync(outside)).toEqual(original);
    }
  );

  it.each([false, true])(
    'restores only intact entries from a mixed archive and leaves a corrupt destination untouched (force=%s)',
    async (force) => {
      const validGlobal = Buffer.from('valid global sqlite bytes');
      const expectedWorkspace = Buffer.from('expected workspace bytes');
      const corruptWorkspace = Buffer.from('corrupt workspace bytes!');
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.16.0',
        files: [
          {
            path: 'globalStorage/state.vscdb',
            size: validGlobal.length,
            checksum: computeChecksum(validGlobal),
            type: 'global-db',
          },
          {
            path: 'workspaceStorage/ws/state.vscdb',
            size: expectedWorkspace.length,
            checksum: computeChecksum(expectedWorkspace),
            type: 'workspace-db',
          },
        ],
        stats: {
          totalSize: validGlobal.length + expectedWorkspace.length,
          sessionCount: 0,
          workspaceCount: 1,
        },
      };
      const archivePath = join(fixtureRoot, 'mixed-integrity-restore.zip');
      writeFileSync(
        archivePath,
        buildZip([
          { name: 'globalStorage/state.vscdb', data: validGlobal, method: 8 },
          { name: 'workspaceStorage/ws/state.vscdb', data: corruptWorkspace, method: 8 },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)), method: 8 },
        ]).buffer,
        { mode: 0o600 }
      );
      const targetPath = join(fixtureRoot, 'mixed-restore', 'User', 'workspaceStorage');
      const corruptDestination = join(targetPath, 'ws', 'state.vscdb');
      const priorDestination = Buffer.from('existing destination must survive');
      mkdirSync(dirname(corruptDestination), { recursive: true });
      writeFileSync(corruptDestination, priorDestination, { mode: 0o600 });

      const validation = await validateBackup(archivePath);
      expect(validation).toMatchObject({
        status: 'warnings',
        validFiles: ['globalStorage/state.vscdb'],
        corruptedFiles: ['workspaceStorage/ws/state.vscdb'],
      });

      const result = await restoreBackup({ backupPath: archivePath, targetPath, force });

      expect(result).toMatchObject({
        success: true,
        filesRestored: 1,
        warnings: [
          'Integrity mismatch (size or checksum); skipped: workspaceStorage/ws/state.vscdb',
        ],
      });
      expect(readFileSync(join(dirname(targetPath), 'globalStorage', 'state.vscdb'))).toEqual(
        validGlobal
      );
      expect(readFileSync(corruptDestination)).toEqual(priorDestination);
    }
  );

  it('skips a size-only invalid entry from a mixed archive while restoring the intact entry', async () => {
    const validGlobal = Buffer.from('valid global bytes');
    const workspace = Buffer.from('workspace checksum is valid but declared size is not');
    const files = [
      {
        path: 'globalStorage/state.vscdb',
        size: validGlobal.length,
        checksum: computeChecksum(validGlobal),
        type: 'global-db',
      },
      {
        path: 'workspaceStorage/ws/state.vscdb',
        size: workspace.length + 1,
        checksum: computeChecksum(workspace),
        type: 'workspace-db',
      },
    ];
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.18.0',
      files,
      stats: {
        totalSize: validGlobal.length + workspace.length + 1,
        sessionCount: 0,
        workspaceCount: 1,
      },
    };
    const archivePath = join(fixtureRoot, 'mixed-size-only-invalid-restore.zip');
    writeFileSync(
      archivePath,
      buildZip([
        { name: files[0]!.path, data: validGlobal },
        { name: files[1]!.path, data: workspace },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(fixtureRoot, 'mixed-size-only', 'User', 'workspaceStorage');
    const workspaceDestination = join(dirname(targetPath), files[1]!.path);
    const priorWorkspace = Buffer.from('existing workspace survives');
    mkdirSync(dirname(workspaceDestination), { recursive: true });
    writeFileSync(workspaceDestination, priorWorkspace, { mode: 0o600 });

    const result = await restoreBackup({ backupPath: archivePath, targetPath, force: true });

    expect(result).toMatchObject({
      success: true,
      filesRestored: 1,
      warnings: ['Integrity mismatch (size or checksum); skipped: workspaceStorage/ws/state.vscdb'],
    });
    expect(readFileSync(join(dirname(targetPath), files[0]!.path))).toEqual(validGlobal);
    expect(readFileSync(workspaceDestination)).toEqual(priorWorkspace);
  });

  it.each(['checksum', 'size'] as const)(
    'rejects an all-corrupt archive with a %s mismatch without modifying an existing destination',
    async (mismatch) => {
      const expected = Buffer.from('expected sqlite bytes');
      const corrupt = Buffer.from('corrupt sqlite bytes!');
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.16.0',
        files: [
          {
            path: 'globalStorage/state.vscdb',
            size: mismatch === 'size' ? corrupt.length + 1 : expected.length,
            checksum: computeChecksum(expected),
            type: 'global-db',
          },
        ],
        stats: {
          totalSize: expected.length,
          sessionCount: 0,
          workspaceCount: 0,
        },
      };
      const archivePath = join(fixtureRoot, `all-corrupt-${mismatch}-restore.zip`);
      writeFileSync(
        archivePath,
        buildZip([
          { name: 'globalStorage/state.vscdb', data: corrupt, method: 8 },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)), method: 8 },
        ]).buffer,
        { mode: 0o600 }
      );
      const targetPath = join(
        fixtureRoot,
        `all-corrupt-${mismatch}-restore`,
        'User',
        'workspaceStorage'
      );
      const destination = join(dirname(targetPath), 'globalStorage', 'state.vscdb');
      const priorDestination = Buffer.from('existing global destination must survive');
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, priorDestination, { mode: 0o600 });

      const result = await restoreBackup({ backupPath: archivePath, targetPath, force: true });

      expect(result).toMatchObject({
        success: false,
        filesRestored: 0,
      });
      expect(result.error).toContain('Corrupted files: globalStorage/state.vscdb');
      expect(readFileSync(destination)).toEqual(priorDestination);
    }
  );

  it('fails closed without mutating an already-published file after a later callback fails', async () => {
    const replacementGlobal = Buffer.from('replacement global');
    const replacementWorkspace = Buffer.from('replacement workspace');
    const files = [
      {
        path: 'globalStorage/state.vscdb',
        size: replacementGlobal.length,
        checksum: computeChecksum(replacementGlobal),
        type: 'global-db',
      },
      {
        path: 'workspaceStorage/ws/state.vscdb',
        size: replacementWorkspace.length,
        checksum: computeChecksum(replacementWorkspace),
        type: 'workspace-db',
      },
    ];
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.16.0',
      files,
      stats: {
        totalSize: replacementGlobal.length + replacementWorkspace.length,
        sessionCount: 0,
        workspaceCount: 1,
      },
    };
    const path = join(fixtureRoot, 'rollback-restore.zip');
    writeFileSync(
      path,
      buildZip([
        { name: files[0]!.path, data: replacementGlobal },
        { name: files[1]!.path, data: replacementWorkspace },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ]).buffer,
      { mode: 0o600 }
    );

    const targetPath = join(fixtureRoot, 'rollback-restore', 'User', 'workspaceStorage');
    const userDirectory = dirname(targetPath);
    const globalPath = join(userDirectory, files[0]!.path);
    const workspacePath = join(userDirectory, files[1]!.path);
    mkdirSync(dirname(globalPath), { recursive: true });
    const originalGlobal = Buffer.from('original global');
    writeFileSync(globalPath, originalGlobal, { mode: 0o640 });
    const before = currentPrivateTempPaths();

    let caught: unknown;
    try {
      await restoreBackup({
        backupPath: path,
        targetPath,
        force: true,
        onProgress: (progress) => {
          if (progress.phase === 'extracting' && progress.filesCompleted === 1) {
            expect(readFileSync(globalPath)).toEqual(replacementGlobal);
            throw new Error('synthetic failure after first publication');
          }
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RestoreRollbackError);
    expect(caught).toMatchObject({
      code: 'RESTORE_ROLLBACK_INCOMPLETE',
      details: {
        publishedFileCount: 1,
        residualFileCount: 1,
        residualFiles: ['globalStorage/state.vscdb'],
      },
      cause: expect.objectContaining({
        message: 'synthetic failure after first publication',
      }),
    });
    expect(readFileSync(globalPath)).toEqual(replacementGlobal);
    expect(lstatSync(globalPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(globalPath)).not.toEqual(originalGlobal);
    expect(existsSync(workspacePath)).toBe(false);
    expect(currentPrivateTempPaths()).toEqual(before);
  });

  it('preserves a committed non-force restore while reporting private publication residue', async () => {
    const replacementGlobal = Buffer.from('replacement global');
    const file = {
      path: 'globalStorage/state.vscdb',
      size: replacementGlobal.length,
      checksum: computeChecksum(replacementGlobal),
      type: 'global-db',
    };
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.18.0',
      files: [file],
      stats: {
        totalSize: replacementGlobal.length,
        sessionCount: 0,
        workspaceCount: 0,
      },
    };
    const path = join(fixtureRoot, 'restore-publication-cleanup-failure.zip');
    writeFileSync(
      path,
      buildZip([
        { name: file.path, data: replacementGlobal },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(
      fixtureRoot,
      'restore-publication-cleanup-failure',
      'User',
      'workspaceStorage'
    );
    const destinationPath = join(dirname(targetPath), file.path);

    let caught: unknown;
    restorePublicationCleanupFault.enabled = true;
    try {
      await restoreBackup({ backupPath: path, targetPath, force: false });
    } catch (error) {
      caught = error;
    } finally {
      restorePublicationCleanupFault.enabled = false;
    }

    expect(caught).toBeInstanceOf(RestoreRollbackError);
    expect(caught).toMatchObject({
      code: 'RESTORE_ROLLBACK_INCOMPLETE',
      details: {
        publishedFileCount: 1,
        residualFileCount: 1,
        residualFiles: ['globalStorage/state.vscdb'],
        residueCount: 1,
        residuePaths: [expect.stringMatching(/\.cursor-history-restore-[^/]+\.tmp$/u)],
        unverifiedResidueCount: 0,
        unverifiedResiduePaths: [],
      },
    });
    const cleanupCause = (caught as Error & { cause: TemporaryArtifactCleanupError }).cause;
    expect(cleanupCause).toMatchObject({
      code: 'TEMPORARY_ARTIFACT_CLEANUP_FAILED',
      details: {
        residueCount: 1,
        residuePaths: [expect.stringMatching(/\.cursor-history-restore-[^/]+\.tmp$/u)],
      },
    });
    expect((cleanupCause as Error & { cause: unknown }).cause).toMatchObject({
      message: 'synthetic restore publication cleanup failure',
    });
    const [residuePath] = cleanupCause.details.residuePaths;
    expect(residuePath).toBeDefined();
    expect(existsSync(residuePath!)).toBe(true);
    expect(readFileSync(destinationPath)).toEqual(replacementGlobal);
  });

  it('keeps publication and outer-workspace cleanup residue in one fail-closed error', async () => {
    const replacementGlobal = Buffer.from('replacement global');
    const file = {
      path: 'globalStorage/state.vscdb',
      size: replacementGlobal.length,
      checksum: computeChecksum(replacementGlobal),
      type: 'global-db',
    };
    const manifest = {
      version: '1.0.0',
      createdAt: new Date(0).toISOString(),
      sourcePlatform: 'linux',
      cursorHistoryVersion: '0.18.0',
      files: [file],
      stats: {
        totalSize: replacementGlobal.length,
        sessionCount: 0,
        workspaceCount: 0,
      },
    };
    const path = join(fixtureRoot, 'restore-combined-cleanup-failure.zip');
    writeFileSync(
      path,
      buildZip([
        { name: file.path, data: replacementGlobal },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ]).buffer,
      { mode: 0o600 }
    );
    const targetPath = join(
      fixtureRoot,
      'restore-combined-cleanup-failure',
      'User',
      'workspaceStorage'
    );
    const destinationPath = join(dirname(targetPath), file.path);
    const before = currentPrivateTempPaths();
    let injectedWorkspacePath: string | undefined;
    let caught: unknown;
    restorePublicationCleanupFault.enabled = true;
    try {
      await restoreBackup({
        backupPath: path,
        targetPath,
        force: false,
        onProgress: (progress) => {
          if (progress.phase !== 'extracting' || progress.filesCompleted !== 0) return;
          const currentWorkspace = currentPrivateTempPaths().find(
            (entry) => !before.includes(entry)
          );
          if (!currentWorkspace) throw new Error('private restore workspace not found');
          injectedWorkspacePath = join(tmpdir(), currentWorkspace);
          const markerPath = join(injectedWorkspacePath, PRIVATE_TEMP_MARKER_FILENAME);
          if (!existsSync(markerPath) || lstatSync(markerPath).isDirectory()) return;
          rmSync(markerPath);
          mkdirSync(markerPath);
          writeFileSync(join(markerPath, 'retained'), Buffer.from('force cleanup residue'));
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      restorePublicationCleanupFault.enabled = false;
    }

    expect(caught).toBeInstanceOf(RestoreRollbackError);
    const details = (caught as RestoreRollbackError).details;
    expect(details).toMatchObject({
      publishedFileCount: 1,
      residualFiles: ['globalStorage/state.vscdb'],
      residueCount: 3,
      unverifiedResidueCount: 0,
      unverifiedResiduePaths: [],
    });
    expect(injectedWorkspacePath).toBeDefined();
    expect(existsSync(injectedWorkspacePath!)).toBe(true);
    expect(details.residuePaths).toContain(injectedWorkspacePath);
    expect(details.residuePaths).toContain(
      join(injectedWorkspacePath!, PRIVATE_TEMP_MARKER_FILENAME)
    );
    expect(
      details.residuePaths.some((entry) => /\.cursor-history-restore-[^/]+\.tmp$/u.test(entry))
    ).toBe(true);
    const publicationCleanup = (caught as Error & { cause: TemporaryArtifactCleanupError }).cause;
    expect(publicationCleanup.details.residuePaths).toEqual([
      expect.stringMatching(/\.cursor-history-restore-[^/]+\.tmp$/u),
    ]);
    expect(readFileSync(destinationPath)).toEqual(replacementGlobal);

    rmSync(injectedWorkspacePath!, { recursive: true });
    expect(currentPrivateTempPaths()).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')(
    'throws a typed fail-closed result when a published path becomes inaccessible',
    async () => {
      const replacementGlobal = Buffer.from('replacement global');
      const replacementWorkspace = Buffer.from('replacement workspace');
      const files = [
        {
          path: 'globalStorage/state.vscdb',
          size: replacementGlobal.length,
          checksum: computeChecksum(replacementGlobal),
          type: 'global-db',
        },
        {
          path: 'workspaceStorage/ws/state.vscdb',
          size: replacementWorkspace.length,
          checksum: computeChecksum(replacementWorkspace),
          type: 'workspace-db',
        },
      ];
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.18.0',
        files,
        stats: {
          totalSize: replacementGlobal.length + replacementWorkspace.length,
          sessionCount: 0,
          workspaceCount: 1,
        },
      };
      const path = join(fixtureRoot, 'rollback-incomplete.zip');
      writeFileSync(
        path,
        buildZip([
          { name: files[0]!.path, data: replacementGlobal },
          { name: files[1]!.path, data: replacementWorkspace },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );
      const targetPath = join(fixtureRoot, 'rollback-incomplete', 'User', 'workspaceStorage');
      const userDirectory = dirname(targetPath);
      const globalDirectory = join(userDirectory, 'globalStorage');
      const globalPath = join(globalDirectory, 'state.vscdb');
      const movedGlobalDirectory = join(fixtureRoot, 'rollback-incomplete-residual');
      const movedGlobalPath = join(movedGlobalDirectory, 'state.vscdb');
      mkdirSync(globalDirectory, { recursive: true });
      writeFileSync(globalPath, Buffer.from('original global'), { mode: 0o600 });
      const before = currentPrivateTempPaths();

      let caught: unknown;
      try {
        await restoreBackup({
          backupPath: path,
          targetPath,
          force: true,
          onProgress: (progress) => {
            if (progress.phase === 'extracting' && progress.filesCompleted === 1) {
              renameSync(globalDirectory, movedGlobalDirectory);
              symlinkSync(movedGlobalDirectory, globalDirectory, 'dir');
              throw new Error('synthetic failure with blocked rollback path');
            }
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RestoreRollbackError);
      expect(caught).toMatchObject({
        code: 'RESTORE_ROLLBACK_INCOMPLETE',
        details: {
          publishedFileCount: 1,
          residualFileCount: 1,
          residualFiles: ['globalStorage/state.vscdb'],
          remedy: expect.stringContaining('known-good backup'),
        },
        cause: expect.objectContaining({
          message: 'synthetic failure with blocked rollback path',
        }),
      });
      expect(readFileSync(movedGlobalPath)).toEqual(replacementGlobal);
      expect(currentPrivateTempPaths()).toEqual(before);
    }
  );

  it.each([false, true])(
    'preserves a replacement installed immediately after the former rollback identity observation (prior=%s)',
    async (hadPriorDestination) => {
      const replacementGlobal = Buffer.from('replacement global');
      const replacementWorkspace = Buffer.from('replacement workspace');
      const files = [
        {
          path: 'globalStorage/state.vscdb',
          size: replacementGlobal.length,
          checksum: computeChecksum(replacementGlobal),
          type: 'global-db',
        },
        {
          path: 'workspaceStorage/ws/state.vscdb',
          size: replacementWorkspace.length,
          checksum: computeChecksum(replacementWorkspace),
          type: 'workspace-db',
        },
      ];
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        cursorHistoryVersion: '0.18.0',
        files,
        stats: {
          totalSize: replacementGlobal.length + replacementWorkspace.length,
          sessionCount: 0,
          workspaceCount: 1,
        },
      };
      const path = join(
        fixtureRoot,
        `rollback-leaf-replacement-${hadPriorDestination ? 'prior' : 'new'}.zip`
      );
      writeFileSync(
        path,
        buildZip([
          { name: files[0]!.path, data: replacementGlobal },
          { name: files[1]!.path, data: replacementWorkspace },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );

      const targetPath = join(
        fixtureRoot,
        `rollback-leaf-replacement-${hadPriorDestination ? 'prior' : 'new'}`,
        'User',
        'workspaceStorage'
      );
      const globalPath = join(dirname(targetPath), files[0]!.path);
      mkdirSync(dirname(globalPath), { recursive: true });
      if (hadPriorDestination) {
        writeFileSync(globalPath, Buffer.from('prior global bytes'), { mode: 0o640 });
      }
      const concurrentBytes = Buffer.from('concurrent owner bytes');
      const concurrentPath = join(dirname(globalPath), 'concurrent-state.vscdb');
      const before = currentPrivateTempPaths();

      let caught: unknown;
      try {
        await restoreBackup({
          backupPath: path,
          targetPath,
          force: true,
          onProgress: (progress) => {
            if (progress.phase === 'extracting' && progress.filesCompleted === 1) {
              expect(readFileSync(globalPath)).toEqual(replacementGlobal);
              const observedPublishedIdentity = lstatSync(globalPath, { bigint: true });
              writeFileSync(concurrentPath, concurrentBytes, { mode: 0o600 });
              renameSync(concurrentPath, globalPath);
              const replacementIdentity = lstatSync(globalPath, { bigint: true });
              expect(replacementIdentity.dev).toBe(observedPublishedIdentity.dev);
              expect(replacementIdentity.ino).not.toBe(observedPublishedIdentity.ino);
              throw new Error('synthetic failure after concurrent leaf replacement');
            }
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RestoreRollbackError);
      expect(caught).toMatchObject({
        code: 'RESTORE_ROLLBACK_INCOMPLETE',
        details: {
          publishedFileCount: 1,
          residualFileCount: 1,
          residualFiles: ['globalStorage/state.vscdb'],
        },
        cause: expect.objectContaining({
          message: 'synthetic failure after concurrent leaf replacement',
        }),
      });
      expect(readFileSync(globalPath)).toEqual(concurrentBytes);
      expect(currentPrivateTempPaths()).toEqual(before);
    }
  );

  it.each(['last-file', 'finalizing'] as const)(
    'fails closed and cleans private staging when cancellation occurs at %s progress',
    async (abortPoint) => {
      const replacementGlobal = Buffer.from('replacement global');
      const replacementWorkspace = Buffer.from('replacement workspace');
      const files = [
        {
          path: 'globalStorage/state.vscdb',
          size: replacementGlobal.length,
          checksum: computeChecksum(replacementGlobal),
          type: 'global-db',
        },
        {
          path: 'workspaceStorage/ws/state.vscdb',
          size: replacementWorkspace.length,
          checksum: computeChecksum(replacementWorkspace),
          type: 'workspace-db',
        },
      ];
      const manifest = {
        version: '1.0.0',
        createdAt: new Date(0).toISOString(),
        sourcePlatform: 'linux',
        files,
        stats: {
          totalSize: replacementGlobal.length + replacementWorkspace.length,
          sessionCount: 0,
          workspaceCount: 1,
        },
      };
      const path = join(fixtureRoot, `cancel-${abortPoint}.zip`);
      writeFileSync(
        path,
        buildZip([
          { name: files[0]!.path, data: replacementGlobal },
          { name: files[1]!.path, data: replacementWorkspace },
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        ]).buffer,
        { mode: 0o600 }
      );

      const targetPath = join(fixtureRoot, `cancel-${abortPoint}`, 'User', 'workspaceStorage');
      const userDirectory = dirname(targetPath);
      const globalPath = join(userDirectory, files[0]!.path);
      const workspacePath = join(userDirectory, files[1]!.path);
      mkdirSync(dirname(globalPath), { recursive: true });
      const originalGlobal = Buffer.from('original global');
      writeFileSync(globalPath, originalGlobal);
      const controller = new AbortController();
      const before = currentPrivateTempPaths();

      await expect(
        restoreBackup({
          backupPath: path,
          targetPath,
          force: true,
          signal: controller.signal,
          onProgress: (progress) => {
            if (
              (abortPoint === 'last-file' &&
                progress.phase === 'extracting' &&
                progress.filesCompleted === progress.totalFiles - 1) ||
              (abortPoint === 'finalizing' && progress.phase === 'finalizing')
            ) {
              controller.abort(new Error(`cancel at ${abortPoint}`));
            }
          },
        })
      ).rejects.toMatchObject({
        code: 'RESTORE_ROLLBACK_INCOMPLETE',
        details: {
          publishedFileCount: abortPoint === 'last-file' ? 1 : 2,
          residualFileCount: abortPoint === 'last-file' ? 1 : 2,
          residualFiles:
            abortPoint === 'last-file'
              ? ['globalStorage/state.vscdb']
              : ['globalStorage/state.vscdb', 'workspaceStorage/ws/state.vscdb'],
        },
        cause: { name: 'AbortError' },
      });

      expect(readFileSync(globalPath)).toEqual(replacementGlobal);
      expect(readFileSync(globalPath)).not.toEqual(originalGlobal);
      expect(existsSync(workspacePath)).toBe(abortPoint === 'finalizing');
      if (abortPoint === 'finalizing') {
        expect(readFileSync(workspacePath)).toEqual(replacementWorkspace);
      }
      expect(currentPrivateTempPaths()).toEqual(before);
    }
  );

  it('uses isolated workspaces for concurrent reads and cleans both', async () => {
    const paths: string[] = [];
    openDatabaseMock.mockImplementation((path: string) => {
      paths.push(path);
      return databaseWithClose(vi.fn());
    });

    const [first, second] = await Promise.all([
      openBackupDatabase(archivePath, 'globalStorage/state.vscdb'),
      openBackupDatabase(archivePath, 'globalStorage/state.vscdb'),
    ]);
    expect(paths).toHaveLength(2);
    expect(dirname(paths[0]!)).not.toBe(dirname(paths[1]!));
    expect(paths.every(existsSync)).toBe(true);

    first.close();
    second.close();
    expect(paths.every((path) => !existsSync(path) && !existsSync(dirname(path)))).toBe(true);
  });

  it('cleans private backup-creation staging when a database snapshot fails', async () => {
    const sourcePath = join(fixtureRoot, 'source', 'User', 'workspaceStorage');
    const globalDirectory = join(dirname(sourcePath), 'globalStorage');
    mkdirSync(sourcePath, { recursive: true });
    mkdirSync(globalDirectory, { recursive: true });
    writeFileSync(join(globalDirectory, 'state.vscdb'), Buffer.from('sqlite source'));
    backupDatabaseMock.mockRejectedValueOnce(new Error('synthetic snapshot failure'));
    const before = currentPrivateTempPaths();

    await expect(
      createBackup({
        sourcePath,
        outputPath: join(fixtureRoot, 'snapshot-failure.zip'),
      })
    ).rejects.toThrow('synthetic snapshot failure');
    expect(currentPrivateTempPaths()).toEqual(before);
  });

  it.runIf(process.platform !== 'win32')(
    'streams and atomically publishes a new owner-only archive under umask 000',
    async () => {
      const sourcePath = join(fixtureRoot, 'archive-source', 'User', 'workspaceStorage');
      const globalDirectory = join(dirname(sourcePath), 'globalStorage');
      mkdirSync(sourcePath, { recursive: true });
      mkdirSync(globalDirectory, { recursive: true });
      const sourceBytes = Buffer.from('synthetic sqlite archive source');
      const sourceDb = join(globalDirectory, 'state.vscdb');
      writeFileSync(sourceDb, sourceBytes, { mode: 0o600 });
      backupDatabaseMock.mockImplementation(async (from: string, to: string) => {
        copyFileSync(from, to);
      });
      const outputPath = join(fixtureRoot, 'streamed.zip');
      const originalUmask = process.umask();
      const parentMode = lstatSync(fixtureRoot).mode & 0o777;
      let result;
      try {
        process.umask(0o000);
        result = await createBackup({ sourcePath, outputPath });
      } finally {
        process.umask(originalUmask);
      }

      expect(result?.success).toBe(true);
      expect(result?.manifest.producer).toBe(packageJson.version);
      expect(result?.manifest.cursorHistoryVersion).toBe(packageJson.version);
      expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(fixtureRoot).mode & 0o777).toBe(parentMode);
      expect(
        readdirSync(fixtureRoot).some((name) => name.startsWith('.cursor-history-backup-'))
      ).toBe(false);
      const validation = await validateBackup(outputPath);
      expect(validation.status).toBe('valid');
      expect(validation.validFiles).toEqual(['globalStorage/state.vscdb']);
    }
  );

  it('counts manifest.json in producer limits and self-validates under the same policy', async () => {
    const sourcePath = join(fixtureRoot, 'self-read-source', 'User', 'workspaceStorage');
    const globalDirectory = join(dirname(sourcePath), 'globalStorage');
    mkdirSync(sourcePath, { recursive: true });
    mkdirSync(globalDirectory, { recursive: true });
    writeFileSync(join(globalDirectory, 'state.vscdb'), Buffer.alloc(512, 0x41));
    backupDatabaseMock.mockImplementation(async (from: string, to: string) => {
      copyFileSync(from, to);
    });

    const rejectedPath = join(fixtureRoot, 'manifest-count-rejected.zip');
    const countError = await captureLimitError(
      createBackup({
        sourcePath,
        outputPath: rejectedPath,
        sourceReadLimits: { zipEntryCount: 1 },
      })
    );
    expectZipLimit(countError, 'zip-entry-count', 'records', 1);
    expect(countError.details.observedAtLeast).toBe(2);
    expect(existsSync(rejectedPath)).toBe(false);

    const sourceReadLimits = {
      zipCompressedBytes: 16 * 1024,
      zipEntryCount: 2,
      zipEntryBytes: 4 * 1024,
      zipAggregateBytes: 8 * 1024,
      zipCompressionRatio: 1,
    } as const;
    const outputPath = join(fixtureRoot, 'manifest-self-read.zip');
    expect((await createBackup({ sourcePath, outputPath, sourceReadLimits })).success).toBe(true);
    expect((await validateBackup(outputPath, { sourceReadLimits })).status).toBe('valid');
  });

  it.runIf(process.platform !== 'win32')(
    'preserves overwrite mode by default and applies explicit shared mode without changing umask',
    async () => {
      const sourcePath = join(fixtureRoot, 'mode-source', 'User', 'workspaceStorage');
      const globalDirectory = join(dirname(sourcePath), 'globalStorage');
      mkdirSync(sourcePath, { recursive: true });
      mkdirSync(globalDirectory, { recursive: true });
      writeFileSync(join(globalDirectory, 'state.vscdb'), Buffer.from('mode fixture'));
      backupDatabaseMock.mockImplementation(async (from: string, to: string) => {
        copyFileSync(from, to);
      });
      const outputPath = join(fixtureRoot, 'mode.zip');
      expect((await createBackup({ sourcePath, outputPath })).success).toBe(true);
      chmodSync(outputPath, 0o640);

      expect((await createBackup({ sourcePath, outputPath, force: true })).success).toBe(true);
      expect(lstatSync(outputPath).mode & 0o777).toBe(0o640);

      const originalUmask = process.umask();
      try {
        process.umask(0o022);
        expect(
          (
            await createBackup({
              sourcePath,
              outputPath,
              force: true,
              sharedPermissions: true,
            })
          ).success
        ).toBe(true);
        expect(process.umask()).toBe(0o022);
      } finally {
        process.umask(originalUmask);
      }
      expect(lstatSync(outputPath).mode & 0o777).toBe(0o644);
    }
  );

  it.runIf(process.platform !== 'win32')(
    'keeps a valid published archive and reports its actual mode when post-publication chmod fails',
    async () => {
      const sourcePath = join(fixtureRoot, 'permission-failure-source', 'User', 'workspaceStorage');
      const globalDirectory = join(dirname(sourcePath), 'globalStorage');
      mkdirSync(sourcePath, { recursive: true });
      mkdirSync(globalDirectory, { recursive: true });
      writeFileSync(join(globalDirectory, 'state.vscdb'), Buffer.from('permission fixture'));
      backupDatabaseMock.mockImplementation(async (from: string, to: string) => {
        copyFileSync(from, to);
      });
      const outputPath = join(fixtureRoot, 'published-before-permission-failure.zip');
      const originalUmask = process.umask(0o022);
      publicationModeFault.enabled = true;
      let caught: unknown;
      try {
        await createBackup({ sourcePath, outputPath, sharedPermissions: true });
      } catch (error) {
        caught = error;
      } finally {
        publicationModeFault.enabled = false;
        process.umask(originalUmask);
      }

      expect(caught).toBeInstanceOf(BackupPublishedPermissionError);
      expect(caught).toMatchObject({
        details: {
          published: true,
          outputPath,
          requestedMode: 0o644,
          actualMode: 0o600,
        },
      });
      expect(existsSync(outputPath)).toBe(true);
      expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
      expect((await validateBackup(outputPath)).status).toBe('valid');
      expect(
        readdirSync(fixtureRoot).some((name) => name.startsWith('.cursor-history-backup-'))
      ).toBe(false);
    }
  );

  it('keeps the prior archive byte-for-byte when cancellation or a bound fails before publication', async () => {
    const sourcePath = join(fixtureRoot, 'atomic-source', 'User', 'workspaceStorage');
    const globalDirectory = join(dirname(sourcePath), 'globalStorage');
    mkdirSync(sourcePath, { recursive: true });
    mkdirSync(globalDirectory, { recursive: true });
    writeFileSync(join(globalDirectory, 'state.vscdb'), Buffer.from('atomic fixture'));
    backupDatabaseMock.mockImplementation(async (from: string, to: string) => {
      copyFileSync(from, to);
    });
    const outputPath = join(fixtureRoot, 'atomic.zip');
    expect((await createBackup({ sourcePath, outputPath })).success).toBe(true);
    const original = readFileSync(outputPath);
    const controller = new AbortController();

    await expect(
      createBackup({
        sourcePath,
        outputPath,
        force: true,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'finalizing') controller.abort(new Error('cancel publish'));
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(readFileSync(outputPath)).toEqual(original);

    await expect(
      createBackup({
        sourcePath,
        outputPath,
        force: true,
        sourceReadLimits: { zipCompressedBytes: 1 },
      })
    ).rejects.toBeInstanceOf(SourceLimitExceededError);
    expect(readFileSync(outputPath)).toEqual(original);
    expect(
      readdirSync(fixtureRoot).some((name) => name.startsWith('.cursor-history-backup-'))
    ).toBe(false);
  });

  it('fails secure workspace creation without falling back to a shared predictable file', async () => {
    const priorTmpdir = process.env['TMPDIR'];
    process.env['TMPDIR'] = join(fixtureRoot, 'missing-temp-parent');
    try {
      await expect(openBackupDatabase(archivePath, 'globalStorage/state.vscdb')).rejects.toThrow();
      expect(snapshotPath).toBeUndefined();
    } finally {
      if (priorTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = priorTmpdir;
    }
  });

  it.runIf(process.platform !== 'win32')(
    'surfaces cleanup residue paths under an intentional permission leak mutation',
    async () => {
      openDatabaseMock.mockImplementation((path: string) => {
        snapshotPath = path;
        return databaseWithClose(vi.fn());
      });
      const database = await openBackupDatabase(archivePath, 'globalStorage/state.vscdb');
      const privateDirectory = dirname(snapshotPath!);
      chmodSync(privateDirectory, 0o500);
      let cleanupError: unknown;
      try {
        database.close();
      } catch (error) {
        cleanupError = error;
      }

      expect(cleanupError).toBeInstanceOf(TemporaryArtifactCleanupError);
      expect((cleanupError as TemporaryArtifactCleanupError).details.residuePaths).toEqual(
        expect.arrayContaining([privateDirectory, snapshotPath!])
      );
      expect(existsSync(snapshotPath!)).toBe(true);
      chmodSync(privateDirectory, 0o700);
      rmSync(privateDirectory, { force: true, recursive: true });
    }
  );

  it('cooperatively cancels streamed extraction after private staging begins with no residue', async () => {
    const largePath = join(fixtureRoot, 'large-cancel.zip');
    const largeFixture = buildZip([
      { name: 'globalStorage/state.vscdb', data: Buffer.alloc(32 * 1024 * 1024, 0x41) },
    ]);
    writeFileSync(largePath, largeFixture.buffer, { mode: 0o600 });
    const before = currentPrivateTempPaths();
    const controller = new AbortController();
    const operation = openBackupDatabase(largePath, 'globalStorage/state.vscdb', {
      signal: controller.signal,
    });

    let observedPrivateStaging = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = currentPrivateTempPaths();
      if (current.some((path) => !before.includes(path))) {
        observedPrivateStaging = true;
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(observedPrivateStaging).toBe(true);
    controller.abort(new Error('synthetic cancellation'));
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(currentPrivateTempPaths()).toEqual(before);
  }, 15_000);
});
