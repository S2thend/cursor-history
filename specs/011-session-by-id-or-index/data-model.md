# Data Model: Retrieve Session by Composer ID or Index

**Feature**: 011-session-by-id-or-index
**Date**: 2026-03-15

## Identifier Type (Logical)

Sessions are referenced by one of two mutually exclusive identifier kinds:

| Kind   | Type    | Example   | Resolution |
|--------|---------|-----------|------------|
| Index  | number  | 1, 2      | 1-based in CLI; 0-based in library. Position in ordered list from `listSessions`. |
| ID     | string  | UUID-like | Canonical composer ID (same as composer ID). Match by `summary.id`. |

**Rule**: Numeric or numeric string (e.g. `"1"`) → index. Non-numeric string → composer ID. No mixing in a single list (for multi-session export if supported).

## Existing Types (Unchanged)

### ChatSessionSummary (core)

```text
index: number     # 1-based position in list
id: string       # Composer ID; used for lookup by ID
...
```

### Session (library)

Same as today; obtained by resolving identifier then loading full session. No new fields.

## Modified Signatures (Contract-Level)

### Core storage.getSession

- **Before**: `getSession(index: number, customDataPath?, backupPath?): Promise<ChatSession | null>`
- **After**: `getSession(identifier: number | string, customDataPath?, backupPath?): Promise<ChatSession | null>`
  - If `identifier` is number: treat as 1-based index (current behavior).
  - If `identifier` is string: resolve via `resolveSessionIdentifiers([identifier], customDataPath)`, then load session for that ID (same workspace scope as list).

### Library getSession / export

- **Before**: `getSession(index: number, config?): Promise<Session>`
- **After**: `getSession(identifier: number | string, config?): Promise<Session>`
  - number: 0-based index (convert to 1-based for core).
  - string: pass through to core as composer ID.

Export functions that take a session identifier will accept `number | string` in the same way.

## Validation Rules

1. **Index**: Positive integer (CLI 1-based; library 0-based). Zero or negative → error. Out of range → session not found with valid range in message (CLI) or SessionNotFoundError (library).
2. **Composer ID**: Non-numeric string. Not found → session not found with invalid ID in message (CLI) or SessionNotFoundError with identifier (library).
3. **Workspace**: When `dataPath`/`workspace` filter is applied, resolution (by index or ID) uses the same scope as `listSessions`.

## State Transitions

N/A — read-only lookups; no session state changes.
