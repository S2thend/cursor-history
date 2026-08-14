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
import { logicalSessionIdKey, sessionIdsEqual } from '../../src/core/session-id.js';
import * as storage from '../../src/core/storage.js';
import { mergeCrossStackSessions } from '../../src/core/store-stack/merge.js';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';
import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';
import type { ChatSession, Message as CoreMessage } from '../../src/core/types.js';
import type { Message, Session } from '../../src/lib/types.js';
import {
  applyGenericCompleteView,
  fingerprintV016DownstreamContract,
  projectV016DownstreamContract,
  type GenericDownstreamState,
} from '../helpers/v016-downstream-contract.js';
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
  const oldIds = new Set(projectV016DownstreamContract(baseline).messages.map(({ key }) => key));
  const candidateIds = new Set(
    projectV016DownstreamContract(candidate).messages.map(({ key }) => key)
  );
  const missing = [...oldIds].filter((id) => !candidateIds.has(id));
  if (missing.length > 0) throw new Error(`Compatibility identity drift: ${missing.join(', ')}`);
}

function assertCompleteProjection(expected: Session, candidate: Session): void {
  const expectedDigest = fingerprintV016DownstreamContract(projectV016DownstreamContract(expected));
  const candidateDigest = fingerprintV016DownstreamContract(
    projectV016DownstreamContract(candidate)
  );
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
  const publishNeeds = workflowNeeds(source, 'publish');
  for (const dependency of ['package-candidate', 'verify-candidate', 'runtime-candidate']) {
    if (!publishNeeds.includes(dependency)) failures.push(`publish bypasses ${dependency}`);
  }
  const publishJob = workflowJob(source, 'publish');
  if (!/^ {4}environment:\s*npm-release-verification\s*$/mu.test(publishJob)) {
    failures.push('publish is not protected by the release environment');
  }
  if (!/^ {6}id-token:\s*write\s*$/mu.test(publishJob)) {
    failures.push('publish lacks OIDC permission');
  }
  const verificationJob = workflowJob(source, 'verify-candidate');
  if (!/^ {8}run:\s*npm ci\s*$/mu.test(verificationJob)) {
    failures.push('verification disables its dependency lifecycle');
  }
  if (/^ {4}if:\s*.*\balways\s*\(\s*\)/mu.test(publishJob)) {
    failures.push('publish runs after a failed dependency');
  }
  return failures;
}

function assertLegacyCollationOrder(actual: readonly string[], expected: readonly string[]): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error('Equal-time Composer rows no longer retain v0.16 locale discovery order.');
  }
}

interface MigrationBindingEvidence {
  readonly logicalId: string;
  readonly authoritativePublicId: string;
  readonly physicalId: string;
  readonly selectedPhysicalId: string;
  readonly targetCount: number;
  readonly preparedTargetCount: number;
  readonly offScopePayloadReads: number;
  readonly writesBeforeAllTargetsPrepared: number;
}

function assertMigrationBinding(evidence: Readonly<MigrationBindingEvidence>): void {
  if (
    logicalSessionIdKey(evidence.logicalId) !==
      logicalSessionIdKey(evidence.authoritativePublicId) ||
    !sessionIdsEqual(evidence.authoritativePublicId, evidence.physicalId)
  ) {
    throw new Error('Migration byte-exact session-ID binding changed.');
  }
  if (evidence.selectedPhysicalId !== evidence.physicalId) {
    throw new Error('Migration no longer retains the exact physical SQLite spelling.');
  }
  if (evidence.offScopePayloadReads !== 0) {
    throw new Error('Migration discovery hydrated an off-scope payload.');
  }
  if (
    evidence.targetCount < 1 ||
    evidence.preparedTargetCount !== evidence.targetCount ||
    evidence.writesBeforeAllTargetsPrepared !== 0
  ) {
    throw new Error('Migration batch wrote before every logical target was prepared.');
  }
}

