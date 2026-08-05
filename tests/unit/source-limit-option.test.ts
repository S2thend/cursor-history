import { describe, expect, it } from 'vitest';

import { SourceLimitConfigurationError } from '../../src/core/errors.js';
import {
  parseSourceLimitOption,
  resolveCliSourceReadLimits,
} from '../../src/cli/source-limit-option.js';

describe('repeatable CLI source-limit parsing', () => {
  it('parses decimal counts and IEC byte sizes without mutating prior accumulators', () => {
    const first = parseSourceLimitOption('jsonlRecordBytes=128MiB');
    const second = parseSourceLimitOption('jsonlRecordCount=3000000', first);

    expect(first).toEqual({ jsonlRecordBytes: 134_217_728 });
    expect(second).toEqual({
      jsonlRecordBytes: 134_217_728,
      jsonlRecordCount: 3_000_000,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it.each([
    'policyVersion=1',
    'unknown=1',
    'jsonlRecordBytes',
    '=1',
    'jsonlRecordBytes=1=2',
    'jsonlRecordBytes=0',
    'jsonlRecordBytes=1MB',
    'jsonlRecordCount=1KiB',
    'zipCompressionRatio=1.5',
    'zipEntryCount=9007199254740992',
  ])('rejects invalid assignment %s with the typed usage error', (assignment) => {
    expect(() => parseSourceLimitOption(assignment)).toThrow(SourceLimitConfigurationError);
  });

  it('rejects duplicate fields even when the repeated value is identical', () => {
    const first = parseSourceLimitOption('zipEntryCount=10');
    expect(() => parseSourceLimitOption('zipEntryCount=10', first)).toThrow(
      SourceLimitConfigurationError
    );
  });

  it('validates relationships only after all repeatable assignments are accumulated', () => {
    const entry = parseSourceLimitOption('zipEntryBytes=2GiB');
    const aggregate = parseSourceLimitOption('zipAggregateBytes=1GiB', entry);
    expect(() => resolveCliSourceReadLimits(aggregate)).toThrow(SourceLimitConfigurationError);
  });

  it('inherits defaults for omitted fields and returns one frozen policy map', () => {
    const overrides = parseSourceLimitOption('sqlitePageRows=512');
    const resolved = resolveCliSourceReadLimits(overrides);
    expect(resolved.policyVersion).toBe('source-read-limits/v1');
    expect(resolved.sqlitePageRows).toBe(512);
    expect(resolved.sqliteRowCount).toBe(5_000_000);
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});
