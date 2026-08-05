import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TemporaryArtifactCleanupError } from '../../src/core/errors.js';
import {
  PRIVATE_TEMP_MARKER_FILENAME,
  createPrivateTempWorkspace,
  getProcessStartToken,
  recoverStalePrivateTempWorkspaces,
  type PrivateTempMarker,
  type PrivateTempWorkspace,
} from '../../src/core/private-temp.js';

const testParents: string[] = [];

function createParent(mode = 0o751): string {
  const parent = mkdtempSync(join(tmpdir(), 'cursor-history-private-temp-unit-'));
  if (process.platform !== 'win32') chmodSync(parent, mode);
  testParents.push(parent);
  return parent;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function writeMarker(directory: string, marker: PrivateTempMarker | string): void {
  const markerPath = join(directory, PRIVATE_TEMP_MARKER_FILENAME);
  const descriptor = openSync(markerPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, typeof marker === 'string' ? marker : `${JSON.stringify(marker)}\n`);
  } finally {
    closeSync(descriptor);
  }
  if (process.platform !== 'win32') chmodSync(markerPath, 0o600);
}

function makeMarker(overrides: Partial<PrivateTempMarker> = {}): PrivateTempMarker {
  return {
    formatVersion: 1,
    ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
    pid: process.pid,
    processStartToken: getProcessStartToken() ?? `test:${process.pid}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  for (const parent of testParents.splice(0)) {
    rmSync(parent, { recursive: true, force: true });
  }
});

describe('PrivateTempWorkspace creation and cleanup', () => {
  it('creates exact owner-private POSIX modes without changing umask or parent permissions', () => {
    const parent = createParent(0o751);
    const parentModeBefore = process.platform === 'win32' ? undefined : mode(parent);
    const umaskBefore = process.umask();
    const workspace = createPrivateTempWorkspace({ prefix: 'secure-', parent });

    try {
      const filePath = workspace.createFile('snapshot.vscdb');
      expect(workspace.path.startsWith(parent)).toBe(true);
      expect(workspace.marker.formatVersion).toBe(1);
      expect(workspace.marker.pid).toBe(process.pid);
      expect(
        readFileSync(join(workspace.path, PRIVATE_TEMP_MARKER_FILENAME), 'utf8')
      ).not.toContain('snapshot');

      if (process.platform !== 'win32') {
        expect(mode(workspace.path)).toBe(0o700);
        expect(mode(filePath)).toBe(0o600);
        expect(mode(join(workspace.path, PRIVATE_TEMP_MARKER_FILENAME))).toBe(0o600);
        expect(mode(parent)).toBe(parentModeBefore);
      }
      expect(process.umask()).toBe(umaskBefore);
    } finally {
      workspace.dispose();
    }

    expect(existsSync(workspace.path)).toBe(false);
    expect(workspace.state).toBe('disposed');
  });

  it('creates collision-free workspaces and exclusive same-name files', () => {
    const parent = createParent();
    const workspaces: PrivateTempWorkspace[] = [];
    try {
      for (let index = 0; index < 16; index += 1) {
        const workspace = createPrivateTempWorkspace({ prefix: 'parallel-', parent });
        workspace.createFile('snapshot.db');
        workspaces.push(workspace);
      }

      expect(new Set(workspaces.map((workspace) => workspace.path)).size).toBe(16);
      expect(() => workspaces[0]!.createFile('snapshot.db')).toThrow();
    } finally {
      for (const workspace of workspaces) workspace.dispose();
    }

    expect(workspaces.every((workspace) => !existsSync(workspace.path))).toBe(true);
  });

  it('tracks caller-created artifacts, rejects external paths, and never follows symlinks', () => {
    const parent = createParent();
    const outsideDirectory = join(parent, 'outside');
    mkdirSync(outsideDirectory, { mode: 0o700 });
    const outsideFile = join(outsideDirectory, 'keep.txt');
    writeFileSync(outsideFile, 'keep', { mode: 0o600 });
    const workspace = createPrivateTempWorkspace({ prefix: 'tracked-', parent });

    const callerFile = join(workspace.path, 'driver-created.db');
    writeFileSync(callerFile, 'temporary', { mode: 0o600 });
    workspace.register(callerFile);
    const linkPath = join(workspace.path, 'outside-link');
    symlinkSync(outsideDirectory, linkPath, 'dir');
    workspace.register(linkPath);

    expect(() => workspace.register(outsideFile)).toThrow(TypeError);
    expect(() => workspace.register(join(linkPath, 'keep.txt'))).toThrow(TypeError);
    workspace.dispose();

    expect(existsSync(workspace.path)).toBe(false);
    expect(readFileSync(outsideFile, 'utf8')).toBe('keep');
  });

  it('refuses to descend through an unexpected intermediate directory during cleanup', () => {
    const parent = createParent();
    const outsideDirectory = join(parent, 'intermediate-outside');
    mkdirSync(outsideDirectory, { mode: 0o700 });
    const outsideFile = join(outsideDirectory, 'keep.txt');
    writeFileSync(outsideFile, 'keep', { mode: 0o600 });
    const workspace = createPrivateTempWorkspace({ prefix: 'intermediate-', parent });
    const unexpectedDirectory = join(workspace.path, 'unexpected-directory');
    mkdirSync(unexpectedDirectory, { mode: 0o700 });
    symlinkSync(outsideDirectory, join(unexpectedDirectory, 'outside-link'), 'dir');

    expect(() => workspace.dispose()).toThrow(TemporaryArtifactCleanupError);
    expect(readFileSync(outsideFile, 'utf8')).toBe('keep');
    expect(lstatSync(join(unexpectedDirectory, 'outside-link')).isSymbolicLink()).toBe(true);

    rmSync(unexpectedDirectory, { recursive: true, force: true });
    workspace.dispose();
    expect(workspace.state).toBe('disposed');
  });

  it('cleans on AbortSignal and remains safe to dispose repeatedly', () => {
    const parent = createParent();
    const controller = new AbortController();
    const workspace = createPrivateTempWorkspace({
      prefix: 'abort-',
      parent,
      signal: controller.signal,
    });
    workspace.createFile('plaintext.db');

    controller.abort();

    expect(workspace.state).toBe('disposed');
    expect(existsSync(workspace.path)).toBe(false);
    expect(() => workspace.dispose()).not.toThrow();
    expect(() => workspace.dispose()).not.toThrow();
  });

  it('removes plaintext through a caller failure finally path without replacing the operation error', () => {
    const parent = createParent();
    const workspace = createPrivateTempWorkspace({ prefix: 'finally-', parent });
    const operationError = new Error('synthetic parse failure');

    let observedError: unknown;
    try {
      try {
        workspace.createFile('plaintext.db');
        throw operationError;
      } finally {
        workspace.dispose();
      }
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBe(operationError);
    expect(workspace.state).toBe('disposed');
    expect(existsSync(workspace.path)).toBe(false);
  });

  it('creates nothing for an already-aborted operation', () => {
    const parent = createParent();
    const before = new Set(readdirNames(parent));
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      createPrivateTempWorkspace({ prefix: 'pre-abort-', parent, signal: controller.signal })
    ).toThrow();

    expect(new Set(readdirNames(parent))).toEqual(before);
  });

  it.runIf(process.platform !== 'win32')(
    'attempts every tracked artifact, reports paths-only residue, and retries idempotently',
    () => {
      const parent = createParent();
      const workspace = createPrivateTempWorkspace({ prefix: 'residue-', parent });
      const first = workspace.createFile('first.db');
      const second = workspace.createFile('second.db');
      writeFileSync(first, 'temporary database content');
      writeFileSync(second, 'different private content');
      chmodSync(workspace.path, 0o500);

      try {
        let cleanupError: unknown;
        try {
          workspace.dispose();
        } catch (error) {
          cleanupError = error;
        }

        expect(cleanupError).toBeInstanceOf(TemporaryArtifactCleanupError);
        expect(cleanupError).toMatchObject({
          code: 'TEMPORARY_ARTIFACT_CLEANUP_FAILED',
          details: { residuePaths: expect.arrayContaining([first, second, workspace.path]) },
        });
        expect(
          JSON.stringify((cleanupError as TemporaryArtifactCleanupError).details)
        ).not.toContain('temporary database content');
        expect(workspace.state).toBe('residue');
      } finally {
        chmodSync(workspace.path, 0o700);
        workspace.dispose();
      }

      expect(workspace.state).toBe('disposed');
      expect(existsSync(workspace.path)).toBe(false);
    }
  );
});

describe('conservative stale workspace recovery', () => {
  it('retains live, malformed, wrong-marker-owner, symlink, and unrelated candidates', () => {
    const parent = createParent();
    const prefix = 'recovery-';
    const live = createPrivateTempWorkspace({ prefix, parent });

    const malformed = join(parent, `${prefix}malformed`);
    mkdirSync(malformed, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(malformed, 0o700);
    writeMarker(malformed, '{bad json');

    const wrongMarkerOwner = join(parent, `${prefix}wrong-marker-owner`);
    mkdirSync(wrongMarkerOwner, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(wrongMarkerOwner, 0o700);
    writeMarker(
      wrongMarkerOwner,
      makeMarker(
        typeof process.getuid === 'function'
          ? { uid: process.getuid() + 1 }
          : { formatVersion: 2 as 1 }
      )
    );

    const symlinkTarget = join(parent, 'symlink-target');
    mkdirSync(symlinkTarget, { mode: 0o700 });
    const targetSentinel = join(symlinkTarget, 'sentinel.txt');
    writeFileSync(targetSentinel, 'untouched');
    const symlinkCandidate = join(parent, `${prefix}symlink`);
    symlinkSync(symlinkTarget, symlinkCandidate, 'dir');

    const markerSymlinkCandidate = join(parent, `${prefix}marker-symlink`);
    mkdirSync(markerSymlinkCandidate, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(markerSymlinkCandidate, 0o700);
    const externalMarkerDirectory = join(parent, 'external-marker');
    mkdirSync(externalMarkerDirectory, { mode: 0o700 });
    writeMarker(
      externalMarkerDirectory,
      makeMarker({ processStartToken: 'external-marker-token' })
    );
    const externalMarker = join(externalMarkerDirectory, PRIVATE_TEMP_MARKER_FILENAME);
    symlinkSync(externalMarker, join(markerSymlinkCandidate, PRIVATE_TEMP_MARKER_FILENAME), 'file');

    const unrelated = join(parent, 'recoveryX-unrelated');
    mkdirSync(unrelated, { mode: 0o700 });

    try {
      const result = recoverStalePrivateTempWorkspaces({ prefix, parent });
      const retained = new Map(result.retained.map((entry) => [entry.path, entry.reason]));

      expect(result.recoveredPaths).toEqual([]);
      expect(retained.get(live.path)).toBe('live-owner');
      expect(retained.get(malformed)).toBe('invalid-marker');
      expect(retained.get(wrongMarkerOwner)).toMatch(/marker|invalid/u);
      expect(retained.get(symlinkCandidate)).toBe('candidate-symlink');
      expect(retained.get(markerSymlinkCandidate)).toBe('invalid-marker');
      expect(retained.has(unrelated)).toBe(false);
      expect(lstatSync(symlinkCandidate).isSymbolicLink()).toBe(true);
      expect(
        lstatSync(join(markerSymlinkCandidate, PRIVATE_TEMP_MARKER_FILENAME)).isSymbolicLink()
      ).toBe(true);
      expect(readFileSync(targetSentinel, 'utf8')).toBe('untouched');
      expect(readFileSync(externalMarker, 'utf8')).toContain('external-marker-token');
    } finally {
      live.dispose();
    }
  });

  it('recovers a valid current-owner marker when the process-start token proves PID reuse', () => {
    const parent = createParent();
    const prefix = 'reused-';
    const candidate = join(parent, `${prefix}candidate`);
    mkdirSync(candidate, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(candidate, 0o700);
    writeMarker(candidate, makeMarker({ processStartToken: 'definitely-not-this-process' }));
    writeFileSync(join(candidate, 'plaintext.db'), 'private', { mode: 0o600 });

    const result = recoverStalePrivateTempWorkspaces({ prefix, parent });

    expect(result.recoveredPaths).toEqual([candidate]);
    expect(result.retained).toEqual([]);
    expect(existsSync(candidate)).toBe(false);
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path);
}
