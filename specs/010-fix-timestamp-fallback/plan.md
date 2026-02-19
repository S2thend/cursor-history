# Implementation Plan: Fix Timestamp Fallback for Pre-2025-09 Sessions

**Branch**: `010-fix-timestamp-fallback` | **Date**: 2026-02-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-fix-timestamp-fallback/spec.md`

## Summary

Fix incorrect message timestamps in pre-2025-09 Cursor sessions. Currently, bubbles without a `createdAt` field fall back to `new Date()` (current time). The fix introduces a priority-based timestamp resolution chain: `createdAt` > `timingInfo.clientRpcSendTime` > `timingInfo.clientSettleTime`/`clientEndTime` > neighbor interpolation > session creation time > current time. This involves extending the `RawBubbleData` interface, extracting a shared `extractTimestamp()` function, adding a two-pass timestamp resolution (direct extraction + gap filling), and threading session creation time into the message mapping code paths.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: commander, picocolors, better-sqlite3 / node:sqlite (existing)
**Storage**: SQLite databases (`state.vscdb` files) - read-only access
**Testing**: Vitest (unit tests in `tests/unit/`)
**Target Platform**: Node.js 20 LTS / Node.js 22.5+ (dual SQLite driver support)
**Project Type**: Single project (CLI + Library sharing core)
**Performance Goals**: N/A (bug fix, no new performance requirements)
**Constraints**: Read-only database access; no schema changes; backward compatible
**Scale/Scope**: Affects 2 code locations in `src/core/storage.ts`, 1 interface in `src/core/storage.ts`, no API surface changes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Simplicity First | PASS | Single function extraction + interface extension. Minimal change surface. |
| II. CLI-Native Design | PASS | No CLI interface changes. Timestamps display correctly where they already appear. |
| III. Documentation-Driven | PASS | Bug fix with clear rationale. CLAUDE.md will be updated with new extraction functions. |
| IV. Incremental Delivery | PASS | P1/P2/P3 are independently testable user stories. Can ship P1 alone. |
| V. Defensive Parsing | PASS | Validates timestamp values before use (> 1,000,000,000,000). Graceful fallback chain. Unknown fields ignored. |

No violations. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/010-fix-timestamp-fallback/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── storage.ts       # PRIMARY: extractTimestamp(), fillTimestampGaps(), updated RawBubbleData
│   └── types.ts         # No changes needed (Message.timestamp already Date)
├── cli/
│   └── (no changes)     # Formatters already consume Message.timestamp
└── lib/
    └── (no changes)     # Library API already delegates to core storage

tests/
└── unit/
    └── storage.test.ts  # New tests for extractTimestamp(), fillTimestampGaps()
```

**Structure Decision**: This is a targeted bug fix within the existing single-project structure. All changes are in `src/core/storage.ts` (logic) and `tests/unit/storage.test.ts` (tests). No new files, directories, or modules needed.
