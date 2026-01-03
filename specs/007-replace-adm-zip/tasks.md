# Tasks: Replace adm-zip with ESM-Compatible Alternative

**Input**: Design documents from `/specs/007-replace-adm-zip/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: No tests explicitly requested in the specification. Manual testing via CLI commands is specified.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root
- Paths based on plan.md structure

---

## Phase 1: Setup (Dependency Changes)

**Purpose**: Update project dependencies to replace adm-zip with jszip

- [ ] T001 Remove adm-zip and @types/adm-zip from package.json
- [ ] T002 Add jszip ^3.10.1 to dependencies in package.json
- [ ] T003 Run npm install to update node_modules and package-lock.json
- [ ] T004 Verify build succeeds with `npm run build` after dependency change

---

## Phase 2: Foundational (Core Async Refactoring)

**Purpose**: Convert core backup functions from sync to async - MUST complete before user story implementation

**⚠️ CRITICAL**: These changes affect all backup-related functionality

- [ ] T005 Update import statement in src/core/backup.ts: replace `import AdmZip from 'adm-zip'` with `import JSZip from 'jszip'` and add `import { readFile, writeFile } from 'node:fs/promises'`
- [ ] T006 Update import statement in src/core/storage.ts: replace `import AdmZip from 'adm-zip'` with `import JSZip from 'jszip'` and add `import { readFile } from 'node:fs/promises'`
- [ ] T007 Convert `readBackupManifest()` to async in src/core/backup.ts: change signature to `async function`, use `await readFile()` and `JSZip.loadAsync()`, return `Promise<BackupManifest | null>`
- [ ] T008 Convert `openBackupDatabase()` to async in src/core/backup.ts: change signature to `async function`, use `await readFile()` and `JSZip.loadAsync()`, extract file with `await zip.file(dbPath)?.async('nodebuffer')`, return `Promise<DatabaseInterface>`
- [ ] T009 Convert `validateBackup()` to async in src/core/backup.ts: change signature to `async function`, use async zip loading and file reading, return `Promise<BackupValidation>`
- [ ] T010 Convert `restoreBackup()` to async in src/core/backup.ts: change signature to `async function`, use async zip loading and extraction, return `Promise<RestoreResult>`
- [ ] T011 Convert `listBackups()` to async in src/core/backup.ts: change signature to `async function`, await `readBackupManifest()` calls, return `Promise<BackupInfo[]>`
- [ ] T012 Convert `readWorkspaceJsonFromBackup()` to async in src/core/storage.ts: change signature to `async function`, use `await readFile()` and `JSZip.loadAsync()`, return `Promise<string | null>`

**Checkpoint**: Core async infrastructure complete - user story implementation can now begin

---

## Phase 3: User Story 1 & 2 - Backup Create/Restore (Priority: P1) 🎯 MVP

**Goal**: Replace adm-zip usage in createBackup() and restoreBackup() so backup operations work with jszip

**Independent Test**: Run `cursor-history backup` to create a backup, then `cursor-history restore <file>` to restore it

### Implementation for User Story 1 & 2

- [ ] T013 [US1] Refactor zip creation in `createBackup()` in src/core/backup.ts: replace `new AdmZip()` with `new JSZip()`, use `zip.file(path, content)` instead of `addLocalFile/addFile`
- [ ] T014 [US1] Refactor zip writing in `createBackup()` in src/core/backup.ts: replace `zip.writeZip(outputPath)` with `const content = await zip.generateAsync({type: 'nodebuffer'}); await writeFile(outputPath, content)`
- [ ] T015 [US2] Refactor zip reading in `restoreBackup()` in src/core/backup.ts: replace `new AdmZip(backupPath)` with `const data = await readFile(backupPath); const zip = await JSZip.loadAsync(data)`
- [ ] T016 [US2] Refactor file extraction in `restoreBackup()` in src/core/backup.ts: replace `zip.readFile(path)` with `await zip.file(path)?.async('nodebuffer')`
- [ ] T017 [US2] Update library wrapper `restoreBackup()` in src/lib/backup.ts: change to `async function`, update return type to `Promise<RestoreResult>`
- [ ] T018 [US2] Update library wrapper `validateBackup()` in src/lib/backup.ts: change to `async function`, update return type to `Promise<BackupValidation>`
- [ ] T019 [US2] Update library wrapper `listBackups()` in src/lib/backup.ts: change to `async function`, update return type to `Promise<BackupInfo[]>`
- [ ] T020 [US2] Update CLI command callers in src/cli/commands/backup.ts: add `await` to `restoreBackup()`, `validateBackup()`, `listBackups()` calls

**Checkpoint**: Backup create and restore should work - test with `cursor-history backup` and `cursor-history restore`

---

## Phase 4: User Story 3 - Backup Data Source (Priority: P2)

**Goal**: Enable reading sessions from backup files with jszip

**Independent Test**: Run `cursor-history list --backup <file>` and `cursor-history show 1 --backup <file>`

### Implementation for User Story 3

- [ ] T021 [US3] Refactor `readWorkspaceJsonFromBackup()` implementation in src/core/storage.ts: use `await readFile()` and `JSZip.loadAsync()` to read zip, extract workspace.json with `await zip.file(path)?.async('nodebuffer')`
- [ ] T022 [US3] Update `findWorkspacesFromBackup()` in src/core/storage.ts: await the now-async `readWorkspaceJsonFromBackup()` call
- [ ] T023 [US3] Update callers of `openBackupDatabase()` in src/core/storage.ts: add `await` to all calls (in `findWorkspacesFromBackup`, `listSessions`, `getSession`)

**Checkpoint**: Reading from backup files should work - test with `cursor-history list --backup <file>`

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, and cleanup

- [ ] T024 [P] Update module docstring in src/core/backup.ts: change "Zip creation/extraction using adm-zip" to "Zip creation/extraction using jszip"
- [ ] T025 [P] Run TypeScript type check with `npm run typecheck` to verify all async/await types are correct
- [ ] T026 [P] Run linter with `npm run lint` to verify code style
- [ ] T027 Build project with `npm run build` and verify no errors
- [ ] T028 Manual test: Create backup with `node dist/cli/index.js backup`
- [ ] T029 Manual test: List backups with `node dist/cli/index.js backup list`
- [ ] T030 Manual test: Validate backup with `node dist/cli/index.js backup validate <file>`
- [ ] T031 Manual test: Restore backup with `node dist/cli/index.js backup restore <file> --force`
- [ ] T032 Manual test: List sessions from backup with `node dist/cli/index.js list --backup <file>`
- [ ] T033 Manual test: Show session from backup with `node dist/cli/index.js show 1 --backup <file>`
- [ ] T034 [P] Verify backwards compatibility: read a backup file created with adm-zip version (if available)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories 1 & 2 (Phase 3)**: Depends on Foundational phase completion
- **User Story 3 (Phase 4)**: Depends on Foundational phase completion, can run parallel to Phase 3
- **Polish (Phase 5)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 & 2 (P1)**: Can start after Foundational (Phase 2) - Core backup/restore
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - Can run in parallel with US1/2 if different developer

### Within Each Phase

- T001-T004: Sequential (dependency changes must be in order)
- T005-T012: T005-T006 parallel, then T007-T012 can be parallel (different functions)
- T013-T020: T013-T014 sequential (same function), T015-T016 sequential (same function), T017-T020 can be parallel
- T021-T023: Sequential within storage.ts
- T024-T034: T024-T027 parallel, T028-T034 sequential (manual tests depend on build)

### Parallel Opportunities

```bash
# Phase 2 - Foundation (after imports updated):
Task: T007 "Convert readBackupManifest() to async"
Task: T008 "Convert openBackupDatabase() to async"
Task: T009 "Convert validateBackup() to async"
Task: T010 "Convert restoreBackup() to async"
Task: T011 "Convert listBackups() to async"

