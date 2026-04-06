# Tasks: Expose Bubble ID on Message Type

**Input**: Design documents from `/specs/014-expose-bubble-id/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Explicit unit coverage is required for library mapping, export output, branch-manifest parsing, and degraded-mode behavior, followed by full regression runs and manual validation.

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

**Goal**: Expose bubble UUID on every message returned by the library API and by both JSON and Markdown exports

**Independent Test**: Call `getSession()` via library API and verify each message has an `id` field. Run `cursor-history show 1 --json` and verify messages include `id`. Run `cursor-history export 1 -f json` and `cursor-history export 1 -f markdown` and verify message IDs are included when available.

### Implementation for User Story 1

- [ ] T003 [P] [US1] Add `id: msg.id ?? undefined` to message mapping in `convertToLibrarySession()` function in `src/lib/index.ts` (inside the `messages.map()` callback, alongside existing `role`, `content`, `timestamp` fields)
- [ ] T004 [P] [US1] Add `id: m.id` to message mapping in `exportToJson()` function in `src/core/parser.ts` (inside the `messages.map()` callback, as the first field before `role`)
- [ ] T005 [US1] Update `exportToMarkdown()` in `src/core/parser.ts` to include a message ID metadata line for each message when `message.id` is available (for example, immediately under the message heading before the content)
- [ ] T006 [P] [US1] Extend `tests/unit/lib-index.test.ts` to verify library `getSession()` returns `Message.id` and omits it when the core message ID is `null`
- [ ] T007 [US1] Extend `tests/unit/parser.test.ts` to verify `exportToJson()` includes message IDs and `exportToMarkdown()` renders message IDs only when available

**Checkpoint**: Library API, JSON export, and Markdown export now include message IDs when available. CLI JSON (`show --json`) already includes them via `formatSessionJson()` — no change needed there for US1. Verify with `npm run typecheck`.

---

## Phase 3: User Story 2 - Active Branch Identification (Priority: P2)

**Goal**: Expose `activeBranchBubbleIds` on session objects so consumers can identify which messages are on the active conversation branch vs orphaned rewind branches

**Independent Test**: Read a session via library API and verify `activeBranchBubbleIds` is present when the session has `fullConversationHeadersOnly` in its composer metadata. Verify it is `undefined` when the manifest is absent, empty, malformed, or when the session source is `workspace-fallback`.

**Depends on**: Phase 1 (type definitions)

### Implementation for User Story 2

- [ ] T008 [US2] Add `extractActiveBranchBubbleIds(composerDataValue: string | undefined): string[] | undefined` helper function in `src/core/storage.ts` — parse `composerData`, read `fullConversationHeadersOnly`, extract valid `bubbleId` strings in order, ignore malformed entries, and return `undefined` for invalid JSON, non-array manifests, absent manifests, or empty result sets. Place near `parseComposerSessionUsage()`.
- [ ] T009 [US2] Populate `activeBranchBubbleIds` in the global-path return value of `getSession()` in `src/core/storage.ts` — call `extractActiveBranchBubbleIds(composerDataRow?.value)` and add the result to the returned `ChatSession`. Keep workspace-fallback returns `undefined` for this field so degraded sessions do not expose a partial branch-matching contract.
- [ ] T010 [US2] Populate `activeBranchBubbleIds` in `getGlobalSession()` in `src/core/storage.ts` — call `extractActiveBranchBubbleIds(composerRow?.value)` and add the result to the returned `ChatSession`.
- [ ] T011 [P] [US2] Add `activeBranchBubbleIds` passthrough in `convertToLibrarySession()` in `src/lib/index.ts` — add `activeBranchBubbleIds: coreSession.activeBranchBubbleIds` to the returned Session object (after `usage` field). Only include if defined.
- [ ] T012 [P] [US2] Add `activeBranchBubbleIds` to session JSON output in `formatSessionJson()` in `src/cli/formatters/json.ts` — add a conditional block after the existing `source` output when the field is defined.
- [ ] T013 [P] [US2] Add `activeBranchBubbleIds` to export JSON output in `exportToJson()` in `src/core/parser.ts` — add a conditional block after existing `usage` output when the field is defined.
- [ ] T014 [US2] Extend `tests/unit/storage.test.ts` to cover valid manifest extraction, invalid JSON, non-array manifests, malformed header entries, empty manifests, and the workspace-fallback omission contract
- [ ] T015 [P] [US2] Extend `tests/unit/lib-index.test.ts` and `tests/unit/cli-formatters-json.test.ts` to verify `Session.activeBranchBubbleIds` passes through the library API and appears in CLI JSON only when defined
- [ ] T016 [US2] Extend `tests/unit/parser.test.ts` to verify `exportToJson()` includes `activeBranchBubbleIds` when defined and omits it when undefined

**Checkpoint**: Sessions now include active branch bubble IDs in library API, CLI JSON, and JSON export. Verify with `npm run typecheck`.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Validation and documentation

- [ ] T017 Run `npm run typecheck` and `npm test` to verify zero regressions and all types compile cleanly
- [ ] T018 Perform manual validation on real Cursor data: verify `show --json`, `export -f json`, and `export -f markdown` output for a normal session, a rewound session, and a workspace-fallback session if available
- [ ] T019 Update `CHANGELOG.md` with the additive library/API/export changes (`Message.id`, `Session.activeBranchBubbleIds`, JSON output, Markdown export IDs)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — start immediately
- **User Story 1 (Phase 2)**: Depends on Phase 1 (type definitions must exist)
- **User Story 2 (Phase 3)**: Depends on Phase 1 (type definitions must exist). Does NOT depend on Phase 2 (US1) technically, but US2 is lower priority and should be done after US1.
- **Polish (Phase 4)**: Depends on all implementation phases complete

### User Story Dependencies

- **User Story 1 (P1)**: Independent. Modifies `src/lib/index.ts`, `src/core/parser.ts`, and related tests.
- **User Story 2 (P2)**: Independent of US1 at the code level (different fields), but logically depends on US1 (consumers need message IDs to cross-reference against `activeBranchBubbleIds`).

### Within Each User Story

```
Phase 1 (types) ──▶ Phase 2 (US1: T003 ∥ T004 → T005, then T006 ∥ T007) ──▶ Phase 3 (US2: T008 → T009 → T010, then T011 ∥ T012 ∥ T013 ∥ T014 ∥ T015, then T016) ──▶ Phase 4 (T017 → T018 ∥ T019)
```

### Parallel Opportunities

- **Phase 1**: T001 and T002 are parallel (different files)
- **Phase 2 (US1)**: T003 and T004 are parallel. T005 follows T004 (same file). T006 and T007 are parallel after implementation (different test files).
- **Phase 3 (US2)**: T008 → T009 → T010 are sequential (same file: `src/core/storage.ts`). Then T011, T012, T013, T014, and T015 are parallel (different files). T016 follows T013 because it validates parser export behavior in the same file.

---

## Parallel Example: User Story 1

```
# These tasks can run in parallel (different files):
T003: Add id to convertToLibrarySession() in src/lib/index.ts
T004: Add id to exportToJson() in src/core/parser.ts
T006: Add library API tests in tests/unit/lib-index.test.ts
```

## Parallel Example: User Story 2

```
# Sequential (same file — src/core/storage.ts):
T008: Create extractActiveBranchBubbleIds() helper
T009: Use in getSession()
T010: Use in getGlobalSession()

