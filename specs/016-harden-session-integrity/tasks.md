# Tasks: Session Integrity and Compatibility Hardening

**Input**: Design documents from `/workspaces/patcomm/cursor-history/specs/016-harden-session-integrity/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Tests are required by FR-069 and FR-072–FR-078. In every story, create the listed failing tests and locked evidence before changing the corresponding production behavior.

**Organization**: Tasks are grouped by user story and ordered so each story has an independently runnable acceptance slice. Paths are repository-relative unless shown as absolute.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Safe to execute in parallel after the phase prerequisites are complete because it uses different files and has no dependency on another unfinished task in the same parallel group.
- **[Story]**: Maps the task to the numbered user story in `spec.md`.
- Unmarked tasks must run in listed order within their phase.

---

## Phase 1: Setup (Shared Test Infrastructure)

**Purpose**: Add reusable test infrastructure without changing production resolution behavior.

- [ ] T001 Create deterministic Composer, Store DB, transcript, backup, duplicate-UUID, and workspace A/B fixture builders in `tests/helpers/session-integrity-fixtures.ts`
- [ ] T002 Create the unchanged v0.16 vibe-history identity, digest, parent, and atomic-replacement harness in `tests/helpers/v016-consumer.ts`
- [ ] T003 [P] Create a built-CLI subprocess helper that captures stdout bytes, stderr bytes, exit status, signals, and temporary roots in `tests/helpers/run-cli.ts`
- [ ] T004 [P] Create low-level filesystem/SQLite/key-value event recording and poison-canary helpers in `tests/helpers/io-probe.ts`
- [ ] T005 [P] Add explicit compatibility, e2e, package-smoke, and required-gate scripts while retaining Vitest discovery of every required suite in `package.json` and `vitest.config.ts`

**Checkpoint**: Shared fixtures and real-process test helpers are available; existing tests still pass unchanged.

---

## Phase 2: Foundational Contracts (Blocking Prerequisites)

**Purpose**: Establish the additive type and error vocabulary shared by every story.

**⚠️ CRITICAL**: Complete this phase before production work in any user-story phase.

- [ ] T006 Define source roles, representations, resolution/fidelity states, identity origins, timestamp provenance, workspace memberships, source instances, index scope, and diagnostics in `src/core/types.ts` and additive source-compatible declarations in `src/lib/types.ts`
- [ ] T007 [P] Add failing safe-detail, stable-code, and no-raw-locator tests for new core, CLI, and library failures in `tests/unit/cli-errors.test.ts` and `tests/unit/lib-errors.test.ts`
- [ ] T008 Implement the typed scope, ambiguity, migration, temporary-artifact, and read-context error hierarchy in `src/core/errors.ts`
- [ ] T009 Map core failures without exposing physical locators or content and export the new contracts through `src/core/index.ts`, `src/cli/errors.ts`, `src/lib/errors.ts`, and `src/lib/index.ts`
- [ ] T010 [P] Create deterministic set-order, identity, pathless-alias, and structured-output assertion helpers in `tests/helpers/contract-assertions.ts`

**Checkpoint**: All later modules can depend on one typed compatibility vocabulary without changing existing public values.

---

## Phase 3: User Story 1 — Existing Library Backups Upgrade Without Identity Drift (Priority: P1) 🎯 MVP

**Goal**: Preserve every v0.16 Composer-derived key while complete Composer/Store views gain new content through one replacement and become idempotent.

**Independent Test**: Import a locked v0.16 Composer fixture through the unchanged consumer, resolve it as a complete merged session, synchronize twice, and prove every old key is byte-identical, new content exists once, failure is atomic, and the third synchronization performs zero writes.

### Tests and Locked Evidence for User Story 1

> Write and run these tests before production identity or merge changes; they must fail for the documented regressions.

- [ ] T011 [US1] Create the provenance-recorded test-only v0.16 projector from tag `v0.16.0` commit `e8a7abf8cea3419a9dda911e174a05f82a9b260e` in `tests/compatibility/support/v016-projector.ts` and record source paths/blob hashes in `tests/compatibility/fixtures/v016/projector-manifest.json`
- [ ] T012 [P] [US1] Add a locked Composer-only v0.16 raw global SQLite database, workspace-fallback JSON, tagged projection, unchanged-consumer archive, and Store enrichment/gap/collision fixtures in `tests/compatibility/fixtures/v016/composer-global-state.vscdb`, `tests/compatibility/fixtures/v016/workspace-fallback.json`, `tests/compatibility/fixtures/v016/tagged-output.json`, `tests/compatibility/fixtures/v016/legacy-consumer-archive.json`, and `tests/compatibility/fixtures/v016/merged-store-source.json`
- [ ] T013 [P] [US1] Record v0.17 tag/commit/source provenance and add locked complete/degraded merged baselines, complete transcript-to-Store-DB inputs, and tagged CLI fatal-output bytes in `tests/compatibility/fixtures/v017/provenance.json`, `tests/compatibility/fixtures/v017/complete-merged.json`, `tests/compatibility/fixtures/v017/degraded-store.json`, `tests/compatibility/fixtures/v017/transcript-complete.json`, `tests/compatibility/fixtures/v017/store-db-complete.json`, and `tests/compatibility/fixtures/v017/cli-fatal-output.json`
- [ ] T014 [P] [US1] Add provenance, `rowid ASC`, placeholder, filtering, branch, bubble-ID, global, and workspace-fallback oracle tests in `tests/compatibility/v016-projector-provenance.test.ts`
- [ ] T015 [P] [US1] Add native/null-ID, both-backbone, enrichment, parent, tool, collision, atomic-failure, degraded-non-overwrite, third-sync, and identity/fidelity/append-only faults, including start/middle Store insertions whose direct or inferred timestamps are below the archived maximum, in `tests/compatibility/v016-composer-upgrade.test.ts`
- [ ] T016 [P] [US1] Add one-replacement, no-duplicate, native-Composer-ID, complete transcript-to-Store-DB replacement, degraded-pin/retry, second-sync-no-op, and transition-fault tests in `tests/compatibility/v017-convergence.test.ts`
- [ ] T017 [P] [US1] Add failing pure identity, canonical hash, occurrence, collision, relationship, and tool-call tests plus consumed-field attachment projection, unsupported-raw partial fidelity, ignored standalone `codeBlocks`/`ToolCall.files`, and poison-URI no-dereference cases in `tests/unit/message-identity.test.ts`
- [ ] T018 [P] [US1] Extend merge regressions and deliberate failing fault switches for preferred-backbone pairing drift and Composer-tool reordering, plus standalone-files exclusion and Store-native append order, in `tests/unit/store-stack-merge.test.ts`
- [ ] T019 [US1] Add the exhaustive expected/not-expected/unknown Store DB, transcript fallback, metadata-only, explicit-no-conversation, and fatal-infrastructure state matrix before implementation in `tests/integration/store-expectation-state.test.ts`

### Implementation for User Story 1

- [ ] T020 [US1] Implement the exact v0.16 Composer projection, native/fallback message identities, canonical JSON/SHA-256 functions, occurrences, collisions, and synthetic tool identities in `src/core/session-identity.ts`
- [ ] T021 [P] [US1] Retain Store DB leaf hashes/traversal order and transcript canonical inputs/line order before merging in `src/core/store-stack/store-db.ts`, `src/core/store-stack/transcript.ts`, and `src/core/store-stack/types.ts`
- [ ] T022 [US1] Refactor fixed Composer-to-Store alignment, preferred-source rendering, matched Composer identity inheritance, canonical-params tool matching, and fixed Composer tool slots in `src/core/store-stack/merge.ts`
- [ ] T023 [US1] Rewrite parent, branch, leaf, sidechain, `activeBranchBubbleIds`, and additive `activeBranchMessageIds` through resolved identities in `src/core/store-stack/merge.ts` and `src/core/storage.ts`
- [ ] T024 [US1] Implement Store DB expectation and complete/partial/metadata-only representation selection without unsafe transcript fallback in `src/core/store-stack/discover.ts`, `src/core/store-stack/store-db.ts`, and `src/core/store-stack/transcript.ts`
- [ ] T025 [US1] Map complete views to legacy `source: "global"`, degraded views to `workspace-fallback`, and actual provenance to additive resolution fields in `src/core/storage.ts`
- [ ] T026 [US1] Retain raw attachment evidence through source decoding, project supported evidence only into unchanged-consumer `content` or `name/status/params/result/error`, mark unsupported raw evidence partial, and never dereference external targets in `src/core/store-stack/store-db.ts`, `src/core/store-stack/transcript.ts`, `src/core/store-stack/types.ts`, `src/core/parser.ts`, and `src/core/store-stack/merge.ts`
- [ ] T027 [US1] Emit nonempty resolved message/tool identities, origins, deterministic relationship references, and compatibility signals through `src/core/parser.ts` and `src/core/types.ts`
- [ ] T028 [US1] Preserve existing library return shapes and aliases while mapping complete merged views for unchanged-consumer replacement in `src/lib/index.ts` and `src/lib/types.ts`

**Checkpoint**: `tests/compatibility/v016-projector-provenance.test.ts`, `v016-composer-upgrade.test.ts`, `v017-convergence.test.ts`, and identity/merge unit tests pass; fixture regeneration is not an accepted fix.

---

## Phase 4: User Story 2 — Workspace-Scoped Reads Return and Inspect Only Intended Data (Priority: P1)

**Goal**: Make scoped indices round-trip through the same logical row while preventing any unrelated workspace payload hydration.

**Independent Test**: Use conflicting global/workspace ordering, A/B needles, a shared UUID, and poisoned off-scope contributors across built CLI and library list/show/search/export on live, backup, and custom paths; assert correct IDs/paths and zero B payload reads.

### Tests for User Story 2

- [ ] T029 [P] [US2] Add lexical normalization, exact-first, unique component-suffix, ambiguous suffix, historical-path, drive/WSL, case, and pre-I/O failure tests in `tests/unit/workspace-scope.test.ts`
- [ ] T030 [P] [US2] Add low-level metadata/payload events, poison DB/transcript/blob/key-value resources, observer-bypass fault failure, partial omission, and opt-in broadening tests in `tests/integration/workspace-io-boundary.test.ts`
- [ ] T031 [P] [US2] Add built-CLI A/B list/show/search/export and JSON scope/path assertions in `tests/e2e/cli-session-integrity.test.ts`
- [ ] T032 [P] [US2] Extend scoped/global index conflicts, wrong-ID/path/index mutation failures, direct-ID membership, ambiguity round-trip, workspace counts, backup/custom-path parity, and the FR-042 included/excluded-field equivalence matrix—including direct timestamp divergence and provenance/inferred/path/standalone-field equivalence—in `tests/integration/workspace-index-roundtrip.test.ts` and `tests/unit/session-replica-equivalence.test.ts`
- [ ] T033 [P] [US2] Extend public list/get/search/single-export/bulk-export and `listSessionSummaries()` tests for correct IDs/paths/partial diagnostics, ambiguity-inclusive totals/`hasMore`, index gaps, short `listSessions().data`, and one summary row with no `messages` in `tests/unit/lib-index.test.ts`

### Implementation for User Story 2

- [ ] T034 [P] [US2] Implement lexical historical-path normalization and exact-first/unambiguous component-suffix matching in `src/core/workspace-scope.ts`
- [ ] T035 [P] [US2] Implement safe low-level metadata-versus-payload event classification and observer registration in `src/core/io-observer.ts`
- [ ] T036 [US2] Route actual filesystem/backup opens and reads, SQLite driver/index open/prepare/query/backup calls, and Store/key-value reads through the observer seam in `src/core/backup.ts`, `src/core/database/index.ts`, `src/core/database/drivers/node-sqlite.ts`, `src/core/database/drivers/better-sqlite3.ts`, `src/core/storage.ts`, `src/core/store-stack/discover.ts`, `src/core/store-stack/store-db.ts`, and `src/core/store-stack/transcript.ts`
- [ ] T037 [US2] Build metadata-only physical inventory, native-UUID/source-role/representation/tier grouping, workspace memberships, and lazy selected-instance hydration in `src/core/session-catalog.ts` and `src/core/store-stack/discover.ts`
- [ ] T038 [US2] Implement versioned consumed-payload equivalence, one minimal ambiguous logical summary/opaque reference path, immutable workspace content scope, and explicit partial plans before payload access in `src/core/session-catalog.ts` and `src/core/storage.ts`
- [ ] T039 [US2] Preserve Composer canonical path separately from matched and per-source paths and canonically order memberships/source instances in `src/core/session-catalog.ts` and `src/core/storage.ts`
- [ ] T040 [US2] Bind one-based CLI/core indices to logical UUID plus permitted occurrence set and verify scoped direct-ID membership in `src/cli/commands/session-lookup.ts` and `src/core/storage.ts`
- [ ] T041 [US2] Thread one bound read context through CLI list/show/search/export without numeric re-resolution in `src/cli/commands/list.ts`, `src/cli/commands/show.ts`, `src/cli/commands/search.ts`, and `src/cli/commands/export.ts`
- [ ] T042 [US2] Thread workspace, data source, backup, stable-ID reload, and diagnostics through public reads; export `listSessionSummaries()` with one-to-one logical-row pagination while preserving zero-based library indices and short resolved-only `listSessions().data` in `src/lib/config.ts`, `src/lib/types.ts`, and `src/lib/index.ts`
- [ ] T043 [US2] Make workspace discovery count the same deduplicated logical rows returned by each workspace listing in `src/core/storage.ts` and `src/cli/commands/list.ts`
- [ ] T044 [US2] Implement `includeCrossWorkspaceSources` so it broadens only contributors of already-selected UUIDs and records every broadened path through parent options and public declarations in `src/cli/index.ts`, `src/cli/commands/list.ts`, `src/cli/commands/show.ts`, `src/cli/commands/search.ts`, `src/cli/commands/export.ts`, `src/lib/config.ts`, `src/lib/types.ts`, and `src/core/storage.ts`
- [ ] T045 [US2] Emit `indexScope`, workspace-only `indexWorkspacePath`, stable canonical/matched paths, resolution details, and no locators in `src/cli/formatters/json.ts`
- [ ] T046 [US2] Render visible partial/omitted-source and actionable empty/ambiguous workspace diagnostics in `src/cli/formatters/table.ts` and `src/cli/errors.ts`

**Checkpoint**: Built CLI and library operations return A consistently, find only `needle-a`, report omitted contributors honestly, and record zero off-scope payload events.

---

## Phase 5: User Story 3 — Destructive Migration Resolves One Explicit Scoped Target (Priority: P1)

**Goal**: Make dry-run and execution share one prevalidated Composer target and reject every unsafe multi-source or multi-locator case before writes.

**Independent Test**: Preview and apply workspace-A index 1 when global index 1 is B, then verify target identity/fingerprint equality, UUID semantics, and zero-write rejection for changed, duplicate, shared, divergent, Store-only, and merged targets.

### Tests for User Story 3

- [ ] T047 [P] [US3] Add scoped numeric/direct-ID and unchanged unfiltered numeric preview/apply, incapable-driver preflight, fingerprint race, multi-locator/shared-membership, divergent, Store-only, merged, and zero-write assertions in `tests/integration/migrate-session-scope.test.ts`
- [ ] T048 [P] [US3] Extend prepare/preflight/revalidate/apply, move-retains-UUID, copy-new-UUID, and destination-failure unit tests in `tests/unit/migrate.test.ts`
- [ ] T049 [US3] Add built-CLI parent-workspace propagation and identical dry-run/apply target assertions in `tests/e2e/cli-session-integrity.test.ts` and `tests/unit/cli-commands.test.ts`

### Implementation for User Story 3

- [ ] T050 [US3] Implement `BoundMigrationTarget`, prepare/preflight/fingerprint/revalidate/apply state transitions, and first-write boundary in `src/core/migrate.ts`
- [ ] T051 [US3] Consume parent `--workspace` and the already-bound logical row in `src/cli/commands/migrate-session.ts` and `src/cli/commands/session-lookup.ts`
- [ ] T052 [P] [US3] Thread one-based migration selectors, workspace scope, typed refusals, and safe preview metadata through `src/lib/types.ts`, `src/lib/index.ts`, and `src/lib/errors.ts`
- [ ] T053 [US3] Implement the shared `readWrite` capability-request/preference/preflight base and reject multiple Composer locators, shared global footprints, divergent rows, diagnostic references, Store-only/merged sessions, and half-migrations before writes in `src/core/database/types.ts`, `src/core/database/registry.ts`, `src/core/database/index.ts`, `src/core/database/errors.ts`, `src/core/migrate.ts`, and `src/cli/commands/migrate.ts`
- [ ] T054 [US3] Preserve native UUID for moves, allocate a new UUID only for true copies, and fail target changes without re-resolution in `src/core/migrate.ts`

**Checkpoint**: Every migration selector either mutates exactly the previewed eligible Composer occurrence or performs zero writes with a typed refusal.

---

## Phase 6: User Story 4 — Backup and Database Reads Are Private and Reliable (Priority: P1)

**Goal**: Keep every plaintext snapshot private and recoverably cleaned while selecting SQLite providers by actual operation capability.

**Independent Test**: Run successful, malformed, concurrent, cancelled, signaled, SIGKILL-recovery, incapable-provider, and archive-permission scenarios using real files and databases; assert private modes, typed outcomes, and no false empty/partial success.

### Tests for User Story 4

- [ ] T055 [P] [US4] Add importable-but-no-backup, auto fallback, forced failure, config propagation, and synchronous preference tests in `tests/unit/database-capabilities.test.ts`
- [ ] T056 [P] [US4] Add real POSIX `umask 000`, unchanged process/parent modes, exact private/shared/overwrite modes, concurrency, secure-create/snapshot/DB-open/parse/close/cleanup failures, and an intentional temp-leak mutation that must fail the gate in `tests/integration/backup-snapshot-security.test.ts`
- [ ] T057 [P] [US4] Add dedicated child-process SIGINT/SIGTERM/SIGHUP/AbortSignal/SIGKILL containment, preserved signal termination semantics, marker validation, stale recovery, wrong-owner/live-owner/malformed-marker/symlink traps, and Windows uniqueness/cleanup/typed-failure coverage in `tests/integration/private-temp-signal-recovery.test.ts`
- [ ] T058 [P] [US4] Extend real driver capability-boundary and no-false-partial Store tests in `tests/integration/drivers.test.ts`
- [ ] T059 [P] [US4] Extend backup, library backup, and Store snapshot failure/permission tests in `tests/unit/backup.test.ts`, `tests/unit/lib-backup.test.ts`, and `tests/unit/store-stack-store-db.test.ts`

### Implementation for User Story 4

- [ ] T060 [P] [US4] Implement exclusive private directories, markers, `0600` files, tracked artifacts, idempotent exhaustive disposal, and paths-only residue errors in `src/core/private-temp.ts`
- [ ] T061 [US4] Replace shared/predictable backup creation and extraction staging with `PrivateTempWorkspace`, thread cooperative `AbortSignal` cancellation, and guarantee nested `try/finally` cleanup in `src/core/backup.ts` and `src/core/types.ts`
- [ ] T062 [US4] Route routine Store database snapshots and read-context `AbortSignal` cancellation through the same private workspace and propagate infrastructure failures instead of partial sessions in `src/core/store-stack/store-db.ts` and `src/core/storage.ts`
- [ ] T063 [US4] Add active-workspace signal cleanup and conservative current-owner/proven-dead stale recovery without following symlinks in `src/core/private-temp.ts`
- [ ] T064 [P] [US4] Extend the migration capability base with `read` and `onlineBackup` profiles and probe actual APIs in `src/core/database/types.ts`, `src/core/database/drivers/node-sqlite.ts`, and `src/core/database/drivers/better-sqlite3.ts`
- [ ] T065 [P] [US4] Upgrade and lock the researched `better-sqlite3 >=12.10.0 <13` capability baseline consistently in `package.json` and `package-lock.json`
- [ ] T066 [US4] Extend shared selection to every operation using operation/library config, then latest `setDriver`, then environment, then automatic preference; auto-fallback only in automatic mode; return actionable forced/no-capable-driver errors in `src/core/database/registry.ts`, `src/core/database/errors.ts`, and `src/core/database/index.ts`
- [ ] T067 [US4] Thread driver preference through database entry points, read, snapshot, backup, Store, migration, and public-library operations while preserving synchronous `setDriver(): void` in `src/core/database/index.ts`, `src/core/storage.ts`, `src/lib/config.ts`, and `src/lib/index.ts`
- [ ] T068 [US4] Stage and atomically publish final archives as owner-only by default, preserve overwrite modes, and expose typed `sharedPermissions` plus explicit `--shared` in `src/core/backup.ts`, `src/core/types.ts`, `src/cli/commands/backup.ts`, `src/lib/backup.ts`, and `src/lib/types.ts`
- [ ] T069 [US4] Replace the hard-coded backup manifest producer with the current package version in `src/core/backup.ts`
- [ ] T070 [US4] Remove Store/backup catch paths that convert capability or snapshot failures into successful empty/partial data in `src/core/store-stack/store-db.ts` and `src/core/storage.ts`

**Checkpoint**: Catchable paths leave zero plaintext residue, uncatchable residue remains private and is conservatively recovered, and every provider request succeeds through a capable driver or fails once with a typed remedy.

---

## Phase 7: User Story 5 — Duplicate Physical Occurrences Have Deterministic, Honest Addressing (Priority: P2)

**Goal**: Collapse equivalent same-role replicas, expose divergent replicas as one non-resolvable logical ambiguity, and keep Composer/Store contributors complementary.

**Independent Test**: Exercise equivalent/divergent same-role groups and complementary Composer/Store pairs through list, direct/index lookup, search, export, and migration; assert one UUID, deterministic provenance, no contested hydration, and no guessed mutation.

### Tests for User Story 5

- [ ] T071 [P] [US5] Add equivalent/divergent replica list/search/export/direct-ID/index diagnostics, complementary Composer/Store behavior, and field-by-field FR-042 confirmation against the earlier unit matrix in `tests/integration/session-replica-reconciliation.test.ts`
- [ ] T072 [P] [US5] Extend the pre-existing Store expectation matrix with equivalent/divergent same-tier DB/transcript replica groups and deterministic discovery-order permutations in `tests/integration/store-expectation-state.test.ts`
- [ ] T073 [P] [US5] Add global-primary, workspace-membership-only, workspace partial fallback, same-tier-only comparison, off-scope omission, and fatal-infrastructure tests in `tests/integration/composer-source-arbitration.test.ts`
- [ ] T074 [P] [US5] Extend duplicate discovery, one-logical-row, deterministic-order, and complementary-source regressions in `tests/integration/store-stack-dedup.test.ts`, `tests/unit/store-stack-discover.test.ts`, and `tests/unit/store-stack-merge.test.ts`

### Implementation for User Story 5

- [ ] T075 [US5] Apply the US2 grouping/equivalence engine to reconcile permitted same-role replicas, retain every equivalent occurrence, and keep complementary source roles separate in `src/core/session-catalog.ts`
- [ ] T076 [US5] Implement Composer global-primary/workspace-membership arbitration and partial workspace fallback in `src/core/session-catalog.ts` and `src/core/storage.ts`
- [ ] T077 [US5] Apply the already-tested US1 Store representation states to reconcile DB candidates only with same-tier DB peers and transcripts only with same-tier transcript peers without redefining the state matrix in `src/core/session-catalog.ts` and `src/core/store-stack/discover.ts`
- [ ] T078 [US5] Finalize equivalent provenance and ambiguous-summary projection with deterministic opaque references and typed CLI/library read failures in `src/core/session-catalog.ts`, `src/core/errors.ts`, `src/cli/errors.ts`, and `src/lib/errors.ts`
- [ ] T079 [US5] Skip ambiguous payloads exactly once in search/bulk export and emit one machine-readable diagnostic without a locator in `src/core/storage.ts`, `src/cli/commands/search.ts`, and `src/cli/commands/export.ts`
- [ ] T080 [US5] Expose deterministically ordered workspace memberships and plural per-instance `workspacePaths` while keeping locators private in `src/core/storage.ts`, `src/lib/index.ts`, and `src/cli/formatters/json.ts`
- [ ] T081 [US5] Keep native ID and Composer canonical path stable across filters/preferences while varying only matched-path metadata in `src/core/session-catalog.ts` and `src/core/storage.ts`

**Checkpoint**: Equivalent replicas appear once, divergent replicas remain one honest ambiguity, and complementary Composer/Store content still follows the merge contract.

---

## Phase 8: User Story 6 — Large-Corpus Operations Remain Bounded and Order-Independent (Priority: P2)

**Goal**: Bind read scope explicitly, coalesce only active work, retain at most `C+A`, and stream bulk operations without pinning the corpus.

**Independent Test**: Compare `N` and `2N` corpora under reversed list/get order, concurrent same-key reads, scope conflict, one rejection, bulk search/export, and disposal; assert identical results and the documented memory bound.

### Tests for User Story 6

- [ ] T082 [P] [US6] Add get-before-list/list-before-get, conflict-before-I/O, in-flight coalescing, rejection retry, `N`/`2N`, `C+A`, deliberate over-retention fault failure, public/core bulk `C=0`, and dispose assertions in `tests/integration/read-context-bounds.test.ts`
- [ ] T083 [P] [US6] Extend immutable options, finite capacity, eviction, retry, release, and disposed-error unit tests in `tests/unit/storage-context.test.ts`
- [ ] T084 [P] [US6] Extend public library operation-order, diagnostics continuation, and lifecycle tests in `tests/unit/lib-index.test.ts`

### Implementation for User Story 6

- [ ] T085 [US6] Construct `SessionReadContext` from one immutable data-source/scope/options binding and reject conflicting or disposed use before content I/O in `src/core/storage.ts`
- [ ] T086 [US6] Separate active promise coalescing from a completed-session LRU, default capacity to `C=1`, evict rejections, and implement `releaseSession()`/idempotent `dispose()` in `src/core/storage.ts`
- [ ] T087 [US6] Run built-in and public-library search/bulk JSON/Markdown export with `C=0`, release each completed payload, continue supported diagnostics, and dispose contexts in `finally` in `src/core/storage.ts`, `src/lib/index.ts`, `src/cli/commands/search.ts`, and `src/cli/commands/export.ts`
- [ ] T088 [US6] Expose the source-compatible context factory and lifecycle options without mutable call-order binding in `src/lib/config.ts` and `src/lib/index.ts`
- [ ] T089 [US6] Remove eager decoded-session retention from Store discovery and expose test-only ownership counters needed to prove `C+A` in `src/core/store-stack/discover.ts` and `src/core/storage.ts`

**Checkpoint**: Operation order is irrelevant, failures remain retryable/isolated, and doubling session count does not increase context-owned decoded-session retention above `C+A`.

---

## Phase 9: User Story 7 — Addressing, Provenance, and Release Safety Are Visible on Shipped Surfaces (Priority: P2)

**Goal**: Ship explicit scope/fidelity/timestamp contracts and prevent publication unless the exact artifact passes every required compatibility and runtime gate.

**Independent Test**: Validate built CLI and library JSON/human output, help, packaged documentation/types, fatal stream compatibility, CJS/ESM imports, exact-tarball identity, and deliberately failing/zero/skipped/timed-out/cancelled release stages.

### Tests for User Story 7

- [ ] T090 [P] [US7] Add exact session-source precedence, message next/previous/session/epoch fallback, `epoch-unknown` non-anchoring, fake-clock/backbone/scope/discovery-order repetition, `Date.now()`/zero-argument-`new Date()` poison, approximate rendering, true error/thinking filtering, and structured tool tests in `tests/unit/parser.test.ts`, `tests/unit/cli-formatters-json.test.ts`, `tests/unit/cli-formatters-table.test.ts`, and `tests/unit/filter.test.ts`
- [ ] T091 [P] [US7] Compare list/show/search/export invalid-backup and migrate-session fatal stdout/stderr bytes, object shape, exit categories, safe additive details, and partial-success exit behavior against the tagged artifact in `tests/compatibility/fixtures/v017/cli-fatal-output.json` from `tests/e2e/cli-fatal-json.test.ts`
- [ ] T092 [P] [US7] Add exact packed-tarball ESM/CJS/declaration/CLI/fixture/docs/producer-version/pathless-alias smoke tests in `tests/e2e/package-smoke.test.ts`
- [ ] T093 [P] [US7] Add zero-test, allowed platform-skip, unexpected-skip, nonzero, timeout, cancellation, publish-after-failure mutation, and success tests in `tests/unit/verify-test-results.test.ts`
- [ ] T094 [P] [US7] Add fail-closed workflow dependency and bypass mutation, Node 20.0.0/22.15.1/22.16.0/23.7.0/23.8.0/current-24-LTS/current-26-stable matrix, tag/version, pack-once, checksum, clean-install, and publish-exact-tarball assertions in `tests/e2e/publish-workflow.test.ts`
- [ ] T095 [P] [US7] Validate list/show/search/export fixtures and pathless distinctions against the shipped schema in `tests/e2e/cli-json-schema.test.ts`

### Implementation for User Story 7

- [ ] T096 [US7] Implement Composer metadata, Store DB/meta, direct-message extrema, then epoch session-time precedence and message next/previous/valid-session/epoch fallback with explicit provenance, `epoch-unknown` non-anchoring, and no wall-clock/filesystem-time input in `src/core/parser.ts` and `src/core/storage.ts`
- [ ] T097 [US7] Mark inferred human times approximate, retain structured tools on error/thinking messages, and filter by actual message category in `src/cli/formatters/table.ts`, `src/cli/formatters/json.ts`, and `src/core/storage.ts`
- [ ] T098 [US7] Add scope, unique-suffix, cross-source opt-in, migration, backup sharing, completeness, and actionable empty/ambiguity help; route affected fatal objects through shared safe serialization while preserving each released stream/exit branch in `src/cli/index.ts`, `src/cli/errors.ts`, `src/cli/commands/list.ts`, `src/cli/commands/show.ts`, `src/cli/commands/search.ts`, `src/cli/commands/export.ts`, and `src/cli/commands/migrate-session.ts`
- [ ] T099 [US7] Finalize additive public summary/session/message/tool/timestamp/source/diagnostic fields and exact pathless `workspace: "unknown"` behavior in `src/lib/types.ts` and `src/lib/index.ts`
- [ ] T100 [P] [US7] Add the NodeNext CommonJS build tree and generated `.cjs` wrapper in `tsconfig.cjs.json` and `scripts/build-cjs.mjs`
- [ ] T101 [US7] Make build/package scripts produce ESM, CJS, declarations, and CLI and include `README.md`, `LICENSE`, `CHANGELOG.md`, and `docs/compatibility.md` in the declared package contents in `package.json` and `package-lock.json`
- [ ] T102 [P] [US7] Implement a documented per-platform skip allowlist and machine-verifiable rejection of zero tests, unexpected skips, failures, timeout, and cancellation in `scripts/verify-test-results.mjs`
- [ ] T103 [US7] Remove test-failure swallowing; require install/typecheck/lint/nonzero-test/build success; validate Node 20.0.0, 22.15.1/22.16.0, 23.7.0/23.8.0, current 24 LTS, and current 26 stable capability boundaries; then pack once, smoke/checksum, and publish that exact tarball in `.github/workflows/npm-publish.yml`
- [ ] T104 [P] [US7] Write the canonical logical-ID, physical-instance, scoped-index, workspace-I/O, fidelity/provenance, v0.16 safe-upgrade, and v0.17 transition contract in `docs/compatibility.md`
- [ ] T105 [P] [US7] Document the same shipped addressing, source, timestamp, backup-permission, and upgrade guidance in `README.md`
- [ ] T106 [P] [US7] Synchronize or canonically link the compatibility contract from `docs/readme_es.md`, `docs/readme_fr.md`, and `docs/readme_zh.md`
- [ ] T107 [P] [US7] Add missing v0.12–v0.17 history, the v0.17 incremental-library warning, and corrective-release guarantees/pinning path in `CHANGELOG.md`
- [ ] T108 [P] [US7] Enforce the constitution's stable-return-value/source-fidelity review questions in `.github/pull_request_template.md` while retaining the existing v1.2.0 amendment in `.specify/memory/constitution.md`
- [ ] T109 [US7] Treat `specs/016-harden-session-integrity/contracts/session-output.schema.json` as the frozen design oracle and validate required fields, canonical ordering, partial/ambiguous unions, and no-locator guarantees without rewriting it to match implementation output

**Checkpoint**: Every shipped surface explains the same contract, all schema/output tests pass, and no failed or untested revision can reach publication.

---

## Phase 10: Polish & Cross-Cutting Completion Gates

**Purpose**: Prove the integrated implementation, distributed artifact, and release evidence satisfy every story together.

- [ ] T110 [P] Aggregate and rerun the owning-story fault switches for wrong index/ID/path, off-scope hydration, bypassed recording with armed DB/transcript/KV/blob canaries, identity/backbone drift, tool reorder, unsafe fidelity, timestamp watermark, temp leakage, memory overflow, and publish-after-failure in `tests/integration/session-integrity-faults.test.ts`
- [ ] T111 [P] Complete the live/backup/custom-path, both-backbone, duplicate/complementary-source, and structured-output matrix in `tests/e2e/cli-session-integrity.test.ts` and `tests/helpers/session-integrity-fixtures.ts`
- [ ] T112 Run `npm ci`, typecheck, lint, format check, standard tests, and build through the required scripts in `package.json`, fixing any failure in the owning `src/` or `tests/` path before continuing
- [ ] T113 Pack once and execute the clean-install ESM/CJS/declaration/CLI/schema smoke path, closing any gap in `tests/e2e/package-smoke.test.ts`
- [ ] T114 Create instructions/template and perform maintainer-owned live, JSON/Markdown export, backup create/read, and custom-path verification from owner-only storage outside the repository; retain only revision/tarball hash/platform/capabilities, abstract paths/operations, salted nonretained ID hashes, low-level event totals, modes/residue counts, and pass/fail; delete raw artifacts and prohibit raw repository/CI evidence in `docs/release-verification.md`
- [ ] T115 Record final FR-001–FR-078, SC-001–SC-017, contract, quickstart, runtime, and constitution traceability with no unresolved exception in `specs/016-harden-session-integrity/checklists/implementation.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 — Setup**: Starts immediately and changes test infrastructure only.
- **Phase 2 — Foundational Contracts**: Depends on Phase 1 and blocks production story work.
- **Phase 3 — US1**: Depends on Phase 2; locked projector/consumer evidence T011–T019 must precede T020–T028.
- **Phase 4 — US2**: Depends on US1's stable identity/fidelity projection. It establishes the minimal same-role equivalence/ambiguous-row path required by scoped index round-trip; T034 and T035 may proceed in parallel before catalog integration.
- **Phase 5 — US3**: Depends on US1 source classification and US2 bound/ambiguous logical rows. T053 establishes the shared `readWrite` capability preflight before the checkpoint and conservatively rejects every multi-locator target, so read-side equivalent-replica selection never grants mutation authority.
- **Phase 6 — US4**: Private-temp and driver-specific probe code may be prepared from Phase 2 in parallel, but T064's shared capability-type extension waits for US3 T053; phase completion serializes Store/migration/backup integration after the corresponding US1/US3 edits.
- **Phase 7 — US5**: Depends on US1 identity/fidelity and US2 metadata-only catalog/scope/equivalence primitives. It completes read-side reconciliation and provenance without changing US3's conservative mutation refusal.
- **Phase 8 — US6**: Depends on US2 lazy inventory/hydration; it may use US5 logical rows without retaining their payloads.
- **Phase 9 — US7**: Public formatting can begin after field names stabilize, but release/documentation completion depends on all selected stories.
- **Phase 10 — Polish**: Depends on all seven story checkpoints.

