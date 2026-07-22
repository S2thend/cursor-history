# Research: Retrieve Session by Composer ID or Index

**Branch**: 011-session-by-id-or-index | **Date**: 2026-03-15

## R1: Reuse of resolveSessionIdentifiers

**Decision**: Resolve numeric identifiers from the same listing scope that displayed them, then load the selected summary by stable session ID. Resolve non-numeric stable IDs against the global discovered session set for the active data source.

**Rationale**: Workspace-filtered indexes are local to that filtered result and cannot safely be reinterpreted against a global list. Stable IDs are unambiguous and retain their existing global lookup behavior.

**Alternatives considered**: Independent inline resolution in show/export was rejected because the two commands could drift. They share one command-level resolver and the same `SessionNotFoundError` behavior.

## R2: Core getSession API Shape

**Decision**: Extend `getSession` in `src/core/storage.ts` to accept `identifier: number | string` as the first parameter (in addition to existing `customDataPath` and `backupPath`). Behavior: (1) If `identifier` is a number, resolve it from the operation context's current summaries when present, otherwise from the global list. (2) If `identifier` is a string, find that stable ID in the operation context/global discovered set and run the existing full-session load path. Return type and null semantics remain unchanged.

**Rationale**: Single entry point for both CLI and library; no second function. The operation context preserves the listing scope for numeric indexes while stable IDs remain global. Backward compatible for callers passing a number.

**Alternatives considered**: Adding `getSessionById(id: string, ...)` alongside `getSession(index: number, ...)` would duplicate the full-session load logic and complicate the library (two functions vs one overload).

## R3: CLI SessionNotFoundError Messaging

**Decision**: Extend the CLI `SessionNotFoundError` in `src/cli/errors.ts` to support two constructor shapes: (1) `new SessionNotFoundError(identifier: string)` — use generic message including the invalid composer ID (e.g. "Session not found: <id>"). (2) `new SessionNotFoundError(index: number, maxIndex: number)` — keep existing message "Session #n not found. Valid range: 1–maxIndex". Show and export will throw the appropriate shape based on whether the user supplied a numeric (index) or non-numeric (ID) argument.

**Rationale**: Matches spec: ID → generic + invalid ID; index → existing range message. No new error class; single class with overloaded constructor or a single constructor `(identifier: string | number, maxIndex?: number)` where maxIndex is only used when identifier is a number.

**Alternatives considered**: Two error classes (SessionNotFoundByIndexError vs SessionNotFoundByIdError) would complicate handling and documentation; one class with optional second arg is sufficient.

## R4: Export Multi-Session and Identifier Lists

**Decision**: The current export command supports `export [index]` (single) and `export --all`. There is no current "export 1,2,3" multi-session by list. Per spec: "If multi-session export exists, allow the list to support either indices or composer IDs but no mixing." If the codebase does not support a comma-separated list of sessions today, this feature does not add it; only single-session export gains index-or-ID. If we later add multi-session list export, the list must be all indices or all IDs (no mixing).

**Rationale**: Spec defers to existing behavior; avoids scope creep. Single-session export by ID is the minimum; multi-session list is optional and constrained.

**Alternatives considered**: Adding "export 1,2,id" in this feature was explicitly ruled out by clarification (no mixing).

## R5: Library getSession and Export Signatures

**Decision**: Change the public library API from `getSession(index: number, config?)` to `getSession(identifier: number | string, config?)`. Library uses 0-based index when a number is passed (add 1 when calling core, as today). When a string is passed, pass it through to core `getSession(identifier, ...)` (core will resolve and load). Export functions that take an index today (e.g. `exportSessionToJson(index, config?)`) will be updated to accept `identifier: number | string` and resolve the same way. Library `SessionNotFoundError` already accepts `identifier: string | number`; ensure it is thrown from core/storage for both index and ID not-found cases and that message includes the identifier.

**Rationale**: Single function per spec; backward compatible for numeric callers; consistent with CLI.

**Alternatives considered**: Keeping `getSession(index)` and adding `getSessionById(id)` was rejected in clarification (Option A: single function).
