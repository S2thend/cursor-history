import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectV016ComposerMessages } from '../../src/core/session-identity.js';
import { mergeCrossStackSessions } from '../../src/core/store-stack/merge.js';
import type { ChatSession, Message as CoreMessage } from '../../src/core/types.js';
import type { Message, Session } from '../../src/lib/types.js';
import {
  applyGenericCompleteView,
  projectV016DownstreamContract,
  type GenericDownstreamState,
} from '../helpers/v016-downstream-contract.js';

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'compatibility', 'fixtures', 'v016');
const WORKSPACE = '/fixture/v016/project';

interface TaggedFixture {
  globalSession: {
    id: string;
    title: string;
    createdAt: string;
    lastUpdatedAt: string;
    messages: Array<{
      id: string | null;
      role: 'user' | 'assistant';
      content: string;
      timestamp: string;
      codeBlocks: CoreMessage['codeBlocks'];
      metadata?: CoreMessage['metadata'];
      toolCalls?: CoreMessage['toolCalls'];
    }>;
    activeBranchBubbleIds: string[];
  };
  workspaceFallbackSessions: Array<{
    messages: Array<{ id: string | null; role: 'user' | 'assistant'; content: string }>;
  }>;
}

interface StoreFixture {
  preferredSourceCases: Array<'composer' | 'store'>;
  sourceNativeOrder: Array<{
    label: string;
    role: 'user' | 'assistant';
    content: string;
    directTimestamp?: string;
    parentLabel?: string | null;
    appendToolCalls?: CoreMessage['toolCalls'];
  }>;
  collision: {
    frozenComposerMessageId: string;
    expectedAllocatedStoreId: string;
  };
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name), 'utf8')) as T;
}

function composerSession(tagged: TaggedFixture): ChatSession {
  const value = tagged.globalSession;
  return {
    id: value.id,
    index: 1,
    title: value.title,
    createdAt: new Date(value.createdAt),
    lastUpdatedAt: new Date(value.lastUpdatedAt),
    messageCount: value.messages.length,
    messages: value.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: new Date(message.timestamp),
      timestampSource: 'composer-created-at',
      codeBlocks: structuredClone(message.codeBlocks),
      ...(message.metadata ? { metadata: structuredClone(message.metadata) } : {}),
      ...(message.toolCalls ? { toolCalls: structuredClone(message.toolCalls) } : {}),
    })),
    workspaceId: 'synthetic-workspace-global-016',
    workspacePath: WORKSPACE,
    source: 'global',
    activeBranchBubbleIds: [...value.activeBranchBubbleIds],
  };
}

function storeSession(sessionId: string, source: StoreFixture): ChatSession {
  const messages = source.sourceNativeOrder.map((message): CoreMessage => ({
    id: message.label,
    role: message.role,
    content: message.content,
    codeBlocks: [],
    ...(message.directTimestamp
      ? {
          timestamp: new Date(message.directTimestamp),
          timestampSource: 'store-turn-timing' as const,
        }
      : {}),
    ...(message.parentLabel ? { parentMessageId: message.parentLabel } : {}),
    ...(message.appendToolCalls ? { toolCalls: structuredClone(message.appendToolCalls) } : {}),
  }));
  return {
    id: sessionId,
    index: 1,
    title: 'Synthetic complete Store enrichment',
    createdAt: new Date('2024-01-15T23:59:59.000Z'),
    lastUpdatedAt: new Date('2024-01-16T00:01:01.000Z'),
    messageCount: messages.length,
    messages,
    workspaceId: 'synthetic-store-016',
    workspacePath: WORKSPACE,
    source: 'transcript',
    transcriptState: 'parsed',
  };
}

