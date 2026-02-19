/**
 * Shared test fixtures
 */
import type { ChatSession, ChatSessionSummary, Message } from '../../src/core/types.js';

export function sampleMessage(
  role: 'user' | 'assistant' = 'user',
  content = 'Hello world',
  overrides: Partial<Message> = {}
): Message {
  return {
    id: 'msg-1',
    role,
    content,
    timestamp: new Date('2024-01-15T10:30:00Z'),
    codeBlocks: [],
    ...overrides,
  };
}

export function sampleSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-abc-123',
    index: 1,
    title: 'Test Session',
    createdAt: new Date('2024-01-15T10:00:00Z'),
    lastUpdatedAt: new Date('2024-01-15T11:00:00Z'),
    messageCount: 2,
    messages: [sampleMessage('user', 'Hello'), sampleMessage('assistant', 'Hi there!')],
    workspaceId: 'workspace-1',
    ...overrides,
  };
}

export function sampleSummary(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: 'session-abc-123',
    index: 1,
    title: 'Test Session',
    createdAt: new Date('2024-01-15T10:00:00Z'),
    lastUpdatedAt: new Date('2024-01-15T11:00:00Z'),
    messageCount: 2,
    workspaceId: 'workspace-1',
    workspacePath: '~/projects/test',
    preview: 'Hello',
    ...overrides,
  };
}
