# Tasks: Retrieve Session by Composer ID or Index

**Input**: Design documents from `/specs/011-session-by-id-or-index/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Not explicitly requested in spec; optional verification in Polish phase.

**Organization**: Tasks grouped by user story so each story can be implemented and tested independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story (US1, US2, US3)
- File paths are in task descriptions

## Path Conventions

- Single project: `src/` at repository root (`src/core/`, `src/cli/`, `src/lib/`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify feature context and design docs

- [x] T001 Verify feature branch `011-session-by-id-or-index` and design docs in specs/011-session-by-id-or-index/ (plan.md, spec.md, quickstart.md) are present

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core and error changes that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 Extend getSession to accept identifier (number | string) in src/core/storage.ts: when string call resolveSessionIdentifiers([identifier], customDataPath) and load session by resolved ID; when number keep current 1-based index logic; when not found return null
- [x] T003 Extend SessionNotFoundError to support (identifier: string | number, maxIndex?: number) in src/cli/errors.ts: when identifier is string or maxIndex undefined use generic message including identifier; else use "Session #n not found. Valid range: 1–maxIndex"

**Checkpoint**: Foundation ready — CLI and library can now use getSession(identifier) and correct CLI error shape

---

## Phase 3: User Story 1 & 2 - CLI Show and Export by Index or ID (Priority: P1) MVP

**Goal**: Users can view or export a session by passing either a list index (1, 2, …) or a composer ID; correct error messages for not-found (range for index, generic + ID for composer ID).

**Independent Test**: Run `cursor-history list`, then `cursor-history show <id>` with an ID from the list; run `cursor-history show 1`; run `cursor-history show invalid-id` and confirm "Session not found: invalid-id"; run `cursor-history show 999` (out of range) and confirm valid range message. Same for export.

### Implementation for User Story 1 & 2

- [x] T004 [US1] [US2] In show command parse argument as index (positive integer/numeric string) or ID (non-numeric string); call getSession(identifier, ...); on null throw SessionNotFoundError(index, count); on thrown SessionNotFoundError from core rethrow or map to CLI SessionNotFoundError(identifier) so message includes invalid ID in src/cli/commands/show.ts
- [x] T005 [US1] [US2] In export command for single-session path parse index-or-id same as show; call getSession(identifier, ...); apply same not-found handling (range for index, generic+ID for composer ID) in src/cli/commands/export.ts

**Checkpoint**: CLI show and export accept index or ID with correct errors; User Story 1 and 2 are satisfied

---

## Phase 4: User Story 3 - Programmatic Retrieval by ID or Index (Priority: P2)

**Goal**: Library callers can get or export a session via a single function that accepts either 0-based index or composer ID string.

**Independent Test**: Call getSession(0) and getSession(sessionId) and assert same session when ID matches first; call getSession('bad') and catch SessionNotFoundError with identifier; same for exportSessionToJson / exportSessionToMarkdown.

### Implementation for User Story 3

- [x] T006 [US3] Change getSession to getSession(identifier: number | string, config?) in src/lib/index.ts: when number convert to 1-based and call core getSession(coreIndex, ...); when string call core getSession(identifier, ...); map null to library SessionNotFoundError with identifier
- [x] T007 [US3] Update exportSessionToJson and exportSessionToMarkdown to accept identifier: number | string and pass through to core (0-based to 1-based when number) in src/lib/index.ts

**Checkpoint**: Library getSession and single-session export accept index or ID; User Story 3 satisfied

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and verification

- [x] T008 [P] Update README or CLAUDE.md with identifier semantics for show/export and getSession (index or composer ID) in project root
- [x] T009 Run quickstart.md verification steps: show by ID, show by index, show invalid-id, show out-of-range; export by ID/index; library getSession(0) and getSession(id)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all user stories
- **Phase 3 (US1+US2)**: Depends on Phase 2
- **Phase 4 (US3)**: Depends on Phase 2 (can run in parallel with Phase 3 if desired)
- **Phase 5 (Polish)**: Depends on Phase 3 and Phase 4

### User Story Dependencies

- **User Story 1 & 2 (P1)**: After Phase 2; implemented together in Phase 3 (same show/export commands)
- **User Story 3 (P2)**: After Phase 2; Phase 4

### Parallel Opportunities

- T008 can run in parallel with T009 after implementation is done
- Phase 3 (T004, T005) and Phase 4 (T006, T007) could be done by different people after Phase 2

---

## Parallel Example: After Foundational

```text
# Option A: CLI first
T004 show.ts → T005 export.ts (sequential in same phase)

# Option B: Library first
T006 getSession in lib/index.ts → T007 export functions in lib/index.ts (sequential)

# Option C: Different owners
Developer A: T004, T005 (CLI)
Developer B: T006, T007 (Library)
```

---

## Implementation Strategy

### MVP First (User Story 1 & 2)

1. Complete Phase 1 (Setup)
2. Complete Phase 2 (Foundational)
3. Complete Phase 3 (CLI show and export by index or ID)
4. **STOP and VALIDATE**: Manual test per Independent Test above
5. Ship CLI support as MVP

### Incremental Delivery

1. Phase 1 + 2 → foundation
2. Phase 3 → CLI MVP (show/export by index or ID)
3. Phase 4 → Library parity (getSession/export by identifier)
4. Phase 5 → Docs and verification

### Task Summary

| Phase   | Story   | Task IDs   | Count |
|---------|---------|------------|-------|
| Setup   | —       | T001       | 1     |
| Foundational | —   | T002, T003  | 2     |
| US1+US2 | P1 CLI  | T004, T005  | 2     |
| US3     | P2 Lib  | T006, T007  | 2     |
| Polish  | —       | T008, T009  | 2     |
| **Total** |        |            | **9** |

---

## Notes

- Each task includes exact file path(s)
- [US1] [US2] on T004/T005: same commands deliver both “by ID” and “by index” behavior
- No separate test phase; add unit/integration tests in a follow-up if desired
- Commit after each task or after each phase checkpoint
