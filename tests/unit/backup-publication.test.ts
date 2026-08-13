import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  enforcePublishedArchiveMode,
  type PublishedArchiveIdentity,
  type PublishedArchiveModeOperations,
  type PublishedArchiveStat,
} from '../../src/core/backup-publication.js';
import { BackupPublishedPermissionError } from '../../src/core/errors.js';

const identity: PublishedArchiveIdentity = { device: 7n, inode: 11n };

function stat(mode: number, overrides: Partial<PublishedArchiveStat> = {}): PublishedArchiveStat {
  return { ...identity, mode, regularFile: true, ...overrides };
}

function operations(
  overrides: Partial<PublishedArchiveModeOperations> = {}
): PublishedArchiveModeOperations {
  return {
    openNoFollow: vi.fn(() => 23),
    statDescriptor: vi.fn(() => stat(0o600)),
    chmodDescriptor: vi.fn(),
    statPathNoFollow: vi.fn(() => stat(0o600)),
    close: vi.fn(),
    ...overrides,
  };
}

describe('published backup archive permissions', () => {
  it('uses lossless bigint filesystem identities for descriptor and path verification', () => {
    const source = readFileSync(resolve('src/core/backup-publication.ts'), 'utf8');
    const bigintStats = source.match(/(?:fstatSync|lstatSync)\([^\n]*\{ bigint: true \}\)/gu);

    expect(bigintStats).toHaveLength(2);
    expect(
      source.replace('{ bigint: true }', '{ bigint: false }').match(bigintStats![0]!)
    ).toBeNull();

    const largeIdentity = { device: 9_007_199_254_740_993n, inode: 9_007_199_254_740_995n };
    const ops = operations({
      statDescriptor: vi.fn(() => stat(0o600, largeIdentity)),
      statPathNoFollow: vi.fn(() => stat(0o600, largeIdentity)),
    });
    expect(() =>
      enforcePublishedArchiveMode('/backups/large-inode.zip', 0o600, largeIdentity, ops)
    ).not.toThrow();
  });

  it('skips chmod when the published inode already has the requested mode', () => {
    const ops = operations();

    enforcePublishedArchiveMode('/backups/complete.zip', 0o600, identity, ops);

    expect(ops.openNoFollow).toHaveBeenCalledOnce();
    expect(ops.chmodDescriptor).not.toHaveBeenCalled();
    expect(ops.statPathNoFollow).toHaveBeenCalledOnce();
    expect(ops.close).toHaveBeenCalledWith(23);
  });

  it('applies a different requested mode through the bound descriptor once', () => {
    const statDescriptor = vi
      .fn<PublishedArchiveModeOperations['statDescriptor']>()
      .mockReturnValueOnce(stat(0o600))
      .mockReturnValueOnce(stat(0o640));
    const ops = operations({
      statDescriptor,
      statPathNoFollow: vi.fn(() => stat(0o640)),
    });

    enforcePublishedArchiveMode('/backups/shared.zip', 0o640, identity, ops);

    expect(ops.chmodDescriptor).toHaveBeenCalledOnce();
    expect(ops.chmodDescriptor).toHaveBeenCalledWith(23, 0o640);
  });

  it('reports a committed archive when opening without symlink following fails', () => {
    const cause = new Error('synthetic O_NOFOLLOW rejection');
    const ops = operations({
      openNoFollow: vi.fn(() => {
        throw cause;
      }),
    });

    expect(() =>
      enforcePublishedArchiveMode('/backups/published.zip', 0o600, identity, ops)
    ).toThrow(
      expect.objectContaining({
        code: 'BACKUP_PUBLISHED_PERMISSION_FAILED',
        details: expect.objectContaining({
          published: true,
          outputPath: '/backups/published.zip',
          requestedMode: 0o600,
          actualMode: null,
        }),
        cause,
      })
    );
    expect(ops.chmodDescriptor).not.toHaveBeenCalled();
  });

  it('reports a committed archive and its observed inode mode when fchmod fails', () => {
    const cause = new Error('synthetic fchmod failure');
    const ops = operations({
      chmodDescriptor: vi.fn(() => {
        throw cause;
      }),
    });
    let caught: unknown;

    try {
      enforcePublishedArchiveMode('/backups/published.zip', 0o640, identity, ops);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupPublishedPermissionError);
    expect(caught).toMatchObject({
      code: 'BACKUP_PUBLISHED_PERMISSION_FAILED',
      details: {
        published: true,
        outputPath: '/backups/published.zip',
        requestedMode: 0o640,
        actualMode: 0o600,
        remedy: expect.stringContaining('Do not retry with --force'),
      },
      cause,
    });
    expect(ops.close).toHaveBeenCalledWith(23);
  });

  it('never chmods a replacement inode opened after publication', () => {
    const replacement = stat(0o644, { inode: 99n });
    const ops = operations({ statDescriptor: vi.fn(() => replacement) });

    expect(() =>
      enforcePublishedArchiveMode('/backups/published.zip', 0o600, identity, ops)
    ).toThrow(
      expect.objectContaining({
        code: 'BACKUP_PUBLISHED_PERMISSION_FAILED',
        details: expect.objectContaining({ actualMode: 0o644 }),
      })
    );
    expect(ops.chmodDescriptor).not.toHaveBeenCalled();
  });

  it('detects a path replacement after descriptor-bound chmod', () => {
    const statDescriptor = vi
      .fn<PublishedArchiveModeOperations['statDescriptor']>()
      .mockReturnValueOnce(stat(0o600))
      .mockReturnValueOnce(stat(0o640));
    const ops = operations({
      statDescriptor,
      statPathNoFollow: vi.fn(() => stat(0o640, { inode: 99n })),
    });

    expect(() =>
      enforcePublishedArchiveMode('/backups/published.zip', 0o640, identity, ops)
    ).toThrow(
      expect.objectContaining({
        code: 'BACKUP_PUBLISHED_PERMISSION_FAILED',
        details: expect.objectContaining({ actualMode: 0o640 }),
      })
    );
    expect(ops.chmodDescriptor).toHaveBeenCalledWith(23, 0o640);
  });
});
