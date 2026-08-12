import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SESSION_INTEGRITY_IDS,
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeStoreTranscript,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { runBuiltCli } from '../helpers/run-cli.js';

interface AjvError {
  dataPath?: string;
  instancePath?: string;
  keyword?: string;
  message?: string;
}

type ValidateFunction = ((value: unknown) => boolean) & {
  errors?: readonly AjvError[] | null;
};

interface AjvInstance {
  compile(schema: unknown): ValidateFunction;
}

type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

type JsonRecord = Record<string, unknown>;
type SourceKind = 'jsonl' | 'sqlite' | 'zip';
type LimitUnit = 'bytes' | 'records' | 'rows' | 'ratio';

interface LimitPair {
  sourceKind: SourceKind;
  bound: string;
  unit: LimitUnit;
}

const REPOSITORY_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCHEMA_PATH = join(
  REPOSITORY_ROOT,
  'specs',
  '016-harden-session-integrity',
  'contracts',
  'session-output.schema.json'
);
const FROZEN_SCHEMA_SHA256 = 'c5dd73e7455d4dd7b7dd4f099a0addeb9bc0fa3782e0e3e096c1b61ef0ff9a37';
const schemaBytes = readFileSync(SCHEMA_PATH);
const frozenSchema = JSON.parse(schemaBytes.toString('utf8')) as JsonRecord;
const schemaForAjv = structuredClone(frozenSchema);
// Ajv 6 is already present through the lint toolchain and implements all
// keywords used by this oracle. It does not register the draft-2020 meta
// schema, so validate the frozen URI separately and compile the unchanged
// contract body without only that meta-schema selector.
delete schemaForAjv['$schema'];
const require = createRequire(import.meta.url);
const Ajv = require('ajv') as AjvConstructor;
const validateSchema = new Ajv({
  allErrors: true,
  jsonPointers: true,
  schemaId: 'auto',
  validateSchema: false,
}).compile(schemaForAjv);

const SOURCE_ROLE_ORDER = ['composer', 'store'] as const;
const REPRESENTATION_ORDER = [
  'composer-global',
  'composer-workspace',
  'store-db',
  'store-transcript',
  'store-metadata',
] as const;
const REASON_ORDER = [
  'workspace-scope-omitted',
  'source-unavailable',
  'source-read-failed',
  'source-partial',
  'expected-store-db-unavailable',
  'store-db-expectation-unknown',
  'store-conversation-unavailable',
] as const;
const INSTANCE_STATE_ORDER = [
  'contributed',
  'equivalent-replica',
  'omitted-by-scope',
  'failed',
  'superseded',
] as const;
const FORBIDDEN_LOCATOR_KEYS = new Set([
  'locator',
  'physicalLocator',
  'storeDbPath',
  'transcriptPath',
  'chatDir',
  'databasePath',
  'dbPath',
  'workspaceDbPath',
  'sourcePath',
]);
const SOURCE_LOCATOR_SENTINEL = '/private/source-fixture/never-publish';

const PARTIAL_LIMIT_PAIRS: readonly LimitPair[] = [
  { sourceKind: 'jsonl', bound: 'jsonl-record-bytes', unit: 'bytes' },
  { sourceKind: 'jsonl', bound: 'jsonl-source-bytes', unit: 'bytes' },
  { sourceKind: 'jsonl', bound: 'jsonl-record-count', unit: 'records' },
  { sourceKind: 'sqlite', bound: 'sqlite-page-rows', unit: 'rows' },
  { sourceKind: 'sqlite', bound: 'sqlite-page-bytes', unit: 'bytes' },
  { sourceKind: 'sqlite', bound: 'sqlite-value-bytes', unit: 'bytes' },
  { sourceKind: 'sqlite', bound: 'sqlite-row-count', unit: 'rows' },
  { sourceKind: 'sqlite', bound: 'sqlite-decoded-bytes', unit: 'bytes' },
];

const FATAL_LIMIT_PAIRS: readonly LimitPair[] = [
  ...PARTIAL_LIMIT_PAIRS,
  { sourceKind: 'zip', bound: 'zip-compressed-bytes', unit: 'bytes' },
  { sourceKind: 'zip', bound: 'zip-entry-count', unit: 'records' },
  { sourceKind: 'zip', bound: 'zip-entry-bytes', unit: 'bytes' },
  { sourceKind: 'zip', bound: 'zip-aggregate-bytes', unit: 'bytes' },
  { sourceKind: 'zip', bound: 'zip-compression-ratio', unit: 'ratio' },
];

