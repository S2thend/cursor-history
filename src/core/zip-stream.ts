/**
 * Narrow, bounded ZIP reader for cursor-history backup archives.
 *
 * Only the formats produced by cursor-history are accepted: one-disk ZIP32/ZIP64 archives whose
 * file entries use STORE or raw DEFLATE. Central metadata is read through small random-access
 * ranges, and entry bodies are streamed through size, ratio, and CRC verification.
 */

import { createHash } from 'node:crypto';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

import { SourceLimitExceededError } from './errors.js';
import {
  resolveSourceReadLimits,
  sourceLimitDimension,
  type SourceReadLimitField,
} from './source-read-limits.js';
import type { SourceReadLimitsOverride, SourceReadLimitsV1, ZipSourceBoundKind } from './types.js';
import {
  observeAdapterIo,
  type AdapterIoEventInput,
  type OperationIoContext,
} from './io-observer.js';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const MAX_EOCD_SEARCH_BYTES = 65_557;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const STRONG_ENCRYPTION_FLAG = 0x0040;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const MANIFEST_MEMORY_LIMIT = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

function zipEntryIoIdentity(
  name: string
): Pick<AdapterIoEventInput, 'resourceClass' | 'sourceRole' | 'representation'> {
  if (name === 'manifest.json') return { resourceClass: 'backup-manifest' };
  if (/^workspaceStorage\/[^/]+\/workspace\.json$/u.test(name)) {
    return {
      resourceClass: 'workspace-membership-json',
      sourceRole: 'composer',
      representation: 'composer-workspace',
    };
  }
  if (name === 'globalStorage/state.vscdb') {
    return {
      resourceClass: 'backup-entry',
      sourceRole: 'composer',
      representation: 'composer-global',
    };
  }
  return {
    resourceClass: 'backup-entry',
    sourceRole: 'composer',
    representation: 'composer-workspace',
  };
}

const ZIP_LIMIT_FIELDS: Readonly<Record<ZipSourceBoundKind, SourceReadLimitField>> = {
  'zip-compressed-bytes': 'zipCompressedBytes',
  'zip-entry-count': 'zipEntryCount',
  'zip-entry-bytes': 'zipEntryBytes',
  'zip-aggregate-bytes': 'zipAggregateBytes',
  'zip-compression-ratio': 'zipCompressionRatio',
};

export class ZipArchiveFormatError extends Error {
  override readonly name = 'ZipArchiveFormatError';
}

export interface ZipEntryMetadata {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly compressionMethod: 0 | 8;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  /** Whether the central record selected ZIP64 widths for either payload size. */
  readonly usesZip64Sizes: boolean;
}

export interface BoundedZipArchiveOptions {
  readonly sourceReadLimits?: SourceReadLimitsOverride;
  readonly signal?: AbortSignal;
  /** Internal operation-bound low-level observer. */
  readonly io?: OperationIoContext;
}

/** One private filesystem input prepared for streamed ZIP creation. */
export interface ZipFileInput {
  readonly name: string;
  readonly sourcePath: string;
}

/** Immutable size, checksum, and CRC metadata computed without retaining the file body. */
export interface PreparedZipFileInput extends ZipFileInput {
  readonly size: number;
  readonly crc32: number;
  readonly checksum: string;
}

/** Small in-memory metadata entry, such as the completed backup manifest. */
export interface ZipBufferInput {
  readonly name: string;
  readonly data: Uint8Array;
}

export type BoundedZipWriteInput = PreparedZipFileInput | ZipBufferInput;

export interface BoundedZipWriteResult {
  readonly archiveSize: number;
  readonly entryCount: number;
}

interface CentralDirectoryLocation {
  readonly entryCount: bigint;
  readonly offset: number;
  readonly size: number;
  readonly endBoundary: number;
}

interface Zip64Values {
  readonly uncompressedSize?: bigint;
  readonly compressedSize?: bigint;
  readonly localHeaderOffset?: bigint;
  readonly diskStart?: bigint;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error('The ZIP operation was aborted.', {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function formatError(message: string): ZipArchiveFormatError {
  return new ZipArchiveFormatError(message);
}

function limitObservation(value: bigint, limit: number): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? limit + 1 : Number(value);
}

function throwZipLimit(
  bound: ZipSourceBoundKind,
  observedAtLeast: number,
  limits: Readonly<SourceReadLimitsV1>
): never {
  const dimension = sourceLimitDimension(bound);
  if (dimension.sourceKind !== 'zip') throw new Error('Invalid ZIP limit dimension.');
  throw new SourceLimitExceededError({
    ...dimension,
    limit: limits[ZIP_LIMIT_FIELDS[bound]],
    observedAtLeast,
    outcome: 'fatal',
  });
}

function enforceIntegerLimit(
  bound: Exclude<ZipSourceBoundKind, 'zip-compression-ratio'>,
  observed: bigint,
  limits: Readonly<SourceReadLimitsV1>
): void {
  const limit = limits[ZIP_LIMIT_FIELDS[bound]];
  if (observed > BigInt(limit)) throwZipLimit(bound, limitObservation(observed, limit), limits);
}

function enforceRatioLimit(
  uncompressed: bigint,
  compressed: bigint,
  limits: Readonly<SourceReadLimitsV1>
): void {
  if (uncompressed === 0n) return;
  if (compressed === 0n) {
    // A nonempty representation divided by zero has an infinite ratio. Report
    // it through the same typed source-limit contract as every finite ratio
    // exceedance, before any entry is selected or extracted.
    throwZipLimit('zip-compression-ratio', limits.zipCompressionRatio + 1, limits);
  }
  const limit = limits.zipCompressionRatio;
  const denominator = compressed;
  const threshold = denominator * BigInt(limit);
  if (uncompressed > threshold) {
    const firstFailingNumerator = threshold + 1n;
    const observed =
      firstFailingNumerator <= BigInt(Number.MAX_SAFE_INTEGER) &&
      denominator <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(firstFailingNumerator) / Number(denominator)
        : limit + 1;
    throwZipLimit('zip-compression-ratio', observed, limits);
  }
}

function toSafeOffset(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw formatError(`${label} is outside the supported safe integer range.`);
  }
  return Number(value);
}

async function readExact(
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal
): Promise<Buffer> {
  throwIfAborted(signal);
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw formatError('ZIP range is invalid.');
  }
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw formatError('ZIP range ends unexpectedly.');
    offset += bytesRead;
  }
  return buffer;
}

