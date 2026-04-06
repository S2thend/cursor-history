# Implementation Plan: Expose Bubble ID on Message Type

**Branch**: `014-expose-bubble-id` | **Date**: 2026-04-06 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/014-expose-bubble-id/spec.md`

## Summary

Expose the bubble UUID (already resolved in the core layer) through the library API's `Message` type, surface the active branch manifest (`fullConversationHeadersOnly`) on the `Session` type for global-session reads, and include message IDs in both JSON and Markdown exports. The core `Message.id` field is already populated; the remaining work is threading it through the library/export layers, adding defensive branch-manifest parsing, and documenting the degraded workspace-fallback contract.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: commander, picocolors, better-sqlite3/node:sqlite (existing — no new deps)
**Storage**: SQLite databases (state.vscdb files) — read-only access
**Testing**: Vitest
**Target Platform**: Node.js 20+ (cross-platform CLI + library)
**Project Type**: Single project (dual CLI + library interface)
**Performance Goals**: No new database queries; reuse existing composer data rows and keep branch-manifest parsing bounded to existing session metadata
**Constraints**: Additive-only change; zero breaking changes to existing consumers
**Scale/Scope**: ~11 files modified across production code, tests, and release notes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Simplicity First | PASS | Threads existing data through existing conversion layers. No new abstractions, no new dependencies. |
| II. CLI-Native Design | PASS | New fields appear in JSON output only (FR-008). No changes to human-readable table output. |
| III. Documentation-Driven | PASS | New fields will have JSDoc comments, a CHANGELOG entry, and manual validation on real Cursor data. |
| IV. Incremental Delivery | PASS | P1 (message ID) and P2 (active branch) are independently testable user stories. |
| V. Defensive Parsing | PASS | Invalid `composerData`, non-array manifests, and malformed headers fail soft to `undefined`; workspace-fallback remains explicitly degraded. |

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
│   ├── storage.ts         # getSession/getGlobalSession: extract fullConversationHeadersOnly defensively
│   └── parser.ts          # exportToJson/exportToMarkdown: include message id field
├── lib/
│   ├── types.ts           # Message: add id field; Session: add activeBranchBubbleIds field
│   └── index.ts           # convertToLibrarySession: thread id and activeBranchBubbleIds
└── cli/
    └── formatters/json.ts # Already includes m.id — add activeBranchBubbleIds to session output
```

### Tests & Docs

```text
tests/unit/
├── storage.test.ts              # activeBranchBubbleIds extraction and defensive parsing
├── lib-index.test.ts            # library Message.id / Session.activeBranchBubbleIds passthrough
├── parser.test.ts               # JSON + Markdown export message IDs and export JSON branch IDs
└── cli-formatters-json.test.ts  # show --json activeBranchBubbleIds output

CHANGELOG.md                     # user-facing additive API/export notes
```

### Change Impact Summary

| File | Change | Lines |
|------|--------|-------|
| `src/core/types.ts` | Add `activeBranchBubbleIds?: string[]` to `ChatSession` | ~2 |
| `src/core/storage.ts` | Add defensive `fullConversationHeadersOnly` extraction in `getSession()` and `getGlobalSession()` | ~20 |
| `src/core/parser.ts` | Add message IDs to `exportToJson()` and `exportToMarkdown()`, add `activeBranchBubbleIds` to export JSON | ~10 |
| `src/lib/types.ts` | Add `id?: string` to `Message`, `activeBranchBubbleIds?: string[]` to `Session` | ~6 |
| `src/lib/index.ts` | Add `id` and `activeBranchBubbleIds` to `convertToLibrarySession()` | ~4 |
| `src/cli/formatters/json.ts` | Add `activeBranchBubbleIds` to session JSON output | ~3 |
| `tests/unit/storage.test.ts` | Add manifest extraction, malformed metadata, empty-manifest, and workspace-fallback tests | ~40 |
| `tests/unit/lib-index.test.ts` | Add library passthrough tests for `Message.id` and `Session.activeBranchBubbleIds` | ~20 |
| `tests/unit/parser.test.ts` | Add JSON/Markdown export tests for message IDs and export JSON branch IDs | ~30 |
| `tests/unit/cli-formatters-json.test.ts` | Add CLI JSON formatter coverage for `activeBranchBubbleIds` | ~10 |
| `CHANGELOG.md` | Add release note for additive library/export fields | ~5 |

## Generated Artifacts

| Artifact | Path | Description |
|----------|------|-------------|
| Research | [research.md](research.md) | 7 decisions resolving all unknowns |
| Data Model | [data-model.md](data-model.md) | Entity changes, field mappings, null semantics |
| API Contract | [contracts/library-api.md](contracts/library-api.md) | Library, CLI JSON, and export contract changes |
| Quickstart | [quickstart.md](quickstart.md) | Usage examples for library and CLI |

## Next Step

Proceed with implementation using `tasks.md`.
