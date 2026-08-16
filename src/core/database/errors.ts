/**
 * Pluggable SQLite Driver - Error Classes
 *
 * Custom error types for driver-related failures with actionable messages.
 */

import type { DatabaseCapability, DatabaseOperation } from './types.js';
export { DatabaseCapabilityError, NoCapableDriverError } from '../errors.js';

/**
 * Error thrown when no SQLite driver is available in the current environment
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
 * Error thrown when a specified driver is not available.
 *
 * @param driverName - Explicit SQLite driver requested by the caller.
 * @param availableDrivers - Installed driver names available for selection.
 */
export class DriverNotAvailableError extends Error {
  constructor(driverName: string, availableDrivers: string[]) {
    const available =
      availableDrivers.length > 0
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

/** Safe, machine-readable details for an explicitly forced incapable provider. */
export interface DatabaseCapabilityErrorDetails {
  readonly driver: string;
  readonly operation: DatabaseOperation;
  readonly missingCapabilities: DatabaseCapability[];
  readonly alternatives: string[];
  readonly remedy: string;
}

/**
 * Error thrown when an explicit operation, process, or environment preference cannot perform the
 * requested operation. Explicit preferences never fall back silently.
 */
/** Safe, machine-readable details when automatic selection has no capable provider. */
export interface NoCapableDriverErrorDetails {
  readonly operation: DatabaseOperation;
  readonly requiredCapabilities: DatabaseCapability[];
  readonly remedies: string[];
}

/** Error thrown when automatic selection cannot satisfy the complete operation capability set. */
