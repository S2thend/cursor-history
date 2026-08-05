import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectV016ComposerMessages } from '../../src/core/session-identity.js';
import { mergeCrossStackSessions } from '../../src/core/store-stack/merge.js';
import type { ChatSession, Message as CoreMessage } from '../../src/core/types.js';
import type { Message, Session } from '../../src/lib/types.js';
import {
  computeV016MessageDigest,
  normalizeCursorSessionV016,
  readV016ArchiveState,
  syncV016Session,
  type V016Message,
} from '../helpers/v016-consumer.js';

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'compatibility', 'fixtures', 'v016');
const LOCKED_ARCHIVE = join(FIXTURE_ROOT, 'legacy-consumer-archive.sqlite');
const WORKSPACE = '/fixture/v016/project';

interface TaggedFixture {
  globalSession: {
    id: string;
    title: string;
    createdAt: string;
    lastUpdatedAt: string;
    source: 'global';
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
    storeCandidateId: string;
    expectedAllocatedStoreId: string;
  };
}

interface ArchiveSnapshot {
  sessions: unknown[];
  messages: unknown[];
  codeBlocks: unknown[];
  toolCalls: unknown[];
  foreignKeyViolations: unknown[];
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name), 'utf8')) as T;
}

function composerSession(tagged: TaggedFixture): ChatSession {
  const fixture = tagged.globalSession;
  return {
    id: fixture.id,
    index: 1,
    title: fixture.title,
    createdAt: new Date(fixture.createdAt),
    lastUpdatedAt: new Date(fixture.lastUpdatedAt),
    messageCount: fixture.messages.length,
    messages: fixture.messages.map((message) => ({
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
    activeBranchBubbleIds: [...fixture.activeBranchBubbleIds],
  };
}

function storeSession(sessionId: string, fixture: StoreFixture): ChatSession {
  const messages = fixture.sourceNativeOrder.map((message): CoreMessage => ({
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
    ...(message.appendToolCalls
      ? { toolCalls: structuredClone(message.appendToolCalls) }
      : {}),
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

function toConsumerSession(session: ChatSession): Session {
  return {
    id: session.id,
    workspace: session.workspacePath ?? 'unknown',
    timestamp: session.createdAt.toISOString(),
    messageCount: session.messages.length,
    source: session.source,
    resolvedSource: session.resolvedSource,
    ...(session.sources ? { sources: [...session.sources] } : {}),
    ...(session.preferredSource ? { preferredSource: session.preferredSource } : {}),
    ...(session.messageIdentityVersion
      ? { messageIdentityVersion: session.messageIdentityVersion }
      : {}),
    messages: session.messages.map((message): Message => ({
      ...(message.id ? { id: message.id } : {}),
      role: message.role,
      content: message.content,
      timestamp: (message.timestamp ?? session.createdAt).toISOString(),
      ...(message.timestampSource ? { timestampSource: message.timestampSource } : {}),
      ...(message.messageIdentityVersion
        ? { messageIdentityVersion: message.messageIdentityVersion }
        : {}),
      ...(message.identityOrigin ? { identityOrigin: message.identityOrigin } : {}),
      ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
      ...(message.isSidechain !== undefined ? { isSidechain: message.isSidechain } : {}),
      ...(message.source ? { source: message.source } : {}),
      ...(message.toolCalls ? { toolCalls: structuredClone(message.toolCalls) } : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
      ...(message.model ? { model: message.model } : {}),
    })),
    ...(session.activeBranchBubbleIds
      ? { activeBranchBubbleIds: [...session.activeBranchBubbleIds] }
      : {}),
    ...(session.activeBranchMessageIds
      ? { activeBranchMessageIds: [...session.activeBranchMessageIds] }
      : {}),
    metadata: { lastModified: session.lastUpdatedAt.toISOString() },
  };
}

function archiveSnapshot(path: string): ArchiveSnapshot {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    return {
      sessions: db
        .prepare(
          `SELECT id, hostname, provider, created_at, updated_at, project_path,
                  leaf_message_id, first_user_message, message_count, metadata
             FROM sessions ORDER BY id, hostname`
        )
        .all(),
      messages: db
        .prepare(
          `SELECT session_id, hostname, id, role, content, content_type, timestamp,
                  model, parent_message_id, is_sidechain, input_tokens, output_tokens,
                  cache_read_input_tokens, cache_creation_input_tokens, metadata
             FROM messages ORDER BY session_id, hostname, id`
        )
        .all(),
      codeBlocks: db
        .prepare(
          `SELECT session_id, hostname, message_id, language, content, file_path
             FROM code_blocks ORDER BY session_id, hostname, message_id, language, content`
        )
        .all(),
      toolCalls: db
        .prepare(
          `SELECT id, session_id, hostname, message_id, name, input, output, status, duration_ms
             FROM tool_calls ORDER BY session_id, hostname, message_id, id`
        )
        .all(),
      foreignKeyViolations: db.pragma('foreign_key_check') as unknown[],
    };
  } finally {
    db.close();
  }
}

function assertArchiveMatchesCompleteView(path: string, incoming: Session): void {
  const expected = normalizeCursorSessionV016(incoming);
  const state = readV016ArchiveState(path, expected.id);
  const snapshot = archiveSnapshot(path);
  expect(state.messageDigest).toBe(computeV016MessageDigest(expected.messages));
  expect(new Set(state.messageIds)).toEqual(new Set(expected.messages.map(({ id }) => id)));
  expect(snapshot.messages).toHaveLength(expected.messages.length);
  expect(snapshot.foreignKeyViolations).toEqual([]);

  const expectedTools = expected.messages.flatMap((message) => message.toolCalls ?? []);
  const expectedBlocks = expected.messages.flatMap((message) => message.codeBlocks ?? []);
  expect(snapshot.toolCalls).toHaveLength(expectedTools.length);
  expect(snapshot.codeBlocks).toHaveLength(expectedBlocks.length);
  expect(
    (snapshot.messages as Array<{ id: string; content: string; parent_message_id: string | null }>).map(
      ({ id, content, parent_message_id: parentMessageId }) => ({ id, content, parentMessageId })
    )
  ).toEqual(
    [...expected.messages]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, content, parentMessageId }) => ({
        id,
        content,
        parentMessageId: parentMessageId ?? null,
      }))
  );
}

function expectEveryOldKeyPreserved(oldMessages: V016Message[], incoming: Session): void {
  const incomingIds = new Set(normalizeCursorSessionV016(incoming).messages.map(({ id }) => id));
  expect(oldMessages.every(({ id }) => incomingIds.has(id))).toBe(true);
}

function withArchive<T>(run: (path: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cursor-history-v016-upgrade-'));
  const path = join(root, 'archive.sqlite');
  try {
    copyFileSync(LOCKED_ARCHIVE, path);
    return run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('v0.16 Composer-only archive upgrade through the pinned unchanged consumer', () => {
  const tagged = readJson<TaggedFixture>('tagged-output.json');
  const storeFixture = readJson<StoreFixture>('merged-store-source.json');
  const composer = composerSession(tagged);
  const store = storeSession(composer.id, storeFixture);
  const oldProjection = normalizeCursorSessionV016(toConsumerSession(composer));

  it('freezes native, null, and empty Composer identities before either merge backbone', () => {
    expect(projectV016ComposerMessages(composer.messages).map(({ id }) => id)).toEqual([
      'native-user-016',
      storeFixture.collision.frozenComposerMessageId,
      'fallback-assistant-016',
      'native-tool-read-016',
      'native-tool-search-016',
      'msg:5',
    ]);
    expect(
      projectV016ComposerMessages(tagged.workspaceFallbackSessions[0]!.messages).map(
        ({ id }) => id
      )
    ).toEqual(['workspace-native-016', 'msg:1', 'msg:2']);

    for (const preferred of storeFixture.preferredSourceCases) {
      const merged = mergeCrossStackSessions(composer, store, preferred, 1);
      const incoming = toConsumerSession(merged);
      expectEveryOldKeyPreserved(oldProjection.messages, incoming);
      expect(merged.source).toBe('global');
      expect(merged.resolvedSource).toBe('merged');
      expect(merged.resolution?.state).toBe('complete');
      expect(merged.messages.find(({ content }) => content === 'Synthetic question alpha.')).toMatchObject({
        id: 'native-user-016',
        source: 'both',
      });
      expect(
        merged.messages.find(({ content }) => content === 'Synthetic empty-ID compatibility turn.')
      ).toMatchObject({ id: 'msg:5', identityOrigin: 'composer-v0.16-index' });
      expect(merged.messages.find(({ content }) => content === 'Synthetic Store collision payload.'))
        .toMatchObject({ id: storeFixture.collision.expectedAllocatedStoreId });

      const readMessage = merged.messages.find(({ id }) => id === 'native-tool-read-016')!;
      expect(readMessage.toolCalls?.map(({ name }) => name)).toEqual([
        'read_file',
        'synthetic_store_enrichment',
      ]);
      expect(readMessage.toolCalls?.every(({ id, identityOrigin }) => id && identityOrigin)).toBe(
        true
      );
      expect(merged.activeBranchMessageIds).toEqual(merged.activeBranchBubbleIds);
      for (let index = 1; index < (merged.activeBranchMessageIds?.length ?? 0); index++) {
        const id = merged.activeBranchMessageIds![index]!;
        expect(merged.messages.find((message) => message.id === id)?.parentMessageId).toBe(
          merged.activeBranchMessageIds![index - 1]
        );
      }
    }
  });

  it.each(storeFixture.preferredSourceCases)(
    'performs one complete real-SQLite replacement for the %s backbone and converges',
    (preferred) =>
      withArchive((path) => {
        const before = readV016ArchiveState(path, oldProjection.id);
        const merged = mergeCrossStackSessions(composer, store, preferred, 1);
        const incoming = toConsumerSession(merged);
        const start = incoming.messages.find(
          ({ content }) => content === 'Synthetic Store-only turn before Composer history.'
        )!;
        const middle = incoming.messages.find(
          ({ content }) => content === 'Synthetic Store-only middle turn.'
        )!;
        expect(start.timestamp < before.maxTimestamp!).toBe(true);
        expect(middle.timestamp < before.maxTimestamp!).toBe(true);

        expect(syncV016Session(path, incoming)).toEqual({
          action: 'replaced',
          messagesAppended: incoming.messages.length,
        });
        assertArchiveMatchesCompleteView(path, incoming);
        expectEveryOldKeyPreserved(oldProjection.messages, incoming);
        const afterFirstSync = archiveSnapshot(path);

        expect(syncV016Session(path, incoming)).toEqual({
          action: 'skipped',
          messagesAppended: 0,
        });
        expect(archiveSnapshot(path)).toEqual(afterFirstSync);
      })
  );

  it('replaces with an inferred Store insertion below the archived watermark', () => {
    withArchive((path) => {
      const inferredStore = structuredClone(store);
      const middle = inferredStore.messages.find(
        ({ content }) => content === 'Synthetic Store-only middle turn.'
      )!;
      delete middle.timestamp;
      delete middle.timestampSource;
      const incoming = toConsumerSession(
        mergeCrossStackSessions(composer, inferredStore, 'composer', 1)
      );
      const boundary = readV016ArchiveState(path, oldProjection.id).maxTimestamp!;
      const inferredPublicTimestamp = incoming.messages.find(
        ({ content }) => content === 'Synthetic Store-only middle turn.'
      )!.timestamp;
      expect(inferredPublicTimestamp < boundary).toBe(true);

      expect(syncV016Session(path, incoming).action).toBe('replaced');
      assertArchiveMatchesCompleteView(path, incoming);
      expect(archiveSnapshot(path).messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'Synthetic Store-only middle turn.' }),
        ])
      );
    });
  });

  it('rolls back a forced delete/insert failure and is old-or-new complete after close/reopen', () => {
    withArchive((path) => {
      const oldSnapshot = archiveSnapshot(path);
      const incoming = toConsumerSession(mergeCrossStackSessions(composer, store, 'composer', 1));

      expect(() => syncV016Session(path, incoming, { failAfterDelete: true })).toThrow(
        'intentional replacement fault'
      );
      expect(archiveSnapshot(path)).toEqual(oldSnapshot);
      expect(readV016ArchiveState(path, oldProjection.id).messageDigest).toBe(
        computeV016MessageDigest(oldProjection.messages)
      );

      expect(syncV016Session(path, incoming).action).toBe('replaced');
      assertArchiveMatchesCompleteView(path, incoming);
      expect(archiveSnapshot(path)).not.toEqual(oldSnapshot);
    });
  });

  it('pins a complete archive against degraded input and detects identity, fidelity, and append-only faults', () => {
    const complete = toConsumerSession(mergeCrossStackSessions(composer, store, 'store', 1));

    withArchive((path) => {
      expect(syncV016Session(path, complete).action).toBe('replaced');
      const completeSnapshot = archiveSnapshot(path);
      const degraded = structuredClone(complete);
      degraded.source = 'workspace-fallback';
      degraded.messages = degraded.messages.slice(0, 1);
      degraded.messageCount = degraded.messages.length;
      expect(syncV016Session(path, degraded)).toEqual({ action: 'skipped', messagesAppended: 0 });
      expect(archiveSnapshot(path)).toEqual(completeSnapshot);
    });

    const identityFault = structuredClone(complete);
    const fallback = identityFault.messages.find(({ id }) => id === 'msg:5')!;
    delete fallback.id;
    expect(() => expectEveryOldKeyPreserved(oldProjection.messages, identityFault)).toThrow();

    withArchive((path) => {
      const fidelityFault = structuredClone(complete);
      fidelityFault.source = 'workspace-fallback';
      expect(syncV016Session(path, fidelityFault).action).toBe('skipped');
      expect(() => assertArchiveMatchesCompleteView(path, complete)).toThrow();
    });

    withArchive((path) => {
      const boundary = readV016ArchiveState(path, oldProjection.id).maxTimestamp!;
      const oldIds = new Set(oldProjection.messages.map(({ id }) => id));
      const appendOnlyFault = structuredClone(complete);
      appendOnlyFault.source = undefined;
      appendOnlyFault.messages = appendOnlyFault.messages.filter((message) => {
        const normalizedId = normalizeCursorSessionV016({
          ...appendOnlyFault,
          messages: [message],
          messageCount: 1,
        }).messages[0]!.id;
        return oldIds.has(normalizedId) || message.timestamp > boundary;
      });
      appendOnlyFault.messageCount = appendOnlyFault.messages.length;
      syncV016Session(path, appendOnlyFault);
      expect(() => assertArchiveMatchesCompleteView(path, complete)).toThrow();
    });
  });
});
