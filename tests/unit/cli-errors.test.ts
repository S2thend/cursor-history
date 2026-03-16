import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ExitCode,
  CliError,
  CursorNotFoundError,
  NoHistoryError,
  SessionNotFoundError,
  FileExistsError,
  NoSearchResultsError,
  handleError,
} from '../../src/cli/errors.js';

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
});
