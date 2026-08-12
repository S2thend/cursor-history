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
      const messageId = message.id ?? `msg:${index}`;
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
 * Test-only model of the three explicitly versioned v0.16 scalar fallback corrections.
 * Identity, ordering, content, relationships, tool bindings, and fidelity remain exact.
 */
function expectCompatibleExceptVersionedFallbacks(
  legacy: CompatibilitySession,
  candidate: CompatibilitySession
): void {
  expect(persistentBindings(candidate)).toEqual(persistentBindings(legacy));

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

describe('v0.16 explicitly versioned scalar fallback exceptions', () => {
  it('allows only deterministic timestamp, missing-update, and pathless-sentinel corrections', () => {
    const legacy = legacySession();
    const candidate = structuredClone(legacy);
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
    const candidate = structuredClone(legacy);
    mutate(candidate);
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, candidate)).toThrow();
  });

  it('rejects scalar drift outside the documented predicates', () => {
    const legacy = legacySession();

    const knownWorkspace = structuredClone(legacy);
    knownWorkspace.workspace = '/fixture/another-project';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, knownWorkspace)).toThrow();

    const directTimestamp = structuredClone(legacy);
    directTimestamp.messages[0]!.timestamp = '2024-01-16T00:00:03.000Z';
    directTimestamp.messages[0]!.timestampSource = 'composer-created-at';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, directTimestamp)).toThrow();

    const storedUpdate = structuredClone(legacy);
    storedUpdate.metadata.lastModified = '2024-01-16T00:00:04.000Z';
    storedUpdate.lastUpdatedAtSource = 'composer-metadata';
    expect(() => expectCompatibleExceptVersionedFallbacks(legacy, storedUpdate)).toThrow();
  });
});
