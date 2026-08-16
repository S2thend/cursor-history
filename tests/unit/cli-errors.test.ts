import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ExitCode,
  CliError,
  CursorNotFoundError,
  NoHistoryError,
  SessionNotFoundError,
  FileExistsError,
  NoSearchResultsError,
  formatFatalJson,
  handleError,
  mapSessionIntegrityError,
} from '../../src/cli/errors.js';
import {
  BackupPublishedPermissionError,
  BackupPublishedCleanupError,
  BackupWorkspaceScopeMetadataError,
  RestoreRollbackError,
  TemporaryArtifactCleanupError,
  SessionAmbiguityError,
  SourceLimitConfigurationError,
  SourceLimitExceededError,
  SourceEncodingError,
  WorkspaceAmbiguityError,
} from '../../src/core/errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExitCode', () => {
  it('has expected values', () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.USAGE_ERROR).toBe(2);
    expect(ExitCode.NOT_FOUND).toBe(3);
    expect(ExitCode.IO_ERROR).toBe(4);
  });
});

describe('CliError', () => {
  it('has message and default exit code', () => {
    const err = new CliError('test error');
    expect(err.message).toBe('test error');
    expect(err.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(err.name).toBe('CliError');
  });

  it('accepts custom exit code', () => {
    const err = new CliError('test', ExitCode.IO_ERROR);
    expect(err.exitCode).toBe(ExitCode.IO_ERROR);
  });
});

describe('CursorNotFoundError', () => {
  it('includes search path in message', () => {
    const err = new CursorNotFoundError('/search/path');
    expect(err.message).toContain('/search/path');
    expect(err.exitCode).toBe(ExitCode.NOT_FOUND);
    expect(err.name).toBe('CursorNotFoundError');
  });
});

describe('NoHistoryError', () => {
  it('has NOT_FOUND exit code', () => {
    const err = new NoHistoryError();
    expect(err.message).toContain('No chat history');
    expect(err.exitCode).toBe(ExitCode.NOT_FOUND);
  });
});

describe('SessionNotFoundError', () => {
  it('shows range when maxIndex > 0', () => {
    const err = new SessionNotFoundError({ index: 5, maxIndex: 3 });
    expect(err.message).toContain('Session #5');
    expect(err.message).toContain('1-3');
    expect(err.exitCode).toBe(ExitCode.NOT_FOUND);
  });

  it('shows no sessions message when maxIndex is 0', () => {
    const err = new SessionNotFoundError({ index: 1, maxIndex: 0 });
    expect(err.message).toContain('No sessions found');
  });

  it('shows composer ID when session not found by ID', () => {
    const err = new SessionNotFoundError({ composerId: 'xyz-123-abc' });
    expect(err.message).toBe('Session not found: xyz-123-abc');
    expect(err.exitCode).toBe(ExitCode.NOT_FOUND);
  });
});

describe('FileExistsError', () => {
  it('includes path and --force hint', () => {
    const err = new FileExistsError('/output.md');
    expect(err.message).toContain('/output.md');
    expect(err.message).toContain('--force');
    expect(err.exitCode).toBe(ExitCode.IO_ERROR);
  });
});

describe('NoSearchResultsError', () => {
  it('includes query in message', () => {
    const err = new NoSearchResultsError('search term');
    expect(err.message).toContain('search term');
    expect(err.exitCode).toBe(ExitCode.NOT_FOUND);
  });
});

describe('handleError', () => {
  it('exits with CliError exit code', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handleError(new CliError('cli error', ExitCode.IO_ERROR));
    expect(mockExit).toHaveBeenCalledWith(ExitCode.IO_ERROR);
  });

  it('exits with GENERAL_ERROR for generic Error', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handleError(new Error('generic'));
    expect(mockExit).toHaveBeenCalledWith(ExitCode.GENERAL_ERROR);
  });

  it('exits with GENERAL_ERROR for non-Error', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handleError('string error');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.GENERAL_ERROR);
  });

  it('writes one fatal JSON object to stderr and leaves stdout unused', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    const stdout = vi.spyOn(process.stdout, 'write');

    handleError(new CliError('missing', ExitCode.NOT_FOUND), { json: true });

    expect(mockExit).toHaveBeenCalledWith(ExitCode.NOT_FOUND);
    expect(stdout).not.toHaveBeenCalled();
    const fatalWrites = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((chunk) => chunk.startsWith('{'));
    expect(fatalWrites).toHaveLength(1);
    expect(JSON.parse(fatalWrites[0]!)).toEqual({
      error: 'missing',
      code: 'CLI_NOT_FOUND',
    });
  });

  it('prints safe candidates and a remedy for ambiguous workspace input', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    handleError(new WorkspaceAmbiguityError('project', ['/work/b/project', '/work/a/project']));

    expect(mockExit).toHaveBeenCalledWith(ExitCode.GENERAL_ERROR);
    expect(consoleError).toHaveBeenCalledWith('Candidates:\n  /work/a/project\n  /work/b/project');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Remedy: Use a longer component-aligned suffix')
    );
  });

  it('preserves locked legacy fields while adding a stable code', () => {
    const output = formatFatalJson(
      new CliError('Cursor data not found', ExitCode.NOT_FOUND, undefined, undefined, {
        error: 'Cursor data not found',
        path: '/fixture/v017/missing-data',
      })
    );

    expect(JSON.parse(output)).toEqual({
      error: 'Cursor data not found',
      path: '/fixture/v017/missing-data',
      code: 'CLI_NOT_FOUND',
    });
  });

  it('never overwrites released code or details fields in a legacy envelope', () => {
    const output = formatFatalJson(
      new CliError(
        'released',
        ExitCode.GENERAL_ERROR,
        'NEW_CODE',
        { remedy: 'new remedy' },
        {
          error: 'released',
          code: 'RELEASED_CODE',
          details: { released: true },
        }
      )
    );

    expect(JSON.parse(output)).toEqual({
      error: 'released',
      code: 'RELEASED_CODE',
      details: { released: true },
    });
  });

  it('serializes only typed safe details for integrity failures', () => {
    const output = formatFatalJson(
      new SourceLimitExceededError({
        sourceKind: 'sqlite',
        bound: 'sqlite-row-count',
        unit: 'rows',
        limit: 5,
        observedAtLeast: 6,
        outcome: 'fatal',
      })
    );
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed['code']).toBe('SOURCE_LIMIT_EXCEEDED');
    expect(parsed['details']).toMatchObject({
      sourceKind: 'sqlite',
      bound: 'sqlite-row-count',
      unit: 'rows',
      limit: 5,
      observedAtLeast: 6,
      outcome: 'fatal',
    });
    expect(output).not.toContain('/private/');
  });
});

