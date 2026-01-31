# CLI Interface Contract: Message Type Filter

**Feature**: 008-message-type-filter
**Date**: 2026-01-11

## Show Command Extension

### New Option

```
--only <types>    Show only messages of specified type(s)
                  Valid types: user, assistant, tool, thinking, error
                  Multiple types: comma-separated (e.g., --only user,tool)
```

### Usage Examples

```bash
# Show only user messages
cursor-history show 1 --only user

# Show only tool calls
cursor-history show 1 --only tool

# Show user messages and tool calls
cursor-history show 1 --only user,tool

# Combine with existing display options
cursor-history show 1 --only tool --tool    # Filter to tools, show full details

# JSON output with filter
cursor-history show 1 --only user --json
```

### Exit Codes

| Code | Condition |
|------|-----------|
| 0    | Success (including empty filtered result) |
| 1    | Invalid filter value provided |
| 2    | Session not found |
| 3    | Database error |

### Error Messages

**Invalid filter value**:
```
Error: Invalid message type "invalid".
Valid types: user, assistant, tool, thinking, error
```

**Empty filter result** (success, not error):
```
Chat Session #1
═══════════════════════════════════════════════

Title: My Chat Session
Date: Jan 11, 2026
Workspace: /path/to/project
Messages: 42

──────────────────────────────────────────────

No messages match the filter: user

Use --only without arguments to see all messages.
```

### JSON Output Schema (filtered)

```json
{
  "index": 1,
  "id": "composer-uuid-here",
  "title": "My Chat Session",
  "createdAt": "2026-01-11T10:00:00.000Z",
  "messageCount": 42,
  "filteredMessageCount": 5,
  "filter": ["user"],
  "messages": [
    {
      "role": "user",
      "content": "Hello, can you help me?",
      "timestamp": "2026-01-11T10:00:01.000Z",
      "type": "user"
    }
  ],
  "workspacePath": "/path/to/project"
}
```

Note: `filteredMessageCount` and `filter` fields added when filter is active.
