import {
  SourceEncodingError,
  SourceLimitConfigurationError,
  SourceLimitExceededError,
} from './errors.js';
import type {
  SourceBoundKind,
  SourceReadLimitsOverride,
  SourceReadLimitsV1,
  JsonlSourceLimitDimension,
  SqliteSourceLimitDimension,
  ZipSourceLimitDimension,
} from './types.js';

/** Internal identity brand for policies already validated, copied, and frozen by this module. */
const RESOLVED_SOURCE_READ_LIMITS = new WeakSet<object>();

/** Frozen exact inclusive defaults for Source Read Limits v1. */
export const SOURCE_READ_LIMITS_V1_DEFAULTS: Readonly<SourceReadLimitsV1> = Object.freeze({
  policyVersion: 'source-read-limits/v1',
  jsonlRecordBytes: 67_108_864,
  jsonlSourceBytes: 4_294_967_296,
  jsonlRecordCount: 2_000_000,
  sqlitePageRows: 256,
  sqlitePageBytes: 268_435_456,
  sqliteValueBytes: 134_217_728,
  sqliteRowCount: 5_000_000,
  sqliteDecodedBytes: 8_589_934_592,
  zipCompressedBytes: 17_179_869_184,
  zipEntryCount: 65_536,
  zipEntryBytes: 8_589_934_592,
  zipAggregateBytes: 17_179_869_184,
  zipCompressionRatio: 200,
});
RESOLVED_SOURCE_READ_LIMITS.add(SOURCE_READ_LIMITS_V1_DEFAULTS);

export const SOURCE_READ_LIMIT_FIELDS = Object.freeze([
  'jsonlRecordBytes',
  'jsonlSourceBytes',
  'jsonlRecordCount',
  'sqlitePageRows',
  'sqlitePageBytes',
  'sqliteValueBytes',
  'sqliteRowCount',
  'sqliteDecodedBytes',
  'zipCompressedBytes',
  'zipEntryCount',
  'zipEntryBytes',
  'zipAggregateBytes',
  'zipCompressionRatio',
] as const);

export type SourceReadLimitField = (typeof SOURCE_READ_LIMIT_FIELDS)[number];

const SOURCE_READ_LIMIT_FIELD_SET = new Set<string>(SOURCE_READ_LIMIT_FIELDS);

function assertRelationship(
  limits: SourceReadLimitsV1,
  left: SourceReadLimitField,
  right: SourceReadLimitField
): void {
  if (limits[left] > limits[right]) {
    throw new SourceLimitConfigurationError(
      left,
      limits[left],
      `${left} must be less than or equal to ${right}`
    );
  }
}

/** Validate, copy, and freeze an immutable per-operation limit map. */
export function resolveSourceReadLimits(
  override?: SourceReadLimitsOverride | Readonly<SourceReadLimitsV1>
): Readonly<SourceReadLimitsV1> {
  if (override === undefined) return SOURCE_READ_LIMITS_V1_DEFAULTS;
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new SourceLimitConfigurationError('sourceReadLimits', override, 'must be an object');
  }
  if (RESOLVED_SOURCE_READ_LIMITS.has(override)) return override as Readonly<SourceReadLimitsV1>;

  for (const key of Object.keys(override)) {
    if (!SOURCE_READ_LIMIT_FIELD_SET.has(key)) {
      throw new SourceLimitConfigurationError(
        key,
        (override as Record<string, unknown>)[key],
        'unknown field'
      );
    }
  }

  const result = { ...SOURCE_READ_LIMITS_V1_DEFAULTS } as SourceReadLimitsV1;
  for (const key of SOURCE_READ_LIMIT_FIELDS) {
    const value = override[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SourceLimitConfigurationError(key, value, 'must be a positive safe integer');
    }
    (result as unknown as Record<SourceReadLimitField, number>)[key] = value;
  }

  assertRelationship(result, 'jsonlRecordBytes', 'jsonlSourceBytes');
  assertRelationship(result, 'sqlitePageRows', 'sqliteRowCount');
  assertRelationship(result, 'sqliteValueBytes', 'sqlitePageBytes');
  assertRelationship(result, 'sqlitePageBytes', 'sqliteDecodedBytes');
  assertRelationship(result, 'zipEntryBytes', 'zipAggregateBytes');

  const resolved = Object.freeze(result);
  RESOLVED_SOURCE_READ_LIMITS.add(resolved);
  return resolved;
}

