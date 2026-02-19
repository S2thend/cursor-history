import { describe, it, expect, vi, afterEach } from 'vitest';
import { homedir } from 'node:os';
import {
  detectPlatform,
  getDefaultCursorDataPath,
  getCursorDataPath,
  expandPath,
  contractPath,
  normalizePath,
  pathsEqual,
} from '../../src/lib/platform.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('detectPlatform', () => {
  it('returns correct platform for current environment', () => {
    const platform = detectPlatform();
    // Platform should match the actual OS
    const expected =
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
    expect(platform).toBe(expected);
  });
});

describe('getDefaultCursorDataPath', () => {
  it('returns linux path', () => {
    const path = getDefaultCursorDataPath('linux');
    expect(path).toContain('.config/Cursor/User/workspaceStorage');
  });

  it('returns macos path', () => {
    const path = getDefaultCursorDataPath('macos');
    expect(path).toContain('Library/Application Support/Cursor');
  });

  it('returns windows path', () => {
    const path = getDefaultCursorDataPath('windows');
    expect(path).toContain('Cursor');
    expect(path).toContain('workspaceStorage');
  });
});

describe('getCursorDataPath', () => {
  it('returns custom path when provided', () => {
    expect(getCursorDataPath('/custom/path')).toBe('/custom/path');
  });

  it('returns env var when set', () => {
    vi.stubEnv('CURSOR_DATA_PATH', '/env/path');
    expect(getCursorDataPath()).toBe('/env/path');
  });

  it('returns default when no custom or env', () => {
    vi.stubEnv('CURSOR_DATA_PATH', '');
    const result = getCursorDataPath();
    expect(result).toContain('workspaceStorage');
  });

  it('custom path takes priority over env var', () => {
    vi.stubEnv('CURSOR_DATA_PATH', '/env/path');
    expect(getCursorDataPath('/custom')).toBe('/custom');
  });
});

describe('expandPath', () => {
  it('expands ~/foo to homedir/foo', () => {
    expect(expandPath('~/foo')).toBe(homedir() + '/foo');
  });

  it('returns absolute path unchanged', () => {
    expect(expandPath('/absolute/path')).toBe('/absolute/path');
  });

  it('expands ~ alone to homedir', () => {
    expect(expandPath('~')).toBe(homedir());
  });
});

describe('contractPath', () => {
  it('replaces homedir prefix with ~', () => {
    const path = homedir() + '/projects/test';
    expect(contractPath(path)).toBe('~/projects/test');
  });

  it('returns non-home path unchanged', () => {
    expect(contractPath('/other/path')).toBe('/other/path');
  });
});

describe('normalizePath', () => {
  it('expands tilde', () => {
    expect(normalizePath('~/foo')).toBe(homedir() + '/foo');
  });

  it('removes trailing slash', () => {
    expect(normalizePath('/path/to/dir/')).toBe('/path/to/dir');
  });

  it('removes trailing backslash', () => {
    expect(normalizePath('/path/to/dir\\')).toBe('/path/to/dir');
  });

  it('preserves root /', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('removes multiple trailing slashes', () => {
    expect(normalizePath('/path///')).toBe('/path');
  });
});

describe('pathsEqual', () => {
  it('returns true for identical paths', () => {
    expect(pathsEqual('/a/b', '/a/b')).toBe(true);
  });

  it('returns false for different paths', () => {
    expect(pathsEqual('/a/b', '/a/c')).toBe(false);
  });

  it('treats tilde and expanded as equal', () => {
    expect(pathsEqual('~/foo', homedir() + '/foo')).toBe(true);
  });

  it('normalizes trailing slashes', () => {
    expect(pathsEqual('/a/b/', '/a/b')).toBe(true);
  });
});
