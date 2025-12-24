/**
 * Utility functions for library API
 */

import { getCursorDataPath } from '../lib/platform.js';

/**
 * Get the platform-specific default Cursor data path.
 *
 * @returns Absolute path to Cursor data directory
 *
 * @example
 * const defaultPath = getDefaultDataPath();
 * console.log(defaultPath);
 * // macOS: ~/Library/Application Support/Cursor/User/workspaceStorage
 * // Linux: ~/.config/Cursor/User/workspaceStorage
 * // Windows: %APPDATA%\Cursor\User\workspaceStorage
 */
export function getDefaultDataPath(): string {
  return getCursorDataPath();
}
