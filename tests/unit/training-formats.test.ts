import { describe, expect, it } from 'vitest';
import {
  projectSession,
  serializeTrainingLine as legacySerialize,
} from '../../src/core/training.js';
import {
  convertTrainingRecord,
  serializeTrainingLine,
  toTrl,
  validateToolDefinitions,
  type TrainingToolDefinition,
} from '../../src/core/training-formats.js';
import type { TrainingRecord } from '../../src/core/training.js';
import type { ChatSession } from '../../src/core/types.js';

const tools: TrainingToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
];
function record(): TrainingRecord {
  return {
    id: 'session#1',
    schema: 'cursor-history-training/v1',
    metadata: {
      title: null,
      workspace: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUpdatedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 4,
      sources: ['composer'],
      resolvedSource: 'composer',
      resolutionState: 'complete',
      segment: { index: 1, total: 2 },
    },
    tools: structuredClone(tools),
    messages: [
      { role: 'user', content: 'Read these files' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Check both',
        tool_calls: [
          {
            id: 'a',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"a.ts","options":{"lines":[1,2],"enabled":true,"extra":null}}',
            },
          },
          {
            id: 'b',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
          },
        ],
      },
      { role: 'tool', content: 'B', tool_call_id: 'b', status: 'completed' },
      { role: 'tool', content: 'A missing', tool_call_id: 'a', status: 'error' },
      { role: 'assistant', content: 'Found B' },
    ],
  };
}

describe('shared training format adapters', () => {
  it('keeps messages bytes, provenance and the legacy serializer entry point', () => {
    const input = record();
    expect(legacySerialize).toBe(serializeTrainingLine);
    expect(serializeTrainingLine(input, 'messages')).toBe(JSON.stringify(input));
    expect(convertTrainingRecord(input, 'messages')).toBe(input);
  });

  it('keeps the existing ShareGPT text extensions and field order', () => {
    const input = record();
    const expected = {
      id: input.id,
      conversations: [
        { from: 'human', value: 'Read these files' },
        {
          from: 'gpt',
          value:
            '[reasoning]\nCheck both\n\n[tool_call] read_file {"path":"a.ts","options":{"lines":[1,2],"enabled":true,"extra":null}}\n\n[tool_call] read_file {"path":"b.ts"}',
        },
        { from: 'tool', value: '[tool_result completed]\nB' },
        { from: 'tool', value: '[tool_result error]\nA missing' },
        { from: 'gpt', value: 'Found B' },
      ],
      metadata: input.metadata,
    };
    expect(serializeTrainingLine(input, 'sharegpt')).toBe(JSON.stringify(expected));
    expect(serializeTrainingLine(expected as never, 'sharegpt')).toBe(JSON.stringify(expected));
    expect(() => serializeTrainingLine(expected as never, 'trl')).toThrow(
      'only be serialized as sharegpt'
    );
  });

  it('converts nested arguments without mutation, correlates parallel calls and preserves metadata', () => {
    const input = record();
    const before = structuredClone(input);
    const output = toTrl(input);
    expect(input).toEqual(before);
    expect(output.schema).toBe('cursor-history-training-trl/v1');
    expect(output.id).toBe(input.id);
    expect(output.metadata).toEqual(input.metadata);
    expect(output.tools).toEqual(tools);
    expect(output.messages[1]?.tool_calls?.[0]?.function.arguments).toEqual({
      path: 'a.ts',
      options: { lines: [1, 2], enabled: true, extra: null },
    });
    expect(output.messages[1]?.reasoning_content).toBe('Check both');
    expect(output.messages[2]).toEqual({ ...input.messages[2], name: 'read_file' });
    expect(output.messages[3]).toEqual({ ...input.messages[3], name: 'read_file' });
    expect(JSON.parse(serializeTrainingLine(input, 'trl'))).toEqual(output);
  });

  it('allows text-only records and emits an empty tools column', () => {
    const input = record();
    input.messages = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ];
    delete input.tools;
    expect(toTrl(input).tools).toEqual([]);
  });

  it('does not invent tool definitions', () => {
    const input = record();
    delete input.tools;
    expect(() => toTrl(input)).toThrow('Supply it with --tools-file');
  });

  it.each(['{', '[]', 'null', '"text"', '1'])(
    'rejects non-object or malformed arguments: %s',
    (args) => {
      const input = record();
      input.messages[1]!.tool_calls![0]!.function.arguments = args;
      expect(() => toTrl(input)).toThrow(/arguments must be/);
    }
  );

  it.each(['orphan', 'duplicate-call', 'duplicate-result', 'missing-result', 'interrupted'])(
    'rejects broken correlation: %s',
    (kind) => {
      const input = record();
      if (kind === 'orphan') input.messages[2]!.tool_call_id = 'unknown';
      if (kind === 'duplicate-call') input.messages[1]!.tool_calls![1]!.id = 'a';
      if (kind === 'duplicate-result') input.messages[3]!.tool_call_id = 'b';
      if (kind === 'missing-result') input.messages = input.messages.slice(0, 3);
      if (kind === 'interrupted') input.messages.splice(2, 0, { role: 'user', content: 'Wait' });
      expect(() => toTrl(input)).toThrow(/Record session#1:/);
    }
  );

  it('preserves additive JSON Schema fields', () => {
    const extended = structuredClone(tools);
    extended[0]!.function.parameters['$defs'] = { future: { type: 'string' } };
    extended[0]!['x-future'] = true;
    expect(validateToolDefinitions(extended)).toEqual(extended);
  });

  it.each([{}, null, [{}], [{ type: 'function', function: { name: 'x' } }], [...tools, ...tools]])(
    'rejects invalid definitions %j',
    (value) => {
      expect(() => validateToolDefinitions(value)).toThrow(/Tool definition|Duplicate tool/);
    }
  );

  it('shares projection and sanitization across formats, including tool definitions', () => {
    const session = {
      id: 'source-id',
      index: 1,
      title: 'Read',
      workspaceId: 'ws',
      createdAt: new Date(0),
      lastUpdatedAt: new Date(0),
      messageCount: 2,
      messages: [
        { id: null, role: 'user', content: 'Read a file', codeBlocks: [] },
        {
          id: null,
          role: 'assistant',
          content: 'Reading',
          codeBlocks: [],
          toolCalls: [
            {
              name: 'read_file',
              status: 'completed',
              params: {
                path: '/Users/alice/a.ts',
                nested: { value: 'ghp_abcdefghijklmnopqrstuvwxyz' },
              },
              result: 'Done',
            },
          ],
        },
      ],
    } as ChatSession;
    const definitions = structuredClone(tools);
    definitions[0]!.function.description =
      'Read /Users/alice/project; ghp_abcdefghijklmnopqrstuvwxyz';
    const projection = projectSession(session, { toolDefinitions: definitions });
    const input = projection.records[0]!;
    const output = toTrl(input);
    expect(output.messages[1]!.tool_calls![0]!.function.arguments).toEqual({
      path: '/Users/<user>/a.ts',
      nested: { value: '[REDACTED_API_KEY]' },
    });
    expect(JSON.stringify(output)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(output.tools[0]!.function.description).toContain('/Users/<user>/project');
    expect(definitions[0]!.function.description).toContain('/Users/alice');
    expect(projection.redaction.apiKey).toBe(2);
    expect(convertTrainingRecord(input, 'sharegpt')).toEqual(projection.shareGpt[0]);
    expect(
      projectSession(session, { includeToolCalls: false, toolDefinitions: definitions }).records[0]!
        .tools
    ).toBeUndefined();
  });
});
