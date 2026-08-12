import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock core modules
const mockListSessions = vi.fn();
const mockGetSession = vi.fn();
const mockSearchSessions = vi.fn();
const mockResolveSessionIdentifiers = vi.fn();
const mockCreateSessionReadContext = vi.fn();

interface MockCoreReadContext {
  customDataPath?: string;
  backupPath?: string;
  workspaceScope: string | null | undefined;
  includeCrossWorkspaceSources: boolean;
  sqliteDriver?: string;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: unknown) => void;
  storeSessions: unknown[] | null;
  summaries: unknown[] | null;
  resolvedSessions: Map<string, unknown>;
  resolvedSessionCapacity: number;
  disposed: boolean;
  releaseSession: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  emitDiagnostic?: (diagnostic: unknown) => void;
  effectiveSourceReadLimits?: unknown;
}

function makeMockCoreReadContext(resolvedSessionCapacity = 1): MockCoreReadContext {
  const context: MockCoreReadContext = {
    customDataPath: undefined,
    backupPath: undefined,
    workspaceScope: undefined,
    includeCrossWorkspaceSources: false,
    sqliteDriver: undefined,
    signal: undefined,
    onDiagnostic: undefined,
    storeSessions: null,
    summaries: null,
    resolvedSessions: new Map(),
    resolvedSessionCapacity,
    disposed: false,
    releaseSession: vi.fn((sessionId: string) => {
      if (context.disposed) {
        throw Object.assign(new Error('Read context has already been disposed.'), {
          code: 'READ_CONTEXT_DISPOSED',
        });
      }
      context.resolvedSessions.delete(sessionId);
    }),
    dispose: vi.fn(async () => {
      context.resolvedSessions.clear();
      context.disposed = true;
    }),
  };
  return context;
}

const mockReadContext = makeMockCoreReadContext();

type CoreContextFactoryOptions = {
  dataPath?: string;
  backupPath?: string;
  workspacePath?: string;
  includeCrossWorkspaceSources?: boolean;
  resolvedSessionCapacity?: number;
  onDiagnostic?: (diagnostic: unknown) => void;
  sqliteDriver?: string;
  sourceReadLimits?: unknown;
  signal?: AbortSignal;
};

function contextFactoryOptions(args: readonly unknown[]): CoreContextFactoryOptions {
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    return args[0] as CoreContextFactoryOptions;
  }
  return (args[2] ?? {}) as CoreContextFactoryOptions;
}

vi.mock('../../src/core/storage.js', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  listSessionSummaries: (...args: unknown[]) => mockListSessions(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  searchSessions: (...args: unknown[]) => mockSearchSessions(...args),
  resolveSessionIdentifiers: (...args: unknown[]) => mockResolveSessionIdentifiers(...args),
  createSessionReadContext: (...args: unknown[]) => mockCreateSessionReadContext(...args),
  findWorkspaces: vi.fn().mockResolvedValue([]),
  findWorkspaceForSession: vi.fn().mockResolvedValue(null),
  findWorkspaceByPath: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/core/parser.js', () => ({
  exportToJson: vi.fn(() => '{"test": true}'),
  exportToMarkdown: vi.fn(() => '# Test'),
  parseChatData: vi.fn(() => []),
}));

vi.mock('../../src/core/migrate.js', () => ({
  migrateSessions: vi.fn().mockResolvedValue([]),
  migrateWorkspace: vi.fn().mockResolvedValue({ success: true }),
}));

const mockCoreSetDriver = vi.fn();
const mockCoreGetActiveDriver = vi.fn();

vi.mock('../../src/core/database/index.js', () => ({
  setDriver: (...args: unknown[]) => mockCoreSetDriver(...args),
  getActiveDriver: (...args: unknown[]) => mockCoreGetActiveDriver(...args),
  ensureDriver: vi.fn().mockResolvedValue(undefined),
  openDatabase: vi.fn(),
}));

vi.mock('../../src/lib/platform.js', () => ({
  getCursorDataPath: vi.fn(() => '/cursor/data'),
  expandPath: (p: string) => p,
  contractPath: (p: string) => p,
  normalizePath: (p: string) => p,
  pathsEqual: (a: string, b: string) => a === b,
}));

// Mock backup module
vi.mock('../../src/lib/backup.js', () => ({
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  validateBackup: vi.fn(),
  listBackups: vi.fn(),
  getDefaultBackupDir: vi.fn(),
}));

import {
  listSessions,
  listSessionSummaries,
  getSession,
  searchSessions,
  exportSessionToJson,
  exportSessionToMarkdown,
  exportAllSessionsToJson,
  exportAllSessionsToMarkdown,
  setDriver,
  getActiveDriver,
} from '../../src/lib/index.js';
import * as libraryApi from '../../src/lib/index.js';
import type {
  LibraryConfig,
  SessionDiagnostic,
  SessionReadContext,
  SessionReadContextOptions,
  SourceReadLimitsOverride,
} from '../../src/lib/types.js';
import {
  DatabaseCapabilityError,
  DatabaseLockedError,
  DatabaseNotFoundError,
  DriverNotAvailableError,
  InvalidFilterError,
  NoDriverAvailableError,
  ReadContextOptionsMismatchError,
  SessionAmbiguityError,
  SessionNotFoundError,
  SessionScopeMismatchError,
  SourceLimitConfigurationError,
} from '../../src/lib/errors.js';
import { resolveSourceReadLimits } from '../../src/core/source-read-limits.js';

const now = new Date('2024-01-15T10:00:00Z');
const later = new Date('2024-01-15T11:00:00Z');

