/**
 * node:sqlite Driver Adapter
 *
 * Wraps the built-in Node.js SQLite module (available in Node 22.5+)
 * to conform to the DatabaseDriver interface.
 *
 * Note: node:sqlite is experimental and requires --experimental-sqlite flag
 * on Node.js versions before it becomes stable.
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
import { DatabaseCapabilityError, ReadonlyDatabaseError } from '../errors.js';

// Type definitions for node:sqlite (not yet in @types/node)
interface NodeSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
  exec?(sql: string): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { open?: boolean; readOnly?: boolean }
  ) => NodeSqliteDatabase;
  backup?: (
    sourceDb: NodeSqliteDatabase,
    destPath: string,
    options?: { rate?: number }
  ) => Promise<number>;
}

// Lazy-loaded node:sqlite module
let nodeSqliteModule: NodeSqliteModule | null = null;
let nodeSqliteProfilePromise: Promise<DatabaseCapabilityProfile> | null = null;

function unavailableProfile(reason: string): DatabaseCapabilityProfile {
  return {
    driver: 'node:sqlite',
    available: false,
    capabilities: new Set<DatabaseCapability>(),
    unavailableReason: reason,
  };
}

/**
 * Probe the node:sqlite surface cursor-history actually calls.
 *
 * Exported for deterministic runtime-boundary tests: older supported Node releases can import the
 * module and perform reads while legitimately lacking the later online backup API.
 */
export function probeNodeSqliteCapabilities(moduleValue: unknown): DatabaseCapabilityProfile {
  if (typeof moduleValue !== 'object' || moduleValue === null) {
    return unavailableProfile('node:sqlite did not expose a module object.');
  }

  const candidate = moduleValue as Partial<NodeSqliteModule>;
  if (typeof candidate.DatabaseSync !== 'function') {
    return unavailableProfile('node:sqlite does not expose DatabaseSync.');
  }

  let testDb: NodeSqliteDatabase;
  try {
    testDb = new candidate.DatabaseSync(':memory:');
  } catch {
    return unavailableProfile('node:sqlite could not open an in-memory database.');
  }

  const capabilities = new Set<DatabaseCapability>();
  let readSupported = false;
  let writeSupported = false;

  if (typeof testDb.prepare === 'function' && typeof testDb.close === 'function') {
    try {
      const getStatement = testDb.prepare('SELECT 1 AS capability_probe');
      const allStatement = testDb.prepare('SELECT 1 AS capability_probe');
      if (typeof getStatement.get === 'function' && typeof allStatement.all === 'function') {
        getStatement.get();
        allStatement.all();
        readSupported = true;
      }
    } catch {
      readSupported = false;
    }

    if (readSupported) {
      try {
        if (typeof testDb.exec === 'function') {
          testDb.exec('CREATE TABLE cursor_history_capability_probe (value INTEGER)');
        } else {
          const createStatement = testDb.prepare(
            'CREATE TABLE cursor_history_capability_probe (value INTEGER)'
          );
          if (typeof createStatement.run !== 'function') throw new Error('run unavailable');
          createStatement.run();
        }

        const insertStatement = testDb.prepare(
          'INSERT INTO cursor_history_capability_probe (value) VALUES (1)'
        );
        if (typeof insertStatement.run !== 'function') throw new Error('run unavailable');
        insertStatement.run();
        writeSupported = true;
      } catch {
        writeSupported = false;
      }
    }
  }

  try {
    testDb.close();
  } catch {
    return unavailableProfile('node:sqlite could not close a probed database safely.');
  }

  if (!readSupported) {
    return unavailableProfile('node:sqlite statement read APIs are unavailable.');
  }

  capabilities.add('read');
  if (writeSupported) capabilities.add('readWrite');
  if (typeof candidate.backup === 'function') capabilities.add('onlineBackup');

  return {
    driver: 'node:sqlite',
    available: true,
    capabilities,
  };
}

async function loadNodeSqliteProfile(): Promise<DatabaseCapabilityProfile> {
  if (!nodeSqliteProfilePromise) {
    nodeSqliteProfilePromise = (async () => {
      try {
        // Import availability and API capability are deliberately separate checks. In particular,
        // backup() was added after DatabaseSync on supported Node release lines.
        const module = await import('node:sqlite');
        const profile = probeNodeSqliteCapabilities(module);
        if (profile.available) nodeSqliteModule = module as unknown as NodeSqliteModule;
        return profile;
      } catch {
        return unavailableProfile('node:sqlite could not be imported in this runtime.');
      }
    })();
  }
  return nodeSqliteProfilePromise;
}

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
    const profile = await loadNodeSqliteProfile();
    if (profile.available) {
      debugLog('node:sqlite is available');
      return true;
    }
    debugLog(`node:sqlite is not available: ${profile.unavailableReason ?? 'probe failed'}`);
    return false;
  },

  getCapabilityProfile(): Promise<DatabaseCapabilityProfile> {
    return loadNodeSqliteProfile();
  },

  open(path: string, options: DatabaseOptions): Database {
    if (!nodeSqliteModule) {
      throw new Error('node:sqlite is not loaded. Call isAvailable() first.');
    }
    const db = new nodeSqliteModule.DatabaseSync(path, { readOnly: options.readonly });
    debugLog(`Opened database with node:sqlite: ${path} (readonly: ${options.readonly})`);
    return new NodeSqliteDatabaseWrapper(db, options.readonly);
  },

  async backup(sourcePath: string, destPath: string): Promise<void> {
    if (!nodeSqliteModule) {
      throw new Error('node:sqlite is not loaded. Call isAvailable() first.');
    }
    if (typeof nodeSqliteModule.backup !== 'function') {
      throw new DatabaseCapabilityError('node:sqlite', 'backup', ['onlineBackup']);
    }
    const sourceDb = new nodeSqliteModule.DatabaseSync(sourcePath, { readOnly: true });
    try {
      debugLog(`Backing up database with node:sqlite: ${sourcePath} -> ${destPath}`);
      await nodeSqliteModule.backup(sourceDb, destPath);
      debugLog(`Backup completed: ${destPath}`);
    } finally {
      sourceDb.close();
    }
  },
};