const ALL_SOURCE_KINDS = ['jsonl', 'sqlite', 'zip'] as const;
const ALL_UNITS = ['bytes', 'records', 'rows', 'ratio'] as const;
const ALL_BOUNDS = FATAL_LIMIT_PAIRS.map(({ bound }) => bound);
const fixtures: SessionIntegrityFixtureRoot[] = [];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function declarationCompare(values: readonly string[], left: string, right: string): number {
  return values.indexOf(left) - values.indexOf(right);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function schemaErrorText(): string {
  return (validateSchema.errors ?? [])
    .map(
      (error) =>
        `${error.instancePath ?? error.dataPath ?? '<root>'} ${error.keyword ?? ''} ${error.message ?? ''}`
    )
    .join('\n');
}

function expectSchemaValid(value: unknown, label = 'fixture'): void {
  const valid = validateSchema(value);
  expect(valid, `${label} must satisfy the frozen schema:\n${schemaErrorText()}`).toBe(true);
}

function expectSchemaInvalid(value: unknown, label = 'fixture'): void {
  const valid = validateSchema(value);
  expect(valid, `${label} unexpectedly satisfied the frozen schema`).toBe(false);
}

function canonicalArrayErrors(key: string, value: unknown[], path: string): string[] {
  const errors: string[] = [];
  const strings = stringArray(value);
  const roleKeys = new Set([
    'sources',
    'sourceRoles',
    'expectedSourceRoles',
    'loadedSourceRoles',
    'omittedSourceRoles',
    'failedSourceRoles',
  ]);
  if (strings && roleKeys.has(key)) {
    const sorted = [...strings].sort((left, right) =>
      declarationCompare(SOURCE_ROLE_ORDER, left, right)
    );
    if (JSON.stringify(strings) !== JSON.stringify(sorted)) {
      errors.push(`${path} is not in SourceRole declaration order`);
    }
  }
  if (strings && key === 'reasonCodes') {
    const sorted = [...strings].sort((left, right) =>
      declarationCompare(REASON_ORDER, left, right)
    );
    if (JSON.stringify(strings) !== JSON.stringify(sorted)) {
      errors.push(`${path} is not in ResolutionReasonCode declaration order`);
    }
  }
  if (strings && key === 'workspacePaths') {
    const sorted = [...strings].sort(codePointCompare);
    if (JSON.stringify(strings) !== JSON.stringify(sorted)) {
      errors.push(`${path} is not in normalized code-point order`);
    }
  }
  if (key === 'workspaceMemberships' && value.every(isRecord)) {
    const paths = value.map((membership) => String(membership['workspacePath']));
    if (JSON.stringify(paths) !== JSON.stringify([...paths].sort(codePointCompare))) {
      errors.push(`${path} is not in workspace-path code-point order`);
    }
  }
  if (key === 'sourceInstances' && value.every(isRecord)) {
    const compareInstances = (left: JsonRecord, right: JsonRecord): number => {
      const byRole = declarationCompare(
        SOURCE_ROLE_ORDER,
        String(left['sourceRole']),
        String(right['sourceRole'])
      );
      if (byRole !== 0) return byRole;
      const byRepresentation = declarationCompare(
        REPRESENTATION_ORDER,
        String(left['representation']),
        String(right['representation'])
      );
      if (byRepresentation !== 0) return byRepresentation;
      const leftPaths = stringArray(left['workspacePaths']) ?? [];
      const rightPaths = stringArray(right['workspacePaths']) ?? [];
      const byPaths = codePointCompare(leftPaths.join('\0'), rightPaths.join('\0'));
      if (byPaths !== 0) return byPaths;
      return declarationCompare(
        INSTANCE_STATE_ORDER,
        String(left['state']),
        String(right['state'])
      );
    };
    const sorted = [...value].sort(compareInstances);
    if (JSON.stringify(value) !== JSON.stringify(sorted)) {
      errors.push(`${path} is not in canonical source-instance order`);
    }
  }
  return errors;
}

function semanticContractErrors(value: unknown): string[] {
  const errors: string[] = [];

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(node)) return;

    for (const [key, member] of Object.entries(node)) {
      const memberPath = `${path}.${key}`;
      if (FORBIDDEN_LOCATOR_KEYS.has(key)) errors.push(`${memberPath} exposes a source locator`);
      if (Array.isArray(member)) errors.push(...canonicalArrayErrors(key, member, memberPath));
      if (key === 'workspacePath' && member === 'unknown') {
        errors.push(`${memberPath} confuses the library alias with a CLI path`);
      }
      if (key === 'occurrenceRefs' || key === 'diagnosticOccurrenceRefs') {
        const refs = stringArray(member);
        if (refs && refs.some((ref) => !/^occurrence:v1:[0-9a-f]{64}$/u.test(ref))) {
          errors.push(`${memberPath} contains a non-opaque occurrence reference`);
        }
      }
      visit(member, memberPath);
    }

    if (node['messageIdentityVersion'] === 1) {
      if (node['workspacePath'] === null && 'canonicalWorkspacePath' in node) {
        errors.push(`${path} is pathless but emits canonicalWorkspacePath`);
      }
      if (
        typeof node['canonicalWorkspacePath'] === 'string' &&
        node['workspacePath'] !== node['canonicalWorkspacePath']
      ) {
        errors.push(`${path}.workspacePath does not preserve the canonical compatibility path`);
      }
    }
    if (isRecord(node['resolution'])) {
      const state = node['resolution']['state'];
      const expectedSource = state === 'complete' ? 'global' : 'workspace-fallback';
      if (node['source'] !== expectedSource) {
        errors.push(`${path}.source does not agree with resolution.state`);
      }
      if ('resolutionState' in node && node['resolutionState'] !== state) {
        errors.push(`${path}.resolutionState does not agree with resolution.state`);
      }
    }
    if (node['resolutionState'] === 'ambiguous') {
      for (const forbidden of ['messages', 'preview', 'title', 'messageCount', 'resolution']) {
        if (forbidden in node) errors.push(`${path}.${forbidden} exposes contested data`);
      }
    }
    if (Array.isArray(node['sessions']) && typeof node['count'] === 'number') {
      if (node['count'] !== node['sessions'].length) {
        errors.push(`${path}.count does not count logical session rows`);
      }
      for (const session of node['sessions']) {
        if (!isRecord(session) || node['indexScope'] === undefined) continue;
        if (session['indexScope'] !== node['indexScope']) {
          errors.push(`${path}.indexScope disagrees with a session row`);
        }
        if (node['indexScope'] === 'workspace') {
          if (session['indexWorkspacePath'] !== node['indexWorkspacePath']) {
            errors.push(`${path}.indexWorkspacePath disagrees with a session row`);
          }
        }
      }
    }
    if (Array.isArray(node['results']) && typeof node['count'] === 'number') {
      if (node['count'] !== node['results'].length) {
        errors.push(`${path}.count does not count search result rows`);
      }
      const matchTotal = node['results'].reduce(
        (total, result) =>
          total +
          (isRecord(result) && typeof result['matchCount'] === 'number' ? result['matchCount'] : 0),
        0
      );
      if (node['totalMatches'] !== matchTotal) {
        errors.push(`${path}.totalMatches does not equal the result match total`);
      }
    }
    if (Array.isArray(node['files']) && typeof node['count'] === 'number') {
      if (node['count'] !== node['files'].length) {
        errors.push(`${path}.count does not count exported files`);
      }
    }
  };

  visit(value, '$');
  if (JSON.stringify(value).includes(SOURCE_LOCATOR_SENTINEL)) {
    errors.push('output contains the private source-locator sentinel');
  }
  return errors;
}

