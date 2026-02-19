# Tasks: Fix Timestamp Fallback for Pre-2025-09 Sessions

**Input**: Design documents from `/specs/010-fix-timestamp-fallback/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: Test tasks are included as the spec identifies specific testable behaviors and the plan references `tests/unit/storage.test.ts`.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extend the `RawBubbleData` interface to expose the timestamp fields needed by all user stories

- [ ] T001 Add `clientRpcSendTime` and `clientSettleTime` to `RawBubbleData.timingInfo` interface in `src/core/storage.ts` (lines 1298-1301). Update from `{ clientStartTime?: number; clientEndTime?: number }` to include `clientRpcSendTime?: number` and `clientSettleTime?: number`. Add inline comments noting these are Unix ms fields from old-format assistant bubbles.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the shared `extractTimestamp()` function that all user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T002 Implement `extractTimestamp()` function in `src/core/storage.ts`. Add it as an exported function near the existing `extractTimingInfo()` function (after line ~1416). Signature: `export function extractTimestamp(data: RawBubbleData & { createdAt?: string }): Date | null`. Priority chain: (1) `data.createdAt` → `new Date(data.createdAt)`, (2) `data.timingInfo?.clientRpcSendTime` → validate `> 1_000_000_000_000` → `new Date(rpc)`, (3) `data.timingInfo?.clientSettleTime` → same validation → `new Date(settle)`, (4) `data.timingInfo?.clientEndTime` → same validation → `new Date(end)`, (5) return `null`. Add JSDoc describing the priority chain and validation threshold.

- [ ] T003 Add unit tests for `extractTimestamp()` in `tests/unit/storage.test.ts`. Create a new `describe('extractTimestamp')` block. Test cases: (a) returns Date from `createdAt` ISO string when present, (b) returns Date from `clientRpcSendTime` when `createdAt` absent, (c) returns Date from `clientSettleTime` when both `createdAt` and `clientRpcSendTime` absent, (d) returns Date from `clientEndTime` as last timing fallback, (e) returns `null` when no timestamp source exists, (f) skips `clientRpcSendTime` when value is below threshold (e.g., 999), (g) skips `clientRpcSendTime` when value is 0 or negative, (h) prefers `createdAt` over `clientRpcSendTime` when both present, (i) skips all invalid timingInfo values and returns `null`.

**Checkpoint**: `extractTimestamp()` is tested and ready. User story implementation can now begin.

---

## Phase 3: User Story 1 - Accurate Timestamps for Old Assistant Messages (Priority: P1) MVP

**Goal**: Messages with `timingInfo.clientRpcSendTime` display their actual send time instead of current time. Covers FR-001, FR-002, FR-003, FR-004, FR-009.

**Independent Test**: View an old session (pre-2025-09) containing assistant messages and verify their timestamps reflect the actual `clientRpcSendTime` value rather than the current time.

### Implementation for User Story 1

- [ ] T004 [US1] Update `getSession()` bubble mapping in `src/core/storage.ts` (line 499). Replace `timestamp: data.createdAt ? new Date(data.createdAt) : new Date()` with `timestamp: extractTimestamp(data)`. The message `timestamp` field becomes `Date | null` temporarily within the `.map()` callback. After the `.filter()` call, add a step to resolve any remaining `null` timestamps to `summary.createdAt` as fallback: iterate messages, replace `null` with `summary.createdAt ?? new Date()`. This ensures FR-001 through FR-004 for the primary code path.

- [ ] T005 [US1] Update `getGlobalSession()` bubble mapping in `src/core/storage.ts` (line 779). Apply the same change as T004: replace the inline `timestamp: data.createdAt ? new Date(data.createdAt) : new Date()` with `timestamp: extractTimestamp(data)`. Add the same post-filter null resolution step using `summary.createdAt ?? new Date()`.

- [ ] T006 [US1] Add unit tests for User Story 1 scenarios in `tests/unit/storage.test.ts`. Create a `describe('timestamp fallback - US1')` block. Test cases: (a) bubble with `createdAt` still uses `createdAt` (regression test, FR-009), (b) bubble without `createdAt` but with `timingInfo.clientRpcSendTime` uses `clientRpcSendTime`, (c) bubble without `createdAt` or `clientRpcSendTime` but with `clientSettleTime` uses `clientSettleTime`, (d) bubble with invalid `clientRpcSendTime` (below threshold) falls through to next source, (e) bubble with no timestamp source at all does not produce current time (uses session fallback instead), (f) mixed-format session: some bubbles with `createdAt`, some with `timingInfo` only, some with neither -- each uses its own best available source (FR-008 edge case), (g) export path verification: call `exportToJson()`/`exportToMarkdown()` with an old session containing `timingInfo`-only bubbles and verify exported timestamps match `clientRpcSendTime` values, not current time (FR-008 explicit coverage).

**Checkpoint**: User Story 1 is complete. Old assistant messages with `timingInfo` now display accurate timestamps. Post-2025-09 sessions are unaffected.

---

## Phase 4: User Story 2 - Interpolated Timestamps for Old User Messages (Priority: P2)

**Goal**: Messages with no direct timestamp source get an approximate timestamp from the nearest neighboring message. Covers FR-005.

**Independent Test**: View an old session where user messages (type=1) lack `createdAt` and `timingInfo`, and verify they display a timestamp derived from a neighboring assistant message.

### Implementation for User Story 2

- [ ] T007 [US2] Implement `fillTimestampGaps()` function in `src/core/storage.ts`. Add it as an exported function near `extractTimestamp()`. Signature: `export function fillTimestampGaps(messages: Array<{ timestamp: Date | null; [key: string]: unknown }>, sessionCreatedAt?: Date): void`. Algorithm: (1) for each message with `timestamp === null`, scan forward for first non-null timestamp and use it; if none found, scan backward for last non-null timestamp and use it. (2) For any still-null timestamps, set to `sessionCreatedAt ?? new Date()`. Mutates in place. Add JSDoc explaining the "prefer next" heuristic and session fallback.

- [ ] T008 [US2] Integrate `fillTimestampGaps()` into `getSession()` in `src/core/storage.ts`. After the `.filter()` call that produces the `messages` array (around line 509), call `fillTimestampGaps(messages, summary.createdAt)`. This replaces the simple null-to-session-fallback added in T004 with the full interpolation logic. All `null` timestamps will be resolved before the function returns.

- [ ] T009 [US2] Integrate `fillTimestampGaps()` into `getGlobalSession()` in `src/core/storage.ts`. Same change as T008: after the `.filter()` call (around line 789), call `fillTimestampGaps(messages, summary.createdAt)`. Replace the simple null resolution from T005 with this call.

- [ ] T010 [US2] Add unit tests for `fillTimestampGaps()` in `tests/unit/storage.test.ts`. Create a `describe('fillTimestampGaps')` block. Test cases: (a) all timestamps present → no changes, (b) first message null, second has timestamp → first gets second's timestamp ("prefer next"), (c) last message null, previous has timestamp → last gets previous timestamp, (d) middle message null, both neighbors have timestamps → gets next message's timestamp (prefer next), (e) multiple consecutive nulls → all get next available timestamp, (f) all messages null with `sessionCreatedAt` provided → all get session timestamp, (g) all messages null without `sessionCreatedAt` → all get current time (last resort), (h) single message with null timestamp → gets session fallback.

**Checkpoint**: User Stories 1 AND 2 are complete. All old messages display either their actual timestamp or an approximation from neighbors.

---

## Phase 5: User Story 3 - Session-Level Fallback for Edge Cases (Priority: P3)

**Goal**: Sessions with no per-message timestamps at all fall back to session creation time. Covers FR-006, FR-007.

**Independent Test**: Create a mock session where no bubbles have `createdAt` or `timingInfo`, and verify all messages display the session's creation timestamp.

### Implementation for User Story 3

- [ ] T011 [US3] Add unit tests for session-level fallback scenarios in `tests/unit/storage.test.ts`. Create a `describe('timestamp fallback - US3 session-level')` block. Test cases: (a) all bubbles lack any timestamp source, `sessionCreatedAt` provided → all messages get `sessionCreatedAt`, (b) all bubbles lack any timestamp source, `sessionCreatedAt` not provided → all messages get current time (Date.now approximate check), (c) mix of bubbles: some with `createdAt`, some with `timingInfo`, some with nothing → each resolves correctly through the full chain (integration test of all three stories working together).

**Checkpoint**: All user stories are complete. The full timestamp resolution chain works end to end: `createdAt` > `clientRpcSendTime` > `clientSettleTime`/`clientEndTime` > neighbor interpolation > session creation time > current time.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates and final validation

- [ ] T012 Update CLAUDE.md Recent Changes section to document the 010-fix-timestamp-fallback feature. Add entry describing: new `extractTimestamp()` and `fillTimestampGaps()` functions in `src/core/storage.ts`, extended `RawBubbleData.timingInfo` interface, two-pass timestamp resolution (direct extraction + neighbor interpolation + session fallback), and the files modified.
- [ ] T013 Update CHANGELOG.md with a bug fix entry for the timestamp fallback improvement. Note: fixes incorrect timestamps on pre-2025-09 sessions (GitHub Issue #13), adds `timingInfo.clientRpcSendTime` extraction, neighbor interpolation for user messages, and session-level fallback.
- [ ] T014 Run full test suite (`npm test`) and type check (`npm run typecheck`) to verify no regressions across all existing tests.
- [ ] T015 Run lint check (`npm run lint`) and fix any lint issues introduced by the new code.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (T001) - T002 needs the extended interface; T003 needs T002
- **User Story 1 (Phase 3)**: Depends on Phase 2 (T002 extractTimestamp function must exist)
- **User Story 2 (Phase 4)**: Depends on Phase 3 (T004/T005 must be in place so fillTimestampGaps can replace the simple fallback)
- **User Story 3 (Phase 5)**: Depends on Phase 4 (fillTimestampGaps must be integrated; US3 tests validate the full chain)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - Independently testable
- **User Story 2 (P2)**: Depends on US1 being complete (fillTimestampGaps replaces the simple null fallback from US1)
- **User Story 3 (P3)**: Depends on US2 being complete (tests validate the full chain including interpolation)

### Within Each User Story

- Implementation tasks before integration tests
- Core function before call-site integration
- All tasks within a story are sequential (same file: `src/core/storage.ts`)

### Parallel Opportunities

- T003 (extractTimestamp tests) can be written in parallel with T004/T005 if the function signature is known
- T006 (US1 tests) can be written in parallel with T004/T005 since tests are in a different file
- T010 (fillTimestampGaps tests) can be written in parallel with T008/T009
- T011 (US3 tests) can be written in parallel with any US3 implementation (tests only in this phase)
- T012, T013, T014, T015 (polish) can all run in parallel

---

## Parallel Example: User Story 1

```bash
# After T002 (extractTimestamp) is implemented:
# These can run in parallel (different files):
Task: "T004 - Update getSession() bubble mapping in src/core/storage.ts"
Task: "T006 - Add unit tests for US1 in tests/unit/storage.test.ts"
```

## Parallel Example: User Story 2

```bash
# After T007 (fillTimestampGaps) is implemented:
# These can run in parallel (different files):
Task: "T008 - Integrate fillTimestampGaps into getSession()"
Task: "T010 - Add unit tests for fillTimestampGaps in tests/unit/storage.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001 - interface extension)
2. Complete Phase 2: Foundational (T002-T003 - extractTimestamp)
3. Complete Phase 3: User Story 1 (T004-T006 - integrate + test)
4. **STOP and VALIDATE**: Run `npm test` and `npm run typecheck`
5. This alone fixes 16.6% of bubbles (763 assistant messages with `timingInfo`)

### Incremental Delivery

1. Setup + Foundational → extractTimestamp ready
2. Add User Story 1 → Test independently → Fixes accurate assistant timestamps (MVP!)
3. Add User Story 2 → Test independently → Fixes user message timestamps via interpolation
4. Add User Story 3 → Test independently → Validates full fallback chain including session-level
5. Polish → Documentation + final validation

---

## Notes

- All implementation tasks touch the same file (`src/core/storage.ts`) so they must be sequential within each phase
- Test tasks are in a different file (`tests/unit/storage.test.ts`) and can be parallelized with implementation
- US2 builds on US1's changes (replaces simple fallback with interpolation), creating a sequential dependency
- US3 is primarily a test-only phase (validates the full chain already built by US1+US2)
- Total: 15 tasks across 6 phases
