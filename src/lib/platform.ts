/**
 * Platform detection and Cursor data path resolution
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  if (process.env['WSL_DISTRO_NAME'] || process.env['WSLENV'] || process.env['WSL_INTEROP']) {
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
 * 1. An explicit `--data-path` (or `CURSOR_DATA_PATH`) that identifies a Store
 *    tree (root or descendant) → 'store'; an explicit path that is NOT a Store
 *    tree (a Composer workspaceStorage root) → 'composer'.
 * 2. An explicit `CURSOR_STORE_ROOT` pointing somewhere other than the default
 *    ~/.cursor → 'store' (the operator deliberately redirected the Store stack).
 * 3. WSL → 'store' (accepted policy); otherwise (Windows / macOS / native Linux) → 'composer'.
 */
export function detectPreferredStackSource(customDataPath?: string): 'composer' | 'store' {
  // 1. Explicit --data-path / CURSOR_DATA_PATH selects its tree.
  const explicit = customDataPath ?? process.env['CURSOR_DATA_PATH'];
  if (explicit) {
    return findStoreRoot(explicit) ? 'store' : 'composer';
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
 * Compare two paths for equality across native Windows, file-URI, and WSL spellings.
 */
export function pathsEqual(path1: string, path2: string): boolean {
  const normalize = (p: string): string => {
    let normalized = normalizePath(p).replace(/\\/g, '/');
    if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
    const wsl = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
    if (wsl) normalized = `${wsl[1]}:/${wsl[2] ?? ''}`;
    if (/^[a-z]:$/i.test(normalized)) normalized += '/';
    if (/^[a-z]:\//i.test(normalized) || process.platform === 'win32') {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  };
  return normalize(path1) === normalize(path2);
}

/**
 * Get the root directory of Cursor's "Store stack" (`~/.cursor`).
 * Contains `chats/<hash>/<uuid>/{meta.json,store.db}` and
 * `projects/<sanitized>/agent-transcripts/<uuid>/*.jsonl`.
 *
 * Same path on Linux/macOS/Windows (and WSL): `~/.cursor`.
 * The Composer stack (`workspaceStorage`/`globalStorage`) lives elsewhere
 * (see `getDefaultCursorDataPath`); the two stacks are independent.
 *
 * Delegates to `resolveStoreRoot()` so every supported Store path form (explicit
 * root, `chats`/`projects`/`acp-sessions` descendant, `CURSOR_DATA_PATH`,
 * `CURSOR_STORE_ROOT`, default) resolves through ONE resolver.
 */
export function getStoreStackRoot(customDataPath?: string): string {
  return resolveStoreRoot(customDataPath);
}

const STORE_CHILDREN = ['chats', 'projects', 'acp-sessions'] as const;

/** Best-effort directory listing used only for Store-shape detection. */
function listSubdirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Does a single Store child contain a Store-specific layout? */
function hasStoreStructure(root: string): boolean {
  const chats = join(root, 'chats');
  for (const hash of listSubdirs(chats)) {
    for (const session of listSubdirs(join(chats, hash))) {
      const sessionDir = join(chats, hash, session);
      if (existsSync(join(sessionDir, 'meta.json')) || existsSync(join(sessionDir, 'store.db'))) {
        return true;
      }
    }
  }

  const projects = join(root, 'projects');
  for (const project of listSubdirs(projects)) {
    if (existsSync(join(projects, project, 'agent-transcripts'))) return true;
  }

  const acp = join(root, 'acp-sessions');
  for (const session of listSubdirs(acp)) {
    const sessionDir = join(acp, session);
    if (existsSync(join(sessionDir, 'meta.json')) || existsSync(join(sessionDir, 'store.db'))) {
      return true;
    }
  }
  return false;
}

/** Heuristic: does this path look like a Cursor Store stack root? */
function isStoreRoot(p: string): boolean {
  if (basename(p) === '.cursor') return true;
  const childCount = STORE_CHILDREN.filter((child) => existsSync(join(p, child))).length;
  return childCount >= 2 || hasStoreStructure(p);
}

/** Stronger proof required when deriving a root from a deep descendant. */
function isProvenStoreRoot(p: string): boolean {
  return basename(p) === '.cursor' || hasStoreStructure(p);
}

/**
 * Find a Store root from the root itself or an explicit descendant beneath
 * `chats`, `projects`, or `acp-sessions`. Merely having an unrelated directory
 * with one of those common names is not enough to classify an ancestor as a
 * Store root.
 */
export function findStoreRoot(p: string): string | null {
  if (isStoreRoot(p)) return p;
  // An explicitly supplied direct Store child is unambiguous even when the
  // Store is new and that directory is still empty.
  if (STORE_CHILDREN.includes(basename(p) as (typeof STORE_CHILDREN)[number])) {
    return dirname(p);
  }

  let cur = p;
  for (let depth = 0; depth < 8 && cur; depth++) {
    if (basename(cur) === '.cursor') return cur;
    if (STORE_CHILDREN.includes(basename(cur) as (typeof STORE_CHILDREN)[number])) {
      const candidate = dirname(cur);
      if (isProvenStoreRoot(candidate)) return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root
    cur = parent;
  }
  return null;
}

/**
 * The single Store-root resolver used by discovery and conflict-priority
 * detection. Resolution order:
 *   1. Explicit CLI data path when it identifies a Store tree (root or a
 *      descendant under chats/projects/acp-sessions, normalized back to root).
 *   2. `CURSOR_DATA_PATH` when it identifies a Store tree.
 *   3. `CURSOR_STORE_ROOT`.
 *   4. Default `~/.cursor`.
 * A Composer `workspaceStorage` path matches none of the Store checks and is
 * skipped, so it never shadows an independently configured or default Store root.
 */
export function resolveStoreRoot(customDataPath?: string): string {
  const fromCustom = customDataPath ? findStoreRoot(customDataPath) : null;
  if (fromCustom) return fromCustom;

  const envData = process.env['CURSOR_DATA_PATH'];
  if (envData) {
    const fromEnv = findStoreRoot(envData);
    if (fromEnv) return fromEnv;
  }

  const storeEnv = process.env['CURSOR_STORE_ROOT'];
  if (storeEnv) return findStoreRoot(storeEnv) ?? storeEnv;

  return join(homedir(), '.cursor');
}
