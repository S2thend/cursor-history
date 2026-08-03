import { describe, it, expect } from 'vitest';
import { mergeCrossStackSessions, greedyAnchorPairs } from '../../src/core/store-stack/merge.js';
import { detectPreferredStackSource } from '../../src/lib/platform.js';
import type { ChatSession, Message } from '../../src/core/types.js';

function makeSession(overrides: Partial<ChatSession> & { messages: Message[] }): ChatSession {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: 'uuid-1',
    index: 0,
    title: null,
    createdAt: now,
    lastUpdatedAt: now,
    messageCount: overrides.messages.length,
    workspaceId: 'ws',
    ...overrides,
  };
}

function msg(partial: Partial<Message> & { role: 'user' | 'assistant'; content: string }): Message {
  return { id: null, codeBlocks: [], ...partial };
}

describe('mergeCrossStackSessions', () => {
  it('marks the result merged with both stacks + preferred source', () => {
    const composer = makeSession({ messages: [msg({ role: 'user', content: 'hi' })] });
    const store = makeSession({
      messages: [msg({ role: 'user', content: 'hi' })],
      transcriptState: 'partial',
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 7);
    expect(merged.source).toBe('merged');
    expect(merged.sources).toEqual(['composer', 'store']);
    expect(merged.preferredSource).toBe('composer');
    expect(merged.transcriptState).toBe('partial');
    expect(merged.index).toBe(7);
  });

  it('uses the preferred source as the backbone order (never timestamp-sorted)', () => {
    const t1 = new Date('2026-01-01T09:00:00Z');
    const t2 = new Date('2026-01-01T10:00:00Z');
    // Both stacks agree on order [A, B]; Composer timestamps are NON-monotonic
    // (A is later than B). Timestamp sorting would produce [B, A]; the backbone
    // (Composer) order [A, B] must win.
    const composer = makeSession({
      messages: [
        msg({ role: 'user', content: 'A', timestamp: t2 }),
        msg({ role: 'user', content: 'B', timestamp: t1 }),
      ],
    });
    const store = makeSession({
      messages: [msg({ role: 'user', content: 'A' }), msg({ role: 'user', content: 'B' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages.map((m) => m.content)).toEqual(['A', 'B']);
    expect(merged.messages.every((m) => m.source === 'both')).toBe(true);
  });

  it('on WSL (store backbone) unmatched-message order follows Store', () => {
    // Each stack has one unmatched message between the shared A…B anchors.
    // Backbone selection decides whether the Store-only or Composer-only
    // message comes first.
    const composer = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'composer-only' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'store-only' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const byStore = mergeCrossStackSessions(composer, store, 'store', 0);
    expect(byStore.preferredSource).toBe('store');
    expect(byStore.messages.map((m) => m.content)).toEqual([
      'A',
      'store-only',
      'composer-only',
      'B',
    ]);
    // Composer backbone would order them the other way (composer-only first).
    const byComposer = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(byComposer.messages.map((m) => m.content)).toEqual([
      'A',
      'composer-only',
      'store-only',
      'B',
    ]);
  });

  it('fills missing fields additively without duplicating matched tool calls', () => {
    // Composer has the tool call name+params; Store has the result for the same call.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          model: 'claude-x',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [
            { name: 'Read', status: 'completed', params: { file: '/a' }, result: 'file-contents' },
          ],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1);
    const tc = merged.messages[0]!.toolCalls!;
    expect(tc).toHaveLength(1); // matched, not concatenated
    expect(tc[0]!.result).toBe('file-contents'); // filled from Store
    expect(merged.messages[0]!.model).toBe('claude-x'); // kept from Composer
    expect(merged.messages[0]!.source).toBe('both');
  });

  it('preserves unmatched messages from either side at relative positions', () => {
    // Backbone has an extra message between two anchors; Store has a different extra.
    const composer = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'only-composer' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({ role: 'user', content: 'A' }),
        msg({ role: 'user', content: 'only-store' }),
        msg({ role: 'user', content: 'B' }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    const contents = merged.messages.map((m) => m.content);
    expect(contents).toEqual(['A', 'only-composer', 'only-store', 'B']);
    const onlyComposer = merged.messages.find((m) => m.content === 'only-composer')!;
    const onlyStore = merged.messages.find((m) => m.content === 'only-store')!;
    expect(onlyComposer.source).toBe('composer');
    expect(onlyStore.source).toBe('store');
  });

  it('recomputes messageCount; preferred (Composer) lastUpdatedAt wins', () => {
    const composer = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-05T00:00:00Z'),
      messages: [msg({ role: 'user', content: 'A' }), msg({ role: 'user', content: 'B' })],
    });
    const store = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-03T00:00:00Z'), // store.db createdAt (older)
      messages: [msg({ role: 'user', content: 'A' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messageCount).toBe(2); // A merged + B unmatched
    expect(merged.lastUpdatedAt.toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('matches duplicate signatures earliest-first (stable)', () => {
    const composer = makeSession({
      messages: [msg({ role: 'user', content: 'ping' }), msg({ role: 'user', content: 'ping' })],
    });
    const store = makeSession({
      messages: [msg({ role: 'user', content: 'ping' }), msg({ role: 'user', content: 'ping' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages.every((m) => m.source === 'both')).toBe(true);
  });

  it('one side missing content, other complete: fills content, single message', () => {
    const composer = makeSession({
      messages: [msg({ role: 'assistant', content: '[empty message]' })],
    });
    const store = makeSession({
      messages: [msg({ role: 'assistant', content: 'real answer' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]!.content).toBe('real answer');
    expect(merged.messages[0]!.source).toBe('both');
  });

  it('one side missing toolCalls, other complete: fills tools, single message', () => {
    // The reviewer's core case: Composer empty + no tools vs Store empty + Read.
    const composer = makeSession({
      messages: [msg({ role: 'assistant', content: '' })],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1); // NOT split into two
    expect(merged.messages[0]!.source).toBe('both');
    expect(merged.messages[0]!.toolCalls?.[0]?.name).toBe('Read');
  });

  it('matches a Composer tool display alias to the structured internal name', () => {
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '[Tool: Read File]',
          toolCalls: [{ name: 'read_file', status: 'completed' }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: 'Reading the file.',
          toolCalls: [{ name: 'read_file', status: 'completed' }],
        }),
      ],
    });

    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);

    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]).toMatchObject({
      content: 'Reading the file.',
      source: 'both',
    });
  });

  it('same-role empty messages with DIFFERENT tool calls stay distinct', () => {
    // Two separate assistant turns, each with a different tool — must NOT merge.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Write', status: 'completed', params: { file: '/b' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    // Read matches across stacks (both); Write is composer-only.
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages.find((m) => m.toolCalls?.[0]?.name === 'Read')?.source).toBe('both');
    expect(merged.messages.find((m) => m.toolCalls?.[0]?.name === 'Write')?.source).toBe(
      'composer'
    );
  });

  it('does not merge one Read-only turn with one Write-only turn', () => {
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Write', status: 'completed', params: { file: '/b' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages.map((message) => message.source).sort()).toEqual(['composer', 'store']);
  });

  it('does not mix an error payload into a preferred completed outcome', () => {
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' }, result: 'ok' }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'error', params: { file: '/a' }, error: 'boom' }],
        }),
      ],
    });
    const tool = mergeCrossStackSessions(composer, store, 'composer', 0).messages[0]?.toolCalls?.[0];
    expect(tool).toMatchObject({ status: 'completed', result: 'ok' });
    expect(tool?.error).toBeUndefined();
  });

  it('a corrupted message does not merge with a legitimate empty message', () => {
    const composer = makeSession({
      messages: [msg({ role: 'assistant', content: '[corrupted message]' })],
    });
    const store = makeSession({
      messages: [msg({ role: 'assistant', content: '[empty message]' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    // Corrupt ≠ empty → they are distinct messages (not folded/merged).
    expect(merged.messages).toHaveLength(2);
  });

  it('on WSL, lastUpdatedAt follows the Store (preferred) value, not the later Composer time', () => {
    const composer = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-10T00:00:00Z'), // later, but Composer is NOT preferred
      messages: [msg({ role: 'user', content: 'A' })],
    });
    const store = makeSession({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUpdatedAt: new Date('2026-01-03T00:00:00Z'), // Store's value (no separate updatedAt yet)
      messages: [msg({ role: 'user', content: 'A' })],
    });
    const merged = mergeCrossStackSessions(composer, store, 'store', 0);
    expect(merged.lastUpdatedAt.toISOString()).toBe('2026-01-03T00:00:00.000Z');
  });

  it('merges Read(no params) with Read(params) into one, filling params', () => {
    // Composer has the tool with NO params; Store has the same tool with params.
    // They must merge into ONE tool call with params filled from Store.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed' }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1);
    const tc = merged.messages[0]!.toolCalls!;
    expect(tc).toHaveLength(1); // not duplicated
    expect(tc[0]!.params).toEqual({ file: '/a' }); // filled from Store
  });

  it('keeps Read(/a) and Read(/b) as two distinct messages (params differ)', () => {
    // Both sides have params but they differ -> must NOT merge; each keeps its
    // own origin. Neither call is overwritten or lost.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/a' } }],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ name: 'Read', status: 'completed', params: { file: '/b' } }],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(2); // distinct, not folded
    const sources = merged.messages.map((m) => m.source).sort();
    expect(sources).toEqual(['composer', 'store']);
    // Each message still carries its own single tool call.
    expect(merged.messages.every((m) => m.toolCalls?.length === 1)).toBe(true);
  });

  it('global two-pass: exact matches commit before fills (no duplicate params)', () => {
    // Regression: a per-tool "exact-then-fill" lets the no-params Read steal
    // /a, leaving backbone /a unmatched and producing /a,/a,/b. The global
    // two-pass must commit the exact /a match first, then fill /b.
    const composer = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [
            { name: 'Read', status: 'completed' }, // no params
            { name: 'Read', status: 'completed', params: { file: '/a' } },
          ],
        }),
      ],
    });
    const store = makeSession({
      messages: [
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [
            { name: 'Read', status: 'completed', params: { file: '/a' } },
            { name: 'Read', status: 'completed', params: { file: '/b' } },
          ],
        }),
      ],
    });
    const merged = mergeCrossStackSessions(composer, store, 'composer', 0);
    expect(merged.messages).toHaveLength(1); // the two empty assistant msgs merge
    const tcs = merged.messages[0]!.toolCalls!;
    expect(tcs).toHaveLength(2); // NOT 3 (no duplicate)
    const files = tcs
      .map((tc) => (tc.params as { file?: string } | undefined)?.file ?? null)
      .sort();
    expect(files).toEqual(['/a', '/b']); // exact /a + filled /b, nothing lost/duplicated
  });
});