function expectContractValid(value: unknown, label = 'fixture'): void {
  expectSchemaValid(value, label);
  expect(semanticContractErrors(value), `${label} violates semantic contract`).toEqual([]);
}

function expectSemanticInvalid(value: unknown, messagePattern: RegExp): void {
  expectSchemaValid(value, 'semantic mutation');
  expect(semanticContractErrors(value).some((message) => messagePattern.test(message))).toBe(true);
}

function completeSummary(indexScope: 'global' | 'workspace' = 'global'): JsonRecord {
  const workspaceAddress =
    indexScope === 'workspace' ? { indexScope, indexWorkspacePath: '/work/a' } : { indexScope };
  return {
    index: 1,
    ...workspaceAddress,
    id: 'aaaaaaaa-0000-0000-0000-000000000096',
    title: 'Complete merged session',
    preview: 'Complete preview',
    messageCount: 2,
    source: 'global',
    resolvedSource: 'merged',
    sources: ['composer', 'store'],
    preferredSource: 'store',
    resolution: {
      state: 'complete',
      expectedSourceRoles: ['composer', 'store'],
      loadedSourceRoles: ['composer', 'store'],
      omittedSourceRoles: [],
      failedSourceRoles: [],
      reasonCodes: [],
    },
    createdAt: '2026-08-05T12:00:00.000Z',
    createdAtSource: 'composer-metadata',
    lastUpdatedAt: '2026-08-05T12:10:00.000Z',
    lastUpdatedAtSource: 'direct-message',
    workspacePath: '/work/a',
    canonicalWorkspacePath: '/work/a',
    ...(indexScope === 'workspace'
      ? { matchedWorkspacePath: '/work/a', workspaceMatchKind: 'exact' }
      : {}),
    workspaceMemberships: [
      {
        workspacePath: '/work/a',
        sourceRoles: ['composer', 'store'],
        contributingInstanceCount: 3,
      },
      { workspacePath: '/work/z', sourceRoles: ['store'], contributingInstanceCount: 1 },
    ],
    sourceInstances: [
      {
        sourceRole: 'composer',
        representation: 'composer-global',
        workspacePaths: ['/work/a'],
        state: 'contributed',
      },
      {
        sourceRole: 'composer',
        representation: 'composer-workspace',
        workspacePaths: ['/work/a'],
        state: 'superseded',
      },
      {
        sourceRole: 'store',
        representation: 'store-db',
        workspacePaths: ['/work/a', '/work/z'],
        state: 'contributed',
      },
      {
        sourceRole: 'store',
        representation: 'store-transcript',
        workspacePaths: [],
        state: 'superseded',
      },
    ],
    messageIdentityVersion: 1,
    resolutionState: 'complete',
  };
}

