/**
 * Platform detection and Cursor data path resolution
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
 * Detect WSL (Windows Subsystem for Linux) independently of native Linux.
 * WSL runs a Linux kernel; on this machine the Store stack lives at ~/.cursor
 * on the Linux filesystem. Per the cross-stack conflict policy, WSL prefers
 * the Store stack; native Linux keeps the default Composer-first resolution.
 *
 * Detection: /proc/version mentions microsoft/WSL, or WSL-specific env vars
 * are set. Cached after the first read.
 */
let cachedIsWsl: boolean | undefined;
export function isWSL(): boolean {
  if (cachedIsWsl !== undefined) return cachedIsWsl;
  if (process.platform !== 'linux') {
    cachedIsWsl = false;
    return false;
  }
  if (
    process.env['WSL_DISTRO_NAME'] ||
    process.env['WSLENV'] ||
    process.env['WSL_INTEROP']
  ) {
    cachedIsWsl = true;
    return true;
  }
  try {
    const version = readFileSync('/proc/version', 'utf8');
    cachedIsWsl = /microsoft|wsl/i.test(version);
  } catch {
    cachedIsWsl = false;
  }
  return cachedIsWsl;
}

/**
 * Resolve the preferred stack source for a TRUE cross-stack conflict (same
 * session ID in both stacks). Uses ONLY existing configuration signals — no new
 * environment variable is introduced.
 *
 * Priority:
 * 1. An explicit `--data-path` (or `CURSOR_DATA_PATH`) that is a Store root → 'store';
 *    an explicit path that is NOT a Store root (a Composer workspaceStorage root) → 'composer'.
 * 2. An explicit `CURSOR_STORE_ROOT` pointing somewhere other than the default
 *    ~/.cursor → 'store' (the operator deliberately redirected the Store stack).
 * 3. WSL → 'store' (accepted policy); otherwise (Windows / macOS / native Linux) → 'composer'.
 */
export function detectPreferredStackSource(customDataPath?: string): 'composer' | 'store' {
  // 1. Explicit --data-path / CURSOR_DATA_PATH selects its tree.
  const selected = customDataPath ?? process.env['CURSOR_DATA_PATH'];
  if (selected) {
    return isStoreRoot(selected) ? 'store' : 'composer';
  }
  // 2. Explicit CURSOR_STORE_ROOT (not the default ~/.cursor) selects Store.
  const storeRootEnv = process.env['CURSOR_STORE_ROOT'];
  const defaultStoreRoot = join(homedir(), '.cursor');
  if (storeRootEnv && !pathsEqual(storeRootEnv, defaultStoreRoot)) {
    return 'store';
  }
  // 3. Platform inference.
  return isWSL() ? 'store' : 'composer';
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
 * Get the Cursor global storage path for the active workspaceStorage root.
 */
export function getGlobalStoragePath(customDataPath?: string): string {
  return join(dirname(getCursorDataPath(customDataPath)), 'globalStorage');
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

/**
 * Get the root directory of Cursor's "Store stack" (`~/.cursor`).
 * Contains `chats/<hash>/<uuid>/{meta.json,store.db}` and
 * `projects/<sanitized>/agent-transcripts/<uuid>/*.jsonl`.
 *
 * Same path on Linux/macOS/Windows (and WSL): `~/.cursor`.
 * The Composer stack (`workspaceStorage`/`globalStorage`) lives elsewhere
 * (see `getDefaultCursorDataPath`); the two stacks are independent.
 */
export function getStoreStackRoot(customDataPath?: string): string {
  // Honor --data-path ONLY when it actually looks like a Store root (contains
  // chats/ and/or projects/, or is named '.cursor'). Otherwise --data-path is
  // the Composer workspaceStorage root and must NOT shadow the real Store root
  // (CURSOR_STORE_ROOT / ~/.cursor) — otherwise Composer users lose their
  // Store sessions when passing --data-path.
  if (customDataPath && isStoreRoot(customDataPath)) return customDataPath;
  return process.env['CURSOR_STORE_ROOT'] ?? join(homedir(), '.cursor');
}

/** Heuristic: does this path look like a Cursor Store stack root? */
function isStoreRoot(p: string): boolean {
  if (basename(p) === '.cursor') return true;
  return existsSync(join(p, 'chats')) || existsSync(join(p, 'projects'));
}
