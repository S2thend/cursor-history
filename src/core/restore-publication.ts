import { linkSync, lstatSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs';

import type { PublishedArchiveIdentity } from './backup-publication.js';
import { TemporaryArtifactCleanupError } from './errors.js';

const CLEANUP_ATTEMPTS = 2;

/** Filesystem operations injected only by focused restore publication fault tests. */
export interface RestorePublicationOperations {
  rename(sourcePath: string, destinationPath: string): void;
  link(sourcePath: string, destinationPath: string): void;
  unlink(path: string): void;
  statPathNoFollow(path: string): BigIntStats;
}

const DEFAULT_OPERATIONS: RestorePublicationOperations = Object.freeze({
  rename: (sourcePath: string, destinationPath: string): void =>
    renameSync(sourcePath, destinationPath),
  link: (sourcePath: string, destinationPath: string): void =>
    linkSync(sourcePath, destinationPath),
  unlink: (path: string): void => unlinkSync(path),
  statPathNoFollow: (path: string): BigIntStats => lstatSync(path, { bigint: true }),
});

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function hasIdentity(stat: BigIntStats, expected: PublishedArchiveIdentity): boolean {
  return stat.isFile() && stat.dev === expected.device && stat.ino === expected.inode;
}

function cleanupError(
  path: string,
  cause: unknown,
  identityVerified = true
): TemporaryArtifactCleanupError {
  const error = new TemporaryArtifactCleanupError(
    identityVerified ? [path] : [],
    identityVerified ? [] : [path]
  );
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
}

/**
 * Commit one complete restore inode and clean only a private sibling still bound to that inode.
 *
 * Force rename transfers pathname ownership at the commit point and therefore performs no later
 * cleanup by the old stage name. Non-force link publication retries cleanup once, verifies the
 * sibling identity after every failure, and never unlinks a replacement pathname occupant.
 */
export function commitRestorePublication(
  publicationPath: string,
  destinationPath: string,
  replaceExisting: boolean,
  identity: PublishedArchiveIdentity,
  onCommit: () => void,
  operations: RestorePublicationOperations = DEFAULT_OPERATIONS
): void {
  if (replaceExisting) {
    operations.rename(publicationPath, destinationPath);
    onCommit();
    return;
  }

  operations.link(publicationPath, destinationPath);
  onCommit();

  let failure: unknown;
  let siblingIdentityVerified = false;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    try {
      operations.unlink(publicationPath);
      return;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      failure = error;
    }

    siblingIdentityVerified = false;
    try {
      const current = operations.statPathNoFollow(publicationPath);
      if (!hasIdentity(current, identity)) return;
      siblingIdentityVerified = true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw cleanupError(publicationPath, error, false);
    }
  }

  if (!siblingIdentityVerified) throw cleanupError(publicationPath, failure, false);
  throw cleanupError(publicationPath, failure);
}
