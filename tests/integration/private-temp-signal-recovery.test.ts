import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  PRIVATE_TEMP_MARKER_FILENAME,
  createPrivateTempWorkspace,
  type PrivateTempMarker,
} from '../../src/core/private-temp.js';

interface ChildReadyMessage {
  readonly paths: string[];
  readonly files: string[];
  readonly markerPaths: string[];
  readonly umask: number;
}

interface RecoveryChildMessage {
  readonly recoveredPaths: string[];
  readonly retained: Array<{ readonly path: string; readonly reason: string }>;
}

const childScript = String.raw`
const [moduleUrl, parent, prefix, countText] = process.argv.slice(1);
const { createPrivateTempWorkspace } = await import(moduleUrl);
process.umask(0);
const count = Number(countText);
const workspaces = [];
const controller = new AbortController();
for (let index = 0; index < count; index += 1) {
  const workspace = createPrivateTempWorkspace({ prefix, parent, signal: controller.signal });
  const file = workspace.createFile('plaintext-' + index + '.vscdb');
  workspaces.push({ workspace, file });
}
if (!process.send) throw new Error('IPC readiness channel is unavailable.');
process.send({
  paths: workspaces.map(({ workspace }) => workspace.path),
  files: workspaces.map(({ file }) => file),
  markerPaths: workspaces.map(({ workspace }) =>
    workspace.path + '/${PRIVATE_TEMP_MARKER_FILENAME}'
  ),
  umask: process.umask(),
});
process.on('message', (message) => {
  if (message !== 'abort') return;
  controller.abort();
  setImmediate(() => process.exit(0));
});
setInterval(() => {}, 1_000);
`;

const recoveryChildScript = String.raw`
const [moduleUrl, parent, prefix] = process.argv.slice(1);
const { recoverStalePrivateTempWorkspaces } = await import(moduleUrl);
if (!process.send) throw new Error('IPC recovery channel is unavailable.');
const result = recoverStalePrivateTempWorkspaces({ prefix, parent });
process.send(result, () => process.exit(0));
`;

let compiledRoot = '';
let compiledModuleUrl = '';
const testParents: string[] = [];
const liveChildren = new Set<ChildProcess>();

function transpileForChild(sourcePath: string, outputPath: string): void {
  const source = readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
  writeFileSync(outputPath, output, { mode: 0o600 });
}

beforeAll(() => {
  compiledRoot = mkdtempSync(join(tmpdir(), 'cursor-history-private-temp-child-build-'));
  const coreDir = join(compiledRoot, 'core');
  mkdirSync(coreDir, { mode: 0o700 });
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  transpileForChild(join(repositoryRoot, 'src/core/errors.ts'), join(coreDir, 'errors.js'));
  transpileForChild(
    join(repositoryRoot, 'src/core/private-temp.ts'),
    join(coreDir, 'private-temp.js')
  );
  writeFileSync(join(compiledRoot, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  compiledModuleUrl = pathToFileURL(join(coreDir, 'private-temp.js')).href;
});

afterEach(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  liveChildren.clear();
  for (const parent of testParents.splice(0)) {
    rmSync(parent, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (compiledRoot) rmSync(compiledRoot, { recursive: true, force: true });
});

function createParent(): string {
  const parent = mkdtempSync(join(tmpdir(), 'cursor-history-private-temp-signal-'));
  if (process.platform !== 'win32') chmodSync(parent, 0o751);
  testParents.push(parent);
  return parent;
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function startChild(parent: string, prefix: string, count: number): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      childScript,
      compiledModuleUrl,
      parent,
      prefix,
      String(count),
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  liveChildren.add(child);
  return child;
}

function startRecoveryChild(parent: string, prefix: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', recoveryChildScript, compiledModuleUrl, parent, prefix],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  );
  liveChildren.add(child);
  return child;
}

function waitForMessage<T>(child: ChildProcess, description: string): Promise<T> {
  return new Promise((resolveReady, rejectReady) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error(`Child ${description} timed out (stderr=${JSON.stringify(stderr)}).`));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener('message', onMessage);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('exit', onEarlyExit);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    const onMessage = (message: unknown) => {
      cleanup();
      resolveReady(message as T);
    };
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectReady(
        new Error(
          `Child exited before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`
        )
      );
    };

    child.on('message', onMessage);
    child.stderr?.on('data', onStderr);
    child.once('exit', onEarlyExit);
  });
}

function waitForReady(child: ChildProcess): Promise<ChildReadyMessage> {
  return waitForMessage<ChildReadyMessage>(child, 'readiness');
}

function waitForExit(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Child signal exit timed out.')), 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      resolveExit({ code, signal });
    });
  });
}

async function verifyCatchableSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): Promise<void> {
  const parent = createParent();
  const parentMode = fileMode(parent);
  const child = startChild(parent, `catchable-${signal.toLowerCase()}-`, 2);
  const ready = await waitForReady(child);

  expect(new Set(ready.paths).size).toBe(2);
  expect(ready.umask).toBe(0);
  for (const path of ready.paths) expect(fileMode(path)).toBe(0o700);
  for (const path of [...ready.files, ...ready.markerPaths]) expect(fileMode(path)).toBe(0o600);
  expect(fileMode(parent)).toBe(parentMode);

  const exit = waitForExit(child);
  expect(child.kill(signal)).toBe(true);
  const result = await exit;

  expect(result).toEqual({ code: null, signal });
  expect(ready.paths.every((path) => !existsSync(path))).toBe(true);
  expect(ready.files.every((path) => !existsSync(path))).toBe(true);
  expect(fileMode(parent)).toBe(parentMode);
}

