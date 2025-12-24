# Tasks: Library API for Cursor History Access

**Input**: Design documents from `/specs/002-library-api/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: No explicit test generation requested in specification. Tests are NOT included in this task list per feature requirements.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `- [ ] [ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add library interface to existing structure (no renaming)

- [ ] T001 Create `src/lib/types.ts` for public TypeScript type exports (Session, Message, ToolCall, SearchResult, LibraryConfig, PaginatedResult)
- [ ] T002 Create `src/lib/config.ts` for configuration handling and validation logic
- [ ] T003 [P] Create `src/lib/index.ts` as main library entry point (will contain all exported functions)
- [ ] T004 [P] Create `tests/lib/` directory structure with `integration/` and `unit/` subdirectories
- [ ] T005 [P] Update package.json with library exports configuration (main, types, exports fields for dual ESM/CJS)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core utilities and error handling that MUST be complete before ANY user story

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T006 Add custom error classes to `src/lib/errors.ts` (DatabaseLockedError, DatabaseNotFoundError, InvalidConfigError)
- [ ] T007 Add type guard functions to `src/lib/errors.ts` (isDatabaseLockedError, isDatabaseNotFoundError, isInvalidConfigError)
- [ ] T008 Implement config validation in `src/lib/config.ts` (validateConfig function for limit, offset, context, workspace, dataPath)
- [ ] T009 Implement default path resolution in `src/lib/config.ts` (mergeWithDefaults function)
- [ ] T010 Implement path resolution utilities in `src/lib/config.ts` (resolveDatabasePath with symlink handling via fs.realpathSync)
- [ ] T011 [P] Refactor `src/core/storage.ts` to extract stateless query functions (separate DB connection logic from queries)
- [ ] T012 [P] Update `src/lib/platform.ts` to export getDefaultDataPath() for library use

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Programmatic Access to Chat Sessions (Priority: P1) 🎯 MVP

**Goal**: Enable developers to list and retrieve chat sessions programmatically with pagination support

**Independent Test**: Import library via `import { listSessions, getSession } from 'cursor-history'`, call functions, verify data matches CLI output

### Implementation for User Story 1

- [ ] T013 [US1] Implement `listSessions(config?)` function in `src/lib/index.ts` with stateless DB open/close pattern
- [ ] T014 [US1] Implement pagination logic in listSessions() returning PaginatedResult<Session>
- [ ] T015 [US1] Implement workspace filtering in listSessions() function
- [ ] T016 [P] [US1] Implement `getSession(index, config?)` function in `src/lib/index.ts`
- [ ] T017 [US1] Add database connection error handling (DatabaseLockedError, DatabaseNotFoundError) to listSessions()
- [ ] T018 [US1] Add database connection error handling (DatabaseLockedError, DatabaseNotFoundError) to getSession()
- [ ] T019 [US1] Implement corrupted entry skip logic with console.warn in session parsing
- [ ] T020 [US1] Add config validation calls in listSessions() and getSession()
- [ ] T021 [US1] Export all public types from `src/lib/index.ts` (re-export from types.ts)
- [ ] T022 [US1] Export all error classes from `src/lib/index.ts` (re-export from errors.ts)
- [ ] T023 [US1] Refactor CLI `src/cli/commands/list.ts` to use library listSessions() instead of direct storage calls
- [ ] T024 [US1] Refactor CLI `src/cli/commands/show.ts` to use library getSession() instead of direct storage calls

**Checkpoint**: MVP complete - can list sessions, get individual sessions, with pagination and workspace filtering via simple imports

---

## Phase 4: Enhanced Message Data - Tool Calls, Thinking, Metadata (Priority: P2)

**Goal**: Enrich library Message objects with tool calls, thinking text, and metadata that are already extracted by the core storage layer but not currently exposed in the library API

**Independent Test**: Call `getSession(0)` and verify messages contain `toolCalls`, `thinking`, and `metadata` fields when available

**Note**: This phase enhances the existing core types to preserve data that's already being extracted for CLI display. No changes to CLI behavior.

### Implementation for Enhanced Message Data

- [ ] T024A [P] Add optional fields to `src/core/types.ts` Message interface (toolCalls?: ToolCall[], thinking?: string, metadata?: object)
- [ ] T024B [P] Add ToolCall interface to `src/core/types.ts` (name, status, params, result, error, files)
- [ ] T024C Update `src/core/parser.ts` parseChatData() to populate toolCalls array from bubble data
- [ ] T024D Update `src/core/parser.ts` parseChatData() to populate thinking field from extractThinkingText()
- [ ] T024E Update `src/core/parser.ts` parseChatData() to populate metadata field (corrupted flag, bubbleType)
- [ ] T024F Update `src/core/storage.ts` extractBubbleText() to return structured data instead of just text
- [ ] T024G Update `src/lib/index.ts` convertToLibrarySession() to map toolCalls/thinking/metadata from core Message
- [ ] T024H Remove comment about fields not being captured (they now are)
- [ ] T024I Verify CLI formatters still work with enhanced Message type (backward compatible)

**Checkpoint**: Library messages now include rich metadata - tool calls, thinking text, and corruption flags

---

## Phase 5: User Story 4 - Custom Data Path Configuration (Priority: P2)

**Goal**: Support custom Cursor data paths for non-standard installations and testing

**Independent Test**: Call `listSessions({dataPath: '/custom/path'})` and verify it reads from specified location

**Note**: Implementing US4 before US2 because it's a configuration enhancement that other stories may benefit from

### Implementation for User Story 4

- [ ] T025 [P] [US4] Add dataPath validation logic to `src/lib/config.ts` (check directory exists and is readable)
- [ ] T026 [US4] Add special character handling for paths in resolveDatabasePath()
- [ ] T027 [US4] Export `getDefaultDataPath()` function from `src/lib/index.ts`
- [ ] T028 [US4] Add dataPath error messages to InvalidConfigError construction
- [ ] T029 [US4] Update listSessions() to use validated and resolved dataPath from config
- [ ] T030 [US4] Update getSession() to use validated and resolved dataPath from config
- [ ] T031 [US4] Test platform-specific default paths on current OS

**Checkpoint**: Library now supports custom data paths and handles edge cases (symlinks, special chars, validation)

---

## Phase 6: User Story 2 - Search Functionality (Priority: P2)

**Goal**: Enable programmatic search across chat history with context snippets

**Independent Test**: Call `searchSessions('authentication')` and verify results include matching sessions with context

### Implementation for User Story 2

- [ ] T032 [US2] Implement `searchSessions(query, config?)` function in `src/lib/index.ts`
- [ ] T033 [US2] Implement case-insensitive substring matching logic in searchSessions()
- [ ] T034 [US2] Implement context line extraction (contextBefore, contextAfter) based on config.context parameter
- [ ] T035 [US2] Build SearchResult objects with session reference, match, messageIndex, and offset
- [ ] T036 [US2] Add workspace filtering support to searchSessions()
- [ ] T037 [US2] Handle empty search results (return empty array without errors)
- [ ] T038 [US2] Add database connection error handling to searchSessions()
- [ ] T039 [US2] Refactor CLI `src/cli/commands/search.ts` to use library searchSessions() function

**Checkpoint**: Search functionality fully integrated - can find conversations with context snippets

---

## Phase 7: User Story 3 - Export and Format Conversion (Priority: P3)

**Goal**: Enable exporting chat sessions to JSON and Markdown formats

**Independent Test**: Call `exportSessionToJson(0)` and `exportSessionToMarkdown(0)`, verify output matches CLI export format

### Implementation for User Story 3

- [ ] T040 [P] [US3] Implement `exportSessionToJson(index, config?)` function in `src/lib/index.ts`
- [ ] T041 [P] [US3] Implement `exportSessionToMarkdown(index, config?)` function in `src/lib/index.ts`
- [ ] T042 [P] [US3] Implement `exportAllSessionsToJson(config?)` function in `src/lib/index.ts`
- [ ] T043 [P] [US3] Implement `exportAllSessionsToMarkdown(config?)` function in `src/lib/index.ts`
- [ ] T044 [US3] Extract JSON formatting logic from `src/core/parser.ts` (or reuse exportToJson)
- [ ] T045 [US3] Extract Markdown formatting logic from `src/core/parser.ts` (or reuse exportToMarkdown)
- [ ] T046 [US3] Add workspace filtering to exportAll functions
- [ ] T047 [US3] Add database connection error handling to all export functions
- [ ] T048 [US3] Refactor CLI `src/cli/commands/export.ts` to use library export functions

**Checkpoint**: All export formats working - can export single sessions and all sessions to JSON/Markdown

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, and final integration

- [ ] T049 [P] Update package.json with correct "main" pointing to `dist/lib/index.js`
- [ ] T050 [P] Update package.json with "types" pointing to `dist/lib/index.d.ts`
- [ ] T051 [P] Add package.json "exports" field for dual ESM/CJS support
- [ ] T052 [P] Verify TypeScript declaration files generate correctly (`npm run build` produces .d.ts)
- [ ] T053 [P] Create simple test script in `examples/basic.mjs` demonstrating ESM import
- [ ] T054 [P] Create simple test script in `examples/basic.cjs` demonstrating CommonJS require
- [ ] T055 Test tree-shaking: verify unused exports don't get bundled (create rollup test)
- [ ] T056 [P] Update README.md with library usage section showing import examples
- [ ] T057 [P] Add "Library API" section to README with quick examples from quickstart.md
- [ ] T058 Run linting and type checking on all new `src/lib/` code
- [ ] T059 Verify CLI still works after refactoring (run existing CLI manually: `npm run build && node dist/cli/index.js list`)
- [ ] T060 Update CHANGELOG.md with library API feature additions
- [ ] T061 Create manual validation: test DatabaseLockedError (run while Cursor is open)
- [ ] T062 Create manual validation: test pagination with limit/offset parameters
- [ ] T063 Create manual validation: test corrupted entry console.warn output
- [ ] T064 Verify quickstart.md examples work (copy-paste into Node REPL)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-7)**: All depend on Foundational phase completion
  - US1 (Phase 3): Must complete first (MVP)
  - Enhanced Message Data (Phase 4): Can start after US1, enhances core types
  - US4 (Phase 5): Can start after US1, enhances configuration
  - US2 (Phase 6): Can start after US1, independent of US4/Phase 4
  - US3 (Phase 7): Can start after US1, independent of US2/US4/Phase 4
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories ✅ MVP
- **Enhanced Message Data (P2)**: Can start after US1 - Enhances core types, independent of user stories
- **User Story 4 (P2)**: Can start after US1 - Enhances configuration but doesn't block other stories
- **User Story 2 (P2)**: Can start after US1 - Independent of US4 and Enhanced Message Data
- **User Story 3 (P3)**: Can start after US1 - Reuses list/get functionality, independent of US2/US4/Enhanced Message Data

