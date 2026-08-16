/**
 * better-sqlite3 Driver Adapter
 *
 * Wraps the better-sqlite3 library to conform to the DatabaseDriver interface.
 */

import type {
  Database,
  DatabaseCapability,
  DatabaseCapabilityProfile,
  DatabaseDriver,
  DatabaseOptions,
  Statement,
  RunResult,
} from '../types.js';
import { debugLog } from '../debug.js';

// Lazy-loaded better-sqlite3 module
let BetterSqlite3: typeof import('better-sqlite3') | null = null;
let betterSqlite3ProfilePromise: Promise<DatabaseCapabilityProfile> | null = null;

function unavailableProfile(reason: string): DatabaseCapabilityProfile {
  return {
    driver: 'better-sqlite3',
    available: false,
    capabilities: new Set<DatabaseCapability>(),
    unavailableReason: reason,
  };
}

function probeBetterSqlite3Capabilities(
  Constructor: typeof import('better-sqlite3')
): DatabaseCapabilityProfile {
  let testDb: import('better-sqlite3').Database;
  try {
    testDb = new Constructor(':memory:');
  } catch {
    return unavailableProfile('better-sqlite3 could not open an in-memory database.');
  }

  const capabilities = new Set<DatabaseCapability>();
  let readSupported = false;
  let writeSupported = false;

  try {
    const getStatement = testDb.prepare('SELECT 1 AS capability_probe');
    const allStatement = testDb.prepare('SELECT 1 AS capability_probe');
    getStatement.get();
    allStatement.all();
    readSupported = true;
  } catch {
    readSupported = false;
  }

  if (readSupported) {
    try {
      testDb.exec('CREATE TABLE cursor_history_capability_probe (value INTEGER)');
      testDb.prepare('INSERT INTO cursor_history_capability_probe (value) VALUES (1)').run();
      writeSupported = true;
    } catch {
      writeSupported = false;
    }
  }

  const backupSupported = typeof testDb.backup === 'function';
  try {
    testDb.close();
  } catch {
    return unavailableProfile('better-sqlite3 could not close a probed database safely.');
  }

  if (!readSupported) {
    return unavailableProfile('better-sqlite3 statement read APIs are unavailable.');
  }

  capabilities.add('read');
  if (writeSupported) capabilities.add('readWrite');
  if (backupSupported) capabilities.add('onlineBackup');
  return {
    driver: 'better-sqlite3',
    available: true,
    capabilities,
  };
}

async function loadBetterSqlite3Profile(): Promise<DatabaseCapabilityProfile> {
  if (!betterSqlite3ProfilePromise) {
    betterSqlite3ProfilePromise = (async () => {
      try {
        const module = await import('better-sqlite3');
        BetterSqlite3 = module.default;
        return probeBetterSqlite3Capabilities(BetterSqlite3);
      } catch {
        return unavailableProfile('better-sqlite3 could not be imported in this runtime.');
      }
    })();
  }
  return betterSqlite3ProfilePromise;
}

/**
 * Wrapper for better-sqlite3 Statement
 */
class BetterSqlite3Statement implements Statement {
  constructor(private stmt: import('better-sqlite3').Statement) {}

  get(...params: unknown[]): unknown {
    return this.stmt.get(...params);
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params) as unknown[];
  }

  run(...params: unknown[]): RunResult {
    const result = this.stmt.run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

/**
 * Wrapper for better-sqlite3 Database
 */
class BetterSqlite3Database implements Database {
  private nativeDb: import('better-sqlite3').Database;

  constructor(db: import('better-sqlite3').Database) {
    this.nativeDb = db;
  }

  prepare(sql: string): Statement {
    return new BetterSqlite3Statement(this.nativeDb.prepare(sql));
  }

  runSQL(sql: string): void {
    // Call the native database's method to run raw SQL
    (this.nativeDb as unknown as { exec: (sql: string) => void }).exec(sql);
  }

  close(): void {
    this.nativeDb.close();
  }
}

/**
 * better-sqlite3 driver implementation
 */
export const betterSqlite3Driver: DatabaseDriver = {
  name: 'better-sqlite3',

  async isAvailable(): Promise<boolean> {
    const profile = await loadBetterSqlite3Profile();
    if (profile.available) {
      debugLog('better-sqlite3 is available');
      return true;
    }
    debugLog(`better-sqlite3 is not available: ${profile.unavailableReason ?? 'probe failed'}`);
    return false;
  },

  getCapabilityProfile(): Promise<DatabaseCapabilityProfile> {
    return loadBetterSqlite3Profile();
  },

  open(path: string, options: DatabaseOptions): Database {
    if (!BetterSqlite3) {
      throw new Error('better-sqlite3 is not loaded. Call isAvailable() first.');
    }
    const db = new BetterSqlite3(path, { readonly: options.readonly });
    debugLog(`Opened database with better-sqlite3: ${path} (readonly: ${options.readonly})`);
    return new BetterSqlite3Database(db);
  },

  async backup(sourcePath: string, destPath: string): Promise<void> {
    if (!BetterSqlite3) {
      throw new Error('better-sqlite3 is not loaded. Call isAvailable() first.');
    }
    const sourceDb = new BetterSqlite3(sourcePath, { readonly: true });
    try {
      debugLog(`Backing up database with better-sqlite3: ${sourcePath} -> ${destPath}`);
      await sourceDb.backup(destPath);
      debugLog(`Backup completed: ${destPath}`);
    } finally {
      sourceDb.close();
    }
  },
};
