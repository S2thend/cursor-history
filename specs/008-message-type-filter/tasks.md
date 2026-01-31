# Tasks: Message Type Filter

**Input**: Design documents from `/specs/008-message-type-filter/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Unit tests will be added as they are a best practice for filter logic.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- **Project structure**: `src/` at repository root (single project)
- CLI commands: `src/cli/commands/`
- Formatters: `src/cli/formatters/`
- Core types: `src/core/`
- Library API: `src/lib/`
- Tests: `tests/unit/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add core types that all user stories depend on

- [x] T001 Add `MessageType` type and `MESSAGE_TYPES` constant in src/core/types.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Filter logic that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 Export `isToolCall()`, `isThinking()`, `isError()` functions (make public) in src/cli/formatters/table.ts
- [x] T003 Add `getMessageType()` function in src/cli/formatters/table.ts
- [x] T004 Add `filterMessages()` function in src/cli/formatters/table.ts
- [x] T005 Add `validateMessageTypes()` function in src/cli/formatters/table.ts
- [x] T006 [P] Add unit tests for `getMessageType()` in tests/unit/filter.test.ts
- [x] T007 [P] Add unit tests for `filterMessages()` in tests/unit/filter.test.ts
- [x] T008 [P] Add unit tests for `validateMessageTypes()` in tests/unit/filter.test.ts

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Filter to User Messages Only (Priority: P1) 🎯 MVP

**Goal**: Users can filter to see only their own messages with `--only user`

**Independent Test**: Run `cursor-history show 1 --only user` and verify only user messages appear

### Implementation for User Story 1

- [x] T009 [US1] Add `--only <types>` option to show command in src/cli/commands/show.ts
- [x] T010 [US1] Add validation for filter values with error message in src/cli/commands/show.ts
- [x] T011 [US1] Apply filter to session messages before display in src/cli/commands/show.ts
- [x] T012 [US1] Handle empty filter result with informative message in src/cli/formatters/table.ts

**Checkpoint**: User Story 1 complete - `--only user` works for filtering to user messages

---

## Phase 4: User Story 2 - Filter to Tool Calls Only (Priority: P1)

**Goal**: Users can filter to see only tool calls with `--only tool`

**Independent Test**: Run `cursor-history show 1 --only tool` and verify only tool call messages appear

### Implementation for User Story 2

- [x] T013 [US2] Verify tool call detection works correctly with `--only tool` (no new code needed if T003-T011 complete)

**Checkpoint**: User Story 2 complete - `--only tool` works for filtering to tool calls

---

## Phase 5: User Story 3 - Filter to Assistant Responses Only (Priority: P2)

**Goal**: Users can filter to see only assistant explanatory text with `--only assistant`

**Independent Test**: Run `cursor-history show 1 --only assistant` and verify only plain assistant text appears (no tool calls, thinking, errors)

### Implementation for User Story 3

- [x] T014 [US3] Verify assistant detection excludes tool/thinking/error with `--only assistant` (no new code needed if T003-T011 complete)

**Checkpoint**: User Story 3 complete - `--only assistant` works for filtering to assistant text

---

## Phase 6: User Story 4 - Filter with Multiple Types (Priority: P2)

**Goal**: Users can combine filters like `--only user,tool`

**Independent Test**: Run `cursor-history show 1 --only user,tool` and verify both user and tool messages appear

### Implementation for User Story 4

- [x] T015 [US4] Verify comma-separated filter parsing works in src/cli/commands/show.ts (should work from T009-T011)
- [x] T016 [US4] Add support for `thinking` and `error` filter types (complete the 5-type set)

**Checkpoint**: User Story 4 complete - combined filters work

---

## Phase 7: Library API Integration

**Purpose**: Expose filtering via library API

