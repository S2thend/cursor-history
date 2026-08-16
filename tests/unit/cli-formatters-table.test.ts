import { describe, it, expect } from 'vitest';
import {
  formatSessionsTable,
  formatWorkspacesTable,
  formatSessionDetail,
  formatSearchResultsTable,
  formatExportSuccess,
  formatOperationDiagnostics,
  formatNoHistory,
  formatCursorNotFound,
  filterMessages,
  supportsColor,
} from '../../src/cli/formatters/table.js';
import type {
  ChatSessionSummary,
  Workspace,
  ChatSession,
  SearchResult,
  MessageType,
  SessionDiagnostic,
} from '../../src/core/types.js';

const now = new Date('2024-01-15T10:00:00Z');
const later = new Date('2024-01-15T11:00:00Z');

// Strip ANSI escape codes for reliable string matching in tests
const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

function makeSummary(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: 'sess-1',
    index: 1,
    title: 'Test',
    createdAt: now,
    lastUpdatedAt: later,
    messageCount: 2,
    workspaceId: 'ws-1',
    workspacePath: '~/proj',
    preview: 'Hello',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'sess-1',
    index: 1,
    title: 'Test',
    createdAt: now,
    lastUpdatedAt: later,
    messageCount: 2,
    workspaceId: 'ws-1',
    messages: [
      { id: 'm1', role: 'user', content: 'Hello', timestamp: now, codeBlocks: [] },
      { id: 'm2', role: 'assistant', content: 'Hi there!', timestamp: later, codeBlocks: [] },
    ],
    ...overrides,
  };
}

describe('supportsColor', () => {
  it('returns a boolean', () => {
    expect(typeof supportsColor()).toBe('boolean');
  });
});

describe('formatSessionsTable', () => {
  it('shows message for empty sessions', () => {
    const result = formatSessionsTable([]);
    expect(result).toContain('No chat sessions found');
  });

  it('renders an ambiguous logical row without contested content', () => {
    const result = stripAnsi(
      formatSessionsTable([
        {
          id: 'session-ambiguous',
          index: 2,
          indexScope: 'workspace',
          indexWorkspacePath: '/workspaces/a',
          resolutionState: 'ambiguous',
          sourceRoles: ['composer'],
          occurrenceCount: 2,
          diagnosticOccurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
        },
      ])
    );

    expect(result).toContain('2');
    expect(result).toContain('ambiguous');
    expect(result).toContain('Divergent replicas (2)');
    expect(result).toContain('/workspaces/a');
    expect(result).not.toContain('occurrence:v1:');
  });

  it('formats sessions table with rows', () => {
    const result = formatSessionsTable([makeSummary()]);
    expect(result).toContain('1');
    expect(result).toContain('Hello');
  });

  it('includes Composer ID column when showIds=true', () => {
    const result = formatSessionsTable([makeSummary()], true);
    expect(result).toContain('Composer ID');
    expect(result).toContain('sess-1');
  });

  it('shows session count footer', () => {
    const result = formatSessionsTable([makeSummary(), makeSummary({ index: 2, id: 'sess-2' })]);
    expect(result).toContain('2 session(s)');
  });

  it('marks lower-fidelity Store sessions in the text list', () => {
    const result = stripAnsi(
      formatSessionsTable([
        makeSummary({ source: 'transcript' }),
        makeSummary({ index: 2, id: 'sess-2', source: 'store-complete' }),
      ])
    );
    expect(result).toContain('⚠ partial');
    expect(result).toContain('⚠ metadata');
  });

  it('renders partial resolution and omitted source details independently of source label', () => {
    const result = stripAnsi(
      formatSessionsTable([
        makeSummary({
          source: 'merged',
          resolutionState: 'partial',
          resolution: {
            state: 'partial',
            expectedSourceRoles: ['composer', 'store'],
            loadedSourceRoles: ['composer'],
            omittedSourceRoles: ['store'],
            failedSourceRoles: [],
            reasonCodes: ['workspace-scope-omitted'],
          },
        }),
      ])
    );
    expect(result).toContain('⚠ partial');
    expect(result).toContain('#1 omitted source: store');
    expect(result).toContain('workspace-scope-omitted');
  });
});

