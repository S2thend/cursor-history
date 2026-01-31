/**
 * Unit tests for message type filtering functions
 */

import { describe, it, expect } from 'vitest';
import {
  getMessageType,
  filterMessages,
  validateMessageTypes,
  isToolCall,
  isThinking,
  isError,
} from '../../src/cli/formatters/table.js';

describe('isToolCall', () => {
  it('returns true for tool call content', () => {
    expect(isToolCall('[Tool: read_file]\nFile: /path/to/file')).toBe(true);
  });

  it('returns false for non-tool content', () => {
    expect(isToolCall('Here is the answer...')).toBe(false);
  });
});

describe('isThinking', () => {
  it('returns true for thinking content', () => {
    expect(isThinking('[Thinking]\nLet me analyze this...')).toBe(true);
  });

  it('returns false for non-thinking content', () => {
    expect(isThinking('Here is the answer...')).toBe(false);
  });
});

describe('isError', () => {
  it('returns true for error content', () => {
    expect(isError('[Error]\nSomething went wrong')).toBe(true);
  });

  it('returns false for non-error content', () => {
    expect(isError('Here is the answer...')).toBe(false);
  });
});

describe('getMessageType', () => {
  it('returns user for user messages', () => {
    expect(getMessageType({ role: 'user', content: 'Hello' })).toBe('user');
  });

  it('returns tool for tool calls', () => {
    expect(getMessageType({ role: 'assistant', content: '[Tool: read_file]\nFile: /path' })).toBe(
      'tool'
    );
  });

  it('returns thinking for thinking blocks', () => {
    expect(getMessageType({ role: 'assistant', content: '[Thinking]\nLet me think...' })).toBe(
      'thinking'
    );
  });

  it('returns error for error messages', () => {
    expect(getMessageType({ role: 'assistant', content: '[Error]\nSomething went wrong' })).toBe(
      'error'
    );
  });

  it('returns assistant for plain assistant messages', () => {
    expect(getMessageType({ role: 'assistant', content: 'Here is the answer...' })).toBe(
      'assistant'
    );
  });

  it('returns user regardless of content for user role', () => {
    expect(getMessageType({ role: 'user', content: '[Tool: should not match]' })).toBe('user');
  });
});

describe('filterMessages', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: '[Tool: read_file]\nFile: /path' },
    { role: 'assistant', content: 'Here is the answer' },
    { role: 'assistant', content: '[Thinking]\nLet me think...' },
    { role: 'assistant', content: '[Error]\nSomething failed' },
    { role: 'user', content: 'Thanks!' },
  ];

  it('filters to user messages only', () => {
    const result = filterMessages(messages, ['user']);
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.role === 'user')).toBe(true);
  });

  it('filters to tool calls only', () => {
    const result = filterMessages(messages, ['tool']);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain('[Tool:');
  });

  it('filters to assistant messages only (excludes tool, thinking, error)', () => {
    const result = filterMessages(messages, ['assistant']);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('Here is the answer');
  });

  it('filters to thinking blocks only', () => {
    const result = filterMessages(messages, ['thinking']);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain('[Thinking]');
  });

  it('filters to error messages only', () => {
    const result = filterMessages(messages, ['error']);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain('[Error]');
  });

  it('filters to multiple types', () => {
    const result = filterMessages(messages, ['user', 'tool']);
    expect(result).toHaveLength(3); // 2 user + 1 tool
  });

  it('returns all messages when filter is empty', () => {
    const result = filterMessages(messages, []);
    expect(result).toHaveLength(6);
  });

  it('returns all messages when all types specified', () => {
    const result = filterMessages(messages, ['user', 'assistant', 'tool', 'thinking', 'error']);
    expect(result).toHaveLength(6);
  });

  it('preserves message order', () => {
    const result = filterMessages(messages, ['user']);
    expect(result[0]!.content).toBe('Hello');
    expect(result[1]!.content).toBe('Thanks!');
  });
});

describe('validateMessageTypes', () => {
  it('returns empty array for valid types', () => {
    expect(validateMessageTypes(['user', 'tool'])).toEqual([]);
  });

  it('returns empty array for all valid types', () => {
    expect(validateMessageTypes(['user', 'assistant', 'tool', 'thinking', 'error'])).toEqual([]);
  });

  it('returns invalid types', () => {
    expect(validateMessageTypes(['user', 'invalid'])).toEqual(['invalid']);
  });

  it('returns multiple invalid types', () => {
    expect(validateMessageTypes(['foo', 'user', 'bar'])).toEqual(['foo', 'bar']);
  });

  it('returns empty array for empty input', () => {
    expect(validateMessageTypes([])).toEqual([]);
  });

  it('is case-sensitive (uppercase is invalid)', () => {
    expect(validateMessageTypes(['User', 'TOOL'])).toEqual(['User', 'TOOL']);
  });
});