function assertPointerOnlyCaseIsolation(evidence: {
  readonly pointerId: string;
  readonly globalCarrierId: string;
  readonly returnedId?: string;
  readonly resultCount: number;
}): void {
  if (sessionIdsEqual(evidence.pointerId, evidence.globalCarrierId)) {
    throw new Error('Opposite-case pointer and global carrier were collapsed.');
  }
  if (evidence.resultCount !== 0 || evidence.returnedId !== undefined) {
    throw new Error('Opposite-case pointer resolved a global carrier.');
  }
}

function assertResolvedStoreGapBranch(session: Readonly<ChatSession>): void {
  const active = session.activeBranchMessageIds;
  const legacy = session.activeBranchBubbleIds;
  if (!active || !legacy || active.join('\0') !== legacy.join('\0')) {
    throw new Error('Legacy and additive active-branch arrays diverged.');
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]));
  const activeMessages = active.map((id) => byId.get(id));
  if (activeMessages.some((message) => message === undefined)) {
    throw new Error('Active branch references an unresolved message.');
  }
  const contents = activeMessages.map((message) => message!.content);
  if (contents.join('\0') !== ['leading', 'A', 'middle', 'B', 'trailing'].join('\0')) {
    throw new Error('Leading, middle, or trailing Store gap left the resolved active branch.');
  }
  activeMessages.forEach((message, index) => {
    const expectedParent = activeMessages[index - 1]?.id;
    if (message!.parentMessageId !== expectedParent) {
      throw new Error('Resolved active-branch parent chain drifted.');
    }
  });
  const sidechainId = session.messages.find(({ content }) => content === 'side')?.id;
  if (sidechainId && active.includes(sidechainId)) {
    throw new Error('Store sidechain entered the resolved active branch.');
  }
}