/** Exact source-kind/bound/unit mapping used by all typed limit diagnostics. */
export function sourceLimitDimension(
  bound: SourceBoundKind
): JsonlSourceLimitDimension | SqliteSourceLimitDimension | ZipSourceLimitDimension {
  switch (bound) {
    case 'jsonl-record-bytes':
    case 'jsonl-source-bytes':
      return { sourceKind: 'jsonl', bound, unit: 'bytes' };
    case 'jsonl-record-count':
      return { sourceKind: 'jsonl', bound, unit: 'records' };
    case 'sqlite-page-rows':
    case 'sqlite-row-count':
      return { sourceKind: 'sqlite', bound, unit: 'rows' };
    case 'sqlite-page-bytes':
    case 'sqlite-value-bytes':
    case 'sqlite-decoded-bytes':
      return { sourceKind: 'sqlite', bound, unit: 'bytes' };
    case 'zip-compressed-bytes':
    case 'zip-entry-bytes':
    case 'zip-aggregate-bytes':
      return { sourceKind: 'zip', bound, unit: 'bytes' };
    case 'zip-entry-count':
      return { sourceKind: 'zip', bound, unit: 'records' };
    case 'zip-compression-ratio':
      return { sourceKind: 'zip', bound, unit: 'ratio' };
  }
}

/** Throw a typed limit error when an observation is above its inclusive bound. */
export function exceedsInclusiveLimit(observed: number, limit: number): boolean {
  return observed > limit;
}

export type SourceFailureOutcome = 'partial' | 'fatal';

/**
 * Check one inclusive bound and throw the public typed error at the first
 * observed unit above it. Callers deliberately choose whether a safe alternate
 * contributor makes the outcome partial or whether the source is fatal.
 */
export function assertSourceReadLimit(
  bound: SourceBoundKind,
  observedAtLeast: number,
  limit: number,
  outcome: SourceFailureOutcome
): void {
  if (!exceedsInclusiveLimit(observedAtLeast, limit)) return;
  throw new SourceLimitExceededError({
    ...sourceLimitDimension(bound),
    limit,
    observedAtLeast,
    outcome,
  });
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Decode deterministic UTF-8. Exactly one leading BOM is accepted and
 * removed; a BOM anywhere else is rejected rather than becoming identity-
 * changing U+FEFF content. Invalid bytes are never replacement-decoded.
 */
export function decodeDeterministicUtf8(
  value: Uint8Array,
  sourceKind: 'jsonl' | 'sqlite',
  outcome: SourceFailureOutcome,
  allowLeadingBom = true
): { text: string; hadBom: boolean } {
  let bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const startsWithBom = bytes.length >= UTF8_BOM.length && bytes.subarray(0, 3).equals(UTF8_BOM);
  if (startsWithBom && !allowLeadingBom) {
    throw new SourceEncodingError(sourceKind, outcome);
  }
  const hadBom = startsWithBom;
  if (hadBom) bytes = bytes.subarray(3);
  if (bytes.indexOf(UTF8_BOM) >= 0) {
    throw new SourceEncodingError(sourceKind, outcome);
  }

  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      hadBom,
    };
  } catch (error) {
    if (error instanceof SourceEncodingError) throw error;
    throw new SourceEncodingError(sourceKind, outcome);
  }
}

/**
 * Per-transcript raw-byte/count budget. Constructing a fresh budget is the
 * documented reset boundary; it never accumulates across a corpus.
 */
export class JsonlSourceReadBudget {
  private sourceBytesValue = 0;
  private recordCountValue = 0;

