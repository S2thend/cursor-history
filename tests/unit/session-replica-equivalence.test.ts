import { describe, expect, it } from 'vitest';

import {
  fingerprintConsumedPayloadV1,
  type ReplicaConsumedMessage,
  type ReplicaConsumedPayload,
  type ReplicaConsumedToolCall,
} from '../../src/core/session-catalog.js';

function baseline(): ReplicaConsumedPayload {
  return {
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'question\n```cursor_attachment_v1\nYWJj\n```',
        directTimestamp: 1_783_000_000_000,
      },
      {
        id: 'message-2',
        role: 'assistant',
        content: 'answer\n```ts\nconst answer = 42;\n```',
        thinking: 'stored thought',
        error: { code: 'warning' },
        parentMessageId: 'message-1',
        isSidechain: false,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'Read',
            status: 'completed',
            params: { path: '/work/a.ts' },
            result: 'content',
          },
          {
            id: 'tool-2',
            name: 'Shell',
            status: 'error',
            params: { command: 'false' },
            error: 'exit 1',
          },
        ],
      },
    ],
    activeBranchMessageIds: ['message-1', 'message-2'],
    leafMessageId: 'message-2',
    sourceRelationships: { branch: 'main', parent: 'message-1' },
  };
}

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

describe('FR-042 replica-equivalence v1 field contract', () => {
  it('treats every consumed field, including directly stored time, as identity-bearing', () => {
    const original = baseline();
    const answer = original.messages[1]!;
    const firstTool = answer.toolCalls![0]!;
    const secondTool = answer.toolCalls![1]!;
    const replaceSecondTool = (changes: Partial<ReplicaConsumedToolCall>): ReplicaConsumedPayload =>
      replaceMessage(original, 1, {
        toolCalls: [firstTool, { ...secondTool, ...changes }],
      });

    const changed: Array<[string, ReplicaConsumedPayload]> = [
      ['message order', { ...original, messages: [...original.messages].reverse() }],
      ['message ID', replaceMessage(original, 0, { id: 'different' })],
      ['role', replaceMessage(original, 0, { role: 'assistant' })],
      ['content/code/attachment projection', replaceMessage(original, 0, { content: 'different' })],
      ['direct timestamp', replaceMessage(original, 0, { directTimestamp: 1_783_000_000_001 })],
      ['thinking', replaceMessage(original, 1, { thinking: 'different' })],
      ['message error', replaceMessage(original, 1, { error: 'different' })],
      ['parent', replaceMessage(original, 1, { parentMessageId: 'different' })],
      ['sidechain', replaceMessage(original, 1, { isSidechain: true })],
      ['tool order', replaceMessage(original, 1, { toolCalls: [...answer.toolCalls!].reverse() })],
      ['tool ID', replaceSecondTool({ id: 'different' })],
      ['tool name', replaceSecondTool({ name: 'Write' })],
      ['tool status', replaceSecondTool({ status: 'cancelled' })],
      ['tool parameters', replaceSecondTool({ params: { command: 'true' } })],
      ['tool result', replaceSecondTool({ result: 'different' })],
      ['tool error', replaceSecondTool({ error: 'different' })],
      ['active branch', { ...original, activeBranchMessageIds: ['message-2'] }],
      ['leaf', { ...original, leafMessageId: 'message-1' }],
      ['source relationships', { ...original, sourceRelationships: { branch: 'side' } }],
    ];

    for (const [label, candidate] of changed) {
      expect(fingerprintConsumedPayloadV1(candidate), label).not.toBe(
        fingerprintConsumedPayloadV1(original)
      );
    }
  });

  it('ignores inferred display time, provenance, paths, discovery order, and standalone fields', () => {
    const original = baseline();
    const candidate: ReplicaConsumedPayload = {
      ...original,
      canonicalWorkspacePath: '/private/elsewhere',
      matchedWorkspacePath: '/private/filter',
      discoveryOrder: 999,
      messages: original.messages.map((message) => ({
        ...message,
        timestamp: new Date('2099-01-01T00:00:00.000Z'),
        timestampSource: 'inferred-previous',
        source: 'store',
        codeBlocks: [{ content: 'standalone projection' }],
        toolCalls: message.toolCalls?.map((tool) => ({
          ...tool,
          files: ['/private/ignored'],
          durationMs: 999,
          sourceLocator: '/private/ignored.db',
        })),
      })),
    };

    expect(fingerprintConsumedPayloadV1(candidate)).toBe(fingerprintConsumedPayloadV1(original));
  });
});