function makeCoreSession(id = 'c1', index = 1) {
  return {
    id,
    index,
    title: 'Test',
    createdAt: now,
    lastUpdatedAt: later,
    messageCount: 1,
    workspaceId: 'ws1',
    workspacePath: '~/proj',
    messages: [{ id: 'm1', role: 'user', content: 'Hello', timestamp: now, codeBlocks: [] }],
  };
}

function makeCoreSummary(id = 'c1', index = 1) {
  return {
    id,
    index,
    title: 'Test',
    createdAt: now,
    lastUpdatedAt: later,
    messageCount: 1,
    workspaceId: 'ws1',
    workspacePath: '~/proj',
    preview: 'Hello',
  };
}

function createPublicReadContext(options: SessionReadContextOptions = {}): SessionReadContext {
  const factory = (
    libraryApi as unknown as {
      createSessionReadContext?: (value?: SessionReadContextOptions) => SessionReadContext;
    }
  ).createSessionReadContext;
  if (!factory) {
    throw new Error('Package-root createSessionReadContext() is not implemented.');
  }
  return factory(options);
}

function resetMockReadContext(context: MockCoreReadContext): void {
  context.customDataPath = undefined;
  context.backupPath = undefined;
  context.workspaceScope = undefined;
  context.includeCrossWorkspaceSources = false;
  context.sqliteDriver = undefined;
  context.signal = undefined;
  context.onDiagnostic = undefined;
  context.storeSessions = null;
  context.summaries = null;
  context.resolvedSessions.clear();
  context.resolvedSessionCapacity = 1;
  context.disposed = false;
  context.emitDiagnostic = undefined;
  context.effectiveSourceReadLimits = undefined;
}

function faithfulCoreContextFactory(context: MockCoreReadContext) {
  return (...args: unknown[]) => {
    const options = contextFactoryOptions(args);
    context.customDataPath = options.dataPath;
    context.backupPath = options.backupPath;
    context.workspaceScope = options.workspacePath ?? null;
    context.includeCrossWorkspaceSources = options.includeCrossWorkspaceSources ?? false;
    context.sqliteDriver = options.sqliteDriver;
    context.signal = options.signal;
    context.onDiagnostic = options.onDiagnostic;
    context.effectiveSourceReadLimits = resolveSourceReadLimits(
      options.sourceReadLimits as SourceReadLimitsOverride | undefined
    );
    context.resolvedSessionCapacity = options.resolvedSessionCapacity ?? 1;
    context.emitDiagnostic = options.onDiagnostic;
    return context;
  };
}

function installFaithfulCoreContextFactory(context: MockCoreReadContext): void {
  mockCreateSessionReadContext.mockImplementation(faithfulCoreContextFactory(context));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockReadContext(mockReadContext);
  installFaithfulCoreContextFactory(mockReadContext);
});