  constructor(
    readonly limits: Readonly<SourceReadLimitsV1>,
    readonly outcome: SourceFailureOutcome
  ) {}

  get sourceBytes(): number {
    return this.sourceBytesValue;
  }

  get recordCount(): number {
    return this.recordCountValue;
  }

  /** Admit raw bytes read from the source, including BOM and line endings. */
  admitSourceBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError('JSONL source byte observations must be nonnegative safe integers');
    }
    const next = this.sourceBytesValue + bytes;
    assertSourceReadLimit('jsonl-source-bytes', next, this.limits.jsonlSourceBytes, this.outcome);
    this.sourceBytesValue = next;
  }

  /** Admit one record after CR/LF and a permitted leading BOM are removed. */
  admitRecordBytes(recordBytes: number): void {
    if (!Number.isSafeInteger(recordBytes) || recordBytes < 0) {
      throw new TypeError('JSONL record byte observations must be nonnegative safe integers');
    }
    assertSourceReadLimit(
      'jsonl-record-bytes',
      recordBytes,
      this.limits.jsonlRecordBytes,
      this.outcome
    );
  }

  /** Charge a nonempty record only after bounded fatal decoding. */
  admitNonemptyRecord(): void {
    const next = this.recordCountValue + 1;
    assertSourceReadLimit('jsonl-record-count', next, this.limits.jsonlRecordCount, this.outcome);
    this.recordCountValue = next;
  }

  /** Convenience composite for counter-only callers. */
  admitRecord(recordBytes: number, nonempty: boolean): void {
    this.admitRecordBytes(recordBytes);
    if (nonempty) this.admitNonemptyRecord();
  }
}

/**
 * Per-logical-session (or separately per catalog scan) SQLite budget. Metadata
 * pages are admitted before any payload is fetched; admitted payloads are then
 * materialized one at a time and charged against the aggregate decoded total.
 */
export class SqliteSourceReadBudget {
  private rowCountValue = 0;
  private decodedBytesValue = 0;

  constructor(
    readonly limits: Readonly<SourceReadLimitsV1>,
    readonly outcome: SourceFailureOutcome
  ) {}

  get rowCount(): number {
    return this.rowCountValue;
  }

  get decodedBytes(): number {
    return this.decodedBytesValue;
  }

  /** Admit a keyset/row-ID metadata page using declared payload byte lengths. */
  admitMetadataPage(declaredValueBytes: readonly number[]): void {
    for (const value of declaredValueBytes) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('SQLite declared value lengths must be nonnegative safe integers');
      }
    }
    const pageRows = declaredValueBytes.length;
    const pageBytes = declaredValueBytes.reduce((total, value) => total + value, 0);
    assertSourceReadLimit('sqlite-page-rows', pageRows, this.limits.sqlitePageRows, this.outcome);
    assertSourceReadLimit(
      'sqlite-page-bytes',
      pageBytes,
      this.limits.sqlitePageBytes,
      this.outcome
    );
    for (const value of declaredValueBytes) {
      assertSourceReadLimit(
        'sqlite-value-bytes',
        value,
        this.limits.sqliteValueBytes,
        this.outcome
      );
    }
    const rows = this.rowCountValue + pageRows;
    assertSourceReadLimit('sqlite-row-count', rows, this.limits.sqliteRowCount, this.outcome);
    this.rowCountValue = rows;
  }

  /** Charge the actual raw payload only after its metadata page was admitted. */
  admitDecodedValue(actualBytes: number): void {
    if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
      throw new TypeError('SQLite decoded byte observations must be nonnegative safe integers');
    }
    assertSourceReadLimit(
      'sqlite-value-bytes',
      actualBytes,
      this.limits.sqliteValueBytes,
      this.outcome
    );
    const decoded = this.decodedBytesValue + actualBytes;
    assertSourceReadLimit(
      'sqlite-decoded-bytes',
      decoded,
      this.limits.sqliteDecodedBytes,
      this.outcome
    );
    this.decodedBytesValue = decoded;
  }
}