describe('formatWorkspacesTable', () => {
  it('shows message for empty workspaces', () => {
    const result = formatWorkspacesTable([]);
    expect(result).toContain('No workspaces');
  });

  it('formats workspace rows', () => {
    const ws: Workspace = { id: 'ws-1', path: '~/projects/test', dbPath: '/db', sessionCount: 5 };
    const result = formatWorkspacesTable([ws]);
    expect(result).toContain('5');
    expect(result).toContain('~/projects/test');
  });
});

describe('formatSessionDetail', () => {
  it('shows basic user/assistant messages', () => {
    const result = formatSessionDetail(makeSession());
    expect(result).toContain('You:');
    expect(result).toContain('Assistant:');
    expect(result).toContain('Hello');
    expect(result).toContain('Hi there!');
  });

  it('includes session header', () => {
    const result = formatSessionDetail(makeSession());
    expect(result).toContain('Chat Session #1');
    expect(result).toContain('Test');
  });

  it('truncates messages in short mode', () => {
    const longContent = 'A'.repeat(500);
    const s = makeSession({
      messages: [{ id: 'm1', role: 'user', content: longContent, timestamp: now, codeBlocks: [] }],
    });
    const result = formatSessionDetail(s, undefined, { short: true });
    expect(result).not.toContain(longContent);
    expect(result).toContain('...');
  });

  it('formats tool call messages', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '[Tool: Read File]\nFile: /path/to/file',
          timestamp: now,
          codeBlocks: [],
        },
      ],
    });
    const result = formatSessionDetail(s);
    expect(result).toContain('Tool:');
    expect(result).toContain('Read File');
  });

  it('truncates tool Content lines without fullTool', () => {
    const longContent = 'C'.repeat(500);
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: `[Tool: Read File]\nContent: ${longContent}`,
          timestamp: now,
          codeBlocks: [],
        },
      ],
    });
    const result = stripAnsi(formatSessionDetail(s));
    expect(result).toContain(`Content: ${longContent.slice(0, 100)}...`);
    expect(result).not.toContain(`Content: ${longContent}`);
  });

  it('preserves tool Content lines with fullTool', () => {
    const longContent = 'C'.repeat(500);
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: `[Tool: Read File]\nContent: ${longContent}`,
          timestamp: now,
          codeBlocks: [],
        },
      ],
    });
    const result = stripAnsi(formatSessionDetail(s, undefined, { fullTool: true }));
    expect(result).toContain(`Content: ${longContent}`);
  });

  it('formats error messages', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '[Error]\nSomething went wrong',
          timestamp: now,
          codeBlocks: [],
        },
      ],
    });
    const result = formatSessionDetail(s);
    expect(result).toContain('Error');
    expect(result).toContain('Something went wrong');
  });

  it('formats thinking messages', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '[Thinking]\nLet me analyze...',
          timestamp: now,
          codeBlocks: [],
        },
      ],
    });
    const result = formatSessionDetail(s);
    expect(result).toContain('Thinking');
    expect(result).toContain('Let me analyze');
  });

  it('renders consecutive duplicate messages separately without folding', () => {
    const ts1 = new Date('2024-01-15T10:00:00Z');
    const ts2 = new Date('2024-01-15T10:01:00Z');
    const ts3 = new Date('2024-01-15T10:02:00Z');
    const s = makeSession({
      messages: [
        { id: 'm1', role: 'user', content: 'same', timestamp: ts1, codeBlocks: [] },
        { id: 'm2', role: 'user', content: 'same', timestamp: ts2, codeBlocks: [] },
        { id: 'm3', role: 'user', content: 'same', timestamp: ts3, codeBlocks: [] },
      ],
    });
    const result = formatSessionDetail(s);
    // Every resolved message is rendered once; no ×N folding marker.
    expect(result).not.toContain('×3');
    expect((result.match(/\bsame\b/g) ?? []).length).toBe(3);
  });

  it('--only tool renders every distinct structured tool-call message', () => {
    // Two assistant turns with empty text but DIFFERENT tool calls; both must
    // survive filtering and render (no folding onto one block).
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          codeBlocks: [],
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '',
          codeBlocks: [],
          toolCalls: [{ name: 'Write', status: 'completed', params: { file: '/b' } }],
        },
      ],
    });
    const filter: MessageType[] = ['tool'];
    const result = stripAnsi(
      formatSessionDetail(s, undefined, { messageFilter: filter, originalMessageCount: 2 })
    );
    expect((result.match(/🔧 Read/g) ?? []).length).toBe(1);
    expect((result.match(/🔧 Write/g) ?? []).length).toBe(1);
    expect(result).not.toContain('×2');
  });

  it('assigns a mixed assistant/tool message to its one actual category', () => {
    const mixed = {
      id: 'm1',
      role: 'assistant' as const,
      content: 'I inspected the file and found the issue.',
      codeBlocks: [],
      toolCalls: [{ name: 'Read', status: 'completed' as const, params: { file: '/a' } }],
    };

    expect(filterMessages([mixed], ['assistant'])).toEqual([]);
    expect(filterMessages([mixed], ['tool'])).toEqual([mixed]);
  });

  it('preserves explicit marker categories when marked messages carry tool calls', () => {
    const marked = [
      {
        role: 'assistant',
        content: '[Thinking]\nInspecting the repository',
        toolCalls: [{ name: 'Read' }],
      },
      {
        role: 'assistant',
        content: '[Error]\nRead failed',
        toolCalls: [{ name: 'Read' }],
      },
    ];

    expect(filterMessages(marked, ['assistant'])).toEqual([]);
    expect(filterMessages(marked, ['tool'])).toEqual([]);
    expect(filterMessages(marked, ['thinking'])).toEqual([marked[0]]);
    expect(filterMessages(marked, ['error'])).toEqual([marked[1]]);
  });

  it('renders structured calls carried by thinking and error messages', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '[Thinking]\nInspecting the repository',
          codeBlocks: [],
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '[Error]\nWrite failed',
          codeBlocks: [],
          toolCalls: [
            {
              name: 'Write',
              status: 'error',
              params: { file: '/b' },
              error: 'disk full',
            },
          ],
        },
      ],
    });

    const normal = stripAnsi(formatSessionDetail(s));
    expect(normal).toContain('Thinking:');
    expect(normal).toContain('Error:');
    expect(normal).toContain('🔧 Read');
    expect(normal).toContain('🔧 Write');

    expect(filterMessages(s.messages, ['tool'])).toEqual([]);
    const actualCategories = filterMessages(s.messages, ['thinking', 'error']);
    const full = stripAnsi(
      formatSessionDetail({ ...s, messages: actualCategories }, undefined, { fullTool: true })
    );
    expect(full).toContain('params: {"file":"/a"}');
    expect(full).toContain('error: disk full');
  });

  it('marks inferred and unknown human timestamps approximate but leaves direct time exact', () => {
    const s = makeSession({
      messages: [
        {
          id: 'direct',
          role: 'user',
          content: 'direct',
          timestamp: now,
          timestampSource: 'composer-timing',
          codeBlocks: [],
        },
        {
          id: 'inferred',
          role: 'assistant',
          content: 'inferred',
          timestamp: later,
          timestampSource: 'inferred-next',
          codeBlocks: [],
        },
        {
          id: 'unknown',
          role: 'assistant',
          content: 'unknown',
          timestamp: later,
          timestampSource: 'unknown',
          codeBlocks: [],
        },
      ],
    });

    const result = stripAnsi(formatSessionDetail(s));
    expect(result).toMatch(/You: (?!≈)/);
    expect(result.match(/≈/g) ?? []).toHaveLength(2);
  });

  it('shows filter info when messageFilter is active', () => {
    const filter: MessageType[] = ['user'];
    const s = makeSession();
    const result = formatSessionDetail(s, undefined, {
      messageFilter: filter,
      originalMessageCount: 10,
    });
    expect(result).toContain('2 of 10');
    expect(result).toContain('user');
  });

  it('--tool renders full params, status, result, error, and files', () => {
    const longParam = 'x'.repeat(120);
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          codeBlocks: [],
          toolCalls: [
            {
              name: 'Write',
              status: 'error',
              params: { file: longParam },
              error: 'disk full',
              files: ['/a.txt', '/b.txt'],
            },
          ],
        },
      ],
    });
    const full = stripAnsi(formatSessionDetail(s, undefined, { fullTool: true }));
    // Full params (not truncated), status, error, and files all rendered.
    expect(full).toContain(longParam);
    expect(full).toContain('status: error');
    expect(full).toContain('error: disk full');
    expect(full).toContain('files: /a.txt, /b.txt');
  });

  it('--tool exposes structured details for an embedded Composer tool call', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '[Tool: Read File]\nFile: /a',
          codeBlocks: [],
          toolCalls: [
            {
              name: 'read_file',
              status: 'completed',
              params: { file: '/a' },
              result: '',
              files: [],
            },
          ],
        },
      ],
    });
    const full = stripAnsi(formatSessionDetail(s, undefined, { fullTool: true }));
    expect(full).toContain('params: {"file":"/a"}');
    expect(full).toContain('status: completed');
    expect(full).toContain('result: ');
    expect(full).toContain('files: []');
    expect((full.match(/🔧/g) ?? []).length).toBe(1);
  });

  it('normal view suppresses only the embedded call and keeps additional merged calls', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '[Tool: Read File]\nFile: /a',
          codeBlocks: [],
          toolCalls: [
            { name: 'read_file', status: 'completed', params: { file: '/a' } },
            { name: 'write_file', status: 'completed', params: { file: '/b' } },
          ],
        },
      ],
    });
    const normal = stripAnsi(formatSessionDetail(s));
    expect(normal).not.toContain('🔧 read_file');
    expect(normal).toContain('🔧 write_file');
  });

  it('keeps a distinct same-name structured call when the embedded identity disagrees', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '[Tool: Read File]\nFile: /a',
          codeBlocks: [],
          toolCalls: [{ name: 'read_file', status: 'completed', params: { targetFile: '/b' } }],
        },
      ],
    });

    const normal = stripAnsi(formatSessionDetail(s));
    expect(normal).toContain('File: /a');
    expect(normal).toContain('🔧 read_file');
    expect(normal).toContain('targetFile="/b"');
  });

  it('--tool preserves an explicitly defined empty error', () => {
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          codeBlocks: [],
          toolCalls: [{ name: 'Write', status: 'error', error: '' }],
        },
      ],
    });
    const full = stripAnsi(formatSessionDetail(s, undefined, { fullTool: true }));
    expect(full).toContain('error: ');
  });

  it('normal view truncates long structured-tool params', () => {
    const longParam = 'y'.repeat(120);
    const s = makeSession({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          codeBlocks: [],
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: longParam } }],
        },
      ],
    });
    const normal = stripAnsi(formatSessionDetail(s));
    expect(normal).not.toContain(longParam);
    expect(normal).toContain('...');
  });

  it('shows info message when filter results in empty', () => {
    const filter: MessageType[] = ['thinking'];
    const s = makeSession({ messages: [] });
    const result = formatSessionDetail(s, undefined, { messageFilter: filter });
    expect(result).toContain('No messages match the filter');
  });

  it('includes workspace path when provided', () => {
    const result = formatSessionDetail(makeSession(), '~/my/workspace');
    expect(result).toContain('~/my/workspace');
  });

  it('shows degraded warning for workspace fallback sessions', () => {
    const result = formatSessionDetail(makeSession({ source: 'workspace-fallback' }));
    expect(result).toContain('Partial data');
    expect(result).toContain('workspace fallback');
  });

  it('shows omitted sources and reasons for a partial merged detail view', () => {
    const result = stripAnsi(
      formatSessionDetail(
        makeSession({
          source: 'merged',
          resolution: {
            state: 'partial',
            expectedSourceRoles: ['composer', 'store'],
            loadedSourceRoles: ['composer'],
            omittedSourceRoles: ['store'],
            failedSourceRoles: [],
            reasonCodes: ['workspace-scope-omitted'],
          },
        })
      )
    );
    expect(result).toContain('Partial data - unavailable sources: store');
    expect(result).toContain('workspace-scope-omitted');
    expect(result).not.toContain('fields and messages combined');
  });

  it.each(['store', 'store-complete'] as const)(
    'shows missing metadata warning for %s sessions',
    (source) => {
      const result = stripAnsi(formatSessionDetail(makeSession({ source })));
      expect(result).toContain('Partial metadata');
      expect(result).toContain('tokens');
      expect(result).toContain('per-message timestamps');
    }
  );
});

