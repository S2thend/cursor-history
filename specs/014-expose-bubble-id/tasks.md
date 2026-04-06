# Tasks: Expose Bubble ID on Message Type

**Input**: Design documents from `/specs/014-expose-bubble-id/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in spec. Existing test suite validates regressions.

**Organization**: Tasks grouped by user story. US1 (P1) can be completed and validated independently as MVP. US2 (P2) builds on US1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths included in all descriptions

---

## Phase 1: Foundational (Type Definitions)

**Purpose**: Add new fields to core and library type interfaces that both user stories depend on

**Note**: No setup phase needed — this is an existing project with no new dependencies.

- [ ] T001 Add `activeBranchBubbleIds?: string[]` field to `ChatSession` interface in `src/core/types.ts` (after the `usage` field, with JSDoc: "Ordered bubble IDs of the current active conversation branch")
- [ ] T002 Add `id?: string` field to library `Message` interface in `src/lib/types.ts` (as first field, with JSDoc: "Stable bubble UUID from cursorDiskKV when available") and `activeBranchBubbleIds?: string[]` field to library `Session` interface in `src/lib/types.ts` (after `usage` field, with JSDoc: "Ordered bubble UUIDs of the active conversation branch")

**Checkpoint**: Type definitions in place. `npm run typecheck` should pass (new fields are optional).

---

## Phase 2: User Story 1 - Stable Message Identification (Priority: P1) MVP

**Goal**: Expose bubble UUID on every message returned by the library API and JSON export

**Independent Test**: Call `getSession()` via library API and verify each message has an `id` field. Run `cursor-history show 1 --json` and verify messages include `id`. Run `cursor-history export 1 -f json` and verify messages include `id`.

### Implementation for User Story 1

- [ ] T003 [P] [US1] Add `id: msg.id ?? undefined` to message mapping in `convertToLibrarySession()` function in `src/lib/index.ts` (inside the `messages.map()` callback, alongside existing `role`, `content`, `timestamp` fields)
- [ ] T004 [P] [US1] Add `id: m.id` to message mapping in `exportToJson()` function in `src/core/parser.ts` (inside the `messages.map()` callback, as the first field before `role`)

**Checkpoint**: Library API and JSON export now include message IDs. CLI JSON (`show --json`) already includes them via `formatSessionJson()` — no change needed there. Verify with `npm run typecheck`.

---

## Phase 3: User Story 2 - Active Branch Identification (Priority: P2)

**Goal**: Expose `activeBranchBubbleIds` on session objects so consumers can identify which messages are on the active conversation branch vs orphaned rewind branches

**Independent Test**: Read a session via library API and verify `activeBranchBubbleIds` is present when the session has `fullConversationHeadersOnly` in its composer metadata. Verify it is `undefined` when the manifest is absent.

**Depends on**: Phase 1 (type definitions)

### Implementation for User Story 2

- [ ] T005 [US2] Add `extractActiveBranchBubbleIds(composerDataValue: string | undefined): string[] | undefined` helper function in `src/core/storage.ts` — parses composerData JSON, reads `fullConversationHeadersOnly` array, extracts `bubbleId` string from each header object, returns `undefined` if array is absent or empty. Place near existing `parseComposerSessionUsage()` function (around line 306).
- [ ] T006 [US2] Populate `activeBranchBubbleIds` in `getSession()` return value in `src/core/storage.ts` — call `extractActiveBranchBubbleIds(composerDataRow?.value)` and add result to the returned `ChatSession` object at line 783 (the global-path return statement). Do NOT add for workspace-fallback path (research R7: would require refactoring `parseChatData()`).
- [ ] T007 [US2] Populate `activeBranchBubbleIds` in `getGlobalSession()` return value in `src/core/storage.ts` — call `extractActiveBranchBubbleIds(composerRow?.value)` and add result to the returned `ChatSession` object at line 1030.
- [ ] T008 [P] [US2] Add `activeBranchBubbleIds` passthrough in `convertToLibrarySession()` in `src/lib/index.ts` — add `activeBranchBubbleIds: coreSession.activeBranchBubbleIds` to the returned Session object (after `usage` field). Only include if defined.
- [ ] T009 [P] [US2] Add `activeBranchBubbleIds` to session JSON output in `formatSessionJson()` in `src/cli/formatters/json.ts` — add conditional block after the existing `source` output: if `session.activeBranchBubbleIds` is defined and non-empty, add `output['activeBranchBubbleIds'] = session.activeBranchBubbleIds`.
- [ ] T010 [P] [US2] Add `activeBranchBubbleIds` to export JSON output in `exportToJson()` in `src/core/parser.ts` — add conditional block after existing `usage` output: if `session.activeBranchBubbleIds` is defined and non-empty, add `exportData['activeBranchBubbleIds'] = session.activeBranchBubbleIds`.

**Checkpoint**: Sessions now include active branch bubble IDs in library API, CLI JSON, and JSON export. Verify with `npm run typecheck`.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Validation and documentation

- [ ] T011 Run `npm run typecheck` and `npm test` to verify zero regressions and all types compile cleanly
- [ ] T012 Update CLAUDE.md Recent Changes section with `014-expose-bubble-id` entry documenting: added `id` to library Message type, added `activeBranchBubbleIds` to core ChatSession and library Session types, updated `convertToLibrarySession()`, `exportToJson()`, `formatSessionJson()`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — start immediately
- **User Story 1 (Phase 2)**: Depends on Phase 1 (type definitions must exist)
- **User Story 2 (Phase 3)**: Depends on Phase 1 (type definitions must exist). Does NOT depend on Phase 2 (US1) technically, but US2 is lower priority and should be done after US1.
- **Polish (Phase 4)**: Depends on all implementation phases complete

### User Story Dependencies

- **User Story 1 (P1)**: Independent. Modifies `src/lib/index.ts` and `src/core/parser.ts`.
- **User Story 2 (P2)**: Independent of US1 at the code level (different fields), but logically depends on US1 (consumers need message IDs to cross-reference against `activeBranchBubbleIds`).

### Within Each User Story

```
Phase 1 (types) ──▶ Phase 2 (US1: T003 ∥ T004) ──▶ Phase 3 (US2: T005 → T006 → T007, then T008 ∥ T009 ∥ T010) ──▶ Phase 4 (polish)
```

### Parallel Opportunities

- **Phase 1**: T001 and T002 are sequential (T002 modifies `src/lib/types.ts` which is also type-adjacent to T001)
- **Phase 2 (US1)**: T003 and T004 are parallel (different files: `src/lib/index.ts` vs `src/core/parser.ts`)
- **Phase 3 (US2)**: T005 → T006 → T007 are sequential (same file: `src/core/storage.ts`). Then T008, T009, T010 are parallel (three different files: `src/lib/index.ts`, `src/cli/formatters/json.ts`, `src/core/parser.ts`)

---

## Parallel Example: User Story 1

```
# These two tasks can run in parallel (different files):
T003: Add id to convertToLibrarySession() in src/lib/index.ts
T004: Add id to exportToJson() in src/core/parser.ts
```

## Parallel Example: User Story 2

```
# Sequential (same file — src/core/storage.ts):
T005: Create extractActiveBranchBubbleIds() helper
T006: Use in getSession()
T007: Use in getGlobalSession()

# Then parallel (three different files):
T008: Add to convertToLibrarySession() in src/lib/index.ts
T009: Add to formatSessionJson() in src/cli/formatters/json.ts
T010: Add to exportToJson() in src/core/parser.ts
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Type definitions (T001, T002)
2. Complete Phase 2: User Story 1 (T003, T004)
3. **STOP and VALIDATE**: `npm run typecheck && npm test`
4. Library consumers can now use `Message.id` for stable identification

### Full Delivery

1. Complete MVP above
2. Complete Phase 3: User Story 2 (T005–T010)
3. Complete Phase 4: Polish (T011, T012)
4. Library consumers can now use `activeBranchBubbleIds` for branch-aware rendering

---

## Notes

- [P] tasks = different files, no dependencies between them
- [US1]/[US2] labels map tasks to spec user stories for traceability
- No new test files needed — existing test suite validates regressions
- CLI JSON `show --json` already outputs `m.id` via `formatSessionJson()` — no change needed for US1
- Total production code: ~30 lines across 6 files
- All changes are additive (optional fields only) — zero breaking changes