function packedTopologyFaults(source: string): string[] {
  const faults: string[] = [];
  for (const [fragment, message] of [
    ["const scopedWorkspace = '/work/a';", 'packed smoke lost its canonical scoped workspace'],
    [
      "createHash('md5').update(scopedWorkspace)",
      'packed smoke chat directory no longer derives from the scoped workspace',
    ],
    [
      'const scopedProjectDirectory = scopedWorkspace.replace',
      'packed smoke project directory no longer derives from the scoped workspace',
    ],
    ["backup.manifest.version !== '1.0.0'", 'outer backup manifest version is no longer v1'],
    [
      'backup.manifest.composerWorkspaceInventory.schemaVersion !== 1',
      'workspace inventory schema version is no longer independently v1',
    ],
  ] as const) {
    if (!source.includes(fragment)) faults.push(message);
  }
  return faults;
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

  it('detects identity, completeness, watermark, and append-only faults generically', () => {
    const baseline = consumerSession([
      {
        id: 'native-old',
        role: 'user',
        content: 'old content',
        timestamp: '2024-01-02T00:00:00.000Z',
      },
    ]);
    const state: GenericDownstreamState = {};
    expect(applyGenericCompleteView(state, baseline, 'complete').action).toBe('added');
    const original = structuredClone(state);

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
      new Date(baseline.messages[0]!.timestamp).getTime()
    );
    expect(applyGenericCompleteView(state, complete, 'complete').action).toBe('replaced');
    expect(applyGenericCompleteView(state, complete, 'complete').action).toBe('skipped');

    const beforeDegraded = structuredClone(state);
    const degraded = consumerSession(complete.messages.slice(0, 1), 'workspace-fallback');
    expect(applyGenericCompleteView(state, degraded, 'degraded').action).toBe('skipped');
    expect(state).toEqual(beforeDegraded);

    const identityFault = structuredClone(complete);
    identityFault.messages[0]!.id = 'rewritten-old-key';
    expect(() => assertEveryOldKeyPreserved(baseline, identityFault)).toThrow('identity drift');

    const boundary = new Date(baseline.messages[0]!.timestamp).getTime();
    const appendOnlyFault = consumerSession(
      complete.messages.filter(({ timestamp }) => new Date(timestamp).getTime() >= boundary)
    );
    expect(() => assertCompleteProjection(complete, appendOnlyFault)).toThrow('Append-only');
    expect(original.view).toBeDefined();
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

  it('detects post-audit collation, exact-ID binding, scoped migration, and pointer mutations', () => {
    const suffixes = ['Z', 'ä', 'é', 'z', 'Å', 'a', 'Ω'];
    const codePointCompare = (left: string, right: string): number =>
      left < right ? -1 : left > right ? 1 : 0;
    const differingPair = suffixes
      .flatMap((left) => suffixes.map((right) => [left, right] as const))
      .find(
        ([left, right]) =>
          left !== right &&
          Math.sign(left.localeCompare(right)) !== Math.sign(codePointCompare(left, right))
      );
    expect(differingPair).toBeDefined();
    const legacyOrder = [...differingPair!].sort((left, right) => left.localeCompare(right));
    const codePointOrder = [...differingPair!].sort(codePointCompare);
    assertLegacyCollationOrder(legacyOrder, legacyOrder);
    expect(() => assertLegacyCollationOrder(codePointOrder, legacyOrder)).toThrow(
      'locale discovery order'
    );

    const authoritativePublicId = 'ABABABAB-0000-4000-8000-000000000016';
    const physicalId = authoritativePublicId;
    const migration: MigrationBindingEvidence = {
      logicalId: physicalId,
      authoritativePublicId,
      physicalId,
      selectedPhysicalId: physicalId,
      targetCount: 2,
      preparedTargetCount: 2,
      offScopePayloadReads: 0,
      writesBeforeAllTargetsPrepared: 0,
    };
    assertMigrationBinding(migration);
    expect(() =>
      assertMigrationBinding({ ...migration, physicalId: physicalId.toLowerCase() })
    ).toThrow('byte-exact session-ID binding');
    expect(() =>
      assertMigrationBinding({ ...migration, selectedPhysicalId: physicalId.toLowerCase() })
    ).toThrow('exact physical SQLite spelling');
    expect(() => assertMigrationBinding({ ...migration, offScopePayloadReads: 1 })).toThrow(
      'off-scope payload'
    );
    expect(() => assertMigrationBinding({ ...migration, preparedTargetCount: 1 })).toThrow(
      'before every logical target was prepared'
    );
    expect(() =>
      assertMigrationBinding({ ...migration, writesBeforeAllTargetsPrepared: 1 })
    ).toThrow('before every logical target was prepared');

    const pointer = {
      pointerId: physicalId,
      globalCarrierId: physicalId.toLowerCase(),
      returnedId: undefined,
      resultCount: 0,
    };
    assertPointerOnlyCaseIsolation(pointer);
    expect(() =>
      assertPointerOnlyCaseIsolation({ ...pointer, returnedId: physicalId, resultCount: 1 })
    ).toThrow('resolved a global carrier');
    expect(() =>
      assertPointerOnlyCaseIsolation({ ...pointer, globalCarrierId: physicalId })
    ).toThrow('were collapsed');
  });

  it('detects active-branch Store-gap, parent-chain, and sidechain mutations for both backbones', () => {
    const composer = {
      ...coreSession(
        [
          coreMessage({ id: 'composer-a', role: 'user', content: 'A' }),
          coreMessage({ id: 'composer-b', role: 'assistant', content: 'B' }),
        ],
        'global'
      ),
      activeBranchBubbleIds: ['composer-a', 'composer-b'],
    };
    const store = coreSession(
      [
        coreMessage({ id: 'store-leading', role: 'user', content: 'leading' }),
        coreMessage({ id: 'store-a', role: 'user', content: 'A' }),
        coreMessage({ id: 'store-middle', role: 'assistant', content: 'middle' }),
        coreMessage({ id: 'store-b', role: 'assistant', content: 'B' }),
        coreMessage({ id: 'store-trailing', role: 'user', content: 'trailing' }),
        coreMessage({ id: 'store-side', role: 'assistant', content: 'side', isSidechain: true }),
      ],
      'store-complete'
    );

    for (const backbone of ['composer', 'store'] as const) {
      const merged = mergeCrossStackSessions(composer, store, backbone, 1);
      assertResolvedStoreGapBranch(merged);

      const missingMiddle = structuredClone(merged);
      missingMiddle.activeBranchMessageIds = missingMiddle.activeBranchMessageIds?.filter(
        (id) => missingMiddle.messages.find((message) => message.id === id)?.content !== 'middle'
      );
      missingMiddle.activeBranchBubbleIds = missingMiddle.activeBranchMessageIds;
      expect(() => assertResolvedStoreGapBranch(missingMiddle)).toThrow('Store gap');

      const wrongParent = structuredClone(merged);
      const trailing = wrongParent.messages.find(({ content }) => content === 'trailing')!;
      trailing.parentMessageId = undefined;
      expect(() => assertResolvedStoreGapBranch(wrongParent)).toThrow('parent chain');

      const admittedSidechain = structuredClone(merged);
      const sidechainId = admittedSidechain.messages.find(({ content }) => content === 'side')!.id!;
      admittedSidechain.activeBranchMessageIds = [
        ...(admittedSidechain.activeBranchMessageIds ?? []),
        sidechainId,
      ];
      admittedSidechain.activeBranchBubbleIds = admittedSidechain.activeBranchMessageIds;
      expect(() => assertResolvedStoreGapBranch(admittedSidechain)).toThrow(/Store gap|sidechain/u);
    }
  });

  it('detects packed Store-topology and backup-envelope version mutations', () => {
    const source = readFileSync(resolve('scripts/smoke-packed-package.mjs'), 'utf8');
    expect(packedTopologyFaults(source)).toEqual([]);

    const wrongChatIdentity = source.replace(
      "createHash('md5').update(scopedWorkspace)",
      "createHash('md5').update('/different/workspace')"
    );
    expect(wrongChatIdentity).not.toBe(source);
    expect(packedTopologyFaults(wrongChatIdentity)).toContain(
      'packed smoke chat directory no longer derives from the scoped workspace'
    );

    const wrongOuterVersion = source.replace(
      "backup.manifest.version !== '1.0.0'",
      "backup.manifest.version !== '2.0.0'"
    );
    expect(wrongOuterVersion).not.toBe(source);
    expect(packedTopologyFaults(wrongOuterVersion)).toContain(
      'outer backup manifest version is no longer v1'
    );

    const collapsedInventoryVersion = source.replace(
      'backup.manifest.composerWorkspaceInventory.schemaVersion !== 1',
      'backup.manifest.composerWorkspaceInventory.schemaVersion !== 2'
    );
    expect(collapsedInventoryVersion).not.toBe(source);
    expect(packedTopologyFaults(collapsedInventoryVersion)).toContain(
      'workspace inventory schema version is no longer independently v1'
    );
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

    const publishSkipsRuntime = source.replace(
      'needs: [package-candidate, verify-candidate, runtime-candidate]',
      'needs: [package-candidate, verify-candidate]'
    );
    expect(publishSkipsRuntime).not.toBe(source);
    expect(releaseBypasses(publishSkipsRuntime)).toContain('publish bypasses runtime-candidate');

    const misplacedEnvironment = source.replace('    environment: npm-release-verification\n', '');
    expect(misplacedEnvironment).not.toBe(source);
    expect(releaseBypasses(misplacedEnvironment)).toContain(
      'publish is not protected by the release environment'
    );

    const disabledLifecycle = source.replace(
      'run: npm ci\n\n      - name: Download preserved candidate',
      'run: npm ci --ignore-scripts\n\n      - name: Download preserved candidate'
    );
    expect(disabledLifecycle).not.toBe(source);
    expect(releaseBypasses(disabledLifecycle)).toContain(
      'verification disables its dependency lifecycle'
    );
  });
});
