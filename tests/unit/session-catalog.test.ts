import { describe, expect, it, vi } from 'vitest';
import { SessionAmbiguityError } from '../../src/core/errors.js';
import {
  arbitrateComposerContribution,
  arbitrateStoreReplicaTier,
  buildSessionCatalog,
  fingerprintConsumedPayloadV1,
  hydrateSelectedReplica,
  projectAmbiguousSessionSummary,
  reconcileReplicaGroup,
  sessionAmbiguityErrorFromReplicaGroup,
  type PhysicalSessionInstance,
  type ReplicaConsumedPayload,
  type ReplicaFidelityTier,
} from '../../src/core/session-catalog.js';
import type { SourceRepresentation, SourceRole } from '../../src/core/types.js';

const SESSION_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SESSION_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const basePayload: ReplicaConsumedPayload = {
  messages: [
    {
      id: 'msg:0',
      role: 'user',
      content: 'question',
      directTimestamp: 1_700_000_000_000,
    },
    {
      id: 'native-answer',
      role: 'assistant',
      content: 'answer\n```ts\nconst value = 1;\n```',
      thinking: 'stored thought',
      parentMessageId: 'msg:0',
      isSidechain: false,
      toolCalls: [
        {
          id: 'tool:read',
          name: 'read_file',
          status: 'completed',
          params: { path: '/project/a.ts', options: { lines: [1, 2] } },
          result: 'const value = 1;',
        },
      ],
    },
  ],
  activeBranchMessageIds: ['msg:0', 'native-answer'],
  leafMessageId: 'native-answer',
  sourceRelationships: { branch: 'main' },
};

function roleForRepresentation(representation: SourceRepresentation): SourceRole {
  return representation.startsWith('composer-') ? 'composer' : 'store';
}

interface InstanceOptions {
  sessionId?: string;
  representation?: SourceRepresentation;
  fidelityTier?: ReplicaFidelityTier;
  sourceOrder?: number;
  workspacePaths?: string[];
  payload?: ReplicaConsumedPayload;
  loader?: ReturnType<typeof vi.fn>;
  canonicalKind?: 'composer-configuration' | 'composer-folder' | 'store-cwd';
  locatorPath?: string;
}

function makeInstance(
  instanceKey: string,
  options: InstanceOptions = {}
): PhysicalSessionInstance<{ privatePath: string }> {
  const representation = options.representation ?? 'composer-global';
  const workspacePaths = options.workspacePaths ?? ['/workspaces/project'];
  const loader = options.loader ?? vi.fn(async () => options.payload ?? basePayload);
  return {
    instanceKey,
    logicalSessionId: options.sessionId ?? SESSION_A,
    sourceRole: roleForRepresentation(representation),
    representation,
    fidelityTier: options.fidelityTier ?? 'complete',
    locator: { privatePath: options.locatorPath ?? `/private/${instanceKey}.db` },
    workspacePaths,
    ...(options.canonicalKind
      ? {
          canonicalWorkspaceCandidates: workspacePaths.map((workspacePath) => ({
            workspacePath,
            kind: options.canonicalKind!,
          })),
        }
      : {}),
    sourceOrder: options.sourceOrder ?? 0,
    loadConsumedPayload: loader,
  };
}

function groupFor(
  instances: readonly PhysicalSessionInstance<{ privatePath: string }>[],
  representation: SourceRepresentation,
  fidelityTier: ReplicaFidelityTier = 'complete'
) {
  const record = buildSessionCatalog(instances)[0]!;
  return record.replicaGroups.find(
    (group) => group.representation === representation && group.fidelityTier === fidelityTier
  )!;
}

