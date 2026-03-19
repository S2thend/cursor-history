# Tasks: Fix Session Data Integrity

**Input**: Design documents from `/specs/012-fix-session-data-integrity/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Story-level verification tasks and final regression/manual validation tasks are included. New automated tests are not explicitly required by the spec; existing suites plus targeted manual checks cover the acceptance criteria.

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Exact file paths included in descriptions

---

## Phase 1: Setup

**Purpose**: No project initialization needed — existing codebase, branch already created.

- [ ] T001 Verify branch `012-fix-session-data-integrity` is checked out and builds cleanly with `npm run build`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Extract shared helper and debug infrastructure that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T002 [P] Add `debugLogStorage(message: string)` function in `src/core/database/debug.ts` using `[cursor-history:storage]` namespace prefix, same env var check as existing `debugLog()`
- [ ] T003 Extract shared `mapBubbleToMessage(row: { key: string; value: string }): Message | null` helper function in `src/core/storage.ts` from the duplicated bubble-to-message mapping logic in `getSession()` (lines ~482-517) and `getGlobalSession()` (lines ~772-807). As part of the extraction, set `metadata.bubbleType` from `data.type` on parsed returned messages for debugging visibility. Treat this as an intentional behavioral/output change, not a refactor-only task. (FR-011)
- [ ] T004 Refactor `getSession()` in `src/core/storage.ts` to call `mapBubbleToMessage()` instead of inline mapping. Verify no additional output changes beyond the intentional `metadata.bubbleType` population from T003.
- [ ] T005 Refactor `getGlobalSession()` in `src/core/storage.ts` to call `mapBubbleToMessage()` instead of inline mapping. Verify no additional output changes beyond the intentional `metadata.bubbleType` population from T003.

**Checkpoint**: Both `getSession()` and `getGlobalSession()` use the shared helper. Build passes. `metadata.bubbleType` is populated when available; other behavior remains unchanged.

---

## Phase 3: User Story 1 — Library consumers get complete conversation data (Priority: P1) 🎯 MVP

**Goal**: Fix the core data integrity bug — preserve all bubbles including empty and malformed ones, so `getSession()` returns the real conversation with both user and assistant roles.

**Independent Test**: Call `getSession()` against a session with known global bubble data containing type=2 assistant bubbles. Verify returned messages include both `role: 'user'` and `role: 'assistant'`.

### Implementation for User Story 1

- [ ] T006 [US1] In `mapBubbleToMessage()` in `src/core/storage.ts`, replace the `content.length > 0` filter: when `extractBubbleText()` returns empty string, set `content` to `'[empty message]'` instead of filtering the message out. Applies to both user and assistant bubbles. (FR-002, FR-006)
- [ ] T007 [US1] In `mapBubbleToMessage()` in `src/core/storage.ts`, handle malformed bubble JSON: when `JSON.parse(row.value)` throws, create a corrupted placeholder message with `content: '[corrupted message]'`, `role: 'assistant'` (default — actual type unknowable from malformed data), `metadata: { corrupted: true }`, and log the parse error via `debugLogStorage()`. Return the placeholder instead of `null`. (FR-009, FR-010)
- [ ] T008 [US1] Update `mapBubbleToMessage()` return type from `Message | null` to `Message` in `src/core/storage.ts`, since after T006 and T007 it always returns a message. Remove the `.filter(m !== null && m.content.length > 0)` from both call sites in `getSession()` and `getGlobalSession()` — no filter needed. (FR-006, FR-008)
- [ ] T021 [US1] Verify via `src/core/storage.ts` `getSession()` that a known session with assistant bubbles, empty bubbles, and malformed rows returns both roles, preserves `[empty message]`, and marks corrupted placeholders with `metadata.corrupted = true`. (SC-001, SC-003, SC-007)

**Checkpoint**: `getSession()` preserves all bubbles. Empty bubbles show `[empty message]`. Malformed bubbles show `[corrupted message]` with `metadata.corrupted = true`. Assistant messages no longer silently disappear.

---

## Phase 4: User Story 2 — Structured tool call data on messages (Priority: P2)

**Goal**: Populate `message.toolCalls` with structured `ToolCall` data from `toolFormerData`, so library consumers can programmatically inspect tool usage.

**Independent Test**: Call `getSession()` on a session with known tool activity. Verify `message.toolCalls` contains entries with `name`, `params`, `status`.

### Implementation for User Story 2

- [ ] T009 [US2] Create `extractToolCalls(data: Record<string, unknown>): ToolCall[] | undefined` helper function in `src/core/storage.ts`. Extract `name` from `toolFormerData.name`, determine `status` (error > cancelled > completed default), parse `params` with `{ _raw: rawString }` fallback for invalid JSON, extract `result`, extract `files` from param file path fields using `getParam()`. Return `undefined` if no `toolFormerData.name`. (FR-003)
- [ ] T010 [US2] Integrate `extractToolCalls()` into `mapBubbleToMessage()` in `src/core/storage.ts` — set `toolCalls` field on the returned message object. (FR-003, FR-008)
- [ ] T022 [US2] Verify via `src/core/storage.ts` `getSession()` that tool activity produces populated `toolCalls`, invalid params use `{ _raw: ... }`, and missing explicit status defaults to `completed`. (SC-002)

**Checkpoint**: `message.toolCalls` is populated for all messages with `toolFormerData.name`. Invalid params use `{ _raw }` sentinel. Status defaults to `'completed'` when not explicit.

---

## Phase 5: User Story 3 — Fallback sessions marked as degraded (Priority: P2)

**Goal**: Add `source` field to sessions so consumers can distinguish full global data from degraded workspace-fallback prompt snapshots.

**Independent Test**: Force a global storage failure. Verify returned session has `source: 'workspace-fallback'`. Load a normal session and verify `source: 'global'`.

### Implementation for User Story 3

- [ ] T011 [P] [US3] Add optional `source?: 'global' | 'workspace-fallback'` field to `ChatSession` interface in `src/core/types.ts` with JSDoc comment. (FR-004)
- [ ] T012 [P] [US3] Add optional `source?: 'global' | 'workspace-fallback'` field to `Session` interface in `src/lib/types.ts` with JSDoc comment. (FR-004)
- [ ] T013 [US3] Set `source: 'global'` on sessions returned from the global storage path in `getSession()` and `getGlobalSession()` in `src/core/storage.ts`. Set `source: 'workspace-fallback'` on sessions returned from the workspace fallback path. For backup-loaded sessions, set based on which data was actually available. (FR-004, FR-007)
- [ ] T014 [US3] Thread `source` field through `convertToLibrarySession()` in `src/lib/index.ts` — map `coreSession.source` to `Session.source`. (FR-004)
- [ ] T015 [US3] Add degraded session visual indicator in `formatSessionDetail()` in `src/cli/formatters/table.ts` — when session `source === 'workspace-fallback'`, display a warning line (e.g., yellow text: "⚠ Partial data — loaded from workspace fallback"). (FR-007)
- [ ] T027 [US3] Update `formatSessionJson()` in `src/cli/formatters/json.ts` so CLI JSON output includes `session.source` when present, while preserving the existing output shape for sessions where `source` is undefined. (FR-004, FR-007)
- [ ] T023 [US3] Verify via `src/core/storage.ts`, `src/lib/index.ts`, `src/cli/formatters/table.ts`, and `src/cli/formatters/json.ts` that global sessions report `source: 'global'`, fallback sessions report `source: 'workspace-fallback'`, CLI detail shows a degraded warning, and CLI JSON includes `source`. (SC-004)

**Checkpoint**: Sessions carry `source` field. CLI shows a degraded warning. CLI JSON includes `source`. Library consumers can check `session.source` programmatically.

---

## Phase 6: User Story 4 — Debug logging for global storage failures (Priority: P3)

**Goal**: Replace silent `catch {}` blocks with granular debug logging so maintainers can diagnose why global loading failed.

**Independent Test**: Set `DEBUG=cursor-history:*`, trigger each failure mode (missing DB, missing table, no bubbles, query error). Verify appropriate debug messages appear on stderr.

### Implementation for User Story 4

- [ ] T016 [US4] In `getSession()` in `src/core/storage.ts`, replace the outer `catch {}` block (line ~556) with granular debug logging via `debugLogStorage()`: log "Global DB not found" when `existsSync` fails, "cursorDiskKV table not found" when table check fails, "No bubbles for composer [id]" when `bubbleRows.length === 0`, and the actual error message for any caught exception. (FR-001, FR-005)
- [ ] T017 [US4] In `getGlobalSession()` in `src/core/storage.ts`, add equivalent debug logging for the global load path — log DB open failures and query errors via `debugLogStorage()`. (FR-005, FR-008)
- [ ] T024 [US4] Verify via `src/core/storage.ts` and `src/core/database/debug.ts` with `DEBUG=cursor-history:*` that missing DB, missing table, no bubbles, query error, and malformed row parse failure each emit specific debug messages. (SC-005)

**Checkpoint**: Every global storage fallback event produces a debug log entry. `DEBUG=cursor-history:*` reveals the specific failure reason.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Verify no regressions and update documentation.

- [ ] T018 Run `npm run build && npm test` to verify existing tests pass. Fix any broken assertions caused by new `[empty message]` placeholder or additional fields. Additionally, verify `listSessions()` returns sessions with assistant roles (the fix is transitive via `getSession()` but must be confirmed end-to-end). (SC-006)
- [ ] T019 Run `npm run typecheck` to verify no type errors from new `source` field or `toolCalls` population.
- [ ] T020 [P] Update CLAUDE.md Recent Changes section with `012-fix-session-data-integrity` feature summary: list new `source` field, `toolCalls` population, empty bubble preservation, corrupted bubble handling, debug logging.
- [ ] T025 Run manual validation via `src/cli/commands/show.ts` and `src/lib/index.ts` against real Cursor chat exports/backups before merge: confirm assistant/tool data recovery, degraded fallback marking, and debug logging behavior on at least one failure case.
- [ ] T026 [P] Update `CHANGELOG.md` with user-facing release notes for `012-fix-session-data-integrity`: `source` field, `toolCalls` population, empty/corrupted bubble handling, degraded-session indicators, and debug logging improvements.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — verify build
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 (needs `mapBubbleToMessage()` helper)
- **US2 (Phase 4)**: Depends on Phase 2 (needs `mapBubbleToMessage()` helper). Independent of US1.
- **US3 (Phase 5)**: Depends on Phase 2. Independent of US1 and US2.
- **US4 (Phase 6)**: Depends on Phase 2 (needs `debugLogStorage()`). Independent of US1, US2, US3.
- **Polish (Phase 7)**: Depends on all user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2. No dependencies on other stories.
- **US2 (P2)**: Can start after Phase 2. Logically independent of US1, but coordinate `src/core/storage.ts` edits.
- **US3 (P2)**: Can start after Phase 2. No dependencies on other stories.
- **US4 (P3)**: Can start after Phase 2. Logically independent of US1/US2, but coordinate `src/core/storage.ts` edits.

### Within Each User Story

- Tasks within a story are sequential unless marked [P]
- Each story is independently completable and testable

### Parallel Opportunities

- T002 (debug function) and T003 (extract helper) can run in parallel
- After Phase 2, `src/core/storage.ts` work across US1, US2, and US4 should be coordinated in a single stream or serialized to avoid same-file conflicts
- T011 and T012 (type changes) can run in parallel (different files)
- T015 and T027 can run in parallel after T013 (different formatter files)
- T020 and T026 can run in parallel after implementation stabilizes

---

## Parallel Example: After Phase 2

```text
# Coordinate same-file work, parallelize different files:
Stream A (core storage): T006 → T007 → T008 → T009 → T010 → T016 → T017
Stream B (types/lib): T011 + T012 (parallel) → T013 → T014
Stream C (CLI formatters): T015 + T027 (parallel after T013)
Stream D (verification/docs): T021 → T022 → T023 → T024 → T018 → T019 → T025 → T020 + T026
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002–T005)
3. Complete Phase 3: User Story 1 (T006–T008, T021)
4. **STOP and VALIDATE**: `getSession()` now returns assistant messages, empty bubbles preserved, malformed bubbles handled
5. This alone fixes the core data integrity bug

### Incremental Delivery

1. Setup + Foundational → Shared helper extracted, `metadata.bubbleType` populated for debugging visibility
2. Add US1 + T021 verification → Core bug fixed (MVP)
3. Add US2 + T022 verification → `toolCalls` populated
4. Add US3 + T023 verification → `source` field available, CLI text/JSON outputs updated
5. Add US4 + T024 verification → Debug logging for troubleshooting
6. Polish → Tests verified, docs updated

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and verifiable after Phase 2, but same-file edits should be coordinated
- Commit after each phase or logical group
- Stop at any checkpoint to validate independently
- No new files created — all changes are modifications to existing files
