# Data Model: Library API for Cursor History Access

**Feature**: 002-library-api
**Date**: 2025-12-22
**Status**: Complete

**IMPORTANT**: This is a **library interface** for direct import and use in TypeScript/JavaScript projects, NOT a network/REST API. These types are exported for direct use: `import { Session, Message } from 'cursor-history'`

## Overview

This document defines the data structures exposed by the cursor-history library API. All types are derived from the existing SQLite schema (`state.vscdb`) and functional requirements from spec.md.

## Core Entities

### 1. Session

Represents a complete chat conversation with all associated metadata and messages.

**Source**: Derived from spec.md Key Entities + existing `src/core/types.ts`

```typescript
export interface Session {
  /** Unique identifier (database row ID or composite key) */
  id: string;

  /** Absolute path to workspace directory */
  workspace: string;

  /** ISO 8601 timestamp of session creation */
  timestamp: string;

  /** Array of messages in chronological order */
  messages: Message[];

  /** Total number of messages in session */
  messageCount: number;

  /** Metadata about session origin (optional) */
  metadata?: {
    /** Cursor version that created this session */
    cursorVersion?: string;

    /** Last modified timestamp */
    lastModified?: string;
  };
}
```

**Validation Rules** (from FR-008, FR-015):
- `id` MUST be unique within a workspace
- `workspace` MUST be an absolute path (validated via `path.isAbsolute()`)
- `timestamp` MUST be valid ISO 8601 format
- `messages` array MAY be empty (valid session with no messages)
- If any message parsing fails (corrupted data), session is still returned with successfully parsed messages, and a warning is logged

**State Transitions**: N/A (read-only entity, no lifecycle)

---

### 2. Message

Represents a single message within a session (user or assistant).

**Source**: Derived from spec.md Key Entities + existing `src/core/types.ts`

```typescript
export interface Message {
  /** Message role: 'user' or 'assistant' */
  role: 'user' | 'assistant';

  /** Message content (text, code blocks, or structured data) */
  content: string;

  /** ISO 8601 timestamp when message was created */
  timestamp: string;

  /** Tool calls executed by assistant (optional, assistant-only) */
  toolCalls?: ToolCall[];

  /** AI reasoning/thinking text (optional, assistant-only) */
  thinking?: string;

  /** Metadata about message processing (optional) */
  metadata?: {
    /** Whether message data was partially corrupted */
    corrupted?: boolean;

    /** Original bubble type from database (for debugging) */
    bubbleType?: number;
  };
}
```

**Validation Rules** (from FR-015):
- `role` MUST be either 'user' or 'assistant' (no other values allowed)
- `content` MUST NOT be empty string (messages with empty content are skipped with warning)
- `timestamp` MUST be valid ISO 8601 format
- `toolCalls` and `thinking` MUST only be present when `role === 'assistant'`
- If message is corrupted but partially parseable, `metadata.corrupted === true` and content contains whatever was successfully extracted

**Relationships**:
- Message belongs to exactly one Session
- Message may reference multiple ToolCalls (0..N relationship)

---

### 3. ToolCall

Represents a tool/function call executed by the assistant.

**Source**: Derived from existing `src/core/storage.ts` bubble extraction logic

```typescript
export interface ToolCall {
  /** Tool/function name (e.g., 'read_file', 'write', 'grep') */
  name: string;

  /** Tool execution status */
  status: 'completed' | 'cancelled' | 'error';

  /** Tool parameters as JSON object */
  params?: Record<string, unknown>;

  /** Tool execution result (optional, present if status === 'completed') */
  result?: string;

  /** Error message (optional, present if status === 'error') */
  error?: string;

  /** File paths involved in this tool call (optional) */
  files?: string[];
}
```

**Validation Rules**:
- `name` MUST be a non-empty string
- `status` MUST be one of the three valid values
- `result` SHOULD only be present when `status === 'completed'`
- `error` SHOULD only be present when `status === 'error'`
- `params` MAY be empty object (valid for parameterless tools)

**Relationships**:
- ToolCall belongs to exactly one Message (assistant role)
- ToolCall is independent (no references to other tool calls)

---

### 4. SearchResult

Represents a search match with context.

