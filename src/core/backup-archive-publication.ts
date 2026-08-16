import { linkSync, lstatSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs';

import type { PublishedArchiveIdentity } from './backup-publication.js';
import { BackupPublishedCleanupError } from './errors.js';

const CLEANUP_ATTEMPTS = 2;

/** Filesystem operations injected only by focused publication fault tests. */
export interface BackupArchivePublicationOperations {
  rename(sourcePath: string, destinationPath: string): void;
  link(sourcePath: string, destinationPath: string): void;
  unlink(path: string): void;
  statPathNoFollow(path: string): BigIntStats;
}

const DEFAULT_OPERATIONS: BackupArchivePublicationOperations = Object.freeze({
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

function pathIdentityVerified(
  path: string,
  expected: PublishedArchiveIdentity,
  operations: BackupArchivePublicationOperations
): boolean {
  try {
    return hasIdentity(operations.statPathNoFollow(path), expected);
  } catch {
    return false;
  }
}

/**
 * Publish one complete private archive and remove only the sibling name still bound to its inode.
 *
 * Rename/link is the commit point. Force rename transfers ownership away from `stagePath`, so this
 * helper never probes or removes that pathname afterward. Non-force publication retries sibling
 * unlink once, but stops without touching a replacement inode if the private name changes identity.
 */
export function publishBackupArchiveStage(
  stagePath: string,
  outputPath: string,
  force: boolean,
  identity: PublishedArchiveIdentity,
  onCommit: () => void,
  operations: BackupArchivePublicationOperations = DEFAULT_OPERATIONS
): void {
  if (force) {
    operations.rename(stagePath, outputPath);
    onCommit();
    return;
  }

  operations.link(stagePath, outputPath);
  onCommit();

  let cleanupFailure: unknown;
  let stageIdentityVerified = false;
  let stageIdentityUnverified = false;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    try {
      operations.unlink(stagePath);
      return;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      cleanupFailure = error;
    }

    stageIdentityVerified = false;
    stageIdentityUnverified = false;
    try {
      const current = operations.statPathNoFollow(stagePath);
      // The completed archive no longer owns this pathname. Never delete a replacement entry.
      if (!hasIdentity(current, identity)) return;
      stageIdentityVerified = true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      cleanupFailure = error;
      stageIdentityUnverified = true;
      break;
    }
  }

  throw new BackupPublishedCleanupError(
    outputPath,
    pathIdentityVerified(outputPath, identity, operations),
    stageIdentityVerified ? [stagePath] : [],
    cleanupFailure,
    stageIdentityUnverified ? [stagePath] : []
  );
}
