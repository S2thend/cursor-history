/**
 * Driver Registry - Singleton for managing capability-aware SQLite driver selection.
 *
 * Selection happens per operation. A provider that is preferred for ordinary reads is not reused
 * for snapshots unless its cached runtime profile satisfies the snapshot capability set.
 */

import type {
  Database,
  DatabaseCapability,
  DatabaseCapabilityProfile,
  DatabaseDriver,
  DatabaseOperationRequest,
  DriverName,
} from './types.js';
import {
  DatabaseCapabilityError,
  DriverNotAvailableError,
  NoCapableDriverError,
  NoDriverAvailableError,
} from './errors.js';
import { debugLog } from './debug.js';
import { observeDatabaseBackup, openObservedDatabase } from './observed.js';

const AUTO_DRIVER_ORDER = ['node:sqlite', 'better-sqlite3'] as const;

const READ_SESSION_REQUEST: DatabaseOperationRequest = {
  operation: 'read-session',
  required: new Set<DatabaseCapability>(['read']),
};

const MIGRATION_REQUEST: DatabaseOperationRequest = {
  operation: 'migrate',
  required: new Set<DatabaseCapability>(['readWrite']),
};

const BACKUP_REQUEST: DatabaseOperationRequest = {
  operation: 'backup',
  required: new Set<DatabaseCapability>(['read', 'onlineBackup']),
};

function missingCapabilities(
  profile: DatabaseCapabilityProfile,
  required: ReadonlySet<DatabaseCapability>
): DatabaseCapability[] {
  return [...required].filter((capability) => !profile.capabilities.has(capability));
}

/** Singleton registry for managing SQLite drivers. */
class DriverRegistry {
  private drivers: Map<string, DatabaseDriver> = new Map();
  private capabilityProfiles: Map<string, Promise<DatabaseCapabilityProfile>> = new Map();
  private currentDriver: DatabaseDriver | null = null;
  private preferredDriver: DriverName | null = null;

  /** Register a driver with the registry. */
  register(driver: DatabaseDriver): void {
    this.drivers.set(driver.name, driver);
    this.capabilityProfiles.delete(driver.name);
    if (this.currentDriver?.name === driver.name) this.currentDriver = null;
    debugLog(`Registered driver: ${driver.name}`);
  }

  /** Get all registered driver names. */
  getRegisteredDrivers(): string[] {
    return Array.from(this.drivers.keys());
  }

  private async getCapabilityProfile(driver: DatabaseDriver): Promise<DatabaseCapabilityProfile> {
    let pending = this.capabilityProfiles.get(driver.name);
    if (!pending) {
      pending = driver.getCapabilityProfile().catch(() => ({
        driver: driver.name,
        available: false,
        capabilities: new Set<DatabaseCapability>(),
        unavailableReason: 'The database capability probe failed.',
      }));
      this.capabilityProfiles.set(driver.name, pending);
    }
    return pending;
  }

  /** Return cached runtime profiles for every registered provider. */
  async getCapabilityProfiles(): Promise<DatabaseCapabilityProfile[]> {
    const profiles: DatabaseCapabilityProfile[] = [];
    for (const driver of this.drivers.values()) {
      profiles.push(await this.getCapabilityProfile(driver));
    }
    return profiles;
  }

  /** Check which drivers can perform at least ordinary database reads. */
  async getAvailableDrivers(): Promise<string[]> {
    const available: string[] = [];
    for (const [name, driver] of this.drivers) {
      const profile = await this.getCapabilityProfile(driver);
      if (profile.available) available.push(name);
    }
    return available;
  }

  private orderedDrivers(): DatabaseDriver[] {
    const ordered: DatabaseDriver[] = [];
    const seen = new Set<string>();
    for (const name of AUTO_DRIVER_ORDER) {
      const driver = this.drivers.get(name);
      if (driver) {
        ordered.push(driver);
        seen.add(name);
      }
    }
    for (const driver of this.drivers.values()) {
      if (!seen.has(driver.name)) ordered.push(driver);
    }
    return ordered;
  }

  private activate(driver: DatabaseDriver): DatabaseDriver {
    this.currentDriver = driver;
    return driver;
  }

  private async getCapableAlternatives(
    request: DatabaseOperationRequest,
    excludedDriver: string
  ): Promise<string[]> {
    const alternatives: string[] = [];
    for (const driver of this.orderedDrivers()) {
      if (driver.name === excludedDriver) continue;
      const profile = await this.getCapabilityProfile(driver);
      if (profile.available && missingCapabilities(profile, request.required).length === 0) {
        alternatives.push(driver.name);
      }
    }
    return alternatives;
  }

