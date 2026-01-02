/**
 * better-sqlite3 Driver Adapter
 *
 * Wraps the better-sqlite3 library to conform to the DatabaseDriver interface.
 */

import type { Database, DatabaseDriver, DatabaseOptions, Statement, RunResult } from '../types.js';
import { debugLog } from '../debug.js';

// Lazy-loaded better-sqlite3 module
let BetterSqlite3: typeof import('better-sqlite3') | null = null;

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
    try {
      if (!BetterSqlite3) {
        // Dynamic import to avoid errors if not installed
        const module = await import('better-sqlite3');
        BetterSqlite3 = module.default;
      }
      debugLog('better-sqlite3 is available');
      return true;
    } catch {
      debugLog('better-sqlite3 is not available');
      return false;
    }
  },

  open(path: string, options: DatabaseOptions): Database {
    if (!BetterSqlite3) {
      throw new Error('better-sqlite3 is not loaded. Call isAvailable() first.');
    }
    const db = new BetterSqlite3(path, { readonly: options.readonly });
    debugLog(`Opened database with better-sqlite3: ${path} (readonly: ${options.readonly})`);
    return new BetterSqlite3Database(db);
  },
};
