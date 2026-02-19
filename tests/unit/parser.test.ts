import { describe, it, expect } from 'vitest';
import {
  parseChatData,
  extractCodeBlocks,
  extractPreview,
  getSearchSnippets,
  exportToMarkdown,
  exportToJson,
} from '../../src/core/parser.js';
import type { ChatSession, Message } from '../../src/core/types.js';

function msg(role: 'user' | 'assistant', content: string): Message {
  return { id: null, role, content, timestamp: new Date('2024-01-15T10:00:00Z'), codeBlocks: [] };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'abc-123',
    index: 1,
    title: 'Test Chat',
    createdAt: new Date('2024-01-15T10:00:00Z'),
    lastUpdatedAt: new Date('2024-01-15T11:00:00Z'),
    messageCount: 2,
    messages: [msg('user', 'Hello'), msg('assistant', 'Hi there!')],
    workspaceId: 'ws-1',
    ...overrides,
  };
}

// =============================================================================
// parseChatData
// =============================================================================
describe('parseChatData', () => {
  it('returns empty array for invalid JSON', () => {
    expect(parseChatData('not json')).toEqual([]);
  });

  it('returns empty array for empty object', () => {
    expect(parseChatData('{}')).toEqual([]);
  });

  it('parses legacy format with chatSessions key', () => {
    const data = {
      chatSessions: [
        {
          id: 's1',
          title: 'Test',
          createdAt: 1705300000000,
          messages: [{ role: 'user', content: 'hi' }],
        },
      ],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s1');
    expect(result[0]!.title).toBe('Test');
  });

  it('parses legacy format with tabs key', () => {
    const data = {
      tabs: [
        {
          id: 's2',
          messages: [{ role: 'user', content: 'hello' }],
        },
      ],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('s2');
  });

  it('filters sessions without id', () => {
    const data = {
      chatSessions: [
        { messages: [{ role: 'user', content: 'no id' }] },
        { id: 'valid', messages: [{ role: 'user', content: 'has id' }] },
      ],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('valid');
  });

  it('filters sessions with no messages', () => {
    const data = {
      chatSessions: [
        { id: 'empty', messages: [] },
        { id: 'has-msgs', messages: [{ role: 'user', content: 'hi' }] },
      ],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('has-msgs');
  });

  it('parses composer format with allComposers', () => {
    const data = {
      allComposers: [
        {
          composerId: 'c1',
          name: 'My Chat',
          createdAt: 1705300000000,
          lastUpdatedAt: 1705303600000,
        },
      ],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('c1');
    expect(result[0]!.title).toBe('My Chat');
    expect(result[0]!.messages[0]!.content).toBe('My Chat');
  });

  it('uses (Empty session) for composer without name', () => {
    const data = {
      allComposers: [{ composerId: 'c2', createdAt: 1705300000000 }],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.messages[0]!.content).toBe('(Empty session)');
  });

  it('skips composers without composerId', () => {
    const data = {
      allComposers: [{ name: 'No ID' }, { composerId: 'c3', name: 'Has ID' }],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('c3');
  });

  it('matches generations to composer by time range', () => {
    const data = {
      allComposers: [{ composerId: 'c4', createdAt: 1000000, lastUpdatedAt: 2000000 }],
    };
    const bundle = {
      generations: JSON.stringify([
        { unixMs: 1500000, generationUUID: 'g1', textDescription: 'generated text' },
      ]),
    };
    const result = parseChatData(JSON.stringify(data), bundle);
    expect(result).toHaveLength(1);
    // Should include the generation as a message
    const messages = result[0]!.messages;
    expect(messages.some((m) => m.content === 'generated text')).toBe(true);
  });

  it('handles invalid generations JSON gracefully', () => {
    const data = {
      allComposers: [{ composerId: 'c5', name: 'Test' }],
    };
    const bundle = { generations: 'not valid json' };
    const result = parseChatData(JSON.stringify(data), bundle);
    expect(result).toHaveLength(1);
  });

  it('normalizes role strings', () => {
    const data = {
      chatSessions: [
        {
          id: 's3',
          messages: [
            { role: 'ai', content: 'AI response' },
            { role: 'bot', content: 'Bot response' },
            { role: 'system', content: 'System' },
            { type: 'user', content: 'User typed' },
          ],
        },
      ],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result[0]!.messages[0]!.role).toBe('assistant');
    expect(result[0]!.messages[1]!.role).toBe('assistant');
    expect(result[0]!.messages[2]!.role).toBe('assistant');
    expect(result[0]!.messages[3]!.role).toBe('user');
  });

  it('uses bubbles as alternative to messages key', () => {
    const data = {
      chatSessions: [{ id: 's4', bubbles: [{ role: 'user', content: 'via bubbles' }] }],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.messages[0]!.content).toBe('via bubbles');
  });

  it('derives title from first user message when not set', () => {
    const data = {
      chatSessions: [{ id: 's5', messages: [{ role: 'user', content: 'Short question' }] }],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result[0]!.title).toBe('Short question');
  });

  it('truncates derived title at 50 chars', () => {
    const longMsg = 'A'.repeat(60);
    const data = {
      chatSessions: [{ id: 's6', messages: [{ role: 'user', content: longMsg }] }],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result[0]!.title).toBe('A'.repeat(47) + '...');
  });

  it('uses text field as alternative to content', () => {
    const data = {
      chatSessions: [{ id: 's7', messages: [{ role: 'user', text: 'via text field' }] }],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result[0]!.messages[0]!.content).toBe('via text field');
  });

  it('uses lastSendTime as fallback for lastUpdatedAt', () => {
    const data = {
      chatSessions: [
        { id: 's8', lastSendTime: 1705310000000, messages: [{ role: 'user', content: 'hi' }] },
      ],
    };
    const result = parseChatData(JSON.stringify(data));
    expect(result[0]!.lastUpdatedAt.getTime()).toBe(1705310000000);
  });
});

// =============================================================================
// extractCodeBlocks
// =============================================================================
describe('extractCodeBlocks', () => {
  it('returns empty array for no code blocks', () => {
    expect(extractCodeBlocks('plain text')).toEqual([]);
  });

  it('extracts single block with language', () => {
    const content = '```typescript\nconst x = 1;\n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('typescript');
    expect(blocks[0]!.content).toBe('const x = 1;');
  });

  it('extracts multiple blocks', () => {
    const content = '```js\na\n```\ntext\n```python\nb\n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.language).toBe('js');
    expect(blocks[1]!.language).toBe('python');
  });

  it('handles block with no language', () => {
    const content = '```\ncode here\n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBeNull();
  });

  it('calculates startLine correctly', () => {
    const content = 'line0\nline1\n```js\ncode\n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks[0]!.startLine).toBe(2);
  });

  it('trims trailing whitespace from content', () => {
    const content = '```js\ncode  \n  \n```';
    const blocks = extractCodeBlocks(content);
    expect(blocks[0]!.content).toBe('code');
  });
});

// =============================================================================
// extractPreview
// =============================================================================
describe('extractPreview', () => {
  it('returns empty string when no user messages', () => {
    expect(extractPreview([msg('assistant', 'response')])).toBe('');
  });

  it('returns short content as-is', () => {
    expect(extractPreview([msg('user', 'Hello world')])).toBe('Hello world');
  });

  it('truncates at 97 chars with ellipsis', () => {
    const long = 'A'.repeat(150);
    const result = extractPreview([msg('user', long)]);
    expect(result.length).toBe(100);
    expect(result).toBe('A'.repeat(97) + '...');
  });

  it('replaces code blocks with [code]', () => {
    const content = 'Before ```js\ncode\n``` after';
    const result = extractPreview([msg('user', content)]);
    expect(result).toContain('[code]');
    expect(result).not.toContain('```');
  });

  it('collapses multiple newlines to single space', () => {
    const result = extractPreview([msg('user', 'line1\n\n\nline2')]);
    expect(result).toBe('line1 line2');
  });
});

// =============================================================================
// getSearchSnippets
// =============================================================================
describe('getSearchSnippets', () => {
  it('returns empty array when no matches', () => {
    expect(getSearchSnippets([msg('user', 'hello')], 'xyz')).toEqual([]);
  });

  it('finds single match with context', () => {
    const result = getSearchSnippets([msg('user', 'the quick brown fox')], 'quick');
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain('quick');
    expect(result[0]!.messageRole).toBe('user');
  });

  it('uses custom contextChars', () => {
    const longText = 'A'.repeat(100) + 'TARGET' + 'B'.repeat(100);
    const result = getSearchSnippets([msg('user', longText)], 'target', 10);
    expect(result[0]!.text.length).toBeLessThan(longText.length);
  });

  it('is case-insensitive', () => {
    const result = getSearchSnippets([msg('user', 'Hello World')], 'hello');
    expect(result).toHaveLength(1);
  });

  it('adds ellipsis when snippet does not start at beginning', () => {
    const longText = 'A'.repeat(200) + 'match' + 'B'.repeat(200);
    const result = getSearchSnippets([msg('user', longText)], 'match', 10);
    expect(result[0]!.text.startsWith('...')).toBe(true);
  });

  it('adds ellipsis when snippet does not reach end', () => {
    const longText = 'A'.repeat(200) + 'match' + 'B'.repeat(200);
    const result = getSearchSnippets([msg('user', longText)], 'match', 10);
    expect(result[0]!.text.endsWith('...')).toBe(true);
  });

  it('no prefix ellipsis when match at start', () => {
    const result = getSearchSnippets([msg('user', 'match at start')], 'match');
    expect(result[0]!.text.startsWith('...')).toBe(false);
  });

  it('returns matchPositions for found matches', () => {
    const result = getSearchSnippets([msg('user', 'find me here')], 'find');
    expect(result[0]!.matchPositions.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// exportToMarkdown
// =============================================================================
describe('exportToMarkdown', () => {
  it('includes title in header', () => {
    const md = exportToMarkdown(session());
    expect(md).toContain('# Test Chat');
  });

  it('uses Untitled Chat when no title', () => {
    const md = exportToMarkdown(session({ title: null }));
    expect(md).toContain('# Untitled Chat');
  });

  it('includes workspace path when provided', () => {
    const md = exportToMarkdown(session(), '/path/to/workspace');
    expect(md).toContain('**Workspace**: /path/to/workspace');
  });

  it('omits workspace line when not provided', () => {
    const md = exportToMarkdown(session());
    expect(md).not.toContain('**Workspace**');
  });

  it('formats user and assistant messages', () => {
    const md = exportToMarkdown(session());
    expect(md).toContain('### **User**');
    expect(md).toContain('### **Assistant**');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there!');
  });

  it('includes date and message count', () => {
    const md = exportToMarkdown(session());
    expect(md).toContain('**Date**: 2024-01-15');
    expect(md).toContain('**Messages**: 2');
  });
});

// =============================================================================
// exportToJson
// =============================================================================
describe('exportToJson', () => {
  it('returns valid JSON', () => {
    const json = exportToJson(session());
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes all session fields with ISO dates', () => {
    const parsed = JSON.parse(exportToJson(session()));
    expect(parsed.id).toBe('abc-123');
    expect(parsed.title).toBe('Test Chat');
    expect(parsed.createdAt).toBe('2024-01-15T10:00:00.000Z');
    expect(parsed.lastUpdatedAt).toBe('2024-01-15T11:00:00.000Z');
    expect(parsed.messageCount).toBe(2);
  });

  it('workspacePath is null when not provided', () => {
    const parsed = JSON.parse(exportToJson(session()));
    expect(parsed.workspacePath).toBeNull();
  });

  it('includes workspacePath when provided', () => {
    const parsed = JSON.parse(exportToJson(session(), '/my/workspace'));
    expect(parsed.workspacePath).toBe('/my/workspace');
  });

  it('messages include expected fields', () => {
    const parsed = JSON.parse(exportToJson(session()));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].role).toBe('user');
    expect(parsed.messages[0].content).toBe('Hello');
    expect(parsed.messages[0].timestamp).toBe('2024-01-15T10:00:00.000Z');
    expect(parsed.messages[0].codeBlocks).toEqual([]);
  });
});