**Source**: Derived from spec.md User Story 2 acceptance scenarios

```typescript
export interface SearchResult {
  /** Reference to the session containing this match */
  session: Session;

  /** Matched content snippet */
  match: string;

  /** Message index within session where match was found */
  messageIndex: number;

  /** Context lines before match (optional, based on config) */
  contextBefore?: string[];

  /** Context lines after match (optional, based on config) */
  contextAfter?: string[];

  /** Character offset of match within message content */
  offset?: number;
}
```

**Validation Rules**:
- `session` MUST be a valid Session object
- `match` MUST be non-empty substring of `session.messages[messageIndex].content`
- `messageIndex` MUST be valid index: `0 <= messageIndex < session.messages.length`
- `contextBefore` and `contextAfter` arrays MUST have length `<= config.context` parameter

**Relationships**:
- SearchResult references exactly one Session
- SearchResult references exactly one Message (via messageIndex)

---

### 5. LibraryConfig

Configuration options for library functions.

**Source**: Derived from clarifications (Q6) and FR-003, FR-016

```typescript
export interface LibraryConfig {
  /** Custom Cursor data path (optional, defaults to platform path) */
  dataPath?: string;

  /** Filter sessions by workspace path (optional) */
  workspace?: string;

  /** Pagination limit (optional, defaults to no limit) */
  limit?: number;

  /** Pagination offset (optional, defaults to 0) */
  offset?: number;

  /** Search context lines (optional, defaults to 0) */
  context?: number;
}
```

**Validation Rules** (from FR-016, clarification Q4):
- `dataPath`: If provided, MUST be a valid directory path; if omitted, platform default is used
- `workspace`: If provided, MUST be a valid absolute path
- `limit`: If provided, MUST be positive integer (> 0)
- `offset`: If provided, MUST be non-negative integer (>= 0)
- `context`: If provided, MUST be non-negative integer (>= 0)