function readHandleRange(
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal
): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    let cursor = position;
    let remaining = length;
    while (remaining > 0) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
      if (bytesRead === 0) throw formatError('ZIP entry data ends unexpectedly.');
      cursor += bytesRead;
      remaining -= bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  }

  return Readable.from(chunks(), { objectMode: false });
}

function writeToHandle(handle: FileHandle): Writable {
  let position = 0;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const writeAll = async (): Promise<void> => {
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
            position
          );
          if (bytesWritten === 0) throw new Error('Temporary ZIP output accepted zero bytes.');
          offset += bytesWritten;
          position += bytesWritten;
        }
      };
      void writeAll().then(() => callback(), callback);
    },
  });
}

function findEocdOffset(tail: Buffer): number {
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) return offset;
  }
  throw formatError('ZIP end-of-central-directory record was not found.');
}

function findZip64ExtraData(extra: Buffer): Buffer | undefined {
  let offset = 0;
  let result: Buffer | undefined;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw formatError('ZIP extra field header is truncated.');
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;
    if (dataEnd > extra.length) throw formatError('ZIP extra field is truncated.');
    if (id === ZIP64_EXTRA_FIELD_ID) {
      if (result) throw formatError('ZIP contains duplicate ZIP64 extra fields.');
      result = extra.subarray(dataStart, dataEnd);
    }
    offset = dataEnd;
  }
  return result;
}

function parseZip64Values(
  data: Buffer,
  needs: {
    uncompressedSize: boolean;
    compressedSize: boolean;
    localHeaderOffset: boolean;
    diskStart: boolean;
  }
): Zip64Values {
  let cursor = 0;
  const result: {
    uncompressedSize?: bigint;
    compressedSize?: bigint;
    localHeaderOffset?: bigint;
    diskStart?: bigint;
  } = {};
  const take64 = (label: string): bigint => {
    if (cursor + 8 > data.length) throw formatError(`ZIP64 ${label} is truncated.`);
    const value = data.readBigUInt64LE(cursor);
    cursor += 8;
    return value;
  };
  if (needs.uncompressedSize) result.uncompressedSize = take64('uncompressed size');
  if (needs.compressedSize) result.compressedSize = take64('compressed size');
  if (needs.localHeaderOffset) result.localHeaderOffset = take64('local header offset');
  if (needs.diskStart) {
    if (cursor + 4 > data.length) throw formatError('ZIP64 disk start is truncated.');
    result.diskStart = BigInt(data.readUInt32LE(cursor));
    cursor += 4;
  }
  if (cursor !== data.length) {
    throw formatError('ZIP64 extra field contains surplus values.');
  }
  return result;
}

function parseZip64Extra(
  extra: Buffer,
  needs: {
    uncompressedSize: boolean;
    compressedSize: boolean;
    localHeaderOffset: boolean;
    diskStart: boolean;
  }
): Zip64Values {
  const data = findZip64ExtraData(extra);
  if (!data) throw formatError('Required ZIP64 extra field is missing.');
  return parseZip64Values(data, needs);
}

function parseDescriptorZip64Sizes(
  extra: Buffer,
  needs: { uncompressedSize: boolean; compressedSize: boolean }
): Zip64Values {
  const data = findZip64ExtraData(extra);
  if (!data) {
    if (needs.uncompressedSize || needs.compressedSize) {
      throw formatError('Required ZIP64 extra field is missing.');
    }
    return {};
  }

  // A descriptor permits zero placeholders in the 32-bit local header. If a producer still emits
  // a ZIP64 local size field, it is authoritative local metadata and must not be ignored. With no
  // sentinels, the local ZIP64 field has the canonical uncompressed/compressed pair.
  const parseNeeds =
    needs.uncompressedSize || needs.compressedSize
      ? { ...needs, localHeaderOffset: false, diskStart: false }
      : {
          uncompressedSize: true,
          compressedSize: true,
          localHeaderOffset: false,
          diskStart: false,
        };
  return parseZip64Values(data, parseNeeds);
}

function decodeEntryName(bytes: Buffer, flags: number): string {
  if ((flags & UTF8_FLAG) === 0 && bytes.some((value) => value > 0x7f)) {
    throw formatError('Non-ASCII ZIP names must declare UTF-8 encoding.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw formatError('ZIP entry name is not valid UTF-8.');
  }
}

function hasUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function normalizeEntryName(rawName: string): {
  name: string;
  isDirectory: boolean;
  portableKey: string;
} {
  if (rawName.length === 0 || rawName.includes('\0') || rawName.includes('\\')) {
    throw formatError('ZIP entry name is empty or contains an unsafe separator.');
  }
  const normalizedUnicode = rawName.normalize('NFC');
  if (normalizedUnicode.startsWith('/') || /^[A-Za-z]:/u.test(normalizedUnicode)) {
    throw formatError('ZIP entry name must be relative.');
  }
  const isDirectory = normalizedUnicode.endsWith('/');
  const pathPart = isDirectory ? normalizedUnicode.slice(0, -1) : normalizedUnicode;
  const segments = pathPart.split('/');
  if (
    pathPart.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        hasUnsafeControlCharacters(segment) ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
    )
  ) {
    throw formatError('ZIP entry name contains a traversal, ambiguous, or unsafe path component.');
  }
  const portableKey = segments.map((segment) => segment.toLowerCase()).join('/');
  return {
    name: `${segments.join('/')}${isDirectory ? '/' : ''}`,
    isDirectory,
    portableKey,
  };
}

