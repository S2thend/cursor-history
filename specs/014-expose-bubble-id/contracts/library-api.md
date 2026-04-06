# API Contract Changes: Library API

**Date**: 2026-04-06 | **Branch**: `014-expose-bubble-id`

## Message Type (additive)

```typescript
// src/lib/types.ts
export interface Message {
  /** Stable bubble UUID from cursorDiskKV (when available) */
  id?: string;                    // NEW — added

  role: 'user' | 'assistant';    // existing
  content: string;                // existing
  timestamp: string;              // existing
  toolCalls?: ToolCall[];         // existing
  thinking?: string;              // existing
  tokenUsage?: TokenUsage;        // existing
  model?: string;                 // existing
  durationMs?: number;            // existing
  metadata?: { ... };             // existing
}
```

## Session Type (additive)

```typescript
// src/lib/types.ts
export interface Session {
  id: string;                     // existing
  workspace: string;              // existing
  timestamp: string;              // existing
  messages: Message[];            // existing (messages now include id)
  messageCount: number;           // existing
  source?: 'global' | 'workspace-fallback';  // existing
  usage?: SessionUsage;           // existing
  metadata?: { ... };             // existing

  /** Ordered bubble UUIDs of the active conversation branch */
  activeBranchBubbleIds?: string[];  // NEW — added
}
```

## Backward Compatibility

- Both new fields are optional (`?`). Existing consumers that destructure or type-check will not break.
- `Message.id` is `undefined` (omitted from JSON serialization) when no UUID is available — not `null`.
- `Session.activeBranchBubbleIds` is `undefined` when the active branch manifest is absent, empty, invalid, or intentionally omitted for `workspace-fallback` sessions.

## CLI JSON Output (additive)

### `show --json` command

Messages already include `id` field (no change). Session output gains:

```json
{
  "activeBranchBubbleIds": ["uuid-1", "uuid-2", "uuid-3"]
}
```

Field omitted when data unavailable.

### `export --format json` command

Messages gain `id` field:

```json
{
  "messages": [
    {
      "id": "e66f2d00-47ff-4943-94ac-c0b5ea324d38",
      "role": "user",
      "content": "...",
      "timestamp": "..."
    }
  ]
}
```

Field omitted on messages where UUID is unavailable.

If the session has active-branch metadata:

```json
{
  "activeBranchBubbleIds": ["uuid-1", "uuid-2", "uuid-3"]
}
```

Field omitted when unavailable.

### `export --format markdown` command

Each exported message block gains an ID metadata line when available:

```markdown
### **User**
**ID**: `e66f2d00-47ff-4943-94ac-c0b5ea324d38`

How do I...
```

The ID line is omitted for messages where no stable UUID is available.