**Default Values** (from research.md decision #4):
```typescript
const defaultConfig: Required<LibraryConfig> = {
  dataPath: getPlatformDefaultPath(),  // From src/platform/paths.ts
  workspace: undefined,                 // No filter
  limit: Number.MAX_SAFE_INTEGER,       // No pagination
  offset: 0,
  context: 0                            // No context lines
};
```

---

### 6. PaginatedResult

Wrapper for paginated API responses.

**Source**: Derived from research.md decision #5 and FR-011

```typescript
export interface PaginatedResult<T> {
  /** Array of data items for current page */
  data: T[];

  /** Pagination metadata */
  pagination: {
    /** Total number of items across all pages */
    total: number;

    /** Maximum items per page (from config.limit) */
    limit: number;

    /** Offset of first item in current page (from config.offset) */
    offset: number;

    /** Whether more pages exist after this one */
    hasMore: boolean;
  };
}
```

**Validation Rules**:
- `data.length` MUST be `<= pagination.limit`
- `pagination.hasMore` MUST be `true` iff `pagination.offset + pagination.limit < pagination.total`
- `pagination.total` MUST be `>= data.length`

**Usage**: Returned by `listSessions()` when `config.limit` is specified

---

## Error Types

Custom error classes for typed error handling (from FR-005 and research.md decision #3).

### DatabaseLockedError

Thrown when database is locked by Cursor or another process.

```typescript
export class DatabaseLockedError extends Error {
  name = 'DatabaseLockedError';
  path: string;  // Path to locked database file

  constructor(path: string) {
    super(`Database is locked: ${path}. Close Cursor or retry later.`);
    this.path = path;
  }
}
```

**When Thrown**:
- `better-sqlite3` throws SQLITE_BUSY error during connection
- Database file has OS-level file lock

**Recovery Strategy** (from clarification Q2):
- User MUST implement retry logic (library does not retry automatically)
- Suggest closing Cursor IDE before retrying

---

### DatabaseNotFoundError

Thrown when database file or directory does not exist.

```typescript
export class DatabaseNotFoundError extends Error {
  name = 'DatabaseNotFoundError';
  path: string;  // Path that was not found

  constructor(path: string) {
    super(`Database not found: ${path}. Check dataPath configuration.`);
    this.path = path;
  }
}
```

**When Thrown**:
- `config.dataPath` points to non-existent directory
- Platform default path does not exist (Cursor not installed)

**Recovery Strategy**:
- Verify Cursor is installed
- Check `config.dataPath` spelling/permissions
- Use platform-specific default paths (see quickstart.md)

---

### InvalidConfigError

Thrown when configuration parameters are invalid.

```typescript
export class InvalidConfigError extends Error {
  name = 'InvalidConfigError';
  field: string;  // Name of invalid config field
  value: unknown; // Invalid value provided

  constructor(field: string, value: unknown, reason: string) {
    super(`Invalid config.${field}: ${reason} (got: ${value})`);
    this.field = field;
    this.value = value;
  }
}
```

**When Thrown**:
- `config.limit < 1`
- `config.offset < 0`
- `config.context < 0`
- `config.workspace` is not absolute path

**Recovery Strategy**:
- Fix configuration values per validation rules above

---

## Data Volume Assumptions

From spec.md Success Criteria and research.md:

| Metric | Expected Scale | Design Implication |
|--------|----------------|-------------------|
| Sessions per workspace | < 1,000 | Pagination optional for most users |
| Messages per session | < 10,000 | FR-002 requires handling 1000+ without issues |
| Tool calls per message | < 50 | Inline array storage acceptable |
| Search results | < 500 | Return all matches (no pagination on search yet) |
| Concurrent API calls | 1-10 | No connection pooling needed (research.md #2) |

**Memory Budget** (from Technical Context):
- Target: Handle 1000-message session in < 100MB RAM
- Strategy: Streaming not required (SQLite loads full result set), acceptable for CLI-style usage

---

## Schema Migration Notes

**Assumption** (from spec.md): "Cursor's database schema remains consistent with current implementation (state.vscdb structure)"

**Out of Scope** (from spec.md): "No automatic handling of schema changes between Cursor versions"

**Implication**:
- Library MUST gracefully handle unknown fields (ignore them, per research.md #7)
- Library SHOULD log warning if schema version mismatch detected
- Users MUST manually update library if Cursor schema changes significantly

---

## Type Export Structure

All types exported from `src/lib/types.ts` and re-exported in `src/lib/index.ts` for single import:

```typescript
// src/lib/index.ts
export type {
  Session,
  Message,
  ToolCall,
  SearchResult,
  LibraryConfig,
  PaginatedResult
} from './types.js';

export {
  DatabaseLockedError,
  DatabaseNotFoundError,
  InvalidConfigError
} from './errors.js';
```

**Tree-Shaking**: Named exports enable bundlers to eliminate unused types from final bundle.

---

## Diagram: Entity Relationships

```
┌─────────────────┐
│ LibraryConfig   │ (passed to all API functions)
└─────────────────┘
        │
        │ configures
        ▼
┌─────────────────┐      contains     ┌─────────────────┐
│ Session         │◄─────────────────►│ PaginatedResult │
│ - id            │                   │ - data[]        │
│ - workspace     │                   │ - pagination    │
│ - timestamp     │                   └─────────────────┘
│ - messages[]    │
│ - messageCount  │
└────────┬────────┘
         │
         │ has many
         ▼
┌─────────────────┐      may have     ┌─────────────────┐
│ Message         │───────────────────►│ ToolCall        │
│ - role          │                    │ - name          │
│ - content       │                    │ - status        │
│ - timestamp     │                    │ - params        │
│ - toolCalls[]   │                    │ - result        │
│ - thinking      │                    └─────────────────┘
└────────┬────────┘
         │
         │ referenced by
         ▼
┌─────────────────┐
│ SearchResult    │
│ - session       │ ──┐
│ - match         │   │ references
│ - messageIndex  │◄──┘
│ - contextBefore │
│ - contextAfter  │
└─────────────────┘
```

---

## Summary

This data model:
- ✅ Covers all entities from spec.md (Session, Message, SearchResult, LibraryConfig)
- ✅ Includes error types for typed error handling (FR-005)
- ✅ Supports pagination requirements (FR-011)
- ✅ Defines validation rules from functional requirements
- ✅ Documents relationships and cardinality
- ✅ Aligns with Constitution Principle I (Simplicity First) - no ORM, no complex abstractions
