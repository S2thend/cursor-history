# Quickstart: Session by Index or ID Implementation

**Feature**: 011-session-by-id-or-index
**Date**: 2026-03-15

## Implementation Order

1. **Core** — Extend `getSession(identifier, ...)` and ensure resolution/errors.
2. **CLI errors** — Extend `SessionNotFoundError` for ID vs index messaging.
3. **CLI show** — Accept index or ID; call core; throw appropriate error.
4. **CLI export** — Accept index or ID for single-session export; same resolution.
5. **Library** — Update `getSession` and export functions to accept `identifier: number | string`.
6. **Tests** — Unit tests for resolution, core getSession by ID, CLI and library behavior.

## Step 1: Core storage.getSession

**File**: `src/core/storage.ts`

- Change `getSession(index: number, customDataPath?, backupPath?)` to `getSession(identifier: number | string, customDataPath?, backupPath?)`.
- If `typeof identifier === 'string'`: call `resolveSessionIdentifiers([identifier], customDataPath)` to get one ID; get summary from `listSessions` where `s.id === resolvedId`; then run existing "load full session" path using that summary (same as current flow after finding summary by index). If resolution throws `SessionNotFoundError`, let it propagate.
- If `typeof identifier === 'number'`: keep current logic (find summary by index; load session). When not found, throw `SessionNotFoundError(identifier, summaries.length)` so CLI can show range — or keep returning null and let CLI construct error; either way, CLI must get enough info to show "Valid range: 1–N" for index. (Current: CLI gets null and calls `listSessions` to get maxIndex; that can remain.)
- Ensure when identifier is string and not found, core throws `SessionNotFoundError(identifier)` (from resolveSessionIdentifiers). When identifier is number and not found, either return null (CLI builds error with range) or throw with range; align with CLI error contract.

## Step 2: CLI SessionNotFoundError

**File**: `src/cli/errors.ts`

- Extend `SessionNotFoundError` to support:
  - `(identifier: string)` — message: "Session not found: <identifier>".
  - `(index: number, maxIndex: number)` — existing message with valid range.
- Implementation: single constructor `(identifier: string | number, maxIndex?: number)`. If `typeof identifier === 'string'` or `maxIndex === undefined`, use generic message with identifier; else use range message.

## Step 3: CLI show

**File**: `src/cli/commands/show.ts`

- Change argument from strictly numeric to index-or-ID: parse as number if possible; if valid positive integer, treat as index; else treat as composer ID string.
- Call `getSession(identifier, customPath, backupPath)` where identifier is number (1-based) or string (ID). Core returns session or null (index path) or throws SessionNotFoundError (ID path from resolveSessionIdentifiers).
- When core returns null (index not found): get session count and throw `SessionNotFoundError(index, count)`.
- When core throws SessionNotFoundError (ID not found): rethrow or map to CLI SessionNotFoundError with identifier only so message includes invalid ID.

## Step 4: CLI export

**File**: `src/cli/commands/export.ts`

- For single-session export (`indexArg` provided, not `--all`): same parsing as show — numeric → index, else → composer ID. Call core getSession with that identifier; on not found, same error handling as show (range for index, generic + ID for composer ID).
- Multi-session: if current implementation only has `--all`, no change. If comma-separated list is added later, validate all indices or all IDs (no mixing) and resolve each; fail with clear error if mixed.

## Step 5: Library getSession and export

**File**: `src/lib/index.ts`

- Change `getSession(index: number, config?)` to `getSession(identifier: number | string, config?)`. When number: convert to 1-based and call core `getSession(coreIndex, ...)`. When string: call core `getSession(identifier, ...)`. Map core null/throw to library `SessionNotFoundError`; ensure message includes identifier.
- Update `exportSessionToJson`, `exportSessionToMarkdown` (and any other single-session export) to accept `identifier: number | string` and pass through to core (with 0-based → 1-based conversion when number).

## Step 6: Tests

- **Core**: getSession with string ID (valid / invalid); getSession with number (unchanged); workspace filter applied for ID lookup.
- **CLI**: show with ID (valid / invalid); show with index (unchanged); export with ID; error message content for ID vs index.
- **Library**: getSession(0), getSession(id); export by ID; SessionNotFoundError thrown with correct identifier.

## Verification

- Run `cursor-history list` then `cursor-history show <id>` with an ID from the list; same session as `show 1` when that ID is first.
- Run `cursor-history show 999` (out of range) and confirm "Valid range: 1–N".
- Run `cursor-history show invalid-id` and confirm "Session not found: invalid-id".
- Library: `getSession(0)` and `getSession(sessionId)` return same session when ID matches first; `getSession('bad')` throws SessionNotFoundError with identifier.
