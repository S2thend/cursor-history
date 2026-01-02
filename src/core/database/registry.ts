/**
 * Driver Registry - Singleton for managing SQLite driver selection
 *
 * Handles auto-detection, manual selection, and runtime switching of drivers.
 */

import type { Database, DatabaseDriver, DriverName } from './types.js';
import { NoDriverAvailableError, DriverNotAvailableError } from './errors.js';
import { debugLog } from './debug.js';

/**
 * Singleton registry for managing SQLite drivers
 */
class DriverRegistry {
  private drivers: Map<string, DatabaseDriver> = new Map();
  private currentDriver: DatabaseDriver | null = null;
  private initialized = false;

  /**
   * Register a driver with the registry
   */
  register(driver: DatabaseDriver): void {
    this.drivers.set(driver.name, driver);
    debugLog(`Registered driver: ${driver.name}`);
  }

  /**
   * Get all registered driver names
   */
  getRegisteredDrivers(): string[] {
    return Array.from(this.drivers.keys());
  }

  /**
   * Check which drivers are currently available
   */
  async getAvailableDrivers(): Promise<string[]> {
    const available: string[] = [];
    for (const [name, driver] of this.drivers) {
      if (await driver.isAvailable()) {
        available.push(name);
      }
    }
    return available;
  }

  /**
   * Auto-detect and select the best available driver
   *
   * Priority:
   * 1. User-specified via CURSOR_HISTORY_SQLITE_DRIVER env var
   * 2. node:sqlite (no native bindings, ESM compatible)
   * 3. better-sqlite3 (fallback)
   */
  async autoSelect(): Promise<DatabaseDriver> {
    // Check for user override via environment variable
    const envDriver = process.env['CURSOR_HISTORY_SQLITE_DRIVER'];
    if (envDriver) {
      debugLog(`Environment override: CURSOR_HISTORY_SQLITE_DRIVER=${envDriver}`);
      const driver = this.drivers.get(envDriver);
      if (driver && (await driver.isAvailable())) {
        this.currentDriver = driver;
        this.initialized = true;
        debugLog(`Using driver from env var: ${driver.name}`);
        return driver;
      }
      // Driver specified but not available
      const available = await this.getAvailableDrivers();
      throw new DriverNotAvailableError(envDriver, available);
    }

    // Auto-detect: try node:sqlite first (no native bindings)
    const nodeSqlite = this.drivers.get('node:sqlite');
    if (nodeSqlite && (await nodeSqlite.isAvailable())) {
      this.currentDriver = nodeSqlite;
      this.initialized = true;
      debugLog(`Auto-selected driver: node:sqlite`);
      return nodeSqlite;
    }

    // Fallback to better-sqlite3
    const betterSqlite = this.drivers.get('better-sqlite3');
    if (betterSqlite && (await betterSqlite.isAvailable())) {
      this.currentDriver = betterSqlite;
      this.initialized = true;
      debugLog(`Auto-selected driver: better-sqlite3`);
      return betterSqlite;
    }

    // No driver available
    throw new NoDriverAvailableError();
  }

  /**
   * Manually set the active driver by name
   */
  async setDriver(name: DriverName): Promise<void> {
    const driver = this.drivers.get(name);
    if (!driver) {
      const available = await this.getAvailableDrivers();
      throw new DriverNotAvailableError(name, available);
    }

    if (!(await driver.isAvailable())) {
      const available = await this.getAvailableDrivers();
      throw new DriverNotAvailableError(name, available);
    }

    this.currentDriver = driver;
    this.initialized = true;
    debugLog(`Manually set driver: ${name}`);
  }

  /**
   * Get the name of the currently active driver
   */
  getActiveDriver(): string {
    if (!this.currentDriver) {
      throw new Error('No driver is currently active. Call autoSelect() or setDriver() first.');
    }
    return this.currentDriver.name;
  }

  /**
   * Check if a driver has been selected
   */
  hasActiveDriver(): boolean {
    return this.currentDriver !== null;
  }

  /**
   * Get the current driver, auto-selecting if needed
   */
  async ensureDriver(): Promise<DatabaseDriver> {
    if (!this.initialized || !this.currentDriver) {
      return this.autoSelect();
    }
    return this.currentDriver;
  }

  /**
   * Open a database in read-only mode
   */
  async openDatabase(path: string): Promise<Database> {
    const driver = await this.ensureDriver();
    return driver.open(path, { readonly: true });
  }

  /**
   * Open a database in read-write mode
   */
  async openDatabaseReadWrite(path: string): Promise<Database> {
    const driver = await this.ensureDriver();
    return driver.open(path, { readonly: false });
  }

  /**
   * Synchronous database open (requires driver to already be selected)
   *
   * This is used by backup module which needs synchronous access.
   * Auto-selection must have happened before calling this.
   */
  openSync(path: string, options: { readonly: boolean }): Database {
    if (!this.currentDriver) {
      throw new Error(
        'No driver is currently active. Auto-selection must complete before using openSync(). ' +
        'Call a database operation first to trigger auto-selection.'
      );
    }
    return this.currentDriver.open(path, options);
  }

  /**
   * Reset the registry (mainly for testing)
   */
  reset(): void {
    this.currentDriver = null;
    this.initialized = false;
    debugLog('Registry reset');
  }
}

// Singleton instance
export const registry = new DriverRegistry();