async function locateCentralDirectory(
  handle: FileHandle,
  archiveSize: number,
  signal?: AbortSignal
): Promise<CentralDirectoryLocation> {
  const tailLength = Math.min(archiveSize, MAX_EOCD_SEARCH_BYTES);
  if (tailLength < 22) throw formatError('ZIP file is too short.');
  const tailOffset = archiveSize - tailLength;
  const tail = await readExact(handle, tailOffset, tailLength, signal);
  const relativeEocdOffset = findEocdOffset(tail);
  const eocdOffset = tailOffset + relativeEocdOffset;

  const diskNumber = tail.readUInt16LE(relativeEocdOffset + 4);
  const centralDisk = tail.readUInt16LE(relativeEocdOffset + 6);
  const entriesOnDisk = tail.readUInt16LE(relativeEocdOffset + 8);
  const entryCount32 = tail.readUInt16LE(relativeEocdOffset + 10);
  const centralSize32 = tail.readUInt32LE(relativeEocdOffset + 12);
  const centralOffset32 = tail.readUInt32LE(relativeEocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    (entriesOnDisk !== 0xffff && entryCount32 !== 0xffff && entriesOnDisk !== entryCount32)
  ) {
    throw formatError('Multi-disk ZIP archives are not supported.');
  }

  const requiresZip64 =
    entriesOnDisk === 0xffff ||
    entryCount32 === 0xffff ||
    centralSize32 === 0xffffffff ||
    centralOffset32 === 0xffffffff;
  if (!requiresZip64) {
    return {
      entryCount: BigInt(entryCount32),
      offset: centralOffset32,
      size: centralSize32,
      endBoundary: eocdOffset,
    };
  }

  if (eocdOffset < 20) throw formatError('ZIP64 locator is missing.');
  const locator = await readExact(handle, eocdOffset - 20, 20, signal);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    throw formatError('ZIP64 locator signature is missing.');
  }
  if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
    throw formatError('Multi-disk ZIP64 archives are not supported.');
  }
  const zip64Offset = toSafeOffset(locator.readBigUInt64LE(8), 'ZIP64 record offset');
  const fixed = await readExact(handle, zip64Offset, 56, signal);
  if (fixed.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw formatError('ZIP64 end-of-central-directory signature is missing.');
  }
  const recordSize = fixed.readBigUInt64LE(4);
  if (recordSize < 44n) throw formatError('ZIP64 end-of-central-directory record is truncated.');
  const zip64End = BigInt(zip64Offset) + 12n + recordSize;
  if (zip64End !== BigInt(eocdOffset - 20)) {
    throw formatError('ZIP64 record does not end at its locator.');
  }
  if (fixed.readUInt32LE(16) !== 0 || fixed.readUInt32LE(20) !== 0) {
    throw formatError('Multi-disk ZIP64 archives are not supported.');
  }
  const entriesOnZip64Disk = fixed.readBigUInt64LE(24);
  const entryCount64 = fixed.readBigUInt64LE(32);
  if (entriesOnZip64Disk !== entryCount64) {
    throw formatError('ZIP64 entry counts disagree across disks.');
  }
  const centralSize64 = fixed.readBigUInt64LE(40);
  const centralOffset64 = fixed.readBigUInt64LE(48);
  const legacyMatches =
    (entriesOnDisk === 0xffff || BigInt(entriesOnDisk) === entriesOnZip64Disk) &&
    (entryCount32 === 0xffff || BigInt(entryCount32) === entryCount64) &&
    (centralSize32 === 0xffffffff || BigInt(centralSize32) === centralSize64) &&
    (centralOffset32 === 0xffffffff || BigInt(centralOffset32) === centralOffset64);
  if (!legacyMatches) {
    throw formatError('ZIP32 legacy metadata disagrees with the ZIP64 end record.');
  }
  return {
    entryCount: entryCount64,
    size: toSafeOffset(centralSize64, 'ZIP64 central-directory size'),
    offset: toSafeOffset(centralOffset64, 'ZIP64 central-directory offset'),
    endBoundary: zip64Offset,
  };
}

