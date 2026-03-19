# Implementation Plan: Fix Session Data Integrity

**Branch**: `012-fix-session-data-integrity` | **Date**: 2026-03-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/012-fix-session-data-integrity/spec.md`

## Summary

Fix a data integrity bug where `getSession()` and `listSessions()` can return sessions with only `role: 'user'` messages, dropping assistant responses and tool call data. Root causes: (1) silent fallback from global storage to workspace parsing swallows errors and returns prompt snapshots as `role: 'user'`, (2) empty assistant bubbles are silently filtered out by `content.length > 0`, (3) `message.toolCalls` is never populated despite the type existing. Fix involves replacing silent error swallowing with debug logging, preserving empty bubbles with `[empty message]` placeholder, populating structured `toolCalls`, and adding a `source` field to distinguish global vs workspace-fallback sessions.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: better-sqlite3 / node:sqlite (pluggable), commander, picocolors
**Storage**: SQLite databases (state.vscdb files) — read-only access
**Testing**: Vitest
**Target Platform**: Node.js 20+ (cross-platform: macOS, Linux, Windows)
**Project Type**: Single project (CLI + library sharing core)
**Performance Goals**: N/A (bug fix, no new perf requirements)
**Constraints**: Non-breaking change — new fields are optional, existing API contracts preserved
**Scale/Scope**: 7-9 files modified across core/lib/cli/docs layers, ~250-350 lines changed

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Simplicity First | ✅ Pass | Minimal changes to existing functions; no new abstractions. `[empty message]` placeholder follows existing `[Thinking]`/`[Error]` pattern. |
| II. CLI-Native Design | ✅ Pass | CLI `show` command gets a visual indicator for degraded sessions, and CLI JSON output will include `source` for machine-readable parity. |
| III. Documentation-Driven | ✅ Pass | Types are self-documenting with JSDoc. Both `CHANGELOG.md` and `CLAUDE.md` will be updated for this user-facing change. |
| IV. Incremental Delivery | ✅ Pass | Each fix (debug logging, empty bubble preservation, toolCalls population, source field) has explicit verification tasks, plus manual validation on real Cursor exports before merge. |
| V. Defensive Parsing | ✅ Pass | This fix directly improves defensive parsing: malformed bubbles become corrupted placeholders instead of being silently dropped; global load failures are logged instead of swallowed. |

No violations. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/012-fix-session-data-integrity/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (files to modify)

```text
src/
├── core/
│   ├── storage.ts         # PRIMARY: bubble mapping, getSession(), getGlobalSession(), extractBubbleText()
│   ├── types.ts           # Add source field to ChatSession
│   └── database/
│       └── debug.ts       # Extend debug logging for storage operations (new namespace)
├── cli/
│   └── formatters/
│       ├── table.ts       # Show degraded session indicator in CLI output
│       └── json.ts        # Include source in CLI JSON session output
└── lib/
    ├── types.ts           # Add source field to Session (already has metadata.corrupted)
    └── index.ts           # Thread source field through convertToLibrarySession()
```

**Structure Decision**: Existing single-project structure. All changes are modifications to existing files plus documentation updates in `CHANGELOG.md` and `CLAUDE.md` — no new files needed.
