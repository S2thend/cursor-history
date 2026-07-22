# CLI Contract: Session by Index or ID

**Feature**: 011-session-by-id-or-index
**Date**: 2026-03-15

## show Command

**Syntax**: `cursor-history show <index-or-id> [options]`

**Argument**: `<index-or-id>` — Either:

- A **positive integer** (or numeric string): 1-based index in the session list (same as today). Example: `show 1`, `show 2`.
- A **stable session ID** (non-numeric string, e.g. UUID): Look up a session by its canonical ID. Example: `show abc123-def456-...`.

**Behavior**:

- Numeric → resolve as index; load session at that position; on not found, throw `SessionNotFoundError(index, maxIndex)` with message "Session #n not found. Valid range: 1–maxIndex" (or "No sessions found." if maxIndex 0).
- Non-numeric → resolve as a stable session ID across the global discovered session set, independent of workspace filtering; load session; on not found, throw `SessionNotFoundError(identifier)` with a generic message including the invalid session ID.

**Options**: Unchanged (`-s`, `-t`, `-e`, `-o`, `-b`, `--json`, `--data-path`, etc.).

## export Command

**Syntax**: `cursor-history export [index-or-id] [options]`

**Argument**: `[index-or-id]` — Optional when `--all` is used. When provided:

- **Single session**: Either a positive integer (1-based index) or a stable session ID (non-numeric string). Same resolution and error rules as show.
- **Multi-session** (if supported in future): List must be either all indices or all stable session IDs (no mixing). Not required for this feature if current export does not support a list.

**Behavior**: Same resolution as show: numeric → scoped index (existing range message on not found); non-numeric → globally resolvable stable session ID (generic message with invalid ID on not found).

**Options**: Unchanged (`-o`, `-f`, `--force`, `-a`, `-b`, `--json`, `--data-path`).

## SessionNotFoundError (CLI)

**Location**: `src/cli/errors.ts`

**Constructor**:

- `SessionNotFoundError(identifier: string)` — For session-ID lookup failure. Message: generic "Session not found" including the invalid ID. Exit code: NOT_FOUND.
- `SessionNotFoundError(index: number, maxIndex: number)` — For index lookup failure (existing). Message: "Session #index not found. Valid range: 1–maxIndex" or "No sessions found." Exit code: NOT_FOUND.

Implementation may use a single constructor `(identifier: string | number, maxIndex?: number)` and branch on type to build the message.

## Workspace Scope

When `--data-path` or `--workspace` is used, numeric indices resolve within the filtered session-list scope. Stable session IDs remain globally resolvable and are not rejected merely because their session falls outside that workspace filter.
