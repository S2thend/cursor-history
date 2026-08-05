/**
 * Pluggable SQLite Driver - Error Classes
 *
 * Custom error types for driver-related failures with actionable messages.
 */

import type { DatabaseCapability, DatabaseOperation } from './types.js';
import { SessionIntegrityError } from '../errors.js';

const CAPABILITY_ORDER: readonly DatabaseCapability[] = ['read', 'readWrite', 'onlineBackup'];

function orderCapabilities(capabilities: Iterable<DatabaseCapability>): DatabaseCapability[] {
  const values = new Set(capabilities);
  return CAPABILITY_ORDER.filter((capability) => values.has(capability));
}

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
 * Error thrown when a specified driver is not available
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
export class DatabaseCapabilityError extends SessionIntegrityError<
  'DATABASE_CAPABILITY_MISSING',
  {
    driver: string;
    operation: DatabaseOperation;
    missingCapabilities: string[];
    alternatives: string[];
    remedy: string;
  }
> {
  override readonly name = 'DatabaseCapabilityError';
  constructor(
    driver: string,
    operation: DatabaseOperation,
    missingCapabilities: Iterable<DatabaseCapability>,
    alternatives: Iterable<string> = []
  ) {
    const missing = orderCapabilities(missingCapabilities);
    const capableAlternatives = [...new Set(alternatives)].filter((name) => name !== driver).sort();
    const remedy =
      capableAlternatives.length > 0
        ? `Use automatic selection or select a capable driver: ${capableAlternatives.join(', ')}.`
        : 'Install a capable SQLite provider or use a Node.js runtime exposing the required APIs.';

    super(
      'DATABASE_CAPABILITY_MISSING',
      `Database driver "${driver}" cannot perform ${operation}; missing capabilities: ${missing.join(', ')}. ${remedy}`,
      { driver, operation, missingCapabilities: missing, alternatives: capableAlternatives, remedy }
    );
  }
}

/** Safe, machine-readable details when automatic selection has no capable provider. */
export interface NoCapableDriverErrorDetails {
  readonly operation: DatabaseOperation;
  readonly requiredCapabilities: DatabaseCapability[];
  readonly remedies: string[];
}

/** Error thrown when automatic selection cannot satisfy the complete operation capability set. */
export class NoCapableDriverError extends SessionIntegrityError<
  'NO_CAPABLE_DATABASE_DRIVER',
  {
    operation: DatabaseOperation;
    requiredCapabilities: string[];
    remedies: string[];
  }
> {
  override readonly name = 'NoCapableDriverError';
  constructor(operation: DatabaseOperation, required: Iterable<DatabaseCapability>) {
    const requiredCapabilities = orderCapabilities(required);
    const remedies = [
      'Install a capable better-sqlite3 provider.',
      'Use a Node.js runtime whose node:sqlite module exposes every required API.',
      'Review CURSOR_HISTORY_SQLITE_DRIVER or the operation-specific sqliteDriver setting.',
    ];

    super(
      'NO_CAPABLE_DATABASE_DRIVER',
      `No available SQLite driver can perform ${operation}; required capabilities: ${requiredCapabilities.join(', ')}.`,
      { operation, requiredCapabilities, remedies }
    );
  }
}