function partialSummary(): JsonRecord {
  return {
    index: 1,
    indexScope: 'workspace',
    indexWorkspacePath: '/work/a',
    id: 'bbbbbbbb-0000-0000-0000-000000000096',
    title: 'Partial Store fallback',
    preview: 'Partial preview',
    messageCount: 1,
    source: 'workspace-fallback',
    resolvedSource: 'store-transcript',
    sources: ['store'],
    resolution: {
      state: 'partial',
      expectedSourceRoles: ['store'],
      loadedSourceRoles: ['store'],
      omittedSourceRoles: [],
      failedSourceRoles: ['store'],
      reasonCodes: ['source-partial', 'expected-store-db-unavailable'],
    },
    createdAt: '2026-08-05T12:00:00.000Z',
    createdAtSource: 'store-meta',
    lastUpdatedAt: '2026-08-05T12:01:00.000Z',
    lastUpdatedAtSource: 'direct-message',
    workspacePath: '/work/a',
    canonicalWorkspacePath: '/work/a',
    matchedWorkspacePath: '/work/a',
    workspaceMatchKind: 'exact',
    workspaceMemberships: [
      { workspacePath: '/work/a', sourceRoles: ['store'], contributingInstanceCount: 2 },
    ],
    sourceInstances: [
      {
        sourceRole: 'store',
        representation: 'store-db',
        workspacePaths: ['/work/a'],
        state: 'failed',
      },
      {
        sourceRole: 'store',
        representation: 'store-transcript',
        workspacePaths: ['/work/a'],
        state: 'contributed',
      },
    ],
    messageIdentityVersion: 1,
    resolutionState: 'partial',
  };
}

function ambiguousSummary(): JsonRecord {
  return {
    index: 2,
    indexScope: 'workspace',
    indexWorkspacePath: '/work/a',
    id: 'cccccccc-0000-0000-0000-000000000096',
    resolutionState: 'ambiguous',
    sourceRoles: ['composer'],
    occurrenceCount: 2,
    diagnosticOccurrenceRefs: [
      `occurrence:v1:${'1'.repeat(64)}`,
      `occurrence:v1:${'2'.repeat(64)}`,
    ],
  };
}

function globalListFixture(): JsonRecord {
  return { count: 1, indexScope: 'global', sessions: [completeSummary()] };
}

function workspaceListFixture(): JsonRecord {
  return {
    count: 2,
    indexScope: 'workspace',
    indexWorkspacePath: '/work/a',
    sessions: [partialSummary(), ambiguousSummary()],
    diagnostics: [
      {
        code: 'SESSION_AMBIGUOUS',
        message: 'The logical session has divergent Composer replicas.',
        sessionId: 'cccccccc-0000-0000-0000-000000000096',
        occurrenceCount: 2,
        occurrenceRefs: [`occurrence:v1:${'1'.repeat(64)}`, `occurrence:v1:${'2'.repeat(64)}`],
        remedy: 'Resolve the duplicate data and retry.',
      },
    ],
  };
}

function summaryEnvelope(summary: JsonRecord): JsonRecord {
  const workspaceScoped = summary['indexScope'] === 'workspace';
  return {
    count: 1,
    indexScope: workspaceScoped ? 'workspace' : 'global',
    ...(workspaceScoped ? { indexWorkspacePath: summary['indexWorkspacePath'] } : {}),
    sessions: [summary],
  };
}

function pathlessShowFixture(): JsonRecord {
  return {
    index: 3,
    indexScope: 'global',
    id: 'dddddddd-0000-0000-0000-000000000096',
    title: 'Pathless Store session',
    messageCount: 1,
    source: 'global',
    resolvedSource: 'store-transcript',
    sources: ['store'],
    resolution: {
      state: 'complete',
      expectedSourceRoles: ['store'],
      loadedSourceRoles: ['store'],
      omittedSourceRoles: [],
      failedSourceRoles: [],
      reasonCodes: [],
    },
    createdAt: '1970-01-01T00:00:00.000Z',
    createdAtSource: 'epoch-unknown',
    lastUpdatedAt: '1970-01-01T00:00:00.000Z',
    lastUpdatedAtSource: 'epoch-unknown',
    workspacePath: null,
    workspaceMemberships: [],
    sourceInstances: [
      {
        sourceRole: 'store',
        representation: 'store-transcript',
        workspacePaths: [],
        state: 'contributed',
      },
    ],
    messageIdentityVersion: 1,
    messages: [
      {
        id: `store:v1:transcript:${'a'.repeat(64)}:1`,
        messageIdentityVersion: 1,
        identityOrigin: 'store-transcript-v1',
        role: 'assistant',
        content: 'Pathless answer',
        timestamp: '1970-01-01T00:00:00.000Z',
        timestampSource: 'unknown',
        toolCalls: [
          {
            id: `tool:v1:${'b'.repeat(64)}:1`,
            identityOrigin: 'tool-v1',
            name: 'Read',
            status: 'completed',
          },
        ],
      },
    ],
  };
}

