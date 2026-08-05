import { SourceLimitConfigurationError } from '../core/errors.js';
import {
  resolveSourceReadLimits,
  SOURCE_READ_LIMIT_FIELDS,
  type SourceReadLimitField,
} from '../core/source-read-limits.js';
import type { SourceReadLimitsOverride, SourceReadLimitsV1 } from '../core/types.js';

const BYTE_FIELDS = new Set<SourceReadLimitField>([
  'jsonlRecordBytes',
  'jsonlSourceBytes',
  'sqlitePageBytes',
  'sqliteValueBytes',
  'sqliteDecodedBytes',
  'zipCompressedBytes',
  'zipEntryBytes',
  'zipAggregateBytes',
]);

const FIELD_SET = new Set<string>(SOURCE_READ_LIMIT_FIELDS);
const IEC_MULTIPLIERS: Readonly<Record<string, bigint>> = Object.freeze({
  '': 1n,
  B: 1n,
  KiB: 1_024n,
  MiB: 1_048_576n,
  GiB: 1_073_741_824n,
  TiB: 1_099_511_627_776n,
});

export type CliSourceLimitOverrides = Readonly<SourceReadLimitsOverride>;

function invalid(field: string, value: unknown, constraint: string): never {
  throw new SourceLimitConfigurationError(field, value, constraint);
}

function parsePositiveSafeInteger(field: SourceReadLimitField, rawValue: string): number {
  const match = rawValue.match(/^(0|[1-9]\d*)(B|KiB|MiB|GiB|TiB)?$/u);
  if (!match) invalid(field, rawValue, 'must be a positive integer or documented IEC byte size');

  const suffix = match[2] ?? '';
  if (!BYTE_FIELDS.has(field) && suffix !== '') {
    invalid(field, rawValue, 'count, row, and ratio fields do not accept byte suffixes');
  }
  const multiplier = IEC_MULTIPLIERS[suffix];
  if (multiplier === undefined) invalid(field, rawValue, 'uses an unsupported IEC suffix');
  const result = BigInt(match[1]!) * multiplier;
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(field, rawValue, 'must resolve to a positive safe integer');
  }
  return Number(result);
}

/** Commander option accumulator for repeatable `--source-limit field=value` arguments. */
export function parseSourceLimitOption(
  assignment: string,
  previous: CliSourceLimitOverrides = Object.freeze({})
): CliSourceLimitOverrides {
  const separator = assignment.indexOf('=');
  if (separator <= 0 || separator !== assignment.lastIndexOf('=')) {
    invalid('sourceReadLimits', assignment, 'must use exactly one field=value assignment');
  }
  const field = assignment.slice(0, separator);
  const rawValue = assignment.slice(separator + 1);
  if (!FIELD_SET.has(field)) invalid(field, rawValue, 'unknown field');
  if (Object.prototype.hasOwnProperty.call(previous, field)) {
    invalid(field, rawValue, 'a field may be specified only once per operation');
  }
  const typedField = field as SourceReadLimitField;
  return Object.freeze({
    ...previous,
    [typedField]: parsePositiveSafeInteger(typedField, rawValue),
  });
}

/** Validate cross-field relationships and freeze the effective v1 operation policy. */
export function resolveCliSourceReadLimits(
  overrides?: CliSourceLimitOverrides
): Readonly<SourceReadLimitsV1> {
  return resolveSourceReadLimits(overrides);
}
