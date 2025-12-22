# Quickstart: cursor-history CLI

Get started with the Cursor Chat History CLI in under a minute.

## Installation

### Option 1: npm (requires Node.js)

```bash
npm install -g cursor-history
```

### Option 2: Standalone Binary

Download from releases for your platform:
- `cursor-history-macos-arm64`
- `cursor-history-macos-x64`
- `cursor-history-linux-x64`
- `cursor-history-windows-x64.exe`

```bash
# macOS/Linux
chmod +x cursor-history-*
sudo mv cursor-history-* /usr/local/bin/cursor-history

# Windows (PowerShell as Admin)
Move-Item cursor-history-windows-x64.exe C:\Windows\cursor-history.exe
```

## Basic Usage

### List Your Chats

```bash
# Show recent chat sessions
cursor-history --list

# Output:
# # Chat History (showing 20 of 47)
#
#  #  | Date       | Workspace              | Preview
# ----|------------|------------------------|----------------------------------
#  1  | 2025-12-18 | ~/projects/my-app      | How do I implement auth...
#  2  | 2025-12-17 | ~/projects/my-app      | Fix the TypeScript error in...
```

### View a Chat

```bash
# View chat #1 (from list output)
cursor-history --show 1

# Output:
# # Chat Session #1
# **Workspace**: ~/projects/my-app
# **Created**: 2025-12-18 10:30
#
# ---
# ## User (10:30)
# How do I implement authentication in Next.js?
#
# ---
# ## Assistant (10:31)
# Here's how to implement authentication...
```

### Search Your History

```bash
# Find chats about a topic
cursor-history --search "authentication"

# Output:
# # Search Results for "authentication" (5 matches)
#
#  #  | Date       | Workspace         | Match
# ----|------------|-------------------|----------------------------------
#  1  | 2025-12-18 | ~/projects/my-app | ...implement **authentication** in...
```

### Export a Chat

```bash
# Export to Markdown
cursor-history --export 1 -o chat.md

# Export to JSON
cursor-history --export 1 --format json -o chat.json

# Export all chats
cursor-history --export --all -o ./exports/
```

## Common Workflows

### Filter by Project

```bash
# Show chats from current directory
cursor-history --list --workspace .

# Show chats from specific project
cursor-history --list --workspace ~/projects/my-app
```

### JSON Output for Scripting

```bash
# Pipe to jq
cursor-history --list --json | jq '.sessions[0]'

# Get all message content
cursor-history --show 1 --json | jq '.messages[].content'

# Count sessions per workspace
cursor-history --list --all --json | jq '.sessions | group_by(.workspacePath) | map({path: .[0].workspacePath, count: length})'
```

### List Workspaces

```bash
cursor-history --list --workspaces

# Output:
# # Workspaces with Chat History
#
#  #  | Sessions | Path
# ----|----------|----------------------------------
#  1  |       23 | ~/projects/my-app
#  2  |       15 | ~/projects/other
```

## Troubleshooting

### "No chat history found"

1. Make sure Cursor is installed and you've used the AI chat feature
2. Check if data exists:
   ```bash
   # macOS
   ls ~/Library/Application\ Support/Cursor/User/workspaceStorage/

   # Linux
   ls ~/.config/Cursor/User/workspaceStorage/

   # Windows (PowerShell)
   dir $env:APPDATA\Cursor\User\workspaceStorage\
   ```

### Custom Data Path

If Cursor is installed in a non-standard location:

```bash
# Using flag
cursor-history --list --data-path /custom/path/to/workspaceStorage

# Using environment variable
export CURSOR_DATA_PATH=/custom/path/to/workspaceStorage
cursor-history --list
```

### Corrupted Data Warning

If you see "Skipped N corrupted sessions", some chat data couldn't be parsed.
This can happen after Cursor updates. The tool will show what it can read.

## Next Steps

- Run `cursor-history --help` for full command reference
- See [CLI Interface Contract](./contracts/cli-interface.md) for detailed specifications
- Report issues at https://github.com/yourrepo/cursor-history/issues
