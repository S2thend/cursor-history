# Quickstart: Message Type Filter Implementation

**Feature**: 008-message-type-filter
**Date**: 2026-01-11

## Implementation Order

1. **Types** → 2. **Filter Logic** → 3. **CLI** → 4. **Library** → 5. **Tests**

## Step 1: Add Types

### src/core/types.ts

```typescript
// Add after existing type definitions

/**
 * Valid message type filter values
 */
export type MessageType = 'user' | 'assistant' | 'tool' | 'thinking' | 'error';

/**
 * Array of all valid message types (for validation)
 */
export const MESSAGE_TYPES: readonly MessageType[] = [
  'user', 'assistant', 'tool', 'thinking', 'error'
] as const;
```

## Step 2: Add Filter Logic

### src/cli/formatters/table.ts

```typescript
import { MessageType, MESSAGE_TYPES } from '../../core/types.js';

// Export existing helpers (make public)
export function isToolCall(content: string): boolean { /* ... */ }
export function isThinking(content: string): boolean { /* ... */ }
export function isError(content: string): boolean { /* ... */ }

/**
 * Get the type of a message based on its content
 */
export function getMessageType(message: { role: string; content: string }): MessageType {
  if (message.role === 'user') {
    return 'user';
  }
  if (isToolCall(message.content)) return 'tool';
  if (isThinking(message.content)) return 'thinking';
  if (isError(message.content)) return 'error';
  return 'assistant';
}

/**
 * Filter messages by type
 */
export function filterMessages<T extends { role: string; content: string }>(
  messages: T[],
  types: MessageType[]
): T[] {
  if (types.length === 0 || types.length === MESSAGE_TYPES.length) {
    return messages; // No filtering needed
  }
  return messages.filter(m => types.includes(getMessageType(m)));
}

/**
 * Validate filter types, returns invalid types or empty array if all valid
 */
export function validateMessageTypes(types: string[]): string[] {
  return types.filter(t => !MESSAGE_TYPES.includes(t as MessageType));
}
```

## Step 3: Update CLI Show Command

### src/cli/commands/show.ts

```typescript
// Add to imports
import { filterMessages, validateMessageTypes, MESSAGE_TYPES } from '../formatters/table.js';
import type { MessageType } from '../../core/types.js';

// Add to ShowCommandOptions interface
interface ShowCommandOptions {
  // ... existing fields ...
  only?: string;  // NEW
}

// Add option registration
.option('-o, --only <types>', 'Show only specified message types (user,assistant,tool,thinking,error)')

// Add validation in action handler
if (options.only) {
  const types = options.only.split(',').map(t => t.trim().toLowerCase());
  const invalid = validateMessageTypes(types);
  if (invalid.length > 0) {
    console.error(pc.red(`Invalid message type(s): ${invalid.join(', ')}`));
    console.error(`Valid types: ${MESSAGE_TYPES.join(', ')}`);
    process.exit(1);
  }
}

// Apply filter before display
const messageFilter = options.only
  ? options.only.split(',').map(t => t.trim().toLowerCase()) as MessageType[]
  : undefined;

const filteredMessages = messageFilter
  ? filterMessages(session.messages, messageFilter)
  : session.messages;

// Handle empty result
if (messageFilter && filteredMessages.length === 0) {
  // Show header + empty message
}
```

## Step 4: Update Library API

### src/lib/types.ts

```typescript
// Add to exports
export type { MessageType } from '../core/types.js';
export { MESSAGE_TYPES } from '../core/types.js';

// Add to LibraryConfig
export interface LibraryConfig {
  // ... existing fields ...
  messageFilter?: MessageType[];
}
```

### src/lib/index.ts

```typescript
// Add exports
export { getMessageType, filterMessages, validateMessageTypes } from '../cli/formatters/table.js';
export type { MessageType } from '../core/types.js';
export { MESSAGE_TYPES } from '../core/types.js';

// Modify getSession to apply filter
export async function getSession(index: number, config?: LibraryConfig): Promise<Session | null> {
  // ... existing code ...

  if (config?.messageFilter && config.messageFilter.length > 0) {
    session.messages = filterMessages(session.messages, config.messageFilter);
  }

  return session;
}
```

## Step 5: Add Tests

### tests/unit/filter.test.ts

```typescript
import { describe, it, expect } from 'vitest';
import { getMessageType, filterMessages, validateMessageTypes } from '../../src/cli/formatters/table.js';

describe('getMessageType', () => {
  it('returns user for user messages', () => {
    expect(getMessageType({ role: 'user', content: 'Hello' })).toBe('user');
  });

  it('returns tool for tool calls', () => {
    expect(getMessageType({ role: 'assistant', content: '[Tool: read_file]...' })).toBe('tool');
  });

  it('returns thinking for thinking blocks', () => {
    expect(getMessageType({ role: 'assistant', content: '[Thinking]\n...' })).toBe('thinking');
  });

  it('returns error for error messages', () => {
    expect(getMessageType({ role: 'assistant', content: '[Error]\n...' })).toBe('error');
  });

  it('returns assistant for plain assistant messages', () => {
    expect(getMessageType({ role: 'assistant', content: 'Here is the answer...' })).toBe('assistant');
  });
});

describe('filterMessages', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: '[Tool: read_file]...' },
    { role: 'assistant', content: 'Answer here' },
    { role: 'assistant', content: '[Thinking]\nLet me think...' },
  ];

  it('filters to user only', () => {
    const result = filterMessages(messages, ['user']);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('filters to multiple types', () => {
    const result = filterMessages(messages, ['user', 'tool']);
    expect(result).toHaveLength(2);
  });

  it('returns all when empty filter', () => {
    const result = filterMessages(messages, []);
    expect(result).toHaveLength(4);
  });
});

describe('validateMessageTypes', () => {
  it('returns empty for valid types', () => {
    expect(validateMessageTypes(['user', 'tool'])).toEqual([]);
  });

  it('returns invalid types', () => {
    expect(validateMessageTypes(['user', 'invalid'])).toEqual(['invalid']);
  });
});
```

## Build & Test

```bash
npm run build
npm test

# Manual testing
node dist/cli/index.js show 1 --only user
node dist/cli/index.js show 1 --only tool
node dist/cli/index.js show 1 --only user,tool
node dist/cli/index.js show 1 --only invalid  # Should error
```