### User Story Dependency Graph

```text
Setup -> Foundation -> US1 -> US2 -> US3 -> US4 completion
                  \              ├──> US5
                   \             └──> US6
                    └──> US4 private-temp/driver-specific probe preparation

US1 + US2 + US3 + US4 + US5 + US6 -> US7 -> Cross-cutting gates
```

### Within Each User Story

- Create locked fixtures and tests first and confirm the relevant assertions fail for the intended reason.
- Add pure models/policies before orchestration and adapters.
- Bind identity/scope before hydration and bind mutation targets before preflight or writes.
- Update core behavior before CLI/library formatting, then run the story's independent test.
- Do not update historical fixtures merely to agree with current implementation.

### Merge-Conflict Hotspots

- Serialize ownership of `src/core/storage.ts`, `src/core/store-stack/merge.ts`, `src/core/types.ts`, `src/lib/types.ts`, `src/lib/index.ts`, `src/core/backup.ts`, `package.json`, and `.github/workflows/npm-publish.yml`.
- Parallel markers do not authorize concurrent edits to one of these hotspots unless the owning task has already landed.

### Requirement Coverage

| Requirement range | Owning tasks |
|---|---|
| FR-001–FR-014: logical/message/tool identity and relationships | T006, T011–T023, T027–T028, T050–T054 |
| FR-015–FR-023: fidelity, replacement safety, and Store representation | T015–T016, T019, T024–T028 |
| FR-024–FR-028: deterministic timestamps and complete-view updates | T015, T090, T096–T099 |
| FR-029–FR-040: workspace matching, I/O boundary, scoped indices, and paths | T029–T046 |
| FR-041–FR-045: replicas, ambiguity, diagnostics, and occurrence references | T032, T037–T038, T071–T081 |
| FR-046–FR-050: bound migration | T047–T054, T064–T067 |
| FR-051–FR-055: temporary/final backup privacy and cleanup | T056–T063, T068–T069 |
| FR-056–FR-060: database capabilities and runtime fidelity | T055, T058–T059, T064–T067, T070 |
| FR-061–FR-065: bounded read contexts | T082–T089 |
| FR-066–FR-075: shipped contracts, release gates, and fault evidence | T091–T115 |
| FR-076–FR-078: tool rendering and locked v0.16/v0.17 transitions | T011–T019, T090, T097, T110 |

