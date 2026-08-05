import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseCapabilityError, NoCapableDriverError } from '../../src/core/database/errors.js';
import { probeNodeSqliteCapabilities } from '../../src/core/database/drivers/node-sqlite.js';
import { registry } from '../../src/core/database/registry.js';
import type {
  Database,
  DatabaseCapability,
  DatabaseDriver,
  DatabaseOperationRequest,
} from '../../src/core/database/types.js';

const READ = new Set<DatabaseCapability>(['read']);
const READ_WRITE = new Set<DatabaseCapability>(['read', 'readWrite']);
const SNAPSHOT = new Set<DatabaseCapability>(['read', 'onlineBackup']);

function request(
  operation: DatabaseOperationRequest['operation'],
  required: ReadonlySet<DatabaseCapability>,
  forcedDriver?: DatabaseOperationRequest['forcedDriver']
): DatabaseOperationRequest {
  return { operation, required, forcedDriver };
}

function mockDriver(
  name: DatabaseOperationRequest['forcedDriver'],
  capabilities: ReadonlySet<DatabaseCapability>,
  available = true
): DatabaseDriver {
  const database: Database = {
    prepare: vi.fn(() => ({
      get: vi.fn(),
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    })),
    runSQL: vi.fn(),
    close: vi.fn(),
  };
  return {
    name,
    // Import availability deliberately stays true for the simulated old-node profile below.
    isAvailable: vi.fn().mockResolvedValue(available),
    getCapabilityProfile: vi.fn().mockResolvedValue({
      driver: name,
      available,
      capabilities,
    }),
    open: vi.fn(() => database),
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

describe('node:sqlite capability probing', () => {
  it('advertises reads and writes but not online backup when backup() is absent', () => {
    class ImportableNodeDatabase {
      prepare() {
        return {
          get: () => ({ capability_probe: 1 }),
          all: () => [{ capability_probe: 1 }],
          run: () => ({ changes: 1, lastInsertRowid: 1 }),
        };
      }

      exec() {}

      close() {}
    }

    const profile = probeNodeSqliteCapabilities({ DatabaseSync: ImportableNodeDatabase });

    expect(profile.available).toBe(true);
    expect(profile.capabilities).toEqual(new Set(['read', 'readWrite']));
    expect(profile.capabilities.has('onlineBackup')).toBe(false);
  });

  it('advertises online backup only when backup is a function', () => {
    class CapableNodeDatabase {
      prepare() {
        return {
          get: () => ({ capability_probe: 1 }),
          all: () => [{ capability_probe: 1 }],
          run: () => ({ changes: 1, lastInsertRowid: 1 }),
        };
      }

      exec() {}

      close() {}
    }

    const profile = probeNodeSqliteCapabilities({
      DatabaseSync: CapableNodeDatabase,
      backup: async () => 1,
    });

    expect(profile.capabilities.has('onlineBackup')).toBe(true);
  });
});

describe('operation-aware database driver selection', () => {
  it('uses node:sqlite for reads and a capable fallback for a later snapshot', async () => {
    const node = mockDriver('node:sqlite', READ_WRITE);
    const better = mockDriver('better-sqlite3', new Set([...READ_WRITE, 'onlineBackup']));
    registry.register(node);
    registry.register(better);

    expect((await registry.selectDatabaseDriver(request('read-session', READ))).name).toBe(
      'node:sqlite'
    );
    await registry.backupDatabase(
      '/source.db',
      '/snapshot.db',
      request('store-snapshot', SNAPSHOT)
    );

    expect(better.backup).toHaveBeenCalledWith('/source.db', '/snapshot.db');
    expect(node.backup).not.toHaveBeenCalled();
    expect(registry.getActiveDriver()).toBe('better-sqlite3');
  });

  it('does not fall back when an operation explicitly forces an incapable provider', async () => {
    const node = mockDriver('node:sqlite', READ_WRITE);
    const better = mockDriver('better-sqlite3', new Set([...READ_WRITE, 'onlineBackup']));
    registry.register(node);
    registry.register(better);

    const selection = registry.selectDatabaseDriver(
      request('store-snapshot', SNAPSHOT, 'node:sqlite')
    );
    const error = await selection.catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DatabaseCapabilityError);
    expect(error).toMatchObject({
      code: 'DATABASE_CAPABILITY_MISSING',
      details: {
        driver: 'node:sqlite',
        operation: 'store-snapshot',
        missingCapabilities: ['onlineBackup'],
        alternatives: ['better-sqlite3'],
      },
    });
    expect((error as DatabaseCapabilityError).details.remedy).toContain('automatic selection');
    expect(node.backup).not.toHaveBeenCalled();
    expect(better.backup).not.toHaveBeenCalled();
  });

  it('records setDriver synchronously and treats it as strict on the next operation', async () => {
    const node = mockDriver('node:sqlite', READ_WRITE);
    const better = mockDriver('better-sqlite3', new Set([...READ_WRITE, 'onlineBackup']));
    registry.register(node);
    registry.register(better);

    expect(registry.setDriver('node:sqlite')).toBeUndefined();
    expect(node.getCapabilityProfile).not.toHaveBeenCalled();

    await expect(registry.selectDatabaseDriver(request('backup', SNAPSHOT))).rejects.toMatchObject({
      code: 'DATABASE_CAPABILITY_MISSING',
    });
    expect(better.backup).not.toHaveBeenCalled();
  });

  it('applies operation config before setDriver and environment preferences', async () => {
    vi.stubEnv('CURSOR_HISTORY_SQLITE_DRIVER', 'node:sqlite');
    const node = mockDriver('node:sqlite', READ_WRITE);
    const better = mockDriver('better-sqlite3', new Set([...READ_WRITE, 'onlineBackup']));
    registry.register(node);
    registry.register(better);
    registry.setDriver('node:sqlite');

    const selected = await registry.selectDatabaseDriver(
      request('read-session', READ, 'better-sqlite3')
    );

    expect(selected.name).toBe('better-sqlite3');
  });

  it('applies the latest setDriver preference before the environment', async () => {
    vi.stubEnv('CURSOR_HISTORY_SQLITE_DRIVER', 'better-sqlite3');
    const node = mockDriver('node:sqlite', READ_WRITE);
    const better = mockDriver('better-sqlite3', new Set([...READ_WRITE, 'onlineBackup']));
    registry.register(node);
    registry.register(better);
    registry.setDriver('node:sqlite');

    const selected = await registry.selectDatabaseDriver(request('read-session', READ));

    expect(selected.name).toBe('node:sqlite');
  });

  it('treats the environment preference as strict rather than silently falling back', async () => {
    vi.stubEnv('CURSOR_HISTORY_SQLITE_DRIVER', 'node:sqlite');
    const node = mockDriver('node:sqlite', READ_WRITE);
    const better = mockDriver('better-sqlite3', new Set([...READ_WRITE, 'onlineBackup']));
    registry.register(node);
    registry.register(better);

    await expect(registry.selectDatabaseDriver(request('backup', SNAPSHOT))).rejects.toMatchObject({
      code: 'DATABASE_CAPABILITY_MISSING',
      details: { driver: 'node:sqlite', missingCapabilities: ['onlineBackup'] },
    });
  });

  it('returns an actionable typed error when automatic selection has no capable provider', async () => {
    registry.register(mockDriver('node:sqlite', READ_WRITE));
    registry.register(mockDriver('better-sqlite3', READ_WRITE));

    const selection = registry.selectDatabaseDriver(request('backup', SNAPSHOT));
    const error = await selection.catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(NoCapableDriverError);
    expect(error).toMatchObject({
      code: 'NO_CAPABLE_DATABASE_DRIVER',
      details: {
        operation: 'backup',
        requiredCapabilities: ['read', 'onlineBackup'],
      },
    });
    expect((error as NoCapableDriverError).details.remedies.length).toBeGreaterThan(0);
  });

  it('caches one runtime capability profile per registered provider across operations', async () => {
    const node = mockDriver('node:sqlite', READ_WRITE);
    const better = mockDriver('better-sqlite3', new Set([...READ_WRITE, 'onlineBackup']));
    registry.register(node);
    registry.register(better);

    await registry.selectDatabaseDriver(request('read-session', READ));
    await registry.selectDatabaseDriver(request('store-snapshot', SNAPSHOT));
    await registry.selectDatabaseDriver(request('read-session', READ));

    expect(node.getCapabilityProfile).toHaveBeenCalledTimes(1);
    expect(better.getCapabilityProfile).toHaveBeenCalledTimes(1);
  });
});