function searchFixture(): JsonRecord {
  return {
    query: 'needle-a',
    count: 1,
    totalMatches: 2,
    indexScope: 'workspace',
    indexWorkspacePath: '/work/a',
    results: [
      {
        index: 1,
        indexScope: 'workspace',
        indexWorkspacePath: '/work/a',
        sessionId: 'aaaaaaaa-0000-0000-0000-000000000096',
        workspacePath: '/work/a',
        matchedWorkspacePath: '/work/a',
        matchCount: 2,
        snippets: [],
      },
    ],
    diagnostics: [],
  };
}

function exportFixture(indexScope: 'global' | 'workspace'): JsonRecord {
  return {
    count: 1,
    files: [
      {
        index: 1,
        indexScope,
        ...(indexScope === 'workspace' ? { indexWorkspacePath: '/work/a' } : {}),
        sessionId: 'aaaaaaaa-0000-0000-0000-000000000096',
        path: '/exports/session.json',
      },
    ],
    diagnostics: [],
  };
}

function partialDiagnostic(pair: LimitPair, observedAtLeast = 2): JsonRecord {
  return {
    code: 'SOURCE_LIMIT_EXCEEDED',
    message: `${pair.bound} exceeded`,
    policyVersion: 'source-read-limits/v1',
    sourceKind: pair.sourceKind,
    bound: pair.bound,
    limit: 1,
    observedAtLeast,
    unit: pair.unit,
    outcome: 'partial',
    retryableWithOverride: true,
    remedy: 'Raise the named limit and retry.',
  };
}

function partialEnvelope(diagnostic: JsonRecord): JsonRecord {
  return { count: 0, sessions: [], diagnostics: [diagnostic] };
}

function fatalLimit(pair: LimitPair, observedAtLeast = 2): JsonRecord {
  return {
    error: `${pair.bound} exceeded`,
    code: 'SOURCE_LIMIT_EXCEEDED',
    details: {
      policyVersion: 'source-read-limits/v1',
      sourceKind: pair.sourceKind,
      bound: pair.bound,
      limit: 1,
      observedAtLeast,
      unit: pair.unit,
      outcome: 'fatal',
      retryableWithOverride: true,
      remedy: 'Raise the named limit and retry.',
    },
  };
}

function pairKey(pair: LimitPair): string {
  return `${pair.sourceKind}\0${pair.bound}\0${pair.unit}`;
}

function deleteAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  const clone = structuredClone(value);
  let cursor: unknown = clone;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === 'number' && Array.isArray(cursor)) cursor = cursor[segment];
    else if (typeof segment === 'string' && isRecord(cursor)) cursor = cursor[segment];
    else throw new Error(`Cannot traverse required-field mutation ${path.join('.')}`);
  }
  const leaf = path.at(-1)!;
  if (typeof leaf === 'number' && Array.isArray(cursor)) cursor.splice(leaf, 1);
  else if (typeof leaf === 'string' && isRecord(cursor)) delete cursor[leaf];
  else throw new Error(`Cannot delete required-field mutation ${path.join('.')}`);
  return clone;
}