  private async selectForcedDriver(
    driverName: string,
    request: DatabaseOperationRequest
  ): Promise<DatabaseDriver> {
    const driver = this.drivers.get(driverName);
    if (!driver) {
      throw new DriverNotAvailableError(driverName, await this.getAvailableDrivers());
    }

    const profile = await this.getCapabilityProfile(driver);
    if (!profile.available) {
      throw new DriverNotAvailableError(driverName, await this.getAvailableDrivers());
    }

    const missing = missingCapabilities(profile, request.required);
    if (missing.length > 0) {
      throw new DatabaseCapabilityError(
        driverName,
        request.operation,
        missing,
        await this.getCapableAlternatives(request, driverName)
      );
    }

    debugLog(`Selected forced driver for ${request.operation}: ${driverName}`);
    return this.activate(driver);
  }

  /**
   * Select a provider for one complete operation capability set.
   *
   * Explicit preferences are strict and follow this precedence: operation/library configuration,
   * latest setDriver(), environment, then automatic provider preference. Only automatic mode may
   * fall back to another capable provider.
   */
  async selectDatabaseDriver(request: DatabaseOperationRequest): Promise<DatabaseDriver> {
    const explicitDriver =
      request.forcedDriver ?? this.preferredDriver ?? process.env['CURSOR_HISTORY_SQLITE_DRIVER'];

    if (explicitDriver) {
      return this.selectForcedDriver(explicitDriver, request);
    }

    for (const driver of this.orderedDrivers()) {
      const profile = await this.getCapabilityProfile(driver);
      if (profile.available && missingCapabilities(profile, request.required).length === 0) {
        debugLog(`Auto-selected driver for ${request.operation}: ${driver.name}`);
        return this.activate(driver);
      }
    }

    throw new NoCapableDriverError(request.operation, request.required);
  }

  /**
   * Backward-compatible ordinary-read auto-selection.
   *
   * The legacy method retains NoDriverAvailableError when automatic read selection has no provider;
   * operation-aware callers receive the more specific NoCapableDriverError.
   */
  async autoSelect(): Promise<DatabaseDriver> {
    try {
      return await this.selectDatabaseDriver(READ_SESSION_REQUEST);
    } catch (error) {
      if (error instanceof NoCapableDriverError) throw new NoDriverAvailableError();
      throw error;
    }
  }

  /**
   * Record a strict process preference synchronously.
   *
   * Availability and operation-specific capabilities are validated by the next awaited database
   * operation, preserving the public setDriver(): void contract without a discarded-promise race.
   */
  setDriver(name: DriverName): void {
    this.preferredDriver = name;
    this.currentDriver = null;
    debugLog(`Recorded driver preference: ${name}`);
  }

  /** Get the name of the provider used by the latest completed selection. */
  getActiveDriver(): string {
    if (!this.currentDriver) {
      throw new Error('No driver is currently active. Complete a database operation first.');
    }
    return this.currentDriver.name;
  }

  /** Check whether an operation has completed provider selection. */
  hasActiveDriver(): boolean {
    return this.currentDriver !== null;
  }

  /** Select a provider for the supplied request, or for an ordinary read by default. */
  async ensureDriver(
    request: DatabaseOperationRequest = READ_SESSION_REQUEST
  ): Promise<DatabaseDriver> {
    return this.selectDatabaseDriver(request);
  }

  /** Open a database in read-only mode. */
  async openDatabase(
    path: string,
    request: DatabaseOperationRequest = READ_SESSION_REQUEST
  ): Promise<Database> {
    const driver = await this.ensureDriver(request);
    return openObservedDatabase(request.io, request, () => driver.open(path, { readonly: true }));
  }

  /** Open a database in read-write mode. */
  async openDatabaseReadWrite(
    path: string,
    request: DatabaseOperationRequest = MIGRATION_REQUEST
  ): Promise<Database> {
    const driver = await this.ensureDriver(request);
    return openObservedDatabase(request.io, request, () => driver.open(path, { readonly: false }));
  }

  /**
   * Synchronous database open (requires a completed capability-aware selection).
   *
   * This remains for backup parsing paths that perform synchronous reads after an awaited
   * selection or snapshot operation.
   */
  openSync(path: string, options: { readonly: boolean }): Database {
    if (!this.currentDriver) {
      throw new Error(
        'No driver is currently active. Capability-aware selection must complete before using openSync().'
      );
    }
    return this.currentDriver.open(path, options);
  }

  /** Create an online database snapshot with a provider satisfying the complete request. */
  async backupDatabase(
    sourcePath: string,
    destPath: string,
    request: DatabaseOperationRequest = BACKUP_REQUEST
  ): Promise<void> {
    const driver = await this.ensureDriver(request);
    observeDatabaseBackup(request);
    return driver.backup(sourcePath, destPath);
  }

  /** Reset the registry (mainly for testing). */
  reset(): void {
    this.drivers.clear();
    this.capabilityProfiles.clear();
    this.currentDriver = null;
    this.preferredDriver = null;
    debugLog('Registry reset');
  }
}

// Singleton instance
export const registry = new DriverRegistry();
