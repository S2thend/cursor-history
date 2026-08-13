import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openObservedDatabase } from '../../src/core/database/observed.js';
import type { DatabaseOperationRequest } from '../../src/core/database/types.js';
import { TemporaryArtifactCleanupError } from '../../src/core/errors.js';
import {
  createOperationIoContext,
  IoObserverError,
  type AdapterIoEvent,
} from '../../src/core/io-observer.js';
import { createPrivateTempWorkspace } from '../../src/core/private-temp.js';
import {
  JsonlSourceReadBudget,
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  resolveSourceReadLimits,
} from '../../src/core/source-read-limits.js';
import * as storage from '../../src/core/storage.js';
import { mergeCrossStackSessions } from '../../src/core/store-stack/merge.js';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';
import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';
import type { ChatSession, Message as CoreMessage } from '../../src/core/types.js';
import type { Message, Session } from '../../src/lib/types.js';
import {
  computeV016MessageDigest,
  initializeV016Archive,
  normalizeCursorSessionV016,
  readV016ArchiveState,
  syncV016Session,
} from '../helpers/v016-consumer.js';
import {
  SESSION_INTEGRITY_IDS,
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeStoreDb,
  writeStoreTranscript,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import {
  assertNoSessionPayloadIo,
  createIoEventRecorder,
  createPoisonCanary,
  createPoisonIoObserver,
} from '../helpers/io-probe.js';

const fixtures: SessionIntegrityFixtureRoot[] = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const sourceLimitEnvironmentKey = 'CURSOR_HISTORY_SOURCE_LIMIT_JSONL_RECORD_BYTES';
const previousSourceLimitEnvironment = process.env[sourceLimitEnvironmentKey];

interface OwnershipSnapshot {
  readonly resolvedSessionCapacity: number;
  readonly activeResolutions: number;
  readonly completedSessions: number;
  readonly discoveryDecodedSessions: number;
  readonly ownedDecodedSessions: number;
  readonly resolutionStarts: number;
}

interface InstrumentedContextOptions extends storage.SessionReadContextOptions {
  readonly testOnlyOnOwnershipChange?: (snapshot: Readonly<OwnershipSnapshot>) => void;
}

function fixture(prefix: string): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot(prefix);
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  if (previousSourceLimitEnvironment === undefined) delete process.env[sourceLimitEnvironmentKey];
  else process.env[sourceLimitEnvironmentKey] = previousSourceLimitEnvironment;
});

function assertAddressAssociation(
  actual: { index: number; id: string; workspacePath?: string },
  expected: { index: number; id: string; workspacePath: string }
): void {
  if (
    actual.index !== expected.index ||
    actual.id !== expected.id ||
    actual.workspacePath !== expected.workspacePath
  ) {
    throw new Error('Scoped index, logical ID, and workspace path no longer describe one row.');
  }
}

function ioContext(
  emit: (event: Readonly<AdapterIoEvent>) => void,
  suffix: string
): ReturnType<typeof createOperationIoContext> {
  return createOperationIoContext({
    contextId: `fault-aggregate:${suffix}`,
    dataSourceIdentity: `fixture:${suffix}`,
    sourceReadLimits: SOURCE_READ_LIMITS_V1_DEFAULTS,
    emit,
  });
}

function coreMessage(
  partial: Partial<CoreMessage> & { role: 'user' | 'assistant'; content: string }
): CoreMessage {
  return { id: null, codeBlocks: [], ...partial };
}

function coreSession(messages: CoreMessage[], source: ChatSession['source']): ChatSession {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'fault-merge-session',
    index: 1,
    title: 'Fault aggregate',
    createdAt: timestamp,
    createdAtSource: source === 'global' ? 'composer-metadata' : 'store-metadata',
    lastUpdatedAt: timestamp,
    lastUpdatedAtSource: source === 'global' ? 'composer-metadata' : 'store-metadata',
    messageCount: messages.length,
    messages,
    workspaceId: 'fault-workspace',
    workspacePath: '/work/fault',
    source,
  };
}

function consumerSession(messages: Message[], source: Session['source'] = 'global'): Session {
  return {
    id: 'fault-consumer-session',
    workspace: '/work/fault',
    timestamp: '2024-01-01T00:00:00.000Z',
    messageCount: messages.length,
    source,
    messages,
    metadata: { lastModified: '2024-01-02T00:00:00.000Z' },
  };
}

