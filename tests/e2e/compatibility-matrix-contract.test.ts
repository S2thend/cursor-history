import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readBackupManifest } from '../../src/core/backup.js';
import { SessionAmbiguityError } from '../../src/core/errors.js';
import {
  buildSessionCatalog,
  hydrateSelectedReplica,
  reconcileReplicaGroup,
  type PhysicalSessionInstance,
  type ReplicaConsumedPayload,
} from '../../src/core/session-catalog.js';
import * as storage from '../../src/core/storage.js';
import { mergeCrossStackSessions } from '../../src/core/store-stack/merge.js';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';
import type { ChatSession, Message } from '../../src/core/types.js';
import {
  createFixtureBackup,
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  writeStoreMeta,
  writeStoreTranscript,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { runBuiltCli } from '../helpers/run-cli.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const specificationPath = join(repositoryRoot, 'specs/016-harden-session-integrity/spec.md');
const designProjectionPath = join(
  repositoryRoot,
  'specs/016-harden-session-integrity/contracts/compatibility-matrix-v1.md'
);
const packagedProjectionPath = join(repositoryRoot, 'docs/compatibility.md');

const MATRIX_HEADERS = Object.freeze([
  'Source representation or resolution scenario',
  'Live default path',
  'Custom data path',
  'Supported backup',
  'Expected result / preferred orientation',
] as const);
const CARRIERS = Object.freeze([
  'Live default path',
  'Custom data path',
  'Supported backup',
] as const);

type Carrier = (typeof CARRIERS)[number];
type Classification = 'Required' | 'Unsupported' | 'N/A';

interface MatrixRow {
  readonly scenario: string;
  readonly 'Live default path': Classification;
  readonly 'Custom data path': Classification;
  readonly 'Supported backup': Classification;
  readonly expected: string;
}

const MATRIX_V1 = Object.freeze([
  {
    scenario: 'Composer global',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'Required',
    expected: 'Complete Composer',
  },
  {
    scenario: 'Composer workspace fallback',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'Required',
    expected: 'Degraded Composer fallback',
  },
  {
    scenario: 'Store database conversation',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Complete Store database',
  },
  {
    scenario: 'Store transcript with no discovered or expected database',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Complete transcript primary',
  },
  {
    scenario: 'Store transcript after an expected database fails',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Degraded transcript fallback',
  },
  {
    scenario: 'Store transcript selected instead of a usable Store database',
    'Live default path': 'Unsupported',
    'Custom data path': 'Unsupported',
    'Supported backup': 'N/A',
    expected: 'Reject; database remains Store backbone',
  },
  {
    scenario: 'Complete Composer/Store merge, Composer-preferred ordering',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Complete merged, Composer-preferred',
  },
  {
    scenario: 'Complete Composer/Store merge, Store-preferred ordering',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Complete merged, Store-preferred',
  },
  {
    scenario:
      'Scoped merged UUID with a known contributor outside the default workspace I/O boundary',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Explicit partial with omitted contributor; never silent single-source completeness',
  },
  {
    scenario: 'Scoped merged UUID with explicit selected-UUID cross-workspace contributor opt-in',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Complete merged with every broadened contributor disclosed',
  },
  {
    scenario: 'Store metadata indicating a possible conversation but no usable payload',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'Metadata-only degraded row',
  },
  {
    scenario: 'Equivalent same-role Composer replicas',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'Required',
    expected: 'One reconciled logical row',
  },
  {
    scenario: 'Divergent same-role Composer replicas',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'Required',
    expected: 'One unresolved ambiguity row',
  },
  {
    scenario: 'Equivalent same-role Store replicas',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'One reconciled logical row',
  },
  {
    scenario: 'Divergent same-role Store replicas',
    'Live default path': 'Required',
    'Custom data path': 'Required',
    'Supported backup': 'N/A',
    expected: 'One unresolved ambiguity row',
  },
  {
    scenario: 'Automatic selection or union of divergent replicas',
    'Live default path': 'Unsupported',
    'Custom data path': 'Unsupported',
    'Supported backup': 'Unsupported',
    expected: 'Reject; never resolve silently',
  },
] as const satisfies readonly MatrixRow[]);

interface MatrixCellEvidence {
  readonly classification: Classification;
  readonly evidenceId: string;
}

function required(evidenceId: string): MatrixCellEvidence {
  return Object.freeze({ classification: 'Required', evidenceId });
}

function unsupported(evidenceId: string): MatrixCellEvidence {
  return Object.freeze({ classification: 'Unsupported', evidenceId });
}

function notApplicable(evidenceId: string): MatrixCellEvidence {
  return Object.freeze({ classification: 'N/A', evidenceId });
}

/** Explicit executable-evidence assignment for every one of the 16 x 3 Matrix v1 cells. */
const MATRIX_EVIDENCE = Object.freeze({
  'Composer global': {
    'Live default path': required('composer-global/live-default'),
    'Custom data path': required('composer-global/custom-data-path'),
    'Supported backup': required('composer-global/supported-backup'),
  },
  'Composer workspace fallback': {
    'Live default path': required('composer-workspace-fallback/live-default'),
    'Custom data path': required('composer-workspace-fallback/custom-data-path'),
    'Supported backup': required('composer-workspace-fallback/supported-backup'),
  },
  'Store database conversation': {
    'Live default path': required('store-database/live-default'),
    'Custom data path': required('store-database/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/store-database'),
  },
  'Store transcript with no discovered or expected database': {
    'Live default path': required('transcript-primary/live-default'),
    'Custom data path': required('transcript-primary/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/store-transcript-primary'),
  },
  'Store transcript after an expected database fails': {
    'Live default path': required('transcript-fallback/live-default'),
    'Custom data path': required('transcript-fallback/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/store-transcript-fallback'),
  },
  'Store transcript selected instead of a usable Store database': {
    'Live default path': unsupported('usable-database-rejects-transcript/live-default'),
    'Custom data path': unsupported('usable-database-rejects-transcript/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/store-representation-selection'),
  },
  'Complete Composer/Store merge, Composer-preferred ordering': {
    'Live default path': required('merged-composer-backbone/live-default'),
    'Custom data path': required('merged-composer-backbone/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/composer-store-merge'),
  },
  'Complete Composer/Store merge, Store-preferred ordering': {
    'Live default path': required('merged-store-backbone/live-default'),
    'Custom data path': required('merged-store-backbone/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/store-preferred-merge'),
  },
  'Scoped merged UUID with a known contributor outside the default workspace I/O boundary': {
    'Live default path': required('scoped-partial/live-default'),
    'Custom data path': required('scoped-partial/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/scoped-cross-source-partial'),
  },
  'Scoped merged UUID with explicit selected-UUID cross-workspace contributor opt-in': {
    'Live default path': required('scoped-opt-in-complete/live-default'),
    'Custom data path': required('scoped-opt-in-complete/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/scoped-cross-source-opt-in'),
  },
  'Store metadata indicating a possible conversation but no usable payload': {
    'Live default path': required('store-metadata/live-default'),
    'Custom data path': required('store-metadata/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/store-metadata'),
  },
  'Equivalent same-role Composer replicas': {
    'Live default path': required('equivalent-composer-replicas/live-default'),
    'Custom data path': required('equivalent-composer-replicas/custom-data-path'),
    'Supported backup': required('equivalent-composer-replicas/supported-backup'),
  },
  'Divergent same-role Composer replicas': {
    'Live default path': required('divergent-composer-replicas/live-default'),
    'Custom data path': required('divergent-composer-replicas/custom-data-path'),
    'Supported backup': required('divergent-composer-replicas/supported-backup'),
  },
  'Equivalent same-role Store replicas': {
    'Live default path': required('equivalent-store-replicas/live-default'),
    'Custom data path': required('equivalent-store-replicas/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/equivalent-store-replicas'),
  },
  'Divergent same-role Store replicas': {
    'Live default path': required('divergent-store-replicas/live-default'),
    'Custom data path': required('divergent-store-replicas/custom-data-path'),
    'Supported backup': notApplicable('backup-exclusion/divergent-store-replicas'),
  },
  'Automatic selection or union of divergent replicas': {
    'Live default path': unsupported('divergent-union-rejected/live-default'),
    'Custom data path': unsupported('divergent-union-rejected/custom-data-path'),
    'Supported backup': unsupported('divergent-union-rejected/supported-backup'),
  },
} as const satisfies Record<
  (typeof MATRIX_V1)[number]['scenario'],
  Record<Carrier, MatrixCellEvidence>
>);

interface ParsedMatrix {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseMatrixV1(markdown: string): ParsedMatrix {
  const lines = markdown.split(/\r?\n/u);
  const heading = lines.findIndex((line) =>
    /^#{1,6} Compatibility Matrix v1(?:\s+—.*)?\s*$/u.test(line)
  );
  if (heading < 0) throw new Error('Compatibility Matrix v1 heading is missing.');
  const header = lines.findIndex(
    (line, index) => index > heading && splitMarkdownRow(line)[0] === MATRIX_HEADERS[0]
  );
  if (header < 0) throw new Error('Compatibility Matrix v1 table header is missing.');
  const separator = lines[header + 1];
  if (!separator || !splitMarkdownRow(separator).every((cell) => /^-{3,}$/u.test(cell))) {
    throw new Error('Compatibility Matrix v1 table separator is invalid.');
  }
  const rows: string[][] = [];
  for (let index = header + 2; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim().startsWith('|')) break;
    rows.push(splitMarkdownRow(line));
  }
  return Object.freeze({
    headers: Object.freeze(splitMarkdownRow(lines[header]!)),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
}

function expectedTable(): ParsedMatrix {
  return {
    headers: MATRIX_HEADERS,
    rows: MATRIX_V1.map((row) =>
      Object.freeze([
        row.scenario,
        row['Live default path'],
        row['Custom data path'],
        row['Supported backup'],
        row.expected,
      ])
    ),
  };
}

function assertFrozenMatrixV1(actual: ParsedMatrix): void {
  const expected = expectedTable();
  if (
    JSON.stringify(actual.headers) !== JSON.stringify(expected.headers) ||
    JSON.stringify(actual.rows) !== JSON.stringify(expected.rows)
  ) {
    throw new Error(
      'Compatibility Matrix v1 drifted; add a new representation/carrier only with an explicit matrix-version update and complete cell classification.'
    );
  }
}

function cells() {
  return MATRIX_V1.flatMap((row) =>
    CARRIERS.map((carrier) => ({
      row,
      carrier,
      classification: row[carrier],
      evidence: MATRIX_EVIDENCE[row.scenario][carrier],
    }))
  );
}

async function withFixture<T>(
  prefix: string,
  run: (fixture: SessionIntegrityFixtureRoot) => Promise<T> | T
): Promise<T> {
  const fixture = createSessionIntegrityFixtureRoot(prefix);
  const oldStoreRoot = process.env['CURSOR_STORE_ROOT'];
  const oldDataPath = process.env['CURSOR_DATA_PATH'];
  process.env['CURSOR_STORE_ROOT'] = fixture.storeRoot;
  try {
    return await run(fixture);
  } finally {
    fixture.cleanup();
    if (oldStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
    else process.env['CURSOR_STORE_ROOT'] = oldStoreRoot;
    if (oldDataPath === undefined) delete process.env['CURSOR_DATA_PATH'];
    else process.env['CURSOR_DATA_PATH'] = oldDataPath;
  }
}

function composerFixture(
  fixture: SessionIntegrityFixtureRoot,
  id: string,
  content: string
): ComposerFixtureSession {
  return {
    id,
    title: content,
    workspacePath: fixture.projectA,
    createdAt: 1_783_000_000_000,
    messages: [
      {
        id: 'native-composer-message',
        role: 'user',
        content,
        createdAt: 1_783_000_000_000,
      },
    ],
  };
}

async function carrierBinding(
  fixture: SessionIntegrityFixtureRoot,
  carrier: Carrier
): Promise<{ dataPath?: string; backupPath?: string }> {
  if (carrier === 'Live default path') {
    process.env['CURSOR_DATA_PATH'] = fixture.workspaceStorage;
    return {};
  }
  if (carrier === 'Custom data path') return { dataPath: fixture.workspaceStorage };
  return { backupPath: await createFixtureBackup(fixture, 'matrix-v1.zip') };
}

async function executeComposerCell(
  scenario: 'Composer global' | 'Composer workspace fallback',
  carrier: Carrier
): Promise<void> {
  await withFixture('ch-matrix-composer-', async (fixture) => {
    const id =
      scenario === 'Composer global'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222';
    const session = composerFixture(fixture, id, `matrix:${scenario}`);
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [session]);
    if (scenario === 'Composer global') writeComposerGlobalSessions(fixture, [session]);
    const binding = await carrierBinding(fixture, carrier);
    const context = storage.createSessionReadContext(binding);
    try {
      const rows = await storage.listSessions(
        { all: true, limit: 0 },
        binding.dataPath,
        binding.backupPath,
        context
      );
      const row = rows.find((candidate) => candidate.id === id);
      expect(row, `${scenario}/${carrier} must expose one row`).toBeDefined();
      const resolved = await storage.getSession(
        id,
        binding.dataPath,
        binding.backupPath,
        context,
        row!.index
      );
      const expectedSource = scenario === 'Composer global' ? 'global' : 'workspace-fallback';
      const expectedState = scenario === 'Composer global' ? 'complete' : 'partial';
      if (
        !resolved ||
        resolved.id !== id ||
        resolved.source !== expectedSource ||
        resolved.resolvedSource !== 'composer' ||
        resolved.resolution?.state !== expectedState
      ) {
        throw new Error(
          `expected ${expectedSource}/composer/${expectedState}, received ${JSON.stringify({
            id: resolved?.id,
            source: resolved?.source,
            resolvedSource: resolved?.resolvedSource,
            resolution: resolved?.resolution,
            sourceInstances: resolved?.sourceInstances,
          })}`
        );
      }
    } finally {
      await context.dispose();
    }
  });
}

type StoreScenario =
  | 'Store database conversation'
  | 'Store transcript with no discovered or expected database'
  | 'Store transcript after an expected database fails'
  | 'Store transcript selected instead of a usable Store database'
  | 'Store metadata indicating a possible conversation but no usable payload';

async function executeStoreCell(scenario: StoreScenario, carrier: Carrier): Promise<void> {
  await withFixture('ch-matrix-store-', async (fixture) => {
    const id = '33333333-3333-4333-8333-333333333333';
    const dbContent = 'matrix-store-database';
    const transcriptContent = 'matrix-store-transcript';
    if (
      scenario === 'Store database conversation' ||
      scenario === 'Store transcript selected instead of a usable Store database'
    ) {
      const dbPath = writeStoreDb(
        fixture,
        id,
        [{ role: 'assistant', content: dbContent }],
        'Matrix Store DB'
      );
      writeStoreMeta(dirname(dbPath), {
        cwd: fixture.projectA,
        title: 'Matrix Store DB',
        hasConversation: true,
        createdAtMs: 1_783_000_000_000,
      });
    }
    if (
      scenario === 'Store transcript with no discovered or expected database' ||
      scenario === 'Store transcript after an expected database fails' ||
      scenario === 'Store transcript selected instead of a usable Store database'
    ) {
      writeStoreTranscript(fixture, 'matrix-project', id, [
        {
          role: 'user',
          message: { content: [{ type: 'text', text: transcriptContent }] },
        },
      ]);
    }
    if (
      scenario === 'Store transcript after an expected database fails' ||
      scenario === 'Store metadata indicating a possible conversation but no usable payload'
    ) {
      writeStoreMeta(join(fixture.storeRoot, 'chats', 'matrix', id), {
        cwd: fixture.projectA,
        title: 'Matrix expected Store conversation',
        hasConversation: true,
        createdAtMs: 1_783_000_000_000,
      });
    }

    if (carrier === 'Live default path') process.env['CURSOR_DATA_PATH'] = fixture.workspaceStorage;
    const dataPath = carrier === 'Custom data path' ? fixture.workspaceStorage : undefined;
    const sessions = await discoverStoreSessions(fixture.storeRoot);
    const resolved = sessions.find((candidate) => candidate.id === id);
    expect(resolved, `${scenario}/${carrier} must expose Store evidence`).toBeDefined();

    if (scenario === 'Store database conversation') {
      expect(resolved).toMatchObject({
        source: 'global',
        resolvedSource: 'store-db',
        resolution: { state: 'complete' },
      });
      expect(resolved!.messages.map(({ content }) => content)).toContain(dbContent);
    } else if (scenario === 'Store transcript with no discovered or expected database') {
      expect(resolved).toMatchObject({
        source: 'global',
        resolvedSource: 'store-transcript',
        resolution: { state: 'complete' },
      });
    } else if (scenario === 'Store transcript after an expected database fails') {
      expect(resolved).toMatchObject({
        source: 'workspace-fallback',
        resolvedSource: 'store-transcript',
        resolution: {
          state: 'partial',
          reasonCodes: expect.arrayContaining(['expected-store-db-unavailable']),
        },
      });
    } else if (scenario === 'Store transcript selected instead of a usable Store database') {
      expect(resolved).toMatchObject({ resolvedSource: 'store-db' });
      expect(resolved!.messages.map(({ content }) => content)).toContain(dbContent);
      expect(resolved!.messages.map(({ content }) => content)).not.toContain(transcriptContent);
    } else {
      expect(resolved).toMatchObject({
        source: 'workspace-fallback',
        resolvedSource: 'store-metadata',
        resolution: {
          state: 'partial',
          reasonCodes: expect.arrayContaining(['store-conversation-unavailable']),
        },
      });
      expect(resolved!.messages).toEqual([]);
    }

    // Exercise the same representation through the carrier-bound storage entry point as well as
    // direct Store decoding, so the live/custom distinction is not merely an evidence label.
    const context = storage.createSessionReadContext({ dataPath });
    try {
      const rows = await storage.listSessions(
        { all: true, limit: 0 },
        dataPath,
        undefined,
        context
      );
      const row = rows.find((candidate) => candidate.id === id);
      expect(row, `${scenario}/${carrier} must survive catalog projection`).toBeDefined();
      if (scenario !== 'Store metadata indicating a possible conversation but no usable payload') {
        const hydrated = await storage.getSession(id, dataPath, undefined, context, row!.index);
        expect(hydrated?.resolvedSource).toBe(resolved!.resolvedSource);
        expect(hydrated?.messages.map(({ content }) => content)).toEqual(
          resolved!.messages.map(({ content }) => content)
        );
      } else {
        expect(row?.resolvedSource).toBe('store-metadata');
      }
    } finally {
      await context.dispose();
    }
  });
}

function mergedMessage(
  partial: Partial<Message> & { role: 'user' | 'assistant'; content: string }
): Message {
  return { id: null, codeBlocks: [], ...partial };
}

function mergedSession(
  source: ChatSession['source'],
  messages: Message[],
  workspacePath: string
): ChatSession {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: '44444444-4444-4444-8444-444444444444',
    index: 1,
    title: 'Matrix merge',
    createdAt: timestamp,
    createdAtSource: source === 'global' ? 'composer-metadata' : 'store-metadata',
    lastUpdatedAt: timestamp,
    lastUpdatedAtSource: source === 'global' ? 'composer-metadata' : 'store-metadata',
    messageCount: messages.length,
    messages,
    workspaceId: 'matrix-merge',
    workspacePath,
    source,
  };
}

async function executeMergeOrientationCell(
  scenario:
    | 'Complete Composer/Store merge, Composer-preferred ordering'
    | 'Complete Composer/Store merge, Store-preferred ordering',
  carrier: Carrier
): Promise<void> {
  const preferred = scenario.includes('Composer-preferred') ? 'composer' : 'store';
  const composer = mergedSession(
    'global',
    [
      mergedMessage({ id: 'composer-anchor', role: 'user', content: 'anchor' }),
      mergedMessage({ id: null, role: 'assistant', content: 'composer-only' }),
    ],
    `/matrix/${carrier}/composer`
  );
  const store = mergedSession(
    'store-complete',
    [
      mergedMessage({ id: 'store-gap', role: 'assistant', content: 'store-only' }),
      mergedMessage({ id: 'store-anchor', role: 'user', content: 'anchor' }),
    ],
    `/matrix/${carrier}/store`
  );
  const resolved = mergeCrossStackSessions(composer, store, preferred, 1);
  expect(resolved).toMatchObject({
    id: composer.id,
    source: 'global',
    resolvedSource: 'merged',
    sources: ['composer', 'store'],
    preferredSource: preferred,
    resolution: { state: 'complete' },
  });
  expect(resolved.messages.map(({ content }) => content)).toEqual(
    expect.arrayContaining(['anchor', 'composer-only', 'store-only'])
  );
  expect(resolved.messages.find(({ content }) => content === 'anchor')?.id).toBe('composer-anchor');
}

async function executeScopedMergeCell(
  scenario:
    | 'Scoped merged UUID with a known contributor outside the default workspace I/O boundary'
    | 'Scoped merged UUID with explicit selected-UUID cross-workspace contributor opt-in',
  carrier: Carrier
): Promise<void> {
  await withFixture('ch-matrix-scope-', async (fixture) => {
    const id = '55555555-5555-4555-8555-555555555555';
    const composer = composerFixture(fixture, id, 'matrix-composer-scope');
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [composer]);
    writeComposerGlobalSessions(fixture, [composer]);
    const dbPath = writeStoreDb(fixture, id, [
      { role: 'assistant', content: 'matrix-store-off-scope' },
    ]);
    writeStoreMeta(dirname(dbPath), {
      cwd: fixture.projectB,
      hasConversation: true,
      createdAtMs: 1_783_000_000_000,
    });
    if (carrier === 'Live default path') process.env['CURSOR_DATA_PATH'] = fixture.workspaceStorage;
    const dataPath = carrier === 'Custom data path' ? fixture.workspaceStorage : undefined;
    const includeCrossWorkspaceSources = scenario.includes('explicit selected-UUID');
    const context = storage.createSessionReadContext({
      dataPath,
      workspacePath: fixture.projectA,
      includeCrossWorkspaceSources,
    });
    try {
      const rows = await storage.listSessions(
        {
          all: true,
          limit: 0,
          workspacePath: fixture.projectA,
          includeCrossWorkspaceSources,
        },
        dataPath,
        undefined,
        context
      );
      const row = rows.find((candidate) => candidate.id === id);
      expect(row).toBeDefined();
      const resolved = await storage.getSession(id, dataPath, undefined, context, row!.index);
      expect(resolved).not.toBeNull();
      if (includeCrossWorkspaceSources) {
        expect(resolved).toMatchObject({
          source: 'global',
          resolvedSource: 'merged',
          sources: ['composer', 'store'],
          resolution: { state: 'complete' },
        });
        expect(resolved!.messages.map(({ content }) => content)).toContain(
          'matrix-store-off-scope'
        );
      } else {
        expect(resolved).toMatchObject({
          source: 'workspace-fallback',
          resolution: {
            state: 'partial',
            reasonCodes: expect.arrayContaining(['workspace-scope-omitted']),
          },
        });
        expect(resolved!.messages.map(({ content }) => content)).not.toContain(
          'matrix-store-off-scope'
        );
      }
    } finally {
      await context.dispose();
    }
  });
}

function replicaInstance(
  key: string,
  role: 'composer' | 'store',
  carrier: Carrier,
  payload: ReplicaConsumedPayload
): PhysicalSessionInstance<string> {
  return {
    instanceKey: key,
    logicalSessionId: '66666666-6666-4666-8666-666666666666',
    sourceRole: role,
    representation: role === 'composer' ? 'composer-global' : 'store-db',
    fidelityTier: 'complete',
    locator: `${carrier}:${key}`,
    workspacePaths: ['/matrix/replica'],
    sourceOrder: key === 'candidate-a' ? 1 : 2,
    loadConsumedPayload: async () => payload,
  };
}

async function executeReplicaCell(
  scenario:
    | 'Equivalent same-role Composer replicas'
    | 'Divergent same-role Composer replicas'
    | 'Equivalent same-role Store replicas'
    | 'Divergent same-role Store replicas'
    | 'Automatic selection or union of divergent replicas',
  carrier: Carrier
): Promise<void> {
  const role =
    scenario.includes('Composer') || carrier === 'Supported backup' ? 'composer' : 'store';
  const divergent = scenario.startsWith('Divergent') || scenario.startsWith('Automatic');
  const baseline: ReplicaConsumedPayload = {
    messages: [{ id: 'replica-message', role: 'user', content: 'same' }],
  };
  const changed: ReplicaConsumedPayload = divergent
    ? { messages: [{ id: 'replica-message', role: 'user', content: 'changed' }] }
    : {
        messages: [
          {
            id: 'replica-message',
            role: 'user',
            content: 'same',
            timestampSource: 'inferred-previous',
          },
        ],
      };
  const record = buildSessionCatalog([
    replicaInstance('candidate-z', role, carrier, baseline),
    replicaInstance('candidate-a', role, carrier, changed),
  ])[0]!;
  const reconciliation = await reconcileReplicaGroup(record.replicaGroups[0]!, {
    diagnosticContextId: `matrix:${carrier}:${scenario}`,
  });
  if (divergent) {
    expect(reconciliation).toMatchObject({ state: 'divergent' });
    await expect(hydrateSelectedReplica(reconciliation)).rejects.toBeInstanceOf(
      SessionAmbiguityError
    );
  } else {
    expect(reconciliation).toMatchObject({
      state: 'equivalent',
      selected: { instanceKey: 'candidate-a' },
    });
    await expect(hydrateSelectedReplica(reconciliation)).resolves.toMatchObject(baseline);
  }
}

async function executeNotApplicableCell(scenario: string): Promise<void> {
  await withFixture('ch-matrix-na-', async (fixture) => {
    const composer = composerFixture(
      fixture,
      '77777777-7777-4777-8777-777777777777',
      'backup-composer-only'
    );
    writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [composer]);
    writeComposerGlobalSessions(fixture, [composer]);
    const storePath = writeStoreDb(fixture, composer.id, [
      { role: 'assistant', content: `must-not-enter-backup:${scenario}` },
    ]);
    writeStoreMeta(dirname(storePath), { cwd: fixture.projectB, hasConversation: true });
    writeStoreTranscript(fixture, 'matrix-na', composer.id, [
      { role: 'assistant', message: { content: [{ type: 'text', text: 'excluded' }] } },
    ]);

    const backupPath = await createFixtureBackup(fixture, 'matrix-na.zip');
    const manifest = await readBackupManifest(backupPath);
    expect(manifest).not.toBeNull();
    expect(manifest!.files.length).toBeGreaterThan(0);
    expect(
      manifest!.files.every(
        ({ path }) => path.startsWith('globalStorage/') || path.startsWith('workspaceStorage/')
      )
    ).toBe(true);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('store.db');
    expect(serialized).not.toContain('agent-transcripts');
    expect(serialized).not.toContain('meta.json');

    const rows = await storage.listSessions({ all: true, limit: 0 }, undefined, backupPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: composer.id, resolvedSource: 'composer' });
    expect(rows[0]?.resolvedSource).not.toMatch(/^store|merged$/u);
  });
}