- [x] T017 [P] Add `messageFilter` to `LibraryConfig` interface in src/lib/types.ts
- [x] T018 [P] Export `MessageType` and `MESSAGE_TYPES` from src/lib/types.ts
- [x] T019 Apply filter in `getSession()` when `messageFilter` is provided in src/lib/index.ts
- [x] T020 [P] Export `getMessageType`, `filterMessages`, `validateMessageTypes` from src/lib/index.ts
- [x] T021 [P] Add `InvalidFilterError` class to src/lib/errors.ts
- [x] T022 Add filter validation in library `getSession()` that throws `InvalidFilterError` in src/lib/index.ts

**Checkpoint**: Library API supports filtering

---

## Phase 8: JSON Output Support

**Purpose**: Ensure filter works with JSON output mode

- [x] T023 Update JSON formatter to include `filter` and `filteredMessageCount` fields in src/cli/formatters/json.ts
- [x] T024 Add `type` field to each message in JSON output when filter is active in src/cli/formatters/json.ts

**Checkpoint**: JSON output includes filter metadata

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final verification

- [x] T025 [P] Update CLAUDE.md with new `--only` option documentation
- [x] T026 [P] Update README.md with `--only` option usage examples
- [x] T027 Run full test suite and verify all existing tests pass
- [x] T028 Manual testing: verify all filter combinations work correctly

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-6)**: All depend on Foundational phase completion
- **Library API (Phase 7)**: Depends on Phase 2 (foundational functions)
- **JSON Output (Phase 8)**: Depends on Phase 3 (basic CLI working)
- **Polish (Phase 9)**: Depends on all prior phases

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Phase 2 - First to implement CLI option
- **User Story 2 (P1)**: Can start after US1 - Uses same infrastructure
- **User Story 3 (P2)**: Can start after Phase 2 - Independent testing of assistant filter
- **User Story 4 (P2)**: Can start after US1 - Tests combined filters

### Within Each Phase

- T002 before T003 (need exports before using them)
- T003 before T004 (filterMessages uses getMessageType)
- T009-T011 sequential (option → validation → apply)
- Tests (T006-T008) can run in parallel after T003-T005

### Parallel Opportunities

- T006, T007, T008 can run in parallel (different test files)
- T017, T018, T020, T021 can run in parallel (different aspects of library)
- T023, T024 can run in parallel after basic CLI working
- T025, T026 can run in parallel (different doc files)

---

## Parallel Example: Foundational Phase

```bash
# After T005 is complete, launch all tests together:
Task: "Add unit tests for getMessageType() in tests/unit/filter.test.ts"
Task: "Add unit tests for filterMessages() in tests/unit/filter.test.ts"
Task: "Add unit tests for validateMessageTypes() in tests/unit/filter.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002-T008)
3. Complete Phase 3: User Story 1 (T009-T012)
4. **STOP and VALIDATE**: Test `--only user` works correctly
5. Ready to demo/use

### Incremental Delivery

1. Complete Setup + Foundational → Filter logic ready
2. Add User Story 1 → `--only user` works (MVP!)
3. Add User Story 2 → `--only tool` works
4. Add User Story 3 → `--only assistant` works
5. Add User Story 4 → Combined filters work
6. Add Library API → Programmatic filtering
7. Add JSON support → Machine-readable output
8. Polish → Documentation complete

### Task Summary

| Phase | Task Count | Purpose |
|-------|------------|---------|
| Setup | 1 | Core types |
| Foundational | 7 | Filter logic + tests |
| US1 | 4 | CLI `--only user` |
| US2 | 1 | Verify `--only tool` |
| US3 | 1 | Verify `--only assistant` |
| US4 | 2 | Combined filters |
| Library | 6 | API integration |
| JSON | 2 | Output enhancement |
| Polish | 4 | Documentation |
| **Total** | **28** | |

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1 and US2 are both P1 priority (equally important)
- US2-US4 are mostly verification tasks (filter logic is shared)
- Library API can be developed in parallel once foundational phase complete
- Commit after each task or logical group
