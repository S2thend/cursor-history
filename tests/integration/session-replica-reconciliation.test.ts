import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import * as library from '../../src/lib/index.js';
import {
  fingerprintConsumedPayloadV1,
  type ReplicaConsumedMessage,
  type ReplicaConsumedPayload,
  type ReplicaConsumedToolCall,
} from '../../src/core/session-catalog.js';
import type { LibraryConfig, PaginatedResult, SessionSummary } from '../../src/lib/types.js';
import {
  SESSION_INTEGRITY_IDS,
  createSessionIntegrityFixtureRoot,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  writeStoreMeta,
  writeStoreTranscript,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

type SummaryApi = {
  listSessionSummaries(config?: LibraryConfig): Promise<PaginatedResult<SessionSummary>>;
};

const roots: SessionIntegrityFixtureRoot[] = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('ch-replica-integration-');
  roots.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function composerSession(
  root: SessionIntegrityFixtureRoot,
  title: string,
  id = SESSION_INTEGRITY_IDS.duplicate
): ComposerFixtureSession {
  return {
    id,
    title,
    workspacePath: root.projectA,
    createdAt: 1_783_000_000_000,
    messages: [
      {
        id: 'composer-user',
        role: 'user',
        content: title,
        createdAt: 1_783_000_000_000,
      },
    ],
  };
}

function writeWorkspaceReplica(
  root: SessionIntegrityFixtureRoot,
  workspaceId: string,
  session: ComposerFixtureSession
): void {
  writeComposerWorkspaceSummary(root, workspaceId, root.projectA, [session]);
}

async function listSummaryRows(config: LibraryConfig): Promise<PaginatedResult<SessionSummary>> {
  const listSessionSummaries = (library as unknown as Partial<SummaryApi>).listSessionSummaries;
  expect(
    listSessionSummaries,
    'feature 016 requires the additive message-free listSessionSummaries() package-root API'
  ).toBeTypeOf('function');
  return listSessionSummaries!(config);
}

afterEach(() => {
  for (const root of roots.splice(0)) root.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe('FR-042 consumed-field integration gate', () => {
  const baseline = (): ReplicaConsumedPayload => ({
    messages: [
      {
        id: 'message-a',
        role: 'user',
        content: 'question with projected attachment\n```cursor_attachment_v1\nYWJj\n```',
        directTimestamp: 1_783_000_000_000,
      },
      {
        id: 'message-b',
        role: 'assistant',
        content: 'answer\n```ts\nconst answer = 42;\n```',
        thinking: 'stored reasoning',
        error: { code: 'stored-warning' },
        parentMessageId: 'message-a',
        isSidechain: false,
        toolCalls: [
          {
            id: 'tool-read',
            name: 'Read',
            status: 'completed',
            params: { path: '/work/a.ts' },
            result: 'const answer = 42;',
          },
          {
            id: 'tool-shell',
            name: 'Shell',
            status: 'error',
            params: { command: 'false' },
            error: 'exit 1',
          },
        ],
      },
    ],
    activeBranchMessageIds: ['message-a', 'message-b'],
    leafMessageId: 'message-b',
    sourceRelationships: { branch: 'main', parent: 'message-a' },
  });

  function replaceMessage(
    payload: ReplicaConsumedPayload,
    index: number,
    changes: Partial<ReplicaConsumedMessage>
  ): ReplicaConsumedPayload {
    return {
      ...payload,
      messages: payload.messages.map((message, messageIndex) =>
        messageIndex === index ? { ...message, ...changes } : message
      ),
    };
  }

  it('covers every included and excluded equivalence-v1 field explicitly', () => {
    const original = baseline();
    const first = original.messages[0]!;
    const second = original.messages[1]!;
    const firstTool = second.toolCalls![0]!;
    const secondTool = second.toolCalls![1]!;
    const changedSecondTool = (changes: Partial<ReplicaConsumedToolCall>): ReplicaConsumedPayload =>
      replaceMessage(original, 1, {
        toolCalls: [firstTool, { ...secondTool, ...changes }],
      });

    const consumedChanges: Array<[string, ReplicaConsumedPayload]> = [
      ['ordered messages', { ...original, messages: [...original.messages].reverse() }],
      ['message identity', replaceMessage(original, 0, { id: 'changed-id' })],
      ['message role', replaceMessage(original, 0, { role: 'assistant' })],
      ['directly stored timestamp', replaceMessage(original, 0, { directTimestamp: 2 })],
      ['content/code/attachment projection', replaceMessage(original, 0, { content: 'changed' })],
      ['thinking', replaceMessage(original, 1, { thinking: 'changed' })],
      ['message error', replaceMessage(original, 1, { error: 'changed' })],
      ['parent relationship', replaceMessage(original, 1, { parentMessageId: 'other' })],
      ['sidechain relationship', replaceMessage(original, 1, { isSidechain: true })],
      [
        'ordered tool activity',
        replaceMessage(original, 1, { toolCalls: [...second.toolCalls!].reverse() }),
      ],
      ['tool identity', changedSecondTool({ id: 'changed-tool' })],
      ['tool name', changedSecondTool({ name: 'Write' })],
      ['tool status', changedSecondTool({ status: 'cancelled' })],
      ['tool parameters', changedSecondTool({ params: { command: 'true' } })],
      ['tool result', changedSecondTool({ result: 'new result' })],
      ['tool error', changedSecondTool({ error: 'changed error' })],
      ['active branch', { ...original, activeBranchMessageIds: ['message-b'] }],
      ['leaf identity', { ...original, leafMessageId: 'message-a' }],
      ['source relationships', { ...original, sourceRelationships: { branch: 'side' } }],
    ];
    for (const [field, changed] of consumedChanges) {
      expect(fingerprintConsumedPayloadV1(changed), field).not.toBe(
        fingerprintConsumedPayloadV1(original)
      );
    }

    const provenanceOnlyNoise: ReplicaConsumedPayload = {
      ...original,
      canonicalWorkspacePath: '/ignored/location',
      discoveryOrder: 999,
      messages: [
        {
          ...first,
          timestamp: new Date('2099-01-01T00:00:00.000Z'),
          timestampSource: 'inferred-previous',
          source: 'store',
          codeBlocks: [{ content: 'standalone projection is ignored' }],
          ignoredAttachment: { uri: 'file:///private/ignored' },
        },
        {
          ...second,
          toolCalls: second.toolCalls!.map((tool) => ({
            ...tool,
            files: ['/private/ignored'],
            durationMs: 999,
            sourceLocator: '/private/ignored.db',
          })),
        },
      ],
    };
    expect(fingerprintConsumedPayloadV1(provenanceOnlyNoise)).toBe(
      fingerprintConsumedPayloadV1(original)
    );
  });
});

describe.sequential('logical replica reconciliation through public reads', () => {
  it('collapses equivalent Composer replicas once across list, lookup, search, and bulk export', async () => {
    const root = fixture();
    const session = composerSession(root, 'equivalent-replica-needle');
    writeWorkspaceReplica(root, 'workspace-copy-z', session);
    writeWorkspaceReplica(root, 'workspace-copy-a', session);

    const diagnostics: unknown[] = [];
    const config: LibraryConfig = {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    };
    const summaryPage = await listSummaryRows(config);
    const fullPage = await library.listSessions(config);

    expect(summaryPage.pagination).toMatchObject({ total: 1, hasMore: false });
    expect(fullPage.pagination).toEqual(summaryPage.pagination);
    expect(summaryPage.data).toHaveLength(1);
    expect(fullPage.data).toHaveLength(1);
    expect(summaryPage.data[0]).not.toHaveProperty('messages');
    expect(fullPage.data[0]).toMatchObject({
      id: session.id,
      index: 0,
      resolutionState: expect.stringMatching(/^(?:complete|partial)$/),
      sourceInstances: [
        expect.objectContaining({
          sourceRole: 'composer',
          representation: 'composer-workspace',
          state: 'contributed',
        }),
        expect.objectContaining({
          sourceRole: 'composer',
          representation: 'composer-workspace',
          state: 'equivalent-replica',
        }),
      ],
    });

    const byId = await library.getSession(session.id, config);
    const byIndex = await library.getSession(summaryPage.data[0]!.index, config);
    expect(byIndex.id).toBe(byId.id);
    expect(byIndex.messages).toEqual(byId.messages);

    const search = await library.searchSessions('equivalent-replica-needle', config);
    expect(search).toHaveLength(1);
    expect(search[0]?.session.id).toBe(session.id);

    const json = JSON.parse(await library.exportAllSessionsToJson(config)) as unknown[];
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ id: session.id });
    const markdown = await library.exportAllSessionsToMarkdown(config);
    expect(markdown).toContain('equivalent-replica-needle');
    expect(markdown.match(/^# /gmu)).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  it('projects divergent Composer replicas once and refuses every contested content path', async () => {
    const root = fixture();
    const left = composerSession(root, 'divergent-left-needle');
    const right = composerSession(root, 'divergent-right-needle');
    writeWorkspaceReplica(root, 'workspace-left', left);
    writeWorkspaceReplica(root, 'workspace-right', right);

    const diagnostics: Array<Record<string, unknown>> = [];
    const config: LibraryConfig = {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic as Record<string, unknown>),
    };
    const summaryPage = await listSummaryRows(config);
    expect(summaryPage.pagination).toMatchObject({ total: 1, hasMore: false });
    expect(summaryPage.data).toHaveLength(1);
    const row = summaryPage.data[0]!;
    expect(row).toMatchObject({
      id: left.id,
      index: 0,
      resolutionState: 'ambiguous',
      sourceRoles: ['composer'],
      occurrenceCount: 2,
    });
    expect(row).not.toHaveProperty('messages');
    expect(row).not.toHaveProperty('title');
    expect(row).not.toHaveProperty('preview');
    expect(row.diagnosticOccurrenceRefs).toHaveLength(2);
    expect(
      row.diagnosticOccurrenceRefs?.every((ref) => /^occurrence:v1:[0-9a-f]{64}$/u.test(ref))
    ).toBe(true);
    const serializedRow = JSON.stringify(row);
    expect(serializedRow).not.toContain('state.vscdb');
    expect(serializedRow).not.toContain('workspace-left');
    expect(serializedRow).not.toContain('workspace-right');
    expect(serializedRow).not.toContain('locator');

    const fullPage = await library.listSessions(config);
    expect(fullPage.pagination).toEqual(summaryPage.pagination);
    expect(fullPage.data).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      sessionId: left.id,
      occurrenceCount: 2,
      occurrenceRefs: row.diagnosticOccurrenceRefs,
    });

    const expectedAmbiguity = {
      code: 'SESSION_AMBIGUOUS',
      details: {
        sessionId: left.id,
        occurrenceCount: 2,
        occurrenceRefs: row.diagnosticOccurrenceRefs,
      },
    };
    await expect(library.getSession(left.id, config)).rejects.toMatchObject(expectedAmbiguity);
    await expect(library.getSession(row.index, config)).rejects.toMatchObject(expectedAmbiguity);
    await expect(library.exportSessionToJson(left.id, config)).rejects.toMatchObject(
      expectedAmbiguity
    );
    await expect(library.exportSessionToMarkdown(row.index, config)).rejects.toMatchObject(
      expectedAmbiguity
    );

    diagnostics.length = 0;
    await expect(library.searchSessions('divergent-left-needle', config)).resolves.toEqual([]);
    expect(diagnostics).toHaveLength(1);
    diagnostics.length = 0;
    await expect(library.searchSessions('divergent-right-needle', config)).resolves.toEqual([]);
    expect(diagnostics).toHaveLength(1);
    diagnostics.length = 0;
    await expect(library.exportAllSessionsToJson(config)).resolves.toBe('[]');
    expect(diagnostics).toHaveLength(1);
    diagnostics.length = 0;
    await expect(library.exportAllSessionsToMarkdown(config)).resolves.toBe('');
    expect(diagnostics).toHaveLength(1);

    const strictConfig: LibraryConfig = {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    };
    await expect(library.listSessions(strictConfig)).rejects.toMatchObject(expectedAmbiguity);
    await expect(library.searchSessions('divergent', strictConfig)).rejects.toMatchObject(
      expectedAmbiguity
    );
    await expect(library.exportAllSessionsToJson(strictConfig)).rejects.toMatchObject(
      expectedAmbiguity
    );
    await expect(library.exportAllSessionsToMarkdown(strictConfig)).rejects.toMatchObject(
      expectedAmbiguity
    );
  });

  it('keeps Composer and Store complementary while retaining the Composer canonical path', async () => {
    const root = fixture();
    const session = composerSession(root, 'composer-complementary-needle');
    writeWorkspaceReplica(root, 'workspace-composer', session);
    const dbPath = writeStoreDb(
      root,
      session.id,
      [{ role: 'assistant', content: 'store-complementary-needle' }],
      'Store complement'
    );
    writeStoreMeta(dirname(dbPath), {
      cwd: root.projectB,
      title: 'Store complement',
      hasConversation: true,
      createdAtMs: 1_783_000_000_000,
    });
    // A transcript with different content is fallback evidence, not a same-tier conflict with DB.
    writeStoreTranscript(root, 'complement', session.id, [
      {
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'transcript-must-not-replace-db' }] },
      },
    ]);

    const config: LibraryConfig = {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
      includeCrossWorkspaceSources: true,
    };
    const page = await library.listSessions(config);
    expect(page.pagination.total).toBe(1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: session.id,
      canonicalWorkspacePath: root.projectA,
      matchedWorkspacePath: root.projectA,
      workspace: root.projectA,
      resolvedSource: 'merged',
      sources: ['composer', 'store'],
    });
    const resolved = await library.getSession(session.id, config);
    expect(resolved.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining(['composer-complementary-needle', 'store-complementary-needle'])
    );
    expect(resolved.messages.map(({ content }) => content)).not.toContain(
      'transcript-must-not-replace-db'
    );
    expect(resolved.sourceInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceRole: 'composer' }),
        expect.objectContaining({ sourceRole: 'store', representation: 'store-db' }),
        expect.objectContaining({
          sourceRole: 'store',
          representation: 'store-transcript',
          state: 'superseded',
        }),
      ])
    );
  });
});