async function executeCellEvidence(cell: ReturnType<typeof cells>[number]): Promise<void> {
  const { scenario } = cell.row;
  if (cell.classification === 'N/A') {
    await executeNotApplicableCell(scenario);
  } else if (scenario === 'Composer global' || scenario === 'Composer workspace fallback') {
    await executeComposerCell(scenario, cell.carrier);
  } else if (
    scenario === 'Store database conversation' ||
    scenario === 'Store transcript with no discovered or expected database' ||
    scenario === 'Store transcript after an expected database fails' ||
    scenario === 'Store transcript selected instead of a usable Store database' ||
    scenario === 'Store metadata indicating a possible conversation but no usable payload'
  ) {
    await executeStoreCell(scenario, cell.carrier);
  } else if (
    scenario === 'Complete Composer/Store merge, Composer-preferred ordering' ||
    scenario === 'Complete Composer/Store merge, Store-preferred ordering'
  ) {
    await executeMergeOrientationCell(scenario, cell.carrier);
  } else if (
    scenario ===
      'Scoped merged UUID with a known contributor outside the default workspace I/O boundary' ||
    scenario === 'Scoped merged UUID with explicit selected-UUID cross-workspace contributor opt-in'
  ) {
    await executeScopedMergeCell(scenario, cell.carrier);
  } else {
    await executeReplicaCell(scenario, cell.carrier);
  }
}

