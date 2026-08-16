import { describe, expect, it } from 'vitest';
import {
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  resolveSourceReadLimits,
  sourceLimitDimension,
} from '../../src/core/source-read-limits.js';
import { SourceLimitConfigurationError } from '../../src/core/errors.js';

describe('Source Read Limits v1', () => {
  it('freezes the exact inclusive defaults', () => {
    expect(SOURCE_READ_LIMITS_V1_DEFAULTS).toEqual({
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
    expect(Object.isFrozen(SOURCE_READ_LIMITS_V1_DEFAULTS)).toBe(true);
  });

  it('copies, validates, and freezes one operation override', () => {
    const override = { jsonlRecordBytes: 1024, jsonlSourceBytes: 2048 };
    const resolved = resolveSourceReadLimits(override);
    override.jsonlRecordBytes = 4096;
    expect(resolved.jsonlRecordBytes).toBe(1024);
    expect(resolved.jsonlSourceBytes).toBe(2048);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('inherits recognized undefined values but rejects null, unknown keys, and policyVersion', () => {
    expect(resolveSourceReadLimits({ jsonlRecordBytes: undefined }).jsonlRecordBytes).toBe(
      SOURCE_READ_LIMITS_V1_DEFAULTS.jsonlRecordBytes
    );
    for (const value of [
      { jsonlRecordBytes: null },
      { unknown: undefined },
      { policyVersion: undefined },
    ]) {
      expect(() => resolveSourceReadLimits(value as never)).toThrow(SourceLimitConfigurationError);
    }
  });

  it('rejects unsafe values and cross-field inconsistencies', () => {
    for (const value of [
      { jsonlRecordBytes: 0 },
      { jsonlRecordBytes: 1.5 },
      { jsonlRecordBytes: Number.MAX_VALUE },
      { jsonlRecordBytes: 10, jsonlSourceBytes: 9 },
      { sqlitePageRows: 10, sqliteRowCount: 9 },
      { sqliteValueBytes: 11, sqlitePageBytes: 10 },
      { sqlitePageBytes: 11, sqliteDecodedBytes: 10 },
      { zipEntryBytes: 11, zipAggregateBytes: 10 },
    ]) {
      expect(() => resolveSourceReadLimits(value)).toThrow(SourceLimitConfigurationError);
    }
  });

  it('maps every bound to its exact source kind and unit', () => {
    expect(sourceLimitDimension('jsonl-record-bytes')).toEqual({
      sourceKind: 'jsonl',
      bound: 'jsonl-record-bytes',
      unit: 'bytes',
    });
    expect(sourceLimitDimension('jsonl-record-count').unit).toBe('records');
    expect(sourceLimitDimension('sqlite-page-rows').unit).toBe('rows');
    expect(sourceLimitDimension('sqlite-value-bytes').unit).toBe('bytes');
    expect(sourceLimitDimension('zip-entry-count').unit).toBe('records');
    expect(sourceLimitDimension('zip-compression-ratio')).toEqual({
      sourceKind: 'zip',
      bound: 'zip-compression-ratio',
      unit: 'ratio',
    });
  });
});
