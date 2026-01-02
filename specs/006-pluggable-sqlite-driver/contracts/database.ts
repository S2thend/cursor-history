/**
 * Pluggable SQLite Driver - TypeScript Interface Contracts
 *
 * Feature: 006-pluggable-sqlite-driver
 * Date: 2026-01-02
 *
 * These interfaces define the contract for the driver abstraction layer.
 * Implementations must conform to these types.
 */

// =============================================================================
// Core Database Interfaces
// =============================================================================

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
   * @param sql - SQL to run
   */
  execSQL(sql: string): void;

  /**
   * Close the database connection
   * After calling this, the database object should not be used
   */
  close(): void;
}

// =============================================================================
// Driver Abstraction Interfaces
// =============================================================================

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

// =============================================================================
// Registry and Configuration
// =============================================================================

/**
 * Driver names that can be used for manual selection
 */
export type DriverName = 'better-sqlite3' | 'node:sqlite';

/**
 * Extension to LibraryConfig for driver selection
 */
export interface DriverConfig {
  /**
   * Manually specify which SQLite driver to use
   * If not set, auto-detection will be used
   */
  sqliteDriver?: DriverName;
}

/**
 * Public API for driver management
 */
export interface DriverRegistryAPI {
  /**
   * Get the name of the currently active driver
   * @returns Driver name (e.g., "better-sqlite3", "node:sqlite")
   * @throws Error if no driver is active
   */
  getActiveDriver(): string;

  /**
   * Manually set the active driver
   * @param name - Driver name to activate
   * @throws Error if driver is not available
   */
  setDriver(name: DriverName): void;

  /**
   * Open a database in read-only mode
   * @param path - Path to database file
   * @returns Open database connection
   */
  openDatabase(path: string): Database;

  /**
   * Open a database in read-write mode
   * @param path - Path to database file
   * @returns Open database connection
   */
  openDatabaseReadWrite(path: string): Database;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when no SQLite driver is available
 */
export class NoDriverAvailableError extends Error {
  constructor() {
    super(
      'No SQLite driver available. ' +
      'Either install better-sqlite3 (npm install better-sqlite3) ' +
      'or use Node.js 22.5+ with --experimental-sqlite flag.'
    );
    this.name = 'NoDriverAvailableError';
  }
}

/**
 * Error thrown when a specified driver is not available
 */
export class DriverNotAvailableError extends Error {
  constructor(driverName: string, availableDrivers: string[]) {
    const available = availableDrivers.length > 0
      ? `Available drivers: ${availableDrivers.join(', ')}`
      : 'No drivers are currently available.';
    super(`Driver "${driverName}" is not available. ${available}`);
    this.name = 'DriverNotAvailableError';
  }
}

/**
 * Error thrown when attempting write on a readonly connection
 */
export class ReadonlyDatabaseError extends Error {
  constructor() {
    super('Cannot write to a read-only database connection.');
    this.name = 'ReadonlyDatabaseError';
  }
}