async function parseCentralDirectory(
  handle: FileHandle,
  archiveSize: number,
  location: CentralDirectoryLocation,
  limits: Readonly<SourceReadLimitsV1>,
  signal?: AbortSignal
): Promise<ZipEntryMetadata[]> {
  enforceIntegerLimit('zip-entry-count', location.entryCount, limits);
  const entryCount = toSafeOffset(location.entryCount, 'ZIP entry count');
  const centralEnd = location.offset + location.size;
  if (
    !Number.isSafeInteger(centralEnd) ||
    location.offset < 0 ||
    location.size < 0 ||
    centralEnd > archiveSize ||
    centralEnd !== location.endBoundary
  ) {
    throw formatError('ZIP central-directory range is outside or inconsistent with the archive.');
  }

  const entries: ZipEntryMetadata[] = [];
  const portableNames = new Map<string, boolean>();
  let cursor = location.offset;
  let aggregateCompressed = 0n;
  let aggregateUncompressed = 0n;

  for (let index = 0; index < entryCount; index++) {
    throwIfAborted(signal);
    if (cursor + 46 > centralEnd) {
      throw formatError('ZIP central directory ends before its declared entry count.');
    }
    const fixed = await readExact(handle, cursor, 46, signal);
    if (fixed.readUInt32LE(0) !== CENTRAL_FILE_SIGNATURE) {
      throw formatError(`ZIP central entry ${index + 1} has an invalid signature.`);
    }
    const flags = fixed.readUInt16LE(8);
    if ((flags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0) {
      throw formatError('Encrypted ZIP entries are not supported.');
    }
    const compressionMethod = fixed.readUInt16LE(10);
    if (compressionMethod !== STORE_METHOD && compressionMethod !== DEFLATE_METHOD) {
      throw formatError(`ZIP compression method ${compressionMethod} is not supported.`);
    }
    const fileNameLength = fixed.readUInt16LE(28);
    const extraLength = fixed.readUInt16LE(30);
    const commentLength = fixed.readUInt16LE(32);
    const variableLength = fileNameLength + extraLength + commentLength;
    const entryEnd = cursor + 46 + variableLength;
    if (!Number.isSafeInteger(entryEnd) || entryEnd > centralEnd) {
      throw formatError('ZIP central entry extends past the central directory.');
    }
    const variable = await readExact(handle, cursor + 46, variableLength, signal);
    const nameBytes = variable.subarray(0, fileNameLength);
    const extra = variable.subarray(fileNameLength, fileNameLength + extraLength);
    const normalized = normalizeEntryName(decodeEntryName(nameBytes, flags));
    if (portableNames.has(normalized.portableKey)) {
      throw formatError(`ZIP contains a duplicate normalized entry: ${normalized.name}`);
    }
    portableNames.set(normalized.portableKey, normalized.isDirectory);

    const size32 = fixed.readUInt32LE(24);
    const compressed32 = fixed.readUInt32LE(20);
    const localOffset32 = fixed.readUInt32LE(42);
    const diskStart32 = fixed.readUInt16LE(34);
    const needs = {
      uncompressedSize: size32 === 0xffffffff,
      compressedSize: compressed32 === 0xffffffff,
      localHeaderOffset: localOffset32 === 0xffffffff,
      diskStart: diskStart32 === 0xffff,
    };
    const zip64 = Object.values(needs).some(Boolean) ? parseZip64Extra(extra, needs) : {};
    const uncompressed = zip64.uncompressedSize ?? BigInt(size32);
    const compressed = zip64.compressedSize ?? BigInt(compressed32);
    const localOffset = zip64.localHeaderOffset ?? BigInt(localOffset32);
    const diskStart = zip64.diskStart ?? BigInt(diskStart32);
    if (diskStart !== 0n) throw formatError('Multi-disk ZIP entries are not supported.');
    if (localOffset >= BigInt(location.offset)) {
      throw formatError('ZIP local header overlaps the central directory.');
    }
    if (compressionMethod === STORE_METHOD && compressed !== uncompressed) {
      throw formatError('Stored ZIP entry has different compressed and uncompressed sizes.');
    }
    if (normalized.isDirectory && (compressed !== 0n || uncompressed !== 0n)) {
      throw formatError('ZIP directory entries must not contain payload bytes.');
    }

    enforceIntegerLimit('zip-entry-bytes', uncompressed, limits);
    aggregateCompressed += compressed;
    aggregateUncompressed += uncompressed;
    enforceIntegerLimit('zip-aggregate-bytes', aggregateUncompressed, limits);
    enforceRatioLimit(uncompressed, compressed, limits);

    entries.push({
      name: normalized.name,
      isDirectory: normalized.isDirectory,
      compressionMethod,
      flags,
      crc32: fixed.readUInt32LE(16),
      compressedSize: toSafeOffset(compressed, 'ZIP compressed entry size'),
      uncompressedSize: toSafeOffset(uncompressed, 'ZIP uncompressed entry size'),
      localHeaderOffset: toSafeOffset(localOffset, 'ZIP local-header offset'),
      usesZip64Sizes: needs.uncompressedSize || needs.compressedSize,
    });
    cursor = entryEnd;
  }

  if (cursor !== centralEnd)
    throw formatError('ZIP central-directory size does not match its entries.');
  if (aggregateCompressed > BigInt(archiveSize)) {
    throw formatError('ZIP compressed entry claims exceed the archive size.');
  }
  const fileKeys = new Set(
    entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => normalizeEntryName(entry.name).portableKey)
  );
  for (const entry of entries) {
    const segments = normalizeEntryName(entry.name).portableKey.split('/');
    for (let index = 1; index < segments.length; index++) {
      if (fileKeys.has(segments.slice(0, index).join('/'))) {
        throw formatError('ZIP file entry conflicts with a descendant path.');
      }
    }
  }
  const localOffsets = new Set<number>();
  for (const entry of entries) {
    if (localOffsets.has(entry.localHeaderOffset)) {
      throw formatError('ZIP entries share one local-file header offset.');
    }
    localOffsets.add(entry.localHeaderOffset);
  }
  enforceRatioLimit(aggregateUncompressed, aggregateCompressed, limits);
  return entries;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(current: number, value: Uint8Array): number {
  let crc = current;
  for (const byte of value) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return crc;
}

function finishCrc32(current: number): number {
  return (current ^ 0xffffffff) >>> 0;
}

function validateDataDescriptor(
  value: Buffer,
  entry: ZipEntryMetadata,
  usesZip64Sizes: boolean
): void {
  const unsignedLength = usesZip64Sizes ? 20 : 12;
  const signedLength = unsignedLength + 4;
  if (value.length !== unsignedLength && value.length !== signedLength) {
    throw formatError('ZIP data descriptor is missing, truncated, or has trailing bytes.');
  }

  const hasSignature = value.length === signedLength;
  if (hasSignature && value.readUInt32LE(0) !== 0x08074b50) {
    throw formatError('ZIP data descriptor signature is invalid.');
  }
  let cursor = hasSignature ? 4 : 0;
  const crc = value.readUInt32LE(cursor);
  cursor += 4;
  const compressed = usesZip64Sizes
    ? toSafeOffset(value.readBigUInt64LE(cursor), 'ZIP64 descriptor compressed size')
    : value.readUInt32LE(cursor);
  cursor += usesZip64Sizes ? 8 : 4;
  const uncompressed = usesZip64Sizes
    ? toSafeOffset(value.readBigUInt64LE(cursor), 'ZIP64 descriptor uncompressed size')
    : value.readUInt32LE(cursor);
  cursor += usesZip64Sizes ? 8 : 4;
  if (cursor !== value.length) throw formatError('ZIP data descriptor length is inconsistent.');
  if (crc !== entry.crc32) throw formatError('ZIP data descriptor CRC32 disagrees with central.');
  if (compressed !== entry.compressedSize) {
    throw formatError('ZIP data descriptor compressed size disagrees with central.');
  }
  if (uncompressed !== entry.uncompressedSize) {
    throw formatError('ZIP data descriptor uncompressed size disagrees with central.');
  }
}

class CompressedVerifier extends Transform {
  private bytes = 0;

  constructor(
    private readonly expected: number,
    private readonly signal?: AbortSignal
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      throwIfAborted(this.signal);
      this.bytes += chunk.length;
      if (this.bytes > this.expected) throw formatError('ZIP compressed data exceeds its claim.');
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      throwIfAborted(this.signal);
      callback(
        this.bytes === this.expected
          ? undefined
          : formatError('ZIP compressed data is shorter than its claim.')
      );
    } catch (error) {
      callback(error as Error);
    }
  }
}

class OutputIntegrityVerifier extends Transform {
  private bytes = 0;
  private crc = 0xffffffff;
  private readonly hash = createHash('sha256');
  private checksumValue?: string;

  constructor(
    private readonly entry: ZipEntryMetadata,
    private readonly limits: Readonly<SourceReadLimitsV1>,
    private readonly onBytes: (count: number) => void,
    private readonly signal?: AbortSignal
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      throwIfAborted(this.signal);
      this.bytes += chunk.length;
      if (this.bytes > this.entry.uncompressedSize) {
        throw formatError('ZIP uncompressed data exceeds its central-directory claim.');
      }
      if (this.bytes > this.limits.zipEntryBytes) {
        throwZipLimit('zip-entry-bytes', this.limits.zipEntryBytes + 1, this.limits);
      }
      const ratioDenominator = Math.max(this.entry.compressedSize, 1);
      const ratioThreshold = BigInt(ratioDenominator) * BigInt(this.limits.zipCompressionRatio);
      if (BigInt(this.bytes) > ratioThreshold) {
        const firstFailingBytes = Number(ratioThreshold + 1n);
        throwZipLimit('zip-compression-ratio', firstFailingBytes / ratioDenominator, this.limits);
      }
      this.onBytes(chunk.length);
      this.hash.update(chunk);
      this.crc = updateCrc32(this.crc, chunk);
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.bytes !== this.entry.uncompressedSize) {
      callback(formatError('ZIP uncompressed size disagrees with the central directory.'));
      return;
    }
    const actualCrc = finishCrc32(this.crc);
    if (actualCrc !== this.entry.crc32) {
      callback(formatError('ZIP entry CRC32 disagrees with the central directory.'));
      return;
    }
    this.checksumValue = `sha256:${this.hash.digest('hex')}`;
    callback();
  }

  checksum(): string {
    if (!this.checksumValue)
      throw new Error('ZIP entry checksum is unavailable before completion.');
    return this.checksumValue;
  }
}

