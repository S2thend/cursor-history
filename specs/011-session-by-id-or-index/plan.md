# Implementation Plan: Retrieve Session by Composer ID or Index

**Branch**: `011-session-by-id-or-index` | **Date**: 2026-03-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-session-by-id-or-index/spec.md`

## Summary

Allow users and library callers to retrieve or export a session by either its list index (existing behavior) or its composer ID. The CLI `show` and `export` commands will accept a single argument that is either a positive integer (index) or a non-numeric string (composer ID). The library will expose a single `getSession(identifier: number | string, config?)` (and equivalent for export) so the same identifier shape works in both interfaces. Error messaging: when the identifier is a composer ID and not found, show a generic message including the invalid ID; when the identifier is an index and not found, keep existing messaging with valid index range. Workspace filter applies to both index and ID lookup. Multi-session export (if present) may accept a list of all indices or all composer IDs (no mixing).

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: commander, picocolors, better-sqlite3 / node:sqlite (existing)
**Storage**: SQLite (state.vscdb) — read-only; no schema changes
**Testing**: Vitest (unit/integration in `tests/`)
**Target Platform**: Node.js 20 LTS / 22.5+
**Project Type**: Single project (CLI + library sharing core)
**Performance Goals**: N/A (identifier resolution is O(n) over session list, same as today)
**Constraints**: Backward compatible; index-only usage unchanged; workspace scope same for index and ID
**Scale/Scope**: Core storage `getSession` signature change; CLI show/export argument parsing; library `getSession`/export overload; CLI error class extension

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Simplicity First | PASS | Reuse existing `resolveSessionIdentifiers` and session-load logic; single function for identifier. |
| II. CLI-Native Design | PASS | Single argument for show/export (index or ID); exit codes and error messages per spec. |
| III. Documentation-Driven | PASS | Docstrings and README for new identifier semantics; actionable errors (include invalid ID or range). |
| IV. Incremental Delivery | PASS | Can ship show-by-ID first, then export-by-ID, then library; each testable. |
| V. Defensive Parsing | PASS | Numeric string → index; non-numeric → ID; invalid/unknown → clear error, no wrong session. |

No violations. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/011-session-by-id-or-index/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1 (CLI + library)
└── tasks.md             # Phase 2 (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   └── storage.ts       # getSession(identifier: number | string, ...); reuse resolve + load by summary
├── cli/
│   ├── commands/
│   │   ├── show.ts      # Accept index or ID; use resolveSessionIdentifiers or parse then getSession
│   │   └── export.ts    # Same for [index] and multi-session list (all indices or all IDs)
│   └── errors.ts        # SessionNotFoundError: support (identifier, maxIndex?) for ID vs index message
└── lib/
    ├── index.ts         # getSession(identifier: number | string, config?); exportSessionToJson/Markdown same
    └── types.ts         # No new types; identifier documented as number | string
```

**Structure Decision**: Single project. Changes are confined to core (getSession signature and resolution path), CLI (show/export argument handling and SessionNotFoundError), and lib (getSession and export signatures). No new packages or modules.
