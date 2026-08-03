import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  detectPlatform,
  getDefaultCursorDataPath,
  getCursorDataPath,
  expandPath,
  contractPath,
  normalizePath,
  pathsEqual,
  getStoreStackRoot,
  findStoreRoot,
  resolveStoreRoot,
} from '../../src/lib/platform.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getStoreStackRoot', () => {
  it('defaults to ~/.cursor', () => {
    vi.unstubAllEnvs();
    expect(getStoreStackRoot()).toBe(join(homedir(), '.cursor'));
  });

  it('honors CURSOR_STORE_ROOT override', () => {
    vi.stubEnv('CURSOR_STORE_ROOT', '/tmp/custom-cursor');
    expect(getStoreStackRoot()).toBe('/tmp/custom-cursor');
  });

  it('honors --data-path only when it looks like a Store root', () => {
    vi.unstubAllEnvs();
    // A non-Store path (e.g. Composer workspaceStorage) must NOT shadow ~/.cursor
    expect(getStoreStackRoot('/some/workspaceStorage')).toBe(join(homedir(), '.cursor'));
    // A .cursor-named path IS a Store root
    expect(getStoreStackRoot('/home/u/.cursor')).toBe('/home/u/.cursor');
  });
});

describe('resolveStoreRoot', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ch-store-root-'));
    mkdirSync(join(root, 'chats'), { recursive: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'acp-sessions'), { recursive: true });
  });
  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the Store root, chats/projects descendants, and CURSOR_DATA_PATH to the same root', () => {
    const hash = 'deadbeef';
    mkdirSync(join(root, 'chats', hash), { recursive: true });
    mkdirSync(join(root, 'projects', 'sanitized', 'agent-transcripts'), { recursive: true });
    // The root itself
    expect(resolveStoreRoot(root)).toBe(root);
    // A chats descendant
    expect(resolveStoreRoot(join(root, 'chats', hash))).toBe(root);
    // A projects descendant
    expect(resolveStoreRoot(join(root, 'projects', 'sanitized'))).toBe(root);
    // CURSOR_DATA_PATH pointing at the Store root
    vi.stubEnv('CURSOR_DATA_PATH', root);
    expect(resolveStoreRoot()).toBe(root);
  });

  it('falls back to default ~/.cursor when the path is a Composer workspaceStorage path', () => {
    const composer = mkdtempSync(join(tmpdir(), 'ch-composer-'));
    try {
      expect(resolveStoreRoot(composer)).toBe(join(homedir(), '.cursor'));
    } finally {
      rmSync(composer, { recursive: true, force: true });
    }
  });

  it('does not mistake an ordinary ancestor with a projects directory for a Store root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ch-ordinary-home-'));
    const project = join(parent, 'projects', 'my-repo');
    const composer = join(parent, 'AppData', 'Cursor', 'User', 'workspaceStorage');
    try {
      mkdirSync(project, { recursive: true });
      mkdirSync(join(parent, 'chats'), { recursive: true });
      mkdirSync(composer, { recursive: true });
      expect(findStoreRoot(project)).toBeNull();
      expect(findStoreRoot(composer)).toBeNull();
      expect(resolveStoreRoot(composer)).toBe(join(homedir(), '.cursor'));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('accepts an explicitly supplied empty direct Store child', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'ch-empty-store-'));
    const chats = join(emptyRoot, 'chats');
    try {
      mkdirSync(chats);
      expect(findStoreRoot(chats)).toBe(emptyRoot);
      expect(resolveStoreRoot(chats)).toBe(emptyRoot);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
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
    const expected = join(homedir(), '.config', 'Cursor', 'User', 'workspaceStorage');
    expect(path).toBe(expected);
  });

  it('returns macos path', () => {
    const path = getDefaultCursorDataPath('macos');
    const expected = join(
      homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'workspaceStorage'
    );
    expect(path).toBe(expected);
  });

  it('returns windows path', () => {
    const path = getDefaultCursorDataPath('windows');
    const expected = join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage');
    expect(path).toBe(expected);
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
    expect(expandPath('~/foo')).toBe(join(homedir(), 'foo'));
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
    expect(normalizePath('~/foo')).toBe(join(homedir(), 'foo'));
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

  it('treats Windows, file-URI, and WSL drive paths as equal', () => {
    expect(pathsEqual('D:\\repo\\project', '/D:/repo/project')).toBe(true);
    expect(pathsEqual('D:\\repo\\project', '/mnt/d/repo/project')).toBe(true);
    expect(pathsEqual('D:\\', '/mnt/d')).toBe(true);
  });
});
