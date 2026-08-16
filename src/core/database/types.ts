/**
 * Pluggable SQLite Driver - Type Definitions
 *
 * These interfaces define the contract for the driver abstraction layer.
 * Both better-sqlite3 and node:sqlite adapters must conform to these types.
 */

/**
 * Result of running a statement that modifies data (INSERT/UPDATE/DELETE)
 */
export interface RunResult {
  /** Number of rows affected by the operation */
  changes: number;
  /** Row ID of the last inserted row (for INSERT operations) */
  lastInsertRowid: number | bigint;
}

/**
 * Prepared SQL statement that can be run multiple times with different parameters
 */
export interface Statement {
  /**
   * Run the statement and return the first row
   * @param params - Bind parameters for the query
   * @returns The first row as an object, or undefined if no rows
   */
  get(...params: unknown[]): unknown;

  /**
   * Run the statement and return all rows
   * @param params - Bind parameters for the query
   * @returns Array of row objects (empty array if no rows)
   */
  all(...params: unknown[]): unknown[];

  /**
   * Run the statement for side effects (INSERT/UPDATE/DELETE)
   * @param params - Bind parameters for the query
   * @returns Result containing changes count and last insert ID
   */
  run(...params: unknown[]): RunResult;
}

/**
 * Open database connection
 */
export interface Database {
  /**
   * Create a prepared statement from SQL
   * @param sql - SQL query string
   * @returns Prepared statement object
   */
  prepare(sql: string): Statement;

  /**
   * Run raw SQL directly without returning results
   * Useful for DDL statements or multiple statements
   * Note: Named 'runSQL' to avoid confusion with child_process methods
   * @param sql - SQL to run
   */
  runSQL(sql: string): void;

  /**
   * Close the database connection
   * After calling this, the database object should not be used
   */
  close(): void;
}

/**
 * Options for opening a database connection
 */
export interface DatabaseOptions {
  /** If true, open in read-only mode (writes will fail) */
  readonly: boolean;
}

/** SQLite operations whose requirements can differ between providers. */
export type DatabaseOperation = 'read-session' | 'migrate' | 'backup' | 'store-snapshot';

/** Independently probed capabilities used by cursor-history database operations. */
export type DatabaseCapability = 'read' | 'readWrite' | 'onlineBackup';

/**
 * Runtime capability result for one database provider.
 *
 * Profiles are intentionally independent from the currently selected provider: a provider may be
 * suitable for ordinary reads while another provider is required for an online snapshot.
 */
export interface DatabaseCapabilityProfile {
  readonly driver: string;
  readonly available: boolean;
  readonly capabilities: ReadonlySet<DatabaseCapability>;
  readonly unavailableReason?: string;
}

/** Requirements and optional explicit preference for one database operation. */
export interface DatabaseOperationRequest {
  readonly operation: DatabaseOperation;
  readonly required: ReadonlySet<DatabaseCapability>;
  readonly forcedDriver?: DriverName;
  /** Internal operation-bound observer; never contains a raw locator. */
  readonly io?: import('../io-observer.js').OperationIoContext;
  /** Reviewed safe classification for this database and its default statements. */
  readonly ioResource?: Pick<
    import('../io-observer.js').AdapterIoEventInput,
    'logicalSessionId' | 'sourceRole' | 'representation' | 'resourceClass'
  >;
}

/**
 * Pluggable database driver implementation
 *
 * Each driver adapter (better-sqlite3, node:sqlite, etc.) must implement
 * this interface to be usable with the driver registry.
 */
export interface DatabaseDriver {
  /** Unique identifier for this driver (e.g., "better-sqlite3", "node:sqlite") */
  readonly name: string;

  /**
   * Check if this driver is available in the current environment
   *
   * This method should:
   * - Attempt to load/import the underlying driver
   * - Return true if successful, false otherwise
   * - Not throw exceptions
   *
   * @returns Promise resolving to availability status
   */
  isAvailable(): Promise<boolean>;

  /**
   * Probe the constructor and APIs used by cursor-history in the current runtime.
   *
   * Implementations cache this profile for the lifetime of the loaded provider/runtime. Importing
   * a provider alone is not sufficient evidence that every operation it exposes is available.
   */
  getCapabilityProfile(): Promise<DatabaseCapabilityProfile>;

  /**
   * Open a database connection using this driver
   *
   * @param path - Path to the SQLite database file
   * @param options - Connection options (readonly, etc.)
   * @returns Open database connection
   * @throws Error if database cannot be opened
   */
  open(path: string, options: DatabaseOptions): Database;

  /**
   * Backup a database to another file
   *
   * Uses the native SQLite backup API for consistent snapshots even
   * while the source database is being written to.
   *
   * @param sourcePath - Path to the source database file
   * @param destPath - Path where backup will be created
   * @returns Promise that resolves when backup is complete
   * @throws Error if backup fails
   */
  backup(sourcePath: string, destPath: string): Promise<void>;
}

/**
 * Driver names that can be used for manual selection
 */
export type DriverName = 'better-sqlite3' | 'node:sqlite';
