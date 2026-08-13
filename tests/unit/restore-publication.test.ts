import type { BigIntStats } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { PublishedArchiveIdentity } from '../../src/core/backup-publication.js';
import { TemporaryArtifactCleanupError } from '../../src/core/errors.js';
import {
  commitRestorePublication,
  type RestorePublicationOperations,
} from '../../src/core/restore-publication.js';

const identity: PublishedArchiveIdentity = { device: 5n, inode: 9n };

function stat(inode = identity.inode): BigIntStats {
  return {
    dev: identity.device,
    ino: inode,
    isFile: () => true,
  } as BigIntStats;
}

function operations(
  overrides: Partial<RestorePublicationOperations> = {}
): RestorePublicationOperations {
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

describe('restore publication commit ownership', () => {
  it('does not inspect or delete a force-stage pathname reused after rename', () => {
    const unlink = vi.fn();
    const statPathNoFollow = vi.fn(() => stat(99n));
    const ops = operations({ rename: vi.fn(), unlink, statPathNoFollow });
    const onCommit = vi.fn();

    commitRestorePublication(
      '/target/.restore.tmp',
      '/target/state.vscdb',
      true,
      identity,
      onCommit,
      ops
    );

    expect(ops.rename).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
    expect(statPathNoFollow).not.toHaveBeenCalled();
  });

  it('does not delete a non-force stage replacement after cleanup fails', () => {
    const unlink = vi.fn(() => {
      throw failure('EACCES', 'synthetic unlink failure');
    });
    const ops = operations({ unlink, statPathNoFollow: vi.fn(() => stat(99n)) });

    expect(() =>
      commitRestorePublication(
        '/target/.restore.tmp',
        '/target/state.vscdb',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).not.toThrow();
    expect(unlink).toHaveBeenCalledOnce();
  });

  it('does not delete a replacement appearing after the second unlink failure', () => {
    const unlink = vi.fn(() => {
      throw failure('EACCES', 'synthetic repeated unlink failure');
    });
    const statPathNoFollow = vi
      .fn<RestorePublicationOperations['statPathNoFollow']>()
      .mockReturnValueOnce(stat())
      .mockReturnValueOnce(stat(99n));
    const ops = operations({ unlink, statPathNoFollow });

    expect(() =>
      commitRestorePublication(
        '/target/.restore.tmp',
        '/target/state.vscdb',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).not.toThrow();
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(statPathNoFollow).toHaveBeenCalledTimes(2);
  });

  it('does not report a private residue when final identity inspection fails', () => {
    const unlink = vi.fn(() => {
      throw failure('EACCES', 'synthetic repeated unlink failure');
    });
    const statPathNoFollow = vi
      .fn<RestorePublicationOperations['statPathNoFollow']>()
      .mockReturnValueOnce(stat())
      .mockImplementationOnce(() => {
        throw failure('EIO', 'synthetic final identity failure');
      });
    const ops = operations({ unlink, statPathNoFollow });

    expect(() =>
      commitRestorePublication(
        '/target/.restore.tmp',
        '/target/state.vscdb',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).toThrow(
      expect.objectContaining({
        code: 'TEMPORARY_ARTIFACT_CLEANUP_FAILED',
        details: expect.objectContaining({
          residueCount: 0,
          residuePaths: [],
          unverifiedResidueCount: 1,
          unverifiedResiduePaths: ['/target/.restore.tmp'],
        }),
      })
    );
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(statPathNoFollow).toHaveBeenCalledTimes(2);
  });

  it('throws typed cleanup residue only while the sibling remains on the committed inode', () => {
    const cause = failure('EBUSY', 'synthetic persistent cleanup failure');
    const unlink = vi.fn(() => {
      throw cause;
    });
    const ops = operations({ unlink });
    const onCommit = vi.fn();

    expect(() =>
      commitRestorePublication(
        '/target/.restore.tmp',
        '/target/state.vscdb',
        false,
        identity,
        onCommit,
        ops
      )
    ).toThrow(
      expect.objectContaining({
        code: 'TEMPORARY_ARTIFACT_CLEANUP_FAILED',
        details: expect.objectContaining({
          residueCount: 1,
          residuePaths: ['/target/.restore.tmp'],
          remedy: expect.stringContaining('Remove only verified private temporary paths'),
        }),
        cause,
      })
    );
    expect(onCommit).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  it('uses a successful cleanup retry without surfacing a false failure', () => {
    const unlink = vi
      .fn<RestorePublicationOperations['unlink']>()
      .mockImplementationOnce(() => {
        throw failure('EBUSY', 'synthetic transient cleanup failure');
      })
      .mockImplementationOnce(() => undefined);
    const ops = operations({ unlink });

    expect(() =>
      commitRestorePublication(
        '/target/.restore.tmp',
        '/target/state.vscdb',
        false,
        identity,
        vi.fn(),
        ops
      )
    ).not.toThrow();
    expect(unlink).toHaveBeenCalledTimes(2);
  });
});
