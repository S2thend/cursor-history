/**
 * Pluggable SQLite Driver - Error Classes
 *
 * Custom error types for driver-related failures with actionable messages.
 */

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
