# Implementation Plan: Pluggable SQLite Driver

**Branch**: `006-pluggable-sqlite-driver` | **Date**: 2026-01-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-pluggable-sqlite-driver/spec.md`

## Summary

Create a pluggable SQLite driver abstraction layer that enables cursor-history to work across Node.js versions (v20, v22, v24+) by auto-detecting available drivers (node:sqlite first, better-sqlite3 fallback). The abstraction provides a unified interface while maintaining full backward compatibility with existing `openDatabase()` and `openDatabaseReadWrite()` functions.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode)
**Primary Dependencies**: better-sqlite3 (existing), node:sqlite (built-in Node 22.5+)
**Storage**: SQLite databases (state.vscdb files) - read-only for queries, read-write for migrations
**Testing**: Vitest for unit/integration tests
**Target Platform**: Node.js 20 LTS, 22 LTS, 24+
**Project Type**: Single project (CLI + Library)
**Performance Goals**: Driver auto-selection < 100ms at startup
**Constraints**: Backward compatible API, synchronous-only operations
**Scale/Scope**: Minimal - 4 new TypeScript files, modifications to 2 existing files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence/Notes |
|-----------|--------|----------------|
| **I. Simplicity First** | ✅ PASS | Driver interface exposes only common subset (prepare, get, all, run, exec, close). No over-abstraction. |
| **II. CLI-Native Design** | ✅ PASS | Environment variable override (`CURSOR_HISTORY_SQLITE_DRIVER`) follows POSIX conventions. Debug output to stderr. |
| **III. Documentation-Driven** | ✅ PASS | Spec complete, error messages include actionable remediation steps. |
| **IV. Incremental Delivery** | ✅ PASS | P1 (auto-detect) deliverable independently from P2 (manual) and P3 (runtime switch). |
| **V. Defensive Parsing** | ✅ PASS | Silent fallback on driver import failure. Validation before use. Clear errors when no driver available. |
| **Technical Standards** | ✅ PASS | TypeScript strict mode, Vitest testing, ESLint+Prettier. Core logic decoupled from CLI. |

**Gate Result**: PASS - No violations. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/006-pluggable-sqlite-driver/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (TypeScript interfaces)
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── database/              # NEW: Driver abstraction layer
│   │   ├── types.ts           # Database, Statement, DatabaseDriver interfaces
│   │   ├── registry.ts        # DriverRegistry singleton, auto-detection logic
│   │   ├── drivers/
│   │   │   ├── better-sqlite3.ts  # better-sqlite3 adapter
│   │   │   └── node-sqlite.ts     # node:sqlite adapter
│   │   └── index.ts           # Public exports: openDatabase, openDatabaseReadWrite, getActiveDriver, setDriver
│   ├── storage.ts             # MODIFIED: Import from database/ instead of better-sqlite3 directly
│   ├── migrate.ts             # MODIFIED: Import from database/
│   ├── backup.ts              # MODIFIED: Import from database/
│   └── ...
├── lib/
│   ├── types.ts               # MODIFIED: Add sqliteDriver to LibraryConfig
│   ├── config.ts              # MODIFIED: Handle sqliteDriver option
│   └── ...
└── cli/
    └── ...

tests/
├── unit/
│   └── database/              # NEW: Driver tests
│       ├── registry.test.ts
│       ├── better-sqlite3.test.ts
│       └── node-sqlite.test.ts
└── integration/
    └── driver-switching.test.ts  # NEW: Cross-driver integration tests
```

**Structure Decision**: Extends existing single-project structure. New `src/core/database/` module encapsulates driver abstraction while keeping changes to existing files minimal.

## Complexity Tracking

> No violations requiring justification. Design follows simplest approach:
> - Interface with only 6 methods (common subset)
> - Singleton registry (no DI framework)
> - Environment variable for config (no config files)

## Post-Design Constitution Re-Check

*Re-evaluated after Phase 1 design completion.*

| Principle | Status | Post-Design Notes |
|-----------|--------|-------------------|
| **I. Simplicity First** | ✅ PASS | 4 new files, minimal interface (6 methods). No over-abstraction. |
| **II. CLI-Native Design** | ✅ PASS | Env var config, stderr debug output, meaningful exit codes preserved. |
| **III. Documentation-Driven** | ✅ PASS | quickstart.md, contracts/, data-model.md all generated. |
| **IV. Incremental Delivery** | ✅ PASS | P1 auto-detect is standalone MVP. P2/P3 layer on top. |
| **V. Defensive Parsing** | ✅ PASS | Silent fallback, clear error messages, validation before use. |
| **Technical Standards** | ✅ PASS | TypeScript strict, Vitest tests planned, ESLint/Prettier. |

**Post-Design Gate Result**: PASS - Ready for `/speckit.tasks`
