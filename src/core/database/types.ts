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
   * Open a database connection using this driver
   *
   * @param path - Path to the SQLite database file
   * @param options - Connection options (readonly, etc.)
   * @returns Open database connection
   * @throws Error if database cannot be opened
   */
  open(path: string, options: DatabaseOptions): Database;
}

/**
 * Driver names that can be used for manual selection
 */
export type DriverName = 'better-sqlite3' | 'node:sqlite';
