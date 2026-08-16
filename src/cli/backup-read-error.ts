import { BackupEntryNotFoundError } from '../core/backup.js';
import { ZipArchiveFormatError } from '../core/zip-stream.js';
import { CliError, ExitCode } from './errors.js';

/**
 * Preserve the released command-level invalid-backup contract when strict workspace scope performs
 * lazy integrity validation instead of scanning the whole archive up front.
 */
export function adaptScopedBackupReadError(error: unknown, scopedBackupRead: boolean): unknown {
  if (
    !scopedBackupRead ||
    (!(error instanceof ZipArchiveFormatError) && !(error instanceof BackupEntryNotFoundError))
  ) {
    return error;
  }

  const detail = error instanceof Error && error.message ? error.message : 'Invalid backup entry';
  return new CliError(
    'Invalid backup',
    ExitCode.NOT_FOUND,
    undefined,
    undefined,
    Object.freeze({ error: 'Invalid backup', errors: Object.freeze([detail]) })
  );
}
