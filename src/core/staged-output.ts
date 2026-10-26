/** Private streaming outputs, published only after the whole export succeeds. */
import {
  closeSync,
  copyFileSync,
  constants,
  createWriteStream,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  type BigIntStats,
  type WriteStream,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

interface OutputEntry {
  target: string;
  directory: string;
  stage: string;
  stream: WriteStream;
  completion: Promise<void>;
  identity: BigIntStats;
  backup?: string;
  published: boolean;
  retain: boolean;
}

function statIfPresent(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Stream a fixed set of files and commit complete files with rollback on ordinary errors.
 * Call dispose() in finally. Multiple files are not crash-atomic as a group.
 */
export class StagedOutputs {
  private readonly entries = new Map<string, OutputEntry>();
  private closed = false;

  private constructor(private readonly force: boolean) {}

  /** Prepare private sibling files; all targets must be distinct regular-file paths. */
  static async create(targets: readonly string[], force = false): Promise<StagedOutputs> {
    const outputs = new StagedOutputs(force);
    try {
      outputs.prepare(targets);
      return outputs;
    } catch (error) {
      await outputs.dispose();
      throw error;
    }
  }

  private prepare(targets: readonly string[]): void {
    const canonical = new Set<string>();
    for (const path of targets) {
      const target = resolve(path);
      const existing = statIfPresent(target);
      if (existing && !existing.isFile()) {
        throw new Error(`Output must be a regular file, not a directory or symlink: ${target}`);
      }
      if (existing && !this.force)
        throw new Error(`Output already exists: ${target}. Use --force to replace it.`);
      mkdirSync(dirname(target), { recursive: true });
      const key = join(realpathSync(dirname(target)), basename(target));
      const canonicalKey = process.platform === 'win32' ? key.toLowerCase() : key;
      if (canonical.has(canonicalKey))
        throw new Error('Output paths must refer to distinct files.');
      canonical.add(canonicalKey);
    }
    for (const path of targets) {
      const target = resolve(path);
      const directory = mkdtempSync(join(dirname(target), '.cursor-history-export-'));
      const stage = join(directory, 'data');
      let fd: number | undefined;
      try {
        fd = openSync(stage, 'wx', 0o600);
        const identity = fstatSync(fd, { bigint: true });
        const stream = createWriteStream(stage, { fd, autoClose: true });
        const completion = finished(stream);
        void completion.catch(() => {}); // Propagate at write/commit/dispose, never unhandled.
        this.entries.set(target, {
          target,
          directory,
          stage,
          stream,
          completion,
          identity,
          published: false,
          retain: false,
        });
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    }
  }

  /** Append UTF-8 text with backpressure; only configured target paths may be written. */
  async write(path: string, text: string): Promise<void> {
    if (this.closed) throw new Error('Output staging is already closed.');
    const entry = this.entries.get(resolve(path));
    if (!entry) throw new Error(`Unconfigured output: ${path}`);
    if (entry.stream.errored) throw entry.stream.errored;
    if (!entry.stream.write(text, 'utf8')) await once(entry.stream, 'drain');
  }

  /** Finish every file, then publish. Restore earlier targets if any publication fails. */
  async commit(): Promise<void> {
    if (this.closed) throw new Error('Output staging is already closed.');
    this.closed = true;
    for (const entry of this.entries.values()) entry.stream.end();
    await Promise.all([...this.entries.values()].map((entry) => entry.completion));
    try {
      // Prepare rollback copies before replacing any output.
      for (const entry of this.entries.values()) {
        const current = statIfPresent(entry.target);
        if (current && !current.isFile())
          throw new Error(`Output is no longer a regular file: ${entry.target}`);
        if (current && !this.force)
          throw new Error(`Output already exists: ${entry.target}. Use --force to replace it.`);
        if (current) {
          entry.backup = join(entry.directory, 'previous');
          copyFileSync(entry.target, entry.backup, constants.COPYFILE_EXCL);
        }
      }
      for (const entry of this.entries.values()) {
        const current = statIfPresent(entry.target);
        if (
          current &&
          [...this.entries.values()].some(
            (other) =>
              other.published &&
              current.dev === other.identity.dev &&
              current.ino === other.identity.ino
          )
        ) {
          throw new Error('Output paths refer to the same published file.');
        }
        if (this.force) renameSync(entry.stage, entry.target);
        else linkSync(entry.stage, entry.target); // Atomic no-clobber publication.
        entry.published = true;
      }
    } catch (error) {
      const recovery: string[] = [];
      for (const entry of [...this.entries.values()].reverse()) {
        if (!entry.published) continue;
        try {
          const current = statIfPresent(entry.target);
          if (
            !current ||
            current.dev !== entry.identity.dev ||
            current.ino !== entry.identity.ino
          ) {
            throw new Error('Output changed after publication.');
          }
          if (entry.backup) renameSync(entry.backup, entry.target);
          else unlinkSync(entry.target);
          entry.published = false;
        } catch {
          entry.retain = true;
          recovery.push(entry.directory);
        }
      }
      if (recovery.length) {
        throw new Error(
          `Export publication failed and rollback was incomplete. Recovery files retained in: ${recovery.join(', ')}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  /** Close and remove private stages, retaining any explicitly reported recovery files. */
  async dispose(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) entry.stream.destroy();
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.completion));
    for (const entry of this.entries.values()) {
      if (!entry.retain) rmSync(entry.directory, { recursive: true, force: true });
    }
  }
}
