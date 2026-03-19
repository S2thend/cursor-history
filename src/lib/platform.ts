/**
 * Platform detection and Cursor data path resolution
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '../core/types.js';

/**
 * Detect the current operating system platform
 */
export function detectPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

/**
 * Get the default Cursor data path for the current platform
 */
export function getDefaultCursorDataPath(platform?: Platform): string {
  const p = platform ?? detectPlatform();

  switch (p) {
    case 'windows':
      return join(
        process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'workspaceStorage'
      );
    case 'macos':
      return join(
        homedir(),
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'workspaceStorage'
      );
    case 'linux':
      return join(homedir(), '.config', 'Cursor', 'User', 'workspaceStorage');
  }
}

/**
 * Get the Cursor data path, checking environment variable and custom path first
 */
export function getCursorDataPath(customPath?: string): string {
  // Priority: custom path > env var > default
  if (customPath) {
    return customPath;
  }

  const envPath = process.env['CURSOR_DATA_PATH'];
  if (envPath) {
    return envPath;
  }

  return getDefaultCursorDataPath();
}

/**
 * Expand ~ to home directory in paths
 */
export function expandPath(path: string): string {
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/**
 * Contract a path by replacing home directory with ~
 */
export function contractPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  return path;
}

/**
 * Normalize a file path for consistent comparison
 * - Resolves ~ to home directory
 * - Removes trailing slashes
 */
export function normalizePath(filePath: string): string {
  // Expand ~ to home directory
  let normalized = filePath;
  if (normalized.startsWith('~')) {
    normalized = join(homedir(), normalized.slice(1));
  }

  // Remove trailing slashes (but keep root /)
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  while (normalized.length > 1 && normalized.endsWith('\\')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Compare two paths for equality (case-sensitive on Unix, case-insensitive on Windows)
 */
export function pathsEqual(path1: string, path2: string): boolean {
  const normalize = (p: string) => normalizePath(p).replace(/\\/g, '/');
  const n1 = normalize(path1);
  const n2 = normalize(path2);
  return process.platform === 'win32' ? n1.toLowerCase() === n2.toLowerCase() : n1 === n2;
}
