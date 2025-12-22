# Research: Cursor Chat History CLI

**Date**: 2025-12-18
**Branch**: 001-chat-history-cli

## Research Summary

This document resolves the NEEDS CLARIFICATION items from the implementation plan.

---

## 1. Cursor Chat History Storage Format

### Decision: SQLite database with JSON blobs

### Storage Locations

| OS | Path |
|----|------|
| **Windows** | `%APPDATA%\Cursor\User\workspaceStorage\<workspace-id>\state.vscdb` |
| **macOS** | `~/Library/Application Support/Cursor/User/workspaceStorage/<workspace-id>/state.vscdb` |
| **Linux** | `~/.config/Cursor/User/workspaceStorage/<workspace-id>/state.vscdb` |

Each workspace has its own `state.vscdb` SQLite file. The `<workspace-id>` is a hash
derived from the workspace path.

### Database Schema

**Table**: `ItemTable`

| Column | Type | Description |
|--------|------|-------------|
| `rowid` | INTEGER | Auto-increment primary key |
| `key` | TEXT | Storage key identifier |
| `value` | TEXT/BLOB | JSON-encoded data |

### Relevant Keys

| Key | Content |
|-----|---------|
| `workbench.panel.aichat.view.aichat.chatdata` | Primary chat history (legacy) |
| `aiService.prompts` | User prompts |
| `aiService.generations` | AI responses (some versions) |

**SQL Query**:
```sql
SELECT rowid, [key], value FROM ItemTable
WHERE [key] IN ('aiService.prompts', 'workbench.panel.aichat.view.aichat.chatdata')
```

### JSON Structure (Chat Data)

```json
{
  "version": 1,
  "chatSessions": [
    {
      "id": "uuid-string",
      "title": "Chat Title",
      "createdAt": 1732619305658,
      "lastUpdatedAt": 1732697065798,
      "messages": [
        {
          "role": "user",
          "content": "User message text",
          "timestamp": 1732619305658
        },
        {
          "role": "assistant",
          "content": "Assistant response with ```code blocks```",
          "timestamp": 1732619310000
        }
      ]
    }
  ]
}
```

### Workspace Identification

The `workspaceStorage` directory contains subdirectories named with hashed workspace IDs.
Each subdirectory contains a `workspace.json` file mapping the hash to the actual
filesystem path:

```json
{
  "folder": "file:///Users/username/projects/my-project"
}
```

### Rationale

- SQLite is cross-platform and requires no external database
- JSON blob storage allows flexible schema evolution by Cursor team
- Existing tools (cursor-view, cursor-chat-export) validate this approach

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|------------------|
| Direct JSON files | Not how Cursor stores data |
| VS Code API | Requires Cursor extension, not standalone CLI |
| Cursor export feature | Manual, not scriptable |

### Sources

- [Cursor Forum: Chat history in SQLite](https://forum.cursor.com/t/chat-history-in-sqllite/132473)
- [Cursor Forum: Exporting chats guide](https://forum.cursor.com/t/guide-5-steps-exporting-chats-prompts-from-cursor/2825)
- [GitHub: cursor-view](https://github.com/saharmor/cursor-view)
- [GitHub: cursor-chat-export](https://github.com/somogyijanos/cursor-chat-export)

---

## 2. CLI Framework Selection

### Decision: Commander.js

### Rationale

| Factor | Commander | Yargs |
|--------|-----------|-------|
| Bundle size | ~50KB | ~150KB |
| TypeScript types | Good (manual) | Excellent (inferred) |
| Learning curve | Simple | Moderate |
| Flag-based pattern | Native fit | Native fit |
| Maintenance | tj/commander (active) | yargs/yargs (active) |

**Choice**: Commander.js

- Smaller bundle aligns with Constitution Principle I (Simplicity First)
- Sufficient for flag-based invocation pattern
- Well-documented, widely adopted
- Native support for `-h/--help` generation

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|------------------|
| Yargs | Larger bundle, more features than needed |
| Oclif | Enterprise-focused, over-engineered for this use case |
| Raw process.argv | No help generation, more manual work |
| Citty | Less mature, smaller community |

### Sources

- [LogRocket: Building TypeScript CLI with Commander](https://blog.logrocket.com/building-typescript-cli-node-js-commander/)
- [npm: commander](https://www.npmjs.com/package/commander)

---

## 3. Terminal Formatting Dependencies

### Decision: Minimal dependencies with optional color support

| Dependency | Purpose | Size |
|------------|---------|------|
| `commander` | CLI framework | ~50KB |
| `better-sqlite3` | SQLite access (sync API) | Native addon |
| `picocolors` | Terminal colors (optional) | ~2KB |

### Rationale

- `better-sqlite3` provides synchronous API ideal for CLI (no async complexity)
- `picocolors` is the smallest color library with full feature set
- No heavy dependencies like `chalk` (larger) or `ink` (React-based, overkill)

### Code Block Formatting

For syntax highlighting in terminal:
- **MVP**: Plain text with language annotation header
- **Future**: Consider `cli-highlight` if users request

### Alternatives Considered

| Alternative | Rejected Because |
|-------------|------------------|
| chalk | Larger than picocolors, more than needed |
| sql.js | WASM-based, larger bundle, async API |
| node:sqlite | Experimental in Node.js, not stable yet |
| marked-terminal | Heavy dependency for markdown rendering |

---

## 4. Version Compatibility Notes

Cursor has been refactoring its database schema across versions:
- v0.40.2: Includes references and scores
- v0.40.3: Scores removed
- Future versions may change key names

### Mitigation Strategy

1. Check for known keys in priority order
2. Fall back to scanning ItemTable for chat-like JSON structures
3. Log warnings for unknown formats, don't crash
4. Suggest tool update if structure unrecognized

---

## Technical Context Updates

Based on this research, the plan's Technical Context is now resolved:

**Primary Dependencies**:
- `commander` (CLI framework)
- `better-sqlite3` (SQLite access)
- `picocolors` (terminal colors)

**Storage**: SQLite (`state.vscdb`) with JSON blobs in `ItemTable`

All NEEDS CLARIFICATION items resolved.