---

## Parallel Execution Examples

### User Story 1

After T011–T013 establish the oracle inputs, run T014, T015, T016, T017, and T018 in parallel. After T020 fixes shared identity functions, T021 can proceed independently from relationship/fidelity orchestration until merge integration.

### User Story 2

Run T029–T033 in parallel as failing acceptance slices. Implement T034 workspace matching and T035 I/O observation in parallel, then integrate them sequentially through T036–T046.

### User Story 3

Run T047 and T048 in parallel. After T050 defines the bound target, T051 CLI plumbing and T052 library plumbing can proceed in parallel before T053–T054 final refusal/revalidation logic.

### User Story 4

Run T055–T059 in parallel. Implement the private-temp lane T060/T063 and capability lane T064–T066 in parallel; serialize their integrations T061–T062 and T067–T070.

### User Story 5

Run T071–T074 in parallel. After T075 defines grouping/equivalence, serialize T076 Composer arbitration and T077 Store arbitration through the shared catalog hotspot before ambiguity/public projection work.

### User Story 6

Run T082–T084 in parallel. After T085 freezes construction semantics, implement core retention T086 while preparing public lifecycle mapping T088, then integrate bulk operations T087 and discovery counters T089.

### User Story 7

Run T090–T095 in parallel as failing release/output contracts. Once public fields stabilize, T100 CJS tooling, T102 result verification, and documentation tasks T104–T108 can proceed in parallel; serialize `package.json` and workflow integration through T101/T103.

