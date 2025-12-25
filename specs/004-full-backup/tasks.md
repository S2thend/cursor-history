# Tasks: Full Backup and Restore

**Input**: Design documents from `/specs/004-full-backup/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and dependency setup

- [x] T001 Install adm-zip dependency: `npm install adm-zip && npm install -D @types/adm-zip`
- [x] T002 [P] Add backup types to src/core/types.ts (BackupManifest, BackupFileEntry, BackupStats, BackupConfig, BackupProgress, BackupResult, RestoreConfig, RestoreProgress, RestoreResult, BackupValidation, BackupInfo)
- [x] T003 [P] Add backup error classes to src/lib/errors.ts (BackupError, NoDataError, FileExistsError, InsufficientSpaceError, RestoreError, BackupNotFoundError, InvalidBackupError, TargetExistsError, IntegrityError)
- [x] T004 [P] Add backup types to src/lib/types.ts (public library types matching core types)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Implement getDefaultBackupDir() utility in src/core/backup.ts (returns ~/cursor-history-backups/)
- [x] T006 Implement computeChecksum(buffer: Buffer) utility in src/core/backup.ts using SHA-256
- [x] T007 Implement generateBackupFilename() utility in src/core/backup.ts (cursor_history_backup_YYYY-MM-DD_HHMMSS.zip)
- [x] T008 [P] Implement scanDatabaseFiles(dataPath: string) in src/core/backup.ts to discover all state.vscdb files
- [x] T009 Implement createManifest(files, stats) in src/core/backup.ts to generate BackupManifest JSON
- [x] T010 [P] Add backupPath option to LibraryConfig in src/lib/config.ts

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Create Full Backup (Priority: P1) 🎯 MVP

**Goal**: Users can create a complete backup of all chat history into a single zip file

**Independent Test**: Run `cursor-history backup` and verify zip file contains all DB files with correct structure and valid manifest

### Implementation for User Story 1

- [x] T011 [US1] Implement backupDatabase(sourcePath, destPath) in src/core/backup.ts using better-sqlite3 .backup() API
- [x] T012 [US1] Implement createBackup(config: BackupConfig) core function in src/core/backup.ts with progress callback support
- [x] T013 [US1] Add disk space check before backup creation in src/core/backup.ts
- [x] T014 [US1] Implement zip creation with adm-zip: add DB files preserving directory structure in src/core/backup.ts
- [x] T015 [US1] Implement manifest generation and inclusion in zip in src/core/backup.ts
- [x] T016 [US1] Add force flag handling to prevent accidental overwrites in src/core/backup.ts
- [x] T017 [P] [US1] Implement createBackup() library wrapper in src/lib/backup.ts
- [x] T018 [P] [US1] Export createBackup and getDefaultBackupDir from src/lib/index.ts
- [x] T019 [US1] Implement backup CLI command in src/cli/commands/backup.ts with -o, -f, --json options
- [x] T020 [US1] Register backup command in src/cli/index.ts
- [x] T021 [US1] Add progress display for backup command (scanning, backing-up, compressing, finalizing phases)
- [x] T022 [US1] Handle edge case: no data to backup (exit code 2)
- [x] T023 [US1] Handle edge case: file exists without --force (exit code 3)
- [x] T024 [US1] Handle edge case: insufficient disk space (exit code 4)

**Checkpoint**: User Story 1 complete - users can create backups via CLI and library

---

## Phase 4: User Story 2 - View Backup Contents Without Restore (Priority: P2)

**Goal**: Users can browse and view chat history directly from a backup zip file without restoring

**Independent Test**: Run `cursor-history list --backup ~/backup.zip` and verify sessions are listed correctly

### Implementation for User Story 2

- [x] T025 [US2] Implement openBackupDatabase(backupPath, dbPath) in src/core/backup.ts to read DB from zip into memory using new Database(buffer)
- [x] T026 [US2] Implement validateBackup(backupPath) in src/core/backup.ts returning BackupValidation with checksum verification
- [x] T027 [US2] Implement BackupDataSource abstraction in src/core/storage.ts to switch between live and backup data
- [x] T028 [US2] Modify findWorkspaces() in src/core/storage.ts to support backupPath parameter
- [x] T029 [US2] Modify listSessions() in src/core/storage.ts to support backupPath parameter
- [x] T030 [US2] Modify getSession() in src/core/storage.ts to support backupPath parameter
- [x] T031 [US2] Modify searchSessions() in src/core/storage.ts to support backupPath parameter
- [x] T032 [P] [US2] Implement validateBackup() library wrapper in src/lib/backup.ts
- [x] T033 [P] [US2] Update listSessions, getSession, searchSessions in src/lib/index.ts to accept backupPath
- [x] T034 [US2] Add --backup option to list command in src/cli/commands/list.ts
- [x] T035 [US2] Add --backup option to show command in src/cli/commands/show.ts
- [x] T036 [US2] Add --backup option to search command in src/cli/commands/search.ts
- [x] T037 [US2] Add --backup option to export command in src/cli/commands/export.ts
- [x] T038 [US2] Handle edge case: invalid/corrupted backup file with clear error message
- [x] T039 [US2] Handle edge case: graceful degradation for partially corrupted backups (warn but allow intact files)

**Checkpoint**: User Story 2 complete - users can view backup contents via CLI and library

---

## Phase 5: User Story 3 - Restore from Backup (Priority: P3)

**Goal**: Users can restore chat history from a backup zip file to recover from data loss

**Independent Test**: Run `cursor-history restore ~/backup.zip --force` and verify all sessions accessible via normal commands

### Implementation for User Story 3

- [x] T040 [US3] Implement restoreBackup(config: RestoreConfig) core function in src/core/backup.ts
- [x] T041 [US3] Implement integrity verification before restore in src/core/backup.ts
- [x] T042 [US3] Implement file extraction with path normalization (forward slashes to OS-native) in src/core/backup.ts
- [x] T043 [US3] Implement rollback mechanism for partial restore failures in src/core/backup.ts
- [x] T044 [US3] Add force flag handling to prevent accidental data overwrites in src/core/backup.ts
- [x] T045 [US3] Add progress callback support for restore operation in src/core/backup.ts
- [x] T046 [P] [US3] Implement restoreBackup() library wrapper in src/lib/backup.ts
- [x] T047 [P] [US3] Export restoreBackup from src/lib/index.ts
- [x] T048 [US3] Implement restore CLI command in src/cli/commands/restore.ts with -t, -f, --json options
- [x] T049 [US3] Register restore command in src/cli/index.ts
- [x] T050 [US3] Add progress display for restore command (validating, extracting, finalizing phases)
- [x] T051 [US3] Handle edge case: backup file not found (exit code 2)
- [x] T052 [US3] Handle edge case: invalid/corrupted backup (exit code 3)
- [x] T053 [US3] Handle edge case: target exists without --force (exit code 4)
- [x] T054 [US3] Handle edge case: integrity check failures (exit code 5)

**Checkpoint**: User Story 3 complete - users can restore backups via CLI and library

---

## Phase 6: User Story 4 - List Available Backups (Priority: P4)

**Goal**: Users can list all backup files in a directory with metadata

**Independent Test**: Run `cursor-history list-backups` and verify all backups shown with date, size, session count

### Implementation for User Story 4

- [x] T055 [US4] Implement listBackups(directory?: string) in src/core/backup.ts to scan directory for .zip files
- [x] T056 [US4] Implement backup metadata extraction (read manifest from each zip) in src/core/backup.ts
- [x] T057 [US4] Handle invalid backups gracefully (include in list with error field) in src/core/backup.ts
- [x] T058 [P] [US4] Implement listBackups() library wrapper in src/lib/backup.ts
- [x] T059 [P] [US4] Export listBackups from src/lib/index.ts
- [x] T060 [US4] Implement list-backups CLI command in src/cli/commands/list-backups.ts with --json option
- [x] T061 [US4] Register list-backups command in src/cli/index.ts
- [x] T062 [US4] Add table formatter for backup list (filename, date, size, sessions) in src/cli/commands/list-backups.ts
- [x] T063 [US4] Handle edge case: no backups found (informational message, exit code 0)
- [x] T064 [US4] Handle edge case: directory not found (exit code 2)

**Checkpoint**: User Story 4 complete - users can list and manage backups

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T065 [P] Export all backup types from src/lib/types.ts
- [x] T066 [P] Add type guards (isBackupError, isRestoreError, isInvalidBackupError) to src/lib/errors.ts
- [x] T067 [P] Export type guards from src/lib/index.ts
- [ ] T068 Update README.md with backup/restore usage examples (deferred - docs)
- [x] T069 Run typecheck and fix any TypeScript errors
- [x] T070 Run lint and fix any linting issues
- [x] T071 Verify all CLI commands have proper --help text
- [ ] T072 Run quickstart.md validation (test all documented commands) (deferred - docs)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phases 3-6)**: All depend on Foundational phase completion
  - US1 can proceed immediately after Foundational
  - US2 depends on US1 (needs backup files to test against)
  - US3 depends on US1 (needs backup files to restore)
  - US4 depends on US1 (needs backup files to list)
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational - No dependencies on other stories
- **User Story 2 (P2)**: Requires US1 complete (needs backup file to test viewing)
- **User Story 3 (P3)**: Requires US1 complete (needs backup file to test restore)
- **User Story 4 (P4)**: Requires US1 complete (needs backup files to list)

### Within Each User Story

- Core functions before library wrappers
- Library functions before CLI commands
- Main implementation before edge case handling

### Parallel Opportunities

**Setup Phase**:
```
T002, T003, T004 can run in parallel (different files)
```

**Foundational Phase**:
```
T008, T010 can run in parallel (different files)
```

**User Story 1**:
```
T017, T018 can run in parallel (different files)
```

**User Story 2**:
```
T032, T033 can run in parallel (different files)
```

**User Story 3**:
```
T046, T047 can run in parallel (different files)
```

**User Story 4**:
```
T058, T059 can run in parallel (different files)
```

**Polish Phase**:
```
T065, T066, T067 can run in parallel (different files)
```

---

## Parallel Example: User Story 1

```bash
# After T016 completes, launch library tasks in parallel:
Task: "T017 [P] [US1] Implement createBackup() library wrapper in src/lib/backup.ts"
Task: "T018 [P] [US1] Export createBackup and getDefaultBackupDir from src/lib/index.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T004)
2. Complete Phase 2: Foundational (T005-T010)
3. Complete Phase 3: User Story 1 (T011-T024)
4. **STOP and VALIDATE**: Test backup creation independently
5. Deploy/demo if ready - users can now create backups!

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test viewing backups → Deploy/Demo
4. Add User Story 3 → Test restoring backups → Deploy/Demo
5. Add User Story 4 → Test listing backups → Deploy/Demo
6. Complete Polish → Final release

### Suggested MVP Scope

**MVP = User Story 1 only (Create Full Backup)**

Tasks: T001-T024 (24 tasks)

This delivers the foundational capability - users can create backups. All other features (viewing, restoring, listing) are enhancements that build on this core functionality.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US2, US3, US4 all require US1 to be complete first (need backup files)
