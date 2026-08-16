/**
 * Configuration handling and validation for library API
 *
 * IMPORTANT: This is a library interface for direct import and use in TypeScript/JavaScript
 * projects, NOT a network/REST API.
 */

import { realpathSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
import type { LibraryConfig, SqliteDriverName } from './types.js';
import { InvalidConfigError, DatabaseNotFoundError } from './errors.js';
import { getCursorDataPath } from '../lib/platform.js';

/** Valid SQLite driver names */
const VALID_SQLITE_DRIVERS: SqliteDriverName[] = ['better-sqlite3', 'node:sqlite'];

/**
 * Merged configuration with behavioral defaults applied.
 *
 * `dataPath` intentionally remains undefined when the caller did not provide
 * one. Core storage resolves the platform default itself, while preserving the
 * distinction between an implicit default and an explicit Composer/Store path
 * for cross-stack conflict priority.
 */
export interface ResolvedConfig {
  dataPath?: string;
  workspace?: string;
  includeCrossWorkspaceSources: boolean;
  limit: number;
  offset: number;
  context: number;
  backupPath?: string;
  sqliteDriver?: SqliteDriverName;
  onDiagnostic?: LibraryConfig['onDiagnostic'];
  sourceReadLimits?: LibraryConfig['sourceReadLimits'];
  readContext?: LibraryConfig['readContext'];
  signal?: AbortSignal;
}

/**
 * Validate configuration parameters
 * @throws {InvalidConfigError} If any parameter is invalid
 */
export function validateConfig(config?: LibraryConfig): void {
  if (!config) return;

  // Validate limit
  if (config.limit !== undefined) {
    if (typeof config.limit !== 'number' || config.limit < 1 || !Number.isInteger(config.limit)) {
      throw new InvalidConfigError(
        'limit',
        config.limit,
        'must be a positive integer greater than 0'
      );
    }
  }

  // Validate offset
  if (config.offset !== undefined) {
    if (
      typeof config.offset !== 'number' ||
      config.offset < 0 ||
      !Number.isInteger(config.offset)
    ) {
      throw new InvalidConfigError('offset', config.offset, 'must be a non-negative integer');
    }
  }

  // Validate context
  if (config.context !== undefined) {
    if (
      typeof config.context !== 'number' ||
      config.context < 0 ||
      !Number.isInteger(config.context)
    ) {
      throw new InvalidConfigError('context', config.context, 'must be a non-negative integer');
    }
  }

  // Validate workspace path
  if (config.workspace !== undefined) {
    if (
      typeof config.workspace !== 'string' ||
      config.workspace.length === 0 ||
      /[\r\n\0]/.test(config.workspace)
    ) {
      throw new InvalidConfigError(
        'workspace',
        config.workspace,
        'must be a non-empty single-line historical path or component suffix'
      );
    }
  }

  // Validate dataPath
  if (config.dataPath !== undefined && typeof config.dataPath !== 'string') {
    throw new InvalidConfigError('dataPath', config.dataPath, 'must be a string');
  }

  // Validate sqliteDriver
  if (config.sqliteDriver !== undefined) {
    if (!VALID_SQLITE_DRIVERS.includes(config.sqliteDriver)) {
      throw new InvalidConfigError(
        'sqliteDriver',
        config.sqliteDriver,
        `must be one of: ${VALID_SQLITE_DRIVERS.join(', ')}`
      );
    }
  }

  if (
    config.includeCrossWorkspaceSources !== undefined &&
    typeof config.includeCrossWorkspaceSources !== 'boolean'
  ) {
    throw new InvalidConfigError(
      'includeCrossWorkspaceSources',
      config.includeCrossWorkspaceSources,
      'must be a boolean'
    );
  }

  if (config.onDiagnostic !== undefined && typeof config.onDiagnostic !== 'function') {
    throw new InvalidConfigError('onDiagnostic', config.onDiagnostic, 'must be a function');
  }

  if (
    config.readContext !== undefined &&
    (typeof config.readContext !== 'object' || config.readContext === null)
  ) {
    throw new InvalidConfigError(
      'readContext',
      config.readContext,
      'must be a context created by createSessionReadContext()'
    );
  }
}

/**
 * Merge user configuration with defaults
 */
export function mergeWithDefaults(config?: LibraryConfig): ResolvedConfig {
  validateConfig(config);

  return {
    dataPath: config?.dataPath,
    workspace: config?.workspace,
    includeCrossWorkspaceSources: config?.includeCrossWorkspaceSources ?? false,
    limit: config?.limit ?? Number.MAX_SAFE_INTEGER,
    offset: config?.offset ?? 0,
    context: config?.context ?? 0,
    backupPath: config?.backupPath,
    sqliteDriver: config?.sqliteDriver,
    onDiagnostic: config?.onDiagnostic,
    sourceReadLimits: config?.sourceReadLimits,
    readContext: config?.readContext,
    signal: config?.signal,
  };
}

/**
 * Resolve database path with symlink handling
 * @throws {DatabaseNotFoundError} If path does not exist
 */
export function resolveDatabasePath(configPath?: string): string {
  const basePath = configPath ?? getCursorDataPath();
  const normalized = normalize(basePath);
  const resolved = resolve(normalized);

  try {
    // Resolve symlinks and verify path exists
    return realpathSync(resolved);
  } catch {
    throw new DatabaseNotFoundError(resolved);
  }
}