// =============================================================================
// listSessions
// =============================================================================
describe('listSessions', () => {
  it('paginates logical rows, reports ambiguity, and never backfills the requested window', async () => {
    const onDiagnostic = vi.fn();
    mockListSessions.mockResolvedValue([
      {
        ...makeCoreSummary('resolved-first', 1),
        indexScope: 'workspace',
        indexWorkspacePath: '/w',
      },
      {
        id: 'ambiguous-second',
        index: 2,
        indexScope: 'workspace',
        indexWorkspacePath: '/w',
        resolutionState: 'ambiguous',
        sourceRoles: ['composer'],
        occurrenceCount: 2,
        diagnosticOccurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
      },
      {
        ...makeCoreSummary('resolved-third', 3),
        indexScope: 'workspace',
        indexWorkspacePath: '/w',
      },
    ]);
    mockGetSession.mockResolvedValue(makeCoreSession('resolved-first', 1));

    const result = await listSessions({
      workspace: '/w',
      limit: 2,
      offset: 0,
      onDiagnostic,
    });

    expect(result.pagination).toEqual({ total: 3, limit: 2, offset: 0, hasMore: true });
    expect(result.data.map(({ id, index }) => [id, index])).toEqual([['resolved-first', 0]]);
    expect(mockGetSession).toHaveBeenCalledOnce();
    expect(mockGetSession).not.toHaveBeenCalledWith(
      'resolved-third',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SESSION_AMBIGUOUS', sessionId: 'ambiguous-second' })
    );
  });

  it('returns one zero-based payload-free public summary for every logical catalog row', async () => {
    mockListSessions.mockResolvedValue([
      { ...makeCoreSummary('resolved', 1), indexScope: 'global', resolutionState: 'partial' },
      {
        id: 'ambiguous',
        index: 2,
        indexScope: 'global',
        resolutionState: 'ambiguous',
        sourceRoles: ['composer'],
        occurrenceCount: 2,
        diagnosticOccurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
      },
    ]);

    const result = await listSessionSummaries({ limit: 10 });

    expect(result.pagination).toMatchObject({ total: 2, hasMore: false });
    expect(result.data.map(({ id, index }) => [id, index])).toEqual([
      ['resolved', 0],
      ['ambiguous', 1],
    ]);
    expect(result.data.every((row) => !Object.prototype.hasOwnProperty.call(row, 'messages'))).toBe(
      true
    );
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('projects pathless summary sentinels to the public unknown workspace contract', async () => {
    mockListSessions.mockResolvedValue([
      {
        ...makeCoreSummary('pathless', 1),
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
      },
    ]);

    const result = await listSessionSummaries();
    expect(result.data[0]).toMatchObject({ id: 'pathless', workspace: 'unknown' });
    expect(result.data[0]).not.toHaveProperty('canonicalWorkspacePath');
    expect(result.data[0]).not.toHaveProperty('matchedWorkspacePath');
    expect(result.data[0]!.workspaceMemberships).toEqual([]);
    expect(result.data[0]!.sourceInstances[0]!.workspacePaths).toEqual([]);
  });

  it('returns PaginatedResult with sessions', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    const result = await listSessions();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.id).toBe('c1');
    expect(result.pagination.total).toBe(1);
    expect(mockGetSession).toHaveBeenCalledWith('c1', undefined, undefined, mockReadContext, 1);
  });

  it('preserves assistant roles in listSessions output', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      messages: [{ id: 'm2', role: 'assistant', content: 'Hi', timestamp: later, codeBlocks: [] }],
    });

    const result = await listSessions();
    expect(result.data[0]!.messages[0]!.role).toBe('assistant');
  });

  it('applies pagination with offset and limit', async () => {
    mockListSessions.mockResolvedValue([
      makeCoreSummary('c1', 1),
      makeCoreSummary('c2', 2),
      makeCoreSummary('c3', 3),
    ]);
    mockGetSession.mockResolvedValue(makeCoreSession('c2', 2));

    const result = await listSessions({ limit: 1, offset: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(3);
    expect(result.pagination.offset).toBe(1);
    expect(result.pagination.hasMore).toBe(true);
  });

  it('wraps SQLITE_BUSY as DatabaseLockedError', async () => {
    mockListSessions.mockRejectedValue(new Error('SQLITE_BUSY'));

    await expect(listSessions()).rejects.toThrow(DatabaseLockedError);
  });

  it('wraps ENOENT as DatabaseNotFoundError', async () => {
    mockListSessions.mockRejectedValue(new Error('ENOENT: no such file'));

    await expect(listSessions()).rejects.toThrow(DatabaseNotFoundError);
  });

  it('wraps unknown errors', async () => {
    mockListSessions.mockRejectedValue(new Error('Something else'));

    await expect(listSessions()).rejects.toThrow('Failed to list sessions');
  });

  it('binds driver, limits, signal, diagnostics, and cross-workspace policy once', async () => {
    const controller = new AbortController();
    const onDiagnostic = vi.fn();
    mockListSessions.mockResolvedValue([]);

    await listSessions({
      dataPath: '/cursor/custom',
      backupPath: '/archives/history.zip',
      workspace: '/workspaces/a',
      sqliteDriver: 'better-sqlite3',
      sourceReadLimits: { sqliteRowCount: 6_000_000 },
      includeCrossWorkspaceSources: true,
      onDiagnostic,
      signal: controller.signal,
    });

    expect(mockCreateSessionReadContext).toHaveBeenCalledWith({
      dataPath: '/cursor/custom',
      backupPath: '/archives/history.zip',
      workspacePath: '/workspaces/a',
      includeCrossWorkspaceSources: true,
      resolvedSessionCapacity: 1,
      sqliteDriver: 'better-sqlite3',
      sourceReadLimits: { sqliteRowCount: 6_000_000 },
      onDiagnostic,
      signal: controller.signal,
    });
    expect(mockListSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/workspaces/a',
        includeCrossWorkspaceSources: true,
      }),
      '/cursor/custom',
      '/archives/history.zip',
      mockReadContext
    );
    expect(mockListSessions.mock.calls[0]?.[0]).not.toHaveProperty('sourceReadLimits');
    expect(mockListSessions.mock.calls[0]?.[0]).not.toHaveProperty('signal');
  });

  it('preserves typed database capability failures from public read operations', async () => {
    const failure = new DatabaseCapabilityError(
      'node:sqlite',
      'store-snapshot',
      ['onlineBackup'],
      ['better-sqlite3']
    );
    mockListSessions.mockRejectedValue(failure);

    await expect(listSessions({ sqliteDriver: 'node:sqlite' })).rejects.toBe(failure);
  });

  it.each([
    new DriverNotAvailableError('node:sqlite', ['better-sqlite3']),
    new NoDriverAvailableError(),
  ])('preserves typed $name failures from public read operations', async (failure) => {
    mockListSessions.mockRejectedValue(failure);

    await expect(listSessions({ sqliteDriver: 'node:sqlite' })).rejects.toBe(failure);
  });

  it('preserves AbortError identity even when its caller reason resembles a filesystem error', async () => {
    const failure = new Error('ENOENT supplied as the cancellation reason');
    failure.name = 'AbortError';
    mockListSessions.mockRejectedValue(failure);

    await expect(listSessions()).rejects.toBe(failure);
  });
});

