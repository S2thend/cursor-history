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
  DatabaseDriver,
  DatabaseOptions,
  DriverName,
  RunResult,
  Statement,
} from './types.js';

// Re-export errors
export {
  DriverNotAvailableError,
  NoDriverAvailableError,
  ReadonlyDatabaseError,
} from './errors.js';

// Import drivers and registry
import { registry } from './registry.js';
import { betterSqlite3Driver } from './drivers/better-sqlite3.js';
import { nodeSqliteDriver } from './drivers/node-sqlite.js';

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
export async function openDatabase(path: string) {
  return registry.openDatabase(path);
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
export async function openDatabaseReadWrite(path: string) {
  return registry.openDatabaseReadWrite(path);
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
export async function setDriver(name: 'better-sqlite3' | 'node:sqlite') {
  return registry.setDriver(name);
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
export async function ensureDriver(): Promise<void> {
  await registry.ensureDriver();
}