/** Open central metadata once, then stream selected entries without whole-archive materialization. */
export class BoundedZipArchive {
  private closed = false;
  private actualAggregateBytes = 0;
  private readonly byName: ReadonlyMap<string, ZipEntryMetadata>;
  private readonly localEndBoundary: ReadonlyMap<number, number>;

  private constructor(
    readonly path: string,
    readonly entries: readonly ZipEntryMetadata[],
    private readonly archiveSize: number,
    private readonly centralOffset: number,
    private readonly handle: FileHandle,
    private readonly limits: Readonly<SourceReadLimitsV1>,
    private readonly signal?: AbortSignal,
    private readonly io?: OperationIoContext
  ) {
    this.byName = new Map(entries.map((entry) => [entry.name, entry]));
    const offsets = entries.map((entry) => entry.localHeaderOffset).sort((a, b) => a - b);
    this.localEndBoundary = new Map(
      offsets.map((offset, index) => [offset, offsets[index + 1] ?? centralOffset])
    );
  }

  static async open(
    path: string,
    options: BoundedZipArchiveOptions = {}
  ): Promise<BoundedZipArchive> {
    const limits = resolveSourceReadLimits(options.sourceReadLimits);
    throwIfAborted(options.signal);
    if (options.io) {
      observeAdapterIo(options.io, {
        adapter: 'filesystem',
        operation: 'open',
        resourceClass: 'backup-central-directory',
      });
    }
    const handle = await open(path, 'r');
    try {
      if (options.io) {
        observeAdapterIo(options.io, {
          adapter: 'filesystem',
          operation: 'read',
          resourceClass: 'backup-central-directory',
        });
      }
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile()) throw formatError('ZIP source must be a regular file.');
      enforceIntegerLimit('zip-compressed-bytes', metadata.size, limits);
      const archiveSize = toSafeOffset(metadata.size, 'ZIP archive size');
      const central = await locateCentralDirectory(handle, archiveSize, options.signal);
      const entries = await parseCentralDirectory(
        handle,
        archiveSize,
        central,
        limits,
        options.signal
      );
      return new BoundedZipArchive(
        path,
        entries,
        archiveSize,
        central.offset,
        handle,
        limits,
        options.signal,
        options.io
      );
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ZIP archive is closed.');
    throwIfAborted(this.signal);
  }

  getEntry(name: string): ZipEntryMetadata | undefined {
    this.assertOpen();
    const normalized = normalizeEntryName(name);
    return this.byName.get(normalized.name);
  }