function assertEveryOldKeyPreserved(baseline: Session, candidate: Session): void {
  const oldIds = new Set(normalizeCursorSessionV016(baseline).messages.map(({ id }) => id));
  const candidateIds = new Set(normalizeCursorSessionV016(candidate).messages.map(({ id }) => id));
  const missing = [...oldIds].filter((id) => !candidateIds.has(id));
  if (missing.length > 0) throw new Error(`Compatibility identity drift: ${missing.join(', ')}`);
}

function assertCompleteProjection(expected: Session, candidate: Session): void {
  const expectedDigest = computeV016MessageDigest(normalizeCursorSessionV016(expected).messages);
  const candidateDigest = computeV016MessageDigest(normalizeCursorSessionV016(candidate).messages);
  if (candidateDigest !== expectedDigest) {
    throw new Error('Append-only or timestamp-watermark projection lost complete content.');
  }
}

function assertOwnershipBound(snapshot: Readonly<OwnershipSnapshot>): void {
  const counters = Object.values(snapshot);
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Ownership counters must be nonnegative safe integers.');
  }
  if (snapshot.completedSessions > snapshot.resolvedSessionCapacity) {
    throw new Error('Completed-session retention exceeded C.');
  }
  const inactive = snapshot.completedSessions + snapshot.discoveryDecodedSessions;
  if (
    snapshot.ownedDecodedSessions < inactive ||
    snapshot.ownedDecodedSessions > inactive + snapshot.activeResolutions
  ) {
    throw new Error('Decoded-session ownership counters are internally inconsistent.');
  }
  if (
    snapshot.ownedDecodedSessions >
    snapshot.resolvedSessionCapacity + snapshot.activeResolutions
  ) {
    throw new Error('Decoded-session ownership exceeded C+A.');
  }
}

function workflowJob(source: string, name: string): string {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return '';
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:\s*$/u.test(line)
  );
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function workflowNeeds(source: string, name: string): string[] {
  const lines = workflowJob(source, name).split(/\r?\n/u);
  const index = lines.findIndex((line) => /^ {4}needs:/u.test(line));
  if (index < 0) return [];
  const inline = lines[index]!.replace(/^ {4}needs:\s*/u, '').trim();
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return inline
      .slice(1, -1)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return inline ? [inline] : [];
}

function releaseBypasses(source: string): string[] {
  const failures: string[] = [];
  if (
    /\bnpm\s+(?:test|run\s+(?:typecheck|lint|build))\b[^\n]*(?:\|\||continue-on-error)/u.test(
      source
    )
  ) {
    failures.push('validation failure is swallowed');
  }
  if (/continue-on-error:\s*true/u.test(source)) failures.push('workflow permits a failed step');
  if (!workflowNeeds(source, 'verify-candidate').includes('package-candidate')) {
    failures.push('verification bypasses the preserved candidate');
  }
  if (!workflowNeeds(source, 'package-candidate').includes('source-quality')) {
    failures.push('packaging bypasses source validation');
  }
  if (!workflowNeeds(source, 'runtime-candidate').includes('package-candidate')) {
    failures.push('runtime matrix bypasses the preserved candidate');
  }
  if (!workflowNeeds(source, 'approve-candidate').includes('verify-candidate')) {
    failures.push('protected approval bypasses verification');
  }
  if (!workflowNeeds(source, 'approve-candidate').includes('runtime-candidate')) {
    failures.push('protected approval bypasses runtime matrix');
  }
  const publishNeeds = workflowNeeds(source, 'publish');
  if (!publishNeeds.includes('approve-candidate')) failures.push('publish bypasses approval');
  if (!publishNeeds.includes('package-candidate')) failures.push('publish bypasses candidate');
  if (/^ {4}if:\s*.*\balways\s*\(\s*\)/mu.test(workflowJob(source, 'publish'))) {
    failures.push('publish runs after a failed dependency');
  }
  return failures;
}