describe('feature-016 typed error mapping', () => {
  it('maps configuration and fatal source failures to stable exit categories', () => {
    const configuration = mapSessionIntegrityError(
      new SourceLimitConfigurationError('jsonlRecordBytes', 0, 'must be positive')
    );
    expect(configuration.code).toBe('SOURCE_LIMIT_CONFIGURATION_INVALID');
    expect(configuration.exitCode).toBe(ExitCode.USAGE_ERROR);

    const exceeded = mapSessionIntegrityError(
      new SourceLimitExceededError({
        sourceKind: 'zip',
        bound: 'zip-compression-ratio',
        unit: 'ratio',
        limit: 200,
        observedAtLeast: 200.5,
        outcome: 'fatal',
      })
    );
    expect(exceeded.exitCode).toBe(ExitCode.IO_ERROR);
    expect(exceeded.details?.['observedAtLeast']).toBe(200.5);

    const encoding = mapSessionIntegrityError(new SourceEncodingError('jsonl', 'fatal'));
    expect(encoding.code).toBe('SOURCE_ENCODING_INVALID');
    expect(encoding.exitCode).toBe(ExitCode.IO_ERROR);

    const published = mapSessionIntegrityError(
      new BackupPublishedPermissionError('/backups/published.zip', 0o640, 0o600, undefined, true)
    );
    expect(published.code).toBe('BACKUP_PUBLISHED_PERMISSION_FAILED');
    expect(published.exitCode).toBe(ExitCode.IO_ERROR);
    expect(published.details).toMatchObject({
      published: true,
      outputPath: '/backups/published.zip',
      requestedMode: 0o640,
      actualMode: 0o600,
      pathIdentityVerified: true,
    });

    const publishedCleanup = mapSessionIntegrityError(
      new BackupPublishedCleanupError('/backups/published.zip', true, ['/backups/.private-stage'])
    );
    expect(publishedCleanup.code).toBe('BACKUP_PUBLISHED_CLEANUP_FAILED');
    expect(publishedCleanup.exitCode).toBe(ExitCode.IO_ERROR);
    expect(publishedCleanup.details).toMatchObject({
      published: true,
      outputPath: '/backups/published.zip',
      pathIdentityVerified: true,
      residueCount: 1,
      residuePaths: ['/backups/.private-stage'],
      unverifiedResidueCount: 0,
      unverifiedResiduePaths: [],
    });

    const legacyScopedBackup = mapSessionIntegrityError(new BackupWorkspaceScopeMetadataError(2));
    expect(legacyScopedBackup.code).toBe('BACKUP_WORKSPACE_SCOPE_METADATA_REQUIRED');
    expect(legacyScopedBackup.exitCode).toBe(ExitCode.IO_ERROR);
    expect(legacyScopedBackup.details).toMatchObject({ workspaceCount: 2 });

    const rollback = mapSessionIntegrityError(
      new RestoreRollbackError(
        1,
        ['globalStorage/state.vscdb'],
        new TemporaryArtifactCleanupError(
          ['/private/verified-stage'],
          ['/private/unverified-stage']
        )
      )
    );
    expect(rollback.code).toBe('RESTORE_ROLLBACK_INCOMPLETE');
    expect(rollback.exitCode).toBe(ExitCode.IO_ERROR);
    expect(rollback.details).toMatchObject({
      publishedFileCount: 1,
      residualFileCount: 1,
      residualFiles: ['globalStorage/state.vscdb'],
      residueCount: 1,
      residuePaths: ['/private/verified-stage'],
      unverifiedResidueCount: 1,
      unverifiedResiduePaths: ['/private/unverified-stage'],
    });
  });

  it('keeps ambiguity details opaque and content-free', () => {
    const mapped = mapSessionIntegrityError(
      new SessionAmbiguityError('session-1', ['occurrence:b', 'occurrence:a'])
    );
    expect(mapped.code).toBe('SESSION_AMBIGUOUS');
    expect(mapped.details?.['occurrenceRefs']).toEqual(['occurrence:a', 'occurrence:b']);
    expect(JSON.stringify(mapped.details)).not.toContain('/private/source');
  });
});