// =============================================================================
// getSession
// =============================================================================
describe('getSession', () => {
  it('resolves a zero-based index inside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    await getSession(0, { workspace: '/workspace/a' });

    expect(mockListSessions).toHaveBeenCalledWith(
      {
        limit: 0,
        all: true,
        workspacePath: '/workspace/a',
        includeCrossWorkspaceSources: false,
      },
      undefined,
      undefined,
      mockReadContext
    );
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
  });

  it('converts zero-based to one-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await getSession(0);
    // Should call core getSession with index 1
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
  });

  it('interprets a numeric string as a zero-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await getSession('1');

    expect(mockGetSession).toHaveBeenCalledWith(2, undefined, undefined, mockReadContext);
  });

  it('passes composer ID string through to core getSession', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession('my-composer-id', 1));

    const session = await getSession('my-composer-id');

    expect(mockGetSession).toHaveBeenCalledWith(
      'my-composer-id',
      undefined,
      undefined,
      mockReadContext
    );
    expect(session.id).toBe('my-composer-id');
  });

  it('rejects a direct ID outside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary('inside-workspace', 1)]);

    await expect(
      getSession('outside-workspace', { workspace: '/workspace/a' })
    ).rejects.toMatchObject({
      name: 'SessionScopeMismatchError',
      code: 'SESSION_SCOPE_MISMATCH',
    } satisfies Partial<SessionScopeMismatchError>);

    expect(mockListSessions).toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns converted Session', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const session = await getSession(0);
    expect(session.id).toBe('c1');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]!.id).toBe('m1');
    expect(session.messages[0]!.role).toBe('user');
    expect(session.timestamp).toBe('2024-01-15T10:00:00.000Z');
  });

  it('projects pathless session sentinels to library workspace unknown', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession('pathless'),
      workspacePath: '(unknown workspace)',
      canonicalWorkspacePath: '(global)',
      matchedWorkspacePath: '(workspace: legacy-id)',
      indexWorkspacePath: '(workspace: legacy-id)',
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
    });

    const session = await getSession(0);
    expect(session.workspace).toBe('unknown');
    expect(session).not.toHaveProperty('canonicalWorkspacePath');
    expect(session).not.toHaveProperty('matchedWorkspacePath');
    expect(session).not.toHaveProperty('indexWorkspacePath');
    expect(session.workspaceMemberships).toEqual([]);
    expect(session.sourceInstances?.[0]?.workspacePaths).toEqual([]);
  });

  it('preserves the required library message timestamp for an untimed Store message', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      source: 'transcript',
      messages: [{ id: null, role: 'user', content: 'Store message', codeBlocks: [] }],
    });

    const session = await getSession(0);
    expect(session.messages[0]!.timestamp).toBe(now.toISOString());
    expect(session.messages[0]!.timestampSource).toBe('session-fallback');
  });

  it('marks the fixed epoch fallback unknown when the session has no source-derived anchor', async () => {
    const epoch = new Date(0);
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      createdAt: epoch,
      createdAtSource: 'epoch-unknown',
      source: 'transcript',
      messages: [{ id: null, role: 'user', content: 'Store message', codeBlocks: [] }],
    });

    const session = await getSession(0);
    expect(session.messages[0]!.timestamp).toBe(epoch.toISOString());
    expect(session.messages[0]!.timestampSource).toBe('unknown');
  });

  it('omits library Message.id when the core message ID is null', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      messages: [{ id: null, role: 'user', content: 'Hello', timestamp: now, codeBlocks: [] }],
    });

    const session = await getSession(0);
    expect(session.messages[0]!.id).toBeUndefined();
  });

  it('threads session source through the library type', async () => {
    mockGetSession.mockResolvedValue({ ...makeCoreSession(), source: 'workspace-fallback' });

    const session = await getSession(0);
    expect(session.source).toBe('workspace-fallback');
  });

  it('threads Store transcript state through the library type', async () => {
    mockGetSession.mockResolvedValue({ ...makeCoreSession(), transcriptState: 'partial' });

    const session = await getSession(0);
    expect(session.transcriptState).toBe('partial');
  });

  it('threads activeBranchBubbleIds through the library type when defined', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      activeBranchBubbleIds: ['m1'],
    });

    const session = await getSession(0);
    expect(session.activeBranchBubbleIds).toEqual(['m1']);
  });

  it('emits a complete replacement-safe merged view with additive provenance and identities', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession('merged-session', 3),
      workspacePath: '/workspaces/canonical',
      canonicalWorkspacePath: '/workspaces/canonical',
      matchedWorkspacePath: '/workspaces/alias',
      workspaceMatchKind: 'unique-suffix',
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/alias',
      source: 'merged',
      resolvedSource: 'merged',
      sources: ['composer', 'store'],
      preferredSource: 'composer',
      resolution: {
        state: 'complete',
        expectedSourceRoles: ['composer', 'store'],
        loadedSourceRoles: ['composer', 'store'],
        omittedSourceRoles: [],
        failedSourceRoles: [],
        reasonCodes: [],
      },
      workspaceMemberships: [
        {
          workspacePath: '/workspaces/alias',
          sourceRoles: ['store'],
          contributingInstanceCount: 1,
        },
      ],
      sourceInstances: [
        {
          sourceRole: 'store',
          representation: 'store-db',
          workspacePaths: ['/workspaces/alias'],
          state: 'contributed',
        },
      ],
      messageIdentityVersion: 1,
      createdAtSource: 'composer-metadata',
      lastUpdatedAtSource: 'store-db-metadata',
      transcriptState: 'parsed',
      activeBranchBubbleIds: ['bubble-native'],
      activeBranchMessageIds: ['msg:0'],
      messages: [
        {
          id: 'msg:0',
          messageIdentityVersion: 1,
          identityOrigin: 'composer-v0.16-index',
          parentMessageId: 'native-parent',
          isSidechain: false,
          role: 'assistant',
          content: 'Merged content',
          timestamp: later,
          timestampSource: 'composer-timing',
          source: 'both',
          codeBlocks: [],
          toolCalls: [
            {
              id: 'tool:v1:msg:0:hash:1',
              identityOrigin: 'tool-v1',
              name: 'Read',
              status: 'completed',
              params: { path: '/fixture/file' },
              result: 'contents',
              files: ['/fixture/file'],
            },
          ],
        },
      ],
    });

    const session = await getSession(2);

    expect(session).toMatchObject({
      id: 'merged-session',
      index: 2,
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/alias',
      workspace: '/workspaces/canonical',
      canonicalWorkspacePath: '/workspaces/canonical',
      matchedWorkspacePath: '/workspaces/alias',
      workspaceMatchKind: 'unique-suffix',
      source: 'global',
      resolvedSource: 'merged',
      sources: ['composer', 'store'],
      preferredSource: 'composer',
      messageIdentityVersion: 1,
      createdAtSource: 'composer-metadata',
      lastUpdatedAtSource: 'store-db-metadata',
      activeBranchBubbleIds: ['bubble-native'],
      activeBranchMessageIds: ['msg:0'],
      resolution: { state: 'complete' },
      messages: [
        {
          id: 'msg:0',
          messageIdentityVersion: 1,
          identityOrigin: 'composer-v0.16-index',
          parentMessageId: 'native-parent',
          isSidechain: false,
          timestampSource: 'composer-timing',
          source: 'both',
          toolCalls: [
            {
              id: 'tool:v1:msg:0:hash:1',
              identityOrigin: 'tool-v1',
              name: 'Read',
              result: 'contents',
            },
          ],
        },
      ],
    });
    expect(session).not.toHaveProperty('rawContentBlockEvidence');
    expect(session.messages[0]).not.toHaveProperty('rawContentBlocks');
    expect(Object.hasOwn(session, 'usage')).toBe(true);
    expect(session.usage).toBeUndefined();
  });

  it('keeps a degraded resolved view below the unchanged consumer replacement boundary', async () => {
    mockGetSession.mockResolvedValue({
      ...makeCoreSession(),
      source: 'store-complete',
      resolvedSource: 'store-db',
      resolution: {
        state: 'partial',
        expectedSourceRoles: ['store'],
        loadedSourceRoles: ['store'],
        omittedSourceRoles: [],
        failedSourceRoles: [],
        reasonCodes: ['source-partial'],
      },
    });

    const session = await getSession(0);
    expect(session.source).toBe('workspace-fallback');
    expect(session.resolvedSource).toBe('store-db');
    expect(session.resolution?.reasonCodes).toEqual(['source-partial']);
  });

  it('throws SessionNotFoundError with the caller identifier when session is not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(getSession(99)).rejects.toMatchObject({
      name: 'SessionNotFoundError',
      identifier: 99,
    } satisfies Partial<SessionNotFoundError>);
  });

  it('throws InvalidFilterError for invalid message filter', async () => {
    await expect(getSession(0, { messageFilter: ['invalid' as 'user'] })).rejects.toThrow(
      InvalidFilterError
    );
  });

  it('applies valid messageFilter', async () => {
    const session = makeCoreSession();
    session.messages = [
      { id: 'm1', role: 'user', content: 'Hello', timestamp: now, codeBlocks: [] },
      { id: 'm2', role: 'assistant', content: 'Hi', timestamp: later, codeBlocks: [] },
    ];
    mockGetSession.mockResolvedValue(session);

    const result = await getSession(0, { messageFilter: ['user'] });
    // filterMessages should filter to only user messages
    expect(result.messages.length).toBeLessThanOrEqual(2);
  });

  it('wraps SQLITE_BUSY as DatabaseLockedError', async () => {
    mockGetSession.mockRejectedValue(new Error('SQLITE_BUSY'));

    await expect(getSession(0)).rejects.toThrow(DatabaseLockedError);
  });
});

