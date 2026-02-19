import { describe, it, expect } from 'vitest';
import {
  formatSessionsJson,
  formatWorkspacesJson,
  formatSessionJson,
  formatSearchResultsJson,
  formatExportResultJson,
} from '../../src/cli/formatters/json.js';
import type {
  ChatSessionSummary,
  Workspace,
  ChatSession,
  SearchResult,
  MessageType,
} from '../../src/core/types.js';

const now = new Date('2024-01-15T10:00:00Z');
const later = new Date('2024-01-15T11:00:00Z');

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

describe('formatSessionsJson', () => {
  it('returns valid JSON with count', () => {
    const result = JSON.parse(formatSessionsJson([makeSummary()]));
    expect(result.count).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('sess-1');
  });

  it('handles empty array', () => {
    const result = JSON.parse(formatSessionsJson([]));
    expect(result.count).toBe(0);
    expect(result.sessions).toEqual([]);
  });
});

describe('formatWorkspacesJson', () => {
  it('returns valid JSON with count', () => {
    const ws: Workspace = { id: 'ws-1', path: '~/proj', dbPath: '/db', sessionCount: 3 };
    const result = JSON.parse(formatWorkspacesJson([ws]));
    expect(result.count).toBe(1);
    expect(result.workspaces[0].sessionCount).toBe(3);
  });

  it('handles empty array', () => {
    const result = JSON.parse(formatWorkspacesJson([]));
    expect(result.count).toBe(0);
  });
});

describe('formatSessionJson', () => {
  it('includes basic fields', () => {
    const result = JSON.parse(formatSessionJson(makeSession(), '~/proj'));
    expect(result.id).toBe('sess-1');
    expect(result.title).toBe('Test');
    expect(result.workspacePath).toBe('~/proj');
    expect(result.messages).toHaveLength(2);
  });

  it('adds filter metadata when messageFilter provided', () => {
    const filter: MessageType[] = ['user'];
    const session = makeSession();
    session.messages = [session.messages[0]!]; // Only user message
    const result = JSON.parse(formatSessionJson(session, undefined, filter, 5));
    expect(result.filter).toEqual(['user']);
    expect(result.filteredMessageCount).toBe(1);
    expect(result.messageCount).toBe(5);
  });

  it('adds type field to messages when filtering', () => {
    const filter: MessageType[] = ['user'];
    const result = JSON.parse(formatSessionJson(makeSession(), undefined, filter));
    expect(result.messages[0].type).toBe('user');
    expect(result.messages[1].type).toBe('assistant');
  });

  it('no type field without filter', () => {
    const result = JSON.parse(formatSessionJson(makeSession()));
    expect(result.messages[0].type).toBeUndefined();
  });

  it('workspacePath is null when not provided', () => {
    const result = JSON.parse(formatSessionJson(makeSession()));
    expect(result.workspacePath).toBeNull();
  });
});

describe('formatSearchResultsJson', () => {
  it('includes query and counts', () => {
    const sr: SearchResult = {
      sessionId: 's1',
      index: 1,
      workspacePath: '~/proj',
      createdAt: now,
      matchCount: 2,
      snippets: [{ messageRole: 'user', text: 'match', matchPositions: [[0, 5]] }],
    };
    const result = JSON.parse(formatSearchResultsJson([sr], 'test'));
    expect(result.query).toBe('test');
    expect(result.count).toBe(1);
    expect(result.totalMatches).toBe(2);
  });

  it('handles empty results', () => {
    const result = JSON.parse(formatSearchResultsJson([], 'test'));
    expect(result.count).toBe(0);
    expect(result.totalMatches).toBe(0);
  });
});

describe('formatExportResultJson', () => {
  it('includes count and files', () => {
    const exported = [{ index: 1, path: '/out/1.md' }];
    const result = JSON.parse(formatExportResultJson(exported));
    expect(result.count).toBe(1);
    expect(result.files[0].path).toBe('/out/1.md');
  });
});
