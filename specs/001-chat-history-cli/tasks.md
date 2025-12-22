# Tasks: Cursor Chat History CLI

**Input**: Design documents from `/specs/001-chat-history-cli/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in spec. Tests omitted per guidelines.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root
- Core library in `src/core/`, CLI in `src/cli/`, utilities in `src/lib/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Create project directory structure per plan.md in repository root
- [x] T002 Initialize TypeScript project with package.json and tsconfig.json (strict mode)
- [x] T003 [P] Install dependencies: commander, better-sqlite3, picocolors
- [x] T004 [P] Install dev dependencies: typescript, vitest, eslint, prettier, @types/better-sqlite3
- [x] T005 [P] Configure ESLint and Prettier in eslint.config.js and .prettierrc
- [x] T006 [P] Add npm scripts for build, dev, lint, test in package.json

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T007 Create type definitions for all entities in src/core/types.ts (Platform, MessageRole, CursorDataStore, Workspace, ChatSession, Message, CodeBlock, ChatSessionSummary)
- [x] T008 [P] Implement platform detection and default paths in src/lib/platform.ts (getCursorDataPath for Windows/macOS/Linux)
- [x] T009 [P] Implement storage discovery in src/core/storage.ts (findWorkspaces, openDatabase, readWorkspaceJson)
- [x] T010 Implement chat data parser in src/core/parser.ts (parseChatData, extractCodeBlocks, parseMessages)
- [x] T011 Create public API exports in src/core/index.ts
- [x] T012 [P] Implement JSON output formatter in src/cli/formatters/json.ts
- [x] T013 [P] Implement table output formatter in src/cli/formatters/table.ts (with picocolors)
- [x] T014 Setup CLI entry point with commander in src/cli/index.ts (global options: --help, --version, --json, --data-path, --workspace)
- [x] T015 Implement exit codes and error handling utilities in src/lib/errors.ts

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - List Chat Sessions (Priority: P1) 🎯 MVP

**Goal**: Users can see a list of their Cursor chat sessions with date, workspace, and preview

**Independent Test**: Run `cursor-history --list` and verify it displays chat sessions sorted by date

### Implementation for User Story 1

- [x] T016 [US1] Implement listSessions function in src/core/storage.ts (returns ChatSessionSummary[], supports limit/all, filters by workspace)
- [x] T017 [US1] Implement listWorkspaces function in src/core/storage.ts (returns Workspace[] with session counts)
- [x] T018 [US1] Implement --list command handler in src/cli/commands/list.ts (--limit, --all, --workspaces flags)
- [x] T019 [US1] Add list table formatting in src/cli/formatters/table.ts (sessions table, workspaces table)
- [x] T020 [US1] Add list JSON formatting in src/cli/formatters/json.ts (ListOutput, WorkspacesOutput types)
- [x] T021 [US1] Wire --list command to CLI entry point in src/cli/index.ts
- [x] T022 [US1] Handle empty history case with helpful message in src/cli/commands/list.ts
- [x] T023 [US1] Handle Cursor not installed case with guidance in src/cli/commands/list.ts

**Checkpoint**: User Story 1 should be fully functional - `cursor-history --list` works

---

## Phase 4: User Story 2 - View Chat Content (Priority: P2)

**Goal**: Users can view the full content of a specific chat session with messages and code blocks

**Independent Test**: Run `cursor-history --show 1` and verify full conversation displays with formatting

### Implementation for User Story 2

- [x] T024 [US2] Implement getSession function in src/core/storage.ts (returns full ChatSession by index, loads messages)
- [x] T025 [US2] Implement code block extraction in src/core/parser.ts (extractCodeBlocks from message content)
- [x] T026 [US2] Implement --show command handler in src/cli/commands/show.ts (index argument, --full flag)
- [x] T027 [US2] Add show formatting in src/cli/formatters/table.ts (conversation display with markdown-like output)
- [x] T028 [US2] Add show JSON formatting in src/cli/formatters/json.ts (full session with messages)
- [x] T029 [US2] Wire --show command to CLI entry point in src/cli/index.ts
- [x] T030 [US2] Handle invalid index with error message in src/cli/commands/show.ts
- [x] T031 [US2] Handle index out of range with helpful message in src/cli/commands/show.ts

**Checkpoint**: User Stories 1 AND 2 work independently - MVP complete (list + view)

---

## Phase 5: User Story 3 - Search Chat History (Priority: P3)

**Goal**: Users can search across all chat sessions for keywords and see matching snippets

**Independent Test**: Run `cursor-history --search "keyword"` and verify matching sessions display with context

### Implementation for User Story 3

