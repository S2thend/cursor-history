# Data Model: Message Type Filter

**Feature**: 008-message-type-filter
**Date**: 2026-01-11

## New Types

### MessageType

```typescript
/**
 * Valid message type filter values
 */
export type MessageType = 'user' | 'assistant' | 'tool' | 'thinking' | 'error';

/**
 * Array of all valid message types (for validation)
 */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'user',
  'assistant',
  'tool',
  'thinking',
  'error'
] as const;
```

**Location**: `src/core/types.ts`

### MessageTypeFilter

```typescript
/**
 * Filter configuration for message types
 * When undefined or empty, all messages are shown
 */
export type MessageTypeFilter = MessageType[];
```

**Location**: `src/core/types.ts` (internal), `src/lib/types.ts` (public API)

## Modified Types

### LibraryConfig (src/lib/types.ts)

Add optional `messageFilter` field:

```typescript
export interface LibraryConfig {
  dataPath?: string;
  workspace?: string;
  limit?: number;
  offset?: number;
  context?: number;
  sqliteDriver?: 'better-sqlite3' | 'node:sqlite';
  messageFilter?: MessageType[];  // NEW
}
```

### ShowCommandOptions (src/cli/commands/show.ts)

Add optional `only` field:

```typescript
interface ShowCommandOptions {
  json?: boolean;
  dataPath?: string;
  short?: boolean;
  think?: boolean;
  tool?: boolean;
  error?: boolean;
  backup?: string;
  only?: string;  // NEW - comma-separated types
}
```

## Existing Types (Unchanged)

### Message (src/core/types.ts)

```typescript
export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}
```

The `Message` interface remains unchanged. Message type classification is derived from:
- `role === 'user'` → `user` type
- `role === 'assistant'` + content detection → `tool`, `thinking`, `error`, or `assistant` type

## Type Classification Logic

```typescript
function getMessageType(message: Message): MessageType {
  if (message.role === 'user') {
    return 'user';
  }
  // For assistant messages, check content markers
  if (message.content.startsWith('[Tool:')) {
    return 'tool';
  }
  if (message.content.startsWith('[Thinking]')) {
    return 'thinking';
  }
  if (message.content.startsWith('[Error]')) {
    return 'error';
  }
  return 'assistant';
}
```

## Validation Rules

1. **Filter values**: Must be one of `MESSAGE_TYPES`; invalid values produce error listing valid options
2. **Empty filter**: Treated as "show all" (no filtering applied)
3. **All types specified**: Equivalent to no filter (optimization: skip filtering)
4. **Duplicate types**: Silently deduplicated
5. **Case sensitivity**: Filter values are case-sensitive (lowercase only)

## State Transitions

N/A - This feature is stateless filtering at display time.

## Data Volume

Filter operates on in-memory `Message[]` array. Typical sessions have 10-200 messages.
Performance target: <1ms per 100 messages (simple string prefix checks).