// =============================================================================
// searchSessions
// =============================================================================
describe('searchSessions', () => {
  it('returns search results', async () => {
    mockSearchSessions.mockResolvedValue([
      {
        sessionId: 'c1',
        index: 1,
        workspacePath: '~/proj',
        createdAt: now,
        matchCount: 1,
        snippets: [{ messageRole: 'user', text: 'found the bug', matchPositions: [[10, 13]] }],
      },
    ]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    const results = await searchSessions('bug');
    expect(results).toHaveLength(1);
    expect(results[0]!.session.id).toBe('c1');
    expect(mockSearchSessions.mock.calls[0]?.[4]).toBe(mockReadContext);
    expect(mockGetSession).toHaveBeenCalledWith('c1', undefined, undefined, mockReadContext, 1);
  });

  it('returns empty for no matches', async () => {
    mockSearchSessions.mockResolvedValue([]);

    const results = await searchSessions('nonexistent');
    expect(results).toEqual([]);
  });

  it('wraps SQLITE_BUSY as DatabaseLockedError', async () => {
    mockSearchSessions.mockRejectedValue(new Error('SQLITE_BUSY'));

    await expect(searchSessions('test')).rejects.toThrow(DatabaseLockedError);
  });
});

// =============================================================================
// exportSessionToJson / exportSessionToMarkdown
// =============================================================================
describe('exportSessionToJson', () => {
  it('resolves the export target inside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToJson(0, { workspace: '/workspace/a' });

    expect(mockListSessions).toHaveBeenCalledWith(
      {
        limit: 0,
        all: true,
        workspacePath: '/workspace/a',
        includeCrossWorkspaceSources: false,
      },
      undefined,
      undefined,
      mockReadContext
    );
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
  });

  it('delegates to core exportToJson', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const json = await exportSessionToJson(0);
    expect(json).toBe('{"test": true}');
  });

  it('interprets a numeric string export target as a zero-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToJson('1');

    expect(mockGetSession).toHaveBeenCalledWith(2, undefined, undefined, mockReadContext);
  });

  it('rejects a direct export ID outside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary('inside-workspace', 1)]);

    await expect(
      exportSessionToJson('outside-workspace', { workspace: '/workspace/a' })
    ).rejects.toMatchObject({
      name: 'SessionScopeMismatchError',
      code: 'SESSION_SCOPE_MISMATCH',
    } satisfies Partial<SessionScopeMismatchError>);

    expect(mockListSessions).toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('throws SessionNotFoundError when session is not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(exportSessionToJson(99)).rejects.toThrow(SessionNotFoundError);
  });
});

