# Tasks: Fix Migration File Path References

**Input**: Design documents from `/specs/005-fix-migration-paths/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md

**Tests**: Not explicitly requested in spec. Test tasks included as optional for implementation confidence.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root (per plan.md)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add types and error infrastructure needed by all user stories

- [x] T001 Add `debug` option to `MigrateSessionOptions` interface in src/core/types.ts
- [x] T002 Add `debug` option to `MigrateWorkspaceOptions` interface in src/core/types.ts
- [x] T003 Add `NestedPathError` class to src/lib/errors.ts for nested path validation

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core path transformation logic that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create `transformPath()` helper function in src/core/migrate.ts that replaces source prefix with dest prefix
- [x] T005 Create `transformToolFormerParams()` function in src/core/migrate.ts to update all path fields (relativeWorkspacePath, targetFile, filePath, path)
- [x] T006 Create `transformCodeBlockUri()` function in src/core/migrate.ts to update uri.path, uri._formatted, uri._fsPath
- [x] T007 Create `transformBubblePaths()` function in src/core/migrate.ts that calls T005 and T006 for a single bubble
- [x] T008 Add nested path validation in src/core/migrate.ts to detect if dest starts with source prefix
- [x] T009 Export `NestedPathError` from src/lib/errors.ts in the existing error exports

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Move Session Path Updates (Priority: P1) 🎯 MVP

**Goal**: File paths in moved sessions are updated to destination workspace

**Independent Test**: Run `cursor-history migrate-session 1 ~/new-project` and verify paths in bubble data point to new-project

### Implementation for User Story 1

- [x] T010 [US1] Modify `copyBubbleDataInGlobalStorage()` in src/core/migrate.ts to accept sourceWorkspace and destWorkspace parameters
- [x] T011 [US1] Call `transformBubblePaths()` for each bubble in `copyBubbleDataInGlobalStorage()` in src/core/migrate.ts
- [x] T012 [US1] Update `migrateSession()` in src/core/migrate.ts to pass workspace paths to copyBubbleDataInGlobalStorage
- [x] T013 [US1] Add nested path check at start of `migrateSession()` in src/core/migrate.ts, throw NestedPathError if detected

**Checkpoint**: Move mode now updates file paths correctly

---

## Phase 4: User Story 2 - Copy Session Path Updates (Priority: P1)

**Goal**: Copied sessions have paths updated; original sessions remain unchanged

**Independent Test**: Run `cursor-history migrate-session 1 ~/new-project --copy`, verify original has old paths, copy has new paths

### Implementation for User Story 2

- [x] T014 [US2] Ensure `transformBubblePaths()` is called AFTER bubble data is copied (not on original) in src/core/migrate.ts
- [x] T015 [US2] Add nested path check for copy mode in `migrateSession()` in src/core/migrate.ts (same validation as move)

**Checkpoint**: Copy mode creates independent sessions with correct paths

---

## Phase 5: User Story 3 - Debug Mode (Priority: P1)

**Goal**: Users can see detailed path transformation logs with --debug flag

**Independent Test**: Run `cursor-history migrate-session 1 ~/new-project --debug` and see bubble IDs, path transformations, skipped paths in stderr

### Implementation for User Story 3

- [x] T016 [P] [US3] Add `--debug` flag to migrate-session command in src/cli/commands/migrate-session.ts
- [x] T017 [P] [US3] Add `--debug` flag to migrate command in src/cli/commands/migrate.ts
- [x] T018 [US3] Pass debug option through `migrateSession()` to `copyBubbleDataInGlobalStorage()` in src/core/migrate.ts
- [x] T019 [US3] Add debug logging for bubble processing: `[DEBUG] Processing bubble: {bubbleId}` in src/core/migrate.ts
- [x] T020 [US3] Add debug logging for path transformations: `[DEBUG] {field}: {oldPath} -> {newPath}` in src/core/migrate.ts
- [x] T021 [US3] Add debug logging for skipped external paths: `[SKIP] {field}: {path} (outside workspace)` in src/core/migrate.ts
- [x] T022 [US3] Ensure all debug output uses `console.error()` for stderr in src/core/migrate.ts

**Checkpoint**: Debug mode provides full visibility into migration process

---

## Phase 6: User Story 4 - Dry Run Path Preview (Priority: P2)

**Goal**: Dry run output indicates paths will be updated

**Independent Test**: Run `cursor-history migrate-session 1 ~/new-project --dry-run` and see message about path updates

### Implementation for User Story 4

- [x] T023 [US4] Enhance dry run output in `migrateSession()` to include path update indicator in src/core/migrate.ts
- [x] T024 [US4] Update CLI output formatting for dry run in src/cli/commands/migrate-session.ts to show "File paths will be updated from {source} to {dest}"

**Checkpoint**: Dry run provides confidence about what will change

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and cleanup

- [x] T025 Run existing test suite to verify no regressions: `npm test`
- [x] T026 Build and verify no TypeScript errors: `npm run build`
- [ ] T027 Test manual migration with debug flag using actual Cursor data
- [x] T028 Update CLAUDE.md to document new --debug flag for migration commands

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-6)**: All depend on Foundational phase completion
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - Core move functionality
- **User Story 2 (P1)**: Depends on US1 - Copy uses same transform functions
- **User Story 3 (P1)**: Depends on US1 - Debug logging wraps existing transform logic
- **User Story 4 (P2)**: Depends on US1 - Dry run enhancement

### Within Each User Story

- Foundational functions must exist before they can be called
- CLI flags can be added in parallel [P]
- Core logic changes are sequential

### Parallel Opportunities

- T001, T002, T003 can run in parallel (different files)
- T016, T017 can run in parallel (different CLI command files)
- Once Foundational completes, US1 can start immediately

---

## Parallel Example: Setup Phase

```bash
# Launch all setup tasks together:
Task: "Add debug option to MigrateSessionOptions in src/core/types.ts"
Task: "Add debug option to MigrateWorkspaceOptions in src/core/types.ts"
Task: "Add NestedPathError class to src/lib/errors.ts"
```

## Parallel Example: User Story 3 CLI

```bash
# Launch CLI flag additions together:
Task: "Add --debug flag to migrate-session command in src/cli/commands/migrate-session.ts"
Task: "Add --debug flag to migrate command in src/cli/commands/migrate.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1-3)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: Foundational (T004-T009) - CRITICAL
3. Complete Phase 3: User Story 1 (T010-T013) - Core fix
4. Complete Phase 4: User Story 2 (T014-T015) - Copy mode
5. Complete Phase 5: User Story 3 (T016-T022) - Debug logging
6. **STOP and VALIDATE**: Test all P1 stories
7. Deploy MVP

### Incremental Delivery

1. Setup + Foundational → Core transform logic ready
2. Add US1 → Move mode works → Test with real data
3. Add US2 → Copy mode works → Test with real data
4. Add US3 → Debug logging → Verify stderr output
5. Add US4 → Dry run preview → Nice-to-have

---

## Notes

- All 4 user stories share the same foundational transform functions
- US1 and US2 are both P1 because both move and copy need to work for the feature to be useful
- US3 (Debug) is P1 because it's essential for development and troubleshooting
- US4 (Dry run preview) is P2 - the existing dry run works, this is an enhancement
- Total tasks: 28
- Tasks per story: Setup=3, Foundational=6, US1=4, US2=2, US3=7, US4=2, Polish=4