describe('greedyAnchorPairs (oversize fallback) — no crossing anchors', () => {
  it('produces strictly increasing pairs even when keys are reversed', () => {
    // backbone [A,B], other [B,A]: an unguarded greedy pass would emit (0,1)
    // and (1,0), which cross. The monotonic guard must yield only (0,1).
    const pairs = greedyAnchorPairs(['A', 'B'], ['B', 'A']);
    expect(pairs).toEqual([[0, 1]]);
    // Invariant: both axes strictly increasing.
    for (let k = 1; k < pairs.length; k++) {
      expect(pairs[k]![0]).toBeGreaterThan(pairs[k - 1]![0]);
      expect(pairs[k]![1]).toBeGreaterThan(pairs[k - 1]![1]);
    }
  });

  it('matches an identical same-order oversize sequence fully', () => {
    const n = 502; // 502*502 > 250_000 DP threshold → greedy path
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    const pairs = greedyAnchorPairs(keys, keys);
    expect(pairs).toHaveLength(n);
    expect(pairs).toEqual(keys.map((_, i) => [i, i]));
  });
});

describe('detectPreferredStackSource — existing env vars', () => {
  const ORIG_DATA = process.env['CURSOR_DATA_PATH'];
  const ORIG_STORE = process.env['CURSOR_STORE_ROOT'];

  function restore() {
    if (ORIG_DATA === undefined) delete process.env['CURSOR_DATA_PATH'];
    else process.env['CURSOR_DATA_PATH'] = ORIG_DATA;
    if (ORIG_STORE === undefined) delete process.env['CURSOR_STORE_ROOT'];
    else process.env['CURSOR_STORE_ROOT'] = ORIG_STORE;
  }

  it('CURSOR_DATA_PATH pointing at a Store root selects Store', () => {
    process.env['CURSOR_DATA_PATH'] = '/home/u/.cursor';
    const r = detectPreferredStackSource();
    restore();
    expect(r).toBe('store');
  });

  it('CURSOR_DATA_PATH pointing at a Composer root selects Composer', () => {
    process.env['CURSOR_DATA_PATH'] = '/home/u/Cursor/User/workspaceStorage';
    const r = detectPreferredStackSource();
    restore();
    expect(r).toBe('composer');
  });

  it('an explicit non-default CURSOR_STORE_ROOT selects Store', () => {
    delete process.env['CURSOR_DATA_PATH'];
    process.env['CURSOR_STORE_ROOT'] = '/custom/cursor-store';
    const r = detectPreferredStackSource();
    restore();
    expect(r).toBe('store');
  });
});

describe('detectPreferredStackSource conflict priority', () => {
  it('selects Store for an explicit Store-root path', () => {
    expect(detectPreferredStackSource('/home/u/.cursor')).toBe('store');
  });

  it('selects Composer for an explicit non-Store path', () => {
    expect(detectPreferredStackSource('/home/u/Cursor/User/workspaceStorage')).toBe('composer');
  });
});
