import { describe, it, expect } from 'vitest';
import {
  formatSessionsTable,
  formatWorkspacesTable,
  formatSessionDetail,
  formatSearchResultsTable,
  formatExportSuccess,
  formatNoHistory,
  formatCursorNotFound,
  supportsColor,
} from '../../src/cli/formatters/table.js';
import type { ChatSessionSummary, Workspace, ChatSession, SearchResult, MessageType } from '../../src/core/types.js';

const now = new Date('2024-01-15T10:00:00Z');
const later = new Date('2024-01-15T11:00:00Z');

function makeSummary(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: 'sess-1', index: 1, title: 'Test', createdAt: now, lastUpdatedAt: later,
    messageCount: 2, workspaceId: 'ws-1', workspacePath: '~/proj', preview: 'Hello',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'sess-1', index: 1, title: 'Test', createdAt: now, lastUpdatedAt: later,
    messageCount: 2, workspaceId: 'ws-1',
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
    const s = makeSession({ messages: [{ id: 'm1', role: 'user', content: longContent, timestamp: now, codeBlocks: [] }] });
    const result = formatSessionDetail(s, undefined, { short: true });
    expect(result).not.toContain(longContent);
    expect(result).toContain('...');
  });

  it('formats tool call messages', () => {
    const s = makeSession({
      messages: [
        { id: 'm1', role: 'assistant', content: '[Tool: Read File]\nFile: /path/to/file', timestamp: now, codeBlocks: [] },
      ],
    });
    const result = formatSessionDetail(s);
    expect(result).toContain('Tool:');
    expect(result).toContain('Read File');
  });

  it('formats error messages', () => {
    const s = makeSession({
      messages: [
        { id: 'm1', role: 'assistant', content: '[Error]\nSomething went wrong', timestamp: now, codeBlocks: [] },
      ],
    });
    const result = formatSessionDetail(s);
    expect(result).toContain('Error');
    expect(result).toContain('Something went wrong');
  });

  it('formats thinking messages', () => {
    const s = makeSession({
      messages: [
        { id: 'm1', role: 'assistant', content: '[Thinking]\nLet me analyze...', timestamp: now, codeBlocks: [] },
      ],
    });
    const result = formatSessionDetail(s);
    expect(result).toContain('Thinking');
    expect(result).toContain('Let me analyze');
  });

  it('folds consecutive duplicate messages', () => {
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
    expect(result).toContain('×3');
  });

  it('shows filter info when messageFilter is active', () => {
    const filter: MessageType[] = ['user'];
    const s = makeSession();
    const result = formatSessionDetail(s, undefined, { messageFilter: filter, originalMessageCount: 10 });
    expect(result).toContain('2 of 10');
    expect(result).toContain('user');
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
});

describe('formatSearchResultsTable', () => {
  it('shows message for empty results', () => {
    const result = formatSearchResultsTable([], 'test');
    expect(result).toContain('No results found');
    expect(result).toContain('test');
  });

  it('formats search results with matches', () => {
    const sr: SearchResult = {
      sessionId: 's1', index: 1, workspacePath: '~/proj',
      createdAt: now, matchCount: 3,
      snippets: [{ messageRole: 'user', text: 'found it here', matchPositions: [[6, 8]] }],
    };
    const result = formatSearchResultsTable([sr], 'it');
    expect(result).toContain('#1');
    expect(result).toContain('3 match');
    expect(result).toContain('[You] found it here');
  });
});

describe('formatExportSuccess', () => {
  it('shows exported count and paths', () => {
    const result = formatExportSuccess([{ index: 1, path: '/out/1.md' }]);
    expect(result).toContain('1 session');
    expect(result).toContain('/out/1.md');
  });
});

describe('formatNoHistory', () => {
  it('returns guidance text', () => {
    const result = formatNoHistory();
    expect(result).toContain('No chat history');
    expect(result).toContain('Cursor');
  });
});

describe('formatCursorNotFound', () => {
  it('includes search path', () => {
    const result = formatCursorNotFound('/search/path');
    expect(result).toContain('/search/path');
    expect(result).toContain('--data-path');
  });
});
