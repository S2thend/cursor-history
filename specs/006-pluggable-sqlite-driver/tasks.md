# Tasks: Pluggable SQLite Driver

**Input**: Design documents from `/specs/006-pluggable-sqlite-driver/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Tests are included as this feature requires validation across multiple Node.js versions.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the database abstraction module structure

- [x] T001 Create directory structure: src/core/database/ and src/core/database/drivers/
- [x] T002 [P] Create type definitions in src/core/database/types.ts (copy from contracts/database.ts, adapt for implementation)
- [x] T003 [P] Create error classes in src/core/database/errors.ts (NoDriverAvailableError, DriverNotAvailableError, ReadonlyDatabaseError)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core driver infrastructure that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Implement DriverRegistry singleton in src/core/database/registry.ts (register, drivers map, currentDriver state)
- [x] T005 [P] Implement better-sqlite3 driver adapter in src/core/database/drivers/better-sqlite3.ts
- [x] T006 [P] Implement node:sqlite driver adapter in src/core/database/drivers/node-sqlite.ts
- [x] T007 Create debug logging utility function in src/core/database/debug.ts (check DEBUG/CURSOR_HISTORY_DEBUG env vars)
- [x] T008 Create public exports in src/core/database/index.ts (openDatabase, openDatabaseReadWrite, getActiveDriver, setDriver)
- [x] T009 Update src/core/storage.ts imports to use src/core/database/index.ts instead of better-sqlite3 directly
- [x] T010 [P] Update src/core/migrate.ts imports to use src/core/database/index.ts
- [x] T011 [P] Update src/core/backup.ts imports to use src/core/database/index.ts

**Checkpoint**: Foundation ready - all existing functionality should work with better-sqlite3 driver

---

## Phase 3: User Story 1 - Automatic Driver Selection (Priority: P1) MVP

**Goal**: Library auto-detects and uses best available SQLite driver without user configuration

**Independent Test**: Run cursor-history on Node.js v24 (where better-sqlite3 may fail ESM) and verify it auto-selects node:sqlite

### Tests for User Story 1

- [ ] T012 [P] [US1] Unit test for driver availability detection in tests/unit/database/availability.test.ts
- [ ] T013 [P] [US1] Unit test for auto-selection priority logic in tests/unit/database/auto-select.test.ts
- [ ] T014 [US1] Integration test for fallback behavior in tests/integration/driver-fallback.test.ts

### Implementation for User Story 1

- [x] T015 [US1] Implement autoSelect() method in src/core/database/registry.ts (node:sqlite first, then better-sqlite3)
- [x] T016 [US1] Add driver initialization on first openDatabase() call in src/core/database/index.ts
- [x] T017 [US1] Implement NoDriverAvailableError with actionable message in src/core/database/errors.ts
- [x] T018 [US1] Add debug logging for driver selection in src/core/database/registry.ts
- [ ] T019 [US1] Verify existing tests pass (backward compatibility check) by running npm test

**Checkpoint**: User Story 1 complete - cursor-history works on Node 20/22/24+ without configuration

---

## Phase 4: User Story 2 - Manual Driver Selection (Priority: P2)

**Goal**: Developers can explicitly choose which driver to use via env var or config

**Independent Test**: Set CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 and verify that driver is used exclusively

### Tests for User Story 2

- [ ] T020 [P] [US2] Unit test for env var override in tests/unit/database/env-override.test.ts
- [ ] T021 [P] [US2] Unit test for LibraryConfig.sqliteDriver option in tests/unit/database/config-override.test.ts

### Implementation for User Story 2

- [x] T022 [US2] Add CURSOR_HISTORY_SQLITE_DRIVER env var check to autoSelect() in src/core/database/registry.ts
- [x] T023 [US2] Add sqliteDriver field to LibraryConfig in src/lib/types.ts
- [x] T024 [US2] Handle sqliteDriver config option in src/lib/config.ts
- [x] T025 [US2] Wire LibraryConfig.sqliteDriver to registry in src/lib/index.ts
- [x] T026 [US2] Implement DriverNotAvailableError with available alternatives in src/core/database/errors.ts
- [x] T027 [US2] Add debug logging for manual override in src/core/database/registry.ts

**Checkpoint**: User Story 2 complete - developers can override driver via env var or config

---

## Phase 5: User Story 3 - Runtime Driver Switching (Priority: P3)

**Goal**: Developers can switch drivers at runtime for advanced use cases

**Independent Test**: Call setDriver('node:sqlite') mid-session and verify new connections use that driver

### Tests for User Story 3

- [ ] T028 [P] [US3] Unit test for setDriver() in tests/unit/database/set-driver.test.ts
- [ ] T029 [US3] Integration test for runtime switching in tests/integration/driver-switching.test.ts

### Implementation for User Story 3

- [x] T030 [US3] Implement setDriver(name) method in src/core/database/registry.ts
- [x] T031 [US3] Implement getActiveDriver() method in src/core/database/registry.ts
- [x] T032 [US3] Export setDriver and getActiveDriver from src/core/database/index.ts
- [x] T033 [US3] Export setDriver and getActiveDriver from src/lib/index.ts (library API)
- [x] T034 [US3] Add debug logging for runtime switch in src/core/database/registry.ts

**Checkpoint**: User Story 3 complete - developers can switch drivers at runtime

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, cleanup, and final validation

- [x] T035 [P] Update README.md with driver configuration documentation
- [x] T036 [P] Update CLAUDE.md with new module information
- [x] T037 Run full test suite and fix any regressions (npm test) - Note: no test files exist yet
- [x] T038 Run linting and fix issues (npm run lint)
- [x] T039 Run type checking (npm run typecheck)
- [x] T040 Validate quickstart.md scenarios manually

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-5)**: All depend on Foundational phase completion
  - US1 (P1): Can start after Phase 2
  - US2 (P2): Can start after Phase 2 (parallel with US1 if staffed)
  - US3 (P3): Can start after Phase 2 (parallel with US1/US2 if staffed)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: No dependencies on other stories - standalone MVP
- **User Story 2 (P2)**: No dependencies on US1 - extends registry independently
- **User Story 3 (P3)**: No dependencies on US1/US2 - extends registry independently

### Within Each Phase

- Tests MUST be written and FAIL before implementation
- Type definitions before implementations
- Core infrastructure before dependent modules
- Registry before drivers
- Drivers before integration

### Parallel Opportunities

**Phase 1**:
- T002 and T003 can run in parallel (different files)

**Phase 2**:
- T005 and T006 can run in parallel (different driver adapters)
- T010 and T011 can run in parallel (different files to update)

**Phase 3 (US1)**:
- T012 and T013 can run in parallel (different test files)

**Phase 4 (US2)**:
- T020 and T021 can run in parallel (different test files)

**Phase 5 (US3)**:
- T028 runs alone, T029 depends on implementation

**Phase 6**:
- T035 and T036 can run in parallel (different docs)

---

## Parallel Example: Phase 2 Foundation

```bash
# After T004 (registry) is complete, launch driver adapters in parallel:
Task: "Implement better-sqlite3 driver adapter in src/core/database/drivers/better-sqlite3.ts"
Task: "Implement node:sqlite driver adapter in src/core/database/drivers/node-sqlite.ts"

# After drivers complete, update imports in parallel:
Task: "Update src/core/migrate.ts imports"
Task: "Update src/core/backup.ts imports"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: Foundational (T004-T011)
3. Complete Phase 3: User Story 1 (T012-T019)
4. **STOP and VALIDATE**: Run `npm test`, verify on Node 20/22/24+
5. Deploy/release if ready (US2 and US3 can follow later)

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Release v0.9.0 (MVP!)
3. Add User Story 2 → Test independently → Release v0.9.1
4. Add User Story 3 → Test independently → Release v0.10.0
5. Polish → Release v1.0.0

### Single Developer Strategy

Execute phases sequentially:
1. Phase 1 → Phase 2 → Phase 3 (MVP)
2. Validate MVP works on all target Node versions
3. Phase 4 → Phase 5 → Phase 6

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate independently
- Run `npm test` frequently to catch regressions early
