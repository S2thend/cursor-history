# CLI Interface Contract: cursor-history

**Date**: 2025-12-18
**Branch**: 001-chat-history-cli

## Overview

This document defines the command-line interface contract for the `cursor-history` tool.
All commands use a flag-based invocation pattern as specified in the clarifications.

---

## Global Options

These options apply to all commands:

| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--help` | `-h` | boolean | - | Show help message |
| `--version` | `-v` | boolean | - | Show version number |
| `--json` | `-j` | boolean | false | Output as JSON instead of human-readable |
| `--data-path` | - | string | auto | Override Cursor data directory |
| `--workspace` | `-w` | string | cwd | Filter by workspace path |

**Environment Variables**:
- `CURSOR_DATA_PATH`: Override default Cursor data directory (flag takes precedence)

**Exit Codes**:
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Data not found (no Cursor installation or empty history) |
| 4 | Parse error (corrupted or unknown format) |

---

## Commands

### --list

List chat sessions.

**Usage**:
```
cursor-history --list [options]
```

**Options**:
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--limit` | `-n` | number | 20 | Maximum sessions to show |
| `--all` | `-a` | boolean | false | Show all sessions (override limit) |
| `--workspaces` | - | boolean | false | List workspaces instead of sessions |

**Human Output** (default):
```
# Chat History (showing 20 of 47)

 #  | Date       | Workspace              | Preview
----|------------|------------------------|----------------------------------
 1  | 2025-12-18 | ~/projects/my-app      | How do I implement auth...
 2  | 2025-12-17 | ~/projects/my-app      | Fix the TypeScript error in...
 3  | 2025-12-17 | ~/projects/other       | What's the best way to...
...
```

**JSON Output** (`--json`):
```json
{
  "total": 47,
  "showing": 20,
  "sessions": [
    {
      "index": 1,
      "id": "abc123-def456",
      "title": null,
      "createdAt": "2025-12-18T10:30:00Z",
      "lastUpdatedAt": "2025-12-18T11:45:00Z",
      "messageCount": 12,
      "workspaceId": "a1b2c3",
      "workspacePath": "/Users/dev/projects/my-app",
      "preview": "How do I implement auth..."
    }
  ]
}
```

**--workspaces Output**:
```
# Workspaces with Chat History

 #  | Sessions | Path
----|----------|----------------------------------
 1  |       23 | ~/projects/my-app
 2  |       15 | ~/projects/other
 3  |        9 | ~/work/client-project
```

---

### --show

Show full content of a chat session.

**Usage**:
```
cursor-history --show <index> [options]
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `<index>` | number | yes | Session index from --list output |

**Options**:
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--full` | `-f` | boolean | false | Show complete content (no truncation) |

**Human Output** (default):
```
# Chat Session #1
**Workspace**: ~/projects/my-app
**Created**: 2025-12-18 10:30
**Messages**: 12

---

## User (10:30)

How do I implement authentication in Next.js?

---

## Assistant (10:31)

Here's how to implement authentication in Next.js:

```typescript
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
...
```

---

## User (10:35)

What about protecting API routes?

...
```

**JSON Output** (`--json`):
```json
{
  "id": "abc123-def456",
  "index": 1,
  "title": null,
  "createdAt": "2025-12-18T10:30:00Z",
  "lastUpdatedAt": "2025-12-18T11:45:00Z",
  "workspaceId": "a1b2c3",
  "workspacePath": "/Users/dev/projects/my-app",
  "messages": [
    {
      "role": "user",
      "content": "How do I implement authentication in Next.js?",
      "timestamp": "2025-12-18T10:30:00Z",
      "codeBlocks": []
    },
    {
      "role": "assistant",
      "content": "Here's how to implement authentication...",
      "timestamp": "2025-12-18T10:31:00Z",
      "codeBlocks": [
        {
          "language": "typescript",
          "content": "// app/api/auth/[...nextauth]/route.ts\nimport NextAuth from 'next-auth';",
          "startLine": 3
        }
      ]
    }
  ]
}
```

**Error Cases**:
- Invalid index → Exit 2, message: "Invalid session index: must be a positive integer"
- Index out of range → Exit 3, message: "Session #N not found. Use --list to see available sessions."

---

### --search

Search across chat history.

**Usage**:
```
cursor-history --search <term> [options]
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `<term>` | string | yes | Search term (case-insensitive) |

**Options**:
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--limit` | `-n` | number | 20 | Maximum results to show |
| `--context` | `-c` | number | 50 | Characters of context around match |