async function executeJsonFixture(
  label: string,
  args: readonly string[],
  fixture: SessionIntegrityFixtureRoot
): Promise<{ label: string; value?: unknown; errors: string[] }> {
  const run = await runBuiltCli(args, {
    ...(process.env['CURSOR_HISTORY_SCHEMA_CLI_PATH']
      ? { cliPath: process.env['CURSOR_HISTORY_SCHEMA_CLI_PATH'] }
      : {}),
    env: { CURSOR_STORE_ROOT: fixture.storeRoot },
    timeoutMs: 20_000,
  });
  const errors: string[] = [];
  if (run.status !== 0 || run.signal !== null || run.timedOut) {
    errors.push(
      `${label}: status=${String(run.status)} signal=${String(run.signal)} timedOut=${String(run.timedOut)} stderr=${run.stderr}`
    );
  }
  if (run.stderr !== '') errors.push(`${label}: unexpected stderr ${run.stderr}`);
  try {
    return { label, value: JSON.parse(run.stdout) as unknown, errors };
  } catch (error) {
    errors.push(`${label}: stdout is not one JSON value (${String(error)}): ${run.stdout}`);
    return { label, errors };
  }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('frozen structured-output schema oracle', () => {
  it('locks the exact schema revision and draft identity', () => {
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toBe(FROZEN_SCHEMA_SHA256);
    expect(frozenSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'urn:cursor-history:schema:session-integrity:v1',
    });
  });

  it('accepts list/show/search/export, both index scopes, and every resolved union member', () => {
    for (const [label, fixture] of [
      ['global list', globalListFixture()],
      ['workspace partial/ambiguous list', workspaceListFixture()],
      ['pathless show', pathlessShowFixture()],
      ['workspace search', searchFixture()],
      ['global export', exportFixture('global')],
      ['workspace export', exportFixture('workspace')],
    ] as const) {
      expectContractValid(fixture, label);
    }
  });

  it('rejects removal of required envelope, address, metadata, message, tool, and diagnostic fields', () => {
    const cases: Array<[string, unknown, readonly (string | number)[][]]> = [
      [
        'list',
        globalListFixture(),
        [
          ['count'],
          ['sessions'],
          ['sessions', 0, 'index'],
          ['sessions', 0, 'indexScope'],
          ['sessions', 0, 'id'],
          ['sessions', 0, 'source'],
          ['sessions', 0, 'resolvedSource'],
          ['sessions', 0, 'sources'],
          ['sessions', 0, 'resolution'],
          ['sessions', 0, 'createdAt'],
          ['sessions', 0, 'createdAtSource'],
          ['sessions', 0, 'lastUpdatedAt'],
          ['sessions', 0, 'lastUpdatedAtSource'],
          ['sessions', 0, 'workspacePath'],
          ['sessions', 0, 'workspaceMemberships'],
          ['sessions', 0, 'sourceInstances'],
          ['sessions', 0, 'messageIdentityVersion'],
          ['sessions', 0, 'title'],
          ['sessions', 0, 'preview'],
          ['sessions', 0, 'messageCount'],
          ['sessions', 0, 'resolutionState'],
          ['sessions', 0, 'resolution', 'state'],
          ['sessions', 0, 'resolution', 'expectedSourceRoles'],
          ['sessions', 0, 'resolution', 'loadedSourceRoles'],
          ['sessions', 0, 'resolution', 'omittedSourceRoles'],
          ['sessions', 0, 'resolution', 'failedSourceRoles'],
          ['sessions', 0, 'resolution', 'reasonCodes'],
          ['sessions', 0, 'workspaceMemberships', 0, 'workspacePath'],
          ['sessions', 0, 'workspaceMemberships', 0, 'sourceRoles'],
          ['sessions', 0, 'workspaceMemberships', 0, 'contributingInstanceCount'],
          ['sessions', 0, 'sourceInstances', 0, 'sourceRole'],
          ['sessions', 0, 'sourceInstances', 0, 'representation'],
          ['sessions', 0, 'sourceInstances', 0, 'workspacePaths'],
          ['sessions', 0, 'sourceInstances', 0, 'state'],
        ],
      ],
      [
        'show',
        pathlessShowFixture(),
        [
          ['messages'],
          ['messages', 0, 'id'],
          ['messages', 0, 'messageIdentityVersion'],
          ['messages', 0, 'identityOrigin'],
          ['messages', 0, 'role'],
          ['messages', 0, 'content'],
          ['messages', 0, 'timestamp'],
          ['messages', 0, 'timestampSource'],
          ['messages', 0, 'toolCalls', 0, 'id'],
          ['messages', 0, 'toolCalls', 0, 'identityOrigin'],
          ['messages', 0, 'toolCalls', 0, 'name'],
          ['messages', 0, 'toolCalls', 0, 'status'],
        ],
      ],
      [
        'search',
        searchFixture(),
        [
          ['query'],
          ['count'],
          ['totalMatches'],
          ['results'],
          ['results', 0, 'index'],
          ['results', 0, 'indexScope'],
          ['results', 0, 'indexWorkspacePath'],
          ['results', 0, 'sessionId'],
          ['results', 0, 'matchCount'],
          ['results', 0, 'snippets'],
        ],
      ],
      [
        'export',
        exportFixture('workspace'),
        [
          ['count'],
          ['files'],
          ['files', 0, 'index'],
          ['files', 0, 'indexScope'],
          ['files', 0, 'indexWorkspacePath'],
          ['files', 0, 'sessionId'],
          ['files', 0, 'path'],
        ],
      ],
    ];

    for (const [label, fixture, paths] of cases) {
      for (const path of paths) {
        expectSchemaInvalid(deleteAtPath(fixture, path), `${label} missing ${path.join('.')}`);
      }
    }
  });

  it('locks pathless null versus the public-library unknown alias', () => {
    const valid = pathlessShowFixture();
    expectContractValid(valid, 'pathless show');
    expect(valid).toHaveProperty('workspacePath', null);
    expect(valid).not.toHaveProperty('canonicalWorkspacePath');

    const aliasLeak = { ...valid, workspacePath: 'unknown' };
    expectSemanticInvalid(aliasLeak, /library alias/u);
    const contradictoryCanonical = { ...valid, canonicalWorkspacePath: '/invented/path' };
    expectSemanticInvalid(contradictoryCanonical, /pathless/u);
    expectSchemaInvalid(deleteAtPath(valid, ['workspacePath']), 'missing pathless marker');
  });

  it('enforces canonical array ordering beyond structural uniqueness', () => {
    const complete = completeSummary();
    const reversedSources = { ...complete, sources: ['store', 'composer'] };
    expectSemanticInvalid(summaryEnvelope(reversedSources), /SourceRole declaration order/u);

    const reversedInstances = {
      ...complete,
      sourceInstances: [...(complete['sourceInstances'] as unknown[])].reverse(),
    };
    expectSemanticInvalid(summaryEnvelope(reversedInstances), /source-instance order/u);

    const reversedMemberships = {
      ...complete,
      workspaceMemberships: [...(complete['workspaceMemberships'] as unknown[])].reverse(),
    };
    expectSemanticInvalid(summaryEnvelope(reversedMemberships), /workspace-path code-point order/u);

    const unsortedInstancePaths = structuredClone(complete);
    (unsortedInstancePaths['sourceInstances'] as JsonRecord[])[2]!['workspacePaths'] = [
      '/work/z',
      '/work/a',
    ];
    expectSemanticInvalid(summaryEnvelope(unsortedInstancePaths), /normalized code-point order/u);

    const partial = partialSummary();
    const reversedReasons = structuredClone(partial);
    (reversedReasons['resolution'] as JsonRecord)['reasonCodes'] = [
      'expected-store-db-unavailable',
      'source-partial',
    ];
    expectSemanticInvalid(
      summaryEnvelope(reversedReasons),
      /ResolutionReasonCode declaration order/u
    );
  });

  it('rejects raw physical locator fields and non-opaque diagnostic references', () => {
    const leaked = {
      ...completeSummary(),
      storeDbPath: SOURCE_LOCATOR_SENTINEL,
    };
    expectSemanticInvalid(summaryEnvelope(leaked), /source locator/u);

    const ambiguous = ambiguousSummary();
    ambiguous['diagnosticOccurrenceRefs'] = [
      '/tmp/raw/session.db',
      `occurrence:v1:${'2'.repeat(64)}`,
    ];
    const envelope = workspaceListFixture();
    envelope['sessions'] = [partialSummary(), ambiguous];
    expectSemanticInvalid(envelope, /non-opaque occurrence reference/u);
  });
});

