import type { BigIntStats } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  publishBackupArchiveStage,
  type BackupArchivePublicationOperations,
} from '../../src/core/backup-archive-publication.js';
import type { PublishedArchiveIdentity } from '../../src/core/backup-publication.js';
import { BackupPublishedCleanupError } from '../../src/core/errors.js';

const identity: PublishedArchiveIdentity = { device: 7n, inode: 11n };

function stat(overrides: Partial<{ device: bigint; inode: bigint; regularFile: boolean }> = {}) {
  const value = {
    device: identity.device,
    inode: identity.inode,
    regularFile: true,
    ...overrides,
  };
  return {
    dev: value.device,
    ino: value.inode,
    isFile: () => value.regularFile,
  } as BigIntStats;
}

function operations(
  overrides: Partial<BackupArchivePublicationOperations> = {}
): BackupArchivePublicationOperations {
  return {
    rename: vi.fn(),
    link: vi.fn(),
    unlink: vi.fn(),
    statPathNoFollow: vi.fn(() => stat()),
    ...overrides,
  };
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('backup archive publication commit cleanup', () => {
  it('reports a typed committed result after identity-bound sibling cleanup exhausts retries', () => {
    const cause = failure('EACCES', 'synthetic persistent sibling unlink failure');
    const ops = operations({
      unlink: vi.fn(() => {
        throw cause;
      }),
    });
    const onCommit = vi.fn();

    expect(() =>
      publishBackupArchiveStage(
        '/backups/.private.tmp',
        '/backups/final.zip',
        false,
        identity,
        onCommit,
        ops
      )
    ).toThrow(
      expect.objectContaining({
        code: 'BACKUP_PUBLISHED_CLEANUP_FAILED',
        details: {
          published: true,
          outputPath: '/backups/final.zip',
          pathIdentityVerified: true,
          residueCount: 1,
          residuePaths: ['/backups/.private.tmp'],
          unverifiedResidueCount: 0,
          unverifiedResiduePaths: [],
          remedy: expect.stringContaining('Do not retry with --force'),
        },
        cause,
      })
    );
    expect(onCommit).toHaveBeenCalledOnce();
    expect(ops.link).toHaveBeenCalledOnce();
    expect(ops.unlink).toHaveBeenCalledTimes(2);
  });

  it('succeeds when the identity-bound sibling unlink retry succeeds', () => {
    const unlink = vi
      .fn<BackupArchivePublicationOperations['unlink']>()
      .mockImplementationOnce(() => {
        throw failure('EBUSY', 'synthetic transient unlink failure');
      })
      .mockImplementationOnce(() => undefined);
    const ops = operations({ unlink });

    expect(() =>
      publishBackupArchiveStage(
        '/backups/.private.tmp',
        '/backups/final.zip',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).not.toThrow();
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  it('does not remove a stage-path replacement after force rename transfers ownership', () => {
    const unlink = vi.fn();
    const statPathNoFollow = vi.fn(() => stat({ inode: 99n }));
    const ops = operations({
      rename: vi.fn(),
      unlink,
      statPathNoFollow,
    });

    publishBackupArchiveStage(
      '/backups/.private.tmp',
      '/backups/final.zip',
      true,
      identity,
      vi.fn(),
      ops
    );

    expect(ops.rename).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
    expect(statPathNoFollow).not.toHaveBeenCalled();
  });

  it('stops cleanup without touching a non-force stage-path replacement', () => {
    const unlink = vi.fn(() => {
      throw failure('EACCES', 'synthetic unlink race');
    });
    const ops = operations({
      unlink,
      statPathNoFollow: vi.fn(() => stat({ inode: 99n })),
    });

    expect(() =>
      publishBackupArchiveStage(
        '/backups/.private.tmp',
        '/backups/final.zip',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).not.toThrow();
    expect(unlink).toHaveBeenCalledOnce();
  });

  it('stops after a replacement appears between the first and second unlink failures', () => {
    const unlink = vi.fn(() => {
      throw failure('EACCES', 'synthetic repeated unlink race');
    });
    const statPathNoFollow = vi
      .fn<BackupArchivePublicationOperations['statPathNoFollow']>()
      .mockReturnValueOnce(stat())
      .mockReturnValueOnce(stat({ inode: 99n }));
    const ops = operations({ unlink, statPathNoFollow });

    expect(() =>
      publishBackupArchiveStage(
        '/backups/.private.tmp',
        '/backups/final.zip',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).not.toThrow();
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(statPathNoFollow).toHaveBeenCalledTimes(2);
  });

  it('reports an unverified path without calling it owner-private residue', () => {
    const cause = failure('EIO', 'synthetic final identity inspection failure');
    const unlink = vi.fn(() => {
      throw failure('EACCES', 'synthetic persistent unlink failure');
    });
    const statPathNoFollow = vi
      .fn<BackupArchivePublicationOperations['statPathNoFollow']>()
      .mockReturnValueOnce(stat())
      .mockImplementationOnce(() => {
        throw cause;
      })
      .mockReturnValueOnce(stat());
    const ops = operations({ unlink, statPathNoFollow });

    expect(() =>
      publishBackupArchiveStage(
        '/backups/.private.tmp',
        '/backups/final.zip',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).toThrow(
      expect.objectContaining({
        code: 'BACKUP_PUBLISHED_CLEANUP_FAILED',
        details: expect.objectContaining({
          pathIdentityVerified: true,
          residueCount: 0,
          residuePaths: [],
          unverifiedResidueCount: 1,
          unverifiedResiduePaths: ['/backups/.private.tmp'],
          remedy: expect.stringContaining('Do not delete unverified residue paths'),
        }),
        cause,
      })
    );
  });
});