**Human Output** (default):
```
# Search Results for "authentication" (5 matches)

 #  | Date       | Workspace         | Match
----|------------|-------------------|----------------------------------
 1  | 2025-12-18 | ~/projects/my-app | ...implement **authentication** in Next.js...
 2  | 2025-12-15 | ~/projects/my-app | ...JWT **authentication** flow...
 3  | 2025-12-10 | ~/work/api        | ...OAuth **authentication** provider...
```

**JSON Output** (`--json`):
```json
{
  "query": "authentication",
  "total": 5,
  "results": [
    {
      "index": 1,
      "sessionId": "abc123",
      "workspacePath": "/Users/dev/projects/my-app",
      "createdAt": "2025-12-18T10:30:00Z",
      "matchCount": 3,
      "snippets": [
        {
          "messageRole": "user",
          "text": "...implement authentication in Next.js...",
          "matchPositions": [14, 28]
        }
      ]
    }
  ]
}
```

---

### --export

Export chat history to file.

**Usage**:
```
cursor-history --export <index> [options]
cursor-history --export --all [options]
```

**Arguments**:
| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `<index>` | number | no* | Session index to export (*required unless --all) |

**Options**:
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--all` | `-a` | boolean | false | Export all sessions |
| `--output` | `-o` | string | stdout | Output file or directory |
| `--format` | - | string | md | Export format: 'md' or 'json' |
| `--force` | - | boolean | false | Overwrite existing files |

**Markdown Output** (`--format md`):
```markdown
# Chat Session

**Workspace**: ~/projects/my-app
**Created**: 2025-12-18 10:30
**Exported**: 2025-12-18 14:00

---

## User

How do I implement authentication in Next.js?

## Assistant

Here's how to implement authentication in Next.js:

```typescript
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
```

---
```

**Batch Export** (`--all --output ./exports/`):
- Creates one file per session
- Filename format: `{workspace-name}_{date}_{index}.md`
- Example: `my-app_2025-12-18_001.md`

**Error Cases**:
- Output file exists without --force → Exit 1, message: "File exists. Use --force to overwrite."
- Invalid format → Exit 2, message: "Invalid format. Use 'md' or 'json'."

---

## Help Output

```
cursor-history - Browse and export Cursor AI chat history

Usage:
  cursor-history --list [options]      List chat sessions
  cursor-history --show <n> [options]  Show session content
  cursor-history --search <term>       Search chat history
  cursor-history --export <n>          Export to file

Options:
  -h, --help              Show this help message
  -v, --version           Show version number
  -j, --json              Output as JSON
  -w, --workspace <path>  Filter by workspace
  --data-path <path>      Override Cursor data directory

List Options:
  -n, --limit <n>         Max sessions to show (default: 20)
  -a, --all               Show all sessions
  --workspaces            List workspaces instead

Show Options:
  -f, --full              Show complete content (no truncation)

Search Options:
  -n, --limit <n>         Max results (default: 20)
  -c, --context <n>       Context characters (default: 50)

Export Options:
  -a, --all               Export all sessions
  -o, --output <path>     Output file or directory
  --format <fmt>          Format: md, json (default: md)
  --force                 Overwrite existing files

Environment:
  CURSOR_DATA_PATH        Override default Cursor data directory

Examples:
  cursor-history --list                    # List recent chats
  cursor-history --list --workspaces       # List workspaces
  cursor-history --show 1                  # View first chat
  cursor-history --show 1 --json | jq      # Pipe to jq
  cursor-history --search "typescript"     # Search all chats
  cursor-history --export 1 -o chat.md     # Export to file
  cursor-history --export --all -o ./out/  # Export all chats
```

---

## Pipe & Script Compatibility

**stdin**: Not used (read-only from files)

**stdout**:
- Human-readable by default (with colors if TTY)
- JSON with `--json` flag
- Colors disabled when piped (non-TTY)

**stderr**:
- Error messages
- Warnings (e.g., "Skipped 2 corrupted sessions")
- Progress indicators (if TTY, not piped)

**Examples**:
```bash
# Pipe to grep
cursor-history --list | grep "my-project"

# Pipe JSON to jq
cursor-history --show 1 --json | jq '.messages[].content'

# Export and process
cursor-history --export 1 --format json | python process.py

# Use in script
if cursor-history --list --json | jq -e '.total > 0' > /dev/null; then
  echo "Has chat history"
fi
```
