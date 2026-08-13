import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type LegacyTool = {
  id?: string;
  name: string;
  status: string;
  params?: unknown;
  result?: string;
  error?: string;
};

type LegacyMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  timestampSource?: string;
  parentMessageId?: string;
  toolCalls?: LegacyTool[];
};

type CompatibilitySession = {
  id: string;
  workspace: string;
  source: string;
  messages: LegacyMessage[];
  metadata: { lastModified: string };
  lastUpdatedAtSource?: string;
};

const INFERRED_MESSAGE_SOURCES = new Set([
  'inferred-next',
  'inferred-previous',
  'session-fallback',
  'unknown',
]);
const NON_STORED_SESSION_UPDATE_SOURCES = new Set(['direct-message', 'epoch-unknown']);
const V016_PATHLESS_WORKSPACE = /^\(workspace: [^)]+\)$/u;

function persistentBindings(session: CompatibilitySession): unknown {
  return {
    id: session.id,
    source: session.source,
    messages: session.messages.map((message, index) => {
      // The released consumer used truthiness, so missing, null-like, and empty IDs all shared the
      // same ordinal fallback key.
      const messageId = message.id || `msg:${index}`;
      return {
        id: messageId,
        role: message.role,
        content: message.content,
        parentMessageId: message.parentMessageId,
        toolCalls: message.toolCalls?.map(
          ({ id, name, status, params, result, error }, toolIndex) => ({
            id: id ?? `${messageId}:tool:${toolIndex}`,
            name,
            status,
            params,
            result,
            error,
          })
        ),
      };
    }),
  };
}

/**
 * Test-only model of the explicitly versioned v0.16 compatibility exceptions: one exact
 * materialization of an already-existing ordinal identity plus three scalar fallback corrections.
 * Ordering, content, relationships, tool bindings, and fidelity remain exact.
 */
function expectCompatibleExceptVersionedFallbacks(
  legacy: CompatibilitySession,
  candidate: CompatibilitySession
): void {
  expect(persistentBindings(candidate)).toEqual(persistentBindings(legacy));

  candidate.messages.forEach((message, index) => {
    const legacyId = legacy.messages[index]!.id;
    if (typeof legacyId === 'string' && legacyId.length > 0) {
      expect(Object.prototype.hasOwnProperty.call(message, 'id')).toBe(true);
      expect(message.id).toBe(legacyId);
      return;
    }
    // This is the only permitted identity-property shape change: expose exactly the key that the
    // v0.16 consumer already synthesized from the Composer-only final array position.
    expect(Object.prototype.hasOwnProperty.call(message, 'id')).toBe(true);
    expect(message.id).toBe(`msg:${index}`);
  });

  if (candidate.workspace !== legacy.workspace) {
    expect(V016_PATHLESS_WORKSPACE.test(legacy.workspace)).toBe(true);
    expect(candidate.workspace).toBe('unknown');
  }

  if (candidate.metadata.lastModified !== legacy.metadata.lastModified) {
    expect(NON_STORED_SESSION_UPDATE_SOURCES.has(candidate.lastUpdatedAtSource ?? '')).toBe(true);
  }

  expect(candidate.messages).toHaveLength(legacy.messages.length);
  candidate.messages.forEach((message, index) => {
    if (message.timestamp !== legacy.messages[index]!.timestamp) {
      expect(INFERRED_MESSAGE_SOURCES.has(message.timestampSource ?? '')).toBe(true);
    }
  });
}

