import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { BackupPublishedPermissionError } from './errors.js';

/** Stable filesystem identity captured from the private archive before publication. */
export interface PublishedArchiveIdentity {
  device: bigint;
  inode: bigint;
}

/** Minimum stat projection used to bind permission changes to one regular-file inode. */
export interface PublishedArchiveStat extends PublishedArchiveIdentity {
  mode: number;
  regularFile: boolean;
}

/** Filesystem operations injected only by focused fault and race tests. */
export interface PublishedArchiveModeOperations {
  openNoFollow(path: string): number;
  statDescriptor(descriptor: number): PublishedArchiveStat;
  chmodDescriptor(descriptor: number, mode: number): void;
  statPathNoFollow(path: string): PublishedArchiveStat;
  close(descriptor: number): void;
}

function projectStat(stat: Stats | BigIntStats): PublishedArchiveStat {
  return {
    device: BigInt(stat.dev),
    inode: BigInt(stat.ino),
    mode: Number(stat.mode) & 0o777,
    regularFile: stat.isFile(),
  };
}

const DEFAULT_MODE_OPERATIONS: PublishedArchiveModeOperations = Object.freeze({
  openNoFollow: (path: string): number =>
    openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
  statDescriptor: (descriptor: number): PublishedArchiveStat =>
    projectStat(fstatSync(descriptor, { bigint: true })),
  chmodDescriptor: (descriptor: number, mode: number): void => fchmodSync(descriptor, mode),
  statPathNoFollow: (path: string): PublishedArchiveStat =>
    projectStat(lstatSync(path, { bigint: true })),
  close: (descriptor: number): void => closeSync(descriptor),
});

function hasIdentity(stat: PublishedArchiveIdentity, expected: PublishedArchiveIdentity): boolean {
  return stat.device === expected.device && stat.inode === expected.inode;
}

function identityError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'code', { configurable: true, value: 'ESTALE' });
  return error;
}

/**
 * Apply the requested mode to the exact archive inode that crossed the publication commit point.
 *
 * The descriptor is opened without following symlinks, checked against the identity captured from
 * the private stage, changed with `fchmod`, and checked against the final path again. Matching
 * modes avoid a redundant chmod. A failure never rolls back the completed rename/link; instead it
 * reports the requested and last safely observed modes explicitly.
 */
export function enforcePublishedArchiveMode(
  outputPath: string,
  requestedMode: number,
  expectedIdentity: PublishedArchiveIdentity,
  operations: PublishedArchiveModeOperations = DEFAULT_MODE_OPERATIONS
): void {
  let descriptor: number | undefined;
  let actualMode: number | null = null;
  let pathIdentityVerified = false;
  let pathIdentityVerificationAttempted = false;
  let failure: unknown;

  const verifyFinalPathIdentity = (): void => {
    pathIdentityVerificationAttempted = true;
    const finalPath = operations.statPathNoFollow(outputPath);
    if (!finalPath.regularFile || !hasIdentity(finalPath, expectedIdentity)) {
      throw identityError('Published backup path was replaced during permission verification.');
    }
    actualMode = finalPath.mode;
    pathIdentityVerified = true;
  };

  try {
    descriptor = operations.openNoFollow(outputPath);
    const initial = operations.statDescriptor(descriptor);
    if (!initial.regularFile || !hasIdentity(initial, expectedIdentity)) {
      throw identityError('Published backup path no longer refers to the completed archive inode.');
    }
    actualMode = initial.mode;

    if (initial.mode !== requestedMode) {
      operations.chmodDescriptor(descriptor, requestedMode);
      const changed = operations.statDescriptor(descriptor);
      if (!changed.regularFile || !hasIdentity(changed, expectedIdentity)) {
        throw identityError(
          'Published backup descriptor changed identity during permission update.'
        );
      }
      actualMode = changed.mode;
      if (changed.mode !== requestedMode) {
        throw new Error('Published backup inode did not retain the requested permission mode.');
      }
    }

    verifyFinalPathIdentity();
  } catch (cause) {
    failure = cause;
  } finally {
    // Permission operations can fail before the ordinary final-path check. Make one best-effort
    // identity check so the public error can distinguish a verified published path from an
    // untrusted or replaced pathname. Preserve the primary failure as the cause.
    if (failure !== undefined && !pathIdentityVerificationAttempted) {
      try {
        verifyFinalPathIdentity();
      } catch {
        pathIdentityVerified = false;
      }
    }
    if (descriptor !== undefined) {
      try {
        operations.close(descriptor);
      } catch (cause) {
        failure ??= cause;
      }
    }
  }

  if (failure !== undefined) {
    throw new BackupPublishedPermissionError(
      outputPath,
      requestedMode,
      actualMode,
      failure,
      pathIdentityVerified
    );
  }
}
