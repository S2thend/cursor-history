import { SourceLimitConfigurationError } from './errors.js';
import type {
  SourceBoundKind,
  SourceReadLimitsOverride,
  SourceReadLimitsV1,
  JsonlSourceLimitDimension,
  SqliteSourceLimitDimension,
  ZipSourceLimitDimension,
} from './types.js';

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
  override?: SourceReadLimitsOverride
): Readonly<SourceReadLimitsV1> {
  if (override === undefined) return SOURCE_READ_LIMITS_V1_DEFAULTS;
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new SourceLimitConfigurationError('sourceReadLimits', override, 'must be an object');
  }

  for (const key of Object.keys(override)) {
    if (!SOURCE_READ_LIMIT_FIELD_SET.has(key)) {
      throw new SourceLimitConfigurationError(key, (override as Record<string, unknown>)[key], 'unknown field');
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

  return Object.freeze(result);
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
