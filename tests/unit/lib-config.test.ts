import { describe, it, expect } from 'vitest';
import { validateConfig, mergeWithDefaults, resolveDatabasePath } from '../../src/lib/config.js';
import { InvalidConfigError, DatabaseNotFoundError } from '../../src/lib/errors.js';

describe('validateConfig', () => {
  it('accepts undefined config', () => {
    expect(() => validateConfig()).not.toThrow();
  });

  it('accepts valid complete config', () => {
    expect(() =>
      validateConfig({
        limit: 10,
        offset: 0,
        context: 5,
        workspace: '/absolute/path',
        dataPath: '/some/path',
        sqliteDriver: 'better-sqlite3',
      })
    ).not.toThrow();
  });

  it('rejects limit: 0', () => {
    expect(() => validateConfig({ limit: 0 })).toThrow(InvalidConfigError);
  });

  it('rejects limit: -1', () => {
    expect(() => validateConfig({ limit: -1 })).toThrow(InvalidConfigError);
  });

  it('rejects limit: 1.5 (non-integer)', () => {
    expect(() => validateConfig({ limit: 1.5 })).toThrow(InvalidConfigError);
  });

  it('rejects limit: string', () => {
    expect(() => validateConfig({ limit: 'abc' as unknown as number })).toThrow(InvalidConfigError);
  });

  it('rejects offset: -1', () => {
    expect(() => validateConfig({ offset: -1 })).toThrow(InvalidConfigError);
  });

  it('rejects offset: 0.5', () => {
    expect(() => validateConfig({ offset: 0.5 })).toThrow(InvalidConfigError);
  });

  it('rejects context: -1', () => {
    expect(() => validateConfig({ context: -1 })).toThrow(InvalidConfigError);
  });

  it('rejects workspace: relative path', () => {
    expect(() => validateConfig({ workspace: 'relative/path' })).toThrow(InvalidConfigError);
  });

  it('rejects workspace: non-string', () => {
    expect(() => validateConfig({ workspace: 123 as unknown as string })).toThrow(
      InvalidConfigError
    );
  });

  it('rejects dataPath: non-string', () => {
    expect(() => validateConfig({ dataPath: 123 as unknown as string })).toThrow(
      InvalidConfigError
    );
  });

  it('rejects invalid sqliteDriver', () => {
    expect(() =>
      validateConfig({ sqliteDriver: 'invalid' as unknown as 'better-sqlite3' })
    ).toThrow(InvalidConfigError);
  });
});

describe('mergeWithDefaults', () => {
  it('returns defaults when no config provided', () => {
    const result = mergeWithDefaults();
    expect(result.limit).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.offset).toBe(0);
    expect(result.context).toBe(0);
    expect(typeof result.dataPath).toBe('string');
  });

  it('merges partial config with defaults', () => {
    const result = mergeWithDefaults({ limit: 10 });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it('preserves optional fields', () => {
    const result = mergeWithDefaults({
      workspace: '/abs/path',
      backupPath: '/backup',
      sqliteDriver: 'node:sqlite',
    });
    expect(result.workspace).toBe('/abs/path');
    expect(result.backupPath).toBe('/backup');
    expect(result.sqliteDriver).toBe('node:sqlite');
  });

  it('throws on invalid config', () => {
    expect(() => mergeWithDefaults({ limit: -1 })).toThrow(InvalidConfigError);
  });
});

describe('resolveDatabasePath', () => {
  it('throws DatabaseNotFoundError for non-existent path', () => {
    expect(() => resolveDatabasePath('/nonexistent/path/xyz')).toThrow(DatabaseNotFoundError);
  });

  it('resolves valid path', () => {
    const result = resolveDatabasePath('/tmp');
    expect(typeof result).toBe('string');
    expect(result).toContain('tmp');
  });
});