describe('Source Read Limits diagnostic schema', () => {
  it('accepts every exact partial and fatal source-kind/bound/unit pairing', () => {
    expect(new Set(PARTIAL_LIMIT_PAIRS.map(({ bound }) => bound))).toEqual(
      new Set(ALL_BOUNDS.filter((bound) => !bound.startsWith('zip-')))
    );
    expect(new Set(FATAL_LIMIT_PAIRS.map(({ bound }) => bound))).toEqual(new Set(ALL_BOUNDS));

    for (const pair of PARTIAL_LIMIT_PAIRS) {
      expectContractValid(partialEnvelope(partialDiagnostic(pair)), `partial ${pair.bound}`);
    }
    for (const pair of FATAL_LIMIT_PAIRS) {
      const observed = pair.unit === 'ratio' ? 200.5 : 2;
      expectContractValid(fatalLimit(pair, observed), `fatal ${pair.bound}`);
    }
  });

  it('rejects every wrong source-kind/bound/unit Cartesian pairing', () => {
    const partialAllowed = new Set(PARTIAL_LIMIT_PAIRS.map(pairKey));
    const fatalAllowed = new Set(FATAL_LIMIT_PAIRS.map(pairKey));
    let rejectedPartial = 0;
    let rejectedFatal = 0;

    for (const sourceKind of ALL_SOURCE_KINDS) {
      for (const bound of ALL_BOUNDS) {
        for (const unit of ALL_UNITS) {
          const pair = { sourceKind, bound, unit } satisfies LimitPair;
          if (!partialAllowed.has(pairKey(pair))) {
            expectSchemaInvalid(
              partialEnvelope(partialDiagnostic(pair)),
              `wrong partial ${sourceKind}/${bound}/${unit}`
            );
            rejectedPartial++;
          }
          if (!fatalAllowed.has(pairKey(pair))) {
            expectSchemaInvalid(fatalLimit(pair), `wrong fatal ${sourceKind}/${bound}/${unit}`);
            rejectedFatal++;
          }
        }
      }
    }

    expect(rejectedPartial).toBe(
      ALL_SOURCE_KINDS.length * ALL_BOUNDS.length * ALL_UNITS.length - PARTIAL_LIMIT_PAIRS.length
    );
    expect(rejectedFatal).toBe(
      ALL_SOURCE_KINDS.length * ALL_BOUNDS.length * ALL_UNITS.length - FATAL_LIMIT_PAIRS.length
    );
  });

  it('requires integer byte/count/row observations but permits a fractional ZIP ratio', () => {
    for (const pair of FATAL_LIMIT_PAIRS.filter(({ unit }) => unit !== 'ratio')) {
      expectSchemaValid(fatalLimit(pair, 2), `integer ${pair.bound}`);
      expectSchemaInvalid(fatalLimit(pair, 1.5), `fractional ${pair.bound}`);
    }
    const ratio = FATAL_LIMIT_PAIRS.find(({ bound }) => bound === 'zip-compression-ratio')!;
    expectSchemaValid(fatalLimit(ratio, 200.5), 'fractional ZIP ratio');
    expectSchemaValid(fatalLimit(ratio, 201), 'integer ZIP ratio');
  });

  it('allows ZIP limits only as fatal details, never as successful diagnostics', () => {
    for (const pair of FATAL_LIMIT_PAIRS.filter(({ sourceKind }) => sourceKind === 'zip')) {
      expectSchemaValid(
        fatalLimit(pair, pair.unit === 'ratio' ? 200.5 : 2),
        `fatal ZIP ${pair.bound}`
      );
      expectSchemaInvalid(partialEnvelope(partialDiagnostic(pair)), `partial ZIP ${pair.bound}`);
    }
  });
});