  private async dataOffset(entry: ZipEntryMetadata): Promise<number> {
    const fixed = await readExact(this.handle, entry.localHeaderOffset, 30, this.signal);
    if (fixed.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
      throw formatError('ZIP local-file header signature is invalid.');
    }
    const localFlags = fixed.readUInt16LE(6);
    const localMethod = fixed.readUInt16LE(8);
    if ((localFlags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0) {
      throw formatError('Encrypted ZIP entries are not supported.');
    }
    if (localFlags !== entry.flags) {
      throw formatError('ZIP local and central flags disagree.');
    }
    if (localMethod !== entry.compressionMethod) {
      throw formatError('ZIP local and central compression methods disagree.');
    }
    const fileNameLength = fixed.readUInt16LE(26);
    const extraLength = fixed.readUInt16LE(28);
    const localVariableEnd = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
    if (!Number.isSafeInteger(localVariableEnd) || localVariableEnd > this.centralOffset) {
      throw formatError('ZIP local-file header extends into the central directory.');
    }
    const localVariable = await readExact(
      this.handle,
      entry.localHeaderOffset + 30,
      fileNameLength + extraLength,
      this.signal
    );
    const localName = localVariable.subarray(0, fileNameLength);
    const localExtra = localVariable.subarray(fileNameLength);
    if (normalizeEntryName(decodeEntryName(localName, localFlags)).name !== entry.name) {
      throw formatError('ZIP local and central entry names disagree.');
    }

    const hasDescriptor = (localFlags & DATA_DESCRIPTOR_FLAG) !== 0;
    const localCrc = fixed.readUInt32LE(14);
    const localCompressed32 = fixed.readUInt32LE(18);
    const localUncompressed32 = fixed.readUInt32LE(22);
    const needsLocalZip64Sizes = {
      uncompressedSize: localUncompressed32 === 0xffffffff,
      compressedSize: localCompressed32 === 0xffffffff,
    };
    let localZip64: Zip64Values = {};
    if (hasDescriptor) {
      localZip64 = parseDescriptorZip64Sizes(localExtra, needsLocalZip64Sizes);
      if (localCrc !== 0 && localCrc !== entry.crc32) {
        throw formatError('ZIP local and central CRC32 values disagree.');
      }
      if (
        localCompressed32 !== 0 &&
        localCompressed32 !== 0xffffffff &&
        localCompressed32 !== entry.compressedSize
      ) {
        throw formatError('ZIP local and central compressed sizes disagree.');
      }
      if (
        localUncompressed32 !== 0 &&
        localUncompressed32 !== 0xffffffff &&
        localUncompressed32 !== entry.uncompressedSize
      ) {
        throw formatError('ZIP local and central uncompressed sizes disagree.');
      }
      if (
        localZip64.compressedSize !== undefined &&
        toSafeOffset(localZip64.compressedSize, 'ZIP local compressed size') !==
          entry.compressedSize
      ) {
        throw formatError('ZIP64 local and central compressed sizes disagree.');
      }
      if (
        localZip64.uncompressedSize !== undefined &&
        toSafeOffset(localZip64.uncompressedSize, 'ZIP local uncompressed size') !==
          entry.uncompressedSize
      ) {
        throw formatError('ZIP64 local and central uncompressed sizes disagree.');
      }
    } else {
      const needsZip64 = {
        uncompressedSize: localUncompressed32 === 0xffffffff,
        compressedSize: localCompressed32 === 0xffffffff,
        localHeaderOffset: false,
        diskStart: false,
      };
      const zip64 = Object.values(needsZip64).some(Boolean)
        ? parseZip64Extra(localExtra, needsZip64)
        : {};
      const localCompressed = toSafeOffset(
        zip64.compressedSize ?? BigInt(localCompressed32),
        'ZIP local compressed size'
      );
      const localUncompressed = toSafeOffset(
        zip64.uncompressedSize ?? BigInt(localUncompressed32),
        'ZIP local uncompressed size'
      );
      if (
        localCrc !== entry.crc32 ||
        localCompressed !== entry.compressedSize ||
        localUncompressed !== entry.uncompressedSize
      ) {
        throw formatError('ZIP local metadata disagrees with the central directory.');
      }
    }
    const offset = localVariableEnd;
    const end = offset + entry.compressedSize;
    const localBoundary = this.localEndBoundary.get(entry.localHeaderOffset);
    if (
      !Number.isSafeInteger(end) ||
      localBoundary === undefined ||
      end > this.archiveSize ||
      end > localBoundary
    ) {
      throw formatError('ZIP entry data range is outside the archive.');
    }
    if (hasDescriptor) {
      const descriptorLength = localBoundary - end;
      const usesZip64Descriptor =
        entry.usesZip64Sizes ||
        needsLocalZip64Sizes.uncompressedSize ||
        needsLocalZip64Sizes.compressedSize ||
        localZip64.uncompressedSize !== undefined ||
        localZip64.compressedSize !== undefined;
      const unsignedDescriptorLength = usesZip64Descriptor ? 20 : 12;
      if (
        descriptorLength !== unsignedDescriptorLength &&
        descriptorLength !== unsignedDescriptorLength + 4
      ) {
        throw formatError('ZIP data descriptor is missing, truncated, or has trailing bytes.');
      }
      const descriptor = await readExact(this.handle, end, descriptorLength, this.signal);
      validateDataDescriptor(descriptor, entry, usesZip64Descriptor);
    }
    return offset;
  }

  private recordOutputBytes(count: number): void {
    this.actualAggregateBytes += count;
    if (this.actualAggregateBytes > this.limits.zipAggregateBytes) {
      throwZipLimit('zip-aggregate-bytes', this.limits.zipAggregateBytes + 1, this.limits);
    }
  }

  private async pipeEntry(entry: ZipEntryMetadata, destination: Writable): Promise<string> {
    this.assertOpen();
    if (entry.isDirectory) throw formatError('A directory entry cannot be materialized as a file.');
    if (this.io) {
      const identity = zipEntryIoIdentity(entry.name);
      observeAdapterIo(this.io, {
        adapter: 'filesystem',
        operation: 'read',
        ...identity,
      });
    }
    const offset = await this.dataOffset(entry);
    const source = readHandleRange(this.handle, offset, entry.compressedSize, this.signal);
    const compressed = new CompressedVerifier(entry.compressedSize, this.signal);
    const integrity = new OutputIntegrityVerifier(
      entry,
      this.limits,
      (count) => this.recordOutputBytes(count),
      this.signal
    );

    if (entry.compressionMethod === STORE_METHOD) {
      await pipeline(source, compressed, integrity, destination, { signal: this.signal });
    } else {
      await pipeline(source, compressed, createInflateRaw(), integrity, destination, {
        signal: this.signal,
      });
    }
    return integrity.checksum();
  }

  async extractEntryToFile(name: string, destinationPath: string): Promise<ZipEntryMetadata> {
    this.assertOpen();
    const entry = this.getEntry(name);
    if (!entry) throw formatError(`ZIP entry was not found: ${name}`);
    const destination = await open(destinationPath, 'r+');
    try {
      await destination.chmod(0o600);
      await destination.truncate(0);
      const output = writeToHandle(destination);
      await this.pipeEntry(entry, output);
      await destination.sync();
      return entry;
    } finally {
      await destination.close();
    }
  }

  async extractEntryToFileWithChecksum(
    name: string,
    destinationPath: string
  ): Promise<{ entry: ZipEntryMetadata; checksum: string }> {
    this.assertOpen();
    const entry = this.getEntry(name);
    if (!entry) throw formatError(`ZIP entry was not found: ${name}`);
    const destination = await open(destinationPath, 'r+');
    try {
      await destination.chmod(0o600);
      await destination.truncate(0);
      const output = writeToHandle(destination);
      const checksum = await this.pipeEntry(entry, output);
      await destination.sync();
      return { entry, checksum };
    } finally {
      await destination.close();
    }
  }

  async checksumEntry(name: string): Promise<{ entry: ZipEntryMetadata; checksum: string }> {
    this.assertOpen();
    const entry = this.getEntry(name);
    if (!entry) throw formatError(`ZIP entry was not found: ${name}`);
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const checksum = await this.pipeEntry(entry, sink);
    return { entry, checksum };
  }

  async readEntryBuffer(name: string, maxBytes = MANIFEST_MEMORY_LIMIT): Promise<Buffer> {
    this.assertOpen();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError('ZIP in-memory entry limit must be a positive safe integer.');
    }
    const entry = this.getEntry(name);
    if (!entry) throw formatError(`ZIP entry was not found: ${name}`);
    if (entry.uncompressedSize > maxBytes) {
      throw formatError(`ZIP entry exceeds its in-memory consumer bound: ${name}`);
    }
    const chunks: Buffer[] = [];
    const collector = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await this.pipeEntry(entry, collector);
    return Buffer.concat(chunks, entry.uncompressedSize);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

interface PlannedZipEntry {
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly size: number;
  readonly crc32: number;
  readonly checksum?: string;
  readonly sourcePath?: string;
  readonly data?: Buffer;
  readonly localOffset: bigint;
  readonly localExtra: Buffer;
  readonly centralExtra: Buffer;
  readonly zip64: boolean;
}

function encodeZip64Extra(values: readonly bigint[]): Buffer {
  const result = Buffer.alloc(4 + values.length * 8);
  result.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0);
  result.writeUInt16LE(values.length * 8, 2);
  for (let index = 0; index < values.length; index++) {
    result.writeBigUInt64LE(values[index]!, 4 + index * 8);
  }
  return result;
}

function validateWriteName(
  rawName: string,
  portableNames: Set<string>
): { name: string; nameBytes: Buffer } {
  const normalized = normalizeEntryName(rawName);
  if (normalized.isDirectory) throw formatError('Generated ZIP inputs must be file entries.');
  if (portableNames.has(normalized.portableKey)) {
    throw formatError(`Generated ZIP contains a duplicate normalized entry: ${normalized.name}`);
  }
  portableNames.add(normalized.portableKey);
  const nameBytes = Buffer.from(normalized.name, 'utf8');
  if (nameBytes.length > 0xffff) throw formatError('Generated ZIP entry name is too long.');
  return { name: normalized.name, nameBytes };
}

/** Stream private file inputs once to freeze exact size, SHA-256, and CRC metadata. */
export async function prepareZipFileInputs(
  inputs: readonly ZipFileInput[],
  options: BoundedZipArchiveOptions = {}
): Promise<readonly PreparedZipFileInput[]> {
  const limits = resolveSourceReadLimits(options.sourceReadLimits);
  throwIfAborted(options.signal);
  enforceIntegerLimit('zip-entry-count', BigInt(inputs.length), limits);
  const portableNames = new Set<string>();
  const prepared: PreparedZipFileInput[] = [];
  let aggregateBytes = 0n;

  for (const input of inputs) {
    throwIfAborted(options.signal);
    const normalized = validateWriteName(input.name, portableNames);
    const handle = await open(input.sourcePath, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw formatError('Generated ZIP input must be a regular file.');
      enforceIntegerLimit('zip-entry-bytes', before.size, limits);
      aggregateBytes += before.size;
      enforceIntegerLimit('zip-aggregate-bytes', aggregateBytes, limits);
      enforceRatioLimit(before.size, before.size, limits);
      const size = toSafeOffset(before.size, 'Generated ZIP input size');
      const hash = createHash('sha256');
      let crc = 0xffffffff;
      let observed = 0;
      for await (const rawChunk of readHandleRange(handle, 0, size, options.signal)) {
        const chunk = Buffer.from(rawChunk as Uint8Array);
        observed += chunk.length;
        if (observed > size) throw formatError('Generated ZIP input grew while hashing.');
        hash.update(chunk);
        crc = updateCrc32(crc, chunk);
      }
      const after = await handle.stat({ bigint: true });
      if (observed !== size || after.size !== before.size) {
        throw formatError('Generated ZIP input changed while hashing.');
      }
      prepared.push(
        Object.freeze({
          name: normalized.name,
          sourcePath: input.sourcePath,
          size,
          crc32: finishCrc32(crc),
          checksum: `sha256:${hash.digest('hex')}`,
        })
      );
    } finally {
      await handle.close();
    }
  }

  return Object.freeze(prepared);
}

function planWriteEntries(
  inputs: readonly BoundedZipWriteInput[],
  limits: Readonly<SourceReadLimitsV1>
): {
  readonly entries: PlannedZipEntry[];
  readonly centralOffset: bigint;
  readonly centralSize: bigint;
  readonly archiveSize: number;
  readonly zip64: boolean;
} {
  enforceIntegerLimit('zip-entry-count', BigInt(inputs.length), limits);
  const portableNames = new Set<string>();
  const partial: Array<
    Omit<PlannedZipEntry, 'localOffset' | 'localExtra' | 'centralExtra' | 'zip64'>
  > = [];
  let aggregateBytes = 0n;

  for (const input of inputs) {
    const normalized = validateWriteName(input.name, portableNames);
    if ('sourcePath' in input) {
      if (!Number.isSafeInteger(input.size) || input.size < 0) {
        throw formatError('Prepared ZIP input size is invalid.');
      }
      if (!Number.isInteger(input.crc32) || input.crc32 < 0 || input.crc32 > 0xffffffff) {
        throw formatError('Prepared ZIP input CRC32 is invalid.');
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(input.checksum)) {
        throw formatError('Prepared ZIP input checksum is invalid.');
      }
      enforceIntegerLimit('zip-entry-bytes', BigInt(input.size), limits);
      aggregateBytes += BigInt(input.size);
      enforceIntegerLimit('zip-aggregate-bytes', aggregateBytes, limits);
      enforceRatioLimit(BigInt(input.size), BigInt(input.size), limits);
      partial.push({
        ...normalized,
        size: input.size,
        crc32: input.crc32,
        checksum: input.checksum,
        sourcePath: input.sourcePath,
      });
    } else {
      const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
      enforceIntegerLimit('zip-entry-bytes', BigInt(data.length), limits);
      aggregateBytes += BigInt(data.length);
      enforceIntegerLimit('zip-aggregate-bytes', aggregateBytes, limits);
      enforceRatioLimit(BigInt(data.length), BigInt(data.length), limits);
      partial.push({
        ...normalized,
        size: data.length,
        crc32: finishCrc32(updateCrc32(0xffffffff, data)),
        data,
      });
    }
  }

  let cursor = 0n;
  const entries: PlannedZipEntry[] = partial.map((entry) => {
    const size = BigInt(entry.size);
    const sizeZip64 = size >= 0xffffffffn;
    const localOffset = cursor;
    const offsetZip64 = localOffset >= 0xffffffffn;
    const localExtra = sizeZip64 ? encodeZip64Extra([size, size]) : Buffer.alloc(0);
    const centralValues: bigint[] = [];
    if (sizeZip64) centralValues.push(size, size);
    if (offsetZip64) centralValues.push(localOffset);
    const centralExtra =
      centralValues.length > 0 ? encodeZip64Extra(centralValues) : Buffer.alloc(0);
    const zip64 = sizeZip64 || offsetZip64;
    cursor += 30n + BigInt(entry.nameBytes.length + localExtra.length) + size;
    return {
      ...entry,
      localOffset,
      localExtra,
      centralExtra,
      zip64,
    };
  });

  const centralOffset = cursor;
  let centralSize = 0n;
  for (const entry of entries) {
    centralSize += 46n + BigInt(entry.nameBytes.length + entry.centralExtra.length);
  }
  const zip64 =
    entries.some((entry) => entry.zip64) ||
    inputs.length >= 0xffff ||
    centralOffset >= 0xffffffffn ||
    centralSize >= 0xffffffffn;
  const archiveSizeBig = centralOffset + centralSize + (zip64 ? 98n : 22n);
  enforceIntegerLimit('zip-compressed-bytes', archiveSizeBig, limits);
  return {
    entries,
    centralOffset,
    centralSize,
    archiveSize: toSafeOffset(archiveSizeBig, 'Generated ZIP archive size'),
    zip64,
  };
}

function localHeader(entry: PlannedZipEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(entry.zip64 ? 45 : 20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(STORE_METHOD, 8);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.size >= 0xffffffff ? 0xffffffff : entry.size, 18);
  header.writeUInt32LE(entry.size >= 0xffffffff ? 0xffffffff : entry.size, 22);
  header.writeUInt16LE(entry.nameBytes.length, 26);
  header.writeUInt16LE(entry.localExtra.length, 28);
  return header;
}

function centralHeader(entry: PlannedZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(entry.zip64 ? 45 : 20, 4);
  header.writeUInt16LE(entry.zip64 ? 45 : 20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(STORE_METHOD, 10);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.size >= 0xffffffff ? 0xffffffff : entry.size, 20);
  header.writeUInt32LE(entry.size >= 0xffffffff ? 0xffffffff : entry.size, 24);
  header.writeUInt16LE(entry.nameBytes.length, 28);
  header.writeUInt16LE(entry.centralExtra.length, 30);
  header.writeUInt32LE(
    entry.localOffset >= 0xffffffffn ? 0xffffffff : Number(entry.localOffset),
    42
  );
  return header;
}

async function writeAllAt(handle: FileHandle, value: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await handle.write(
      value,
      offset,
      value.length - offset,
      position + offset
    );
    if (bytesWritten === 0) throw new Error('Generated ZIP output accepted zero bytes.');
    offset += bytesWritten;
  }
  return position + value.length;
}