describe('exportSessionToMarkdown', () => {
  it('resolves the export target inside the configured workspace scope', async () => {
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToMarkdown(0, { workspace: '/workspace/a' });

    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
  });

  it('delegates to core exportToMarkdown', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    const md = await exportSessionToMarkdown(0);
    expect(md).toBe('# Test');
  });

  it('interprets a numeric string export target as a zero-based index', async () => {
    mockGetSession.mockResolvedValue(makeCoreSession());

    await exportSessionToMarkdown('1');

    expect(mockGetSession).toHaveBeenCalledWith(2, undefined, undefined, mockReadContext);
  });

  it('throws SessionNotFoundError when session is not found', async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(exportSessionToMarkdown(99)).rejects.toThrow(SessionNotFoundError);
  });
});

describe('bulk export late ambiguity handling', () => {
  it.each([
    { label: 'JSON', run: exportAllSessionsToJson, empty: '[]' },
    { label: 'Markdown', run: exportAllSessionsToMarkdown, empty: '' },
  ])('skips a payload that becomes ambiguous after the $label listing', async ({ run, empty }) => {
    const onDiagnostic = vi.fn();
    mockListSessions.mockResolvedValue([makeCoreSummary('late-ambiguous', 1)]);
    mockGetSession.mockRejectedValue(
      new SessionAmbiguityError('late-ambiguous', ['occurrence:v1:late-a', 'occurrence:v1:late-b'])
    );

    await expect(run({ onDiagnostic })).resolves.toBe(empty);
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SESSION_AMBIGUOUS',
        sessionId: 'late-ambiguous',
        occurrenceCount: 2,
      })
    );
    expect(mockReadContext.releaseSession).toHaveBeenCalledWith('late-ambiguous');
  });
});

