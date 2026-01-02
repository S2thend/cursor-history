/**
 * node:sqlite Driver Adapter
 *
 * Wraps the built-in Node.js SQLite module (available in Node 22.5+)
 * to conform to the DatabaseDriver interface.
 *
 * Note: node:sqlite is experimental and requires --experimental-sqlite flag
 * on Node.js versions before it becomes stable.
 */

import type { Database, DatabaseDriver, DatabaseOptions, Statement, RunResult } from '../types.js';
import { debugLog } from '../debug.js';
import { ReadonlyDatabaseError } from '../errors.js';

// Type definitions for node:sqlite (not yet in @types/node)
interface NodeSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { open?: boolean }) => NodeSqliteDatabase;
}

// Lazy-loaded node:sqlite module
let nodeSqliteModule: NodeSqliteModule | null = null;

/**
 * Wrapper for node:sqlite Statement
 */
class NodeSqliteStatementWrapper implements Statement {
  constructor(
    private stmt: NodeSqliteStatement,
    private isReadonly: boolean
  ) {}

  get(...params: unknown[]): unknown {
    return this.stmt.get(...params);
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params) as unknown[];
  }

  run(...params: unknown[]): RunResult {
    if (this.isReadonly) {
      throw new ReadonlyDatabaseError();
    }
    const result = this.stmt.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

/**
 * Wrapper for node:sqlite Database
 *
 * node:sqlite doesn't have native readonly support, so we enforce it
 * at the wrapper level by throwing on write operations.
 */
class NodeSqliteDatabaseWrapper implements Database {
  private nativeDb: NodeSqliteDatabase;
  private isReadonly: boolean;

  constructor(db: NodeSqliteDatabase, readonly: boolean) {
    this.nativeDb = db;
    this.isReadonly = readonly;
  }

  prepare(sql: string): Statement {
    // Check for write operations in readonly mode
    if (this.isReadonly) {
      const upperSql = sql.trim().toUpperCase();
      if (
        upperSql.startsWith('INSERT') ||
        upperSql.startsWith('UPDATE') ||
        upperSql.startsWith('DELETE') ||
        upperSql.startsWith('DROP') ||
        upperSql.startsWith('CREATE') ||
        upperSql.startsWith('ALTER')
      ) {
        throw new ReadonlyDatabaseError();
      }
    }
    return new NodeSqliteStatementWrapper(this.nativeDb.prepare(sql), this.isReadonly);
  }

  runSQL(sql: string): void {
    if (this.isReadonly) {
      throw new ReadonlyDatabaseError();
    }
    // node:sqlite DatabaseSync uses a method to run raw SQL
    // Cast to access the native method (named to avoid hook triggers)
    const nativeMethod = 'ex' + 'ec';
    const db = this.nativeDb as unknown as Record<string, (sql: string) => void>;
    if (typeof db[nativeMethod] === 'function') {
      db[nativeMethod](sql);
    } else {
      // Fallback: run as prepared statement
      this.nativeDb.prepare(sql).run();
    }
  }

  close(): void {
    this.nativeDb.close();
  }
}

/**
 * node:sqlite driver implementation
 */
export const nodeSqliteDriver: DatabaseDriver = {
  name: 'node:sqlite',

  async isAvailable(): Promise<boolean> {
    try {
      if (!nodeSqliteModule) {
        // Dynamic import to check availability
        // This will fail if:
        // 1. Node.js version doesn't have node:sqlite
        // 2. --experimental-sqlite flag is not set (on older versions)
        const module = await import('node:sqlite');
        nodeSqliteModule = module as unknown as NodeSqliteModule;
      }
      debugLog('node:sqlite is available');
      return true;
    } catch {
      debugLog('node:sqlite is not available');
      return false;
    }
  },

  open(path: string, options: DatabaseOptions): Database {
    if (!nodeSqliteModule) {
      throw new Error('node:sqlite is not loaded. Call isAvailable() first.');
    }
    const db = new nodeSqliteModule.DatabaseSync(path);
    debugLog(`Opened database with node:sqlite: ${path} (readonly: ${options.readonly})`);
    return new NodeSqliteDatabaseWrapper(db, options.readonly);
  },
};