describe('private workspace cooperative cancellation', () => {
  it('cleans every active child-process workspace on AbortSignal and exits normally', async () => {
    const parent = createParent();
    const child = startChild(parent, 'abort-child-', 2);
    const ready = await waitForReady(child);
    const exit = waitForExit(child);

    expect(child.send?.('abort')).not.toBe(false);
    expect(await exit).toEqual({ code: 0, signal: null });
    expect(ready.paths.every((path) => !existsSync(path))).toBe(true);
    expect(ready.files.every((path) => !existsSync(path))).toBe(true);
  }, 10_000);
});

describe.runIf(process.platform !== 'win32')(
  'platform:posix: private workspace process-signal lifecycle',
  () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      it(`cleans every active workspace and preserves ${signal} termination semantics`, async () => {
        await verifyCatchableSignal(signal);
      }, 10_000);
    }

    it('contains SIGKILL residue privately and the next operation recovers the proven-dead owner', async () => {
      const parent = createParent();
      const prefix = 'sigkill-stale-';
      const child = startChild(parent, prefix, 1);
      const ready = await waitForReady(child);
      const stalePath = ready.paths[0]!;
      const staleFile = ready.files[0]!;
      const markerPath = join(stalePath, PRIVATE_TEMP_MARKER_FILENAME);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as PrivateTempMarker;

      const exit = waitForExit(child);
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await exit).toEqual({ code: null, signal: 'SIGKILL' });

      expect(existsSync(stalePath)).toBe(true);
      expect(existsSync(staleFile)).toBe(true);
      expect(fileMode(stalePath)).toBe(0o700);
      expect(fileMode(staleFile)).toBe(0o600);
      expect(fileMode(markerPath)).toBe(0o600);
      expect(marker).toMatchObject({
        formatVersion: 2,
        pid: child.pid,
        processStartToken: expect.any(String),
        createdAt: expect.any(String),
      });
      if (process.platform === 'linux') {
        expect(marker.pidNamespaceToken).toMatch(
          /^linux-pidns:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d*$/u
        );
      } else {
        expect(marker.pidNamespaceToken).toBeUndefined();
      }

      const nextOperation = createPrivateTempWorkspace({ prefix, parent });
      try {
        expect(existsSync(stalePath)).toBe(false);
        expect(nextOperation.path).not.toBe(stalePath);
      } finally {
        nextOperation.dispose();
      }
      expect(existsSync(nextOperation.path)).toBe(false);
    }, 10_000);

    it.runIf(process.platform === 'linux')(
      'a second process retains a live first-process workspace carrying foreign PID-namespace identity',
      async () => {
        const parent = createParent();
        const prefix = 'foreign-pidns-two-process-';
        const owner = startChild(parent, prefix, 1);
        const ready = await waitForReady(owner);
        const ownerPath = ready.paths[0]!;
        const ownerFile = ready.files[0]!;
        const markerPath = ready.markerPaths[0]!;
        const originalMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as PrivateTempMarker;
        const injectedMarker: PrivateTempMarker = {
          ...originalMarker,
          // Simulate how the owner's numeric PID and start token are interpreted from a different
          // PID namespace: the local pair appears reused even though the real owner remains live.
          pid: process.pid,
          processStartToken: 'foreign-namespace-start-token',
          pidNamespaceToken: 'linux-pidns:00000000-0000-4000-8000-000000000000:999999999999999999',
        };
        writeFileSync(markerPath, `${JSON.stringify(injectedMarker)}\n`, { mode: 0o600 });

        try {
          const recovery = startRecoveryChild(parent, prefix);
          const recoveryExit = waitForExit(recovery);
          const result = await waitForMessage<RecoveryChildMessage>(recovery, 'recovery result');

          expect(await recoveryExit).toEqual({ code: 0, signal: null });
          expect(result.recoveredPaths).toEqual([]);
          expect(result.retained).toEqual([{ path: ownerPath, reason: 'owner-status-uncertain' }]);
          expect(owner.exitCode).toBeNull();
          expect(existsSync(ownerPath)).toBe(true);
          expect(existsSync(ownerFile)).toBe(true);
          expect(readFileSync(ownerFile, 'utf8')).toBe('');
        } finally {
          if (owner.exitCode === null && owner.signalCode === null) {
            const ownerExit = waitForExit(owner);
            expect(owner.send?.('abort')).not.toBe(false);
            expect(await ownerExit).toEqual({ code: 0, signal: null });
          }
        }

        expect(existsSync(ownerPath)).toBe(false);
      },
      10_000
    );
  }
);

describe.runIf(process.platform === 'win32')('platform:windows: private workspace behavior', () => {
  it('uses the system user temp tree with unique exclusive paths and cleanup', () => {
    const first = createPrivateTempWorkspace({ prefix: 'cursor-history-windows-private-' });
    const second = createPrivateTempWorkspace({ prefix: 'cursor-history-windows-private-' });
    try {
      first.createFile('first.db');
      second.createFile('second.db');
      const systemTemp = realpathSync(tmpdir());
      expect(relative(systemTemp, first.path)).not.toMatch(/^\.\./u);
      expect(relative(systemTemp, second.path)).not.toMatch(/^\.\./u);
      expect(first.path).not.toBe(second.path);
      // Deliberately no cross-user ACL-isolation assertion: this path uses inherited Windows ACLs.
    } finally {
      first.dispose();
      second.dispose();
    }
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });
});
