# cursor-history Development Guidelines

## Overview

CLI tool to browse, search, and export Cursor AI chat history. Built with TypeScript, commander, better-sqlite3, and picocolors.

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
│   ├── commands/          # list, show, search, export
│   ├── formatters/        # table.ts (terminal), json.ts
│   └── index.ts           # CLI entry, global options
├── core/
│   ├── storage.ts         # findWorkspaces, listSessions, getSession, extractBubbleText
│   ├── parser.ts          # parseChatData, exportToMarkdown, exportToJson
│   └── types.ts           # ChatSession, Message, Workspace, etc.
└── lib/
    ├── platform.ts        # getCursorDataPath, expandPath, contractPath
    └── errors.ts          # CliError, SessionNotFoundError, handleError
```

## Key Implementation Details

### Storage Layer (`src/core/storage.ts`)

- `listSessions()` - Uses workspace storage for listing (correct paths)
- `getSession()` - Tries global storage first (full AI responses), falls back to workspace
- `extractBubbleText()` - Extracts text from bubble with priority order (all based on DB fields, not pattern matching)
- `extractThinkingText()` - Extracts from `data.thinking.text` DB field
- `formatToolCallWithResult()` - Parses `toolFormerData.result` for diff blocks
- `formatToolCall()` - Formats tool calls with parameters using `getParam()` helper
- `formatDiffBlock()` - Formats diff chunks with ```diff markdown fencing
- `getParam()` - Helper that tries multiple field name variations for tool parameters

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

## CLI Commands

| Command | Description |
|---------|-------------|
| `list` | List sessions (--all, --ids, --workspaces, -n) |
| `show <index>` | Show session details (-s/--short, -t/--think, -f/--fullread, -e/--error) |
| `search <query>` | Search across sessions (-n, --context) |
| `export [index]` | Export to md/json (--all, -o, -f, --force) |

### Show Command Options

- `-s, --short` - Truncate user and assistant messages to 300 characters
- `-t, --think` - Show full AI thinking/reasoning text (default: 200 char preview)
- `-f, --fullread` - Show full file read content (default: 100 char preview)
- `-e, --error` - Show full error messages (default: 300 char preview)

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
