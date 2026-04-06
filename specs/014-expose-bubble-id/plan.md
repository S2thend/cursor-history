# Implementation Plan: Expose Bubble ID on Message Type

**Branch**: `014-expose-bubble-id` | **Date**: 2026-04-06 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/014-expose-bubble-id/spec.md`

## Summary

Expose the bubble UUID (already resolved in the core layer) through the library API's `Message` type, and surface the active branch manifest (`fullConversationHeadersOnly`) on the `Session` type. The core `Message.id` field is already populated; the gap is in the library mapping layer and JSON export functions.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: commander, picocolors, better-sqlite3/node:sqlite (existing — no new deps)
**Storage**: SQLite databases (state.vscdb files) — read-only access
**Testing**: Vitest
**Target Platform**: Node.js 20+ (cross-platform CLI + library)
**Project Type**: Single project (dual CLI + library interface)
**Performance Goals**: N/A — threads existing data through, no new queries or computation
**Constraints**: Additive-only change; zero breaking changes to existing consumers
**Scale/Scope**: ~6 files modified, ~30 lines of production code

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Simplicity First | PASS | Threads existing data through existing conversion layers. No new abstractions, no new dependencies. |
| II. CLI-Native Design | PASS | New fields appear in JSON output only (FR-008). No changes to human-readable table output. |
| III. Documentation-Driven | PASS | New fields will have JSDoc comments. CLAUDE.md updated with new type fields. |
| IV. Incremental Delivery | PASS | P1 (message ID) and P2 (active branch) are independently testable user stories. |
| V. Defensive Parsing | PASS | Null/undefined handling matches existing patterns. Missing data → field omitted, no crashes. |

No violations. No complexity tracking needed.

**Post-design re-check (after Phase 1)**: All gates still PASS. No new abstractions, dependencies, or complexity introduced by the design. The implementation threads existing data through existing layers.

## Project Structure

### Documentation (this feature)

```text
specs/014-expose-bubble-id/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── types.ts           # ChatSession: add activeBranchBubbleIds field
│   ├── storage.ts         # getSession/getGlobalSession: extract fullConversationHeadersOnly
│   └── parser.ts          # exportToJson: include message id field
├── lib/
│   ├── types.ts           # Message: add id field; Session: add activeBranchBubbleIds field
│   └── index.ts           # convertToLibrarySession: thread id and activeBranchBubbleIds
└── cli/
    └── formatters/json.ts # Already includes m.id — add activeBranchBubbleIds to session output
```

### Change Impact Summary

| File | Change | Lines |
|------|--------|-------|
| `src/core/types.ts` | Add `activeBranchBubbleIds?: string[]` to `ChatSession` | ~2 |
| `src/core/storage.ts` | Extract `fullConversationHeadersOnly` from composerData in `getSession()` and `getGlobalSession()`, map to `activeBranchBubbleIds` | ~15 |
| `src/core/parser.ts` | Add `id: m.id` to message mapping in `exportToJson()` | ~1 |
| `src/lib/types.ts` | Add `id?: string` to `Message`, `activeBranchBubbleIds?: string[]` to `Session` | ~6 |
| `src/lib/index.ts` | Add `id` and `activeBranchBubbleIds` to `convertToLibrarySession()` | ~4 |
| `src/cli/formatters/json.ts` | Add `activeBranchBubbleIds` to session JSON output | ~3 |

## Generated Artifacts

| Artifact | Path | Description |
|----------|------|-------------|
| Research | [research.md](research.md) | 7 decisions resolving all unknowns |
| Data Model | [data-model.md](data-model.md) | Entity changes, field mappings, null semantics |
| API Contract | [contracts/library-api.md](contracts/library-api.md) | Library + CLI JSON contract changes |
| Quickstart | [quickstart.md](quickstart.md) | Usage examples for library and CLI |

## Next Step

Run `/speckit.tasks` to generate the implementation task list.