- [x] T032 [US3] Implement searchSessions function in src/core/storage.ts (keyword search, returns matches with snippets)
- [x] T033 [US3] Implement snippet extraction with context in src/core/parser.ts (getSearchSnippet with highlight positions)
- [x] T034 [US3] Implement --search command handler in src/cli/commands/search.ts (term argument, --limit, --context flags)
- [x] T035 [US3] Add search results formatting in src/cli/formatters/table.ts (results table with highlighted matches)
- [x] T036 [US3] Add search JSON formatting in src/cli/formatters/json.ts (SearchResult type with snippets)
- [x] T037 [US3] Wire --search command to CLI entry point in src/cli/index.ts
- [x] T038 [US3] Handle no results case with message in src/cli/commands/search.ts

**Checkpoint**: User Stories 1, 2, AND 3 work independently

---

## Phase 6: User Story 4 - Export Chat History (Priority: P4)

**Goal**: Users can export chat history to Markdown or JSON files

**Independent Test**: Run `cursor-history --export 1 -o chat.md` and verify valid Markdown file is created

### Implementation for User Story 4

- [x] T039 [US4] Implement exportToMarkdown function in src/core/parser.ts (ChatSession → Markdown string)
- [x] T040 [US4] Implement exportToJson function in src/core/parser.ts (ChatSession → formatted JSON string)
- [x] T041 [US4] Implement --export command handler in src/cli/commands/export.ts (index/--all, --output, --format, --force flags)
- [x] T042 [US4] Implement batch export logic in src/cli/commands/export.ts (--all exports to directory with naming convention)
- [x] T043 [US4] Wire --export command to CLI entry point in src/cli/index.ts
- [x] T044 [US4] Handle file exists without --force in src/cli/commands/export.ts
- [x] T045 [US4] Handle invalid format with error message in src/cli/commands/export.ts

**Checkpoint**: All user stories complete and independently functional

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T046 [P] Create README.md with installation, usage examples, and troubleshooting
- [ ] T047 [P] Create CHANGELOG.md with initial release notes
- [ ] T048 Configure build script for standalone binary in package.json (bun build --compile)
- [x] T049 [P] Add TTY detection for color output in src/cli/formatters/table.ts
- [ ] T050 [P] Add test fixtures with sample state.vscdb files in tests/fixtures/
- [ ] T051 Validate tool against real Cursor installation (manual testing per quickstart.md)
- [x] T052 [P] Add --version flag implementation in src/cli/index.ts (reads from package.json)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-6)**: All depend on Foundational phase completion
  - US1 (list) can start immediately after Phase 2
  - US2 (show) can start after Phase 2 (independent of US1)
  - US3 (search) can start after Phase 2 (independent of US1/US2)
  - US4 (export) can start after Phase 2 (independent of US1/US2/US3)
- **Polish (Phase 7)**: Depends on at least US1 being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - Uses same storage functions as US1 but independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - Independent search implementation
- **User Story 4 (P4)**: Can start after Foundational (Phase 2) - Uses storage functions, independent export

### Within Each User Story

- Core function before command handler
- Command handler before formatters (for that command)
- Wire to CLI after handler is complete
- Error handling as final step

### Parallel Opportunities

- T003, T004, T005, T006 (all setup tasks) can run in parallel
- T008, T009 (platform.ts, storage.ts initial) can run in parallel
- T012, T013 (formatters) can run in parallel
- Once Phase 2 completes, US1-US4 can run in parallel (different developers)
- Within each user story, [P] tasks can run in parallel

---

## Parallel Example: Foundation Phase

```bash
# Launch in parallel after T007 (types.ts):
Task: "Implement platform detection in src/lib/platform.ts"
Task: "Implement storage discovery in src/core/storage.ts"
Task: "Implement JSON formatter in src/cli/formatters/json.ts"
Task: "Implement table formatter in src/cli/formatters/table.ts"
```

## Parallel Example: User Story 1

```bash
# After T016-T017 (core storage functions):
Task: "Add list table formatting in src/cli/formatters/table.ts"
Task: "Add list JSON formatting in src/cli/formatters/json.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 + 2)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (--list)
4. Complete Phase 4: User Story 2 (--show)
5. **STOP and VALIDATE**: Test both commands work independently
6. Release as v0.1.0 MVP

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 (--list) → Test independently → Release v0.1.0 (list only)
3. Add User Story 2 (--show) → Test independently → Release v0.2.0 (list + view = MVP)
4. Add User Story 3 (--search) → Test independently → Release v0.3.0
5. Add User Story 4 (--export) → Test independently → Release v0.4.0
6. Polish phase → Release v1.0.0

### Parallel Team Strategy

With multiple developers after Phase 2:
- Developer A: User Story 1 (list)
- Developer B: User Story 2 (show)
- Developer C: User Story 3 (search)
- Developer D: User Story 4 (export)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [USn] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- MVP = US1 (list) + US2 (show) - minimum viable product
- better-sqlite3 requires native compilation - may need node-gyp on some systems