# Phase 3 - Library wrappers:
Task: T017 "Update restoreBackup wrapper"
Task: T018 "Update validateBackup wrapper"
Task: T019 "Update listBackups wrapper"

# Phase 5 - Polish:
Task: T024 "Update docstring"
Task: T025 "Run typecheck"
Task: T026 "Run linter"
```

---

## Implementation Strategy

### MVP First (User Stories 1 & 2)

1. Complete Phase 1: Setup (dependency swap)
2. Complete Phase 2: Foundational (async conversions)
3. Complete Phase 3: User Stories 1 & 2 (backup create/restore)
4. **STOP and VALIDATE**: Test `cursor-history backup` and `cursor-history restore`
5. If working, this is a deployable MVP

### Incremental Delivery

1. Complete Setup + Foundational → Build passes
2. Add User Stories 1 & 2 → Test backup/restore → Can release
3. Add User Story 3 → Test backup reading → Full feature complete
4. Polish phase → Documentation and validation complete

---

## Notes

- All adm-zip usages are in 2 files: backup.ts (6 instances) and storage.ts (1 instance)
- jszip is Promise-based, so all zip operations become async
- The library API wrappers in src/lib/backup.ts must also become async
- CLI commands in src/cli/commands/backup.ts need await for the now-async functions
- Backwards compatibility: jszip reads standard ZIP format, should read old adm-zip backups
- No new files created - this is a refactoring task