/** Create one complete owner-private STORE archive through bounded file streams. */
export async function writeBoundedZipArchive(
  destinationPath: string,
  inputs: readonly BoundedZipWriteInput[],
  options: BoundedZipArchiveOptions = {}
): Promise<BoundedZipWriteResult> {
  const limits = resolveSourceReadLimits(options.sourceReadLimits);
  throwIfAborted(options.signal);
  const plan = planWriteEntries(inputs, limits);
  const destination = await open(destinationPath, 'wx', 0o600);
  try {
    await destination.chmod(0o600);
    let position = 0;
    const write = async (value: Buffer): Promise<void> => {
      throwIfAborted(options.signal);
      const next = position + value.length;
      if (next > plan.archiveSize) throw formatError('Generated ZIP exceeded its planned size.');
      enforceIntegerLimit('zip-compressed-bytes', BigInt(next), limits);
      position = await writeAllAt(destination, value, position);
    };

    for (const entry of plan.entries) {
      await write(localHeader(entry));
      await write(entry.nameBytes);
      await write(entry.localExtra);
      if (entry.data) {
        await write(entry.data);
        continue;
      }
      if (!entry.sourcePath || !entry.checksum)
        throw formatError('Prepared ZIP input is incomplete.');
      const source = await open(entry.sourcePath, 'r');
      try {
        const metadata = await source.stat({ bigint: true });
        if (!metadata.isFile() || metadata.size !== BigInt(entry.size)) {
          throw formatError('Prepared ZIP input changed before archive creation.');
        }
        let crc = 0xffffffff;
        const hash = createHash('sha256');
        let observed = 0;
        for await (const rawChunk of readHandleRange(source, 0, entry.size, options.signal)) {
          const chunk = Buffer.from(rawChunk as Uint8Array);
          observed += chunk.length;
          if (observed > entry.size)
            throw formatError('Prepared ZIP input grew during archive creation.');
          crc = updateCrc32(crc, chunk);
          hash.update(chunk);
          await write(chunk);
        }
        const after = await source.stat({ bigint: true });
        if (
          observed !== entry.size ||
          after.size !== BigInt(entry.size) ||
          finishCrc32(crc) !== entry.crc32 ||
          `sha256:${hash.digest('hex')}` !== entry.checksum
        ) {
          throw formatError('Prepared ZIP input changed during archive creation.');
        }
      } finally {
        await source.close();
      }
    }

    if (BigInt(position) !== plan.centralOffset) {
      throw formatError('Generated ZIP local-data size is inconsistent.');
    }
    for (const entry of plan.entries) {
      await write(centralHeader(entry));
      await write(entry.nameBytes);
      await write(entry.centralExtra);
    }
    if (BigInt(position) !== plan.centralOffset + plan.centralSize) {
      throw formatError('Generated ZIP central-directory size is inconsistent.');
    }

    if (plan.zip64) {
      const zip64EocdOffset = position;
      const zip64Eocd = Buffer.alloc(56);
      zip64Eocd.writeUInt32LE(ZIP64_EOCD_SIGNATURE, 0);
      zip64Eocd.writeBigUInt64LE(44n, 4);
      zip64Eocd.writeUInt16LE(45, 12);
      zip64Eocd.writeUInt16LE(45, 14);
      zip64Eocd.writeBigUInt64LE(BigInt(plan.entries.length), 24);
      zip64Eocd.writeBigUInt64LE(BigInt(plan.entries.length), 32);
      zip64Eocd.writeBigUInt64LE(plan.centralSize, 40);
      zip64Eocd.writeBigUInt64LE(plan.centralOffset, 48);
      await write(zip64Eocd);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
      locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
      locator.writeUInt32LE(1, 16);
      await write(locator);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(plan.zip64 ? 0xffff : plan.entries.length, 8);
    eocd.writeUInt16LE(plan.zip64 ? 0xffff : plan.entries.length, 10);
    eocd.writeUInt32LE(plan.zip64 ? 0xffffffff : Number(plan.centralSize), 12);
    eocd.writeUInt32LE(plan.zip64 ? 0xffffffff : Number(plan.centralOffset), 16);
    await write(eocd);
    if (position !== plan.archiveSize) throw formatError('Generated ZIP size is inconsistent.');
    await destination.truncate(position);
    await destination.sync();
    await destination.close();
    return { archiveSize: position, entryCount: plan.entries.length };
  } catch (error) {
    try {
      await destination.close();
    } catch {
      // The primary operation error remains authoritative; the path is unlinked below.
    }
    try {
      await unlink(destinationPath);
    } catch {
      // Backup orchestration tracks and retries cleanup for its private sibling staging path.
    }
    throw error;
  }
}

export async function openBoundedZipArchive(
  path: string,
  options?: BoundedZipArchiveOptions
): Promise<BoundedZipArchive> {
  return BoundedZipArchive.open(path, options);
}