describe('metadata-only session catalog', () => {
  it('groups by UUID, role, representation, and fidelity without hydrating payloads', () => {
    const loaders = Array.from({ length: 6 }, () => vi.fn(async () => basePayload));
    const catalog = buildSessionCatalog(
      [
        makeInstance('global-2', {
          sourceOrder: 2,
          workspacePaths: ['/workspaces/folder'],
          loader: loaders[0],
        }),
        makeInstance('transcript', {
          representation: 'store-transcript',
          workspacePaths: ['/workspaces/folder'],
          loader: loaders[1],
        }),
        makeInstance('global-1', {
          sourceOrder: 1,
          workspacePaths: ['/workspaces/team.code-workspace'],
          canonicalKind: 'composer-configuration',
          loader: loaders[2],
        }),
        makeInstance('workspace', {
          representation: 'composer-workspace',
          fidelityTier: 'partial',
          workspacePaths: ['/workspaces/z'],
          loader: loaders[3],
        }),
        makeInstance('store-db', {
          representation: 'store-db',
          workspacePaths: ['/workspaces/folder'],
          loader: loaders[4],
        }),
        makeInstance('session-b', {
          sessionId: SESSION_B,
          workspacePaths: ['/workspaces/b'],
          loader: loaders[5],
        }),
      ],
      {
        activeWorkspace: {
          matchedWorkspacePath: '/workspaces/folder',
          matchKind: 'exact',
        },
      }
    );

    expect(catalog.map(({ id }) => id)).toEqual([SESSION_A, SESSION_B]);
    const record = catalog[0]!;
    expect(
      record.replicaGroups.map((group) => [
        group.sourceRole,
        group.representation,
        group.fidelityTier,
        group.candidates.map(({ instanceKey }) => instanceKey),
      ])
    ).toEqual([
      ['composer', 'composer-global', 'complete', ['global-1', 'global-2']],
      ['composer', 'composer-workspace', 'partial', ['workspace']],
      ['store', 'store-db', 'complete', ['store-db']],
      ['store', 'store-transcript', 'complete', ['transcript']],
    ]);
    expect(record.canonicalWorkspacePath).toBe('/workspaces/team.code-workspace');
    expect(record.matchedWorkspacePath).toBe('/workspaces/folder');
    expect(record.workspaceMatchKind).toBe('exact');
    expect(record.workspaceMemberships).toEqual([
      {
        workspacePath: '/workspaces/folder',
        sourceRoles: ['composer', 'store'],
        contributingInstanceCount: 3,
      },
      {
        workspacePath: '/workspaces/team.code-workspace',
        sourceRoles: ['composer'],
        contributingInstanceCount: 1,
      },
      {
        workspacePath: '/workspaces/z',
        sourceRoles: ['composer'],
        contributingInstanceCount: 1,
      },
    ]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.workspaceMemberships)).toBe(true);
    expect(Object.isFrozen(record.workspaceMemberships[0]!.sourceRoles)).toBe(true);
    expect(Object.isFrozen(record.replicaGroups[0]!.candidates)).toBe(true);
    for (const loader of loaders) expect(loader).not.toHaveBeenCalled();
  });

  it('uses a reliable Store cwd only for a Store-only logical session', () => {
    const storeOnly = buildSessionCatalog([
      makeInstance('store-only', {
        representation: 'store-db',
        workspacePaths: ['/store/z', '/store/a'],
      }),
    ])[0]!;
    const composerWithoutPath = buildSessionCatalog([
      makeInstance('composer-pathless', { workspacePaths: [] }),
      makeInstance('store-path', {
        representation: 'store-db',
        workspacePaths: ['/store/path'],
      }),
    ])[0]!;

    expect(storeOnly.canonicalWorkspacePath).toBe('/store/a');
    expect(composerWithoutPath.canonicalWorkspacePath).toBeUndefined();
  });
});

