# cursor-history Development Guidelines

## Overview

CLI tool and library to browse, search, and export Cursor AI chat history. Built with TypeScript, commander, better-sqlite3, and picocolors.

**Dual Interface:**
- **CLI**: Command-line tool for interactive use (`cursor-history list`, `cursor-history show 1`)
- **Library**: Programmatic API for integration (`import { listSessions } from 'cursor-history'`)

## Quick Reference

```bash
# Build and run
npm run build && node dist/cli/index.js list

# Development
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # Lint code
npm run typecheck    # Type check
```

## Architecture

### Data Flow

1. **Workspace storage** (`workspaceStorage/*/state.vscdb`)
   - Contains session metadata with correct workspace paths
   - User messages stored in `ItemTable` under `composer.composerData`

2. **Global storage** (`globalStorage/state.vscdb`)
   - Contains full AI responses in `cursorDiskKV` table
   - Keys: `composerData:<id>` (metadata), `bubbleId:<composerId>:<bubbleId>` (messages)

3. **Bubble extraction priority** (for assistant messages):
   - Mark errors early: `toolFormerData.additionalData.status === 'error'` but continue extraction
   - `toolFormerData.result` → check for diff blocks (write/edit operations)
   - `toolFormerData.name` + `status: "completed"` → standard tool calls with params
   - `text` field → natural language explanation (check for JSON diff if starts with `{`)
   - `codeBlocks[].content` → code/mermaid artifacts (COMBINED with text, wrapped in ```lang fences)
   - `thinking.text` → reasoning blocks (marked as `[Thinking]`)
   - **Last resort**: Recursive walk through all fields to find longest string with markdown features (catches error messages)
   - If marked as error, prefix result with `[Error]` marker
   - All extractions include timestamps for display

### Project Structure

```
src/
├── cli/
│   ├── commands/          # list, show, search, export, migrate, migrate-session
│   ├── formatters/        # table.ts (terminal), json.ts
│   ├── errors.ts          # CLI-specific errors (CliError, SessionNotFoundError)
│   └── index.ts           # CLI entry, global options
├── core/
│   ├── storage.ts         # findWorkspaces, listSessions, getSession, extractBubbleText
│   ├── migrate.ts         # migrateSession, migrateWorkspace, copyBubbleDataInGlobalStorage
│   ├── parser.ts          # parseChatData, exportToMarkdown, exportToJson
│   └── types.ts           # ChatSession, Message, Workspace, ToolCall, MigrationMode, etc.
└── lib/
    ├── index.ts           # Library entry point (listSessions, getSession, searchSessions, export*, migrate*)
    ├── types.ts           # Public library types (Session, Message, SearchResult, MigrateSessionConfig, etc.)
    ├── config.ts          # Configuration validation and merging
    ├── errors.ts          # Library errors (DatabaseLockedError, SessionNotFoundError, WorkspaceNotFoundError, etc.)
    ├── utils.ts           # Utility functions (getDefaultDataPath)
    └── platform.ts        # getCursorDataPath, expandPath, contractPath, normalizePath, pathsEqual
```

### Architecture: Shared Core

Both CLI and Library share the same core logic:

```
┌─────────────────────────────────────────────────────────────┐
│                      src/core/                              │
│  storage.ts (DB queries)  +  parser.ts (data parsing)       │
│                    ↑               ↑                        │
└────────────────────┼───────────────┼────────────────────────┘
                     │               │
        ┌────────────┴───────────────┴────────────┐
        │                                         │
        ▼                                         ▼
┌───────────────────┐                 ┌───────────────────────┐
│   src/cli/        │                 │   src/lib/            │
│   commands/       │                 │   index.ts            │
│   (CLI interface) │                 │   (Library API)       │
└───────────────────┘                 └───────────────────────┘
```

**Both share:**
- `src/core/storage.ts` - `listSessions()`, `getSession()`, `searchSessions()`, `findWorkspaceForSession()`, `findWorkspaceByPath()`
- `src/core/migrate.ts` - `migrateSession()`, `migrateWorkspace()`, `copyBubbleDataInGlobalStorage()`
- `src/core/parser.ts` - `exportToJson()`, `exportToMarkdown()`

**The library adds:**
- Type conversions (core types → library types)
- Config validation and merging
- Custom error classes
- Pagination wrapper (`PaginatedResult<T>`)
- Zero-based indexing (core uses 1-based)

So when someone uses `import { listSessions } from 'cursor-history'`, they're calling the same underlying database queries as `cursor-history list` CLI command.

## Key Implementation Details

### Storage Layer (`src/core/storage.ts`)

- `listSessions()` - Uses workspace storage for listing (correct paths)
- `getSession()` - Tries global storage first (full AI responses), falls back to workspace
- `findWorkspaceForSession(sessionId)` - Finds which workspace contains a session by ID
- `findWorkspaceByPath(path)` - Finds workspace by its project path
- `getComposerData(db)` - Reads composer array, handles both `allComposers` and legacy formats
- `updateComposerData(db, composers)` - Writes composer array, preserves original format
- `resolveSessionIdentifiers(input)` - Converts index/ID/comma-separated to session ID array
- `extractBubbleText()` - Extracts text from bubble with priority order (all based on DB fields, not pattern matching)
- `extractThinkingText()` - Extracts from `data.thinking.text` DB field
- `formatToolCallWithResult()` - Parses `toolFormerData.result` for diff blocks
- `formatToolCall()` - Formats tool calls with parameters using `getParam()` helper
- `formatDiffBlock()` - Formats diff chunks with ```diff markdown fencing
- `getParam()` - Helper that tries multiple field name variations for tool parameters

### Migration Layer (`src/core/migrate.ts`)

- `migrateSession(sessionId, options)` - Core primitive: move/copy single session between workspaces
- `migrateSessions(options)` - Batch migration with partial failure handling
- `migrateWorkspace(options)` - Convenience wrapper: migrate all sessions from source workspace
- `copyBubbleDataInGlobalStorage(oldId, newId)` - Deep copy bubble data for copy mode (prevents data loss when deleting copies)
- `generateSessionId()` - Creates new UUID v4 for copied sessions

**Migration modes:**
- `move` - Removes session from source, adds to destination (like `mv`)
- `copy` - Duplicates session with new ID, both remain independent (like `cp`)

**All special message detection is DB-field based:**
- Errors: `toolFormerData.additionalData.status === 'error'`
- Tool calls: `toolFormerData.name` exists (any status: completed, cancelled, error)
- Thinking: `data.thinking.text`
- Code blocks: `data.codeBlocks` array

**Tool call formatting:**
- Shows tool name, file paths, parameters regardless of completion status
- Adds `Status: ❌ cancelled/error` line for failed operations
- Supports `write` tool name and `relativeWorkspacePath` parameter

### Bubble Types

- `type: 1` → user message
- `type: 2` → assistant message

### Tool Call Format

Tool calls are stored in `toolFormerData`:
```typescript
{
  name: "read_file" | "list_dir" | "run_terminal_command" | "write" | "edit_file" | "search_replace" | "grep" | ...
  params: '{"targetFile": "/path/to/file"}' | '{"relativeWorkspacePath": "..."}'
  rawArgs: '...' // alternative to params
  result: '{"contents": "..."}' | '{"diff": {"chunks": [{"diffString": "..."}]}, "resultForModel": "..."}'
  status: "completed"
}
```

**Write/Edit operations** store diff in both:
- `text` field as JSON: `{"diff":{"chunks":[{"diffString":"..."}],"editor":"EDITOR_AI"}}`
- `toolFormerData.result` as JSON with same structure

**Tool parameter field name variations** (handled by `getParam()`):
- File paths: `targetFile`, `path`, `file`, `filePath`, `relativeWorkspacePath`
- Search patterns: `pattern`, `query`, `searchQuery`, `regex`
- Directories: `targetDirectory`, `path`, `directory`
- Commands: `command`, `cmd`
- Edit strings: `oldString`, `old_string`, `search`, `searchString`, `newString`, `new_string`, `replace`, `replaceString`
- Content: `content`, `fileContent`, `text`

### Display Formatters (`src/cli/formatters/table.ts`)

- `formatSessionDetail(session, workspacePath, options)` - Shows full session with display options
  - **Message folding**: Consecutive duplicate messages (same role and content) are folded into a single display with multiple timestamps and a repeat count indicator (×N)
  - `options.short` - Truncates user/assistant messages to 300 chars
  - `options.fullThinking` - Shows full thinking text (not truncated to 200 chars)
  - `options.fullRead` - Shows full file read content (not truncated to 100 chars)
  - `options.fullError` - Shows full error messages (not truncated to 300 chars)
- `formatTime()` - Formats timestamps as HH:MM:SS
- `formatToolCallDisplay(content, fullRead)` - Formats tool calls with optional full read content
- `formatThinkingDisplay(content, fullThinking)` - Formats thinking blocks with optional full text
- `formatErrorDisplay(content, fullError)` - Formats error messages with red text and ❌ emoji
- Role labels with timestamps: `You: HH:MM:SS`, `Assistant: HH:MM:SS`, `Tool: HH:MM:SS`, `Thinking: HH:MM:SS`, `Error: HH:MM:SS`
- For duplicates: `You: 02:48:01 PM, 02:48:04 PM, 02:48:54 PM (×3)` (yellow highlight on repeat count)

**Display layer detects markers from storage layer:**
- `isToolCall()` - checks for `[Tool:` marker
- `isError()` - checks for `[Error]` marker
- `isThinking()` - checks for `[Thinking]` marker
- All markers are set by storage layer based on DB fields

## Library API (`src/lib/`)

### Functions

| Function | Description |
|----------|-------------|
| `listSessions(config?)` | List sessions with pagination, returns `PaginatedResult<Session>` |
| `getSession(index, config?)` | Get full session by zero-based index |
| `searchSessions(query, config?)` | Search across sessions, returns `SearchResult[]` |
| `exportSessionToJson(index, config?)` | Export single session to JSON string |
| `exportSessionToMarkdown(index, config?)` | Export single session to Markdown string |
| `exportAllSessionsToJson(config?)` | Export all sessions to JSON array string |
| `exportAllSessionsToMarkdown(config?)` | Export all sessions to Markdown string |
| `migrateSession(config)` | Move/copy sessions to another workspace |
| `migrateWorkspace(config)` | Move/copy all sessions between workspaces |
| `getDefaultDataPath()` | Get platform-specific Cursor data path |

### Configuration (`LibraryConfig`)

```typescript
interface LibraryConfig {
  dataPath?: string;    // Custom Cursor data path
  workspace?: string;   // Filter by workspace path
  limit?: number;       // Pagination limit
  offset?: number;      // Pagination offset
  context?: number;     // Search context lines
}
```

### Error Handling

```typescript
import { listSessions, isDatabaseLockedError, isDatabaseNotFoundError } from 'cursor-history';

try {
  const result = listSessions();
} catch (err) {
  if (isDatabaseLockedError(err)) {
    console.error('Close Cursor and retry');
  } else if (isDatabaseNotFoundError(err)) {
    console.error('Cursor not installed or no history');
  }
}
```

### Key Differences from CLI

- **Zero-based indexing**: Library uses `getSession(0)`, CLI uses `show 1`
- **Structured data**: Library returns typed objects, CLI formats for display
- **Stateless**: Each function call opens/closes DB connection
- **No formatting**: Library returns raw data, no colors or truncation

## CLI Commands

| Command | Description |
|---------|-------------|
| `list` | List sessions (--all, --ids, --workspaces, -n) |
| `show <index>` | Show session details (-s/--short, -t/--think, -f/--fullread, -e/--error) |
| `search <query>` | Search across sessions (-n, --context) |
| `export [index]` | Export to md/json (--all, -o, -f, --force) |
| `migrate-session <session> <dest>` | Move/copy session(s) to workspace (--copy, --dry-run, -f, --debug) |
| `migrate <source> <dest>` | Move/copy all sessions between workspaces (--copy, --dry-run, -f, --debug) |

### Show Command Options

- `-s, --short` - Truncate user and assistant messages to 300 characters
- `-t, --think` - Show full AI thinking/reasoning text (default: 200 char preview)
- `-f, --fullread` - Show full file read content (default: 100 char preview)
- `-e, --error` - Show full error messages (default: 300 char preview)

### Migration Command Options

- `--copy` - Copy sessions instead of moving (keeps originals)
- `--dry-run` - Preview migration without making changes
- `-f, --force` - Proceed even if destination has existing sessions
- `--debug` - Show detailed path transformation logs to stderr (useful for troubleshooting)

### Global Options

- `--json` - Output as JSON
- `--data-path <path>` - Custom Cursor data path
- `--workspace <path>` - Filter by workspace

## Code Style

- TypeScript strict mode
- ESLint + Prettier
- Prefer existing file edits over creating new files
- Use picocolors for terminal output, not chalk
- Handle errors with `CliError` and exit codes

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

## Common Tasks

### Adding a new command

1. Create `src/cli/commands/mycommand.ts`
2. Export `registerMyCommand(program: Command)`
3. Import and register in `src/cli/index.ts`

### Modifying bubble extraction

Edit `extractBubbleText()` in `src/core/storage.ts`. Priority matters:
- For assistant: toolFormerData.result (diff check) → toolFormerData.name (tool call) → text (with diff check) → text + codeBlocks (combined) → thinking.text → codeBlocks alone
- Combine text + codeBlocks, don't choose one
- Wrap code blocks in markdown fences with language ID

### Adding new output format

1. Add formatter in `src/cli/formatters/`
2. Export from `src/cli/formatters/index.ts`
3. Use in command with `--format` option

## Active Technologies
- TypeScript 5.9+ (strict mode enabled)
- better-sqlite3 for SQLite database access (read-only for queries, read-write for migrations)
- commander + picocolors for CLI (not used in library)
- Dual ESM/CommonJS module support
- SQLite databases (state.vscdb files) + zip archives (004-full-backup)
- TypeScript 5.0+ (strict mode enabled) + better-sqlite3, commander, picocolors (005-fix-migration-paths)
- SQLite (globalStorage/state.vscdb, workspaceStorage/*/state.vscdb) (005-fix-migration-paths)

## Recent Changes
- 005-fix-migration-paths: Fixed file path references in migrated sessions
  - File paths in bubble data are now updated during migration (move/copy)
  - Path fields updated: `toolFormerData.params.{relativeWorkspacePath,targetFile,filePath,path}`, `codeBlocks[].uri.{path,_formatted,_fsPath}`
  - External paths (outside source workspace) are silently preserved
  - Nested path detection prevents infinite replacement loops
  - New `--debug` flag shows detailed path transformation logs to stderr
  - Dry run now indicates "File paths will be updated to destination workspace"
  - New error: `NestedPathError` for detecting problematic path configurations

- 003-migrate-workspace: Added session migration feature
  - `src/core/migrate.ts` - Core migration logic (move/copy sessions between workspaces)
  - `src/cli/commands/migrate-session.ts` - Single/multiple session migration command
  - `src/cli/commands/migrate.ts` - Workspace-level migration command
  - Copy mode creates fully independent copies (no shared bubble data)
  - Handles both `allComposers` format and legacy array format
  - Library API: `migrateSession()`, `migrateWorkspace()`
  - New errors: `SessionNotFoundError`, `WorkspaceNotFoundError`, `SameWorkspaceError`, etc.

- 002-library-api: Added library API for programmatic access
  - `src/lib/index.ts` - Main entry point with all public functions
  - `src/lib/types.ts` - Public TypeScript types (Session, Message, etc.)
  - `src/lib/errors.ts` - Custom errors (DatabaseLockedError, etc.)
  - `src/lib/config.ts` - Configuration validation
  - CLI and library share `src/core/` for database access
  - Zero-based indexing in library (vs 1-based in CLI)
  - Stateless design: each call opens/closes DB connection
