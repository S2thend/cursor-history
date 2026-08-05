/**
 * Pure lexical workspace-path normalization and scope matching.
 *
 * This module deliberately has no filesystem dependency. Cursor history may
 * refer to historical, foreign-platform, or currently unmounted workspaces, so
 * matching must never depend on realpath/stat/existence checks.
 */

import { WorkspaceAmbiguityError } from './errors.js';
import type { WorkspaceMatchKind } from './types.js';

export { WorkspaceAmbiguityError } from './errors.js';
export type { WorkspaceMatchKind } from './types.js';

export type WorkspaceScopeResult =
  | { kind: 'matched'; path: string; matchKind: WorkspaceMatchKind }
  | { kind: 'not-found'; normalizedRequest: string };

interface NormalizedWorkspacePath {
  /** Stable public spelling used by scope/path projections. */
  path: string;
  /** Path components excluding a root or drive anchor. */
  components: string[];
  /** Drive/UNC paths use case-insensitive comparison. */
  caseInsensitive: boolean;
  /** A drive anchor prevents suffix matching across different drives. */
  drive?: string;
  /** UNC requests match only the same server/share anchor. */
  uncAnchor?: string;
}

/** Unicode code-point ordering, independent of the process locale. */
function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Decode supported file URIs without consulting the host filesystem. */
function decodeFileUri(value: string): string {
  if (!/^file:/i.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Invalid workspace file URI: ${value}`);
  }
  if (url.protocol !== 'file:') return value;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new TypeError(`Invalid percent encoding in workspace file URI: ${value}`);
  }

  // file://localhost/path is local. Any other host denotes a Windows UNC path.
  if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
    return `//${url.hostname}${pathname}`;
  }
  return pathname;
}

function collapseSegments(
  rawSegments: readonly string[],
  absolute: boolean,
  protectedCount = 0
): string[] {
  const result: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (result.length > protectedCount && result[result.length - 1] !== '..') {
        result.pop();
      } else if (!absolute) {
        result.push(segment);
      }
      continue;
    }
    result.push(segment);
  }
  return result;
}

function normalizeWorkspacePathDetails(input: string): NormalizedWorkspacePath {
  if (typeof input !== 'string' || input.length === 0) {
    throw new TypeError('Workspace path must be a non-empty string.');
  }

  let value = decodeFileUri(input).replace(/\\/g, '/');

  // Normalize native Windows and file-URI drive spellings (`C:/x`, `/C:/x`).
  const driveMatch = value.match(/^\/?([a-z]):(?:\/(.*))?$/i);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const segments = collapseSegments((driveMatch[2] ?? '').split('/'), true).map((part) =>
      part.toLowerCase()
    );
    return {
      path: segments.length > 0 ? `${drive}:/${segments.join('/')}` : `${drive}:/`,
      components: segments,
      caseInsensitive: true,
      drive,
    };
  }

  // WSL drive mounts are the same historical workspace identity as Windows drives.
  const wslMatch = value.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (wslMatch) {
    const drive = wslMatch[1]!.toLowerCase();
    const segments = collapseSegments((wslMatch[2] ?? '').split('/'), true).map((part) =>
      part.toLowerCase()
    );
    return {
      path: segments.length > 0 ? `${drive}:/${segments.join('/')}` : `${drive}:/`,
      components: segments,
      caseInsensitive: true,
      drive,
    };
  }

  if (value.startsWith('//')) {
    const segments = collapseSegments(value.slice(2).split('/'), true, 2).map((part) =>
      part.toLowerCase()
    );
    const server = segments[0] ?? '';
    const share = segments[1] ?? '';
    const uncAnchor = `${server}/${share}`;
    return {
      path: `//${segments.join('/')}`,
      components: segments.slice(2),
      caseInsensitive: true,
      uncAnchor,
    };
  }

  const absolute = value.startsWith('/');
  const segments = collapseSegments(value.split('/'), absolute);
  if (process.platform === 'win32') {
    value = segments.map((part) => part.toLowerCase()).join('/');
    return {
      path: absolute ? `/${value}` : value || '.',
      components: segments.map((part) => part.toLowerCase()),
      caseInsensitive: true,
    };
  }

  return {
    path: absolute ? `/${segments.join('/')}` : segments.join('/') || '.',
    components: segments,
    caseInsensitive: false,
  };
}

/**
 * Normalize a historical workspace path lexically.
 *
 * Supported transformations include file-URI decoding, separator and dot
 * segment normalization, trailing-separator removal, and Windows/WSL drive
 * equivalence. The path is not opened or checked for existence.
 */
export function normalizeWorkspacePath(input: string): string {
  return normalizeWorkspacePathDetails(input).path;
}

function exactComparisonKey(path: NormalizedWorkspacePath): string {
  return path.caseInsensitive ? path.path.toLowerCase() : path.path;
}

function componentsEndWith(
  candidate: NormalizedWorkspacePath,
  request: NormalizedWorkspacePath
): boolean {
  if (request.drive && candidate.drive !== request.drive) return false;
  if (request.uncAnchor && candidate.uncAnchor !== request.uncAnchor) return false;
  if (request.components.length === 0 || request.components.length > candidate.components.length) {
    return false;
  }

  const offset = candidate.components.length - request.components.length;
  const insensitive = candidate.caseInsensitive || request.caseInsensitive;
  for (let index = 0; index < request.components.length; index++) {
    const candidatePart = candidate.components[offset + index]!;
    const requestPart = request.components[index]!;
    if (
      (insensitive ? candidatePart.toLowerCase() : candidatePart) !==
      (insensitive ? requestPart.toLowerCase() : requestPart)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve a workspace request against known normalized memberships.
 *
 * Exact matches always win. A suffix is accepted only when its complete path
 * components identify one normalized candidate; multiple suffix candidates
 * throw before a caller can proceed to conversation hydration.
 */
export function resolveWorkspaceScope(
  request: string,
  memberships: readonly string[]
): WorkspaceScopeResult {
  const normalizedRequest = normalizeWorkspacePathDetails(request);
  const uniqueCandidates = new Map<string, NormalizedWorkspacePath>();

  for (const membership of memberships) {
    const candidate = normalizeWorkspacePathDetails(membership);
    const key = exactComparisonKey(candidate);
    if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
  }

  const candidates = [...uniqueCandidates.values()];
  const requestKey = exactComparisonKey(normalizedRequest);
  const exact = candidates.find((candidate) => exactComparisonKey(candidate) === requestKey);
  if (exact) {
    return { kind: 'matched', path: exact.path, matchKind: 'exact' };
  }

  const suffixMatches = candidates.filter((candidate) =>
    componentsEndWith(candidate, normalizedRequest)
  );
  if (suffixMatches.length === 1) {
    return { kind: 'matched', path: suffixMatches[0]!.path, matchKind: 'unique-suffix' };
  }
  if (suffixMatches.length > 1) {
    throw new WorkspaceAmbiguityError(
      normalizedRequest.path,
      suffixMatches.map((candidate) => candidate.path).sort(compareCodePoints)
    );
  }

  return { kind: 'not-found', normalizedRequest: normalizedRequest.path };
}
