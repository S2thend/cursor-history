/**
 * Unit tests for the training-data projection in `src/core/training.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  projectSession,
  segmentDisplayContent,
  naturalLanguageOf,
  redactSensitiveText,
  anonymizeHostPaths,
  toShareGpt,
  serializeTrainingLine,
  truncateWithMarker,
  baseSessionKey,
  assignSplit,
  deriveValidationPath,
  TRAINING_DEFAULT_OPTIONS,
} from '../../src/core/training.js';
import type { ChatSession, Message, ToolCall } from '../../src/core/types.js';

function message(partial: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: null,
    codeBlocks: [],
    ...partial,
  } as Message;
}

function session(messages: Message[]): ChatSession {
  return {
    id: 'sess-1',
    index: 1,
    title: 'Test session',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastUpdatedAt: new Date('2026-01-02T04:05:06.000Z'),
    messageCount: messages.length,
    workspaceId: 'ws-1',
    workspacePath: '/tmp/project',
    canonicalWorkspacePath: '/tmp/project',
    messages,
  } as unknown as ChatSession;
}

describe('segmentDisplayContent', () => {
  it('separates natural language from tool scaffolding', () => {
    const content = 'Here is the file:\n[Tool: Read File]\nFile: /a/b.ts\nContent: let x = 1;';
    expect(segmentDisplayContent(content)).toEqual([
      { kind: 'text', text: 'Here is the file:' },
      { kind: 'tool', text: 'File: /a/b.ts\nContent: let x = 1;' },
    ]);
  });

  it('recognizes thinking and error markers', () => {
    const kinds = segmentDisplayContent('[Thinking]\nweighing options\n[Error]\nboom').map(
      (segment) => segment.kind
    );
    expect(kinds).toEqual(['thinking', 'error']);
  });

  it('drops internal placeholders emitted for degraded bubbles', () => {
    expect(segmentDisplayContent('[empty message]')).toEqual([]);
    expect(segmentDisplayContent('[corrupted message]')).toEqual([]);
  });

  it('naturalLanguageOf keeps only non-marker text', () => {
    expect(naturalLanguageOf('Answer.\n[Tool: Grep]\npattern: foo')).toBe('Answer.');
  });
});

describe('redactSensitiveText', () => {
  it('redacts complete PEM private keys', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----';
    const result = redactSensitiveText(`key=${pem}`);
    expect(result.text).toBe('key=[REDACTED_PRIVATE_KEY]');
    expect(result.counts.privateKey).toBe(1);
  });

  it('redacts truncated PEM blocks without an end marker', () => {
    const result = redactSensitiveText(
      'JWT_PRIVATE_KEY=-----BEGIN PRIVATE KEY----- MIIEvgIBADANBg'
    );
    expect(result.text).not.toContain('MIIEvgIBADANBg');
    expect(result.counts.privateKey).toBe(1);
  });

  it('preserves the variable name when redacting assignments', () => {
    const result = redactSensitiveText('OPENAI_API_KEY=abcdef123456');
    expect(result.text).toBe('OPENAI_API_KEY=[REDACTED]');
    expect(result.counts.secretAssignment).toBe(1);
  });

  it('redacts JWTs and provider API keys', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const result = redactSensitiveText(`token=${jwt} key=ghp_abcdefghijklmnopqrstuvwxyz`);
    expect(result.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(result.counts.jwt).toBe(1);
    expect(result.counts.apiKey).toBe(1);
  });

  it('leaves ordinary prose untouched', () => {
    const result = redactSensitiveText('The quick brown fox jumps over the lazy dog.');
    expect(result.text).toBe('The quick brown fox jumps over the lazy dog.');
  });
});

describe('anonymizeHostPaths', () => {
  it('replaces unix home directories', () => {
    expect(anonymizeHostPaths('/Users/jake/project/a.ts')).toBe('/Users/<user>/project/a.ts');
    expect(anonymizeHostPaths('/home/jake/x')).toBe('/home/<user>/x');
  });

  it('replaces JSON-escaped windows home directories', () => {
    expect(anonymizeHostPaths('C:\\\\Users\\\\jake\\\\a.ts')).toBe('C:\\\\Users\\\\<user>\\\\a.ts');
  });
});

describe('truncateWithMarker', () => {
  it('returns short text unchanged', () => {
    expect(truncateWithMarker('abc', 10)).toBe('abc');
  });

  it('marks truncation with the removed length', () => {
    expect(truncateWithMarker('abcdefghij', 4)).toBe('abcd\n[... truncated 6 chars]');
  });

  it('treats a non-positive limit as unlimited', () => {
    expect(truncateWithMarker('abcdefghij', 0)).toBe('abcdefghij');
  });
});

describe('projectSession', () => {
  it('rebuilds assistant tool calls into tool_calls plus correlated tool turns', () => {
    const toolCall: ToolCall = {
      id: 'tool:v1:abc:1',
      name: 'read_file',
      status: 'completed',
      params: { targetFile: '/Users/jake/project/a.ts' },
      result: 'file contents',
    };
    const toolCall2: ToolCall = {
      name: 'run_terminal_command',
      status: 'error',
      params: { command: 'npm test' },
      error: 'exit 1',
    };
    const result = projectSession(
      session([
        message({ role: 'user', content: 'Please fix the bug.' }),
        message({
          role: 'assistant',
          content: '[Tool: Read File]\nFile: /Users/jake/project/a.ts\nContent: file contents',
          toolCalls: [toolCall, toolCall2],
        }),
      ])
    );

    expect(result.records).toHaveLength(1);
    const messages = result.records[0]!.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);

    const assistant = messages[1]!;
    expect(assistant.content).toBe('');
    expect(assistant.tool_calls).toHaveLength(2);
    expect(assistant.tool_calls![0]!.function.name).toBe('read_file');
    expect(assistant.tool_calls![0]!.function.arguments).toContain('/Users/<user>/project/a.ts');

    // Tool results correlate back to the emitted call ids.
    expect(messages[2]!.tool_call_id).toBe(assistant.tool_calls![0]!.id);
    expect(messages[3]!.tool_call_id).toBe(assistant.tool_calls![1]!.id);
    expect(messages[3]!.status).toBe('error');
    expect(messages[3]!.content).toBe('exit 1');
  });

  it('never leaks display scaffolding into assistant text', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'hi' }),
        message({
          role: 'assistant',
          content: 'Working on it.\n[Tool: Grep]\npattern: x\n[Error]\nbad',
        }),
      ])
    );
    const assistant = result.records[0]!.messages[1]!;
    expect(assistant.content).toBe('Working on it.');
    expect(assistant.content).not.toContain('[Tool:');
  });

  it('scrubs secrets and host paths from every field, including tool arguments', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'deploy' }),
        message({
          role: 'assistant',
          content: 'ok',
          toolCalls: [
            {
              name: 'write',
              status: 'completed',
              params: {
                targetFile: '/Users/jake/.env',
                content: 'OPENAI_API_KEY=abcdef123456',
              },
              result: 'token=ghp_abcdefghijklmnopqrstuvwxyz',
            },
          ],
        }),
      ])
    );

    const serialized = JSON.stringify(result.records[0]);
    expect(serialized).not.toContain('/Users/jake');
    expect(serialized).not.toContain('abcdef123456');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(result.redaction.secretAssignment).toBeGreaterThan(0);
    expect(result.redaction.apiKey).toBeGreaterThan(0);
  });

  it('can disable redaction and path anonymization', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'x' }),
        message({ role: 'assistant', content: 'path /Users/jake/a.ts' }),
      ]),
      { redact: false, anonymizePaths: false }
    );
    expect(result.records[0]!.messages[1]!.content).toBe('path /Users/jake/a.ts');
  });

  it('treats everything after a [Thinking] marker as reasoning, matching the storage format', () => {
    // Storage emits `[Thinking]\n<text>` as the whole content of a
    // reasoning-only bubble. Verified against the real corpus: 23,973 of
    // 23,973 `[Thinking]` messages are thinking-only (never text-then-thinking).
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: '[Thinking]\ndeep thought' }),
        message({ role: 'assistant', content: 'Visible answer.' }),
      ])
    );
    const messages = result.records[0]!.messages;
    expect(messages[1]!.content).toBe('');
    expect(messages[1]!.reasoning_content).toBe('deep thought');
    expect(messages[2]!.content).toBe('Visible answer.');
  });

  it('drops answer-less sessions so empty assistant targets are never trained', () => {
    // A record whose every assistant turn is reasoning-only (or a degraded
    // placeholder) would teach a model to emit nothing, so it is refused.
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: '[Thinking]\nonly thoughts' }),
      ])
    );
    expect(result.records).toHaveLength(0);
    expect(result.dropReason).toBe('no-usable-content');
  });

  it('separates reasoning from natural text when they are distinct messages', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: 'The answer is 42.' }),
      ])
    );
    const assistant = result.records[0]!.messages[1]!;
    expect(assistant.content).toBe('The answer is 42.');
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it('drops reasoning when disabled', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: 'Visible answer.' }),
        message({ role: 'assistant', content: '[Thinking]\ndeep thought' }),
      ]),
      { includeReasoning: false }
    );
    const messages = result.records[0]!.messages;
    expect(messages.every((entry) => entry.reasoning_content === undefined)).toBe(true);
  });

  it('splits oversized sessions at user-turn boundaries and labels segments', () => {
    const messages: Message[] = [];
    for (let index = 0; index < 6; index += 1) {
      messages.push(message({ role: 'user', content: `question ${index}` }));
      messages.push(message({ role: 'assistant', content: 'x'.repeat(500) }));
    }
    const result = projectSession(session(messages), { maxCharsPerRecord: 1200 });
    expect(result.records.length).toBeGreaterThan(1);
    for (const record of result.records) {
      expect(record.metadata.segment!.total).toBe(result.records.length);
    }
    // Every segment starts at a user turn so no agent loop is answered context-free.
    for (const record of result.records) {
      expect(record.messages[0]!.role).toBe('user');
    }
    const ids = result.records.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('drops sessions with no user turn', () => {
    const result = projectSession(session([message({ role: 'assistant', content: 'orphan' })]));
    expect(result.records).toHaveLength(0);
    expect(result.dropReason).toBe('no-user-turn');
  });

  it('drops sessions whose assistant turns carry no usable content', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'hello' }),
        message({ role: 'assistant', content: '[empty message]' }),
      ])
    );
    expect(result.records).toHaveLength(0);
    expect(result.dropReason).toBe('no-usable-content');
  });

  it('honours minUserTurns', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'only one' }),
        message({ role: 'assistant', content: 'ok' }),
      ]),
      { minUserTurns: 2 }
    );
    expect(result.records).toHaveLength(0);
    expect(result.dropReason).toBe('below-min-user-turns');
  });

  it('prefixes an optional system prompt', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: 'a' }),
      ]),
      { systemPrompt: 'You are a coding agent.' }
    );
    expect(result.records[0]!.messages[0]).toEqual({
      role: 'system',
      content: 'You are a coding agent.',
    });
  });

  it('truncates tool results at maxToolResultChars', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({
          role: 'assistant',
          content: 'ok',
          toolCalls: [
            { name: 'read_file', status: 'completed', params: {}, result: 'y'.repeat(200) },
          ],
        }),
      ]),
      { maxToolResultChars: 50 }
    );
    const tool = result.records[0]!.messages[2]!;
    expect(tool.content).toContain('[... truncated 150 chars]');
  });

  it('keeps tool arguments parseable even when values contain shell-quoted secrets', () => {
    // Regression: redacting the *serialized* arguments deleted a closing quote
    // and produced invalid JSON (225 occurrences in a real history export).
    // Sanitizing each value before serialization keeps the JSON structural.
    const command =
      'cd /repo && export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?}" && node setup.ts';
    const result = projectSession(
      session([
        message({ role: 'user', content: 'run it' }),
        message({
          role: 'assistant',
          content: 'ok',
          toolCalls: [
            {
              name: 'run_terminal_command',
              status: 'completed',
              params: { command, cwd: '', 'API_KEY"': 'x' },
              result: 'done',
            },
          ],
        }),
      ])
    );
    const call = result.records[0]!.messages[1]!.tool_calls![0]!;
    expect(() => JSON.parse(call.function.arguments)).not.toThrow();
    expect(() => JSON.parse(call.function.arguments)).not.toThrow();
  });

  it('emits parseable arguments across nested structures and odd values', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({
          role: 'assistant',
          content: 'ok',
          toolCalls: [
            {
              name: 'edit_file',
              status: 'completed',
              params: {
                nested: { deep: ['token=abcdef123456', '"quoted"', 'line\nbreak'] },
                count: 0,
                flag: true,
                nothing: null,
              },
            },
          ],
        }),
      ])
    );
    const call = result.records[0]!.messages[1]!.tool_calls![0]!;
    const parsed = JSON.parse(call.function.arguments) as Record<string, unknown>;
    expect(parsed).toHaveProperty('count', 0);
    expect(parsed).toHaveProperty('flag', true);
    expect(parsed).toHaveProperty('nothing', null);
    expect(JSON.stringify(parsed)).not.toContain('abcdef123456');
  });

  it('records bounded metadata without absolute workspace paths', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: 'a' }),
      ])
    );
    const metadata = result.records[0]!.metadata;
    expect(metadata.workspace).toBe('project');
    expect(metadata.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(metadata.resolutionState).toBeNull();
  });
});

it('redacts sensitive display metadata while preserving native session identity', () => {
  const input = session([
    message({ role: 'user', content: 'q' }),
    message({ role: 'assistant', content: 'a' }),
  ]);
  input.title = 'Debug API_KEY=secret-value-123 in /Users/alice/project';
  const result = projectSession(input);
  expect(result.records[0]!.metadata.title).toBe(
    'Debug API_KEY=[REDACTED] in /Users/<user>/project'
  );
  expect(result.records[0]!.id).toBe(input.id);
  expect(result.shareGpt[0]!.metadata).toEqual(result.records[0]!.metadata);
  expect(input.title).toContain('secret-value-123');
  expect(
    projectSession(input, { redact: false, anonymizePaths: false }).records[0]!.metadata.title
  ).toBe(input.title);
});

describe('toShareGpt', () => {
  it('maps roles and inlines tool calls', () => {
    const conversations = toShareGpt([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ]);
    expect(conversations.map((turn) => turn.from)).toEqual(['human', 'gpt', 'tool']);
    expect(conversations[1]!.value).toContain('[tool_call] grep');
    expect(conversations[2]!.value).toContain('[tool_result]');
  });

  it('throws on an unhandled role rather than silently dropping it', () => {
    expect(() => toShareGpt([{ role: 'bogus' as 'user', content: 'x' }])).toThrow(
      /Unhandled training role/
    );
  });
});

describe('serializeTrainingLine', () => {
  it('emits one JSON object per line for the messages schema', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: 'a' }),
      ])
    );
    const line = serializeTrainingLine(result.records[0]!, 'messages');
    expect(line).not.toContain('\n');
    expect(JSON.parse(line).schema).toBe('cursor-history-training/v1');
  });

  it('emits the sharegpt shape when requested', () => {
    const result = projectSession(
      session([
        message({ role: 'user', content: 'q' }),
        message({ role: 'assistant', content: 'a' }),
      ])
    );
    const line = serializeTrainingLine(result.shareGpt[0]!, 'sharegpt');
    const parsed = JSON.parse(line);
    expect(parsed.conversations.map((turn: { from: string }) => turn.from)).toEqual([
      'human',
      'gpt',
    ]);
    expect(parsed.schema).toBeUndefined();
  });
});

describe('baseSessionKey', () => {
  it('strips segment suffixes to the stable session key', () => {
    expect(baseSessionKey('abc')).toBe('abc');
    expect(baseSessionKey('abc#2')).toBe('abc');
  });
});

describe('assignSplit', () => {
  it('sends everything to train when the ratio is zero or negative', () => {
    for (const id of ['a', 'b', 'c#1']) {
      expect(assignSplit(id, 0)).toBe('train');
      expect(assignSplit(id, -1)).toBe('train');
    }
  });

  it('sends everything to validation at ratio 1', () => {
    expect(assignSplit('a', 1)).toBe('validation');
  });

  it('is deterministic across calls', () => {
    const first = assignSplit('session-x', 0.25);
    for (let index = 0; index < 20; index += 1) {
      expect(assignSplit('session-x', 0.25)).toBe(first);
    }
  });

  it('keeps every segment of one session in the same split', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = `session-${index}`;
      const parent = assignSplit(id, 0.3);
      for (let segment = 1; segment <= 4; segment += 1) {
        expect(assignSplit(`${id}#${segment}`, 0.3)).toBe(parent);
      }
    }
  });

  it('approximates the requested ratio over many sessions', () => {
    let validation = 0;
    const total = 4000;
    for (let index = 0; index < total; index += 1) {
      if (assignSplit(`s-${index}`, 0.2) === 'validation') validation += 1;
    }
    const observed = validation / total;
    expect(observed).toBeGreaterThan(0.15);
    expect(observed).toBeLessThan(0.25);
  });

  it('reshuffles assignments when the seed changes', () => {
    const a = Array.from({ length: 200 }, (_, index) => assignSplit(`s-${index}`, 0.5, 1));
    const b = Array.from({ length: 200 }, (_, index) => assignSplit(`s-${index}`, 0.5, 2));
    expect(a).not.toEqual(b);
  });
});

describe('deriveValidationPath', () => {
  it('inserts the marker before the .jsonl extension', () => {
    expect(deriveValidationPath('/tmp/dataset.jsonl')).toBe('/tmp/dataset.validation.jsonl');
  });

  it('appends when there is no .jsonl extension', () => {
    expect(deriveValidationPath('/tmp/dataset')).toBe('/tmp/dataset.validation.jsonl');
  });
});

describe('defaults', () => {
  it('redacts and anonymizes by default', () => {
    expect(TRAINING_DEFAULT_OPTIONS.redact).toBe(true);
    expect(TRAINING_DEFAULT_OPTIONS.anonymizePaths).toBe(true);
  });
});