describe('consumed-payload equivalence v1', () => {
  it('ignores provenance, inferred display values, standalone code blocks, and tool files', () => {
    const noisyEquivalent: ReplicaConsumedPayload = {
      ...basePayload,
      canonicalWorkspacePath: '/unrelated/path',
      messages: [
        {
          ...basePayload.messages[0]!,
          timestamp: new Date('2099-01-01T00:00:00.000Z'),
          timestampSource: 'inferred-previous',
          source: 'store',
        },
        {
          ...basePayload.messages[1]!,
          codeBlocks: [{ content: 'ignored standalone projection' }],
          toolCalls: [
            {
              ...basePayload.messages[1]!.toolCalls![0]!,
              params: { options: { lines: [1, 2] }, path: '/project/a.ts' },
              files: ['/private/ignored.ts'],
              durationMs: 999,
            },
          ],
        },
      ],
    };

    expect(fingerprintConsumedPayloadV1(noisyEquivalent)).toBe(
      fingerprintConsumedPayloadV1(basePayload)
    );
  });

  it.each([
    [
      'content',
      { messages: [{ ...basePayload.messages[0]!, content: 'changed' }, basePayload.messages[1]!] },
    ],
    [
      'stored timestamp',
      { messages: [{ ...basePayload.messages[0]!, directTimestamp: 2 }, basePayload.messages[1]!] },
    ],
    [
      'parent',
      {
        messages: [
          basePayload.messages[0]!,
          { ...basePayload.messages[1]!, parentMessageId: 'other' },
        ],
      },
    ],
    [
      'tool result',
      {
        messages: [
          basePayload.messages[0]!,
          {
            ...basePayload.messages[1]!,
            toolCalls: [{ ...basePayload.messages[1]!.toolCalls![0]!, result: 'changed' }],
          },
        ],
      },
    ],
    ['branch', { activeBranchMessageIds: ['native-answer'] }],
    ['leaf', { leafMessageId: 'msg:0' }],
  ])('treats changed consumed %s as divergent', (_label, change) => {
    const changed = { ...basePayload, ...change } as ReplicaConsumedPayload;
    expect(fingerprintConsumedPayloadV1(changed)).not.toBe(
      fingerprintConsumedPayloadV1(basePayload)
    );
  });
});

describe('same-tier replica reconciliation', () => {
  it('keeps a single candidate lazy until selected hydration is requested', async () => {
    const loader = vi.fn(async () => basePayload);
    const group = groupFor([makeInstance('single', { loader })], 'composer-global');

    const reconciliation = await reconcileReplicaGroup(group);
    expect(reconciliation.state).toBe('single');
    expect(loader).not.toHaveBeenCalled();
    await expect(hydrateSelectedReplica(reconciliation)).resolves.toEqual(basePayload);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('collapses equivalent replicas and retains deterministic occurrence provenance', async () => {
    const firstLoader = vi.fn(async () => basePayload);
    const secondLoader = vi.fn(async () => ({
      ...basePayload,
      messages: basePayload.messages.map((message) => ({
        ...message,
        timestampSource: 'composer-timing',
      })),
    }));
    const group = groupFor(
      [
        makeInstance('later', {
          sourceOrder: 9,
          workspacePaths: ['/z'],
          loader: secondLoader,
        }),
        makeInstance('earlier', {
          sourceOrder: 1,
          workspacePaths: ['/a'],
          loader: firstLoader,
        }),
      ],
      'composer-global'
    );

    const reconciliation = await reconcileReplicaGroup(group);
    expect(reconciliation.state).toBe('equivalent');
    if (reconciliation.state !== 'equivalent') throw new Error('Expected equivalent replicas');
    expect(reconciliation.selected.instanceKey).toBe('earlier');
    expect(reconciliation.sourceInstances).toEqual([
      {
        sourceRole: 'composer',
        representation: 'composer-global',
        workspacePaths: ['/a'],
        state: 'contributed',
      },
      {
        sourceRole: 'composer',
        representation: 'composer-global',
        workspacePaths: ['/z'],
        state: 'equivalent-replica',
      },
    ]);
    expect(Object.isFrozen(reconciliation.sourceInstances)).toBe(true);
    expect(Object.isFrozen(reconciliation.sourceInstances[0]!.workspacePaths)).toBe(true);
    expect(firstLoader).toHaveBeenCalledOnce();
    expect(secondLoader).toHaveBeenCalledOnce();
    await hydrateSelectedReplica(reconciliation);
    expect(firstLoader).toHaveBeenCalledOnce();
  });

  it('projects divergence as one opaque locator-free row and a typed read failure', async () => {
    const privateA = '/private/workspace-a/state.vscdb';
    const privateB = '/private/workspace-b/state.vscdb';
    const candidateA = makeInstance('occurrence-a', {
      sourceOrder: 2,
      payload: basePayload,
      locatorPath: privateA,
    });
    const candidateB = makeInstance('occurrence-b', {
      sourceOrder: 1,
      payload: {
        ...basePayload,
        messages: [{ ...basePayload.messages[0]!, content: 'divergent' }],
      },
      locatorPath: privateB,
    });
    const record = buildSessionCatalog([candidateA, candidateB], {
      activeWorkspace: { matchedWorkspacePath: '/workspaces/project', matchKind: 'exact' },
    })[0]!;
    const divergence = await reconcileReplicaGroup(record.replicaGroups[0]!, {
      diagnosticContextId: 'operation-1',
    });
    expect(divergence.state).toBe('divergent');
    if (divergence.state !== 'divergent') throw new Error('Expected divergent replicas');

    const reversed = buildSessionCatalog([candidateB, candidateA])[0]!;
    const reversedDivergence = await reconcileReplicaGroup(reversed.replicaGroups[0]!, {
      diagnosticContextId: 'operation-1',
    });
    expect(reversedDivergence.state).toBe('divergent');
    if (reversedDivergence.state !== 'divergent') throw new Error('Expected divergence');
    expect(
      reversedDivergence.diagnosticOccurrences.map(({ occurrenceRef }) => occurrenceRef)
    ).toEqual(divergence.diagnosticOccurrences.map(({ occurrenceRef }) => occurrenceRef));

    const summary = projectAmbiguousSessionSummary(record, [divergence], {
      index: 1,
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/project',
    });
    expect(summary).toMatchObject({
      id: SESSION_A,
      index: 1,
      indexScope: 'workspace',
      resolutionState: 'ambiguous',
      sourceRoles: ['composer'],
      occurrenceCount: 2,
      matchedWorkspacePath: '/workspaces/project',
    });
    expect(summary.diagnosticOccurrenceRefs).toHaveLength(2);
    expect(
      summary.diagnosticOccurrenceRefs.every((ref) => /^occurrence:v1:[0-9a-f]{64}$/.test(ref))
    ).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(privateA);
    expect(JSON.stringify(summary)).not.toContain(privateB);
    expect(JSON.stringify(summary)).not.toContain('locator');

    const error = sessionAmbiguityErrorFromReplicaGroup(divergence);
    expect(error).toBeInstanceOf(SessionAmbiguityError);
    expect(error).toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      details: {
        sessionId: SESSION_A,
        occurrenceCount: 2,
      },
    });
    await expect(hydrateSelectedReplica(divergence)).rejects.toBeInstanceOf(SessionAmbiguityError);
  });
});

