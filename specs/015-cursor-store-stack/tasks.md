# Tasks: Cursor Store Stack Support

**Input**: Design documents from `specs/015-cursor-store-stack/`(spec.md, plan.md, data-model.md, contracts/, research.md, quickstart.md)  
**Branch**: `015-cursor-store-stack`

**Tests**: Use TDD — write failing tests first, then implement each module (per user request).

**Organization**: Organized by user story (P1 = US1+US2, MVP; P2 = US3+US4). Integration points: `src/core/store-stack/`(new) + `storage.ts`/`parser.ts`/`types.ts`(modified) + `lib/platform.ts`(modified) + `lib` pass-through; zero CLI command changes.

## Format: `[ID] [P?] [Story?] Description + file path`

- **[P]**: Parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: Owning user story (US1–US4); Setup/Foundational/Polish are unlabeled

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Type extensions, test fixtures, Store stack root location

- [x] T001 [P] Extend `ChatSession.source` type to add `'store' | 'transcript'` in `src/core/types.ts` and `src/lib/types.ts` (additive extension, does not break existing `'global' | 'workspace-fallback'`) — FR-030
- [x] T002 [P] Prepare redacted transcript fixtures in `tests/fixtures/transcripts/`: sample and redact real `~/.cursor/projects/**/agent-transcripts/*.jsonl` (replace real paths/credentials with placeholders, keep `[REDACTED]`); cover cases: user-only, contains tool_use, contains error lines (`{type:"error"}`), empty files, nested (`<id>/<id>.jsonl`) layout — FR-012
- [x] T003 [P] Add `getStoreStackRoot()` to cross-platform locate `~/.cursor` (Linux/macOS `~/.cursor`, Windows `%USERPROFILE%\.cursor\`) in `src/lib/platform.ts`; support `--data-path` override — FR-002

**Checkpoint**: Types ready, fixtures available, Store root path resolvable.

---

## Phase 2: Foundational (Blocking Core, All Stories Depend on It)

**⚠️ CRITICAL**: No user story may begin until this phase is complete. Provides Store stack path utilities + transcript parser (pure functions, no external state).

- [x] T004 [P] Define Store stack intermediate types (`StoreWorkspaceEntry`/`TranscriptLine`/`TranscriptPart`/`StoreSession`, see data-model.md §1) in `src/core/store-stack/types.ts`
- [x] T005 [P] Write failing tests: `hashWorkspaceCwd(cwd) === MD5(cwd)`, sanitized name resolution, `~/.cursor/chats/<hash>/` location in `tests/unit/store-stack-paths.test.ts` (case: `/mnt/d/1_yuyu_proj/cursor-history` → `46d408964d3ec2a21d9a23d01b13d82c`, see research §4.4) — FR-001/FR-003
- [x] T006 [P] Implement `paths.ts`: `hashWorkspaceCwd` (using `node:crypto` createHash('md5')), `resolveStoreSessionDir`, workspace cwd resolution in `src/core/store-stack/paths.ts` (make T005 pass)
- [x] T007 [P] Write failing tests: role-nested line parsing → Message; edge cases (error lines skipped, empty files, unknown part types ignored, multiple text+tool_use parts in same line) in `tests/unit/store-stack-transcript.test.ts` (using T002 fixtures) — FR-010/FR-011/FR-012
- [x] T008 [P] Implement `transcript.ts`: `parseTranscriptFile(path) → Message[]` (streaming line-by-line `JSON.parse`, `tool_use` → `ToolCall{name, params:input, status:'completed'}`, fault-tolerant degradation) in `src/core/store-stack/transcript.ts` (make T007 pass)

**Checkpoint** ✅: Foundation ready — `paths.ts` + `transcript.ts` pure functions independently verifiable (191-file local prototype already proven zero parse failures, research §6.4).

---

## Phase 3: User Story 1 - Store Stack Session Listing (Priority: P1) 🎯 MVP

**Goal**: Store stack users can see their sessions in `cursor-history list` (fixes Issue #31 core pain point).  
**Independent Test**: In a Store-stack-only environment (no vscdb), run `cursor-history list`, returns ≥1 session, does not report empty.

### Implementation

- [x] T009 [P] [US1] Write failing tests: `discoverStoreSessions(root) → StoreSession[]` (scan `~/.cursor/chats/<hash>/<uuid>/{meta.json}` + `~/.cursor/projects/<sanitized>/agent-transcripts/<uuid>/*.jsonl`; `meta.json.cwd` → workspacePath; `hasConversation=false` empty-session handling) in `tests/unit/store-stack-discover.test.ts` (build directory tree from T002 fixtures) — FR-001/FR-003
- [x] T010 [US1] Implement `discover.ts`: `discoverStoreSessions` in `src/core/store-stack/discover.ts` (depends on T006 paths + T008 transcript + T004 types; make T009 pass)
- [x] T011 [US1] `storage.ts`: `listSessions` merges Store sessions, **deduplicates across stacks by session ID** (same ID not duplicated) in `src/core/storage.ts` (depends on T010; calls `discoverStoreSessions` and merges with Composer stack results) — FR-030/FR-031
- [x] T012 [US1] CLI list display: `list` shows `source` field for Store sessions; `source='transcript'` degraded marker in `src/cli/formatters/table.ts` + `src/cli/formatters/json.ts` (depends on T011; reuse 012 degraded warning mechanism) — FR-032
- [x] T013 [US1] Integration test: Store-stack-only environment (fixtures, no vscdb) `list` returns sessions and `--json` contains `source` in `tests/integration/store-stack-list-show.test.ts` — SC-001

**Checkpoint** ✅: **US1 complete = Issue #31 fixed (list no longer reports empty)**. Independently verifiable, releasable.

---

## Phase 4: User Story 2 - View/Search/Export Store Session Content (Priority: P1)

**Goal**: `show`/`search`/`export` work for Store stack sessions (text + tool calls).  
**Independent Test**: `cursor-history show <store-session-id>` outputs user/assistant text + tool_use.

### Implementation

- [x] T014 [P] [US2] Write failing tests: `mapStoreSessionToChatSession(StoreSession) → ChatSession` (Message mapping: role/content/toolCalls; missing-field tokenUsage/model/timestamp semantics) in `tests/unit/store-stack-mapper.test.ts` (see data-model.md §2) — FR-030
- [x] T015 [US2] Implement unified mapping `StoreSession → ChatSession/Message` in `src/core/parser.ts` (add `mapStoreSession`; depends on T004; make T014 pass)
- [x] T016 [US2] `storage.ts`: `getSession(identifier)` adds Store branch (when identifier is a Store uuid, read transcript) in `src/core/storage.ts` (depends on T010/T015)
- [x] T017 [US2] `storage.ts`: `searchSessions` covers Store session text (user/assistant content) in `src/core/storage.ts` (depends on T010)
- [x] T018 [US2] `parser.ts`: `exportSessionToMarkdown`/`exportToJson` + `exportAllSessions*` cover Store sessions in `src/core/parser.ts` (depends on T015)
- [x] T019 [US2] library pass-through: `listSessions`/`getSession`/`searchSessions`/`export*` via `src/lib/index.ts` return Sessions containing `source`; `src/lib/types.ts` synced in `src/lib/{index.ts,types.ts}` (depends on T011/T016; no signature breakage) — FR-040/FR-041
- [x] T020 [US2] Integration test: `show`/`search`/`export` on Store sessions produce output containing text + tool calls; `--only` filter and `--json` work in `tests/integration/store-stack-list-show.test.ts` — SC-003/SC-006

**Checkpoint** ✅: **US2 complete = P1 MVP complete** (list/show/search/export fully cover Store stack; transcript-layer fields complete). Issue #31 users can use the tool end-to-end.

---

## Phase 5: User Story 4 - Hybrid Stack No Dupes/No Loss + Degraded Marker (Priority: P2)

**Goal**: Composer+Store hybrid-stack machines: sessions not duplicated, not lost, degraded sessions clearly identifiable.  
**Independent Test**: On fixtures where both stacks contain the same session ID, `list` shows that session only once, with low-fidelity sessions flagged.

### Implementation

- [ ] T021 [P] [US4] Write failing tests: hybrid stack (Composer vscdb fixtures + Store fixtures, with same/distinct IDs) dedup + fidelity preference (transcript > composer workspace-fallback) in `tests/integration/store-stack-dedup.test.ts` — FR-031
- [x] T022 [US4] Complete dedup priority logic in `src/core/storage.ts` (depends on T011; add hybrid-stack merge + fidelity ordering; make T021 pass)
- [x] T023 [US4] degraded warning: `source='transcript'` sessions show degraded hint in `show` detail output (reuse 012) in `src/cli/formatters/table.ts` (depends on T012 extension) — FR-032/SC-005

**Checkpoint** ✅: US4 complete — hybrid stack merges and deduplicates correctly, degradation is recognizable.

---

## Phase 6: User Story 3 - store.db Deep Parse (Full Fidelity) (Priority: P2)

**Goal**: Sessions with `store.db` get titles/tool results/session-level time filled in.  
**Independent Test**: Sessions containing store.db show title + tool results in `show`; `hasConversation=false` empty sessions show a friendly hint.

### Implementation

- [x] T024 [P] [US3] Build contractual `store.db` fixture (per research §5.1 DDL: `blobs(id,data)`+`meta(key,value)`; meta key='0'=hex(JSON); 1 root tree blob contains protobuf frame `0x0a 0x20`+32B + 1 JSON leaf message) in `tests/fixtures/store-db/` — FR-020
- [x] T025 [P] [US3] Write failing tests: `parseStoreDb(path)` → session metadata (meta hex decode) + blobs Merkle traversal + leaf JSON decode → StoreMessage[] in `tests/unit/store-stack-store-db.test.ts` (using T024 fixtures) — FR-020
- [x] T026 [US3] Implement `store-db.ts`: use pluggable driver (006 `openDatabase`) to open read-only; meta hex→UTF-8→JSON; from `latestRootBlobId` scan `0x0a 0x20`+32B to get leaf hashes → `JSON.parse` decode; **failure/corruption/WAL-lock → degrade, do not throw** in `src/core/store-stack/store-db.ts` (depends on T024; make T025 pass)
- [x] T027 [US3] `discover.ts`: if a session has store.db and parse succeeds, merge title/tool results/session-level time, upgrade `source` to `'store'`; on failure keep `'transcript'` in `src/core/store-stack/discover.ts` (depends on T026)
- [x] T028 [US3] Real dump validation of blob leaf encoding (research §10.1.2): use quickstart.md's node:sqlite command to dump a real store.db, confirm JSON/protobuf/prefixed; if it differs from the contractual fixture, extend T026 fault-tolerance and document it — **manual verification task** (fix WSL proxy to generate locally, or ask the Issue author to dump)

**Checkpoint** ✅: US3 complete — Store stack session fidelity maximized (store.db preferred); encoding uncertainty double-confirmed (contractual fixture + real dump).

---

## Phase 7: Polish & Cross-Cutting

- [ ] T029 [P] Documentation: README + `docs/readme_*.md` add Store stack path notes, Issue #31 scenario, `--data-path ~/.cursor` usage in `README.md` (constitution III) — FR-002
- [ ] T030 [P] debug logging: Store stack discovery/parsing/degradation add `debugLogStorage` (reuse 006 `DEBUG=cursor-history:*`) in `src/core/store-stack/{discover,store-db,transcript}.ts`
- [ ] T031 Full validation: `npm run typecheck && npm run lint && npm test` all green (strict mode + ESLint + vitest)
- [ ] T032 Manual end-to-end test: (a) on local Windows `~/.cursor/projects` (190 transcripts) run `node dist/cli/index.js list/show/export`, verify Store discovery + dedup merge with Composer stack (no duplicates); (b) optional: fix WSL proxy to generate real store.db, verify P2 store-db parsing; (c) Store-stack-only fixture environment verifies `list` does not report empty — SC-001/SC-002/SC-004

---

## Dependencies & Execution Order

### Phase dependencies
- **Setup (Phase 1)**: No dependencies, start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1 (T001 types/T003 platform); **blocks all user stories**.
- **US1 (Phase 3, P1)**: Depends on Phase 2. → **MVP core**.
- **US2 (Phase 4, P1)**: Depends on Phase 2 + US1's discover (T010). → **MVP complete**.
- **US4 (Phase 5, P2)**: Depends on US1 (T011 dedup foundation).
- **US3 (Phase 6, P2)**: Depends on Phase 2 + US1 (T010 discover); T027 enhances discover.
- **Polish (Phase 7)**: Depends on all targeted stories being complete.

### Task dependencies (critical chain)
```
T001(types) ─┐
T003(platform)┼─→ Phase2: T004 → {T005→T006, T007→T008} ─→ T009→T010 ─→ T011 ─┬→ T012→T013 (US1✓)
T002(fixtures)┘                                                                  ├→ T016/T017 (US2)
                                                                                 └→ T022 (US4), T027 (US3)
T014→T015(parser) ─→ T016/T018/T019 → T020 (US2✓)
T024→T025→T026(store-db) → T027 → T028 (US3✓)
```

### Parallelization opportunities
- Phase 1: T001/T002/T003 in different files, all parallel.
- Phase 2: T004/T005/T007 (tests + types) parallel; T006/T008 (implementation) follow (make corresponding tests pass).
- Within US2: T014 (test) parallel with T009/T021 (other story tests) across stories.
- Within US3: T024 (fixture) and T025 (test) start in parallel.

---

## Implementation Strategy

### MVP First (US1 + US2, pure transcript layer)
1. Phase 1 Setup → Phase 2 Foundational (paths + transcript pure functions, prototype already validated as feasible).
2. Phase 3 US1 → **verify list does not report empty (Issue #31 fixed)**.
3. Phase 4 US2 → **verify show/search/export**.
4. **STOP & verify**: P1 complete, releasable; Store stack users have 100% session access (text + tool calls), completely independent of store.db blob parsing.

### Incremental Delivery (P2 enhancements)
5. Phase 5 US4 (hybrid stack dedup/degradation) → Phase 6 US3 (store.db deep parse, fill in title/tool results/time).
6. Each phase independently testable, rollbackable (store.db failure must degrade to transcript layer, never blocking).

### Risk hedging
- store.db blob encoding uncertain → contractual fixture (T024) + real dump (T028) double confirmation + degradation (US3 does not block P1).
- Transcript format changes in the future → fault-tolerant ignore of unknown parts (T008), extensible three-form detection (research §6).

---

## Notes

- Strict TDD: test first per module (FAIL) → implement (make pass); commit per task.
- Integration points centralized: `storage.ts` (T011/T016/T017/T022), `parser.ts` (T015/T018); zero CLI command changes (go through the storage layer).
- No new dependencies: `node:crypto` (T006) + existing `node:sqlite` driver (T026) + `node:fs` (T008).
- constitution: simplicity (P1 simplest path), CLI-native (reuse commands), defensive parsing (fault-tolerant degradation throughout), incremental (P1/P2 phased).
- Each Checkpoint is independently verifiable and releasable.
