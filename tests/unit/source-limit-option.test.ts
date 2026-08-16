import { describe, expect, it } from 'vitest';

import { SourceLimitConfigurationError } from '../../src/core/errors.js';
import {
  CLI_SOURCE_LIMIT_REGISTRY,
  parseSourceLimitOption,
  resolveCliSourceReadLimits,
  validateCliSourceLimitArguments,
  validateCliSourceLimitOverrides,
} from '../../src/cli/source-limit-option.js';
import { SOURCE_READ_LIMIT_FIELDS } from '../../src/core/source-read-limits.js';

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
    'jsonlRecordBytes=1B',
    'jsonlRecordBytes=1TiB',
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

  it('keeps the sparse operation override immutable after validating effective defaults', () => {
    const input = { sqliteRowCount: 6_000_000 };
    const validated = validateCliSourceLimitOverrides(input);
    input.sqliteRowCount = 7_000_000;

    expect(validated).toEqual({ sqliteRowCount: 6_000_000 });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(validateCliSourceLimitOverrides(undefined)).toBeUndefined();
  });

  it('prevalidates separated and equals-form argv assignments including relationships', () => {
    const resolved = validateCliSourceLimitArguments([
      '--source-limit',
      'jsonlRecordBytes=128MiB',
      '--source-limit=jsonlRecordCount=3000000',
      'list',
    ]);
    expect(resolved.jsonlRecordBytes).toBe(134_217_728);
    expect(resolved.jsonlRecordCount).toBe(3_000_000);

    expect(() =>
      validateCliSourceLimitArguments([
        '--source-limit=zipEntryBytes=2GiB',
        '--source-limit=zipAggregateBytes=1GiB',
        'backup',
      ])
    ).toThrow(SourceLimitConfigurationError);

    expect(() =>
      validateCliSourceLimitArguments(['search', '--', '--source-limit=not-an-option'])
    ).not.toThrow();
  });

  it.each([
    ['missing value', ['--source-limit']],
    ['missing assignment before another option', ['--source-limit', '--json', 'list']],
    ['duplicate field', ['--source-limit=zipEntryCount=10', '--source-limit', 'zipEntryCount=11']],
    ['unknown field', ['--source-limit=noSuchField=1']],
    ['policyVersion', ['--source-limit=policyVersion=1']],
    ['unsafe range', ['--source-limit=zipEntryCount=9007199254740992']],
  ])('rejects %s during argv preflight', (_label, argv) => {
    expect(() => validateCliSourceLimitArguments(argv)).toThrow(SourceLimitConfigurationError);
  });

  it('keeps the CLI registry closed over every policy field exactly once', () => {
    expect(CLI_SOURCE_LIMIT_REGISTRY.map(({ field }) => field)).toEqual(SOURCE_READ_LIMIT_FIELDS);
    expect(new Set(CLI_SOURCE_LIMIT_REGISTRY.map(({ field }) => field)).size).toBe(
      SOURCE_READ_LIMIT_FIELDS.length
    );
  });
});
