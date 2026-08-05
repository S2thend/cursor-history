import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/core/database/types.js';

const { openSyncMock } = vi.hoisted(() => ({
  openSyncMock: vi.fn(),
}));

vi.mock('../../src/core/database/registry.js', () => ({
  registry: {
    openSync: openSyncMock,
  },
}));

vi.mock('../../src/core/database/index.js', () => ({
  backupDatabase: vi.fn(),
}));

import { openBackupDatabase } from '../../src/core/backup.js';

function databaseWithClose(close: () => void): Database {
  return {
    prepare: vi.fn(),
    runSQL: vi.fn(),
    close,
  } as unknown as Database;
}

describe('backup plaintext snapshot isolation', () => {
  let fixtureRoot: string;
  let archivePath: string;
  let snapshotPath: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
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
    'platform:posix: confines an open snapshot to a 0700 directory and a 0600 file',
    async () => {
      openSyncMock.mockImplementation((path: string) => {
        snapshotPath = path;
        return databaseWithClose(vi.fn());
      });

      const database = await openBackupDatabase(archivePath, 'globalStorage/state.vscdb');

      expect(snapshotPath).toBeDefined();
      const privateDirectory = dirname(snapshotPath!);
      expect(basename(privateDirectory)).toMatch(/^cursor-history-backup-read-/u);
      expect(lstatSync(privateDirectory).mode & 0o777).toBe(0o700);
      expect(lstatSync(snapshotPath!).mode & 0o777).toBe(0o600);
      expect(readFileSync(snapshotPath!)).toEqual(Buffer.from('synthetic sqlite bytes'));

      database.close();

      expect(existsSync(snapshotPath!)).toBe(false);
      expect(existsSync(privateDirectory)).toBe(false);
    }
  );

  it('removes the private workspace when opening the snapshot fails', async () => {
    openSyncMock.mockImplementation((path: string) => {
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

  it('removes the private workspace even when closing the database fails', async () => {
    openSyncMock.mockImplementation((path: string) => {
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
});
