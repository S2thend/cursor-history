/**
 * Private temporary workspaces for plaintext database snapshots and staging artifacts.
 *
 * This module deliberately owns only temporary-workspace lifecycle. Backup and Store callers bind
 * it through nested try/finally blocks so close failures cannot bypass exhaustive cleanup.
 */

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import { TemporaryArtifactCleanupError } from './errors.js';

/** Stable discovery filename; the JSON formatVersion is the schema and deletion-safety boundary. */
export const PRIVATE_TEMP_MARKER_FILENAME = '.cursor-history-private-temp-v1.json';
const PRIVATE_TEMP_MARKER_MAX_BYTES = 4 * 1024;
const CATCHABLE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const SIGNAL_NUMBERS: Readonly<Record<(typeof CATCHABLE_SIGNALS)[number], number>> = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGHUP: 1,
};
const IS_PERMISSION_AWARE_POSIX = process.platform !== 'win32';
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
// performance.timeOrigin is stable for this process across duplicate module instances, while a
// later process reusing the same PID receives a different token.
const FALLBACK_CURRENT_PROCESS_TOKEN = `process:${process.pid}:${Math.trunc(performance.timeOrigin * 1_000)}`;

export interface PrivateTempMarker {
  readonly formatVersion: 2;
  readonly uid?: number;
  readonly pid: number;
  /** Boot-scoped Linux PID-namespace identity; absent where procfs cannot verify it. */
  readonly pidNamespaceToken?: string;
  readonly processStartToken: string;
  readonly createdAt: string;
}

interface LegacyPrivateTempMarker {
  readonly formatVersion: 1;
  readonly uid?: number;
  readonly pid: number;
  readonly processStartToken: string;
  readonly createdAt: string;
}

type RecoverablePrivateTempMarker = PrivateTempMarker | LegacyPrivateTempMarker;

export interface PrivateTempWorkspaceOptions {
  readonly prefix: string;
  readonly parent?: string;
  readonly signal?: AbortSignal;
}

export type PrivateTempWorkspaceState = 'open' | 'disposing' | 'disposed' | 'residue';

export interface PrivateTempWorkspace {
  readonly path: string;
  readonly marker: PrivateTempMarker;
  readonly state: PrivateTempWorkspaceState;
  createFile(name: string): string;
  register(path: string): void;
  dispose(): void;
}

export type StalePrivateTempRetentionReason =
  | 'candidate-symlink'
  | 'not-directory'
  | 'owner-mismatch'
  | 'insecure-directory-mode'
  | 'invalid-marker'
  | 'marker-owner-mismatch'
  | 'insecure-marker-mode'
  | 'live-owner'
  | 'owner-status-uncertain'
  | 'cleanup-failed';

export interface StalePrivateTempRetention {
  readonly path: string;
  readonly reason: StalePrivateTempRetentionReason;
}

export interface StalePrivateTempRecoveryResult {
  readonly recoveredPaths: string[];
  readonly retained: StalePrivateTempRetention[];
}

interface MarkerReadResult {
  readonly marker?: RecoverablePrivateTempMarker;
  readonly reason?: StalePrivateTempRetentionReason;
}

type CatchableSignal = (typeof CATCHABLE_SIGNALS)[number];

const activeWorkspaces = new Set<PrivateTempWorkspaceImpl>();
const installedSignalHandlers = new Map<CatchableSignal, () => void>();
let handlingSignal = false;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errnoCode(error) === 'ENOENT';
}

function validatePrefix(prefix: string): void {
  if (
    prefix.length === 0 ||
    prefix.length > 128 ||
    prefix === '.' ||
    prefix === '..' ||
    basename(prefix) !== prefix ||
    prefix.includes('\0') ||
    prefix.includes('/') ||
    prefix.includes('\\')
  ) {
    throw new TypeError('Private temporary prefix must be a nonempty filesystem-safe name prefix.');
  }
}

function validateFileName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    basename(name) !== name ||
    name.includes('\0') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new TypeError('Private temporary files must use a direct, filesystem-safe leaf name.');
  }
}

function resolveParent(parent?: string): string {
  const requestedParent = resolve(parent ?? tmpdir());
  const parentPath = realpathSync(requestedParent);
  const parentStats = statSync(parentPath);
  if (!parentStats.isDirectory()) {
    throw new TypeError('Private temporary parent must be an existing directory.');
  }

  if (process.platform === 'win32') {
    const systemTempPath = realpathSync(resolve(tmpdir()));
    const fromSystemTemp = relative(systemTempPath, parentPath);
    if (
      fromSystemTemp.startsWith(`..${sep}`) ||
      fromSystemTemp === '..' ||
      isAbsolute(fromSystemTemp)
    ) {
      throw new TypeError(
        'On Windows, private temporary workspaces must remain under the system user temporary directory.'
      );
    }
  }

  return parentPath;
}

function readLinuxBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(bootId)
      ? bootId.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

function readLinuxProcessStartToken(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const statText = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = statText.lastIndexOf(')');
    if (commandEnd < 0) return undefined;
    const fieldsFromState = statText
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fieldsFromState[19];
    if (!startTicks || !/^\d+$/u.test(startTicks)) return undefined;
    const bootId = readLinuxBootId();
    if (!bootId) return undefined;
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return undefined;
  }
}

/**
 * Identify the Linux PID namespace in which numeric process identifiers have meaning.
 *
 * Absence is intentional when procfs does not expose a trustworthy namespace identity. Callers
 * must treat that state as unverifiable rather than comparing a numeric PID across namespaces.
 */
function readLinuxPidNamespaceToken(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = readLinuxBootId();
    if (!bootId) return undefined;
    const target = readlinkSync('/proc/self/ns/pid');
    const match = /^pid:\[([1-9]\d*)\]$/u.exec(target);
    return match?.[1] ? `linux-pidns:${bootId}:${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

/** Return a comparable process-start token where the platform exposes one safely. */
export function getProcessStartToken(pid = process.pid): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const linuxToken = readLinuxProcessStartToken(pid);
  if (linuxToken) return linuxToken;
  return pid === process.pid ? FALLBACK_CURRENT_PROCESS_TOKEN : undefined;
}

function createMarker(): PrivateTempMarker {
  const pidNamespaceToken = readLinuxPidNamespaceToken();
  return {
    // Version 2 is a deletion-safety boundary, not merely descriptive metadata. A v1 reader that
    // does not understand PID namespaces rejects this marker before probing a namespace-local PID.
    formatVersion: 2,
    ...(CURRENT_UID === undefined ? {} : { uid: CURRENT_UID }),
    pid: process.pid,
    ...(pidNamespaceToken === undefined ? {} : { pidNamespaceToken }),
    processStartToken: getProcessStartToken() ?? FALLBACK_CURRENT_PROCESS_TOKEN,
    createdAt: new Date().toISOString(),
  };
}

function exclusiveFlags(): number {
  let flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW;
  return flags;
}

function createExclusivePrivateFile(path: string, contents?: string): void {
  const descriptor = openSync(path, exclusiveFlags(), 0o600);
  try {
    if (IS_PERMISSION_AWARE_POSIX) fchmodSync(descriptor, 0o600);
    if (contents !== undefined) {
      writeFileSync(descriptor, contents, { encoding: 'utf8' });
      fsyncSync(descriptor);
    }
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Remove one path without recursively traversing a child directory.
 *
 * Temporary-workspace artifacts are direct children by contract. Refusing to descend is
 * intentional: a concurrently replaced intermediate directory can otherwise turn a path-based
 * recursive walk into deletion outside the private workspace. Unexpected nonempty directories are
 * retained and reported as residue instead.
 */
function attemptRemoveEntryNoFollow(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) {
      // The caller performs a final existence check and reports possible residue by path.
    }
    return;
  }

  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    try {
      rmdirSync(path);
    } catch {
      // Continue so every sibling and tracked artifact receives an attempt.
    }
    return;
  }

  try {
    unlinkSync(path);
  } catch {
    // The caller performs a final existence check and reports possible residue by path.
  }
}

/** Remove every direct entry and then the private workspace itself without following links. */
function attemptRemoveWorkspaceNoFollow(directoryPath: string): void {
  let stats;
  try {
    stats = lstatSync(directoryPath);
  } catch {
    return;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    attemptRemoveEntryNoFollow(directoryPath);
    return;
  }

  let names: string[];
  try {
    names = readdirSync(directoryPath);
  } catch {
    return;
  }
  for (const name of names) attemptRemoveEntryNoFollow(join(directoryPath, name));
  try {
    rmdirSync(directoryPath);
  } catch {
    // The caller reports the private directory as residue after every direct entry was attempted.
  }
}

function mayStillExist(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

function isDirectChildPath(directoryPath: string, candidatePath: string): boolean {
  const difference = relative(directoryPath, candidatePath);
  return (
    difference.length > 0 &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference) &&
    !difference.includes(sep)
  );
}

function validateMarkerValue(value: unknown): RecoverablePrivateTempMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const marker = value as Record<string, unknown>;
  const formatVersion = marker['formatVersion'];
  if (formatVersion !== 1 && formatVersion !== 2) return undefined;
  if (!Number.isSafeInteger(marker['pid']) || Number(marker['pid']) <= 0) return undefined;
  if (
    formatVersion === 2 &&
    marker['pidNamespaceToken'] !== undefined &&
    (typeof marker['pidNamespaceToken'] !== 'string' ||
      !/^linux-pidns:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d*$/iu.test(
        marker['pidNamespaceToken']
      ))
  ) {
    return undefined;
  }
  if (
    typeof marker['processStartToken'] !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,512}$/u.test(marker['processStartToken'])
  ) {
    return undefined;
  }
  if (typeof marker['createdAt'] !== 'string') return undefined;
  const parsedCreatedAt = new Date(marker['createdAt']);
  if (
    !Number.isFinite(parsedCreatedAt.getTime()) ||
    parsedCreatedAt.toISOString() !== marker['createdAt']
  ) {
    return undefined;
  }

  if (CURRENT_UID !== undefined) {
    if (!Number.isSafeInteger(marker['uid'])) return undefined;
  } else if (marker['uid'] !== undefined) {
    return undefined;
  }

  const commonFields = {
    ...(marker['uid'] === undefined ? {} : { uid: Number(marker['uid']) }),
    pid: Number(marker['pid']),
    processStartToken: marker['processStartToken'],
    createdAt: marker['createdAt'],
  };
  if (formatVersion === 1) {
    // v1 predates PID-namespace provenance. Unknown fields are intentionally ignored, including
    // the field briefly emitted without a version bump, so Linux recovery can recognize the
    // marker only as legacy and retain it conservatively.
    return { formatVersion: 1, ...commonFields };
  }
  const pidNamespaceToken = marker['pidNamespaceToken'];
  return {
    formatVersion: 2,
    ...commonFields,
    ...(typeof pidNamespaceToken === 'string' ? { pidNamespaceToken } : {}),
  };
}

function readMarker(candidatePath: string): MarkerReadResult {
  const markerPath = join(candidatePath, PRIVATE_TEMP_MARKER_FILENAME);
  let descriptor: number | undefined;
  try {
    let flags = constants.O_RDONLY;
    if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW;
    descriptor = openSync(markerPath, flags);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > PRIVATE_TEMP_MARKER_MAX_BYTES) {
      return { reason: 'invalid-marker' };
    }
    if (CURRENT_UID !== undefined && stats.uid !== CURRENT_UID) {
      return { reason: 'marker-owner-mismatch' };
    }
    if (IS_PERMISSION_AWARE_POSIX && (stats.mode & 0o777) !== 0o600) {
      return { reason: 'insecure-marker-mode' };
    }
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    const marker = validateMarkerValue(value);
    if (!marker) return { reason: 'invalid-marker' };
    if (CURRENT_UID !== undefined && marker.uid !== CURRENT_UID) {
      return { reason: 'marker-owner-mismatch' };
    }
    return { marker };
  } catch {
    return { reason: 'invalid-marker' };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A close failure leaves the candidate uncertain; the marker result is never used to
        // expose content, and conservative recovery will retain it on the next validation failure.
      }
    }
  }
}

type OwnerProcessStatus = 'dead' | 'live' | 'reused' | 'uncertain';

function ownerProcessStatus(marker: RecoverablePrivateTempMarker): OwnerProcessStatus {
  if (process.platform === 'linux') {
    // A v1 marker can be read for compatibility but cannot prove the PID namespace in which its
    // numeric PID and start token were recorded. Never use those values to authorize deletion.
    if (marker.formatVersion === 1) return 'uncertain';
    const currentPidNamespaceToken = readLinuxPidNamespaceToken();
    if (
      !marker.pidNamespaceToken ||
      !currentPidNamespaceToken ||
      marker.pidNamespaceToken !== currentPidNamespaceToken
    ) {
      return 'uncertain';
    }
  } else if (marker.formatVersion === 2 && marker.pidNamespaceToken !== undefined) {
    // A marker carrying Linux PID-namespace provenance cannot be interpreted safely elsewhere.
    return 'uncertain';
  }

  try {
    process.kill(marker.pid, 0);
  } catch (error) {
    if (errnoCode(error) === 'ESRCH') return 'dead';
    return 'uncertain';
  }

  const observedToken = getProcessStartToken(marker.pid);
  if (observedToken) return observedToken === marker.processStartToken ? 'live' : 'reused';

  // The process may have exited between kill(0) and token retrieval. Only ESRCH is proof of death.
  try {
    process.kill(marker.pid, 0);
    return 'uncertain';
  } catch (error) {
    return errnoCode(error) === 'ESRCH' ? 'dead' : 'uncertain';
  }
}

/**
 * Recover exact-prefix private workspaces whose current-owner process is proven dead or reused.
 * Linux recovery first proves that the marker belongs to the current PID namespace. Symlinks,
 * malformed markers, ownership or namespace mismatches, live owners, and uncertain states are
 * retained.
 */
export function recoverStalePrivateTempWorkspaces(
  options: Pick<PrivateTempWorkspaceOptions, 'prefix' | 'parent'>
): StalePrivateTempRecoveryResult {
  validatePrefix(options.prefix);
  const parentPath = resolveParent(options.parent);
  const recoveredPaths: string[] = [];
  const retained: StalePrivateTempRetention[] = [];

  const candidateNames = readdirSync(parentPath).filter((name) => name.startsWith(options.prefix));
  for (const name of candidateNames) {
    const candidatePath = join(parentPath, name);
    let stats;
    try {
      stats = lstatSync(candidatePath);
    } catch (error) {
      if (!isMissing(error))
        retained.push({ path: candidatePath, reason: 'owner-status-uncertain' });
      continue;
    }

    if (stats.isSymbolicLink()) {
      retained.push({ path: candidatePath, reason: 'candidate-symlink' });
      continue;
    }
    if (!stats.isDirectory()) {
      retained.push({ path: candidatePath, reason: 'not-directory' });
      continue;
    }
    if (CURRENT_UID !== undefined && stats.uid !== CURRENT_UID) {
      retained.push({ path: candidatePath, reason: 'owner-mismatch' });
      continue;
    }
    if (IS_PERMISSION_AWARE_POSIX && (stats.mode & 0o777) !== 0o700) {
      retained.push({ path: candidatePath, reason: 'insecure-directory-mode' });
      continue;
    }

    const markerResult = readMarker(candidatePath);
    if (!markerResult.marker) {
      retained.push({
        path: candidatePath,
        reason: markerResult.reason ?? 'invalid-marker',
      });
      continue;
    }

    const status = ownerProcessStatus(markerResult.marker);
    if (status === 'live') {
      retained.push({ path: candidatePath, reason: 'live-owner' });
      continue;
    }
    if (status === 'uncertain') {
      retained.push({ path: candidatePath, reason: 'owner-status-uncertain' });
      continue;
    }

    attemptRemoveWorkspaceNoFollow(candidatePath);
    if (mayStillExist(candidatePath)) {
      retained.push({ path: candidatePath, reason: 'cleanup-failed' });
    } else {
      recoveredPaths.push(candidatePath);
    }
  }

  return { recoveredPaths, retained };
}

function uninstallSignalHandlers(): void {
  for (const [signal, handler] of installedSignalHandlers) {
    process.removeListener(signal, handler);
  }
  installedSignalHandlers.clear();
}

function preserveSignalTermination(signal: CatchableSignal): void {
  uninstallSignalHandlers();
  // Every listener already receives the original EventEmitter dispatch. Removing the signal's
  // listeners before re-raising prevents the synthetic second delivery and restores the platform
  // default (signal-observable) termination rather than converting it to an ordinary exit code.
  process.removeAllListeners(signal);
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(128 + SIGNAL_NUMBERS[signal]);
  }
}

function handleSignal(signal: CatchableSignal): void {
  if (handlingSignal) {
    preserveSignalTermination(signal);
    return;
  }
  handlingSignal = true;
  for (const workspace of [...activeWorkspaces]) {
    try {
      workspace.dispose();
    } catch {
      // Signal cleanup is best effort. Any residue remains confined to its private directory and is
      // eligible only for conservative next-run recovery.
    }
  }
  preserveSignalTermination(signal);
}

function installSignalHandlers(): void {
  if (installedSignalHandlers.size > 0) return;
  for (const signal of CATCHABLE_SIGNALS) {
    const handler = () => handleSignal(signal);
    try {
      process.on(signal, handler);
      installedSignalHandlers.set(signal, handler);
    } catch {
      // Some Windows hosts do not support every POSIX signal. The supported handlers retain the
      // same cleanup guarantees without claiming unavailable platform semantics.
    }
  }
}

function registerActiveWorkspace(workspace: PrivateTempWorkspaceImpl): void {
  activeWorkspaces.add(workspace);
  installSignalHandlers();
}

function unregisterActiveWorkspace(workspace: PrivateTempWorkspaceImpl): void {
  activeWorkspaces.delete(workspace);
  if (activeWorkspaces.size === 0 && !handlingSignal) uninstallSignalHandlers();
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The private temporary workspace operation was aborted.');
  error.name = 'AbortError';
  return error;
}

class PrivateTempWorkspaceImpl implements PrivateTempWorkspace {
  private readonly trackedPaths = new Set<string>();
  private stateValue: PrivateTempWorkspaceState = 'open';
  private readonly abortSignal?: AbortSignal;
  private readonly abortHandler?: () => void;

  constructor(
    readonly path: string,
    readonly marker: PrivateTempMarker,
    markerPath: string,
    signal?: AbortSignal
  ) {
    this.trackedPaths.add(markerPath);
    this.abortSignal = signal;
    if (signal) {
      this.abortHandler = () => {
        try {
          this.dispose();
        } catch {
          // The owning operation's normal finally path retries disposal and surfaces residue.
        }
      };
      signal.addEventListener('abort', this.abortHandler, { once: true });
    }
    registerActiveWorkspace(this);
  }

  get state(): PrivateTempWorkspaceState {
    return this.stateValue;
  }

  private assertOpen(): void {
    if (this.stateValue !== 'open') {
      throw new Error(`Private temporary workspace is ${this.stateValue}.`);
    }
  }

  createFile(name: string): string {
    this.assertOpen();
    validateFileName(name);
    const filePath = join(this.path, name);
    this.trackedPaths.add(filePath);
    createExclusivePrivateFile(filePath);
    return filePath;
  }

  register(path: string): void {
    this.assertOpen();
    const candidatePath = resolve(path);
    if (!isDirectChildPath(this.path, candidatePath)) {
      throw new TypeError(
        'Tracked temporary artifacts must be direct children of their private workspace.'
      );
    }
    this.trackedPaths.add(candidatePath);
  }

  dispose(): void {
    if (this.stateValue === 'disposed' || this.stateValue === 'disposing') return;
    this.stateValue = 'disposing';
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener('abort', this.abortHandler);
    }

    const tracked = [...this.trackedPaths].sort((left, right) => right.length - left.length);
    for (const path of tracked) attemptRemoveEntryNoFollow(path);
    attemptRemoveWorkspaceNoFollow(this.path);

    const residuePaths = tracked.filter(mayStillExist);
    if (mayStillExist(this.path)) residuePaths.push(this.path);
    if (residuePaths.length > 0) {
      this.stateValue = 'residue';
      throw new TemporaryArtifactCleanupError(residuePaths);
    }

    this.stateValue = 'disposed';
    unregisterActiveWorkspace(this);
  }
}

/** Create one exclusive private temporary workspace and register its complete lifecycle. */
export function createPrivateTempWorkspace(
  options: PrivateTempWorkspaceOptions
): PrivateTempWorkspace {
  validatePrefix(options.prefix);
  if (options.signal?.aborted) throw abortError(options.signal);
  const parentPath = resolveParent(options.parent);

  const recovery = recoverStalePrivateTempWorkspaces({
    prefix: options.prefix,
    parent: parentPath,
  });
  const failedRecoveryPaths = recovery.retained
    .filter((entry) => entry.reason === 'cleanup-failed')
    .map((entry) => entry.path);
  if (failedRecoveryPaths.length > 0) {
    throw new TemporaryArtifactCleanupError(failedRecoveryPaths);
  }

  let directoryPath: string | undefined;
  try {
    directoryPath = mkdtempSync(join(parentPath, options.prefix));
    if (IS_PERMISSION_AWARE_POSIX) chmodSync(directoryPath, 0o700);
    const marker = createMarker();
    const markerPath = join(directoryPath, PRIVATE_TEMP_MARKER_FILENAME);
    createExclusivePrivateFile(markerPath, `${JSON.stringify(marker)}\n`);
    return new PrivateTempWorkspaceImpl(directoryPath, marker, markerPath, options.signal);
  } catch (error) {
    if (directoryPath) {
      attemptRemoveWorkspaceNoFollow(directoryPath);
      if (mayStillExist(directoryPath)) {
        const cleanupError = new TemporaryArtifactCleanupError([directoryPath]);
        Object.defineProperty(cleanupError, 'cause', {
          configurable: true,
          value: error,
        });
        throw cleanupError;
      }
    }
    throw error;
  }
}
