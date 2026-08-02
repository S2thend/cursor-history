/**
 * Streaming I/O helpers for the backup / restore pipeline.
 *
 * Cursor's `globalStorage/state.vscdb` routinely grows to several GB. Node.js
 * refuses to `fs.readFile()` / `fs.readFileSync()` anything larger than 2 GiB
 * and throws `ERR_FS_FILE_TOO_LARGE` ("File size (...) is greater than 2 GiB").
 * Every place that used to slurp a whole database into a Buffer therefore has
 * to work with streams instead, which also keeps memory usage flat.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/** Hard limit of `fs.readFile()` / `fs.readFileSync()` (2 GiB - 1 bytes). */
export const MAX_READ_FILE_BYTES = 2 ** 31 - 1;

/**
 * Largest zip member that can be read back.
 *
 * jszip parses 32 bit header fields with `(result << 8) + byte`, a signed
 * operation, so any member of 2 GiB or more is read as a negative size and
 * fails with "Bug : uncompressed data size mismatch". Databases are therefore
 * gzipped before being stored (see `createGzipFileStream`), which keeps members
 * far below this limit.
 */
export const MAX_ZIP_ENTRY_BYTES = 2 ** 31 - 1;

/** Progress metadata emitted by jszip while an archive is generated. */
export interface ZipUpdateMetadata {
  percent: number;
  currentFile: string | null;
}

/** Minimal structural view of a JSZip instance (keeps this module test friendly). */
export interface ZipGeneratorLike {
  generateNodeStream(
    options?: {
      type?: 'nodebuffer';
      streamFiles?: boolean;
      compression?: 'STORE' | 'DEFLATE';
      compressionOptions?: { level: number };
    },
    onUpdate?: (metadata: ZipUpdateMetadata) => void
  ): NodeJS.ReadableStream;
}

/** Minimal structural view of a JSZip entry. */
export interface ZipEntryLike {
  nodeStream(type?: 'nodebuffer'): NodeJS.ReadableStream;
}

export interface WriteZipOptions {
  /** Compression method, defaults to DEFLATE (a stored 3 GB database stays 3 GB). */
  compression?: 'STORE' | 'DEFLATE';
  /** DEFLATE level 1-9, defaults to 6. */
  compressionLevel?: number;
  /** Called repeatedly while the archive is written. */
  onUpdate?: (metadata: ZipUpdateMetadata) => void;
}

function isFileTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ERR_FS_FILE_TOO_LARGE'
  );
}

async function hashStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256');

  // pipeline() instead of `for await`: jszip entry streams are readable-stream
  // v2 objects and are not async iterable
  await pipeline(
    stream,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    })
  );

  return `sha256:${hash.digest('hex')}`;
}

/**
 * SHA-256 of a file, computed chunk by chunk.
 * Works for files of any size and never allocates more than one chunk.
 */
export async function computeFileChecksum(filePath: string): Promise<string> {
  return hashStream(createReadStream(filePath));
}

/**
 * SHA-256 of a zip entry, computed while the entry is being inflated.
 * With `gunzip` the hash is taken from the decompressed payload, i.e. it can be
 * compared against the checksum of the original file.
 */
export async function computeZipEntryChecksum(
  entry: ZipEntryLike,
  options: { gunzip?: boolean } = {}
): Promise<string> {
  const source = entry.nodeStream('nodebuffer');
  if (!options.gunzip) {
    return hashStream(source);
  }

  const gunzip = createGunzip();
  source.on('error', (error: Error) => gunzip.destroy(error));
  return hashStream(source.pipe(gunzip));
}

/** Extract a zip entry directly to disk without buffering it in memory. */
export async function extractZipEntryToFile(
  entry: ZipEntryLike,
  destPath: string,
  options: { gunzip?: boolean } = {}
): Promise<void> {
  const source = entry.nodeStream('nodebuffer');
  const stages: NodeJS.ReadableStream[] = [source];

  if (options.gunzip) {
    const gunzip = createGunzip();
    source.on('error', (error: Error) => gunzip.destroy(error));
    stages.push(source.pipe(gunzip));
  }

  await pipeline(stages[stages.length - 1]!, createWriteStream(destPath));
}

/**
 * Read a file as a gzip compressed stream.
 *
 * Storing databases gzipped keeps every zip member well under the 2 GiB the zip
 * reader can handle, and gzip (native zlib) is both faster and stronger than
 * jszip's JavaScript deflate.
 */
export function createGzipFileStream(filePath: string, level = 6): NodeJS.ReadableStream {
  const source = createReadStream(filePath);
  const gzip = createGzip({ level });
  // .pipe() does not forward errors, do it manually so jszip sees the failure
  source.on('error', (error: Error) => gzip.destroy(error));
  return source.pipe(gzip);
}

/** Counts the bytes flowing through it, used to measure stored zip members. */
export interface ByteCounter extends Transform {
  readonly bytes: number;
}

export function createByteCounter(): ByteCounter {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  Object.defineProperty(counter, 'bytes', { get: () => bytes });
  return counter as ByteCounter;
}

/**
 * Write a zip archive straight to disk.
 *
 * `generateAsync({ type: 'nodebuffer' })` materialises the whole archive in a
 * single Buffer, which is impossible for multi-GB backups. `generateNodeStream`
 * streams it out instead; `streamFiles: true` is required because entries added
 * as streams have an unknown size/CRC upfront (jszip then uses data descriptors
 * rather than buffering each entry to measure it).
 */
export async function writeZipToFile(
  zip: ZipGeneratorLike,
  outputPath: string,
  options: WriteZipOptions = {}
): Promise<void> {
  const stream = zip.generateNodeStream(
    {
      type: 'nodebuffer',
      streamFiles: true,
      compression: options.compression ?? 'DEFLATE',
      compressionOptions: { level: options.compressionLevel ?? 6 },
    },
    options.onUpdate
  );

  await pipeline(stream, createWriteStream(outputPath));
}

/**
 * Read a whole file into memory, transparently falling back to a streamed read
 * when the file exceeds the 2 GiB `fs.readFile()` limit.
 *
 * Used for zip archives only: jszip can merely parse in-memory archives, so the
 * container itself still has to fit in a Buffer (entries inside are streamed).
 */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (!isFileTooLargeError(error)) {
      throw error;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(filePath)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  }
}
