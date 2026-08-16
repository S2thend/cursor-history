import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_CLI_PATH = join(REPOSITORY_ROOT, 'dist', 'cli', 'index.js');

export interface BuiltCliRunOptions {
  /** Built CLI module. Defaults to dist/cli/index.js in this checkout. */
  cliPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Uint8Array | string;
  /** Kill the process after this duration. Omit for no helper timeout. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and the SIGKILL fallback. */
  killGraceMs?: number;
  /** Keep the automatically-created temporary root for post-run inspection. */
  retainTempRoot?: boolean;
  /** Use an existing test-owned temporary root instead of creating one. */
  tempRoot?: string;
}

export interface BuiltCliRunResult {
  readonly stdoutBytes: Buffer;
  readonly stderrBytes: Buffer;
  /** Convenience views only; byte-exact assertions should use the buffers above. */
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly tempRoot: string;
  readonly tempRootRetained: boolean;
  /** Idempotently remove a helper-created retained temporary root. */
  cleanup(): void;
}

function assertPositiveTimeout(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

/**
 * Execute the built CLI as a real Node subprocess and retain exact stream bytes.
 * Nonzero exits and signals are results, not thrown exceptions.
 */
export async function runBuiltCli(
  args: readonly string[],
  options: BuiltCliRunOptions = {}
): Promise<BuiltCliRunResult> {
  assertPositiveTimeout('timeoutMs', options.timeoutMs);
  assertPositiveTimeout('killGraceMs', options.killGraceMs);

  const cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
  if (!existsSync(cliPath)) {
    throw new Error(`Built CLI not found: ${cliPath}. Run the build before this test.`);
  }

  const ownsTempRoot = options.tempRoot === undefined;
  const tempRoot = options.tempRoot ?? mkdtempSync(join(tmpdir(), 'cursor-history-cli-test-'));
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned || !ownsTempRoot) return;
    cleaned = true;
    rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    const captureRoot = mkdtempSync(join(tempRoot, '.cli-capture-'));
    const stdoutPath = join(captureRoot, 'stdout.bin');
    const stderrPath = join(captureRoot, 'stderr.bin');
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    let result: Omit<BuiltCliRunResult, 'tempRoot' | 'tempRootRetained' | 'cleanup'> | undefined;
    try {
      // File descriptors preserve byte-exact output and avoid text decoding or
      // platform stream buffering differences in subprocess test runners.
      stdoutFd = openSync(stdoutPath, 'w', 0o600);
      stderrFd = openSync(stderrPath, 'w', 0o600);
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: options.cwd ?? REPOSITORY_ROOT,
        env: {
          ...process.env,
          ...options.env,
          // The child resolves its own os.tmpdir(), so all temporary surfaces
          // remain inside the test-owned root on every supported platform.
          TMPDIR: tempRoot,
          TMP: tempRoot,
          TEMP: tempRoot,
        },
        stdio: ['pipe', stdoutFd, stderrFd],
      });

      let timedOut = false;
      const exit = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (status, signal) => resolve({ status, signal }));
        }
      );

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          hardKill = setTimeout(() => child.kill('SIGKILL'), options.killGraceMs ?? 1_000);
          hardKill.unref();
        }, options.timeoutMs);
        timeout.unref();
      }

      if (options.stdin === undefined) child.stdin.end();
      else child.stdin.end(options.stdin);

      const { status, signal } = await exit;
      closeSync(stdoutFd);
      stdoutFd = undefined;
      closeSync(stderrFd);
      stderrFd = undefined;
      const stdoutBytes = readFileSync(stdoutPath);
      const stderrBytes = readFileSync(stderrPath);
      result = {
        stdoutBytes,
        stderrBytes,
        stdout: stdoutBytes.toString('utf8'),
        stderr: stderrBytes.toString('utf8'),
        status,
        signal,
        timedOut,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      rmSync(captureRoot, { recursive: true, force: true });
    }

    if (!result) throw new Error('CLI subprocess completed without a result.');

    const tempRootRetained = ownsTempRoot && options.retainTempRoot === true;
    if (!tempRootRetained) cleanup();
    return Object.freeze({
      ...result,
      tempRoot,
      tempRootRetained,
      cleanup,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Retain a CLI temporary root during a callback and guarantee cleanup afterward.
 */
export async function withBuiltCliTempRoot<T>(
  callback: (tempRoot: string) => Promise<T> | T
): Promise<T> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cursor-history-cli-test-'));
  try {
    return await callback(tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
