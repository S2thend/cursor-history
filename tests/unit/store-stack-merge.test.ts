import { describe, it, expect } from 'vitest';
import {
  applyStoreMergeToSummary,
  exactLcsAnchorPairs,
  mergeCrossStackSessions,
  greedyAnchorPairs,
} from '../../src/core/store-stack/merge.js';
import { detectPreferredStackSource } from '../../src/lib/platform.js';
import type { ChatSession, ChatSessionSummary, Message } from '../../src/core/types.js';

function makeSession(overrides: Partial<ChatSession> & { messages: Message[] }): ChatSession {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'uuid-1',
    index: 0,
    title: null,
    createdAt: now,
    createdAtSource: 'composer-metadata',
    lastUpdatedAt: now,
    lastUpdatedAtSource: 'composer-metadata',
    messageCount: overrides.messages.length,
    workspaceId: 'ws',
    ...overrides,
  };
}

function msg(partial: Partial<Message> & { role: 'user' | 'assistant'; content: string }): Message {
  return { id: null, codeBlocks: [], ...partial };
}

/** Released full-matrix LCS semantics used as the compatibility oracle. */
function legacyLcsAnchorPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let aIndex = a.length - 1; aIndex >= 0; aIndex--) {
    for (let bIndex = b.length - 1; bIndex >= 0; bIndex--) {
      dp[aIndex]![bIndex] =
        a[aIndex] === b[bIndex]
          ? dp[aIndex + 1]![bIndex + 1]! + 1
          : Math.max(dp[aIndex + 1]![bIndex]!, dp[aIndex]![bIndex + 1]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let aIndex = 0;
  let bIndex = 0;
  while (aIndex < a.length && bIndex < b.length) {
    if (a[aIndex] === b[bIndex]) {
      pairs.push([aIndex++, bIndex++]);
    } else if (dp[aIndex + 1]![bIndex]! >= dp[aIndex]![bIndex + 1]!) {
      aIndex++;
    } else {
      bIndex++;
    }
  }
  return pairs;
}

function sequencesThroughLength(alphabet: readonly string[], maxLength: number): string[][] {
  const result: string[][] = [[]];
  let frontier: string[][] = [[]];
  for (let length = 1; length <= maxLength; length++) {
    frontier = frontier.flatMap((prefix) => alphabet.map((key) => [...prefix, key]));
    result.push(...frontier);
  }
  return result;
}

describe('mergeCrossStackSessions', () => {
  it('freezes v0.16 Composer identities before Store insertion for either preferred backbone', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({ id: 'native-a', role: 'user', content: 'A' }),
        msg({ id: null, role: 'assistant', content: 'B' }),
      ],
      activeBranchBubbleIds: ['native-a'],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({ id: 'store-a', role: 'user', content: 'A' }),
        msg({ id: null, role: 'user', content: 'Store-only gap' }),
        msg({ id: 'store-b', role: 'assistant', content: 'B' }),
      ],
    });

    for (const preferred of ['composer', 'store'] as const) {
      const merged = mergeCrossStackSessions(composer, store, preferred, 1);
      expect(merged.messages.find((message) => message.content === 'A')).toMatchObject({
        id: 'native-a',
        identityOrigin: 'composer-native',
        messageIdentityVersion: 1,
      });
      expect(merged.messages.find((message) => message.content === 'B')).toMatchObject({
        id: 'msg:1',
        identityOrigin: 'composer-v0.16-index',
        messageIdentityVersion: 1,
      });
      expect(merged.messages.find((message) => message.content === 'Store-only gap')?.id).toMatch(
        /^store:v1:transcript:[0-9a-f]{64}:1$/
      );
      const storeGapId = merged.messages.find(
        (message) => message.content === 'Store-only gap'
      )!.id!;
      expect(merged.activeBranchMessageIds).toEqual(['native-a', storeGapId]);
      expect(merged.source).toBe('global');
      expect(merged.resolvedSource).toBe('merged');
      expect(merged.messageIdentityVersion).toBe(1);
    }
  });

  it('keeps Composer tool slots fixed when Store is the preferred rendering backbone', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({
          id: null,
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            { name: 'Read', status: 'completed', params: { path: '/a' } },
            { name: 'Write', status: 'completed', params: { path: '/b' } },
          ],
        }),
      ],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            { name: 'Write', status: 'completed', params: { path: '/b' }, result: 'wrote' },
            { name: 'Read', status: 'completed', params: { path: '/a' }, result: 'read' },
          ],
        }),
      ],
    });

    const assertComposerSlots = (tools: NonNullable<Message['toolCalls']>): void => {
      expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Write']);
      expect(tools.map((tool) => tool.result)).toEqual(['read', 'wrote']);
      expect(tools.every((tool) => tool.id && tool.identityOrigin)).toBe(true);
    };
    assertComposerSlots(
      mergeCrossStackSessions(composer, store, 'store', 1).messages[0]!.toolCalls!
    );

    const faulted = mergeCrossStackSessions(composer, store, 'store', 1, {
      preferredBackboneToolOrder: true,
    }).messages[0]!.toolCalls!;
    expect(() => assertComposerSlots(faulted)).toThrow();
  });

  it('uses the same Composer-to-Store pairs when preferred rendering order changes', () => {
    // Reversed [A, B] / [B, A] inputs expose an LCS tie. Re-running alignment
    // in backbone order would pair A for one preference and B for the other.
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({ id: 'composer-a', role: 'user', content: 'A' }),
        msg({ id: 'composer-b', role: 'assistant', content: 'B' }),
      ],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({ id: 'store-b', role: 'assistant', content: 'B', thinking: 'store enrichment' }),
        msg({ id: 'store-a', role: 'user', content: 'A' }),
      ],
    });

    const assertFixedPair = (merged: ChatSession): void => {
      const matched = merged.messages.filter((message) => message.source === 'both');
      expect(matched).toHaveLength(1);
      expect(matched[0]).toMatchObject({
        id: 'composer-b',
        content: 'B',
        thinking: 'store enrichment',
        identityOrigin: 'composer-native',
      });
    };
    for (const preferred of ['composer', 'store'] as const) {
      assertFixedPair(mergeCrossStackSessions(composer, store, preferred, 1));
    }

    const faulted = mergeCrossStackSessions(composer, store, 'store', 1, {
      preferredBackbonePairing: true,
    });
    expect(() => assertFixedPair(faulted)).toThrow();
  });

  it('keeps the same LCS tie across the former oversize-alignment boundary', () => {
    const composerPrefix = [
      msg({ id: 'composer-a', role: 'user', content: 'A' }),
      msg({ id: 'composer-b', role: 'assistant', content: 'B' }),
    ];
    const storePrefix = [
      msg({ id: 'store-b', role: 'assistant', content: 'B', thinking: 'store-b' }),
      msg({ id: 'store-a', role: 'user', content: 'A', thinking: 'store-a' }),
    ];
    const matchedPrefix = (composerMessages: Message[], storeMessages: Message[]): string[] =>
      mergeCrossStackSessions(
        makeSession({ source: 'global', messages: composerMessages }),
        makeSession({ source: 'store-complete', messages: storeMessages }),
        'composer',
        1
      )
        .messages.filter(
          (message) =>
            message.source === 'both' && (message.content === 'A' || message.content === 'B')
        )
        .map((message) => message.content);

    const small = matchedPrefix(composerPrefix, storePrefix);
    const composerLarge = [...composerPrefix];
    const storeLarge = [...storePrefix];
    for (let index = 0; index < 499; index++) {
      const content = `stable-filler-${index}`;
      composerLarge.push(msg({ role: index % 2 === 0 ? 'user' : 'assistant', content }));
      storeLarge.push(msg({ role: index % 2 === 0 ? 'user' : 'assistant', content }));
    }
    expect(composerLarge.length * storeLarge.length).toBeGreaterThan(250_000);
    expect(matchedPrefix(composerLarge, storeLarge)).toEqual(small);
  });

  it('ignores standalone files for pairing and appends unmatched Store calls in native order', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            {
              name: 'Read',
              status: 'completed',
              params: { path: '/a' },
              files: ['/composer-only-metadata'],
            },
          ],
        }),
      ],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            { name: 'Write', status: 'completed', params: { path: '/b' } },
            {
              name: 'Read',
              status: 'completed',
              params: { path: '/a' },
              files: ['/different-store-metadata'],
              result: 'read',
            },
            { name: 'Shell', status: 'completed', params: { command: 'pwd' } },
          ],
        }),
      ],
    });

    const tools = mergeCrossStackSessions(composer, store, 'store', 1).messages[0]!.toolCalls!;
    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Write', 'Shell']);
    expect(tools[0]).toMatchObject({ result: 'read', files: ['/different-store-metadata'] });
  });

  it('freezes a matched synthetic tool identity from the Composer request projection', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            {
              name: 'Read',
              status: 'completed',
              params: { path: '/same' },
              files: ['/composer.txt'],
            },
          ],
        }),
      ],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({
          role: 'assistant',
          content: 'tools',
          toolCalls: [
            {
              name: 'Read',
              status: 'completed',
              params: { path: '/same' },
              files: ['/store.txt'],
            },
          ],
        }),
      ],
    });

    const composerPreferred = mergeCrossStackSessions(composer, store, 'composer', 1).messages[0]!
      .toolCalls![0]!;
    const storePreferred = mergeCrossStackSessions(composer, store, 'store', 1).messages[0]!
      .toolCalls![0]!;
    expect(storePreferred.id).toBe(composerPreferred.id);
    expect(storePreferred.id).toMatch(/^tool:v1:msg:0:[a-f0-9]{64}:1$/u);
    expect(composerPreferred.files).toEqual(['/composer.txt']);
    expect(storePreferred.files).toEqual(['/store.txt']);

    const changedStore = makeSession({
      ...store,
      messages: [
        msg({
          ...store.messages[0]!,
          role: 'assistant',
          content: 'tools',
          toolCalls: [{ ...store.messages[0]!.toolCalls![0]!, files: ['/changed-store.txt'] }],
        }),
      ],
    });
    expect(
      mergeCrossStackSessions(composer, changedStore, 'store', 1).messages[0]!.toolCalls![0]!.id
    ).toBe(composerPreferred.id);
  });

  it('rewrites stored relationships and inserts Store gaps between active Composer nodes', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({ id: 'composer-a', role: 'user', content: 'A' }),
        msg({ id: 'composer-b', role: 'assistant', content: 'B', parentMessageId: 'composer-a' }),
      ],
      activeBranchBubbleIds: ['composer-a', 'composer-b'],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({ id: 'store-a', role: 'user', content: 'A' }),
        msg({
          id: 'store-gap',
          role: 'user',
          content: 'gap',
          parentMessageId: 'store-a',
        }),
        msg({ id: 'store-b', role: 'assistant', content: 'B' }),
      ],
    });

    const merged = mergeCrossStackSessions(composer, store, 'store', 1);
    const gap = merged.messages.find((message) => message.content === 'gap')!;
    const last = merged.messages.find((message) => message.content === 'B')!;
    expect(gap.parentMessageId).toBe('composer-a');
    // The resolved active branch rebuilds B's parent even though neither
    // representation stored that new cross-representation relationship.
    expect(last.parentMessageId).toBe(gap.id);
    expect(merged.activeBranchMessageIds).toEqual(['composer-a', gap.id, 'composer-b']);
    expect(merged.activeBranchBubbleIds).toEqual(merged.activeBranchMessageIds);
  });

  it('projects leading and trailing Store-only turns into the legacy active branch', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({ id: 'composer-a', role: 'user', content: 'A' }),
        msg({ id: 'composer-b', role: 'assistant', content: 'B' }),
      ],
      activeBranchBubbleIds: ['composer-a', 'composer-b'],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({ id: 'store-leading', role: 'user', content: 'leading' }),
        msg({ id: 'store-a', role: 'user', content: 'A' }),
        msg({ id: 'store-middle', role: 'assistant', content: 'middle' }),
        msg({ id: 'store-b', role: 'assistant', content: 'B' }),
        msg({ id: 'store-trailing', role: 'user', content: 'trailing' }),
        msg({ id: 'store-side', role: 'assistant', content: 'side', isSidechain: true }),
      ],
    });

    const merged = mergeCrossStackSessions(composer, store, 'store', 1);
    const byContent = new Map(merged.messages.map((message) => [message.content, message]));
    expect(merged.activeBranchMessageIds).toEqual([
      byContent.get('leading')!.id,
      'composer-a',
      byContent.get('middle')!.id,
      'composer-b',
      byContent.get('trailing')!.id,
    ]);
    expect(merged.activeBranchBubbleIds).toEqual(merged.activeBranchMessageIds);
    expect(byContent.get('leading')!.parentMessageId).toBeUndefined();
    expect(byContent.get('trailing')!.parentMessageId).toBe('composer-b');
    expect(merged.activeBranchMessageIds).not.toContain(byContent.get('side')!.id);
  });

  it('uses a resolvable alternate parent when the preferred source parent is invalid', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({ id: 'composer-parent', role: 'user', content: 'parent' }),
        msg({
          id: 'composer-child',
          role: 'assistant',
          content: 'child',
          parentMessageId: 'composer-parent',
        }),
      ],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({ id: 'store-parent', role: 'user', content: 'parent' }),
        msg({
          id: 'store-child',
          role: 'assistant',
          content: 'child',
          parentMessageId: 'missing-store-parent',
        }),
      ],
    });

    const merged = mergeCrossStackSessions(composer, store, 'store', 1);
    expect(merged.messages.find((message) => message.content === 'child')?.parentMessageId).toBe(
      'composer-parent'
    );
    expect(merged.resolution?.state).toBe('complete');
  });

  it('marks merged output partial when no explicit relationship or branch reference resolves', () => {
    const composer = makeSession({
      source: 'global',
      messages: [
        msg({ id: 'composer-parent', role: 'user', content: 'parent' }),
        msg({
          id: 'composer-child',
          role: 'assistant',
          content: 'child',
          parentMessageId: 'missing-composer-parent',
        }),
      ],
      activeBranchBubbleIds: ['composer-parent', 'missing-branch-node'],
    });
    const store = makeSession({
      source: 'store-complete',
      messages: [
        msg({ id: 'store-parent', role: 'user', content: 'parent' }),
        msg({
          id: 'store-child',
          role: 'assistant',
          content: 'child',
          parentMessageId: 'missing-store-parent',
        }),
      ],
    });

    const merged = mergeCrossStackSessions(composer, store, 'store', 1);
    expect(
      merged.messages.find((message) => message.content === 'child')?.parentMessageId
    ).toBeUndefined();
    expect(merged.activeBranchMessageIds).toBeUndefined();
    expect(merged.activeBranchBubbleIds).toBeUndefined();
    expect(merged).toMatchObject({
      source: 'workspace-fallback',
      resolution: { state: 'partial', reasonCodes: ['source-partial'] },
    });
  });

  it('marks any explicitly partial contribution unsafe for legacy replacement', () => {
    const composer = makeSession({
      source: 'global',
      messages: [msg({ role: 'user', content: 'A' })],
    });
    const store = makeSession({
      source: 'store-partial',
      messages: [msg({ role: 'user', content: 'A' })],
    });

    const merged = mergeCrossStackSessions(composer, store, 'composer', 1);
    expect(merged.source).toBe('workspace-fallback');
    expect(merged.resolvedSource).toBe('merged');
    expect(merged.resolution).toMatchObject({
      state: 'partial',
      expectedSourceRoles: ['composer', 'store'],
      loadedSourceRoles: ['composer', 'store'],
      reasonCodes: ['source-partial'],
    });
  });

  it('unions omitted and failed contributor roles instead of discarding fidelity evidence', () => {
    const composer = makeSession({
      source: 'workspace-fallback',
      messages: [msg({ role: 'user', content: 'A' })],
      resolution: {
        state: 'partial',
        expectedSourceRoles: ['composer'],
        loadedSourceRoles: [],
        omittedSourceRoles: ['composer'],
        failedSourceRoles: [],
        reasonCodes: ['workspace-scope-omitted'],
      },
    });
    const store = makeSession({
      source: 'store-partial',
      messages: [msg({ role: 'user', content: 'A' })],
      resolution: {
        state: 'partial',
        expectedSourceRoles: ['store'],
        loadedSourceRoles: ['store'],
        omittedSourceRoles: [],
        failedSourceRoles: ['store'],
        reasonCodes: ['source-read-failed'],
      },
    });

    const merged = mergeCrossStackSessions(composer, store, 'store', 1);
    expect(merged.resolution).toEqual({
      state: 'partial',
      expectedSourceRoles: ['composer', 'store'],
      loadedSourceRoles: ['store'],
      omittedSourceRoles: ['composer'],
      failedSourceRoles: ['store'],
      reasonCodes: ['workspace-scope-omitted', 'source-read-failed'],
    });
  });

  it('marks the result merged with both stacks + preferred source', () => {
    const composer = makeSession({ messages: [msg({ role: 'user', content: 'hi' })] });
    const store = makeSession({
      messages: [msg({ role: 'user', content: 'hi' })],
      transcriptState: 'partial',
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 7);
    expect(merged.source).toBe('global');
    expect(merged.resolvedSource).toBe('merged');
    expect(merged.sources).toEqual(['composer', 'store']);
    expect(merged.preferredSource).toBe('composer');
    expect(merged.transcriptState).toBe('partial');
    expect(merged.index).toBe(7);
  });

  it('keeps complementary payloads and canonicalizes provenance independently of backbone order', () => {
    const composer = makeSession({
      source: 'global',
      workspacePath: '/composer/project',
      canonicalWorkspacePath: '/composer/project',
      matchedWorkspacePath: '/composer/project',
      sourceInstances: [
        {
          sourceRole: 'composer',
          representation: 'composer-workspace',
          workspacePaths: ['/composer/membership'],
          state: 'superseded',
        },
        {
          sourceRole: 'composer',
          representation: 'composer-global',
          workspacePaths: ['/composer/project'],
          state: 'contributed',
        },
      ],
      messages: [msg({ id: 'composer-only', role: 'user', content: 'Composer-only fact' })],
    });
    const store = makeSession({
      source: 'store-complete',
      workspacePath: '/store/project',
      sourceInstances: [
        {
          sourceRole: 'store',
          representation: 'store-transcript',
          workspacePaths: ['/store/project'],
          state: 'superseded',
        },
        {
          sourceRole: 'store',
          representation: 'store-db',
          workspacePaths: ['/store/project'],
          state: 'contributed',
        },
      ],
      messages: [msg({ id: 'store-only', role: 'assistant', content: 'Store-only fact' })],
    });

    for (const preferred of ['composer', 'store'] as const) {
      const merged = mergeCrossStackSessions(composer, store, preferred, 4);
      expect(merged).toMatchObject({
        id: composer.id,
        workspacePath: '/composer/project',
        canonicalWorkspacePath: '/composer/project',
        matchedWorkspacePath: '/composer/project',
        resolvedSource: 'merged',
        sources: ['composer', 'store'],
        resolution: { state: 'complete' },
        sourceInstances: [
          {
            sourceRole: 'composer',
            representation: 'composer-global',
            workspacePaths: ['/composer/project'],
            state: 'contributed',
          },
          {
            sourceRole: 'composer',
            representation: 'composer-workspace',
            workspacePaths: ['/composer/membership'],
            state: 'superseded',
          },
          {
            sourceRole: 'store',
            representation: 'store-db',
            workspacePaths: ['/store/project'],
            state: 'contributed',
          },
          {
            sourceRole: 'store',
            representation: 'store-transcript',
            workspacePaths: ['/store/project'],
            state: 'superseded',
          },
        ],
      });
      expect(merged.messages.map(({ content }) => content)).toEqual([
        'Composer-only fact',
        'Store-only fact',
      ]);
    }
  });

  it('does not inflate explicit workspace membership counts with representation provenance', () => {
    const composer = makeSession({
      source: 'global',
      workspacePath: '/shared/project',
      workspaceMemberships: [
        {
          workspacePath: '/shared/project',
          sourceRoles: ['composer'],
          contributingInstanceCount: 1,
        },
      ],
      sourceInstances: [
        {
          sourceRole: 'composer',
          representation: 'composer-global',
          workspacePaths: ['/shared/project'],
          state: 'contributed',
        },
        {
          sourceRole: 'composer',
          representation: 'composer-workspace',
          workspacePaths: ['/shared/project'],
          state: 'superseded',
        },
      ],
      messages: [msg({ role: 'user', content: 'same' })],
    });
    const store = makeSession({
      source: 'store-complete',
      workspacePath: '/shared/project',
      workspaceMemberships: [
        {
          workspacePath: '/shared/project',
          sourceRoles: ['store'],
          contributingInstanceCount: 1,
        },
      ],
      sourceInstances: [
        {
          sourceRole: 'store',
          representation: 'store-db',
          workspacePaths: ['/shared/project'],
          state: 'contributed',
        },
        {
          sourceRole: 'store',
          representation: 'store-transcript',
          workspacePaths: ['/shared/project'],
          state: 'superseded',
        },
      ],
      messages: [msg({ role: 'user', content: 'same' })],
    });

    expect(mergeCrossStackSessions(composer, store, 'composer', 1).workspaceMemberships).toEqual([
      {
        workspacePath: '/shared/project',
        sourceRoles: ['composer', 'store'],
        contributingInstanceCount: 2,
      },
    ]);
  });

  it('uses the preferred source as the backbone order (never timestamp-sorted)', () => {
    const t1 = new Date('2026-01-01T09:00:00Z');
    const t2 = new Date('2026-01-01T10:00:00Z');
    // Both stacks agree on order [A, B]; Composer timestamps are NON-monotonic
    // (A is later than B). Timestamp sorting would produce [B, A]; the backbone
    // (Composer) order [A, B] must win.
    const composer = makeSession({
      messages: [
        msg({ role: 'user', content: 'A', timestamp: t2 }),
        msg({ role: 'user', content: 'B', timestamp: t1 }),
      ],
    });
    const store = makeSession({
      messages: [msg({ role: 'user', content: 'A' }), msg({ role: 'user', content: 'B' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages.map((m) => m.content)).toEqual(['A', 'B']);
    expect(merged.messages.every((m) => m.source === 'both')).toBe(true);
  });

  it('on WSL unmatched-message order stays semantic across backbones', () => {
    // Each stack has one unmatched message between the shared A…B anchors.
    // Backbone selection decides whether the Store-only or Composer-only
    // message comes first.
    const composer = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'composer-only' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'store-only' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const byStore = mergeCrossStackSessions(composer, store, 'store', 0);
    expect(byStore.preferredSource).toBe('store');
    expect(byStore.messages.map((m) => m.content)).toEqual([
      'A',
      'composer-only',
      'store-only',
      'B',
    ]);
    // Composer backbone would order them the other way (composer-only first).
    const byComposer = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(byComposer.messages.map((m) => m.content)).toEqual([
      'A',
      'composer-only',
      'store-only',
      'B',
    ]);
  });

  it('fills missing fields additively without duplicating matched tool calls', () => {
    // Composer has the tool call name+params; Store has the result for the same call.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          model: 'claude-x',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [
            { name: 'Read', status: 'completed', params: { file: '/a' }, result: 'file-contents' },
          ],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1);
    const tc = merged.messages[0]!.toolCalls!;
    expect(tc).toHaveLength(1); // matched, not concatenated
    expect(tc[0]!.result).toBe('file-contents'); // filled from Store
    expect(merged.messages[0]!.model).toBe('claude-x'); // kept from Composer
    expect(merged.messages[0]!.source).toBe('both');
  });

  it('preserves unmatched messages from either side at relative positions', () => {
    // Backbone has an extra message between two anchors; Store has a different extra.
    const composer = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'only-composer' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'only-store' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    const contents = merged.messages.map((m) => m.content);
    expect(contents).toEqual(['A', 'only-composer', 'only-store', 'B']);
    const onlyComposer = merged.messages.find((m) => m.content === 'only-composer')!;
    const onlyStore = merged.messages.find((m) => m.content === 'only-store')!;
    expect(onlyComposer.source).toBe('composer');
    expect(onlyStore.source).toBe('store');
  });

  it('recomputes messageCount; preferred (Composer) lastUpdatedAt wins', () => {
    const composer = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-05T00:00:00Z'),
      messages: [msg({ role: 'user', content: 'A' }), msg({ role: 'user', content: 'B' })],
    });
    const store = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-03T00:00:00Z'), // store.db createdAt (older)
      messages: [msg({ role: 'user', content: 'A' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messageCount).toBe(2); // A merged + B unmatched
    expect(merged.lastUpdatedAt.toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('matches duplicate signatures earliest-first (stable)', () => {
    const composer = makeSession({
      messages: [
        msg({ id: 'composer-first', role: 'user', content: 'ping' }),
        msg({ id: 'composer-second', role: 'user', content: 'ping' }),
      ],
    });
    const store = makeSession({
      messages: [msg({ id: 'store-only', role: 'user', content: 'ping', thinking: 'enrichment' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[0]).toMatchObject({
      id: 'composer-first',
      source: 'both',
      thinking: 'enrichment',
    });
    expect(merged.messages[1]).toMatchObject({
      id: 'composer-second',
      source: 'composer',
    });
    expect(merged.messages[1]!.thinking).toBeUndefined();
  });

  it('one side missing content, other complete: fills content, single message', () => {
    const composer = makeSession({
      messages: [msg({ role: 'assistant', content: '[empty message]' })],
    });
    const store = makeSession({
      messages: [msg({ role: 'assistant', content: 'real answer' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]!.content).toBe('real answer');
    expect(merged.messages[0]!.source).toBe('both');
  });

  it('one side missing toolCalls, other complete: fills tools, single message', () => {
    // The reviewer's core case: Composer empty + no tools vs Store empty + Read.
    const composer = makeSession({
      messages: [msg({ role: 'assistant', content: '' })],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1); // NOT split into two
    expect(merged.messages[0]!.source).toBe('both');
    expect(merged.messages[0]!.toolCalls?.[0]?.name).toBe('Read');
  });

  it('matches a Composer tool display alias to the structured internal name', () => {
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '[Tool: Read File]',
          toolCalls: [{ name: 'read_file', status: 'completed' }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: 'Reading the file.',
          toolCalls: [{ name: 'read_file', status: 'completed' }],
        }),
      ],
    });

    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);

    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]).toMatchObject({
      content: 'Reading the file.',
      source: 'both',
    });
  });

  it('same-role empty messages with DIFFERENT tool calls stay distinct', () => {
    // Two separate assistant turns, each with a different tool — must NOT merge.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Write', status: 'completed', params: { file: '/b' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    // Read matches across stacks (both); Write is composer-only.
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages.find((m) => m.toolCalls?.[0]?.name === 'Read')?.source).toBe('both');
    expect(merged.messages.find((m) => m.toolCalls?.[0]?.name === 'Write')?.source).toBe(
      'composer'
    );
  });

  it('does not merge one Read-only turn with one Write-only turn', () => {
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Write', status: 'completed', params: { file: '/b' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages.map((message) => message.source).sort()).toEqual(['composer', 'store']);
  });

  it('does not mix an error payload into a preferred completed outcome', () => {
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' }, result: 'ok' }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'error', params: { file: '/a' }, error: 'boom' }],
        }),
      ],
    });
    const tool = mergeCrossStackSessions(composer, store, 'composer', 0).messages[0]
      ?.toolCalls?.[0];
    expect(tool).toMatchObject({ status: 'completed', result: 'ok' });
    expect(tool?.error).toBeUndefined();
  });

  it('a corrupted message does not merge with a legitimate empty message', () => {
    const composer = makeSession({
      messages: [msg({ role: 'assistant', content: '[corrupted message]' })],
    });
    const store = makeSession({
      messages: [msg({ role: 'assistant', content: '[empty message]' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    // Corrupt ≠ empty → they are distinct messages (not folded/merged).
    expect(merged.messages).toHaveLength(2);
  });

  it('keeps Composer metadata time when Store is the preferred rendering backbone', () => {
    const composer = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-10T00:00:00Z'), // later, but Composer is NOT preferred
      messages: [msg({ role: 'user', content: 'A' })],
    });
    const store = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-03T00:00:00Z'), // Store's value (no separate updatedAt yet)
      messages: [msg({ role: 'user', content: 'A' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'store', 0);
    expect(merged.lastUpdatedAt.toISOString()).toBe('2026-01-10T00:00:00.000Z');
    expect(merged.lastUpdatedAtSource).toBe('composer-metadata');
  });

  it('merges Read(no params) with Read(params) into one, filling params', () => {
    // Composer has the tool with NO params; Store has the same tool with params.
    // They must merge into ONE tool call with params filled from Store.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed' }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1);
    const tc = merged.messages[0]!.toolCalls!;
    expect(tc).toHaveLength(1); // not duplicated
    expect(tc[0]!.params).toEqual({ file: '/a' }); // filled from Store
  });

  it('keeps Read(/a) and Read(/b) as two distinct messages (params differ)', () => {
    // Both sides have params but they differ -> must NOT merge; each keeps its
    // own origin. Neither call is overwritten or lost.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/b' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(2); // distinct, not folded
    const sources = merged.messages.map((m) => m.source).sort();
    expect(sources).toEqual(['composer', 'store']);
    // Each message still carries its own single tool call.
    expect(merged.messages.every((m) => m.toolCalls?.length === 1)).toBe(true);
  });

  it('global two-pass: exact matches commit before fills (no duplicate params)', () => {
    // Regression: a per-tool "exact-then-fill" lets the no-params Read steal
    // /a, leaving backbone /a unmatched and producing /a,/a,/b. The global
    // two-pass must commit the exact /a match first, then fill /b.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [
            { name: 'Read', status: 'completed' }, // no params
            { name: 'Read', status: 'completed', params: { file: '/a' } },
          ],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [
            { name: 'Read', status: 'completed', params: { file: '/a' } },
            { name: 'Read', status: 'completed', params: { file: '/b' } },
          ],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1); // the two empty assistant msgs merge
    const tcs = merged.messages[0]!.toolCalls!;
    expect(tcs).toHaveLength(2); // NOT 3 (no duplicate)
    const files = tcs
      .map((tc) => (tc.params as { file?: string } | undefined)?.file ?? null)
      .sort();
    expect(files).toEqual(['/a', '/b']); // exact /a + filled /b, nothing lost/duplicated
  });
});

describe('exactLcsAnchorPairs', () => {
  it('is exhaustive-equivalent to the released DP binding for duplicate-heavy small inputs', () => {
    const sequences = sequencesThroughLength(['A', 'B'], 6);
    const mismatches: Array<{
      composer: string[];
      store: string[];
      expected: Array<[number, number]>;
      actual: Array<[number, number]>;
    }> = [];

    for (const composer of sequences) {
      for (const store of sequences) {
        const expected = legacyLcsAnchorPairs(composer, store);
        const actual = exactLcsAnchorPairs(composer, store);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push({ composer, store, expected, actual });
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('evaluates at most two DP cells per input pair for a long identical sequence', () => {
    const length = 900;
    const keys = Array.from({ length }, (_, index) => `key-${index}`);
    const work = { cellEvaluations: 0, checkpointRows: 0, peakRetainedRows: 0 };

    const pairs = exactLcsAnchorPairs(keys, keys, work);

    expect(pairs).toEqual(keys.map((_, index) => [index, index]));
    expect(work.cellEvaluations).toBe(2 * length * length);
    expect(work.peakRetainedRows).toBeLessThanOrEqual(2 * Math.ceil(Math.sqrt(length)) + 2);
  });

  it('keeps Composer-skip tie binding within the same quadratic work bound', () => {
    const length = 800;
    const composer = Array.from({ length }, (_, index) => (index % 2 === 0 ? 'A' : 'B'));
    const store = Array.from({ length }, (_, index) => (index % 2 === 0 ? 'B' : 'A'));
    const work = { cellEvaluations: 0, checkpointRows: 0, peakRetainedRows: 0 };

    const pairs = exactLcsAnchorPairs(composer, store, work);

    expect(pairs).toEqual(Array.from({ length: length - 1 }, (_, index) => [index + 1, index]));
    expect(work.cellEvaluations).toBeLessThanOrEqual(2 * length * length);
    expect(work.peakRetainedRows).toBeLessThanOrEqual(2 * Math.ceil(Math.sqrt(length)) + 3);
  });
});

describe('greedyAnchorPairs helper — no crossing anchors', () => {
  it('produces strictly increasing pairs even when keys are reversed', () => {
    // backbone [A,B], other [B,A]: an unguarded greedy pass would emit (0,1)
    // and (1,0), which cross. The monotonic guard must yield only (0,1).
    const pairs = greedyAnchorPairs(['A', 'B'], ['B', 'A']);
    expect(pairs).toEqual([[0, 1]]);
    // Invariant: both axes strictly increasing.
    for (let k = 1; k < pairs.length; k++) {
      expect(pairs[k]![0]).toBeGreaterThan(pairs[k - 1]![0]);
      expect(pairs[k]![1]).toBeGreaterThan(pairs[k - 1]![1]);
    }
  });

  it('matches an identical same-order sequence fully', () => {
    const n = 502;
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    const pairs = greedyAnchorPairs(keys, keys);
    expect(pairs).toHaveLength(n);
    expect(pairs).toEqual(keys.map((_, i) => [i, i]));
  });
});

describe('applyStoreMergeToSummary', () => {
  it('keeps legacy fidelity separate from additive merged provenance', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const summary: ChatSessionSummary = {
      id: 'uuid-1',
      index: 1,
      title: 'Composer',
      createdAt: now,
      lastUpdatedAt: now,
      messageCount: 1,
      workspaceId: 'ws',
      workspacePath: '/project',
      preview: 'A',
      source: 'global',
    };

    applyStoreMergeToSummary(
      summary,
      {
        id: 'uuid-1',
        title: 'Store',
        createdAt: now,
        lastUpdatedAt: now,
        workspacePath: '/project',
        messageCount: 1,
        source: 'store-complete',
        transcriptState: 'parsed',
      },
      'composer'
    );

    expect(summary).toMatchObject({
      source: 'global',
      resolvedSource: 'merged',
      resolutionState: 'complete',
      messageIdentityVersion: 1,
    });
  });
});

describe('detectPreferredStackSource — existing env vars', () => {
  const ORIG_DATA = process.env['CURSOR_DATA_PATH'];
  const ORIG_STORE = process.env['CURSOR_STORE_ROOT'];

  function restore() {
    if (ORIG_DATA === undefined) delete process.env['CURSOR_DATA_PATH'];
    else process.env['CURSOR_DATA_PATH'] = ORIG_DATA;
    if (ORIG_STORE === undefined) delete process.env['CURSOR_STORE_ROOT'];
    else process.env['CURSOR_STORE_ROOT'] = ORIG_STORE;
  }

  it('CURSOR_DATA_PATH pointing at a Store root selects Store', () => {
    process.env['CURSOR_DATA_PATH'] = '/home/u/.cursor';
    const r = detectPreferredStackSource();
    restore();
    expect(r).toBe('store');
  });

  it('CURSOR_DATA_PATH pointing at a Composer root selects Composer', () => {
    process.env['CURSOR_DATA_PATH'] = '/home/u/Cursor/User/workspaceStorage';
    const r = detectPreferredStackSource();
    restore();
    expect(r).toBe('composer');
  });

  it('an explicit non-default CURSOR_STORE_ROOT selects Store', () => {
    delete process.env['CURSOR_DATA_PATH'];
    process.env['CURSOR_STORE_ROOT'] = '/custom/cursor-store';
    const r = detectPreferredStackSource();
    restore();
    expect(r).toBe('store');
  });
});

describe('detectPreferredStackSource conflict priority', () => {
  it('selects Store for an explicit Store-root path', () => {
    expect(detectPreferredStackSource('/home/u/.cursor')).toBe('store');
  });

  it('selects Composer for an explicit non-Store path', () => {
    expect(detectPreferredStackSource('/home/u/Cursor/User/workspaceStorage')).toBe('composer');
  });
});
