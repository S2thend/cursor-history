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

function msg(
  role: 'user' | 'assistant',
  content: string,
  overrides: Partial<Message> = {}
): Message {
  return {
    id: null,
    role,
    content,
    timestamp: new Date('2024-01-15T10:00:00Z'),
    codeBlocks: [],
    ...overrides,
  };
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

  it('parses composer sessions from root-level composer array', () => {
    const data = [
      {
        composerId: 'c-array-1',
        name: 'Array Chat',
        createdAt: 1705300000000,
        lastUpdatedAt: 1705303600000,
      },
    ];

    const result = parseChatData(JSON.stringify(data));
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('c-array-1');
    expect(result[0]!.title).toBe('Array Chat');
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

  it('renders message IDs only when available', () => {
    const md = exportToMarkdown(
      session({
        messages: [msg('user', 'Hello', { id: 'bubble-1' }), msg('assistant', 'Hi there!')],
      })
    );

    expect(md).toContain('**ID**: `bubble-1`');
    expect(md.match(/\*\*ID\*\*:/g)).toHaveLength(1);
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

  it('includes message IDs only when available', () => {
    const parsed = JSON.parse(
      exportToJson(
        session({
          messages: [msg('user', 'Hello', { id: 'bubble-1' }), msg('assistant', 'Hi there!')],
        })
      )
    );

    expect(parsed.messages[0].id).toBe('bubble-1');
    expect(parsed.messages[1].id).toBeUndefined();
  });

  it('includes activeBranchBubbleIds when defined', () => {
    const parsed = JSON.parse(
      exportToJson(
        session({
          activeBranchBubbleIds: ['bubble-1', 'bubble-2'],
        })
      )
    );

    expect(parsed.activeBranchBubbleIds).toEqual(['bubble-1', 'bubble-2']);
  });

  it('omits activeBranchBubbleIds when undefined', () => {
    const parsed = JSON.parse(exportToJson(session()));

    expect(parsed.activeBranchBubbleIds).toBeUndefined();
  });
});

describe('exportToJson — resolved-session fallback and provenance', () => {
  it('falls back to session.workspacePath when no explicit path is supplied', () => {
    const parsed = JSON.parse(exportToJson(session({ workspacePath: '/store/ws' })));
    expect(parsed.workspacePath).toBe('/store/ws');
  });

  it('explicit workspacePath still wins over session.workspacePath', () => {
    const parsed = JSON.parse(exportToJson(session({ workspacePath: '/store/ws' }), '/explicit'));
    expect(parsed.workspacePath).toBe('/explicit');
  });

  it('preserves merged provenance (source/sources/preferredSource)', () => {
    const parsed = JSON.parse(
      exportToJson(
        session({
          source: 'merged',
          sources: ['composer', 'store'],
          preferredSource: 'store',
        })
      )
    );
    expect(parsed.source).toBe('merged');
    expect(parsed.sources).toEqual(['composer', 'store']);
    expect(parsed.preferredSource).toBe('store');
  });

  it('serializes additive resolution and stable identity metadata', () => {
    const parsed = JSON.parse(
      exportToJson(
        session({
          source: 'global',
          resolvedSource: 'merged',
          sources: ['composer', 'store'],
          messageIdentityVersion: 1,
          resolution: {
            state: 'complete',
            expectedSourceRoles: ['composer', 'store'],
            loadedSourceRoles: ['composer', 'store'],
            omittedSourceRoles: [],
            failedSourceRoles: [],
            reasonCodes: [],
          },
          activeBranchMessageIds: ['msg:0'],
          messages: [
            msg('assistant', 'done', {
              id: 'msg:0',
              messageIdentityVersion: 1,
              identityOrigin: 'composer-v0.16-index',
              parentMessageId: 'native-parent',
              isSidechain: false,
              toolCalls: [
                {
                  id: 'tool:v1:synthetic',
                  identityOrigin: 'tool-v1',
                  name: 'Read',
                  status: 'completed',
                },
              ],
            }),
          ],
        })
      )
    );

    expect(parsed).toMatchObject({
      source: 'global',
      resolvedSource: 'merged',
      messageIdentityVersion: 1,
      activeBranchMessageIds: ['msg:0'],
      resolution: { state: 'complete' },
    });
    expect(parsed.messages[0]).toMatchObject({
      id: 'msg:0',
      messageIdentityVersion: 1,
      identityOrigin: 'composer-v0.16-index',
      parentMessageId: 'native-parent',
      isSidechain: false,
    });
    expect(parsed.messages[0].toolCalls[0]).toMatchObject({
      id: 'tool:v1:synthetic',
      identityOrigin: 'tool-v1',
    });
  });

  it('preserves Store transcript state in JSON', () => {
    const parsed = JSON.parse(exportToJson(session({ transcriptState: 'partial' })));
    expect(parsed.transcriptState).toBe('partial');
  });

  it('serializes every ToolCall field including error and files', () => {
    const parsed = JSON.parse(
      exportToJson(
        session({
          messages: [
            msg('assistant', '', {
              toolCalls: [
                {
                  id: 'native-tool',
                  identityOrigin: 'source-native',
                  name: 'Write',
                  status: 'error',
                  params: { file: '/a' },
                  error: 'disk full',
                  files: ['/a'],
                },
              ],
            }),
          ],
        })
      )
    );
    const tc = parsed.messages[0].toolCalls[0];
    expect(tc).toMatchObject({ name: 'Write', status: 'error', params: { file: '/a' } });
    expect(tc.error).toBe('disk full');
    expect(tc.files).toEqual(['/a']);
    expect(tc.id).toBe('native-tool');
    expect(tc.identityOrigin).toBe('source-native');
  });

  it('preserves defined empty tool fields', () => {
    const parsed = JSON.parse(
      exportToJson(
        session({
          messages: [
            msg('assistant', '', {
              toolCalls: [
                {
                  name: 'Read',
                  status: 'completed',
                  result: '',
                  error: '',
                  files: [],
                },
              ],
            }),
          ],
        })
      )
    );
    expect(parsed.messages[0].toolCalls[0]).toMatchObject({ result: '', error: '', files: [] });
  });
});

describe('exportToMarkdown — source line and no duplicate tool', () => {
  it('includes the session update timestamp without changing the original date line', () => {
    const md = exportToMarkdown(session());
    expect(md).toContain('**Date**: 2024-01-15');
    expect(md).toContain('**Last Updated**: 2024-01-15T11:00:00.000Z');
  });

  it('includes a readable source line for a single-source Store session', () => {
    const md = exportToMarkdown(session({ source: 'store-complete' }));
    expect(md).toContain('**Source**: Store stack (store.db — complete)');
  });

  it('includes a merged source line', () => {
    const md = exportToMarkdown(
      session({ source: 'merged', sources: ['composer', 'store'], preferredSource: 'composer' })
    );
    expect(md).toContain('**Source**: merged from composer + store (backbone: composer)');
  });

  it('includes Store transcript state', () => {
    const md = exportToMarkdown(session({ source: 'transcript', transcriptState: 'partial' }));
    expect(md).toContain('**Transcript State**: partial');
  });

  it('falls back to session.workspacePath when no explicit path is supplied', () => {
    const md = exportToMarkdown(session({ workspacePath: '/store/ws' }));
    expect(md).toContain('**Workspace**: /store/ws');
  });

  it('does not duplicate a structured tool already represented by embedded Composer [Tool:] text', () => {
    const md = exportToMarkdown(
      session({
        messages: [
          msg('assistant', '[Tool: Read File]\nFile: /a', {
            toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
          }),
        ],
      })
    );
    // Embedded Composer text is kept; the structured call is NOT appended again.
    expect(md).toContain('[Tool: Read File]');
    expect(md).not.toContain('🔧 **Read**');
  });

  it('preserves bounded structured result, error, and files for an embedded Composer tool', () => {
    const fullResult = `${'x'.repeat(240)}RESULT-SENTINEL`;
    const md = exportToMarkdown(
      session({
        messages: [
          msg('assistant', '[Tool: Read File]\nFile: /a', {
            toolCalls: [
              {
                name: 'Read',
                status: 'error',
                params: { file: '/a', encoding: 'utf8' },
                result: fullResult,
                error: 'permission denied',
                files: ['/a'],
              },
            ],
          }),
        ],
      })
    );
    expect(md).not.toContain('🔧 **Read**');
    expect(md).toContain('- parameters: {"file":"/a","encoding":"utf8"}');
    expect(md).toContain('- status: error');
    expect(md).toContain('- error: permission denied');
    expect(md).toContain(`- result: ${'x'.repeat(197)}...`);
    expect(md).not.toContain('RESULT-SENTINEL');
    expect(md).toContain('- files: /a');
  });

  it('matches repeated same-name embedded calls by strong identity instead of shared options', () => {
    const md = exportToMarkdown(
      session({
        messages: [
          msg('assistant', '[Tool: Read File]\nFile: /b\nEncoding: utf8', {
            toolCalls: [
              {
                name: 'read_file',
                status: 'completed',
                params: { file: '/a', encoding: 'utf8' },
              },
              {
                name: 'read_file',
                status: 'completed',
                params: { file: '/b', encoding: 'utf8' },
              },
            ],
          }),
        ],
      })
    );

    expect(md).toContain('- parameters: {"file":"/b","encoding":"utf8"}');
    expect(md).toContain('- 🔧 **read_file** — `file`="/a", `encoding`="utf8"');
    expect(md).not.toContain('- 🔧 **read_file** — `file`="/b"');
  });

  it('suppresses no repeated same-name call when the embedded identity is ambiguous', () => {
    const md = exportToMarkdown(
      session({
        messages: [
          msg('assistant', '[Tool: Read File]\nCompleted', {
            toolCalls: [
              { name: 'read_file', status: 'completed', params: { encoding: 'utf8' } },
              { name: 'read_file', status: 'completed', params: { encoding: 'ascii' } },
            ],
          }),
        ],
      })
    );

    expect((md.match(/🔧 \*\*read_file\*\*/g) ?? []).length).toBe(2);
  });

  it('does not suppress a unique same-name call when its identity conflicts', () => {
    const md = exportToMarkdown(
      session({
        messages: [
          msg('assistant', '[Tool: Read File]\nFile: /a', {
            toolCalls: [
              {
                name: 'read_file',
                status: 'completed',
                params: { targetFile: '/b' },
              },
            ],
          }),
        ],
      })
    );

    expect(md).toContain('[Tool: Read File]\nFile: /a');
    expect(md).toContain('- 🔧 **read_file** — `targetFile`="/b"');
  });

  it('keeps bounded standalone structured results alongside errors', () => {
    const fullResult = `${'y'.repeat(240)}RESULT-SENTINEL`;
    const md = exportToMarkdown(
      session({
        messages: [
          msg('assistant', '', {
            toolCalls: [
              {
                name: 'Shell',
                status: 'error',
                result: fullResult,
                error: 'ERROR-SENTINEL',
              },
            ],
          }),
        ],
      })
    );

    expect(md).toContain('— error: ERROR-SENTINEL');
    expect(md).toContain(`— result: ${'y'.repeat(197)}...`);
    expect(md).not.toContain('RESULT-SENTINEL');
  });

  it('still renders additional structured calls merged into an embedded Composer tool message', () => {
    const md = exportToMarkdown(
      session({
        messages: [
          msg('assistant', '[Tool: Read File]\nFile: /a', {
            toolCalls: [
              { name: 'read_file', status: 'completed', params: { file: '/a' } },
              { name: 'write_file', status: 'completed', params: { file: '/b' } },
            ],
          }),
        ],
      })
    );
    expect(md).not.toContain('🔧 **read_file**');
    expect(md).toContain('🔧 **write_file**');
  });
});
