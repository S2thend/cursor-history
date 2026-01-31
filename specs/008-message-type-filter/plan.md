# Implementation Plan: Message Type Filter

**Branch**: `008-message-type-filter` | **Date**: 2026-01-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-message-type-filter/spec.md`

## Summary

Add a `--only <type>` option to the `show` command that filters displayed messages by type: `user`, `assistant`, `tool`, `thinking`, `error`. Supports comma-separated multiple values. Also expose filtering via library API.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: commander (CLI), picocolors (formatting), better-sqlite3/node:sqlite (database)
**Storage**: SQLite databases (state.vscdb files) - read-only for this feature
**Testing**: Vitest
**Target Platform**: Node.js 20+, cross-platform CLI
**Project Type**: Single project with CLI and library exports
**Performance Goals**: Filter 100+ messages in <1 second
**Constraints**: No database schema changes, filter at display time
**Scale/Scope**: Feature touches CLI show command, formatter, and library API

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Simplicity First | ✅ PASS | Reuses existing `isToolCall()`, `isThinking()`, `isError()` functions; minimal new code |
| II. CLI-Native Design | ✅ PASS | `--only` follows POSIX conventions; supports JSON output; meaningful error messages |
| III. Documentation-Driven | ✅ PASS | Will update README with new option; error messages list valid values |
| IV. Incremental Delivery | ✅ PASS | Single focused feature; can be tested independently |
| V. Defensive Parsing | ✅ PASS | Validates filter values; handles empty results gracefully |

**Gate Result**: PASS - No violations requiring justification.

## Project Structure

### Documentation (this feature)

```text
specs/008-message-type-filter/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── cli/
│   ├── commands/
│   │   └── show.ts         # Add --only option parsing
│   └── formatters/
│       └── table.ts        # Add filterMessages() function
├── core/
│   └── types.ts            # Add MessageType type
└── lib/
    ├── index.ts            # Export filter types
    └── types.ts            # Add MessageTypeFilter to LibraryConfig
```

**Structure Decision**: Single project structure - feature modifies existing files, no new directories needed.

## Complexity Tracking

> No violations to justify - design follows simplest path using existing detection functions.