### Within Each User Story

- Core types and errors before API functions (Phase 2 must be complete)
- API function implementation before CLI refactoring
- Basic functionality before error handling enhancements
- Story complete before moving to next priority

### Parallel Opportunities

**Phase 1 (Setup)**: T003, T004, T005 can run in parallel (different files)

**Phase 2 (Foundational)**: T011, T012 can run in parallel (different files)

**Phase 3 (US1)**:
- T016 can run in parallel with T013-T015 (getSession is independent of listSessions)
- T021, T022 can run in parallel (different exports)
- T023, T024 can run in parallel (different CLI command files)

**Phase 4 (Enhanced Message Data)**:
- T024A, T024B can run in parallel (different interface additions)

**Phase 5 (US4)**:
- T025 can run before other US4 tasks

**Phase 6 (US2)**:
- T032-T037 are closely related, should be done sequentially

**Phase 7 (US3)**:
- T040, T041, T042, T043 can run in parallel (4 different export functions)

**Phase 8 (Polish)**:
- T049-T058 can all run in parallel (different files/independent tasks)

---

## Parallel Example: User Story 1

```bash
# After T013-T015 complete, launch in parallel:
Task: "Implement getSession(index, config?) function in src/lib/index.ts"

# After all functions complete, refactor CLI in parallel:
Task: "Refactor CLI list.ts to use library listSessions()"
Task: "Refactor CLI show.ts to use library getSession()"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T005) - ~30 min
2. Complete Phase 2: Foundational (T006-T012) - ~2 hours (CRITICAL)
3. Complete Phase 3: User Story 1 (T013-T024) - ~3 hours
4. **STOP and VALIDATE**: Test User Story 1 independently
   - Can import: `import { listSessions, getSession } from 'cursor-history'`
   - Can list sessions: `const result = listSessions()`
   - Can get session: `const session = getSession(0)`
   - Can paginate: `listSessions({ limit: 10, offset: 0 })`
   - Can filter: `listSessions({ workspace: '/path' })`
   - CLI still works
5. **MVP COMPLETE** - Ship User Story 1

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready (~2.5 hours)
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!) (~3 hours total: ~5.5 hours)
3. Add User Story 4 → Test independently → Deploy/Demo (~1.5 hours total: ~7 hours)
4. Add User Story 2 → Test independently → Deploy/Demo (~2 hours total: ~9 hours)
5. Add User Story 3 → Test independently → Deploy/Demo (~2 hours total: ~11 hours)
6. Add Polish → Final release (~2 hours total: ~13 hours)

**Total Estimated Time**: ~13-15 hours for complete implementation

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (~2.5 hours)
2. Once Foundational is done:
   - Developer A: User Story 1 (MVP, sequential)
3. Once US1 is complete:
   - Developer A: User Story 4
   - Developer B: User Story 2 (can work in parallel)
   - Developer C: User Story 3 (can work in parallel)
4. Stories complete and integrate independently

**With 3 Developers**: ~6-7 hours total elapsed time (vs 13-15 hours with 1 developer)

---

## Task Counts

- **Total Tasks**: 73 (64 original + 9 new for Enhanced Message Data)
- **Phase 1 (Setup)**: 5 tasks
- **Phase 2 (Foundational)**: 7 tasks (CRITICAL PATH)
- **Phase 3 (US1 - MVP)**: 12 tasks
- **Phase 4 (Enhanced Message Data)**: 9 tasks (NEW)
- **Phase 5 (US4)**: 7 tasks
- **Phase 6 (US2)**: 8 tasks
- **Phase 7 (US3)**: 9 tasks
- **Phase 8 (Polish)**: 16 tasks

**Parallel Tasks**: 27 tasks marked [P] (37% can run in parallel with proper coordination)

**MVP Scope**: Phases 1-3 (24 tasks) delivers core programmatic access via simple imports
**Enhanced MVP**: Phases 1-4 (33 tasks) adds rich message metadata (tool calls, thinking, flags)

---

## Notes

- [P] tasks = different files or non-conflicting changes, can run in parallel
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- No tests included per specification (tests not explicitly requested)
- **No directory renaming**: `src/lib/` stays as is, we're adding to it
- **No network API**: Just TypeScript functions for direct import/use
- Focus on simplicity: stateless design, no new dependencies, no connection pooling
- Existing CLI tests should continue to pass after refactoring
- Constitution adherence: all decisions favor simplicity and incremental delivery
