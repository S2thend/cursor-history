import { describe, expect, it, vi } from 'vitest';
import { projectSession } from '../../src/core/training.js';
import * as formats from '../../src/core/training-formats.js';
import type { ChatSession } from '../../src/core/types.js';

function session(): ChatSession {
  return {
    id: 'quality',
    index: 1,
    title: null,
    workspaceId: 'ws',
    resolutionState: 'partial',
    createdAt: new Date(0),
    lastUpdatedAt: new Date(0),
    messageCount: 2,
    messages: [
      { role: 'user', content: 'A long user question', id: null, codeBlocks: [] },
      {
        role: 'assistant',
        content: 'Answer',
        id: null,
        codeBlocks: [],
        toolCalls: [
          { name: 'read_file', status: 'error', error: 'A long failure result' },
          { name: 'read_file', status: 'cancelled' },
          { name: 'read_file', status: 'completed', result: '' },
        ],
      },
    ],
  } as ChatSession;
}

describe('training quality and lazy adapters', () => {
  it('counts actual transformations and observed outcomes on emitted records', () => {
    const result = projectSession(session(), {
      maxUserChars: 3,
      maxToolResultChars: 5,
      systemPrompt: 's'.repeat(8001),
    });
    expect(result.quality).toEqual({
      partialSourceSessions: 1,
      unknownSourceSessions: 0,
      emittedRecords: 1,
      droppedSegments: 0,
      toolCalls: 3,
      failedToolCalls: 1,
      cancelledToolCalls: 1,
      missingToolResults: 1,
      truncatedUserMessages: 1,
      truncatedToolResults: 1,
      truncatedSystemPrompts: 1,
    });
  });
  it('does not confuse source markers or unlimited text with actual truncation', () => {
    const source = session();
    delete source.resolutionState;
    source.messages[0]!.content = '[... truncated 10 chars]';
    const result = projectSession(source, {
      maxUserChars: 0,
      maxToolResultChars: 0,
      includeToolCalls: false,
    });
    expect(result.quality.truncatedUserMessages).toBe(0);
    expect(result.quality.truncatedToolResults).toBe(0);
    expect(result.quality.toolCalls).toBe(0);
    expect(result.quality.unknownSourceSessions).toBe(1);
  });
  it('counts dropped segments without counting their tools as exported', () => {
    const result = projectSession(session(), { minUserTurns: 2, maxUserChars: 1 });
    expect(result.quality.droppedSegments).toBe(1);
    expect(result.quality.emittedRecords).toBe(0);
    expect(result.quality.toolCalls).toBe(0);
    expect(result.quality.truncatedUserMessages).toBe(0);
  });
  it('does not build ShareGPT for messages/TRL and memoizes legacy access', () => {
    const spy = vi.spyOn(formats, 'toShareGptRecord');
    try {
      const result = projectSession(session(), {
        toolDefinitions: [
          {
            type: 'function',
            function: { name: 'read_file', parameters: { type: 'object' } },
          },
        ],
      });
      expect(spy).not.toHaveBeenCalled();
      formats.serializeTrainingLine(result.records[0]!, 'messages');
      formats.serializeTrainingLine(result.records[0]!, 'trl');
      expect(spy).not.toHaveBeenCalled();
      const first = result.shareGpt;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.shareGpt).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(formats.convertTrainingRecord(result.records[0]!, 'sharegpt')).toEqual(first[0]);
    } finally {
      spy.mockRestore();
    }
  });
});
