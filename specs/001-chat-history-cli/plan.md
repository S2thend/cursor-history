# Implementation Plan: Cursor Chat History CLI

**Branch**: `001-chat-history-cli` | **Date**: 2025-12-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-chat-history-cli/spec.md`

## Summary

Build a CLI tool (`cursor-history`) that reads Cursor's chat history from the local
filesystem and provides commands to list, view, search, and export conversations.
Uses flag-based invocation (`--list`, `--show <id>`, etc.) with JSON output support
for scripting. Organized by workspace/directory with numeric indexing for chat sessions.

## Technical Context

**Language/Version**: TypeScript 5.0+ (strict mode)
**Runtime**: Node.js 20 LTS (Bun for standalone binary)
**Primary Dependencies**: commander (CLI), better-sqlite3 (SQLite), picocolors (terminal)
**Storage**: Read-only SQLite (`state.vscdb`) with JSON blobs in `ItemTable`
**Testing**: Vitest
**Target Platform**: Windows, macOS, Linux (cross-platform CLI)
**Project Type**: Single project with CLI + core library separation
**Performance Goals**: List <2s, Show <3s, Search <5s for 1000 sessions (per SC-001/002/003)
**Constraints**: Standalone binary via `bun build --compile`, minimal dependencies
**Scale/Scope**: Personal tool, single-user, local filesystem only

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Simplicity First | Minimal dependencies, no over-engineering | ✅ Pass |
| II. CLI-Native Design | Flag-based, stdin/stdout, exit codes, --json | ✅ Pass |
| III. Documentation-Driven | README, --help with examples, CHANGELOG | ✅ Pass |
| IV. Incremental Delivery | P1→P4 user stories, MVP = list + view | ✅ Pass |
| V. Defensive Parsing | Handle corrupted files, unknown formats | ✅ Pass |

**Technical Standards Compliance**:
- TypeScript strict mode ✅
- Core logic decoupled from CLI for future GUI ✅
- Vitest for testing ✅
- ESLint + Prettier ✅

**All gates pass. Proceeding to Phase 0.**

## Project Structure

### Documentation (this feature)

```text
specs/001-chat-history-cli/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (CLI interface spec)
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/                # Core library (GUI-ready)
│   ├── parser.ts        # Cursor data file parser
│   ├── types.ts         # Data models (Workspace, ChatSession, Message)
│   ├── storage.ts       # Data path detection, file reading
│   └── index.ts         # Public API exports
├── cli/                 # CLI entry point
│   ├── index.ts         # Main CLI with flag parsing
│   ├── commands/        # Individual command handlers
│   │   ├── list.ts
│   │   ├── show.ts
│   │   ├── search.ts
│   │   └── export.ts
│   └── formatters/      # Output formatting (human/JSON)
│       ├── table.ts
│       └── json.ts
└── lib/                 # Shared utilities
    └── platform.ts      # OS detection, path resolution

tests/
├── unit/                # Unit tests for core logic
├── integration/         # CLI integration tests
└── fixtures/            # Sample Cursor data files for testing
```

**Structure Decision**: Single project with `src/core` separated from `src/cli` to enable
future GUI (Electron/Tauri) that imports from `src/core` without CLI dependencies.

## Complexity Tracking

No violations. All gates pass with simplest approach.
