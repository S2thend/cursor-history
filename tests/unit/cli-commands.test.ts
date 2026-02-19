/**
 * Tests for CLI command registration and execution (list, show, search).
 * Mocks all core dependencies and verifies command behavior via programmatic arg parsing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// --- Mock functions ---
const mockListSessions = vi.fn();
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
const mockFormatNoHistory = vi.fn(() => 'No history found');
const mockFormatCursorNotFound = vi.fn(() => 'Cursor not found');
const mockFilterMessages = vi.fn((messages: unknown[]) => messages);
const mockValidateMessageTypes = vi.fn(() => []);
const mockExistsSync = vi.fn(() => true);

vi.mock('../../src/core/storage.js', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  searchSessions: (...args: unknown[]) => mockSearchSessions(...args),
  listWorkspaces: (...args: unknown[]) => mockListWorkspaces(...args),
  findWorkspaces: (...args: unknown[]) => mockFindWorkspaces(...args),
}));

const mockListBackups = vi.fn();
const mockGetDefaultBackupDir = vi.fn(() => '/home/user/cursor-history-backups');
const mockCreateBackup = vi.fn();

vi.mock('../../src/core/backup.js', () => ({
  validateBackup: (...args: unknown[]) => mockValidateBackup(...args),
  createBackup: (...args: unknown[]) => mockCreateBackup(...args),
  restoreBackup: vi.fn(),
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
  formatNoHistory: (...args: unknown[]) => mockFormatNoHistory(...args),
  formatCursorNotFound: (...args: unknown[]) => mockFormatCursorNotFound(...args),
  formatExportSuccess: vi.fn(() => 'Export done'),
  formatExportResultJson: vi.fn(() => '{"exported":[]}'),
  filterMessages: (...args: unknown[]) => mockFilterMessages(...args),
  validateMessageTypes: (...args: unknown[]) => mockValidateMessageTypes(...args),
}));

vi.mock('../../src/lib/platform.js', () => ({
  expandPath: (p: string) => p,
  contractPath: (p: string) => p,
  getCursorDataPath: () => '/mock/cursor/data',
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
vi.mock('../../src/core/migrate.js', () => ({
  migrateWorkspace: (...args: unknown[]) => mockMigrateWorkspace(...args),
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
import { registerBackupCommand } from '../../src/cli/commands/backup.js';
import { writeFileSync } from 'node:fs';
import { createBackup } from '../../src/core/backup.js';

let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
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
  return program;
}

// --- Sample data factories ---
function makeSessions(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    title: `Session ${i + 1}`,
    createdAt: new Date('2025-01-01'),
    messageCount: 5,
    workspacePath: '/ws',
  }));
}

function makeSession(index = 1) {
  return {
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

    expect(mockListSessions).toHaveBeenCalledWith(
      { limit: 20, all: false, workspacePath: undefined },
      undefined,
      undefined
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

  it('lists sessions with --all flag (limit = 0)', async () => {
    mockListSessions.mockResolvedValue(makeSessions());

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list', '--all']);

    expect(mockListSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 0, all: true }),
      undefined,
      undefined
    );
  });

  it('lists sessions with custom limit', async () => {
    mockListSessions.mockResolvedValue(makeSessions());

    const program = createProgram();
    registerListCommand(program);
    await program.parseAsync(['node', 'test', 'list', '-n', '5']);

    expect(mockListSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
      undefined,
      undefined
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

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ count: 0, sessions: [] }));
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

    expect(mockListSessions).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/my/workspace' }),
      undefined,
      undefined
    );
  });
});

// ==================== SHOW COMMAND ====================

describe('show command', () => {
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

  it('exits with error for non-numeric index', async () => {
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
      undefined
    );
    expect(mockFormatSearchResultsTable).toHaveBeenCalledWith(results, 'hello');
    expect(consoleSpy).toHaveBeenCalledWith('search results');
  });

  it('searches with --json flag', async () => {
    mockSearchSessions.mockResolvedValue(makeSearchResults());

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'search', 'hello']);

    expect(mockFormatSearchResultsJson).toHaveBeenCalledWith(expect.any(Array), 'hello');
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
      undefined
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
  });

  it('handles no results in JSON mode with structured output', async () => {
    mockSearchSessions.mockResolvedValue([]);

    const program = createProgram();
    registerSearchCommand(program);
    await program.parseAsync(['node', 'test', '--json', 'search', 'nonexistent']);

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ query: 'nonexistent', count: 0, totalMatches: 0, results: [] })
    );
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
      undefined
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
      undefined
    );
  });
});

// ==================== EXPORT COMMAND ====================

describe('export command', () => {
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

    expect(mockListSessions).toHaveBeenCalledWith({ limit: 0, all: true }, undefined, undefined);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2);
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

    const program = createProgram();
    registerListBackupsCommand(program);

    await expect(program.parseAsync(['node', 'test', '--json', 'list-backups'])).rejects.toThrow(
      'process.exit'
    );

    const output = consoleSpy.mock.calls[0]![0] as string;
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

    expect(mockListBackups).toHaveBeenCalledWith('/custom/backups');
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

    const program = createProgram();
    registerMigrateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', '--json', 'migrate', '/source', '/dest'])
    ).rejects.toThrow('process.exit');

    const output = consoleSpy.mock.calls[0]![0] as string;
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
});

// ==================== BACKUP COMMAND ====================

describe('backup command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
});