// =============================================================================
// SessionReadContext public lifecycle and immutable configuration
// =============================================================================
describe('package-root SessionReadContext', () => {
  const boundSignal = new AbortController().signal;
  const conflictingSignal = new AbortController().signal;
  const boundDiagnostic = vi.fn();
  const conflictingDiagnostic = vi.fn();

  it('exposes only the opaque lifecycle and delegates release/dispose to core', async () => {
    const controller = new AbortController();
    const onDiagnostic = vi.fn();
    const coreContext = makeMockCoreReadContext(2);
    mockCreateSessionReadContext.mockImplementationOnce(faithfulCoreContextFactory(coreContext));

    const context = createPublicReadContext({
      dataPath: '/cursor/bound',
      backupPath: '/archives/bound.zip',
      workspace: '/workspaces/a',
      includeCrossWorkspaceSources: true,
      resolvedSessionCapacity: 2,
      onDiagnostic,
      sqliteDriver: 'better-sqlite3',
      sourceReadLimits: { sqliteRowCount: 6_000_000 },
      signal: controller.signal,
    });

    expect(mockCreateSessionReadContext).toHaveBeenCalledWith({
      dataPath: '/cursor/bound',
      backupPath: '/archives/bound.zip',
      workspacePath: '/workspaces/a',
      includeCrossWorkspaceSources: true,
      resolvedSessionCapacity: 2,
      onDiagnostic,
      sqliteDriver: 'better-sqlite3',
      sourceReadLimits: { sqliteRowCount: 6_000_000 },
      signal: controller.signal,
    });
    expect(context.resolvedSessionCapacity).toBe(2);
    expect(context.disposed).toBe(false);
    for (const internalField of [
      'workspaceScope',
      'storeSessions',
      'summaries',
      'resolvedSessions',
      'binding',
      'catalogPromise',
      'activeResolutions',
      'completedLru',
      'sourceReadLimits',
    ]) {
      expect(context).not.toHaveProperty(internalField);
    }

    context.releaseSession('session-a');
    expect(coreContext.releaseSession).toHaveBeenCalledWith('session-a');
    await expect(context.dispose()).resolves.toBeUndefined();
    await expect(context.dispose()).resolves.toBeUndefined();
    expect(coreContext.dispose).toHaveBeenCalled();
    expect(context.disposed).toBe(true);
    expect(() => context.releaseSession('session-a')).toThrowError(
      expect.objectContaining({ code: 'READ_CONTEXT_DISPOSED' })
    );
  });

  it('returns identical results for get-before-list and list-before-get', async () => {
    const getFirstCore = makeMockCoreReadContext();
    const listFirstCore = makeMockCoreReadContext();
    mockCreateSessionReadContext
      .mockImplementationOnce(faithfulCoreContextFactory(getFirstCore))
      .mockImplementationOnce(faithfulCoreContextFactory(listFirstCore));
    const getFirstContext = createPublicReadContext({
      dataPath: '/cursor/bound',
      workspace: '/workspaces/a',
    });
    const listFirstContext = createPublicReadContext({
      dataPath: '/cursor/bound',
      workspace: '/workspaces/a',
    });
    mockListSessions.mockResolvedValue([makeCoreSummary()]);
    mockGetSession.mockResolvedValue(makeCoreSession());

    const directFirst = await getSession('c1', { readContext: getFirstContext });
    const rowsAfterGet = await listSessions({ readContext: getFirstContext });
    const rowsFirst = await listSessions({ readContext: listFirstContext });
    const directAfterList = await getSession('c1', { readContext: listFirstContext });

    expect(directFirst).toEqual(directAfterList);
    expect(rowsAfterGet).toEqual(rowsFirst);
    expect(mockListSessions).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/workspaces/a' }),
      '/cursor/bound',
      undefined,
      getFirstCore
    );
    expect(mockListSessions).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/workspaces/a' }),
      '/cursor/bound',
      undefined,
      listFirstCore
    );
    expect(mockGetSession).toHaveBeenCalledWith('c1', '/cursor/bound', undefined, getFirstCore, 1);
    expect(mockGetSession).toHaveBeenCalledWith('c1', '/cursor/bound', undefined, listFirstCore, 1);
    expect(getFirstCore.dispose).not.toHaveBeenCalled();
    expect(listFirstCore.dispose).not.toHaveBeenCalled();

    await Promise.all([getFirstContext.dispose(), listFirstContext.dispose()]);
  });

  it('leaves caller-owned contexts open but disposes built-in contexts on success and failure', async () => {
    const callerCore = makeMockCoreReadContext();
    const successCore = makeMockCoreReadContext();
    const failureCore = makeMockCoreReadContext();
    mockCreateSessionReadContext
      .mockImplementationOnce(faithfulCoreContextFactory(callerCore))
      .mockImplementationOnce(faithfulCoreContextFactory(successCore))
      .mockImplementationOnce(faithfulCoreContextFactory(failureCore));
    const callerContext = createPublicReadContext({ dataPath: '/cursor/bound' });
    mockListSessions.mockResolvedValue([]);

    await listSessions({ readContext: callerContext });
    expect(callerCore.dispose).not.toHaveBeenCalled();

    await listSessions();
    expect(successCore.dispose).toHaveBeenCalledOnce();

    const failure = new Error('synthetic list failure');
    mockListSessions.mockRejectedValueOnce(failure);
    await expect(listSessions()).rejects.toThrow('Failed to list sessions');
    expect(failureCore.dispose).toHaveBeenCalledOnce();
    expect(callerContext.disposed).toBe(false);
    await callerContext.dispose();
  });

  it.each([
    {
      label: 'data source',
      config: { dataPath: '/cursor/other' },
      code: 'READ_CONTEXT_SOURCE_MISMATCH',
    },
    {
      label: 'backup source',
      config: { backupPath: '/archives/other.zip' },
      code: 'READ_CONTEXT_SOURCE_MISMATCH',
    },
    {
      label: 'workspace scope',
      config: { workspace: '/workspaces/b' },
      code: 'READ_CONTEXT_SCOPE_MISMATCH',
    },
    {
      label: 'cross-workspace option',
      config: { includeCrossWorkspaceSources: true },
      code: 'READ_CONTEXT_OPTIONS_MISMATCH',
    },
    {
      label: 'SQLite driver',
      config: { sqliteDriver: 'node:sqlite' as const },
      code: 'READ_CONTEXT_OPTIONS_MISMATCH',
    },
    {
      label: 'abort signal',
      config: { signal: conflictingSignal },
      code: 'READ_CONTEXT_OPTIONS_MISMATCH',
    },
    {
      label: 'diagnostic sink',
      config: { onDiagnostic: conflictingDiagnostic },
      code: 'READ_CONTEXT_OPTIONS_MISMATCH',
    },
  ])('rejects a conflicting immutable $label before payload I/O', async ({ config, code }) => {
    const coreContext = makeMockCoreReadContext();
    mockCreateSessionReadContext.mockImplementationOnce(faithfulCoreContextFactory(coreContext));
    const context = createPublicReadContext({
      dataPath: '/cursor/bound',
      backupPath: '/archives/bound.zip',
      workspace: '/workspaces/a',
      includeCrossWorkspaceSources: false,
      sqliteDriver: 'better-sqlite3',
      signal: boundSignal,
      onDiagnostic: boundDiagnostic,
    });
    mockCreateSessionReadContext.mockClear();

    await expect(
      listSessions({ readContext: context, ...config } as LibraryConfig)
    ).rejects.toMatchObject({ code });
    expect(mockCreateSessionReadContext).not.toHaveBeenCalled();
    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockSearchSessions).not.toHaveBeenCalled();
    expect(coreContext.dispose).not.toHaveBeenCalled();
    await context.dispose();
  });

  it('delivers safe diagnostics without aborting a built-in operation', async () => {
    const diagnostic: SessionDiagnostic = {
      code: 'SESSION_AMBIGUOUS',
      message: 'One logical session was skipped.',
      sessionId: 'ambiguous-session',
      occurrenceCount: 2,
      occurrenceRefs: ['occurrence:a', 'occurrence:b'],
      remedy: 'Select a non-ambiguous session.',
    };
    const onDiagnostic = vi.fn();
    const coreContext = makeMockCoreReadContext();
    mockCreateSessionReadContext.mockImplementationOnce(faithfulCoreContextFactory(coreContext));
    mockListSessions.mockImplementation(async (...args: unknown[]) => {
      (args[3] as MockCoreReadContext).emitDiagnostic?.(diagnostic);
      return [];
    });

    await expect(listSessions({ onDiagnostic })).resolves.toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
    expect(coreContext.dispose).toHaveBeenCalledOnce();
  });
});

