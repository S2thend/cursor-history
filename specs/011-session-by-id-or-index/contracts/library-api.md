# Library API Contract: Session by Index or ID

**Feature**: 011-session-by-id-or-index
**Date**: 2026-03-15

## getSession

**Signature**: `getSession(identifier: number | string, config?: LibraryConfig): Promise<Session>`

**Parameters**:

- `identifier`: Either a **number** (0-based index; 0 = first session) or a **string** (composer ID). Same resolution rules as CLI: numeric → index, non-numeric → composer ID.
- `config`: Optional. Unchanged (`dataPath`, `workspace`, `messageFilter`, etc.). When `workspace` is set, composer ID lookup uses the same scope as index lookup.

**Returns**: `Promise<Session>` — The session for the resolved identifier.

**Throws**:

- `SessionNotFoundError` when the identifier cannot be resolved (invalid ID or out-of-range index). Library `SessionNotFoundError` already has `identifier: string | number` and a message that includes the identifier.
- Existing errors: `DatabaseLockedError`, `DatabaseNotFoundError`, `InvalidFilterError`.

**Backward compatibility**: Callers passing only `getSession(0)` or `getSession(index)` continue to work; the first parameter now accepts `number | string`.

## exportSessionToJson / exportSessionToMarkdown

**Signatures**: Update to accept identifier in place of index:

- `exportSessionToJson(identifier: number | string, config?: LibraryConfig): Promise<string>`
- `exportSessionToMarkdown(identifier: number | string, config?: LibraryConfig): Promise<string>`

**Parameters**: Same as getSession: `identifier` is 0-based index (number) or composer ID (string). `config` unchanged.

**Returns / Throws**: Same as today; only the first parameter type changes from `number` to `number | string`.

## exportAllSessionsToJson / exportAllSessionsToMarkdown

No signature change. They export all sessions; no per-session identifier.

## SessionNotFoundError (Library)

**Location**: `src/lib/errors.ts`

Existing class already supports:

- `constructor(identifier: string | number)` — Message includes identifier. Used when session is not found whether by index or ID. No change required; ensure core throws this with the same identifier passed by the caller when resolution fails.

## Type Exports

No new public types. Document in JSDoc that `identifier` is `number | string` (0-based index or composer ID).
