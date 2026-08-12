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
  SessionDiagnostic,
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
    expect(result.indexScope).toBe('global');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('sess-1');
  });

  it('handles empty array', () => {
    const result = JSON.parse(formatSessionsJson([]));
    expect(result.count).toBe(0);
    expect(result.indexScope).toBe('global');
    expect(result.sessions).toEqual([]);
  });

  it('includes transcript provenance in list output', () => {
    const result = JSON.parse(
      formatSessionsJson([makeSummary({ source: 'transcript', transcriptState: 'partial' })])
    );
    expect(result.sessions[0]).toMatchObject({
      source: 'transcript',
      transcriptState: 'partial',
    });
  });

  it('includes deterministic session timestamp provenance in list output', () => {
    const result = JSON.parse(
      formatSessionsJson([
        makeSummary({
          createdAtSource: 'composer-metadata',
          lastUpdatedAtSource: 'direct-message',
        }),
      ])
    );
    expect(result.sessions[0]).toMatchObject({
      createdAtSource: 'composer-metadata',
      lastUpdatedAtSource: 'direct-message',
    });
  });

  it('emits scoped addressing, stable paths, and locator-free resolution details', () => {
    const result = JSON.parse(
      formatSessionsJson([
        makeSummary({
          indexScope: 'workspace',
          indexWorkspacePath: '/workspaces/selected',
          canonicalWorkspacePath: '/workspaces/original',
          matchedWorkspacePath: '/workspaces/selected',
          workspaceMatchKind: 'unique-suffix',
          workspaceMemberships: [
            {
              workspacePath: '/workspaces/original',
              sourceRoles: ['composer'],
              contributingInstanceCount: 1,
            },
          ],
          sourceInstances: [
            {
              sourceRole: 'composer',
              representation: 'composer-global',
              workspacePaths: ['/workspaces/original'],
              state: 'contributed',
            },
          ],
          resolutionState: 'partial',
          resolution: {
            state: 'partial',
            expectedSourceRoles: ['composer', 'store'],
            loadedSourceRoles: ['composer'],
            omittedSourceRoles: ['store'],
            failedSourceRoles: [],
            reasonCodes: ['workspace-scope-omitted'],
          },
          resolvedSource: 'composer',
        }),
      ])
    );

    expect(result.sessions[0]).toMatchObject({
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/selected',
      canonicalWorkspacePath: '/workspaces/original',
      matchedWorkspacePath: '/workspaces/selected',
      workspaceMatchKind: 'unique-suffix',
      resolutionState: 'partial',
      resolvedSource: 'composer',
      resolution: { omittedSourceRoles: ['store'] },
    });
    expect(result).toMatchObject({
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/selected',
    });
    expect(JSON.stringify(result)).not.toContain('locator');
    expect(JSON.stringify(result)).not.toContain('dbPath');
  });

  it('emits one minimal ambiguous logical row and one diagnostic in the list envelope', () => {
    const diagnostic: SessionDiagnostic = {
      code: 'SESSION_AMBIGUOUS',
      message: 'Session ambiguous has divergent physical occurrences.',
      sessionId: 'ambiguous',
      occurrenceCount: 2,
      occurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
      remedy: 'Resolve the replicas and retry.',
    };
    const result = JSON.parse(
      formatSessionsJson(
        [
          {
            id: 'ambiguous',
            index: 2,
            indexScope: 'workspace',
            indexWorkspacePath: '/workspaces/selected',
            resolutionState: 'ambiguous',
            sourceRoles: ['composer'],
            occurrenceCount: 2,
            diagnosticOccurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
            matchedWorkspacePath: '/workspaces/selected',
          },
        ],
        { diagnostics: [diagnostic] }
      )
    );

    expect(result).toMatchObject({
      count: 1,
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/selected',
      diagnostics: [diagnostic],
      sessions: [
        {
          id: 'ambiguous',
          index: 2,
          indexScope: 'workspace',
          indexWorkspacePath: '/workspaces/selected',
          resolutionState: 'ambiguous',
          sourceRoles: ['composer'],
          occurrenceCount: 2,
        },
      ],
    });
    expect(result.sessions[0]).not.toHaveProperty('title');
    expect(result.sessions[0]).not.toHaveProperty('preview');
    expect(result.sessions[0]).not.toHaveProperty('messageCount');
  });

  it('never exposes internal workspace labels as structured canonical paths', () => {
    const result = JSON.parse(
      formatSessionsJson([
        makeSummary({
          workspacePath: '(unknown workspace)',
          canonicalWorkspacePath: '(global)',
          matchedWorkspacePath: '(workspace: legacy-id)',
          workspaceMemberships: [
            {
              workspacePath: '(workspace: legacy-id)',
              sourceRoles: ['composer'],
              contributingInstanceCount: 1,
            },
          ],
          sourceInstances: [
            {
              sourceRole: 'composer',
              representation: 'composer-workspace',
              workspacePaths: ['(unknown workspace)'],
              state: 'contributed',
            },
          ],
        }),
      ])
    );

    expect(result.sessions[0].workspacePath).toBeNull();
    expect(result.sessions[0]).not.toHaveProperty('canonicalWorkspacePath');
    expect(result.sessions[0]).not.toHaveProperty('matchedWorkspacePath');
    expect(result.sessions[0].workspaceMemberships).toEqual([]);
    expect(result.sessions[0].sourceInstances[0].workspacePaths).toEqual([]);
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

  it('serializes a pathless discovery bucket without exposing its display label', () => {
    const ws: Workspace = {
      id: 'unknown',
      path: '(unknown workspace)',
      dbPath: '',
      sessionCount: 1,
    };
    const result = JSON.parse(formatWorkspacesJson([ws]));
    expect(result.workspaces[0].path).toBeNull();
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

  it('serializes a display-only session workspace as null', () => {
    const result = JSON.parse(
      formatSessionJson(
        makeSession({
          workspacePath: '(unknown workspace)',
          canonicalWorkspacePath: '(global)',
        })
      )
    );
    expect(result.workspacePath).toBeNull();
    expect(result).not.toHaveProperty('canonicalWorkspacePath');
  });

  it('includes source when present', () => {
    const result = JSON.parse(formatSessionJson(makeSession({ source: 'workspace-fallback' })));
    expect(result.source).toBe('workspace-fallback');
  });

  it('includes Store transcript state when present', () => {
    const result = JSON.parse(formatSessionJson(makeSession({ transcriptState: 'partial' })));
    expect(result.transcriptState).toBe('partial');
  });

  it('includes activeBranchBubbleIds when present', () => {
    const result = JSON.parse(
      formatSessionJson(makeSession({ activeBranchBubbleIds: ['m1', 'm2'] }))
    );
    expect(result.activeBranchBubbleIds).toEqual(['m1', 'm2']);
  });

  it('omits activeBranchBubbleIds when undefined', () => {
    const result = JSON.parse(formatSessionJson(makeSession()));
    expect(result.activeBranchBubbleIds).toBeUndefined();
  });

  it('preserves defined empty structured-tool fields', () => {
    const result = JSON.parse(
      formatSessionJson(
        makeSession({
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              content: '',
              codeBlocks: [],
              toolCalls: [
                {
                  name: 'Read',
                  status: 'completed',
                  result: '',
                  error: '',
                  files: [],
                },
              ],
            },
          ],
        })
      )
    );
    expect(result.messages[0].toolCalls[0]).toMatchObject({ result: '', error: '', files: [] });
  });

  it('emits deterministic session provenance and total message timestamp pairs', () => {
    const result = JSON.parse(
      formatSessionJson(
        makeSession({
          createdAtSource: 'composer-metadata',
          lastUpdatedAtSource: 'direct-message',
          messages: [
            {
              id: 'direct',
              role: 'user',
              content: 'direct',
              codeBlocks: [],
              timestamp: now,
              timestampSource: 'composer-timing',
            },
            {
              id: 'missing',
              role: 'assistant',
              content: 'missing',
              codeBlocks: [],
            },
          ],
        })
      )
    );

    expect(result.createdAtSource).toBe('composer-metadata');
    expect(result.lastUpdatedAtSource).toBe('direct-message');
    expect(result.messages[0]).toMatchObject({
      timestamp: '2024-01-15T10:00:00.000Z',
      timestampSource: 'composer-timing',
    });
    expect(result.messages[1]).toMatchObject({
      timestamp: '1970-01-01T00:00:00.000Z',
      timestampSource: 'unknown',
    });
  });

  it('emits global index scope without a workspace-only index path', () => {
    const result = JSON.parse(
      formatSessionJson(
        makeSession({
          indexScope: 'global',
          canonicalWorkspacePath: '/workspaces/original',
          resolvedSource: 'composer',
          resolution: {
            state: 'complete',
            expectedSourceRoles: ['composer'],
            loadedSourceRoles: ['composer'],
            omittedSourceRoles: [],
            failedSourceRoles: [],
            reasonCodes: [],
          },
        })
      )
    );

    expect(result.indexScope).toBe('global');
    expect(result.indexWorkspacePath).toBeUndefined();
    expect(result.canonicalWorkspacePath).toBe('/workspaces/original');
    expect(result.resolution).toMatchObject({ state: 'complete' });
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
    expect(result.indexScope).toBe('global');
    expect(result.results[0]).toMatchObject({ indexScope: 'global', sessionId: 's1' });
  });

  it('handles empty results', () => {
    const result = JSON.parse(formatSearchResultsJson([], 'test'));
    expect(result.count).toBe(0);
    expect(result.totalMatches).toBe(0);
  });

  it('serializes pathless search results as null instead of an internal label', () => {
    const result = JSON.parse(
      formatSearchResultsJson(
        [
          {
            sessionId: 'pathless',
            index: 1,
            workspacePath: '(unknown workspace)',
            createdAt: now,
            matchCount: 1,
            snippets: [],
          },
        ],
        'needle'
      )
    );

    expect(result.results[0].workspacePath).toBeNull();
  });

  it('emits one workspace address and machine-readable diagnostics at both levels', () => {
    const diagnostic: SessionDiagnostic = {
      code: 'SESSION_AMBIGUOUS',
      message: 'A divergent session was skipped.',
      sessionId: 'ambiguous-session',
      occurrenceCount: 2,
      occurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
      remedy: 'Resolve the replicas and retry.',
    };
    const result = JSON.parse(
      formatSearchResultsJson(
        [
          {
            sessionId: 's1',
            index: 1,
            workspacePath: '/workspaces/selected',
            createdAt: now,
            matchCount: 1,
            snippets: [],
          },
        ],
        'needle',
        {
          indexScope: 'workspace',
          indexWorkspacePath: '/workspaces/selected',
          diagnostics: [diagnostic],
        }
      )
    );

    expect(result).toMatchObject({
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/selected',
      diagnostics: [diagnostic],
    });
    expect(result.results[0]).toMatchObject({
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/selected',
    });
  });
});

describe('formatExportResultJson', () => {
  it('includes count and files', () => {
    const exported = [
      {
        index: 1,
        indexScope: 'global' as const,
        sessionId: 'session-1',
        path: '/out/1.md',
      },
    ];
    const result = JSON.parse(formatExportResultJson(exported));
    expect(result.count).toBe(1);
    expect(result.files[0]).toMatchObject({
      index: 1,
      indexScope: 'global',
      sessionId: 'session-1',
      path: '/out/1.md',
    });
  });

  it('includes continuation diagnostics once in the export envelope', () => {
    const diagnostic: SessionDiagnostic = {
      code: 'SESSION_AMBIGUOUS',
      message: 'A divergent session was skipped.',
      sessionId: 'ambiguous-session',
      remedy: 'Resolve the replicas and retry.',
    };
    const result = JSON.parse(formatExportResultJson([], { diagnostics: [diagnostic] }));

    expect(result).toEqual({ count: 0, files: [], diagnostics: [diagnostic] });
  });
});