describe('built CLI schema fixtures', () => {
  it('validates list/show/search/export output from global, workspace, and pathless reads', async () => {
    const fixture = createSessionIntegrityFixtureRoot('ch-cli-schema-');
    fixtures.push(fixture);
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
    writeStoreTranscript(fixture, 'pathless', SESSION_INTEGRITY_IDS.storeOnly, [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'pathless-schema-needle' }] },
      },
    ]);

    const exportRoot = join(fixture.root, 'exports');
    mkdirSync(exportRoot, { recursive: true });
    const workspaceExportPath = join(exportRoot, 'workspace-a.json');
    const pathlessExportPath = join(exportRoot, 'pathless.json');
    const common = ['--json', '--data-path', fixture.workspaceStorage] as const;
    const workspace = ['--workspace', fixture.projectA] as const;
    const commands: Array<[string, readonly string[]]> = [
      ['global list', [...common, 'list', '--all']],
      ['workspace list', [...common, ...workspace, 'list', '--all']],
      ['global show', [...common, 'show', sessionB.id]],
      ['workspace show', [...common, ...workspace, 'show', '1']],
      ['pathless show', [...common, 'show', SESSION_INTEGRITY_IDS.storeOnly]],
      ['workspace search', [...common, ...workspace, 'search', 'needle-a']],
      ['global search', [...common, 'search', 'needle-b']],
      ['pathless search', [...common, 'search', 'pathless-schema-needle']],
      [
        'workspace export result',
        [
          ...common,
          ...workspace,
          'export',
          '1',
          '--format',
          'json',
          '--output',
          workspaceExportPath,
          '--force',
        ],
      ],
      [
        'pathless export result',
        [
          ...common,
          'export',
          SESSION_INTEGRITY_IDS.storeOnly,
          '--format',
          'json',
          '--output',
          pathlessExportPath,
          '--force',
        ],
      ],
    ];

    const failures: string[] = [];
    let pathlessSearchOutput: unknown;
    for (const [label, args] of commands) {
      const result = await executeJsonFixture(label, args, fixture);
      failures.push(...result.errors);
      if (label === 'pathless search') pathlessSearchOutput = result.value;
      if (result.value !== undefined) {
        if (!validateSchema(result.value)) {
          failures.push(`${label}: ${schemaErrorText()}`);
        } else {
          failures.push(
            ...semanticContractErrors(result.value).map((error) => `${label}: ${error}`)
          );
        }
      }
    }

    for (const [label, path] of [
      ['workspace exported session', workspaceExportPath],
      ['pathless exported session', pathlessExportPath],
    ] as const) {
      if (!existsSync(path)) {
        failures.push(`${label}: expected export file was not written`);
        continue;
      }
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!validateSchema(value)) failures.push(`${label}: ${schemaErrorText()}`);
      else failures.push(...semanticContractErrors(value).map((error) => `${label}: ${error}`));
    }

    expect(sessionA.id).not.toBe(sessionB.id);
    expect(failures).toEqual([]);
    expect(pathlessSearchOutput).toMatchObject({
      count: 1,
      results: [
        expect.objectContaining({
          sessionId: SESSION_INTEGRITY_IDS.storeOnly,
          workspacePath: null,
        }),
      ],
    });
    expect((pathlessSearchOutput as { results: JsonRecord[] }).results[0]).not.toHaveProperty(
      'canonicalWorkspacePath'
    );
  });
});
