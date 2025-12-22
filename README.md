# cursor-history

CLI tool to browse, search, and export your Cursor AI chat history.

## Features

- **List sessions** - View all chat sessions across workspaces
- **View full conversations** - See complete chat history with:
  - AI responses with natural language explanations
  - **Full diff display** for file edits and writes with syntax highlighting
  - **Detailed tool calls** showing all parameters (file paths, search patterns, commands, etc.)
  - AI reasoning and thinking blocks
  - Message timestamps
- **Search** - Find conversations by keyword with highlighted matches
- **Export** - Save sessions as Markdown or JSON files
- **Cross-platform** - Works on macOS, Windows, and Linux

## Installation

```bash
# Clone and build
git clone https://github.com/your-username/cursor-history.git
cd cursor-history
npm install
npm run build

# Run directly
node dist/cli/index.js list

# Or link globally
npm link
cursor-history list
```

## Requirements

- Node.js 20+
- Cursor IDE (with existing chat history)

## Usage

### List Sessions

```bash
# List recent sessions (default: 20)
cursor-history list

# List all sessions
cursor-history list --all

# List with composer IDs (for external tools)
cursor-history list --ids

# Limit results
cursor-history list -n 10

# List workspaces only
cursor-history list --workspaces
```

### View a Session

```bash
# Show session by index number
cursor-history show 1

# Show with truncated messages (for quick overview)
cursor-history show 1 --short

# Show full AI thinking/reasoning text
cursor-history show 1 --think

# Show full file read content (not truncated)
cursor-history show 1 --fullread

# Show full error messages (not truncated to 300 chars)
cursor-history show 1 --error

# Combine options
cursor-history show 1 --short --think --fullread --error

# Output as JSON
cursor-history show 1 --json
```

### Search

```bash
# Search for keyword
cursor-history search "react hooks"

# Limit results
cursor-history search "api" -n 5

# Adjust context around matches
cursor-history search "error" --context 100
```

### Export

```bash
# Export single session to Markdown
cursor-history export 1

# Export to specific file
cursor-history export 1 -o ./my-chat.md

# Export as JSON
cursor-history export 1 --format json

# Export all sessions to directory
cursor-history export --all -o ./exports/

# Overwrite existing files
cursor-history export 1 --force
```

### Global Options

```bash
# Output as JSON (works with all commands)
cursor-history --json list

# Use custom Cursor data path
cursor-history --data-path ~/.cursor-alt list

# Filter by workspace
cursor-history --workspace /path/to/project list
```

## What You Can View

When browsing your chat history, you'll see:

- **Complete conversations** - All messages exchanged with Cursor AI
- **Duplicate message folding** - Consecutive identical messages are folded into one display with multiple timestamps and repeat count (e.g., "02:48:01 PM, 02:48:04 PM, 02:48:54 PM (×3)")
- **Timestamps** - Exact time each message was sent (HH:MM:SS format)
- **AI tool actions** - Detailed view of what Cursor AI did:
  - **File edits/writes** - Full diff display with syntax highlighting showing exactly what changed
  - **File reads** - File paths and content previews (use `--fullread` for complete content)
  - **Search operations** - Patterns, paths, and search queries used
  - **Terminal commands** - Complete command text
  - **Directory listings** - Paths explored
  - **Tool errors** - Failed/cancelled operations shown with ❌ status indicator and parameters
  - **User decisions** - Shows if you accepted (✓), rejected (✗), or pending (⏳) on tool operations
  - **Errors** - Error messages with ❌ emoji highlighting (extracted from `toolFormerData.additionalData.status`)
- **AI reasoning** - See the AI's thinking process behind decisions (use `--think` for full text)
- **Code artifacts** - Mermaid diagrams, code blocks, with syntax highlighting
- **Natural language explanations** - AI explanations combined with code for full context

### Display Options

- **Default view** - Full messages with truncated thinking (200 chars), file reads (100 chars), and errors (300 chars)
- **`--short` mode** - Truncates user and assistant messages to 300 chars for quick scanning
- **`--think` flag** - Shows complete AI reasoning/thinking text (not truncated)
- **`--fullread` flag** - Shows full file read content instead of previews
- **`--error` flag** - Shows full error messages instead of 300-char preview

## Where Cursor Stores Data

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |
| Linux | `~/.config/Cursor/User/` |

The tool automatically finds and reads your Cursor chat history from these locations.