---

## Implementation Strategy

### MVP First: Compatibility-Safe Upgrade

1. Complete Setup and Foundational Contracts.
2. Lock v0.16/v0.17 evidence before production changes.
3. Complete US1 and run its independent unchanged-consumer synchronization test.
4. Stop if any pre-existing Composer session/message/tool key changes or the third sync writes.

The MVP is **US1 only** because it prevents irreversible archive-key drift. It is not a release candidate until the remaining P1 security, scope, and migration stories also pass.

### Incremental Delivery

1. **US1**: Stable identity and replacement-safe fidelity.
2. **US2**: Scoped logical addressing and payload isolation.
3. **US3**: Safe bound migration.
4. **US4**: Private snapshots and capable database selection.
5. **US5**: Deterministic replica reconciliation and ambiguity.
6. **US6**: Bounded contexts and streaming bulk operations.
7. **US7**: Shipped contracts, artifact validation, and fail-closed publication.
8. **Polish**: Fault injection, complete matrix, exact package, and privacy-safe verification.

### Parallel Team Strategy

After Phase 2, use separate owners for:

- compatibility oracle and identity/merge work;
- workspace catalog/scope/I/O observation;
- private temporary storage and SQLite capability selection;
- release scripts/package smoke and documentation skeletons.

Merge those lanes only through the serialized hotspots listed above. A task marked `[P]` is parallelizable only after its stated phase prerequisites have landed.

---

## Notes

- Tests are release-blocking deliverables, not optional examples.
- Core/CLI indices remain one-based; public library read indices remain zero-based; public migration selectors remain one-based.
- Public `Session.id` remains the native Cursor UUID; physical locators never become public IDs.
- The unchanged-consumer compatibility contract excludes standalone `codeBlocks` and tool `files`; semantically required evidence must be projected into consumed fields or mark the view partial.
- Existing per-command fatal JSON stdout/stderr behavior is intentionally preserved for this corrective release.
- The constitution v1.2.0 amendment already exists; T108 enforces it in review rather than redefining it.
