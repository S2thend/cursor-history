# Implementation Plan: Library API for Cursor History Access

**Branch**: `002-library-api` | **Date**: 2025-12-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-library-api/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

**IMPORTANT**: This is a **library interface** for direct import and use in TypeScript/JavaScript projects, NOT a network/REST API. We're exposing TypeScript functions for direct import: `import { listSessions } from 'cursor-history'`

## Summary

Transform the cursor-history CLI tool into a reusable library by extracting core functionality from `src/core/` into standalone, stateless API functions. The library will provide named function exports (`listSessions`, `getSession`, `searchSessions`, `exportSession`) that open/close database connections automatically per call, eliminating the need for instance lifecycle management. The CLI will be refactored to consume the library, ensuring feature parity while enabling programmatic access for custom tools, analytics dashboards, and automation workflows.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: better-sqlite3 (existing), no CLI dependencies (commander/picocolors removed from library)
**Storage**: SQLite databases (state.vscdb) - read-only access via better-sqlite3
**Testing**: Vitest for unit/integration tests, focus on parsing edge cases and API contract validation
**Target Platform**: Node.js 20 LTS (ESM and CommonJS dual exports)
**Project Type**: Single project with library + CLI separation
**Performance Goals**: Handle 1000+ message sessions without memory issues; stateless design prioritizes simplicity over connection pooling
**Constraints**: Read-only operations; no automatic retries; skip corrupted entries with warnings
**Scale/Scope**: Library API covering ~4 core functions (list, get, search, export) with pagination support (limit/offset)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| **I. Simplicity First** | ✅ PASS | Stateless functional API (no classes/factories) is simplest design. Reuses existing storage.ts/parser.ts logic. No new dependencies added. |
| **II. CLI-Native Design** | ✅ PASS | CLI remains primary interface; library enables programmatic access without compromising CLI UX. Exit codes and output formats preserved. |
| **III. Documentation-Driven** | ✅ PASS | Will generate quickstart.md with usage examples. TypeScript definitions provide inline documentation. Error messages remain actionable. |
| **IV. Incremental Delivery** | ✅ PASS | P1 (list/get) → P2 (search/config) → P3 (export) priority clearly defined. Each story independently testable. |
| **V. Defensive Parsing** | ✅ PASS | Existing parsing handles malformed input; library inherits this. Corrupted entries skipped with warnings (FR-015). |
| **TypeScript Standards** | ✅ PASS | Strict mode enabled, ESLint + Prettier enforced, dual ESM/CJS exports via package.json configuration. |
| **GUI Extensibility** | ✅ PASS | Library decouples core logic from CLI, enabling future Electron/Tauri GUI without refactoring data access layer. |

**Initial Assessment**: All gates PASS. No violations requiring justification.

**Post-Design Re-evaluation** (2025-12-22 after Phase 1):

| Principle | Status | Post-Design Notes |
|-----------|--------|-------------------|
| **I. Simplicity First** | ✅ PASS | Research.md confirms: no bundler needed, no connection pooling, no external error libraries. All decisions favor simplicity. |
| **II. CLI-Native Design** | ✅ PASS | Quickstart.md demonstrates library doesn't compromise CLI patterns. Stateless design actually simplifies CLI integration. |
| **III. Documentation-Driven** | ✅ PASS | Artifacts delivered: quickstart.md (usage examples), contracts/api.ts (full JSDoc), data-model.md (type documentation). |
| **IV. Incremental Delivery** | ✅ PASS | Data model shows clear entity boundaries. Each P1/P2/P3 story maps to specific functions (listSessions, searchSessions, exportSession). |
| **V. Defensive Parsing** | ✅ PASS | Data model includes metadata.corrupted flag, validation rules documented. Console.warn for skipped entries (no silent failures). |
| **TypeScript Standards** | ✅ PASS | Contracts show full type coverage. Declaration maps enabled. No `any` types in public API. |
| **GUI Extensibility** | ✅ PASS | Project structure confirms src/lib/ is independent of src/cli/. Future GUI can import same functions as CLI. |

**Final Assessment**: All gates still PASS post-design. Design decisions strengthen adherence to principles.

## Project Structure

### Documentation (this feature)

```text
specs/002-library-api/
├── spec.md              # Feature specification (completed)
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (to be generated)
├── data-model.md        # Phase 1 output (to be generated)
├── quickstart.md        # Phase 1 output (to be generated)
├── contracts/           # Phase 1 output (to be generated)
│   └── api.ts           # TypeScript API type definitions
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── lib/                 # Library API (NEW - public exports)
│   ├── index.ts         # Main entry point with named function exports
│   ├── types.ts         # Public TypeScript type definitions
│   ├── config.ts        # Config handling and default path resolution
│   └── errors.ts        # Custom error classes (DatabaseLockedError, etc.)
├── core/                # Core business logic (REFACTORED - internal use)
│   ├── storage.ts       # Database access (extract stateless functions)
│   ├── parser.ts        # Data parsing and formatting
│   ├── types.ts         # Internal type definitions
│   └── index.ts         # Internal exports for CLI
├── cli/                 # CLI implementation (REFACTORED - uses lib/)
│   ├── commands/        # Command implementations (list, show, search, export)
│   ├── formatters/      # Output formatters (table, json)
│   └── index.ts         # CLI entry point
└── platform/            # Platform utilities (RENAMED from lib/)
    ├── paths.ts         # Platform-specific path resolution
    └── errors.ts        # Legacy error handling (may be consolidated)

tests/
├── lib/                 # Library API tests (NEW)
│   ├── integration/     # End-to-end library usage tests
│   └── unit/            # Unit tests for individual functions
├── core/                # Core logic tests (EXISTING)
└── cli/                 # CLI tests (EXISTING - update to use lib/)
```

**Structure Decision**: Single project structure maintained. Key changes:
1. **NEW `src/lib/`**: Public library API with stateless function exports
2. **REFACTORED `src/core/`**: Made internal-only, extracted from CLI formatters
3. **RENAMED `src/lib/` → `src/platform/`**: Avoid naming conflict with new library
4. **UPDATED `src/cli/`**: Refactored to consume `src/lib/` functions

This structure ensures:
- Clear separation between public API (`src/lib/`) and internal implementation (`src/core/`)
- CLI can import from `src/lib/` just like external consumers
- Existing tests remain valid with minimal updates
- Tree-shaking friendly (named exports at library root)

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. This section intentionally left empty.
