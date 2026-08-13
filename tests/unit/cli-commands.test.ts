/**
 * Tests for CLI command registration and execution (list, show, search).
 * Mocks all core dependencies and verifies command behavior via programmatic arg parsing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import {
  BackupPublishedPermissionError,
  SessionAmbiguityError,
  SessionNotFoundError,
} from '../../src/lib/errors.js';

// --- Mock functions ---
const mockListSessions = vi.fn();
const mockListSessionSummaries = vi.fn((...args: unknown[]) => mockListSessions(...args));
const mockGetSession = vi.fn();
const mockSearchSessions = vi.fn();
const mockListWorkspaces = vi.fn();
const mockFindWorkspaces = vi.fn();
const mockValidateBackup = vi.fn();
const mockFormatSessionsTable = vi.fn(() => 'sessions table');
const mockFormatSessionsJson = vi.fn(() => '{"sessions":[]}');
const mockFormatSessionDetail = vi.fn(() => 'session detail');
const mockFormatSessionJson = vi.fn(() => '{"session":{}}');
const mockFormatWorkspacesTable = vi.fn(() => 'workspaces table');
const mockFormatWorkspacesJson = vi.fn(() => '{"workspaces":[]}');
const mockFormatSearchResultsTable = vi.fn(() => 'search results');
const mockFormatSearchResultsJson = vi.fn(() => '{"results":[]}');
const mockFormatOperationDiagnostics = vi.fn(() => '');
const mockFormatExportSuccess = vi.fn(() => 'Export done');
const mockFormatExportResultJson = vi.fn(() => '{"exported":[]}');
const mockFormatNoHistory = vi.fn(() => 'No history found');
const mockFormatCursorNotFound = vi.fn(() => 'Cursor not found');
const mockFilterMessages = vi.fn((messages: unknown[]) => messages);
const mockValidateMessageTypes = vi.fn(() => []);
const mockExistsSync = vi.fn(() => true);
const mockExpandPath = vi.fn((path: string) => path);
const mockReleaseSession = vi.fn();
const mockDisposeReadContext = vi.fn(async () => undefined);
const mockReadContext = {
  workspaceScope: null,
  includeCrossWorkspaceSources: false,
  resolvedSessionCapacity: 0,
  storeSessions: null,
  summaries: null,
  resolvedSessions: new Map(),
  releaseSession: (...args: unknown[]) => mockReleaseSession(...args),
  dispose: (...args: unknown[]) => mockDisposeReadContext(...args),
};
const mockCreateSessionReadContext = vi.fn(() => mockReadContext);

vi.mock('../../src/core/storage.js', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  listSessionSummaries: (...args: unknown[]) => mockListSessionSummaries(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  searchSessions: (...args: unknown[]) => mockSearchSessions(...args),
  listWorkspaces: (...args: unknown[]) => mockListWorkspaces(...args),
  findWorkspaces: (...args: unknown[]) => mockFindWorkspaces(...args),
  createSessionReadContext: (...args: unknown[]) => mockCreateSessionReadContext(...args),
}));

const mockListBackups = vi.fn();
const mockGetDefaultBackupDir = vi.fn(() => '/home/user/cursor-history-backups');
const mockCreateBackup = vi.fn();
const mockRestoreBackup = vi.fn();

vi.mock('../../src/core/backup.js', () => ({
  validateBackup: (...args: unknown[]) => mockValidateBackup(...args),
  createBackup: (...args: unknown[]) => mockCreateBackup(...args),
  restoreBackup: (...args: unknown[]) => mockRestoreBackup(...args),
  listBackups: (...args: unknown[]) => mockListBackups(...args),
  getDefaultBackupDir: () => mockGetDefaultBackupDir(),
}));

vi.mock('../../src/core/parser.js', () => ({
  exportToMarkdown: vi.fn(() => '# Markdown'),
  exportToJson: vi.fn(() => '{}'),
}));

vi.mock('../../src/cli/formatters/index.js', () => ({
  formatSessionsTable: (...args: unknown[]) => mockFormatSessionsTable(...args),
  formatSessionsJson: (...args: unknown[]) => mockFormatSessionsJson(...args),
  formatSessionDetail: (...args: unknown[]) => mockFormatSessionDetail(...args),
  formatSessionJson: (...args: unknown[]) => mockFormatSessionJson(...args),
  formatWorkspacesTable: (...args: unknown[]) => mockFormatWorkspacesTable(...args),
  formatWorkspacesJson: (...args: unknown[]) => mockFormatWorkspacesJson(...args),
  formatSearchResultsTable: (...args: unknown[]) => mockFormatSearchResultsTable(...args),
  formatSearchResultsJson: (...args: unknown[]) => mockFormatSearchResultsJson(...args),
  formatOperationDiagnostics: (...args: unknown[]) => mockFormatOperationDiagnostics(...args),
  formatNoHistory: (...args: unknown[]) => mockFormatNoHistory(...args),
  formatCursorNotFound: (...args: unknown[]) => mockFormatCursorNotFound(...args),
  formatExportSuccess: (...args: unknown[]) => mockFormatExportSuccess(...args),
  formatExportResultJson: (...args: unknown[]) => mockFormatExportResultJson(...args),
  filterMessages: (...args: unknown[]) => mockFilterMessages(...args),
  validateMessageTypes: (...args: unknown[]) => mockValidateMessageTypes(...args),
}));

vi.mock('../../src/lib/platform.js', () => ({
  expandPath: (p: string) => mockExpandPath(p),
  contractPath: (p: string) => p,
  getCursorDataPath: () => '/mock/cursor/data',
  getStoreStackRoot: () => '/mock/cursor/store',
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Mock migrate module
const mockMigrateWorkspace = vi.fn();
const mockMigrateSessions = vi.fn();
vi.mock('../../src/core/migrate.js', () => ({
  migrateWorkspace: (...args: unknown[]) => mockMigrateWorkspace(...args),
  migrateSessions: (...args: unknown[]) => mockMigrateSessions(...args),
}));

// Mock lib/errors type guards
vi.mock('../../src/lib/errors.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/errors.js')>('../../src/lib/errors.js');
  return actual;
});

// Import after mocks are set up
import { registerListCommand } from '../../src/cli/commands/list.js';
import { registerShowCommand } from '../../src/cli/commands/show.js';
import { registerSearchCommand } from '../../src/cli/commands/search.js';
import { registerExportCommand } from '../../src/cli/commands/export.js';
import { registerListBackupsCommand } from '../../src/cli/commands/list-backups.js';
import { registerMigrateCommand } from '../../src/cli/commands/migrate.js';
import { registerMigrateSessionCommand } from '../../src/cli/commands/migrate-session.js';
import { registerBackupCommand } from '../../src/cli/commands/backup.js';
import { registerRestoreCommand } from '../../src/cli/commands/restore.js';
import { writeFileSync } from 'node:fs';
import { parseSourceLimitOption } from '../../src/cli/source-limit-option.js';

let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExpandPath.mockImplementation((path: string) => path);
  mockListSessionSummaries.mockImplementation((...args: unknown[]) => mockListSessions(...args));
  mockFormatOperationDiagnostics.mockReturnValue('');
  mockFormatExportSuccess.mockReturnValue('Export done');
  mockFormatExportResultJson.mockReturnValue('{"exported":[]}');
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
});

function createProgram() {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'Output in JSON format');
  program.option('--data-path <path>', 'Custom path');
  program.option('-w, --workspace <path>', 'Filter by workspace');
  program.option('--include-cross-workspace-sources');
  program.option('--source-limit <field=value>', 'Source limit', parseSourceLimitOption);
  return program;
}

// --- Sample data factories ---
function makeSessions(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    id: `session-${i + 1}`,
    index: i + 1,
    title: `Session ${i + 1}`,
    createdAt: new Date('2025-01-01'),
    messageCount: 5,
    workspacePath: '/ws',
  }));
}

function makeSession(index = 1) {
  return {
    id: `session-${index}`,
    index,
    title: 'Test Session',
    createdAt: new Date('2025-01-01'),
    messages: [
      { role: 'user', content: 'hello', timestamp: new Date() },
      { role: 'assistant', content: 'hi there', timestamp: new Date() },
    ],
    workspaceId: 'ws1',
    workspacePath: '/ws',
  };
}

function makeSearchResults() {
  return [
    {
      sessionIndex: 1,
      title: 'Test Session',
      matches: [{ content: 'hello world', snippet: '...hello world...' }],
      totalMatches: 1,
    },
  ];
}

// ==================== LIST COMMAND ====================

describe('list command', () => {
  it('lists sessions with default options', async () => {
    const sessions = makeSessions();
    mockListSessions.mockResolvedValue(sessions);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list']);

    expect(mockListSessionSummaries).toHaveBeenCalledWith(
      { limit: 20, all: false, workspacePath: undefined },
      undefined,
      undefined,
      mockReadContext
    );
    expect(mockFormatSessionsTable).toHaveBeenCalledWith(sessions, false);
    expect(consoleSpy).toHaveBeenCalledWith('sessions table');
  });

  it('lists sessions with --json flag', async () => {
    mockListSessions.mockResolvedValue(makeSessions());

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'list']);

    expect(mockFormatSessionsJson).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('{"sessions":[]}');
  });

  it('passes workspace index scope into the top-level JSON list envelope', async () => {
    const sessions = makeSessions(1);
    mockListSessions.mockResolvedValue(sessions);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', '--json', '--workspace', '/workspace/a', 'list']);

    expect(mockFormatSessionsJson).toHaveBeenCalledWith(sessions, {
      indexScope: 'workspace',
      indexWorkspacePath: '/workspace/a',
      diagnostics: [],
    });
  });

  it('keeps one ambiguous logical row and emits one machine-readable list diagnostic', async () => {
    const ambiguous = {
      id: 'session-ambiguous',
      index: 2,
      indexScope: 'workspace' as const,
      indexWorkspacePath: '/workspace/a',
      resolutionState: 'ambiguous' as const,
      sourceRoles: ['composer'] as const,
      occurrenceCount: 2,
      diagnosticOccurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
    };
    mockListSessionSummaries.mockResolvedValue([ambiguous]);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', '--json', '--workspace', '/workspace/a', 'list']);

    expect(mockFormatSessionsJson).toHaveBeenCalledWith([ambiguous], {
      indexScope: 'workspace',
      indexWorkspacePath: '/workspace/a',
      diagnostics: [
        {
          code: 'SESSION_AMBIGUOUS',
          message: 'Session session-ambiguous has divergent physical occurrences.',
          sessionId: 'session-ambiguous',
          occurrenceCount: 2,
          occurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
          remedy: 'Resolve or remove the divergent replicas, then retry the operation.',
        },
      ],
    });
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
  });

  it('lists sessions with --all flag (limit = 0)', async () => {
    mockListSessions.mockResolvedValue(makeSessions());

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list', '--all']);

    expect(mockListSessionSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 0, all: true }),
      undefined,
      undefined,
      mockReadContext
    );
  });

  it('lists sessions with custom limit', async () => {
    mockListSessions.mockResolvedValue(makeSessions());

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list', '-n', '5']);

    expect(mockListSessionSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
      undefined,
      undefined,
      mockReadContext
    );
  });

  it('shows formatNoHistory when sessions list is empty', async () => {
    mockListSessions.mockResolvedValue([]);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list']);

    expect(mockFormatNoHistory).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('No history found');
  });

  it('outputs JSON for empty sessions list', async () => {
    mockListSessions.mockResolvedValue([]);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'list']);

    expect(mockFormatSessionsJson).toHaveBeenCalledWith([], {
      indexScope: 'global',
      diagnostics: [],
    });
    expect(consoleSpy).toHaveBeenCalledWith('{"sessions":[]}');
  });

  it('lists workspaces with --workspaces flag', async () => {
    const workspaces = [{ path: '/ws1', sessionCount: 3 }];
    mockListWorkspaces.mockResolvedValue(workspaces);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list', '--workspaces']);

    expect(mockListWorkspaces).toHaveBeenCalled();
    expect(mockFormatWorkspacesTable).toHaveBeenCalledWith(workspaces);
    expect(consoleSpy).toHaveBeenCalledWith('workspaces table');
  });

  it('lists workspaces with --json flag', async () => {
    mockListWorkspaces.mockResolvedValue([{ path: '/ws1', sessionCount: 3 }]);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'list', '--workspaces']);

    expect(mockFormatWorkspacesJson).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('{"workspaces":[]}');
  });

  it('shows formatNoHistory when workspaces list is empty', async () => {
    mockListWorkspaces.mockResolvedValue([]);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list', '--workspaces']);

    expect(mockFormatNoHistory).toHaveBeenCalled();
  });

  it('outputs JSON for empty workspaces list', async () => {
    mockListWorkspaces.mockResolvedValue([]);

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'list', '--workspaces']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ count: 0, workspaces: [] }));
  });

  it('exits with code 3 when Cursor data not found for workspaces', async () => {
    mockExistsSync.mockReturnValue(false);

    const program = createProgram();
    registerListCommand(program);

    await expect(program.parseAsync(['node', 'test', 'list', '--workspaces'])).rejects.toThrow(
      'process.exit'
    );

    expect(mockFormatCursorNotFound).toHaveBeenCalledWith('/mock/cursor/data');
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('passes --ids flag to formatSessionsTable', async () => {
    mockListSessions.mockResolvedValue(makeSessions());

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list', '--ids']);

    expect(mockFormatSessionsTable).toHaveBeenCalledWith(expect.any(Array), true);
  });

  it('passes workspace filter from global option', async () => {
    mockListSessions.mockResolvedValue(makeSessions());

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', '-w', '/my/workspace', 'list']);

    expect(mockListSessionSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/my/workspace' }),
      undefined,
      undefined,
      mockReadContext
    );
  });
});

// ==================== SHOW COMMAND ====================

describe('show command', () => {
  it('resolves a workspace-filtered index against the filtered listing', async () => {
    mockListSessions.mockResolvedValue(makeSessions());
    mockGetSession.mockResolvedValue(makeSession());

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', '--workspace', '/workspace/a', 'show', '1']);

    expect(mockListSessions).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      undefined,
      undefined,
      expect.any(Object)
    );
    const context = mockListSessions.mock.calls[0]![3];
    expect(mockGetSession).toHaveBeenCalledWith('session-1', undefined, undefined, context, 1);
    expect(mockFindWorkspaces).not.toHaveBeenCalled();
  });

  it('reuses an ambiguous scoped index through the bound logical catalog', async () => {
    mockListSessions.mockResolvedValue([]);
    mockGetSession.mockRejectedValue(
      new SessionAmbiguityError('ambiguous-session', ['occurrence:v1:b', 'occurrence:v1:a'])
    );

    const program = createProgram();
    registerShowCommand(program);

    await expect(
      program.parseAsync(['node', 'test', '--workspace', '/workspace/a', 'show', '1'])
    ).rejects.toThrow('process.exit');

    const context = mockListSessions.mock.calls[0]![3];
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, context);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('divergent source replicas')
    );
  });

  it('passes composer ID string to getSession when argument is not all digits', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', 'show', 'uuid-abc-123-def']);

    expect(mockGetSession).toHaveBeenCalledWith('uuid-abc-123-def', undefined, undefined);
    expect(mockFormatSessionDetail).toHaveBeenCalledWith(session, '/ws', expect.any(Object));
  });

  it('resolves a direct ID only through the active workspace listing', async () => {
    mockListSessions.mockResolvedValue(makeSessions());
    mockGetSession.mockResolvedValue(makeSession());
    const program = createProgram();
    registerShowCommand(program);

    await program.parseAsync(['node', 'test', '--workspace', '/workspace/a', 'show', 'session-2']);

    expect(mockListSessions).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      undefined,
      undefined,
      expect.any(Object)
    );
    const context = mockListSessions.mock.calls[0]![3];
    expect(mockGetSession).toHaveBeenCalledWith('session-2', undefined, undefined, context, 2);
  });

  it('shows session detail by index', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', 'show', '1']);

    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined);
    expect(mockFormatSessionDetail).toHaveBeenCalledWith(
      session,
      '/ws',
      expect.objectContaining({
        short: false,
        fullThinking: false,
        fullTool: false,
        fullError: false,
      })
    );
    expect(consoleSpy).toHaveBeenCalledWith('session detail');
  });

  it('shows session with --json flag', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'show', '1']);

    expect(mockFormatSessionJson).toHaveBeenCalledWith(session, '/ws', undefined, 2);
    expect(consoleSpy).toHaveBeenCalledWith('{"session":{}}');
  });

  it('shows session with --short flag', async () => {
    mockGetSession.mockResolvedValue(makeSession());

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', 'show', '1', '-s']);

    expect(mockFormatSessionDetail).toHaveBeenCalledWith(
      expect.any(Object),
      '/ws',
      expect.objectContaining({ short: true })
    );
  });

  it('shows session with --tool flag', async () => {
    mockGetSession.mockResolvedValue(makeSession());

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', 'show', '1', '--tool']);

    expect(mockFormatSessionDetail).toHaveBeenCalledWith(
      expect.any(Object),
      '/ws',
      expect.objectContaining({ fullTool: true })
    );
  });

  it('shows session with --think flag', async () => {
    mockGetSession.mockResolvedValue(makeSession());

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', 'show', '1', '-t']);

    expect(mockFormatSessionDetail).toHaveBeenCalledWith(
      expect.any(Object),
      '/ws',
      expect.objectContaining({ fullThinking: true })
    );
  });

  it('shows session with --error flag', async () => {
    mockGetSession.mockResolvedValue(makeSession());

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', 'show', '1', '-e']);

    expect(mockFormatSessionDetail).toHaveBeenCalledWith(
      expect.any(Object),
      '/ws',
      expect.objectContaining({ fullError: true })
    );
  });

  it('exits with error for invalid index (0)', async () => {
    const program = createProgram();
    registerShowCommand(program);

    await expect(program.parseAsync(['node', 'test', 'show', '0'])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalled();
  });

  it('exits with error when session ID not found', async () => {
    mockGetSession.mockRejectedValue(new SessionNotFoundError('abc'));

    const program = createProgram();
    registerShowCommand(program);

    await expect(program.parseAsync(['node', 'test', 'show', 'abc'])).rejects.toThrow(
      'process.exit'
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('throws SessionNotFoundError when session is null', async () => {
    mockGetSession.mockResolvedValue(null);
    mockListSessions.mockResolvedValue(makeSessions(5));

    const program = createProgram();
    registerShowCommand(program);

    await expect(program.parseAsync(['node', 'test', 'show', '99'])).rejects.toThrow(
      'process.exit'
    );

    // handleError is called which does console.error + process.exit
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('passes --only filter types to validateMessageTypes and filterMessages', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockValidateMessageTypes.mockReturnValue([]);

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', 'show', '1', '--only', 'user,assistant']);

    expect(mockValidateMessageTypes).toHaveBeenCalledWith(['user', 'assistant']);
    expect(mockFilterMessages).toHaveBeenCalledWith(session.messages, ['user', 'assistant']);
  });

  it('exits with error for invalid --only types', async () => {
    mockValidateMessageTypes.mockReturnValue(['invalid_type']);

    const program = createProgram();
    registerShowCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'show', '1', '--only', 'invalid_type'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('passes custom data-path to getSession', async () => {
    mockGetSession.mockResolvedValue(makeSession());

    const program = createProgram();
    registerShowCommand(program);
    await program.parseAsync(['node', 'test', '--data-path', '/custom/path', 'show', '1']);

    expect(mockGetSession).toHaveBeenCalledWith(1, '/custom/path', undefined);
  });
});

// ==================== SEARCH COMMAND ====================

describe('search command', () => {
  it('searches and displays table results', async () => {
    const results = makeSearchResults();
    mockSearchSessions.mockResolvedValue(results);

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', 'search', 'hello']);

    expect(mockSearchSessions).toHaveBeenCalledWith(
      'hello',
      { limit: 10, contextChars: 50, workspacePath: undefined },
      undefined,
      undefined,
      mockReadContext
    );
    expect(mockCreateSessionReadContext).toHaveBeenCalledWith({
      dataPath: undefined,
      backupPath: undefined,
      workspacePath: undefined,
      resolvedSessionCapacity: 0,
      sourceReadLimits: undefined,
      onDiagnostic: expect.any(Function),
    });
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
    expect(mockFormatSearchResultsTable).toHaveBeenCalledWith(results, 'hello');
    expect(mockFormatOperationDiagnostics).toHaveBeenCalledWith([]);
    expect(consoleSpy).toHaveBeenCalledWith('search results');
  });

  it('searches with --json flag', async () => {
    mockSearchSessions.mockResolvedValue(makeSearchResults());

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'search', 'hello']);

    expect(mockFormatSearchResultsJson).toHaveBeenCalledWith(expect.any(Array), 'hello', {
      diagnostics: [],
      indexScope: 'global',
    });
    expect(consoleSpy).toHaveBeenCalledWith('{"results":[]}');
  });

  it('searches with custom limit and context', async () => {
    mockSearchSessions.mockResolvedValue(makeSearchResults());

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', 'search', 'hello', '-n', '5', '-c', '100']);

    expect(mockSearchSessions).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ limit: 5, contextChars: 100 }),
      undefined,
      undefined,
      mockReadContext
    );
  });

  it('handles no results in text mode by calling handleError', async () => {
    mockSearchSessions.mockResolvedValue([]);

    const program = createProgram();
    registerSearchCommand(program);

    await expect(program.parseAsync(['node', 'test', 'search', 'nonexistent'])).rejects.toThrow(
      'process.exit'
    );

    // handleError prints the NoSearchResultsError message
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
    expect(mockDisposeReadContext.mock.invocationCallOrder[0]).toBeLessThan(
      exitSpy.mock.invocationCallOrder[0]!
    );
  });

  it('handles no results in JSON mode with structured output', async () => {
    mockSearchSessions.mockResolvedValue([]);

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'search', 'nonexistent']);

    expect(mockFormatSearchResultsJson).toHaveBeenCalledWith([], 'nonexistent', {
      diagnostics: [],
      indexScope: 'global',
    });
    expect(consoleSpy).toHaveBeenCalledWith('{"results":[]}');
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
  });

  it('deduplicates ambiguity diagnostics in an empty JSON search result', async () => {
    const diagnostic = {
      code: 'SESSION_AMBIGUOUS' as const,
      message: 'Session duplicate has divergent physical occurrences.',
      sessionId: 'session-duplicate',
      occurrenceCount: 2,
      occurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
      remedy: 'Resolve the replicas and retry.',
    };
    mockSearchSessions.mockImplementation(async () => {
      const contextOptions = mockCreateSessionReadContext.mock.calls.at(-1)![0] as {
        onDiagnostic(diagnostic: typeof diagnostic): void;
      };
      contextOptions.onDiagnostic(diagnostic);
      contextOptions.onDiagnostic(diagnostic);
      return [];
    });

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'search', 'needle']);

    expect(mockFormatSearchResultsJson).toHaveBeenCalledWith([], 'needle', {
      diagnostics: [diagnostic],
      indexScope: 'global',
    });
  });

  it('prints an actionable ambiguity diagnostic instead of a not-found fatal', async () => {
    const diagnostic = {
      code: 'SESSION_AMBIGUOUS' as const,
      message: 'A divergent session was skipped.',
      sessionId: 'session-duplicate',
      remedy: 'Resolve the replicas and retry.',
    };
    mockFormatOperationDiagnostics.mockReturnValue('actionable diagnostic');
    mockSearchSessions.mockImplementation(async () => {
      const contextOptions = mockCreateSessionReadContext.mock.calls.at(-1)![0] as {
        onDiagnostic(diagnostic: typeof diagnostic): void;
      };
      contextOptions.onDiagnostic(diagnostic);
      return [];
    });

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', 'search', 'needle']);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockFormatOperationDiagnostics).toHaveBeenCalledWith([diagnostic]);
    expect(consoleSpy).toHaveBeenCalledWith('search results\n\nactionable diagnostic');
  });

  it('passes workspace filter from global option', async () => {
    mockSearchSessions.mockResolvedValue(makeSearchResults());

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', '-w', '/my/ws', 'search', 'hello']);

    expect(mockSearchSessions).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ workspacePath: '/my/ws' }),
      undefined,
      undefined,
      mockReadContext
    );
  });

  it('passes custom data-path to searchSessions', async () => {
    mockSearchSessions.mockResolvedValue(makeSearchResults());

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', '--data-path', '/custom', 'search', 'hello']);

    expect(mockSearchSessions).toHaveBeenCalledWith(
      'hello',
      expect.any(Object),
      '/custom',
      undefined,
      mockReadContext
    );
  });

  it('binds Source Read Limits into the capacity-zero search context', async () => {
    const sourceReadLimits = { sqliteRowCount: 6_000_000 };
    mockSearchSessions.mockResolvedValue(makeSearchResults());
    const program = createProgram();
    program.setOptionValue('sourceLimit', sourceReadLimits);
    registerSearchCommand(program);

    await program.parseAsync(['node', 'test', 'search', 'hello']);

    expect(mockCreateSessionReadContext).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedSessionCapacity: 0,
        sourceReadLimits,
      })
    );
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
  });

  it('disposes the owned search context before handling storage failures', async () => {
    mockSearchSessions.mockRejectedValue(new Error('synthetic search failure'));
    const program = createProgram();
    registerSearchCommand(program);

    await expect(program.parseAsync(['node', 'test', 'search', 'hello'])).rejects.toThrow(
      'process.exit'
    );

    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
    expect(mockDisposeReadContext.mock.invocationCallOrder[0]).toBeLessThan(
      exitSpy.mock.invocationCallOrder[0]!
    );
  });
});

// ==================== EXPORT COMMAND ====================

describe('export command', () => {
  it('resolves a workspace-filtered index against the filtered listing', async () => {
    mockListSessions.mockResolvedValue(makeSessions());
    mockGetSession.mockResolvedValue(makeSession());
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(false);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync([
      'node',
      'test',
      '--workspace',
      '/workspace/a',
      'export',
      '1',
      '-o',
      '/tmp/out.md',
    ]);

    expect(mockListSessions).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      undefined,
      undefined,
      expect.any(Object)
    );
    const context = mockListSessions.mock.calls[0]![3];
    expect(mockGetSession).toHaveBeenCalledWith('session-1', undefined, undefined, context, 1);
  });

  it('resolves a direct export ID only through the active workspace listing', async () => {
    mockListSessions.mockResolvedValue(makeSessions());
    mockGetSession.mockResolvedValue(makeSession());
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(false);
    const program = createProgram();
    registerExportCommand(program);

    await program.parseAsync([
      'node',
      'test',
      '--workspace',
      '/workspace/a',
      'export',
      'session-2',
      '-o',
      '/tmp/out.md',
    ]);

    expect(mockListSessions).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      undefined,
      undefined,
      expect.any(Object)
    );
    const context = mockListSessions.mock.calls[0]![3];
    expect(mockGetSession).toHaveBeenCalledWith('session-2', undefined, undefined, context, 2);
  });

  it('exports single session to markdown', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(false); // output file doesn't exist

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync(['node', 'test', 'export', '1', '-o', '/tmp/out.md']);

    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('/tmp/out.md', '# Markdown', 'utf-8');
    expect(consoleSpy).toHaveBeenCalledWith('Export done');
  });

  it('exports single session to json format', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(false);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync(['node', 'test', 'export', '1', '-o', '/tmp/out.json', '-f', 'json']);

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith('/tmp/out.json', '{}', 'utf-8');
  });

  it('exports single session with --json result output', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockFindWorkspaces.mockResolvedValue([]);
    mockExistsSync.mockReturnValue(false);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'export', '1', '-o', '/tmp/out.md']);

    expect(consoleSpy).toHaveBeenCalledWith('{"exported":[]}');
  });

  it('exits with error when no index and no --all', async () => {
    const program = createProgram();
    registerExportCommand(program);

    await expect(program.parseAsync(['node', 'test', 'export'])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('exits with error for invalid index', async () => {
    const program = createProgram();
    registerExportCommand(program);

    await expect(program.parseAsync(['node', 'test', 'export', '0'])).rejects.toThrow(
      'process.exit'
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('exits with error when session not found', async () => {
    mockGetSession.mockResolvedValue(null);
    mockListSessions.mockResolvedValue(makeSessions(3));

    const program = createProgram();
    registerExportCommand(program);

    await expect(program.parseAsync(['node', 'test', 'export', '99'])).rejects.toThrow(
      'process.exit'
    );

    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('passes composer ID to getSession when export argument is not numeric', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(false);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync(['node', 'test', 'export', 'my-composer-uuid', '-o', '/tmp/out.md']);

    expect(mockGetSession).toHaveBeenCalledWith('my-composer-uuid', undefined, undefined);
  });

  it('exits with composer ID in error when session null and identifier is composer ID', async () => {
    mockGetSession.mockResolvedValue(null);

    const program = createProgram();
    registerExportCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'export', 'missing-composer-id', '-o', '/tmp/out.md'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Session not found: missing-composer-id');
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('exits with error when file exists and no --force', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockFindWorkspaces.mockResolvedValue([]);
    mockExistsSync.mockReturnValue(true); // file already exists

    const program = createProgram();
    registerExportCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'export', '1', '-o', '/tmp/existing.md'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('overwrites file when --force is set', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockFindWorkspaces.mockResolvedValue([]);
    mockExistsSync.mockReturnValue(true);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync(['node', 'test', 'export', '1', '-o', '/tmp/out.md', '--force']);

    expect(vi.mocked(writeFileSync)).toHaveBeenCalled();
  });

  it('exports all sessions with --all flag', async () => {
    const sessions = makeSessions(2);
    mockListSessions.mockResolvedValue(sessions);
    const session1 = { ...makeSession(1), workspaceId: 'ws1' };
    const session2 = { ...makeSession(2), workspaceId: 'ws1' };
    mockGetSession.mockResolvedValueOnce(session1).mockResolvedValueOnce(session2);
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(true); // output dir exists, but files don't clash since force isn't needed with unique names

    const program = createProgram();
    registerExportCommand(program);
    // Use --force to avoid FileExistsError on generated filenames
    await program.parseAsync(['node', 'test', 'export', '--all', '--force', '-o', '/tmp/exports']);

    expect(mockListSessionSummaries).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: undefined },
      undefined,
      undefined,
      expect.objectContaining({ storeSessions: null, summaries: null })
    );
    expect(mockCreateSessionReadContext).toHaveBeenCalledWith({
      dataPath: undefined,
      backupPath: undefined,
      workspacePath: undefined,
      resolvedSessionCapacity: 0,
      sourceReadLimits: undefined,
      onDiagnostic: expect.any(Function),
    });
    expect(mockReleaseSession).toHaveBeenNthCalledWith(1, 'session-1');
    expect(mockReleaseSession).toHaveBeenNthCalledWith(2, 'session-2');
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2);
  });

  it('exports all sessions as JSON with bound limits and releases each payload', async () => {
    const sourceReadLimits = { sqliteRowCount: 6_000_000 };
    mockListSessions.mockResolvedValue([makeSessions(1)[0]]);
    mockGetSession.mockResolvedValue(makeSession(1));
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(true);
    const program = createProgram();
    program.setOptionValue('sourceLimit', sourceReadLimits);
    registerExportCommand(program);

    await program.parseAsync([
      'node',
      'test',
      'export',
      '--all',
      '--force',
      '--format',
      'json',
      '--output',
      '/tmp/exports',
    ]);

    expect(mockCreateSessionReadContext).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedSessionCapacity: 0,
        sourceReadLimits,
      })
    );
    expect(mockReleaseSession).toHaveBeenCalledWith('session-1');
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.stringMatching(/\.json$/),
      '{}',
      'utf-8'
    );
  });

  it('exports resolved rows and reports each ambiguous logical group once in JSON', async () => {
    const resolved = makeSessions(1)[0]!;
    const ambiguous = {
      id: 'session-ambiguous',
      index: 2,
      indexScope: 'global' as const,
      resolutionState: 'ambiguous' as const,
      sourceRoles: ['composer'] as const,
      occurrenceCount: 2,
      diagnosticOccurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
    };
    mockListSessionSummaries.mockResolvedValue([resolved, ambiguous]);
    mockGetSession.mockResolvedValue(makeSession(1));
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/ws' }]);
    mockExistsSync.mockReturnValue(true);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync([
      'node',
      'test',
      '--json',
      'export',
      '--all',
      '--force',
      '--output',
      '/tmp/exports',
    ]);

    expect(mockGetSession).toHaveBeenCalledOnce();
    expect(mockGetSession).toHaveBeenCalledWith(
      resolved.id,
      undefined,
      undefined,
      mockReadContext,
      resolved.index
    );
    expect(mockFormatExportResultJson).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          index: 1,
          indexScope: 'global',
          sessionId: 'session-1',
        }),
      ],
      {
        diagnostics: [
          {
            code: 'SESSION_AMBIGUOUS',
            message: 'Session session-ambiguous has divergent physical occurrences.',
            sessionId: 'session-ambiguous',
            occurrenceCount: 2,
            occurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
            remedy: 'Resolve or remove the divergent replicas, then retry the operation.',
          },
        ],
      }
    );
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce();
  });

  it('skips a session that becomes ambiguous after listing and reports it once', async () => {
    const resolved = makeSessions(1)[0]!;
    mockListSessionSummaries.mockResolvedValue([resolved]);
    mockGetSession.mockRejectedValue(
      new SessionAmbiguityError(resolved.id, ['occurrence:v1:late-a', 'occurrence:v1:late-b'])
    );
    mockFindWorkspaces.mockResolvedValue([]);
    mockExistsSync.mockReturnValue(true);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync([
      'node',
      'test',
      '--json',
      'export',
      '--all',
      '--force',
      '--output',
      '/tmp/exports',
    ]);

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(mockReleaseSession).toHaveBeenCalledWith(resolved.id);
    expect(mockFormatExportResultJson).toHaveBeenCalledWith([], {
      diagnostics: [
        expect.objectContaining({
          code: 'SESSION_AMBIGUOUS',
          sessionId: resolved.id,
          occurrenceCount: 2,
        }),
      ],
    });
  });

  it('releases the active export payload and disposes before handling failures', async () => {
    mockListSessions.mockResolvedValue([makeSessions(1)[0]]);
    mockGetSession.mockRejectedValue(new Error('synthetic export failure'));
    mockFindWorkspaces.mockResolvedValue([]);
    mockExistsSync.mockReturnValue(true);
    const program = createProgram();
    registerExportCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'export', '--all', '--force'])
    ).rejects.toThrow('process.exit');

    expect(mockReleaseSession).toHaveBeenCalledWith('session-1');
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
    expect(mockDisposeReadContext.mock.invocationCallOrder[0]).toBeLessThan(
      exitSpy.mock.invocationCallOrder[0]!
    );
  });

  it('limits --all exports to the global workspace filter', async () => {
    mockListSessions.mockResolvedValue([makeSessions(1)[0]]);
    mockGetSession.mockResolvedValue(makeSession());
    mockFindWorkspaces.mockResolvedValue([{ id: 'ws1', path: '/workspace/a' }]);
    mockExistsSync.mockReturnValue(true);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync([
      'node',
      'test',
      '--workspace',
      '/workspace/a',
      'export',
      '--all',
      '--force',
      '-o',
      '/tmp/exports',
    ]);

    expect(mockListSessionSummaries).toHaveBeenCalledWith(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      undefined,
      undefined,
      expect.any(Object)
    );
    expect(mockFindWorkspaces).not.toHaveBeenCalled();
  });

  it('exports all sessions exits when no sessions', async () => {
    mockListSessions.mockResolvedValue([]);

    const program = createProgram();
    registerExportCommand(program);

    await expect(program.parseAsync(['node', 'test', 'export', '--all'])).rejects.toThrow(
      'process.exit'
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('generates default filename when no -o specified', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);
    mockFindWorkspaces.mockResolvedValue([]);
    mockExistsSync.mockReturnValue(false);

    const program = createProgram();
    registerExportCommand(program);
    await program.parseAsync(['node', 'test', 'export', '1']);

    // Default filename: YYYY-MM-DD-index-title.md
    const writeCall = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(writeCall[0])).toMatch(/2025-01-01-1-Test_Session\.md$/);
  });
});

// ==================== LIST-BACKUPS COMMAND ====================

describe('list-backups command', () => {
  it('lists backups in default directory', async () => {
    mockExistsSync.mockReturnValue(true);
    const backups = [
      {
        filename: 'backup1.zip',
        filePath: '/backups/backup1.zip',
        fileSize: 5000,
        modifiedAt: new Date('2025-01-15'),
        manifest: {
          createdAt: '2025-01-15T10:00:00Z',
          stats: { sessionCount: 10, workspaceCount: 2, totalSize: 5000 },
        },
      },
    ];
    mockListBackups.mockResolvedValue(backups);

    const program = createProgram();
    registerListBackupsCommand(program);
    await program.parseAsync(['node', 'test', 'list-backups']);

    expect(mockListBackups).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('lists backups with --json flag', async () => {
    mockExistsSync.mockReturnValue(true);
    const backups = [
      {
        filename: 'backup1.zip',
        filePath: '/backups/backup1.zip',
        fileSize: 5000,
        modifiedAt: new Date('2025-01-15'),
        manifest: {
          createdAt: '2025-01-15T10:00:00Z',
          stats: { sessionCount: 10, workspaceCount: 2, totalSize: 5000 },
        },
      },
    ];
    mockListBackups.mockResolvedValue(backups);

    const program = createProgram();
    registerListBackupsCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'list-backups']);

    // Should output JSON
    const output = consoleSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.count).toBe(1);
    expect(parsed.backups).toHaveLength(1);
  });

  it('exits when directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const program = createProgram();
    registerListBackupsCommand(program);

    await expect(program.parseAsync(['node', 'test', 'list-backups'])).rejects.toThrow(
      'process.exit'
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('exits with JSON when directory does not exist and --json', async () => {
    mockExistsSync.mockReturnValue(false);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    const program = createProgram();
    registerListBackupsCommand(program);

    await expect(program.parseAsync(['node', 'test', '--json', 'list-backups'])).rejects.toThrow(
      'process.exit'
    );

    expect(consoleSpy).not.toHaveBeenCalled();
    const output = String(stderr.mock.calls[0]![0]);
    const parsed = JSON.parse(output);
    expect(parsed.error).toBe('Directory not found');
  });

  it('handles no backups found', async () => {
    mockExistsSync.mockReturnValue(true);
    mockListBackups.mockResolvedValue([]);

    const program = createProgram();
    registerListBackupsCommand(program);
    await program.parseAsync(['node', 'test', 'list-backups']);

    // Shows "No backups found" message
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('handles no backups found with --json', async () => {
    mockExistsSync.mockReturnValue(true);
    mockListBackups.mockResolvedValue([]);

    const program = createProgram();
    registerListBackupsCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'list-backups']);

    const output = consoleSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.count).toBe(0);
  });

  it('uses custom directory with -d flag', async () => {
    mockExistsSync.mockReturnValue(true);
    mockListBackups.mockResolvedValue([]);

    const program = createProgram();
    registerListBackupsCommand(program);
    await program.parseAsync(['node', 'test', 'list-backups', '-d', '/custom/backups']);

    expect(mockListBackups).toHaveBeenCalledWith('/custom/backups', {
      sourceReadLimits: undefined,
    });
  });

  it('forwards the immutable source-limit override to archive inspection', async () => {
    mockExistsSync.mockReturnValue(true);
    mockListBackups.mockResolvedValue([]);
    const sourceReadLimits = Object.freeze({ zipEntryCount: 17 });

    const program = createProgram();
    program.setOptionValue('sourceLimit', sourceReadLimits);
    registerListBackupsCommand(program);
    await program.parseAsync(['node', 'test', 'list-backups']);

    expect(mockListBackups).toHaveBeenCalledWith('/home/user/cursor-history-backups', {
      sourceReadLimits,
    });
  });

  it('displays backup with error status', async () => {
    mockExistsSync.mockReturnValue(true);
    const backups = [
      {
        filename: 'bad.zip',
        filePath: '/backups/bad.zip',
        fileSize: 100,
        modifiedAt: new Date('2025-01-15'),
        error: 'Corrupt file',
      },
    ];
    mockListBackups.mockResolvedValue(backups);

    const program = createProgram();
    registerListBackupsCommand(program);
    await program.parseAsync(['node', 'test', 'list-backups']);

    expect(consoleSpy).toHaveBeenCalled();
  });
});

// ==================== MIGRATE COMMAND ====================

describe('migrate command', () => {
  it('migrates workspace with default options (move mode)', async () => {
    mockMigrateWorkspace.mockResolvedValue({
      success: true,
      source: '/source',
      destination: '/dest',
      mode: 'move',
      totalSessions: 3,
      successCount: 3,
      failureCount: 0,
      results: [],
      dryRun: false,
    });

    const program = createProgram();
    registerMigrateCommand(program);
    await program.parseAsync(['node', 'test', 'migrate', '/source', '/dest']);

    expect(mockMigrateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        source: '/source',
        destination: '/dest',
        mode: 'move',
        dryRun: false,
        force: false,
      })
    );
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('migrates with --copy flag', async () => {
    mockMigrateWorkspace.mockResolvedValue({
      success: true,
      source: '/source',
      destination: '/dest',
      mode: 'copy',
      totalSessions: 2,
      successCount: 2,
      failureCount: 0,
      results: [],
      dryRun: false,
    });

    const program = createProgram();
    registerMigrateCommand(program);
    await program.parseAsync(['node', 'test', 'migrate', '/source', '/dest', '--copy']);

    expect(mockMigrateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'copy',
      })
    );
  });

  it('migrates with --dry-run flag', async () => {
    mockMigrateWorkspace.mockResolvedValue({
      success: true,
      source: '/source',
      destination: '/dest',
      mode: 'move',
      totalSessions: 2,
      successCount: 2,
      failureCount: 0,
      results: [],
      dryRun: true,
    });

    const program = createProgram();
    registerMigrateCommand(program);
    await program.parseAsync(['node', 'test', 'migrate', '/source', '/dest', '--dry-run']);

    expect(mockMigrateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
      })
    );
    // Should show dry run indicator
    const allOutput = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allOutput).toContain('Dry run');
  });

  it('outputs JSON with --json flag', async () => {
    mockMigrateWorkspace.mockResolvedValue({
      success: true,
      source: '/source',
      destination: '/dest',
      mode: 'move',
      totalSessions: 1,
      successCount: 1,
      failureCount: 0,
      results: [],
      dryRun: false,
    });

    const program = createProgram();
    registerMigrateCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'migrate', '/source', '/dest']);

    const output = consoleSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.totalSessions).toBe(1);
  });

  it('exits with error code when migration has failures', async () => {
    mockMigrateWorkspace.mockResolvedValue({
      success: false,
      source: '/source',
      destination: '/dest',
      mode: 'move',
      totalSessions: 2,
      successCount: 1,
      failureCount: 1,
      results: [
        {
          success: true,
          sessionId: 's1',
          sourceWorkspace: '/source',
          destinationWorkspace: '/dest',
          mode: 'move',
          dryRun: false,
        },
        {
          success: false,
          sessionId: 's2-long-id-here',
          sourceWorkspace: '/source',
          destinationWorkspace: '/dest',
          mode: 'move',
          error: 'DB error',
          dryRun: false,
        },
      ],
      dryRun: false,
    });

    const program = createProgram();
    registerMigrateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'migrate', '/source', '/dest'])
    ).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error and message on thrown error', async () => {
    mockMigrateWorkspace.mockRejectedValue(new Error('Something went wrong'));

    const program = createProgram();
    registerMigrateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'migrate', '/source', '/dest'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('outputs JSON error on thrown error with --json', async () => {
    mockMigrateWorkspace.mockRejectedValue(new Error('DB locked'));
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    const program = createProgram();
    registerMigrateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', '--json', 'migrate', '/source', '/dest'])
    ).rejects.toThrow('process.exit');

    expect(consoleSpy).not.toHaveBeenCalled();
    const output = String(stderr.mock.calls[0]![0]);
    const parsed = JSON.parse(output);
    expect(parsed.error).toBeDefined();
  });

  it('uses --force flag', async () => {
    mockMigrateWorkspace.mockResolvedValue({
      success: true,
      source: '/source',
      destination: '/dest',
      mode: 'move',
      totalSessions: 1,
      successCount: 1,
      failureCount: 0,
      results: [],
      dryRun: false,
    });

    const program = createProgram();
    registerMigrateCommand(program);
    await program.parseAsync(['node', 'test', 'migrate', '/source', '/dest', '--force']);

    expect(mockMigrateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
      })
    );
  });

  it('expands a literal home-relative custom data path before migration resolution', async () => {
    mockExpandPath.mockImplementation((path: string) =>
      path === '~/Cursor/User/workspaceStorage' ? '/home/test/Cursor/User/workspaceStorage' : path
    );
    mockMigrateWorkspace.mockResolvedValue({
      success: true,
      source: '/source',
      destination: '/dest',
      mode: 'move',
      totalSessions: 0,
      successCount: 0,
      failureCount: 0,
      results: [],
      dryRun: true,
    });

    const program = createProgram();
    registerMigrateCommand(program);
    await program.parseAsync([
      'node',
      'test',
      '--data-path',
      '~/Cursor/User/workspaceStorage',
      'migrate',
      '/source',
      '/dest',
      '--dry-run',
    ]);

    expect(mockMigrateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ dataPath: '/home/test/Cursor/User/workspaceStorage' })
    );
  });
});

// ==================== MIGRATE-SESSION COMMAND ====================

describe('migrate-session command', () => {
  function successfulResult(sessionId: string, dryRun: boolean) {
    return {
      success: true,
      sessionId,
      sourceWorkspace: '/workspace/a',
      destinationWorkspace: '/workspace/destination',
      mode: 'move' as const,
      dryRun,
      pathsWillBeUpdated: true,
    };
  }

  it('propagates the parent workspace while resolving both numeric and direct-ID selectors', async () => {
    mockMigrateSessions.mockImplementation(
      async (options: { selectors: string[]; dryRun: boolean }) =>
        options.selectors.map((id) => successfulResult(id, options.dryRun))
    );

    for (const selector of ['1', 'session-a']) {
      const program = createProgram();
      registerMigrateSessionCommand(program);
      await program.parseAsync([
        'node',
        'test',
        '--workspace',
        '/workspace/a',
        'migrate-session',
        selector,
        '/workspace/destination',
        '--dry-run',
      ]);
    }

    expect(mockMigrateSessions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        selectors: ['1'],
        workspacePath: '/workspace/a',
        dryRun: true,
      })
    );
    expect(mockMigrateSessions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        selectors: ['session-a'],
        workspacePath: '/workspace/a',
        dryRun: true,
      })
    );
  });

  it('uses the identical scoped target for dry-run and apply', async () => {
    mockMigrateSessions.mockImplementation(
      async (options: { selectors: string[]; dryRun: boolean }) =>
        options.selectors.map((id) => successfulResult(id, options.dryRun))
    );

    const dryRunProgram = createProgram();
    registerMigrateSessionCommand(dryRunProgram);
    await dryRunProgram.parseAsync([
      'node',
      'test',
      '--workspace',
      '/workspace/a',
      'migrate-session',
      '1',
      '/workspace/destination',
      '--dry-run',
    ]);

    const applyProgram = createProgram();
    registerMigrateSessionCommand(applyProgram);
    await applyProgram.parseAsync([
      'node',
      'test',
      '--workspace',
      '/workspace/a',
      'migrate-session',
      '1',
      '/workspace/destination',
    ]);

    const dryRunOptions = mockMigrateSessions.mock.calls[0]?.[0] as {
      selectors: string[];
      workspacePath: string;
      dryRun: boolean;
    };
    const applyOptions = mockMigrateSessions.mock.calls[1]?.[0] as {
      selectors: string[];
      workspacePath: string;
      dryRun: boolean;
    };
    expect(dryRunOptions).toMatchObject({
      selectors: ['1'],
      workspacePath: '/workspace/a',
      dryRun: true,
    });
    expect(applyOptions).toMatchObject({
      selectors: ['1'],
      workspacePath: '/workspace/a',
      dryRun: false,
    });
    expect(applyOptions.selectors).toEqual(dryRunOptions.selectors);
    expect(applyOptions.workspacePath).toBe(dryRunOptions.workspacePath);
  });

  it('expands a literal home-relative custom data path before binding selectors', async () => {
    mockExpandPath.mockImplementation((path: string) =>
      path === '~/Cursor/User/workspaceStorage' ? '/home/test/Cursor/User/workspaceStorage' : path
    );
    mockMigrateSessions.mockResolvedValue([successfulResult('1', true)]);

    const program = createProgram();
    registerMigrateSessionCommand(program);
    await program.parseAsync([
      'node',
      'test',
      '--data-path',
      '~/Cursor/User/workspaceStorage',
      'migrate-session',
      '1',
      '/workspace/destination',
      '--dry-run',
    ]);

    expect(mockMigrateSessions).toHaveBeenCalledWith(
      expect.objectContaining({ dataPath: '/home/test/Cursor/User/workspaceStorage' })
    );
  });

  it('prints an ordinary migration failure result before exiting with partial-failure status', async () => {
    mockMigrateSessions.mockResolvedValue([
      {
        success: false,
        sessionId: 'session-a',
        sourceWorkspace: '/workspace/a',
        destinationWorkspace: '/workspace/destination',
        mode: 'move',
        error: 'synthetic destination write failure',
        dryRun: false,
      },
    ]);

    const program = createProgram();
    registerMigrateSessionCommand(program);
    await expect(
      program.parseAsync([
        'node',
        'test',
        '--workspace',
        '/workspace/a',
        'migrate-session',
        'session-a',
        '/workspace/destination',
      ])
    ).rejects.toThrow('process.exit');

    expect(mockMigrateSessions).toHaveBeenCalledOnce();
    expect(
      consoleSpy.mock.calls.some(([value]) => String(value).includes('Failed to migrate'))
    ).toBe(true);
    expect(
      consoleSpy.mock.calls.some(([value]) =>
        String(value).includes('synthetic destination write failure')
      )
    ).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ==================== BACKUP COMMAND ====================

describe('backup command', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('creates backup with default options', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backupPath: '/backups/test.zip',
      durationMs: 500,
      manifest: {
        stats: { sessionCount: 10, workspaceCount: 3, totalSize: 5000 },
        files: [{ path: 'db1' }, { path: 'db2' }],
      },
    });

    const program = createProgram();
    registerBackupCommand(program);
    await program.parseAsync(['node', 'test', 'backup']);

    expect(mockCreateBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        force: false,
      })
    );
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('creates backup with --output option', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backupPath: '/custom/backup.zip',
      durationMs: 300,
      manifest: {
        stats: { sessionCount: 5, workspaceCount: 1, totalSize: 2000 },
        files: [],
      },
    });

    const program = createProgram();
    registerBackupCommand(program);
    await program.parseAsync(['node', 'test', 'backup', '-o', '/custom/backup.zip']);

    expect(mockCreateBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: '/custom/backup.zip',
      })
    );
  });

  it('creates backup with --force option', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backupPath: '/backups/test.zip',
      durationMs: 500,
      manifest: {
        stats: { sessionCount: 10, workspaceCount: 3, totalSize: 5000 },
        files: [],
      },
    });

    const program = createProgram();
    registerBackupCommand(program);
    await program.parseAsync(['node', 'test', 'backup', '--force']);

    expect(mockCreateBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
      })
    );
  });

  it('forwards explicit shared permissions and the immutable source-limit override', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backupPath: '/backups/test.zip',
      durationMs: 500,
      manifest: {
        stats: { sessionCount: 10, workspaceCount: 3, totalSize: 5000 },
        files: [],
      },
    });
    const sourceReadLimits = Object.freeze({ zipEntryBytes: 1024 });

    const program = createProgram();
    program.setOptionValue('sourceLimit', sourceReadLimits);
    registerBackupCommand(program);
    await program.parseAsync(['node', 'test', 'backup', '--shared']);

    expect(mockCreateBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedPermissions: true,
        sourceReadLimits,
      })
    );
  });

  it('outputs JSON with --json flag', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backupPath: '/backups/test.zip',
      durationMs: 500,
      manifest: {
        stats: { sessionCount: 10, workspaceCount: 3, totalSize: 5000 },
        files: [],
      },
    });

    const program = createProgram();
    registerBackupCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'backup']);

    const output = consoleSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.backupPath).toBe('/backups/test.zip');
  });

  it('exits when no data found', async () => {
    mockCreateBackup.mockResolvedValue({
      success: false,
      backupPath: '',
      durationMs: 0,
      error: 'No Cursor data found',
      manifest: { stats: {}, files: [] },
    });

    const program = createProgram();
    registerBackupCommand(program);

    await expect(program.parseAsync(['node', 'test', 'backup'])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('exits when file already exists', async () => {
    mockCreateBackup.mockResolvedValue({
      success: false,
      backupPath: '/backups/existing.zip',
      durationMs: 0,
      error: 'File already exists',
      manifest: { stats: {}, files: [] },
    });

    const program = createProgram();
    registerBackupCommand(program);

    await expect(program.parseAsync(['node', 'test', 'backup'])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('exits when insufficient disk space', async () => {
    mockCreateBackup.mockResolvedValue({
      success: false,
      backupPath: '',
      durationMs: 0,
      error: 'Insufficient disk space',
      manifest: { stats: {}, files: [] },
    });

    const program = createProgram();
    registerBackupCommand(program);

    await expect(program.parseAsync(['node', 'test', 'backup'])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('handles generic failure', async () => {
    mockCreateBackup.mockResolvedValue({
      success: false,
      backupPath: '',
      durationMs: 0,
      error: 'Unknown error',
      manifest: { stats: {}, files: [] },
    });

    const program = createProgram();
    registerBackupCommand(program);

    await expect(program.parseAsync(['node', 'test', 'backup'])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('handles thrown error', async () => {
    mockCreateBackup.mockRejectedValue(new Error('Unexpected error'));

    const program = createProgram();
    registerBackupCommand(program);

    await expect(program.parseAsync(['node', 'test', 'backup'])).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('reports a safely published archive permission failure and exits with I/O status', async () => {
    mockCreateBackup.mockRejectedValue(
      new BackupPublishedPermissionError('/backups/published.zip', 0o640, 0o600)
    );

    const program = createProgram();
    registerBackupCommand(program);

    await expect(program.parseAsync(['node', 'test', 'backup'])).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(4);
    const output = consoleErrorSpy.mock.calls.map(([value]) => String(value)).join('\n');
    expect(output).toContain('Backup archive was published at /backups/published.zip');
    expect(output).toContain('requested 0o640, actual 0o600');
    expect(output).toContain('Do not retry with --force');
  });
});

// ==================== RESTORE COMMAND ====================

describe('restore command source-read options', () => {
  it('uses one source-limit override for validation and restore', async () => {
    mockExistsSync.mockReturnValue(true);
    mockValidateBackup.mockResolvedValue({
      status: 'valid',
      validFiles: [],
      corruptedFiles: [],
      missingFiles: [],
      errors: [],
      manifest: { files: [] },
    });
    mockRestoreBackup.mockResolvedValue({
      success: true,
      targetPath: '/target',
      filesRestored: 0,
      warnings: [],
      durationMs: 1,
    });
    const sourceReadLimits = Object.freeze({ zipEntryCount: 17 });

    const program = createProgram();
    program.setOptionValue('sourceLimit', sourceReadLimits);
    registerRestoreCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'restore', '/backups/test.zip']);

    expect(mockValidateBackup).toHaveBeenCalledWith('/backups/test.zip', {
      sourceReadLimits,
    });
    expect(mockRestoreBackup).toHaveBeenCalledWith(expect.objectContaining({ sourceReadLimits }));
  });
});

describe('global Source Read Limits command contract', () => {
  const repeatedLimits = Object.freeze({
    sqliteRowCount: 6_000_000,
    jsonlRecordCount: 3_000_000,
  });

  it('propagates repeated different fields through list before session reads', async () => {
    mockListSessions.mockResolvedValue(makeSessions(1));
    const program = createProgram();
    registerListCommand(program);

    await program.parseAsync([
      'node',
      'test',
      '--source-limit',
      'sqliteRowCount=6000000',
      '--source-limit',
      'jsonlRecordCount=3000000',
      'list',
    ]);

    expect(mockListSessionSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ sourceReadLimits: repeatedLimits }),
      undefined,
      undefined,
      mockReadContext
    );
    const forwarded = mockListSessionSummaries.mock.calls[0]![0].sourceReadLimits;
    expect(Object.isFrozen(forwarded)).toBe(true);
  });

  it('binds the same immutable map into show lookup contexts', async () => {
    mockGetSession.mockResolvedValue(makeSession());
    const program = createProgram();
    program.setOptionValue('sourceLimit', repeatedLimits);
    registerShowCommand(program);

    await program.parseAsync(['node', 'test', 'show', '1']);

    expect(mockCreateSessionReadContext).toHaveBeenCalledWith(
      expect.objectContaining({ sourceReadLimits: repeatedLimits })
    );
    expect(mockGetSession).toHaveBeenCalledWith(1, undefined, undefined, mockReadContext);
    expect(mockDisposeReadContext).toHaveBeenCalledOnce();
  });

  it('propagates the immutable map through workspace migration', async () => {
    mockMigrateWorkspace.mockResolvedValue({
      success: true,
      source: '/source',
      destination: '/destination',
      mode: 'move',
      totalSessions: 0,
      successCount: 0,
      failureCount: 0,
      results: [],
      dryRun: false,
    });
    const program = createProgram();
    program.setOptionValue('sourceLimit', repeatedLimits);
    registerMigrateCommand(program);

    await program.parseAsync(['node', 'test', 'migrate', '/source', '/destination']);

    expect(mockMigrateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ sourceReadLimits: repeatedLimits })
    );
  });

  it('propagates the immutable map through scoped session migration', async () => {
    mockMigrateSessions.mockResolvedValue([]);
    const program = createProgram();
    program.setOptionValue('sourceLimit', repeatedLimits);
    registerMigrateSessionCommand(program);

    await program.parseAsync(['node', 'test', 'migrate-session', '1', '/destination']);

    expect(mockMigrateSessions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceReadLimits: repeatedLimits })
    );
  });

  const commandCases = [
    ['list', registerListCommand, ['list']],
    ['show', registerShowCommand, ['show', '1']],
    ['search', registerSearchCommand, ['search', 'needle']],
    ['export', registerExportCommand, ['export', '1', '--force', '-o', '/tmp/out.md']],
    ['migrate', registerMigrateCommand, ['migrate', '/source', '/destination']],
    ['migrate-session', registerMigrateSessionCommand, ['migrate-session', '1', '/destination']],
    ['backup', registerBackupCommand, ['backup']],
    ['restore', registerRestoreCommand, ['restore', '/tmp/backup.zip']],
    ['list-backups', registerListBackupsCommand, ['list-backups']],
  ] as const;

  it.each(commandCases)(
    'rejects an invalid cross-field policy before %s payload I/O',
    async (_name, register, args) => {
      const program = createProgram();
      program.setOptionValue('sourceLimit', {
        zipEntryBytes: 2_147_483_648,
        zipAggregateBytes: 1_073_741_824,
      });
      register(program);

      await expect(program.parseAsync(['node', 'test', ...args])).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(2);
      for (const payloadReader of [
        mockListSessions,
        mockGetSession,
        mockSearchSessions,
        mockMigrateWorkspace,
        mockMigrateSessions,
        mockCreateBackup,
        mockValidateBackup,
        mockRestoreBackup,
        mockListBackups,
      ]) {
        expect(payloadReader).not.toHaveBeenCalled();
      }
    }
  );
});
