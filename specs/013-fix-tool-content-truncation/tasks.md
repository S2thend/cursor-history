# Tasks: Fix Tool Content Truncation

**Input**: Design documents from `specs/013-fix-tool-content-truncation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Test tasks are included — this is a pure normalization fix and regression safety requires explicit coverage of all priority chain branches.

**Organization**: Tasks are grouped by user story. All implementation is in `src/core/storage.ts`; all tests are in `tests/unit/storage.test.ts`. No setup or foundational phase needed — no new infrastructure, no new files, no dependencies to install.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: User Story 1 & 2 — read_file_v2 and edit_file_v2 explicit branches (Priority: P1) 🎯 MVP

**Goal**: Add explicit `read_file_v2` and `edit_file_v2` branches to `formatToolCall()` with full priority-chain content extraction and no storage-layer truncation. These are the primary data-loss bugs from issue #25.

**Independent Test**: Fetch a session containing `read_file_v2` or `edit_file_v2` tool messages via the library API. `message.content` must contain the full content with no `...` suffix. Run `npm test` — all new tests in the `getSession (more tool types)` describe block must pass.

### Implementation for User Story 1 & 2

- [ ] T001 [US1] Extend `formatToolCall()` signature in `src/core/storage.ts` to accept an optional `codeBlocks?: Array<{ content?: unknown }>` parameter (add as second param with default `undefined`)
- [ ] T002 [US1] Add `read_file_v2` branch to `formatToolCall()` in `src/core/storage.ts`: emit `[Tool: Read File v2]`, extract file path via `getParam(params, 'targetFile', 'path', 'file', 'effectiveUri')`, then run priority chain — (1) parse `toolData.result` JSON → `result.contents` if string and non-whitespace; (2) `codeBlocks?.[0]?.content` if string and non-whitespace; (3) JSON.stringify of first non-string named candidate encountered; (4) no Content line if none found. Wrap in try/catch on result parse; call `debugLogStorage('storage', 'read_file_v2: failed to parse result JSON', e)` on failure.
- [ ] T003 [US2] Add `edit_file_v2` branch to `formatToolCall()` in `src/core/storage.ts`: emit `[Tool: Edit File v2]`, extract file path via `getParam(params, 'targetFile', 'path', 'file', 'relativeWorkspacePath')`, then run priority chain — (1) `streamingContent` param if string and non-whitespace; (2) `content` param if string and non-whitespace; (3) `fileContent` param if string and non-whitespace; (4) `codeBlocks?.[0]?.content` if string and non-whitespace; (5) JSON.stringify of first non-string named candidate encountered; (6) no Content line if none found. Call `debugLogStorage('storage', 'edit_file_v2: params/rawArgs could not be parsed as object', ...)` when `parseToolParams` returns `{ _raw: ... }` sentinel.
- [ ] T004 [US1] Update the `formatToolCall()` call site in `extractBubbleText()` in `src/core/storage.ts` (line ~1321) to pass the bubble-level `codeBlocks` field as the new second argument: `formatToolCall(toolFormerData, data['codeBlocks'] as Array<{ content?: unknown }> | undefined)`
- [ ] T005 [US1] In `extractBubbleText()` in `src/core/storage.ts`, remove the existing 200-char-truncated `codeBlocks` append block (lines ~1324–1329) for `read_file_v2` and `edit_file_v2` only — these branches now handle `codeBlocks` internally. Retain the existing block for all other tool types.

### Tests for User Story 1 & 2

- [ ] T006 [P] [US1] Add test `read_file_v2 — full result.contents` in `tests/unit/storage.test.ts` (`getSession (more tool types)` describe): bubble with `toolFormerData.name = 'read_file_v2'`, `result = JSON.stringify({ contents: 'x'.repeat(500) })`; assert `message.content` contains the 500-char string with no `...`
- [ ] T007 [P] [US1] Add test `read_file_v2 — codeBlocks fallback` in `tests/unit/storage.test.ts`: bubble with `read_file_v2`, result JSON missing `contents`; bubble has `codeBlocks: [{ content: 'fallback content' }]`; assert `message.content` contains `'fallback content'`
- [ ] T008 [P] [US1] Add test `read_file_v2 — JSON.stringify fallback` in `tests/unit/storage.test.ts`: bubble with `read_file_v2`, result JSON has `contents: { nested: true }` (non-string); assert `message.content` contains `JSON.stringify({ nested: true })`
- [ ] T009 [P] [US1] Add test `read_file_v2 — malformed result JSON` in `tests/unit/storage.test.ts`: `result = '{'`; assert no throw, `message.content` contains `[Tool: Read File v2]` and does not contain `Content:`
- [ ] T010 [P] [US1] Add test `read_file_v2 — whitespace-only contents` in `tests/unit/storage.test.ts`: `result = JSON.stringify({ contents: '   ' })`; bubble has `codeBlocks: [{ content: 'real content' }]`; assert `message.content` contains `'real content'` (whitespace skipped)
- [ ] T011 [P] [US2] Add test `edit_file_v2 — full streamingContent` in `tests/unit/storage.test.ts`: `params = JSON.stringify({ targetFile: '/f.ts', streamingContent: 'x'.repeat(200) })`; assert full 200-char string in content, no `...`
- [ ] T012 [P] [US2] Add test `edit_file_v2 — content param fallback` in `tests/unit/storage.test.ts`: no `streamingContent`; `content` param present; assert `content` value used
- [ ] T013 [P] [US2] Add test `edit_file_v2 — codeBlocks fallback` in `tests/unit/storage.test.ts`: no string params; `codeBlocks: [{ content: 'block content' }]`; assert used
- [ ] T014 [P] [US2] Add test `edit_file_v2 — malformed params` in `tests/unit/storage.test.ts`: `params = '{'`, no `rawArgs`; assert no throw, `message.content` contains `[Tool: Edit File v2]`
- [ ] T015 [P] [US2] Add test `edit_file_v2 — userDecision rejected with full content` in `tests/unit/storage.test.ts`: full `streamingContent` + `additionalData.userDecision = 'rejected'`; assert content present and `User Decision: ✗ rejected` present

**Checkpoint**: `npm test` passes. `message.content` for `read_file_v2` and `edit_file_v2` contains full content. User Stories 1 and 2 complete.

---

## Phase 2: User Story 3 — Full terminal command output (Priority: P2)

**Goal**: Remove the 500-char truncation from the `run_terminal_command` branch in `formatToolCall()` in `src/core/storage.ts`.

**Independent Test**: Fetch a session with a `run_terminal_command` message whose output exceeds 500 characters. `message.content` must contain the full output with no `...` suffix.

### Implementation for User Story 3

- [ ] T016 [US3] In `formatToolCall()` in `src/core/storage.ts`, in the `run_terminal_command` / `run_terminal_cmd` / `execute_command` branch (~L1100): remove `output.slice(0, 500)` → emit `output` directly; remove the ternary `output.length > 500 ? '...' : ''` suffix

### Tests for User Story 3

- [ ] T017 [P] [US3] Add test `run_terminal_command — output > 500 chars` in `tests/unit/storage.test.ts`: `result = JSON.stringify({ output: 'x'.repeat(600) })`; assert full 600-char string in content, no `...`
- [ ] T018 [P] [US3] Add test `run_terminal_command — empty output` in `tests/unit/storage.test.ts`: `result = JSON.stringify({ output: '' })`; assert no `Output:` line in content (existing behaviour preserved)

**Checkpoint**: `npm test` passes. Full terminal output in `message.content`.

---

## Phase 3: User Story 4 — Full content from legacy read_file (Priority: P2)

**Goal**: Remove the 300-char truncation from the `read_file` (legacy) branch in `formatToolCall()` in `src/core/storage.ts`. All other logic unchanged.

**Independent Test**: Fetch a session with a `read_file` message whose `result.contents` exceeds 300 characters. `message.content` must contain the full content with no `...` suffix.

### Implementation for User Story 4

- [ ] T019 [US4] In `formatToolCall()` in `src/core/storage.ts`, in the `read_file` branch (~L1068): remove `.slice(0, 300)` from `result.contents`; remove the `.replace(/\n/g, '\\n')` call (newlines should be preserved in `Message.content` for the library API); remove the ternary `result.contents.length > 300 ? '...' : ''` suffix. Keep `lines.push(\`Content: ${result.contents}\`)`.

### Tests for User Story 4

- [ ] T020 [P] [US4] Add test `read_file — result.contents > 300 chars` in `tests/unit/storage.test.ts`: `result = JSON.stringify({ contents: 'y'.repeat(400) })`; assert full 400-char string in content, no `...`
- [ ] T021 [P] [US4] Update existing test `read_file with content preview` in `tests/unit/storage.test.ts` (~L1688): verify it still passes with full content (test was asserting partial content — update assertion if it checked for truncation)

**Checkpoint**: `npm test` passes. Full file content in `message.content` for legacy `read_file`.

---

## Phase 4: User Story 5 — CLI display non-regression (Priority: P2)

**Goal**: Verify that the display layer still shows a preview without `--fullread` and full content with `--fullread`, confirming no regression from the storage-layer changes.

**Independent Test**: Run `cursor-history show <index>` on a session with a `read_file_v2` or `read_file` call. Without `--fullread` the terminal shows a preview; with `--fullread` the full content appears.

### Implementation for User Story 5

- [ ] T022 [US5] Verify `formatToolCallDisplay()` in `src/cli/formatters/table.ts` — confirm the function already handles `Content:` lines via its existing line-by-line iteration and `fullTool` parameter. No code changes expected. Document finding in a code comment if the function's behaviour is non-obvious.

### Tests for User Story 5

- [ ] T023 [P] [US5] Add test `formatToolCallDisplay truncates Content line without fullTool` in `tests/unit/cli-formatters-table.test.ts`: pass a `message.content` string containing a long `Content:` line (e.g. 500+ chars); call with `fullTool = false`; assert the rendered output is shorter than the input
- [ ] T024 [P] [US5] Add test `formatToolCallDisplay preserves Content line with fullTool` in `tests/unit/cli-formatters-table.test.ts`: same input; call with `fullTool = true`; assert the full content is present in the rendered output

**Checkpoint**: `npm test` passes. Display layer correctly previews and expands content. All 5 user stories complete.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Generic tool branch cleanup and final validation.

- [ ] T025 [P] In `formatToolCall()` in `src/core/storage.ts`, generic `else` branch (~L1137–1142): remove `val.length > 100 ? val.slice(0, 100) + '...' : val` — emit `val` directly for all string params
- [ ] T026 [P] In `formatToolCall()` in `src/core/storage.ts`, generic `else` branch (~L1151–1152): remove `resultText.slice(0, 500)` — emit `resultText` directly; remove the ternary `resultText.length > 500 ? '...' : ''` suffix
- [ ] T027 [P] Add non-regression test `generic tool — string param > 100 chars` in `tests/unit/storage.test.ts`: unknown tool name, param value 150 chars; assert full value in content, no `...`
- [ ] T028 [P] Add non-regression test `list_dir — content unchanged` in `tests/unit/storage.test.ts`: assert content is identical to pre-fix expected value (path only, no truncation was ever applied here)
- [ ] T029 [P] Add non-regression test `edit_file — oldString/newString still truncated at 100` in `tests/unit/storage.test.ts`: `oldString` of 150 chars; assert content contains the 100-char truncated form with `...` (these truncations are intentional and remain in scope)
- [ ] T030 Run `npm test` — full test suite must pass with zero failures
- [ ] T031 Run `npm run typecheck` — zero TypeScript errors
- [ ] T032 Run `npm run lint` — zero lint errors
- [ ] T033 Update `CLAUDE.md` Recent Changes section with a summary of this feature's changes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (US1 & US2)**: No prerequisites — start immediately
- **Phase 2 (US3)**: Independent of Phase 1 — can run in parallel
- **Phase 3 (US4)**: Independent of Phases 1–2 — can run in parallel
- **Phase 4 (US5)**: Should follow Phase 1 (storage changes must exist to verify display behaviour)
- **Phase 5 (Polish)**: Should follow all user story phases

### User Story Dependencies

- **US1 (read_file_v2)**: Independent — start immediately
- **US2 (edit_file_v2)**: Shares T001 (signature change) with US1; T003 can start after T001
- **US3 (terminal)**: Independent of US1/US2 — parallel
- **US4 (read_file legacy)**: Independent of US1/US2/US3 — parallel
- **US5 (CLI display)**: Depends on US1 storage changes existing; tests are read-only formatter verification

### Within Each Phase

- Implementation tasks first (T001–T005 sequentially for US1/US2 due to shared signature change)
- Test tasks [P] can all be written in parallel after implementation is done

### Parallel Opportunities

- T002 and T003 can be written in parallel (different branches), both after T001
- T006–T015 (all test tasks for US1/US2) can be written in parallel
- T016, T019, T025, T026 are all independent one-line removals — fully parallel
- T017–T018, T020–T021, T027–T029, T023–T024 are all independent test additions — fully parallel

---

## Parallel Example: User Story 1 & 2 (after T001 is done)

```bash
# US1 and US2 implementation in parallel:
Task T002: add read_file_v2 branch in src/core/storage.ts
Task T003: add edit_file_v2 branch in src/core/storage.ts

# After T002/T003, all tests in parallel:
Task T006: test read_file_v2 full contents
Task T007: test read_file_v2 codeBlocks fallback
Task T008: test read_file_v2 JSON.stringify fallback
Task T009: test read_file_v2 malformed result
Task T010: test read_file_v2 whitespace-only
Task T011: test edit_file_v2 full streamingContent
Task T012: test edit_file_v2 content fallback
Task T013: test edit_file_v2 codeBlocks fallback
Task T014: test edit_file_v2 malformed params
Task T015: test edit_file_v2 rejected with full content
```

---

## Implementation Strategy

### MVP First (User Stories 1 & 2 — the primary bug)

1. Complete Phase 1: T001 → T002+T003 (parallel) → T004 → T005
2. Add tests T006–T015 (parallel)
3. Run `npm test` — verify all pass
4. **STOP and VALIDATE**: `message.content` for `read_file_v2` and `edit_file_v2` is full
5. This resolves issue #25 completely

### Incremental Delivery

1. Phase 1 → test → validate (issue #25 fixed)
2. Phase 2 (terminal) → test → validate
3. Phase 3 (legacy read_file) → test → validate
4. Phase 4 (CLI display non-regression) → validate
5. Phase 5 (generic branch + polish) → final `npm test` pass

---

## Notes

- All logic changes are in one function (`formatToolCall`) in one file (`src/core/storage.ts`)
- All test changes are in one file (`tests/unit/storage.test.ts`) plus one formatter test file (`tests/unit/cli-formatters-table.test.ts`)
- No new files, no new dependencies, no API changes
- `edit_file` (legacy, non-v2) `oldString`/`newString` truncations are intentionally **not** changed — they are search-replace strings, not file content
- T005 is important: the existing 200-char `codeBlocks` append in `extractBubbleText()` must be excluded for `read_file_v2` and `edit_file_v2` to avoid double-appending
