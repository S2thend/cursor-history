# Tasks: Retrieve Session by Composer ID or Index

**Input**: Design documents from `/specs/011-session-by-id-or-index/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required regression coverage for global vs workspace-filtered ordering, stable-ID lookup, custom data paths, and backups.

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

- [x] T002 Extend getSession to accept identifier (number | string) in src/core/storage.ts: resolve a number from the operation context's current summaries when available; resolve a string as a global stable ID for the active data source; when not found return null
- [x] T003 Extend SessionNotFoundError to support (identifier: string | number, maxIndex?: number) in src/cli/errors.ts: when identifier is string or maxIndex undefined use generic message including identifier; else use "Session #n not found. Valid range: 1–maxIndex"

**Checkpoint**: Foundation ready — CLI and library can now use getSession(identifier) and correct CLI error shape

---

## Phase 3: User Story 1 & 2 - CLI Show and Export by Index or ID (Priority: P1) MVP

**Goal**: Users can view or export a session by passing either a list index (1, 2, …) or a composer ID; correct error messages for not-found (range for index, generic + ID for composer ID).

**Independent Test**: Run `cursor-history list`, then `cursor-history show <id>` with an ID from the list; run `cursor-history show 1`; run `cursor-history show invalid-id` and confirm "Session not found: invalid-id"; run `cursor-history show 999` (out of range) and confirm valid range message. Same for export.

### Implementation for User Story 1 & 2

- [x] T004 [US1] [US2] Add one shared CLI resolver in `src/cli/commands/session-lookup.ts`: workspace-scoped numeric index → cached summary → stable ID; non-numeric ID → global lookup; preserve index-range and invalid-ID error shapes
- [x] T005 [US1] [US2] Use the shared resolver from both `src/cli/commands/show.ts` and `src/cli/commands/export.ts` so the two commands cannot drift

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
- [x] T010 Reproduce Issue #33 with two deliberately conflicting workspace/global orders and verify filtered list/get/search/export/library flows resolve summaries by stable ID
- [x] T011 Add real Composer SQLite integration coverage for a custom live data path and a generated backup archive; both must round-trip filtered index 1 to the same workspace session and exclude the other workspace from search

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
- T010 and T011 validate the shared resolver after Phases 3 and 4

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
| Polish  | —       | T008–T011   | 4     |
| **Total** |        |            | **11** |

---

## Notes

- Each task includes exact file path(s)
- [US1] [US2] on T004/T005: same commands deliver both “by ID” and “by index” behavior
- Regression and integration tests are part of completion, not a follow-up
- Keep Issue #33 delivery independently reviewable from Store-stack PR #32