# Then parallel (different files):
T011: Add to convertToLibrarySession() in src/lib/index.ts
T012: Add to formatSessionJson() in src/cli/formatters/json.ts
T013: Add to exportToJson() in src/core/parser.ts
T014: Add storage tests in tests/unit/storage.test.ts
T015: Add library/CLI JSON tests in tests/unit/lib-index.test.ts and tests/unit/cli-formatters-json.test.ts
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Type definitions (T001, T002)
2. Complete Phase 2: User Story 1 (T003-T007)
3. **STOP and VALIDATE**: `npm run typecheck && npm test`
4. Library consumers can now use `Message.id` for stable identification

### Full Delivery

1. Complete MVP above
2. Complete Phase 3: User Story 2 (T008-T016)
3. Complete Phase 4: Polish (T017-T019)
4. Library consumers can now use `activeBranchBubbleIds` for branch-aware rendering

---

## Notes

- [P] tasks = different files, no dependencies between them
- [US1]/[US2] labels map tasks to spec user stories for traceability
- No new test files required — extend existing unit tests with explicit coverage for the new fields and defensive parsing behavior
- CLI JSON `show --json` already outputs `m.id` via `formatSessionJson()` — no change needed for US1
- Total production code remains small and additive; most of the extra scope is explicit tests and release-note/manual-validation work
- All changes are additive (optional fields only) — zero breaking changes
