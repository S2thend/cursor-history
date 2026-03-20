import { describe, it, expect, vi, afterEach } from 'vitest';
import { debugLog, debugLogStorage } from '../../src/core/database/debug.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('debugLog', () => {
  it('writes to stderr when DEBUG is set', () => {
    vi.stubEnv('DEBUG', 'cursor-history:*');
    vi.stubEnv('CURSOR_HISTORY_DEBUG', '');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugLog('test message');
    expect(spy).toHaveBeenCalledWith('[cursor-history:sqlite] test message');
  });

  it('writes to stderr when CURSOR_HISTORY_DEBUG is set', () => {
    vi.stubEnv('DEBUG', '');
    vi.stubEnv('CURSOR_HISTORY_DEBUG', '1');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugLog('test message');
    expect(spy).toHaveBeenCalled();
  });

  it('does not write when neither env is set', () => {
    vi.stubEnv('DEBUG', '');
    vi.stubEnv('CURSOR_HISTORY_DEBUG', '');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugLog('test message');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('debugLogStorage', () => {
  it('writes to stderr with the storage namespace when DEBUG is set', () => {
    vi.stubEnv('DEBUG', 'cursor-history:*');
    vi.stubEnv('CURSOR_HISTORY_DEBUG', '');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugLogStorage('storage failure');
    expect(spy).toHaveBeenCalledWith('[cursor-history:storage] storage failure');
  });
});