describe('Composer and Store tier arbitration', () => {
  it('selects a usable Composer global tier and leaves workspace fallback payload untouched', async () => {
    const globalA = vi.fn(async () => basePayload);
    const globalB = vi.fn(async () => basePayload);
    const lowerGlobal = vi.fn(async () => ({ ...basePayload, leafMessageId: 'other' }));
    const workspace = vi.fn(async () => ({
      ...basePayload,
      messages: [{ ...basePayload.messages[0]!, content: 'workspace-only' }],
    }));
    const record = buildSessionCatalog([
      makeInstance('global-a', { sourceOrder: 1, loader: globalA }),
      makeInstance('global-b', { sourceOrder: 2, loader: globalB }),
      makeInstance('global-partial', {
        fidelityTier: 'partial',
        loader: lowerGlobal,
      }),
      makeInstance('workspace', {
        representation: 'composer-workspace',
        fidelityTier: 'partial',
        loader: workspace,
      }),
    ])[0]!;

    const result = await arbitrateComposerContribution(record, {
      diagnosticContextId: 'composer-operation',
    });
    expect(result.state).toBe('selected');
    if (result.state !== 'selected') throw new Error('Expected selected Composer contribution');
    expect(result.selectedTier).toBe('global-primary');
    expect(result.resolutionState).toBe('complete');
    expect(globalA).toHaveBeenCalledOnce();
    expect(globalB).toHaveBeenCalledOnce();
    expect(lowerGlobal).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    expect(result.sourceInstances.filter(({ state }) => state === 'superseded')).toHaveLength(2);
  });

  it('uses Composer workspace only as a partial fallback when no global tier exists', async () => {
    const workspaceLoader = vi.fn(async () => basePayload);
    const record = buildSessionCatalog([
      makeInstance('workspace', {
        representation: 'composer-workspace',
        fidelityTier: 'complete',
        loader: workspaceLoader,
      }),
    ])[0]!;

    const result = await arbitrateComposerContribution(record);
    expect(result.state).toBe('selected');
    if (result.state !== 'selected') throw new Error('Expected selected fallback');
    expect(result.selectedTier).toBe('workspace-fallback');
    expect(result.resolutionState).toBe('partial');
    expect(workspaceLoader).not.toHaveBeenCalled();
  });

  it('never hides a divergent Composer global tier with workspace fallback', async () => {
    const workspaceLoader = vi.fn(async () => basePayload);
    const record = buildSessionCatalog([
      makeInstance('global-a', { payload: basePayload, sourceOrder: 1 }),
      makeInstance('global-b', {
        payload: { ...basePayload, leafMessageId: 'divergent' },
        sourceOrder: 2,
      }),
      makeInstance('workspace', {
        representation: 'composer-workspace',
        fidelityTier: 'partial',
        loader: workspaceLoader,
      }),
    ])[0]!;

    const result = await arbitrateComposerContribution(record, {
      diagnosticContextId: 'composer-operation',
    });
    expect(result.state).toBe('ambiguous');
    expect(result.selectedTier).toBe('global-primary');
    expect(workspaceLoader).not.toHaveBeenCalled();
  });

  it('reconciles only the Store representation and fidelity tier selected upstream', async () => {
    const dbA = vi.fn(async () => basePayload);
    const dbB = vi.fn(async () => basePayload);
    const partialDb = vi.fn(async () => ({ ...basePayload, leafMessageId: 'partial-db' }));
    const transcriptA = vi.fn(async () => basePayload);
    const transcriptB = vi.fn(async () => ({ ...basePayload, leafMessageId: 'different' }));
    const instances = [
      makeInstance('db-a', { representation: 'store-db', sourceOrder: 1, loader: dbA }),
      makeInstance('db-b', { representation: 'store-db', sourceOrder: 2, loader: dbB }),
      makeInstance('db-partial', {
        representation: 'store-db',
        fidelityTier: 'partial',
        loader: partialDb,
      }),
      makeInstance('transcript-a', {
        representation: 'store-transcript',
        sourceOrder: 1,
        loader: transcriptA,
      }),
      makeInstance('transcript-b', {
        representation: 'store-transcript',
        sourceOrder: 2,
        loader: transcriptB,
      }),
    ];

    const dbRecord = buildSessionCatalog(instances)[0]!;
    const dbResult = await arbitrateStoreReplicaTier(
      dbRecord,
      { representation: 'store-db', fidelityTier: 'complete', resolutionState: 'complete' },
      { diagnosticContextId: 'store-operation' }
    );
    expect(dbResult.state).toBe('selected');
    expect(dbA).toHaveBeenCalledOnce();
    expect(dbB).toHaveBeenCalledOnce();
    expect(partialDb).not.toHaveBeenCalled();
    expect(transcriptA).not.toHaveBeenCalled();
    expect(transcriptB).not.toHaveBeenCalled();

    const transcriptInstances = instances.map((instance) => ({
      ...instance,
      loadConsumedPayload:
        instance.instanceKey === 'transcript-a'
          ? vi.fn(async () => basePayload)
          : instance.instanceKey === 'transcript-b'
            ? vi.fn(async () => ({ ...basePayload, leafMessageId: 'different' }))
            : vi.fn(async () => basePayload),
    }));
    const transcriptRecord = buildSessionCatalog(transcriptInstances)[0]!;
    const transcriptResult = await arbitrateStoreReplicaTier(
      transcriptRecord,
      {
        representation: 'store-transcript',
        fidelityTier: 'complete',
        resolutionState: 'partial',
      },
      { diagnosticContextId: 'store-operation' }
    );
    expect(transcriptResult.state).toBe('ambiguous');
    for (const instance of transcriptInstances.filter(
      ({ representation }) => representation === 'store-db'
    )) {
      expect(instance.loadConsumedPayload).not.toHaveBeenCalled();
    }
  });
});