describe('LibraryConfig read-context and Source Read Limits contract', () => {
  const simultaneousLimit: SourceReadLimitsOverride = { sqliteRowCount: 6_000_000 };
  const mismatchOperations: Array<{
    label: string;
    run: (config: LibraryConfig) => Promise<unknown>;
  }> = [
    { label: 'list', run: (config) => listSessions(config) },
    { label: 'get', run: (config) => getSession('c1', config) },
    { label: 'search', run: (config) => searchSessions('needle', config) },
    { label: 'single JSON export', run: (config) => exportSessionToJson('c1', config) },
    {
      label: 'single Markdown export',
      run: (config) => exportSessionToMarkdown('c1', config),
    },
    { label: 'bulk JSON export', run: (config) => exportAllSessionsToJson(config) },
    { label: 'bulk Markdown export', run: (config) => exportAllSessionsToMarkdown(config) },
  ];

  it.each(mismatchOperations)(
    'rejects readContext + sourceReadLimits for $label before payload I/O',
    async ({ run }) => {
      const coreContext = makeMockCoreReadContext();
      mockCreateSessionReadContext.mockImplementationOnce(faithfulCoreContextFactory(coreContext));
      const context = createPublicReadContext({
        dataPath: '/cursor/bound',
        sourceReadLimits: simultaneousLimit,
      });
      mockCreateSessionReadContext.mockClear();
      mockListSessions.mockResolvedValue([]);
      mockGetSession.mockResolvedValue(makeCoreSession());
      mockSearchSessions.mockResolvedValue([]);

      let failure: unknown;
      try {
        await run({
          readContext: context,
          sourceReadLimits: simultaneousLimit,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ReadContextOptionsMismatchError);
      expect(failure).toMatchObject({
        code: 'READ_CONTEXT_OPTIONS_MISMATCH',
        details: expect.objectContaining({ field: 'sourceReadLimits' }),
      });
      expect(mockCreateSessionReadContext).not.toHaveBeenCalled();
      expect(mockListSessions).not.toHaveBeenCalled();
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockSearchSessions).not.toHaveBeenCalled();
      expect(coreContext.dispose).not.toHaveBeenCalled();
      await context.dispose();
    }
  );

  it.each([
    ['unknown field', { unrecognizedBound: 1 }],
    ['policyVersion', { policyVersion: 'source-read-limits/v1' }],
    ['null', null],
  ])('rejects invalid %s source limits before payload I/O', (_label, invalid) => {
    expect(() =>
      createPublicReadContext({
        sourceReadLimits: invalid as unknown as SourceReadLimitsOverride,
      })
    ).toThrowError(SourceLimitConfigurationError);
    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockSearchSessions).not.toHaveBeenCalled();
  });

  it('inherits defaults for omitted and recognized-undefined overrides', async () => {
    const omittedCore = makeMockCoreReadContext();
    const inheritedCore = makeMockCoreReadContext();
    mockCreateSessionReadContext
      .mockImplementationOnce(faithfulCoreContextFactory(omittedCore))
      .mockImplementationOnce(faithfulCoreContextFactory(inheritedCore));

    const omitted = createPublicReadContext();
    const inherited = createPublicReadContext({
      sourceReadLimits: { sqliteRowCount: undefined },
    });

    expect(omittedCore.effectiveSourceReadLimits).toEqual(inheritedCore.effectiveSourceReadLimits);
    expect(omitted.resolvedSessionCapacity).toBe(1);
    expect(inherited.resolvedSessionCapacity).toBe(1);
    await Promise.all([omitted.dispose(), inherited.dispose()]);
  });

  it('keeps session identity stable across lower/raised limits and hydrates each row once', async () => {
    const lowerCore = makeMockCoreReadContext();
    const raisedCore = makeMockCoreReadContext();
    mockCreateSessionReadContext
      .mockImplementationOnce(faithfulCoreContextFactory(lowerCore))
      .mockImplementationOnce(faithfulCoreContextFactory(raisedCore));
    mockListSessions.mockResolvedValue([
      makeCoreSummary('stable-a', 1),
      makeCoreSummary('stable-b', 2),
    ]);
    mockGetSession.mockImplementation(async (id: string, ...args: unknown[]) => {
      const index = (args[3] as number | undefined) ?? (id === 'stable-a' ? 1 : 2);
      return makeCoreSession(id, index);
    });

    const lowered = await listSessions({ sourceReadLimits: { sqliteRowCount: 4_000_000 } });
    const raised = await listSessions({ sourceReadLimits: { sqliteRowCount: 6_000_000 } });

    expect(lowered.data.map((session) => session.id)).toEqual(['stable-a', 'stable-b']);
    expect(raised.data.map((session) => session.id)).toEqual(['stable-a', 'stable-b']);
    expect(mockCreateSessionReadContext).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sourceReadLimits: { sqliteRowCount: 4_000_000 } })
    );
    expect(mockCreateSessionReadContext).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sourceReadLimits: { sqliteRowCount: 6_000_000 } })
    );
    expect(mockGetSession.mock.calls.filter((call) => call[3] === lowerCore)).toHaveLength(2);
    expect(mockGetSession.mock.calls.filter((call) => call[3] === raisedCore)).toHaveLength(2);
    expect(mockGetSession.mock.calls.every((call) => call.length === 5)).toBe(true);
    expect(lowerCore.dispose).toHaveBeenCalledOnce();
    expect(raisedCore.dispose).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// setDriver / getActiveDriver
// =============================================================================
describe('setDriver', () => {
  it('delegates to core setDriver', () => {
    setDriver('better-sqlite3');
    expect(mockCoreSetDriver).toHaveBeenCalledWith('better-sqlite3');
  });
});

describe('getActiveDriver', () => {
  it('delegates to core getActiveDriver', () => {
    mockCoreGetActiveDriver.mockReturnValue('node:sqlite');
    expect(getActiveDriver()).toBe('node:sqlite');
  });

  it('returns undefined when no driver selected', () => {
    mockCoreGetActiveDriver.mockReturnValue(undefined);
    expect(getActiveDriver()).toBeUndefined();
  });
});