describe.sequential('session-integrity load-bearing fault aggregate', () => {
  it('detects wrong index, logical ID, and workspace-path associations on a real scoped read', async () => {
    const root = fixture('ch-fault-address-');
    const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(root);
    const context = storage.createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
    });
    try {
      const rows = await storage.listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const resolved = await storage.getSession(1, root.workspaceStorage, undefined, context);
      expect(resolved).not.toBeNull();
      const expected = { index: 1, id: sessionA.id, workspacePath: root.projectA };
      assertAddressAssociation(
        { index: row.index, id: resolved!.id, workspacePath: resolved!.workspacePath },
        expected
      );
      const found = await storage.searchSessions(
        'needle-a',
        { all: true, limit: 0, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(found.map(({ sessionId }) => sessionId)).toEqual([sessionA.id]);
      await expect(
        storage.getSession(sessionB.id, root.workspaceStorage, undefined, context)
      ).resolves.toBeNull();

      expect(() => assertAddressAssociation({ ...expected, index: 2 }, expected)).toThrow(
        'Scoped index'
      );
      expect(() => assertAddressAssociation({ ...expected, id: sessionB.id }, expected)).toThrow(
        'Scoped index'
      );
      expect(() =>
        assertAddressAssociation({ ...expected, workspacePath: root.projectB }, expected)
      ).toThrow('Scoped index');
    } finally {
      await context.dispose();
    }
  });

  it('arms off-scope DB, transcript, key-value, and blob canaries at the real adapter seam', async () => {
    const root = fixture('ch-fault-io-');
    seedConflictingWorkspaceCorpus(root);
    const transcriptPath = writeStoreTranscript(
      root,
      'fault-project',
      SESSION_INTEGRITY_IDS.storeOnly,
      [{ role: 'user', message: { content: [{ type: 'text', text: 'poison transcript' }] } }]
    );
    const storeDbPath = writeStoreDb(root, SESSION_INTEGRITY_IDS.storeOnly, [
      { role: 'assistant', content: 'poison blob' },
    ]);

    const recorder = createIoEventRecorder();
    const context = storage.createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      ioObserver: recorder.observer,
    });
    try {
      await storage.listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      );
      assertNoSessionPayloadIo(recorder.snapshot(), SESSION_INTEGRITY_IDS.workspaceB);
    } finally {
      await context.dispose();
    }

    const request: DatabaseOperationRequest = {
      operation: 'read-session',
      required: new Set(['read']),
      ioResource: { resourceClass: 'workspace-conversation' },
    };
    const protectedOpen = createPoisonCanary('database-open');
    expect(() =>
      openObservedDatabase(
        ioContext(createPoisonIoObserver({ operation: 'open' }), 'database'),
        request,
        () => protectedOpen.touch()
      )
    ).toThrow(IoObserverError);
    protectedOpen.assertUntouched();

    const bypassed = createPoisonCanary('observer-bypass');
    expect(() => openObservedDatabase(undefined, request, () => bypassed.touch())).toThrow(
      'Poison canary touched: observer-bypass'
    );
    expect(bypassed.touched).toBe(true);

    expect(() =>
      parseTranscriptFile(
        transcriptPath,
        SOURCE_READ_LIMITS_V1_DEFAULTS,
        'fatal',
        undefined,
        ioContext(
          createPoisonIoObserver({
            adapter: 'filesystem',
            operation: 'read',
            resourceClass: 'store-transcript',
          }),
          'transcript'
        ),
        SESSION_INTEGRITY_IDS.storeOnly
      )
    ).toThrow(IoObserverError);

    for (const [resourceClass, suffix] of [
      ['store-database', 'key-value'],
      ['store-leaf', 'blob'],
    ] as const) {
      await expect(
        parseStoreDb(storeDbPath, {
          io: ioContext(
            createPoisonIoObserver({
              adapter: 'key-value',
              operation: 'get',
              resourceClass,
            }),
            suffix
          ),
          logicalSessionId: SESSION_INTEGRITY_IDS.storeOnly,
        })
      ).rejects.toBeInstanceOf(IoObserverError);
    }
  });

  it('makes backbone pairing drift and Composer tool reordering fail their invariants', () => {
    const composerPairing = coreSession(
      [
        coreMessage({ id: 'composer-a', role: 'user', content: 'A' }),
        coreMessage({ id: 'composer-b', role: 'assistant', content: 'B' }),
      ],
      'global'
    );
    const storePairing = coreSession(
      [
        coreMessage({
          id: 'store-b',
          role: 'assistant',
          content: 'B',
          thinking: 'Store enrichment',
        }),
        coreMessage({ id: 'store-a', role: 'user', content: 'A' }),
      ],
      'store-complete'
    );

    const assertStablePairing = (merged: ChatSession): void => {
      const matched = merged.messages.filter(({ source }) => source === 'both');
      if (matched.length !== 1 || matched[0]!.id !== 'composer-b') {
        throw new Error('Preferred-backbone pairing changed Composer identity.');
      }
    };
    assertStablePairing(mergeCrossStackSessions(composerPairing, storePairing, 'store', 1));
    expect(() =>
      assertStablePairing(
        mergeCrossStackSessions(composerPairing, storePairing, 'store', 1, {
          preferredBackbonePairing: true,
        })
      )
    ).toThrow('pairing');

    const composerTools = coreSession(
      [
        coreMessage({
          id: 'composer-tools',
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            { name: 'Read', status: 'completed', params: { path: '/a' } },
            { name: 'Write', status: 'completed', params: { path: '/b' } },
          ],
        }),
      ],
      'global'
    );
    const storeTools = coreSession(
      [
        coreMessage({
          id: 'store-tools',
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            { name: 'Write', status: 'completed', params: { path: '/b' }, result: 'wrote' },
            { name: 'Read', status: 'completed', params: { path: '/a' }, result: 'read' },
          ],
        }),
      ],
      'store-complete'
    );
    const assertStableTools = (merged: ChatSession): void => {
      const matched = merged.messages.find(({ source }) => source === 'both');
      if (!matched) throw new Error('Tool-bearing messages did not align.');
      const tools = matched.toolCalls ?? [];
      if (tools.map(({ name }) => name).join(',') !== 'Read,Write') {
        throw new Error('Existing Composer tool order changed.');
      }
    };
    assertStableTools(mergeCrossStackSessions(composerTools, storeTools, 'store', 1));
    expect(() =>
      assertStableTools(
        mergeCrossStackSessions(composerTools, storeTools, 'store', 1, {
          preferredBackboneToolOrder: true,
        })
      )
    ).toThrow('tool order');
  });

  it('detects identity, fidelity, watermark, and append-only transition faults in the v0.16 consumer', () => {
    const root = fixture('ch-fault-consumer-');
    const archive = join(root.root, 'consumer.sqlite');
    initializeV016Archive(archive);
    const baseline = consumerSession([
      {
        id: 'native-old',
        role: 'user',
        content: 'old content',
        timestamp: '2024-01-02T00:00:00.000Z',
      },
    ]);
    expect(syncV016Session(archive, baseline).action).toBe('added');
    const storedSessionId = normalizeCursorSessionV016(baseline).id;
    const original = readV016ArchiveState(archive, storedSessionId);

    const complete = consumerSession([
      {
        id: 'native-old',
        role: 'user',
        content: 'enriched old content',
        timestamp: '2024-01-02T00:00:00.000Z',
      },
      {
        id: 'store:v1:transcript:fixture:1',
        role: 'assistant',
        content: 'middle insertion below watermark',
        timestamp: '2024-01-01T12:00:00.000Z',
      },
    ]);
    assertEveryOldKeyPreserved(baseline, complete);
    expect(new Date(complete.messages[1]!.timestamp).getTime()).toBeLessThan(
      new Date(original.maxTimestamp!).getTime()
    );
    expect(syncV016Session(archive, complete).action).toBe('replaced');
    expect(syncV016Session(archive, complete).action).toBe('skipped');

    const beforeDegraded = readV016ArchiveState(archive, storedSessionId).messageDigest;
    const degraded = consumerSession(complete.messages.slice(0, 1), 'workspace-fallback');
    expect(syncV016Session(archive, degraded).action).toBe('skipped');
    expect(readV016ArchiveState(archive, storedSessionId).messageDigest).toBe(beforeDegraded);

    const identityFault = structuredClone(complete);
    identityFault.messages[0]!.id = 'rewritten-old-key';
    expect(() => assertEveryOldKeyPreserved(baseline, identityFault)).toThrow('identity drift');

    const boundary = new Date(original.maxTimestamp!).getTime();
    const appendOnlyFault = consumerSession(
      complete.messages.filter(({ timestamp }) => new Date(timestamp).getTime() >= boundary)
    );
    expect(() => assertCompleteProjection(complete, appendOnlyFault)).toThrow('Append-only');
  });

  it('detects source-limit bypass, missing reset, and automatic-raise faults', () => {
    const limits = resolveSourceReadLimits({
      jsonlRecordBytes: 16,
      jsonlSourceBytes: 32,
      jsonlRecordCount: 1,
    });
    const shared = new JsonlSourceReadBudget(limits, 'fatal');
    shared.admitRecord(1, true);
    expect(() => shared.admitRecord(1, true)).toThrow(/jsonl-record-count/u);

    for (let index = 0; index < 2; index++) {
      const perTranscript = new JsonlSourceReadBudget(limits, 'fatal');
      perTranscript.admitRecord(1, true);
      expect(perTranscript.recordCount).toBe(1);
    }

    const assertAdmissionRecorded = (budget: JsonlSourceReadBudget, expected: number): void => {
      if (budget.recordCount !== expected) throw new Error('Source-limit admission was bypassed.');
    };
    assertAdmissionRecorded(shared, 1);
    expect(() => assertAdmissionRecorded(new JsonlSourceReadBudget(limits, 'fatal'), 1)).toThrow(
      'bypassed'
    );

    process.env[sourceLimitEnvironmentKey] = String(
      SOURCE_READ_LIMITS_V1_DEFAULTS.jsonlRecordBytes + 1
    );
    expect(resolveSourceReadLimits().jsonlRecordBytes).toBe(
      SOURCE_READ_LIMITS_V1_DEFAULTS.jsonlRecordBytes
    );
    const explicitlyRaised = resolveSourceReadLimits({
      jsonlRecordBytes: SOURCE_READ_LIMITS_V1_DEFAULTS.jsonlRecordBytes + 1,
    });
    expect(explicitlyRaised.jsonlRecordBytes).toBe(
      SOURCE_READ_LIMITS_V1_DEFAULTS.jsonlRecordBytes + 1
    );
    expect(Object.isFrozen(explicitlyRaised)).toBe(true);
  });

  it('surfaces a deliberate private-temp residue instead of reporting successful cleanup', () => {
    const root = fixture('ch-fault-temp-');
    const workspace = createPrivateTempWorkspace({
      prefix: 'cursor-history-fault-residue-',
      parent: root.root,
    });
    const unexpectedDirectory = join(workspace.path, 'unexpected-directory');
    mkdirSync(unexpectedDirectory, { mode: 0o700 });
    writeFileSync(join(unexpectedDirectory, 'plaintext.db'), 'sensitive fixture', { mode: 0o600 });
    let cleanupError: unknown;
    try {
      workspace.dispose();
    } catch (error) {
      cleanupError = error;
    }
    expect(cleanupError).toBeInstanceOf(TemporaryArtifactCleanupError);
    expect((cleanupError as TemporaryArtifactCleanupError).details.residuePaths).toEqual(
      expect.arrayContaining([workspace.path])
    );
    expect(workspace.state).toBe('residue');
    rmSync(workspace.path, { recursive: true, force: true });
  });

  it('checks real ownership snapshots and rejects a deliberate C+A overflow', async () => {
    const root = fixture('ch-fault-memory-');
    seedConflictingWorkspaceCorpus(root);
    const snapshots: OwnershipSnapshot[] = [];
    const create = storage.createSessionReadContext as unknown as (
      options: InstrumentedContextOptions
    ) => storage.SessionReadContext;
    const context = create({
      dataPath: root.workspaceStorage,
      resolvedSessionCapacity: 1,
      testOnlyOnOwnershipChange: (snapshot) => snapshots.push({ ...snapshot }),
    });
    try {
      const rows = await storage.listSessions(
        { all: true, limit: 0 },
        root.workspaceStorage,
        undefined,
        context
      );
      for (const row of rows) {
        await storage.getSession(row.id, root.workspaceStorage, undefined, context, row.index);
      }
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) assertOwnershipBound(snapshot);
    } finally {
      await context.dispose();
    }

    const overflow: OwnershipSnapshot = {
      resolvedSessionCapacity: 1,
      activeResolutions: 1,
      completedSessions: 2,
      discoveryDecodedSessions: 0,
      ownedDecodedSessions: 3,
      resolutionStarts: 3,
    };
    expect(() => assertOwnershipBound(overflow)).toThrow('exceeded C');
  });

  it('detects publish-after-failure and swallowed-validation workflow mutations', () => {
    const source = readFileSync(resolve('.github/workflows/npm-publish.yml'), 'utf8');
    expect(releaseBypasses(source)).toEqual([]);

    const swallowed = source.replace('run: npm test', 'run: npm test || echo "skip"');
    expect(swallowed).not.toBe(source);
    expect(releaseBypasses(swallowed)).toContain('validation failure is swallowed');

    const publishAfterFailure = source.replace(
      'publish:\n    name: Publish preserved candidate',
      'publish:\n    name: Publish preserved candidate\n    if: always()'
    );
    expect(publishAfterFailure).not.toBe(source);
    expect(releaseBypasses(publishAfterFailure)).toContain(
      'publish runs after a failed dependency'
    );

    const approvalSkipsRuntime = source.replace(
      'needs: [verify-candidate, runtime-candidate]',
      'needs: verify-candidate'
    );
    expect(approvalSkipsRuntime).not.toBe(source);
    expect(releaseBypasses(approvalSkipsRuntime)).toContain(
      'protected approval bypasses runtime matrix'
    );
  });
});