function assertNoLocatorLeak(value: unknown): void {
  const forbidden = new Set([
    'locator',
    'instanceKey',
    'dbPath',
    'transcriptPath',
    'recordKey',
    'physicalPath',
  ]);
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.has(key)) throw new Error(`Structured output leaked ${key}.`);
      visit(child);
    }
  };
  visit(value);
}

describe.sequential('Compatibility Matrix v1 finite executable contract', () => {
  it('locks every row and cell in the normative spec and both projections byte-for-value', () => {
    const sources = [
      ['specification', specificationPath],
      ['design projection', designProjectionPath],
      ['packaged projection', packagedProjectionPath],
    ] as const;
    for (const [label, path] of sources) {
      const markdown = readFileSync(path, 'utf8');
      expect(() => assertFrozenMatrixV1(parseMatrixV1(markdown)), label).not.toThrow();
      expect(markdown, `${label} must identify Matrix v1`).toMatch(/Compatibility Matrix v1/u);
    }
    expect(readFileSync(designProjectionPath, 'utf8')).toContain('**Contract version**: `1`');
  });

  it('requires a version update for a new representation or carrier', () => {
    const baseline = expectedTable();
    const newRepresentation: ParsedMatrix = {
      ...baseline,
      rows: [...baseline.rows, ['Future source', 'Required', 'Required', 'N/A', 'Future result']],
    };
    expect(() => assertFrozenMatrixV1(newRepresentation)).toThrow('matrix-version update');

    const newCarrier: ParsedMatrix = {
      headers: [...baseline.headers, 'Future carrier'],
      rows: baseline.rows.map((row) => [...row, 'N/A']),
    };
    expect(() => assertFrozenMatrixV1(newCarrier)).toThrow('matrix-version update');
  });

  it('maps all 48 cells exactly once to classification-matched executable evidence', () => {
    const mapped = cells();
    expect(mapped).toHaveLength(MATRIX_V1.length * CARRIERS.length);
    expect(new Set(mapped.map(({ evidence }) => evidence.evidenceId)).size).toBe(mapped.length);
    for (const cell of mapped) {
      expect(cell.evidence.classification, cell.evidence.evidenceId).toBe(cell.classification);
      expect(cell.evidence.evidenceId).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/u);
    }
    expect(mapped.filter(({ classification }) => classification === 'Required')).toHaveLength(32);
    expect(mapped.filter(({ classification }) => classification === 'Unsupported')).toHaveLength(5);
    expect(mapped.filter(({ classification }) => classification === 'N/A')).toHaveLength(11);
  });

  it('executes every Required cell and every Unsupported rejection', async () => {
    const executable = cells().filter(({ classification }) => classification !== 'N/A');
    const executed = new Set<string>();
    const failures: string[] = [];
    for (const cell of executable) {
      try {
        await executeCellEvidence(cell);
        executed.add(cell.evidence.evidenceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${cell.evidence.evidenceId}: ${message}`);
      }
    }
    expect(
      failures,
      `Matrix v1 Required/Unsupported evidence failures:\n${failures.join('\n')}`
    ).toEqual([]);
    expect(executed).toEqual(new Set(executable.map(({ evidence }) => evidence.evidenceId)));
  }, 120_000);

  it('executes every N/A exclusion against a real Composer-only backup carrier', async () => {
    const excluded = cells().filter(({ classification }) => classification === 'N/A');
    const executed = new Set<string>();
    const failures: string[] = [];
    for (const cell of excluded) {
      try {
        await executeCellEvidence(cell);
        executed.add(cell.evidence.evidenceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${cell.evidence.evidenceId}: ${message}`);
      }
    }
    expect(failures, `Matrix v1 N/A evidence failures:\n${failures.join('\n')}`).toEqual([]);
    expect(executed).toEqual(new Set(excluded.map(({ evidence }) => evidence.evidenceId)));
  }, 120_000);

  it('projects scoped partial and opt-in complete matrix evidence through built structured output', async () => {
    await withFixture('ch-matrix-cli-', async (fixture) => {
      const id = '88888888-8888-4888-8888-888888888888';
      const composer = composerFixture(fixture, id, 'matrix-cli-composer');
      writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [composer]);
      writeComposerGlobalSessions(fixture, [composer]);
      const dbPath = writeStoreDb(fixture, id, [
        { role: 'assistant', content: 'matrix-cli-store' },
      ]);
      writeStoreMeta(dirname(dbPath), {
        cwd: fixture.projectB,
        hasConversation: true,
        createdAtMs: 1_783_000_000_000,
      });
      const base = [
        '--json',
        '--data-path',
        fixture.workspaceStorage,
        '--workspace',
        fixture.projectA,
      ];
      const env = { CURSOR_STORE_ROOT: fixture.storeRoot };
      const list = await runBuiltCli([...base, 'list', '--all'], { env });
      const partial = await runBuiltCli([...base, 'show', '1'], { env });
      const complete = await runBuiltCli(
        [...base, '--include-cross-workspace-sources', 'show', '1'],
        { env }
      );
      const failures: string[] = [];
      const verify = (label: string, run: () => void): void => {
        try {
          run();
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      verify('workspace list', () => {
        expect(list).toMatchObject({ status: 0, stderr: '', timedOut: false });
        const value = JSON.parse(list.stdout) as Record<string, unknown>;
        expect(value).toMatchObject({
          indexScope: 'workspace',
          indexWorkspacePath: fixture.projectA,
        });
        expect(value['sessions']).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id,
              index: 1,
              indexScope: 'workspace',
              indexWorkspacePath: fixture.projectA,
              resolution: expect.objectContaining({ state: 'partial' }),
            }),
          ])
        );
        assertNoLocatorLeak(value);
      });
      verify('scoped partial show', () => {
        expect(partial).toMatchObject({ status: 0, stderr: '', timedOut: false });
        const value = JSON.parse(partial.stdout) as Record<string, unknown>;
        expect(value).toMatchObject({
          id,
          source: 'workspace-fallback',
          indexScope: 'workspace',
          indexWorkspacePath: fixture.projectA,
          resolution: {
            state: 'partial',
            reasonCodes: expect.arrayContaining(['workspace-scope-omitted']),
          },
        });
        assertNoLocatorLeak(value);
      });
      verify('cross-workspace opt-in show', () => {
        expect(complete).toMatchObject({ status: 0, stderr: '', timedOut: false });
        const value = JSON.parse(complete.stdout) as Record<string, unknown>;
        expect(value).toMatchObject({
          id,
          source: 'global',
          resolvedSource: 'merged',
          sources: ['composer', 'store'],
          indexScope: 'workspace',
          indexWorkspacePath: fixture.projectA,
          resolution: { state: 'complete' },
        });
        assertNoLocatorLeak(value);
      });
      expect(
        failures,
        `Built structured Matrix v1 projection failures:\n${failures.join('\n')}`
      ).toEqual([]);
    });
  }, 60_000);
});
