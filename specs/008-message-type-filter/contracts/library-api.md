# Library API Contract: Message Type Filter

**Feature**: 008-message-type-filter
**Date**: 2026-01-11

## Extended Configuration

### LibraryConfig Addition

```typescript
interface LibraryConfig {
  // ... existing fields ...

  /**
   * Filter messages by type. When provided, only messages matching
   * these types are included in session results.
   *
   * Valid types: 'user', 'assistant', 'tool', 'thinking', 'error'
   *
   * @example
   * // Show only user messages
   * { messageFilter: ['user'] }
   *
   * @example
   * // Show user messages and tool calls
   * { messageFilter: ['user', 'tool'] }
   */
  messageFilter?: MessageType[];
}
```

## New Exports

### Types

```typescript
// src/lib/types.ts
export type MessageType = 'user' | 'assistant' | 'tool' | 'thinking' | 'error';
export const MESSAGE_TYPES: readonly MessageType[] = ['user', 'assistant', 'tool', 'thinking', 'error'];
```

### Functions

```typescript
// src/lib/index.ts

/**
 * Get message type from a message
 * @param message - The message to classify
 * @returns The message type
 */
export function getMessageType(message: Message): MessageType;

/**
 * Filter messages by type
 * @param messages - Array of messages to filter
 * @param types - Message types to include
 * @returns Filtered array of messages
 */
export function filterMessages(messages: Message[], types: MessageType[]): Message[];
```

## Usage Examples

### Filter via getSession config

```typescript
import { getSession } from 'cursor-history';

// Get session with only user messages
const session = await getSession(0, {
  messageFilter: ['user']
});

console.log(session.messages.length); // Only user messages
```

### Direct filtering

```typescript
import { getSession, filterMessages } from 'cursor-history';

// Get full session
const session = await getSession(0);

// Filter manually
const userMessages = filterMessages(session.messages, ['user']);
const toolsAndErrors = filterMessages(session.messages, ['tool', 'error']);
```

### Validate filter types

```typescript
import { MESSAGE_TYPES } from 'cursor-history';

function validateFilter(types: string[]): boolean {
  return types.every(t => MESSAGE_TYPES.includes(t as any));
}
```

## Response Types

### Session (with filter applied)

When `messageFilter` is provided, the returned `Session` object has:
- `messages`: Filtered array containing only matching message types
- `messageCount`: Original total count (before filtering)

Note: The session metadata (title, createdAt, workspacePath) remains unchanged.

### Message (extended)

Messages returned when filtering include a computed `type` field for convenience:

```typescript
interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  type?: MessageType;  // Computed field when filtering is active
}
```

## Error Handling

```typescript
import { getSession, InvalidFilterError } from 'cursor-history';

try {
  const session = await getSession(0, {
    messageFilter: ['invalid' as any]  // Bad filter type
  });
} catch (error) {
  if (error instanceof InvalidFilterError) {
    console.error('Invalid filter:', error.invalidTypes);
    console.error('Valid types:', error.validTypes);
  }
}
```

### InvalidFilterError

```typescript
class InvalidFilterError extends Error {
  readonly invalidTypes: string[];
  readonly validTypes: readonly string[];
}
```