function publicSession(session: ChatSession): Session {
  return {
    id: session.id,
    workspace: session.workspacePath ?? 'unknown',
    timestamp: session.createdAt.toISOString(),
    messageCount: session.messages.length,
    source: session.source,
    resolvedSource: session.resolvedSource,
    messages: session.messages.map((message): Message => ({
      ...(message.id ? { id: message.id } : {}),
      role: message.role,
      content: message.content,
      timestamp: (message.timestamp ?? session.createdAt).toISOString(),
      ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
      ...(message.toolCalls ? { toolCalls: structuredClone(message.toolCalls) } : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
      ...(message.model ? { model: message.model } : {}),
    })),
    metadata: { lastModified: session.lastUpdatedAt.toISOString() },
  };
}

describe('v0.16 Composer compatibility through a generic downstream contract', () => {
  const tagged = fixture<TaggedFixture>('tagged-output.json');
  const storeFixture = fixture<StoreFixture>('merged-store-source.json');
  const composer = composerSession(tagged);
  const store = storeSession(composer.id, storeFixture);
  const legacyView = projectV016DownstreamContract(publicSession(composer));

  it('freezes native, null, empty, and tool keys before either merge backbone', () => {
    expect(projectV016ComposerMessages(composer.messages).map(({ id }) => id)).toEqual([
      'native-user-016',
      storeFixture.collision.frozenComposerMessageId,
      'fallback-assistant-016',
      'synthetic-null-payload-016',
      'native-tool-read-016',
      'native-tool-search-016',
      'msg:6',
    ]);
    expect(
      projectV016ComposerMessages(tagged.workspaceFallbackSessions[0]!.messages).map(({ id }) => id)
    ).toEqual(['workspace-native-016', 'msg:1', 'msg:2']);
    expect(legacyView.messages.flatMap(({ tools }) => tools.map(({ key }) => key))).toEqual([
      `${legacyView.sessionKey}:native-tool-read-016:tc:0`,
      `${legacyView.sessionKey}:native-tool-search-016:tc:0`,
    ]);
  });

  it.each(storeFixture.preferredSourceCases)(
    'preserves every old key and converges a complete %s-backbone view',
    (preferred) => {
      const merged = mergeCrossStackSessions(composer, store, preferred, 1);
      const incoming = publicSession(merged);
      const next = projectV016DownstreamContract(incoming);
      const nextKeys = new Set(next.messages.map(({ key }) => key));
      for (const old of legacyView.messages) expect(nextKeys).toContain(old.key);
      expect(merged.source).toBe('global');
      expect(merged.resolvedSource).toBe('merged');
      expect(merged.resolution?.state).toBe('complete');
      expect(
        merged.messages.find(({ content }) => content === 'Synthetic empty-ID compatibility turn.')
      ).toMatchObject({ id: 'msg:6', identityOrigin: 'composer-v0.16-index' });
      expect(
        merged.messages.find(({ content }) => content === 'Synthetic Store collision payload.')
      ).toMatchObject({ id: storeFixture.collision.expectedAllocatedStoreId });

      const state: GenericDownstreamState = {};
      expect(applyGenericCompleteView(state, publicSession(composer), 'complete').action).toBe(
        'added'
      );
      expect(applyGenericCompleteView(state, incoming, 'complete')).toEqual({
        action: 'replaced',
        recordsWritten: incoming.messages.length,
      });
      const converged = structuredClone(state);
      expect(applyGenericCompleteView(state, incoming, 'complete')).toEqual({
        action: 'skipped',
        recordsWritten: 0,
      });
      expect(state).toEqual(converged);
    }
  );

  it('keeps below-watermark Store insertions because completeness, not time, governs replacement', () => {
    const incoming = publicSession(mergeCrossStackSessions(composer, store, 'composer', 1));
    const oldMaximum = [...publicSession(composer).messages]
      .map(({ timestamp }) => timestamp)
      .sort()
      .at(-1)!;
    const inserted = incoming.messages.filter(({ content }) =>
      content.startsWith('Synthetic Store-only')
    );
    expect(inserted).toHaveLength(2);
    expect(inserted.every(({ timestamp }) => timestamp < oldMaximum)).toBe(true);

    const state: GenericDownstreamState = {};
    applyGenericCompleteView(state, publicSession(composer), 'complete');
    applyGenericCompleteView(state, incoming, 'complete');
    expect(state.view?.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining(inserted.map(({ content }) => content))
    );
  });

  it('rejects a degraded projection without mutating the pinned complete view', () => {
    const complete = publicSession(mergeCrossStackSessions(composer, store, 'store', 1));
    const state: GenericDownstreamState = {};
    applyGenericCompleteView(state, complete, 'complete');
    const pinned = structuredClone(state);
    const degraded = { ...complete, messages: complete.messages.slice(0, 1), messageCount: 1 };
    expect(applyGenericCompleteView(state, degraded, 'degraded')).toEqual({
      action: 'skipped',
      recordsWritten: 0,
    });
    expect(state).toEqual(pinned);
  });
});
