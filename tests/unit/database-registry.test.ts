import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the DriverRegistry class by importing the singleton and using reset()
import { registry } from '../../src/core/database/registry.js';
import { NoDriverAvailableError, DriverNotAvailableError } from '../../src/core/database/errors.js';
import type { DatabaseDriver, Database } from '../../src/core/database/types.js';

function mockDriver(name: string, available = true): DatabaseDriver {
  const mockDb: Database = {
    prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn() })),
    close: vi.fn(),
    runSQL: vi.fn(),
  };
  return {
    name,
    isAvailable: vi.fn().mockResolvedValue(available),
    open: vi.fn().mockReturnValue(mockDb),
    backup: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  registry.reset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('register and getRegisteredDrivers', () => {
  it('registers drivers', () => {
    const driver = mockDriver('test-driver');
    registry.register(driver);
    expect(registry.getRegisteredDrivers()).toContain('test-driver');
  });
});

describe('getAvailableDrivers', () => {
  it('returns only available drivers', async () => {
    registry.register(mockDriver('available', true));
    registry.register(mockDriver('unavailable', false));
    const available = await registry.getAvailableDrivers();
    expect(available).toContain('available');
    expect(available).not.toContain('unavailable');
  });
});

describe('autoSelect', () => {
  it('prefers node:sqlite', async () => {
    registry.register(mockDriver('node:sqlite', true));
    registry.register(mockDriver('better-sqlite3', true));
    const driver = await registry.autoSelect();
    expect(driver.name).toBe('node:sqlite');
  });

  it('falls back to better-sqlite3', async () => {
    registry.register(mockDriver('node:sqlite', false));
    registry.register(mockDriver('better-sqlite3', true));
    const driver = await registry.autoSelect();
    expect(driver.name).toBe('better-sqlite3');
  });

  it('throws NoDriverAvailableError when no drivers available', async () => {
    registry.register(mockDriver('node:sqlite', false));
    registry.register(mockDriver('better-sqlite3', false));
    await expect(registry.autoSelect()).rejects.toThrow(NoDriverAvailableError);
  });

  it('uses env var override', async () => {
    vi.stubEnv('CURSOR_HISTORY_SQLITE_DRIVER', 'better-sqlite3');
    registry.register(mockDriver('node:sqlite', true));
    registry.register(mockDriver('better-sqlite3', true));
    const driver = await registry.autoSelect();
    expect(driver.name).toBe('better-sqlite3');
  });

  it('throws if env var specifies unavailable driver', async () => {
    vi.stubEnv('CURSOR_HISTORY_SQLITE_DRIVER', 'node:sqlite');
    registry.register(mockDriver('node:sqlite', false));
    registry.register(mockDriver('better-sqlite3', true));
    await expect(registry.autoSelect()).rejects.toThrow(DriverNotAvailableError);
  });
});

describe('setDriver', () => {
  it('sets available driver', async () => {
    registry.register(mockDriver('test', true));
    await registry.setDriver('test' as 'better-sqlite3');
    expect(registry.getActiveDriver()).toBe('test');
  });

  it('throws for unavailable driver', async () => {
    registry.register(mockDriver('test', false));
    await expect(registry.setDriver('test' as 'better-sqlite3')).rejects.toThrow(
      DriverNotAvailableError
    );
  });

  it('throws for unregistered driver', async () => {
    await expect(registry.setDriver('unknown' as 'better-sqlite3')).rejects.toThrow(
      DriverNotAvailableError
    );
  });
});

describe('getActiveDriver', () => {
  it('returns name after selection', async () => {
    registry.register(mockDriver('node:sqlite', true));
    await registry.autoSelect();
    expect(registry.getActiveDriver()).toBe('node:sqlite');
  });

  it('throws when no driver selected', () => {
    expect(() => registry.getActiveDriver()).toThrow();
  });
});

describe('hasActiveDriver', () => {
  it('returns false initially', () => {
    expect(registry.hasActiveDriver()).toBe(false);
  });

  it('returns true after selection', async () => {
    registry.register(mockDriver('node:sqlite', true));
    await registry.autoSelect();
    expect(registry.hasActiveDriver()).toBe(true);
  });
});

describe('ensureDriver', () => {
  it('auto-selects on first call', async () => {
    registry.register(mockDriver('node:sqlite', true));
    const driver = await registry.ensureDriver();
    expect(driver.name).toBe('node:sqlite');
  });

  it('returns cached driver on subsequent calls', async () => {
    registry.register(mockDriver('node:sqlite', true));
    const driver1 = await registry.ensureDriver();
    const driver2 = await registry.ensureDriver();
    expect(driver1).toBe(driver2);
  });
});

describe('openDatabase', () => {
  it('opens readonly database', async () => {
    const driver = mockDriver('node:sqlite', true);
    registry.register(driver);
    await registry.openDatabase('/test.db');
    expect(driver.open).toHaveBeenCalledWith('/test.db', { readonly: true });
  });
});

describe('openDatabaseReadWrite', () => {
  it('opens read-write database', async () => {
    const driver = mockDriver('node:sqlite', true);
    registry.register(driver);
    await registry.openDatabaseReadWrite('/test.db');
    expect(driver.open).toHaveBeenCalledWith('/test.db', { readonly: false });
  });
});

describe('openSync', () => {
  it('throws when no driver selected', () => {
    expect(() => registry.openSync('/test.db', { readonly: true })).toThrow();
  });

  it('works after driver selection', async () => {
    const driver = mockDriver('node:sqlite', true);
    registry.register(driver);
    await registry.autoSelect();
    registry.openSync('/test.db', { readonly: true });
    expect(driver.open).toHaveBeenCalledWith('/test.db', { readonly: true });
  });
});

describe('backupDatabase', () => {
  it('delegates to driver backup', async () => {
    const driver = mockDriver('node:sqlite', true);
    registry.register(driver);
    await registry.backupDatabase('/src.db', '/dest.db');
    expect(driver.backup).toHaveBeenCalledWith('/src.db', '/dest.db');
  });
});

describe('reset', () => {
  it('clears active driver and registered drivers', async () => {
    registry.register(mockDriver('node:sqlite', true));
    await registry.autoSelect();
    expect(registry.hasActiveDriver()).toBe(true);
    registry.reset();
    expect(registry.hasActiveDriver()).toBe(false);
    expect(registry.getRegisteredDrivers()).toEqual([]);
  });
});
