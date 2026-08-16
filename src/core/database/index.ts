/**
 * Pluggable SQLite Driver - Public API
 *
 * This module provides a unified interface for SQLite database access,
 * supporting multiple driver implementations (better-sqlite3, node:sqlite).
 *
 * Usage:
 *   import { openDatabase, getActiveDriver } from './database/index.js';
 *   const db = await openDatabase('/path/to/db.sqlite');
 */

// Re-export types
export type {
  Database,
  DatabaseCapability,
  DatabaseCapabilityProfile,
  DatabaseDriver,
  DatabaseOperation,
  DatabaseOperationRequest,
  DatabaseOptions,
  DriverName,
  RunResult,
  Statement,
} from './types.js';

// Re-export errors
export {
  DatabaseCapabilityError,
  DriverNotAvailableError,
  NoCapableDriverError,
  NoDriverAvailableError,
  ReadonlyDatabaseError,
} from './errors.js';

// Import drivers and registry
import { registry } from './registry.js';
import { betterSqlite3Driver } from './drivers/better-sqlite3.js';
import { nodeSqliteDriver } from './drivers/node-sqlite.js';
import type { DatabaseOperationRequest, DriverName } from './types.js';

// Register all available drivers
registry.register(nodeSqliteDriver);
registry.register(betterSqlite3Driver);

/**
 * Open a database in read-only mode
 *
 * This is the primary function for opening databases. It will:
 * 1. Auto-select the best available driver (if not already selected)
 * 2. Open the database file in read-only mode
 *
 * @param path - Path to the SQLite database file
 * @returns Promise resolving to an open Database connection
 * @throws NoDriverAvailableError if no driver is available
 */
export async function openDatabase(path: string, request?: DatabaseOperationRequest) {
  return registry.openDatabase(path, request);
}

/**
 * Open a database in read-write mode
 *
 * Use this function when you need to modify the database.
 *
 * @param path - Path to the SQLite database file
 * @returns Promise resolving to an open Database connection
 * @throws NoDriverAvailableError if no driver is available
 */
export async function openDatabaseReadWrite(path: string, request?: DatabaseOperationRequest) {
  return registry.openDatabaseReadWrite(path, request);
}

/**
 * Get the name of the currently active driver
 *
 * @returns The driver name (e.g., "better-sqlite3", "node:sqlite")
 * @throws Error if no driver has been selected yet
 */
export function getActiveDriver(): string {
  return registry.getActiveDriver();
}

/**
 * Check if a driver has been selected
 *
 * @returns true if a driver is active, false otherwise
 */
export function hasActiveDriver(): boolean {
  return registry.hasActiveDriver();
}

/**
 * Manually set the active driver by name
 *
 * Use this to override auto-detection and force a specific driver.
 *
 * @param name - Driver name ("better-sqlite3" or "node:sqlite")
 * @throws DriverNotAvailableError if the driver is not available
 */
export function setDriver(name: DriverName): void {
  registry.setDriver(name);
}

/** Select a capable provider for one explicitly described database operation. */
export async function selectDatabaseDriver(request: DatabaseOperationRequest) {
  return registry.selectDatabaseDriver(request);
}

/**
 * Get list of all registered driver names
 *
 * @returns Array of driver names
 */
export function getRegisteredDrivers(): string[] {
  return registry.getRegisteredDrivers();
}

/**
 * Get list of currently available driver names
 *
 * This checks each registered driver to see if it can be loaded
 * in the current environment.
 *
 * @returns Promise resolving to array of available driver names
 */
export async function getAvailableDrivers(): Promise<string[]> {
  return registry.getAvailableDrivers();
}

/**
 * Reset the driver registry (mainly for testing)
 *
 * This clears the current driver selection, allowing re-initialization.
 */
export function resetRegistry(): void {
  registry.reset();
}

/**
 * Ensure a driver is selected (auto-select if needed)
 *
 * This is useful when you need to guarantee driver initialization
 * before performing synchronous operations (like openBackupDatabase).
 *
 * @returns Promise that resolves when driver is ready
 */
export async function ensureDriver(request?: DatabaseOperationRequest): Promise<void> {
  await registry.ensureDriver(request);
}

/**
 * Backup a database file to another location
 *
 * Uses the native SQLite backup API for consistent snapshots even
 * while the source database is being written to.
 *
 * @param sourcePath - Path to the source database file
 * @param destPath - Path where backup will be created
 * @returns Promise that resolves when backup is complete
 */
export async function backupDatabase(
  sourcePath: string,
  destPath: string,
  request?: DatabaseOperationRequest
): Promise<void> {
  return registry.backupDatabase(sourcePath, destPath, request);
}
