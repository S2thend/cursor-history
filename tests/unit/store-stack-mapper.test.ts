import { describe, it, expect } from 'vitest';
import { mapStoreSession } from '../../src/core/parser.js';
import type { StoreSession } from '../../src/core/store-stack/types.js';
import type { Message } from '../../src/core/types.js';

function msg(): Message {
  return { id: null, role: 'user', content: 'hi', timestamp: new Date(0), codeBlocks: [] };
}

function makeStore(over: Partial<StoreSession> = {}): StoreSession {
  return {
    id: 'uuid-1',
    workspacePath: '/proj',
    title: null,
    createdAt: new Date(1783737832293),
    lastUpdatedAt: new Date(1783737832293),
    messages: [],
    source: 'transcript',
    transcriptState: 'parsed',
    ...over,
  };
}

describe('mapStoreSession', () => {
  it('maps StoreSession → ChatSession preserving core fields', () => {
    const cs = mapStoreSession(makeStore({ title: 'T', messages: [msg()] }), 3);
    expect(cs.id).toBe('uuid-1');
    expect(cs.index).toBe(3);
    expect(cs.title).toBe('T');
    expect(cs.messageCount).toBe(1);
    expect(cs.workspaceId).toBe('store');
    expect(cs.workspacePath).toBe('/proj');
    expect(cs.source).toBe('transcript');
    expect(cs.transcriptState).toBe('parsed');
  });

  it('source reflects fidelity (transcript | store)', () => {
    expect(mapStoreSession(makeStore({ source: 'store' }), 1).source).toBe('store');
  });

  it('carries StoreSession.lastUpdatedAt from updatedAtMs or createdAt', () => {
    const updated = new Date(1799999999999);
    const cs = mapStoreSession(makeStore({ lastUpdatedAt: updated }), 0);
    expect(cs.lastUpdatedAt).toEqual(updated);
    expect(cs.lastUpdatedAt).not.toEqual(cs.createdAt);
  });

  it('omits token/usage fields (unavailable in transcript layer)', () => {
    const cs = mapStoreSession(makeStore(), 0);
    expect(cs.usage).toBeUndefined();
    expect(cs.activeBranchBubbleIds).toBeUndefined();
  });
});