function legacySession(): CompatibilitySession {
  const tagged = JSON.parse(
    readFileSync(
      join(process.cwd(), 'tests', 'compatibility', 'fixtures', 'v016', 'tagged-output.json'),
      'utf8'
    )
  ) as {
    globalSession: {
      id: string;
      source: string;
      lastUpdatedAt: string;
      messages: Array<{
        id: string | null;
        role: 'user' | 'assistant';
        content: string;
        timestamp: string;
        toolCalls?: LegacyTool[];
      }>;
    };
  };
  const projected = tagged.globalSession;
  return {
    id: projected.id,
    workspace: '(workspace: synthetic-pathless-016)',
    source: projected.source,
    messages: projected.messages.map(({ id, ...message }) => ({
      ...message,
      ...(id === null ? {} : { id }),
    })),
    metadata: { lastModified: projected.lastUpdatedAt },
  };
}

function candidateSession(legacy: CompatibilitySession): CompatibilitySession {
  const candidate = structuredClone(legacy);
  candidate.messages.forEach((message, index) => {
    if (!message.id) message.id = `msg:${index}`;
  });
  return candidate;
}

describe('v0.16 explicitly versioned compatibility exceptions', () => {
  it('allows exact fallback-ID materialization and only the three scalar corrections', () => {
    const legacy = legacySession();
    const candidate = candidateSession(legacy);
    candidate.workspace = 'unknown';
    candidate.metadata.lastModified = '2024-01-16T00:00:02.000Z';
    candidate.lastUpdatedAtSource = 'direct-message';
    candidate.messages[1]!.timestamp = '2024-01-16T00:00:02.500Z';
    candidate.messages[1]!.timestampSource = 'inferred-next';

    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, candidate)).not.toThrow();
  });

  it.each([
    ['session identity', (value: CompatibilitySession) => (value.id = `${value.id}-changed`)],
    ['message identity', (value: CompatibilitySession) => (value.messages[0]!.id = 'changed')],
    [
      'message content binding',
      (value: CompatibilitySession) => (value.messages[1]!.content = 'changed'),
    ],
    [
      'parent binding',
      (value: CompatibilitySession) => (value.messages[1]!.parentMessageId = 'changed'),
    ],
    [
      'tool binding',
      (value: CompatibilitySession) => {
        const message = value.messages.find(({ toolCalls }) => (toolCalls?.length ?? 0) > 0)!;
        message.toolCalls![0]!.id = 'changed';
      },
    ],
  ] as const)('never masks a changed %s', (_label, mutate) => {
    const legacy = legacySession();
    const candidate = candidateSession(legacy);
    mutate(candidate);
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, candidate)).toThrow();
  });

  it('rejects scalar drift outside the documented predicates', () => {
    const legacy = legacySession();

    const knownWorkspace = candidateSession(legacy);
    knownWorkspace.workspace = '/fixture/another-project';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, knownWorkspace)).toThrow();

    const directTimestamp = candidateSession(legacy);
    directTimestamp.messages[0]!.timestamp = '2024-01-16T00:00:03.000Z';
    directTimestamp.messages[0]!.timestampSource = 'composer-created-at';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, directTimestamp)).toThrow();

    const storedUpdate = candidateSession(legacy);
    storedUpdate.metadata.lastModified = '2024-01-16T00:00:04.000Z';
    storedUpdate.lastUpdatedAtSource = 'composer-metadata';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, storedUpdate)).toThrow();
  });

  it('requires the exact ordinal ID for every missing or empty legacy ID', () => {
    const legacy = legacySession();
    legacy.messages[1]!.id = '';

    const compatible = candidateSession(legacy);
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, compatible)).not.toThrow();

    const omitted = candidateSession(legacy);
    delete omitted.messages[1]!.id;
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, omitted)).toThrow();

    const wrongOrdinal = candidateSession(legacy);
    wrongOrdinal.messages[1]!.id = 'msg:2';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, wrongOrdinal)).toThrow();
  });

  it('never relabels or removes a nonempty native Composer ID', () => {
    const legacy = legacySession();
    const relabeled = candidateSession(legacy);
    relabeled.messages[0]!.id = 'msg:0';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, relabeled)).toThrow();

    const omitted = candidateSession(legacy);
    delete omitted.messages[0]!.id;
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, omitted)).toThrow();
  });
});
