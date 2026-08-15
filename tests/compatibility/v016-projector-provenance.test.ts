import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  V016_PROJECTOR_PROVENANCE,
  projectV016GlobalSession,
  projectV016WorkspaceSessions,
} from './support/v016-projector.js';

interface ProjectorManifest {
  schemaVersion: number;
  tag: string;
  commit: string;
  sources: Array<{ path: string; gitBlob: string; projectedSymbols: string[] }>;
  invariants: Record<string, unknown>;
}

const MANIFEST_PATH = join(
  process.cwd(),
  'tests',
  'compatibility',
  'fixtures',
  'v016',
  'projector-manifest.json'
);

function readManifest(): ProjectorManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ProjectorManifest;
}

describe('v0.16 projector provenance', () => {
  it('pins the exact tag commit and source blobs copied into the test oracle', () => {
    const manifest = readManifest();
    expect(manifest).toMatchObject(V016_PROJECTOR_PROVENANCE);
    expect(manifest.tag).toBe('v0.16.0');
    expect(manifest.commit).toBe('e8a7abf8cea3419a9dda911e174a05f82a9b260e');
    expect(manifest.sources.map(({ path, gitBlob }) => [path, gitBlob])).toEqual([
      ['src/core/storage.ts', '9b593c764e3ffb2f2c597bacff731a51009e5179'],
      ['src/core/parser.ts', '110a31865caa49a2c8b15707dc7535761ce3dbf6'],
      ['src/core/types.ts', 'ed6352d26831e0744aa9da5ff1be7a58f8e9ced4'],
    ]);
    expect(manifest.sources.every((source) => source.projectedSymbols.length > 0)).toBe(true);
    expect(manifest.sources[0]?.projectedSymbols).toEqual(
      expect.arrayContaining([
        'formatToolCall',
        'formatDiffBlock',
        'formatToolCallWithResult',
        'extractThinkingText',
        'extractBubbleText',
      ])
    );
    expect(manifest.invariants['toolMessageDisplay']).toBe(
      'v0.16 specialized formatToolCall/formatToolCallWithResult projection'
    );
    expect(manifest.invariants['globalNullBubblePayload']).toBe(
      'row-key ID plus [corrupted message] placeholder'
    );
  });

  it('reproduces rowid order, bubble-ID selection, placeholders, and branch filtering', () => {
    const projected = projectV016GlobalSession({
      id: 'composer-1',
      title: 'Locked global',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      lastUpdatedAt: new Date('2024-01-02T00:00:00.000Z'),
      bubbleRows: [
        {
          rowid: 30,
          key: 'bubbleId:composer-1:last',
          value: JSON.stringify({ type: 1, bubbleId: '', text: '' }),
        },
        {
          rowid: 10,
          key: 'bubbleId:composer-1:first',
          value: JSON.stringify({
            type: 1,
            bubbleId: 'native-first',
            text: 'first',
            createdAt: '2024-01-01T10:00:00.000Z',
          }),
        },
        { rowid: 15, key: 'bubbleId:composer-1:null-bubble', value: null },
        { rowid: 20, key: 'bubbleId:composer-1:broken', value: '{not-json' },
      ],
      composerDataValue: JSON.stringify({
        fullConversationHeadersOnly: [
          null,
          { bubbleId: '' },
          { bubbleId: '   ' },
          { bubbleId: 'native-first' },
          { bubbleId: ' branch-with-spaces ' },
          { wrong: true },
        ],
      }),
    });

    expect(projected.messages.map(({ id, content, role }) => ({ id, content, role }))).toEqual([
      { id: 'native-first', content: 'first', role: 'user' },
      { id: 'null-bubble', content: '[corrupted message]', role: 'assistant' },
      { id: 'broken', content: '[corrupted message]', role: 'assistant' },
      { id: '', content: '[empty message]', role: 'user' },
    ]);
    expect(projected.activeBranchBubbleIds).toEqual(['native-first', ' branch-with-spaces ']);
    expect(projected.source).toBe('global');
  });

  it('reproduces an empty TEXT payload cell as the same placeholder v0.16 gives NULL', () => {
    // NULL and an empty TEXT cell are distinct SQLite storage classes that reach the corrupted
    // placeholder by different routes, so the released v0.16 behaviour for the empty cell is
    // pinned here alongside the NULL case above rather than inferred from it.
    const projected = projectV016GlobalSession({
      id: 'composer-empty-cell',
      title: 'Locked empty payload cell',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      lastUpdatedAt: new Date('2024-01-02T00:00:00.000Z'),
      bubbleRows: [
        {
          rowid: 10,
          key: 'bubbleId:composer-empty-cell:native',
          value: JSON.stringify({ type: 1, bubbleId: 'native', text: 'kept' }),
        },
        { rowid: 20, key: 'bubbleId:composer-empty-cell:empty-cell', value: '' },
      ],
      composerDataValue: JSON.stringify({}),
    });

    expect(projected.messages.map(({ id, content, role }) => ({ id, content, role }))).toEqual([
      { id: 'native', content: 'kept', role: 'user' },
      { id: 'empty-cell', content: '[corrupted message]', role: 'assistant' },
    ]);
  });

  it('reproduces the tagged v0.16 specialized display for supported tool bubbles', () => {
    const projected = projectV016GlobalSession({
      id: 'composer-tools',
      title: 'Locked tool display',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      lastUpdatedAt: new Date('2024-01-01T00:01:00.000Z'),
      bubbleRows: [
        {
          rowid: 20,
          key: 'bubbleId:composer-tools:search',
          value: JSON.stringify({
            type: 2,
            bubbleId: 'search',
            createdAt: '2024-01-01T00:00:02.000Z',
            toolFormerData: {
              name: 'search',
              params: '{"query":"synthetic-token","path":"/fixture/v016/project"}',
              result: 'synthetic search result',
              status: 'completed',
            },
          }),
        },
        {
          rowid: 10,
          key: 'bubbleId:composer-tools:read',
          value: JSON.stringify({
            type: 2,
            bubbleId: 'read',
            createdAt: '2024-01-01T00:00:01.000Z',
            toolFormerData: {
              name: 'read_file',
              params: '{"path":"/fixture/v016/project/synthetic.ts"}',
              result: 'synthetic read result',
              status: 'completed',
            },
          }),
        },
      ],
    });

    expect(projected.messages.map(({ id, content }) => ({ id, content }))).toEqual([
      {
        id: 'read',
        content: '[Tool: Read File]\nFile: /fixture/v016/project/synthetic.ts\nStatus: ✓ completed',
      },
      {
        id: 'search',
        content:
          '[Tool: Search]\nPattern: synthetic-token\nPath: /fixture/v016/project\nStatus: ✓ completed',
      },
    ]);
    expect(projected.messages.map(({ toolCalls }) => toolCalls)).toEqual([
      [
        {
          name: 'read_file',
          status: 'completed',
          params: { path: '/fixture/v016/project/synthetic.ts' },
          result: 'synthetic read result',
          files: ['/fixture/v016/project/synthetic.ts'],
        },
      ],
      [
        {
          name: 'search',
          status: 'completed',
          params: { query: 'synthetic-token', path: '/fixture/v016/project' },
          result: 'synthetic search result',
          files: ['/fixture/v016/project'],
        },
      ],
    ]);
  });

  it('reproduces legacy workspace filtering, native/null IDs, roles, and branch selection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T00:00:00.000Z'));
    try {
      const [session] = projectV016WorkspaceSessions(
        JSON.stringify({
          tabs: [
            { title: 'missing id', messages: [{ role: 'user', content: 'ignored session' }] },
            {
              id: 'workspace-1',
              messages: [
                {},
                { id: 'native-user', role: 'user', content: 'hello', timestamp: 1000 },
                { type: 'ai', text: 'answer', createdAt: 2000 },
                { id: '', type: 'system', content: 'system-shaped assistant' },
              ],
            },
          ],
        })
      );

      expect(session?.id).toBe('workspace-1');
      expect(session?.messages.map(({ id, role, content }) => ({ id, role, content }))).toEqual([
        { id: 'native-user', role: 'user', content: 'hello' },
        { id: null, role: 'assistant', content: 'answer' },
        { id: '', role: 'assistant', content: 'system-shaped assistant' },
      ]);
      expect(session?.title).toBe('hello');
      expect(session?.source).toBe('workspace-fallback');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reproduces Composer-head placeholders and stable generation sorting/filtering', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T00:00:00.000Z'));
    try {
      const sessions = projectV016WorkspaceSessions(
        JSON.stringify({
          allComposers: [
            {
              composerId: 'head-1',
              name: 'Composer title',
              createdAt: 1_000,
              lastUpdatedAt: 2_000,
            },
            { name: 'no id' },
          ],
        }),
        {
          generations: JSON.stringify([
            { unixMs: 1_500, generationUUID: 'later', textDescription: 'second' },
            { unixMs: 1_100, generationUUID: 'earlier', textDescription: 'first' },
            { unixMs: 70_001, generationUUID: 'outside', textDescription: 'outside' },
            { unixMs: 1_200, generationUUID: 'empty-text', textDescription: '' },
          ]),
        }
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.messages.map((message) => message.id)).toEqual([
        null,
        'earlier',
        'later',
      ]);
      expect(sessions[0]?.messages.map((message) => message.content)).toEqual([
        'Composer title',
        'first',
        'second',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