describe('formatSearchResultsTable', () => {
  it('shows message for empty results', () => {
    const result = formatSearchResultsTable([], 'test');
    expect(result).toContain('No results found');
    expect(result).toContain('test');
  });

  it('formats search results with matches', () => {
    const sr: SearchResult = {
      sessionId: 's1',
      index: 1,
      workspacePath: '~/proj',
      createdAt: now,
      matchCount: 3,
      snippets: [{ messageRole: 'user', text: 'found it here', matchPositions: [[6, 8]] }],
    };
    const result = formatSearchResultsTable([sr], 'it');
    expect(result).toContain('#1');
    expect(result).toContain('3 match');
    // Strip ANSI codes because role prefix and match highlighting add escape sequences
    expect(stripAnsi(result)).toContain('[You] found it here');
  });
});

describe('formatExportSuccess', () => {
  it('shows exported count and paths', () => {
    const result = formatExportSuccess([{ index: 1, path: '/out/1.md' }]);
    expect(result).toContain('1 session');
    expect(result).toContain('/out/1.md');
  });
});

describe('formatOperationDiagnostics', () => {
  it('renders each safe diagnostic once with the session, count, and recovery action', () => {
    const diagnostics: SessionDiagnostic[] = [
      {
        code: 'SESSION_AMBIGUOUS',
        message: 'Divergent physical occurrences were skipped.',
        sessionId: 'session-ambiguous',
        occurrenceCount: 2,
        occurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
        remedy: 'Resolve or remove the divergent replicas, then retry.',
      },
    ];

    const result = stripAnsi(formatOperationDiagnostics(diagnostics));

    expect(result).toContain('1 session diagnostic');
    expect(result).toContain('session-ambiguous');
    expect(result).toContain('Physical occurrences: 2');
    expect(result).toContain('Next step:');
    expect(result).toContain('Resolve or remove the divergent replicas');
    expect(result).not.toContain('occurrence:v1:a');
  });

  it('returns an empty string when the operation has no diagnostics', () => {
    expect(formatOperationDiagnostics([])).toBe('');
  });
});

describe('formatNoHistory', () => {
  it('returns guidance text', () => {
    const result = formatNoHistory();
    expect(result).toContain('No chat history');
    expect(result).toContain('Cursor');
  });

  it('gives actionable workspace-scoped empty-result guidance', () => {
    const result = formatNoHistory('my-project');
    expect(result).toContain('No chat sessions matched workspace: my-project');
    expect(result).toContain('list --workspaces');
    expect(result).toContain('complete path');
  });
});

describe('formatCursorNotFound', () => {
  it('includes search path', () => {
    const result = formatCursorNotFound('/search/path');
    expect(result).toContain('/search/path');
    expect(result).toContain('--data-path');
  });
});
