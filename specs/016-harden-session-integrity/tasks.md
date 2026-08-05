# Tasks: Session Integrity and Compatibility Hardening

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

**Input**: Design documents from `/workspaces/patcomm/cursor-history/specs/016-harden-session-integrity/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Tests are required by FR-066, FR-069, and FR-072–FR-080. In every story, create the listed failing tests and locked evidence before changing the corresponding production behavior.

**Organization**: Tasks are grouped by user story and ordered so each story has an independently runnable acceptance slice. Paths are repository-relative unless shown as absolute.

Priority denotes release criticality, while execution remains dependency-ordered. US7 is P1 and
non-deferrable, but its integrated shipped contract and exact-artifact workflow must describe and
validate the selected P2 replica/memory behavior; it therefore closes after US5/US6 rather than
pretending those later contracts are already frozen. This dependency ordering does not make US7
optional or permit publication before it passes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Safe to execute in parallel only after the phase prerequisites and every explicit task/sequence prerequisite in this file are complete; it uses different files and has no dependency on another unfinished task in the same parallel group.
- **[Story]**: Maps the task to the numbered user story in `spec.md`.
- Unmarked tasks must run in listed order within their phase.

---

## Phase 1: Setup (Shared Test Infrastructure)

**Purpose**: Add reusable test infrastructure without changing production resolution behavior.

- [X] T001 Create deterministic Composer, Store DB, transcript, backup, duplicate-UUID, and workspace A/B fixture builders in `tests/helpers/session-integrity-fixtures.ts`
- [X] T002 Create the unchanged v0.16 vibe-history identity, digest, parent, and real SQLite atomic-replacement harness—where cursor-history supplies one complete replacement-safe view and compatibility signal while the unchanged consumer owns persistence, transaction, and rollback—pinned to `S2thend/vibe-history` revision `698701775144f7d8875330e1f8caec9ddfc27744`; record and verify the copied adapter/type/digest/policy/engine/SQLite-target/schema source-path and Git-blob inventory plus archive schema/migration assumptions without a live adjacent-repository dependency in `tests/helpers/v016-consumer.ts`, `tests/compatibility/fixtures/v016/vibe-history-consumer-manifest.json`, and `tests/compatibility/v016-consumer-provenance.test.ts`
- [X] T003 [P] Create a built-CLI subprocess helper that captures stdout bytes, stderr bytes, exit status, signals, and temporary roots in `tests/helpers/run-cli.ts`
- [X] T004 [P] Create low-level filesystem/SQLite/key-value event recording and poison-canary helpers in `tests/helpers/io-probe.ts`
- [X] T005 [P] Add explicit compatibility, e2e, package-smoke, and required-gate scripts while retaining Vitest discovery of every required suite in `package.json` and `vitest.config.ts`

**Checkpoint**: Shared fixtures and real-process test helpers are available; existing tests still pass unchanged.

---

## Phase 2: Foundational Contracts (Blocking Prerequisites)

**Purpose**: Establish the additive type and error vocabulary shared by every story.

**⚠️ CRITICAL**: Complete this phase before production work in any user-story phase.

- [X] T006 Define source roles, representations, resolution/fidelity states, identity origins, timestamp provenance, workspace memberships, source instances, fixed interface-specific index bases/scope, additive `listSessionSummaries()` rows, Source Read Limits v1/default/override types, exact source-kind/bound/unit discriminated diagnostic types for all 13 bounds, opaque public read-context lifecycle types, and diagnostics in `src/core/types.ts` and additive source-compatible declarations in `src/lib/types.ts`
- [X] T007 [P] Add failing safe-detail, stable-code, no-raw-locator, and exhaustive source-kind/bound/unit mismatch tests—including fractional ZIP-ratio observations but integer byte/count/row observations—for new core, CLI, and library failures in `tests/unit/cli-errors.test.ts` and `tests/unit/lib-errors.test.ts`
- [X] T008 Implement the typed scope, ambiguity, migration, temporary-artifact, read-context source/scope/options/disposed, source-encoding, source-limit, and source-limit-configuration error hierarchy in `src/core/errors.ts`
- [X] T009 Map core failures without exposing physical locators or content and export the new contracts through `src/core/index.ts`, `src/cli/errors.ts`, `src/lib/errors.ts`, and `src/lib/index.ts`
- [X] T010 [P] Create deterministic set-order, identity, pathless-alias, and structured-output assertion helpers in `tests/helpers/contract-assertions.ts`

**Checkpoint**: All later modules can depend on one typed compatibility vocabulary without changing existing public values.

---

## Phase 3: User Story 1 — Existing Library Backups Upgrade Without Identity Drift (Priority: P1) 🎯 MVP

**Goal**: Preserve every v0.16 Composer-derived key while complete Composer/Store views gain new content through one replacement and become idempotent.

**Independent Test**: Import a locked v0.16 Composer fixture through the unchanged consumer, resolve it as a complete merged session, synchronize twice, and prove every old key is byte-identical, new content exists once, failure is atomic, and the third synchronization performs zero writes.

### Tests and Locked Evidence for User Story 1

> Write and run these tests before production identity or merge changes; they must fail for the documented regressions.

- [X] T011 [US1] Create the provenance-recorded test-only v0.16 projector from tag `v0.16.0` commit `e8a7abf8cea3419a9dda911e174a05f82a9b260e` in `tests/compatibility/support/v016-projector.ts` and record source paths/blob hashes in `tests/compatibility/fixtures/v016/projector-manifest.json`
- [X] T012 [US1] Create reproducible generation and recurring safety validation for a locked, deterministic, wholly synthetic Composer-only v0.16 raw-layout SQLite database, workspace-fallback JSON, tagged projection, real pinned-schema vibe-history SQLite archive, and Store enrichment/gap/collision fixtures; forbid the generator from reading live Cursor roots, user archives, environment-derived identity/content, the adjacent vibe-history checkout, or other user data; record logical generator inputs, cursor-history source-format provenance, the separately pinned vibe-history consumer manifest reference, and SHA-256 hashes; regenerate into a private temporary directory and compare logical inventory plus hashes on every required run; scan generated and committed bytes for real content, paths, machine data, credentials, and real/user-derived Cursor IDs; and add a poison mutation proving that the scanner rejects a contaminated fixture in `tests/compatibility/support/generate-v016-fixtures.ts`, `tests/compatibility/v016-fixture-safety.test.ts`, `tests/compatibility/fixtures/v016/composer-global-state.vscdb`, `tests/compatibility/fixtures/v016/workspace-fallback.json`, `tests/compatibility/fixtures/v016/tagged-output.json`, `tests/compatibility/fixtures/v016/legacy-consumer-archive.sqlite`, `tests/compatibility/fixtures/v016/merged-store-source.json`, and `tests/compatibility/fixtures/v016/fixture-manifest.json`
- [X] T013 [P] [US1] Record v0.17 tag/commit/source provenance and add locked complete/degraded merged baselines, complete transcript-to-Store-DB inputs, and tagged legacy CLI fatal-output stream bytes in `tests/compatibility/fixtures/v017/provenance.json`, `tests/compatibility/fixtures/v017/complete-merged.json`, `tests/compatibility/fixtures/v017/degraded-store.json`, `tests/compatibility/fixtures/v017/transcript-complete.json`, `tests/compatibility/fixtures/v017/store-db-complete.json`, and `tests/compatibility/fixtures/v017/cli-fatal-output.json`
- [X] T014 [P] [US1] Add provenance, `rowid ASC`, placeholder, filtering, branch, bubble-ID, global, and workspace-fallback oracle tests in `tests/compatibility/v016-projector-provenance.test.ts`
- [X] T015 [P] [US1] Add native/null-ID, both-backbone, enrichment, parent, tool, collision, pinned unchanged-consumer provenance/conformance, real SQLite replacement, forced failure between delete/insert, close/reopen old-or-new completeness, degraded-non-overwrite, third-sync, and identity/fidelity/append-only faults, including start/middle Store insertions whose direct or inferred timestamps are below the archived maximum, in `tests/compatibility/v016-consumer-provenance.test.ts` and `tests/compatibility/v016-composer-upgrade.test.ts`
- [X] T016 [P] [US1] Add one-replacement, no-duplicate, native-Composer-ID, complete transcript-to-Store-DB replacement, degraded-pin/retry, second-sync-no-op, and transition-fault tests in `tests/compatibility/v017-convergence.test.ts`
- [X] T017 [P] [US1] Add failing pure identity, canonical hash, occurrence, collision, relationship, and tool-call tests plus consumed-field attachment projection, unsupported-raw partial fidelity, ignored standalone `codeBlocks`/`ToolCall.files`, and poison-URI no-dereference cases in `tests/unit/message-identity.test.ts`
- [X] T018 [P] [US1] Extend merge regressions and deliberate failing fault switches for preferred-backbone pairing drift and Composer-tool reordering, plus standalone-files exclusion and Store-native append order, in `tests/unit/store-stack-merge.test.ts`
- [X] T019 [US1] Add the exhaustive expected/not-expected/unknown Store DB, transcript fallback, metadata-only, explicit-no-conversation, and fatal-infrastructure state matrix before implementation in `tests/integration/store-expectation-state.test.ts`
- [X] T020 [US1] Add unknown-field tolerance and UTF-8/optional-BOM tests; generate sparse/bounded below/equal/first-unit-above fixtures for every JSONL and SQLite Source Read Limits v1 field; verify raw-byte counting, exact source-kind/bound/unit correlation with integer observations, JSONL per-transcript resets, SQLite keyset page/value and per-session/separate-catalog resets, safe-contributor partial versus no-fallback fatal outcomes, unknown/`policyVersion`/null/cross-field/runtime override rejection before payload I/O, omitted/recognized-undefined default inheritance, immutable internal per-operation raising/lowering, no global/environment/input/manifest override or automatic retry, identity independence, and cleanup in `tests/integration/defensive-source-parsing.test.ts`

### Implementation for User Story 1

- [X] T021 [US1] Implement the exact v0.16 Composer projection, native/fallback message identities, canonical JSON/SHA-256 functions, occurrences, collisions, and synthetic tool identities in `src/core/session-identity.ts`
- [X] T022 [US1] Retain Store DB leaf hashes/traversal order and transcript canonical inputs/line order before merging; centralize, validate, copy, and freeze Source Read Limits v1 defaults/overrides; apply deterministic unknown-field and UTF-8/optional-BOM policy; replace whole-file transcript parsing with raw-byte streaming and fatal per-record decoding; replace SQLite payload `.all()`/offset materialization with keyset/row-ID metadata pages, pre-materialization length checks, and sequential payload fetches; enforce per-source/session/catalog reset rules and typed fallback outcomes in `src/core/source-read-limits.ts`, `src/core/parser.ts`, `src/core/store-stack/store-db.ts`, `src/core/store-stack/transcript.ts`, and `src/core/store-stack/types.ts`
- [X] T023 [US1] Refactor fixed Composer-to-Store alignment, preferred-source rendering, matched Composer identity inheritance, canonical-params tool matching, and fixed Composer tool slots in `src/core/store-stack/merge.ts`
- [X] T024 [US1] Rewrite parent, branch, leaf, sidechain, `activeBranchBubbleIds`, and additive `activeBranchMessageIds` through resolved identities in `src/core/store-stack/merge.ts` and `src/core/storage.ts`
- [X] T025 [US1] Implement Store DB expectation and complete/partial/metadata-only representation selection without unsafe transcript fallback, returning typed partial/fatal diagnostics rather than guessing invalid or mixed encodings in `src/core/store-stack/discover.ts`, `src/core/store-stack/store-db.ts`, and `src/core/store-stack/transcript.ts`
- [X] T026 [US1] Map complete views to legacy `source: "global"`, degraded views to `workspace-fallback`, and actual provenance to additive resolution fields in `src/core/storage.ts`
- [ ] T027 [US1] Retain raw attachment evidence through source decoding, project supported evidence only into unchanged-consumer `content` or `name/status/params/result/error`, mark unsupported raw evidence partial, and never dereference external targets in `src/core/store-stack/store-db.ts`, `src/core/store-stack/transcript.ts`, `src/core/store-stack/types.ts`, `src/core/parser.ts`, and `src/core/store-stack/merge.ts`
- [X] T028 [US1] Emit nonempty resolved message/tool identities, origins, deterministic relationship references, and compatibility signals through `src/core/parser.ts` and `src/core/types.ts`
- [ ] T029 [US1] Preserve existing library return shapes and aliases while emitting one complete replacement-safe merged view and legacy comparison signal; leave atomic persistence, transaction, and rollback to the unchanged consumer exercised by T002/T015 in `src/lib/index.ts` and `src/lib/types.ts`

**Checkpoint**: `tests/compatibility/v016-projector-provenance.test.ts`, `v016-composer-upgrade.test.ts`, `v017-convergence.test.ts`, and identity/merge unit tests pass; fixture regeneration is not an accepted fix.

---

## Phase 4: User Story 2 — Workspace-Scoped Reads Return and Inspect Only Intended Data (Priority: P1)

**Goal**: Make scoped indices round-trip through the same logical row while preventing any unrelated workspace payload hydration.

**Independent Test**: Use conflicting global/workspace ordering, A/B needles, a shared UUID, and poisoned off-scope contributors across built CLI and library list/show/search/export on live, backup, and custom paths; assert correct IDs/paths and zero B payload reads.

### Tests for User Story 2

- [X] T030 [P] [US2] Add lexical normalization, exact-first, unique component-suffix, ambiguous suffix, historical-path, drive/WSL, case, and pre-I/O failure tests in `tests/unit/workspace-scope.test.ts`
- [ ] T031 [P] [US2] Add low-level metadata/payload events, poison DB/transcript/blob/key-value resources, observer-bypass fault failure, partial omission, and opt-in broadening tests in `tests/integration/workspace-io-boundary.test.ts`
- [ ] T032 [P] [US2] Add built-CLI A/B list/show/search/export, first-row-one-based index, and JSON scope/path assertions in `tests/e2e/cli-session-integrity.test.ts`
- [ ] T033 [P] [US2] Extend scoped/global index conflicts, wrong-ID/path/index mutation failures, direct-ID membership, ambiguity round-trip, workspace counts, backup/custom-path parity, and the FR-042 included/excluded-field equivalence matrix—including direct timestamp divergence and provenance/inferred/path/standalone-field equivalence—in `tests/integration/workspace-index-roundtrip.test.ts` and `tests/unit/session-replica-equivalence.test.ts`
- [ ] T034 [P] [US2] Extend public list/get/search/single-export/bulk-export and additive `listSessionSummaries()` tests for zero-based library reads, correct IDs/paths/partial diagnostics, ambiguity-inclusive totals/`hasMore`, index gaps, short resolved-only `listSessions().data`, no backfill from later logical rows, and one summary row with no `messages` per logical catalog row in `tests/unit/lib-index.test.ts`

### Implementation for User Story 2

- [X] T035 [P] [US2] Implement lexical historical-path normalization and exact-first/unambiguous component-suffix matching in `src/core/workspace-scope.ts`
- [X] T036 [P] [US2] Implement safe low-level metadata-versus-payload event classification and observer registration in `src/core/io-observer.ts`
- [ ] T037 [US2] Route actual filesystem/backup opens and reads, SQLite driver/index open/prepare/query/backup calls, and Store/key-value reads through the observer seam in `src/core/backup.ts`, `src/core/database/index.ts`, `src/core/database/drivers/node-sqlite.ts`, `src/core/database/drivers/better-sqlite3.ts`, `src/core/storage.ts`, `src/core/store-stack/discover.ts`, `src/core/store-stack/store-db.ts`, and `src/core/store-stack/transcript.ts`
- [ ] T038 [US2] Build metadata-only physical inventory, native-UUID/source-role/representation/tier grouping, workspace memberships, and lazy selected-instance hydration in `src/core/session-catalog.ts` and `src/core/store-stack/discover.ts`
- [ ] T039 [US2] Implement versioned consumed-payload equivalence, one minimal ambiguous logical summary/opaque reference path, immutable workspace content scope, and explicit partial plans before payload access in `src/core/session-catalog.ts` and `src/core/storage.ts`
- [ ] T040 [US2] Preserve Composer canonical path separately from matched and per-source paths and canonically order memberships/source instances in `src/core/session-catalog.ts` and `src/core/storage.ts`
- [ ] T041 [US2] Bind the documented one-based CLI/core indices to logical UUID plus permitted occurrence set and verify scoped direct-ID membership in `src/cli/commands/session-lookup.ts` and `src/core/storage.ts`
- [ ] T042 [US2] Thread one bound read context through CLI list/show/search/export without numeric re-resolution in `src/cli/commands/list.ts`, `src/cli/commands/show.ts`, `src/cli/commands/search.ts`, and `src/cli/commands/export.ts`
- [ ] T043 [US2] Thread workspace, data source, backup, stable-ID reload, and diagnostics through public reads; formally export additive `listSessionSummaries()` with one-to-one logical-row pagination, resolution/ambiguity rows without `messages`, and documented zero-based library indices; compute both listing APIs' total/`hasMore` from the same pre-hydration logical catalog window while preserving short resolved-only `listSessions().data`, index gaps, and a strict no-backfill rule in `src/lib/config.ts`, `src/lib/types.ts`, and `src/lib/index.ts`
- [ ] T044 [US2] Make workspace discovery count the same deduplicated logical rows returned by each workspace listing in `src/core/storage.ts` and `src/cli/commands/list.ts`
- [ ] T045 [US2] Implement `includeCrossWorkspaceSources` so it broadens only contributors of already-selected UUIDs and records every broadened path through parent options and public declarations in `src/cli/index.ts`, `src/cli/commands/list.ts`, `src/cli/commands/show.ts`, `src/cli/commands/search.ts`, `src/cli/commands/export.ts`, `src/lib/config.ts`, `src/lib/types.ts`, and `src/core/storage.ts`
- [ ] T046 [US2] Emit `indexScope`, workspace-only `indexWorkspacePath`, stable canonical/matched paths, resolution details, and no locators in `src/cli/formatters/json.ts`
- [ ] T047 [US2] Render visible partial/omitted-source and actionable empty/ambiguous workspace diagnostics in `src/cli/formatters/table.ts` and `src/cli/errors.ts`

**Checkpoint**: Built CLI and library operations return A consistently, find only `needle-a`, report omitted contributors honestly, and record zero off-scope payload events.

---

## Phase 5: User Story 3 — Destructive Migration Resolves One Explicit Scoped Target (Priority: P1)

**Goal**: Make dry-run and execution share one prevalidated Composer target and reject every unsafe multi-source or multi-locator case before writes.

**Independent Test**: Preview and apply workspace-A index 1 when global index 1 is B, then verify target identity/fingerprint equality, UUID semantics, and zero-write rejection for changed, duplicate, shared, divergent, Store-only, and merged targets.

### Tests for User Story 3

- [ ] T048 [P] [US3] Add scoped numeric/direct-ID, documented one-based library migration selector, unchanged unfiltered numeric preview/apply, session/workspace migration `sourceReadLimits` propagation and invalid-before-read behavior, incapable-driver preflight, fingerprint race, multi-locator/shared-membership, divergent, Store-only, merged, and zero-write assertions in `tests/integration/migrate-session-scope.test.ts`
- [ ] T049 [P] [US3] Extend prepare/preflight/revalidate/apply, move-retains-UUID, copy-new-UUID, and destination-failure unit tests in `tests/unit/migrate.test.ts`
- [ ] T050 [US3] Add built-CLI parent-workspace propagation and identical dry-run/apply target assertions in `tests/e2e/cli-session-integrity.test.ts` and `tests/unit/cli-commands.test.ts`

### Implementation for User Story 3

- [ ] T051 [US3] Implement `BoundMigrationTarget`, prepare/preflight/fingerprint/revalidate/apply state transitions, and first-write boundary in `src/core/migrate.ts`
- [ ] T052 [US3] Consume parent `--workspace` and the already-bound logical row in `src/cli/commands/migrate-session.ts` and `src/cli/commands/session-lookup.ts`
- [ ] T053 [US3] Thread the documented one-based migration selectors, workspace scope, validated/frozen per-operation `sourceReadLimits`, cancellation, typed refusals, and safe preview metadata through `src/lib/types.ts`, `src/lib/index.ts`, and `src/lib/errors.ts`
- [ ] T054 [US3] Implement the shared `readWrite` capability-request/preference/preflight base and reject multiple Composer locators, shared global footprints, divergent rows, diagnostic references, Store-only/merged sessions, and half-migrations before writes in `src/core/database/types.ts`, `src/core/database/registry.ts`, `src/core/database/index.ts`, `src/core/database/errors.ts`, `src/core/migrate.ts`, and `src/cli/commands/migrate.ts`
- [ ] T055 [US3] Preserve native UUID for moves, allocate a new UUID only for true copies, and fail target changes without re-resolution in `src/core/migrate.ts`

**Checkpoint**: Every migration selector either mutates exactly the previewed eligible Composer occurrence or performs zero writes with a typed refusal.

---

## Phase 6: User Story 4 — Backup and Database Reads Are Private and Reliable (Priority: P1)

**Goal**: Keep every plaintext snapshot owner-private on permission-aware platforms and securely created, isolated, and recoverably cleaned on every supported platform while selecting SQLite providers by actual operation capability.

**Independent Test**: Run successful, malformed, concurrent, cancelled, signaled, SIGKILL-recovery, incapable-provider, and archive-permission scenarios using real files and databases; assert owner-only modes on permission-aware platforms, Windows system-temporary-directory ACL inheritance/unique creation/cleanup without an unverified cross-user claim, typed outcomes, and no false empty/partial success.

### Tests for User Story 4

- [ ] T056 [P] [US4] Add importable-but-no-backup, auto fallback, forced failure, config propagation, and synchronous preference tests in `tests/unit/database-capabilities.test.ts`
- [ ] T057 [P] [US4] Add real POSIX `umask 000`, unchanged process/parent modes, exact private/shared/overwrite modes, concurrency, secure-create/snapshot/DB-open/parse/close/cleanup failures, and an intentional temp-leak mutation; generate sparse/bounded below/equal/first-unit-above fixtures for every ZIP Source Read Limits v1 compressed-container/central-count/entry/aggregate/ratio field; enforce exact source-kind/bound/unit correlation, integer byte/count observations, and fractional first-failing ratio observations; validate central-versus-streamed size/CRC disagreement, traversal/duplicate/encryption/unknown-method rejection, archive-fatal outcomes, override validation, and residue-free cancellation in `tests/integration/backup-snapshot-security.test.ts`
- [X] T058 [P] [US4] Add dedicated child-process SIGINT/SIGTERM/SIGHUP/AbortSignal/SIGKILL containment, preserved signal termination semantics, marker validation, stale recovery, wrong-owner/live-owner/malformed-marker/symlink traps, and Windows system-temp ACL inheritance, uniqueness, cleanup, and typed-failure coverage without asserting unverified cross-user isolation in `tests/integration/private-temp-signal-recovery.test.ts`
- [ ] T059 [P] [US4] Extend real driver capability-boundary and no-false-partial Store tests in `tests/integration/drivers.test.ts`
- [ ] T060 [P] [US4] Extend backup/library create/validate/list/restore source-limit override propagation, Store snapshot failure/permission, legacy-manifest readability, actual producer-version, and limit/producer identity-dedup independence tests in `tests/unit/backup.test.ts`, `tests/unit/lib-backup.test.ts`, and `tests/unit/store-stack-store-db.test.ts`

### Implementation for User Story 4

- [X] T061 [US4] Implement exclusive private directories, markers, POSIX `0700` directories/`0600` files, Windows creation under the system-provided user temporary directory with inherited ACLs, tracked artifacts, idempotent exhaustive disposal, and paths-only residue errors in `src/core/private-temp.ts`
- [X] T062 [US4] Add active-workspace signal cleanup and conservative current-owner/proven-dead stale recovery without following symlinks in `src/core/private-temp.ts`
- [ ] T063 [US4] Replace shared/predictable backup creation and extraction staging with `PrivateTempWorkspace`; implement bounded ZIP32/ZIP64 central-range parsing, normalized-name/duplicate rejection, STORE/DEFLATE streamed extraction, encryption/unknown-method refusal, CRC/checksum validation, and Source Read Limits v1 compressed-container, entry-count, per-entry, aggregate, and per-entry/aggregate ratio checks before/during output; thread per-operation overrides and cooperative `AbortSignal` cancellation; and guarantee nested `try/finally` cleanup in `src/core/zip-stream.ts`, `src/core/backup.ts`, and `src/core/types.ts`
- [ ] T064 [US4] Route routine Store database snapshots and read-context `AbortSignal` cancellation through the same private workspace and propagate infrastructure failures instead of partial sessions in `src/core/store-stack/store-db.ts` and `src/core/storage.ts`
- [X] T065 [P] [US4] Extend the migration capability base with `read` and `onlineBackup` profiles and probe actual APIs in `src/core/database/types.ts`, `src/core/database/drivers/node-sqlite.ts`, and `src/core/database/drivers/better-sqlite3.ts`
- [X] T066 [P] [US4] Upgrade and lock the researched `better-sqlite3 >=12.10.0 <13` capability baseline consistently in `package.json` and `package-lock.json`
- [X] T067 [US4] Extend shared selection to every operation using operation/library config, then latest `setDriver`, then environment, then automatic preference; auto-fallback only in automatic mode; return actionable forced/no-capable-driver errors in `src/core/database/registry.ts`, `src/core/database/errors.ts`, and `src/core/database/index.ts`
- [ ] T068 [US4] Thread driver preference through database entry points, read, snapshot, backup, Store, migration, and public-library operations while preserving synchronous `setDriver(): void` in `src/core/database/index.ts`, `src/core/storage.ts`, `src/lib/config.ts`, and `src/lib/index.ts`
- [ ] T069 [US4] Generate final archives and per-file hashes through streamed file inputs/output rather than aggregate in-memory buffers, stage and atomically publish them as owner-only by default on permission-aware platforms, preserve overwrite modes, and expose typed `sharedPermissions`, per-operation `sourceReadLimits`, explicit `--shared`, and repeatable `--source-limit` plumbing in `src/core/zip-stream.ts`, `src/core/backup.ts`, `src/core/types.ts`, `src/cli/commands/backup.ts`, `src/lib/backup.ts`, and `src/lib/types.ts`
- [X] T070 [US4] Replace the hard-coded backup-manifest producer with the actual running package version, retain readability of older manifests, and keep producer metadata out of session/message identity, replica equivalence, deduplication, and incremental synchronization in `src/core/backup.ts`
- [ ] T071 [US4] Remove Store/backup catch paths that convert capability or snapshot failures into successful empty/partial data in `src/core/store-stack/store-db.ts` and `src/core/storage.ts`

**Checkpoint**: Catchable paths leave zero plaintext residue, uncatchable residue remains private and is conservatively recovered, and every provider request succeeds through a capable driver or fails once with a typed remedy.

---

## Phase 7: User Story 5 — Duplicate Physical Occurrences Have Deterministic, Honest Addressing (Priority: P2)

**Goal**: Collapse equivalent same-role replicas, expose divergent replicas as one non-resolvable logical ambiguity, and keep Composer/Store contributors complementary.

**Independent Test**: Exercise equivalent/divergent same-role groups and complementary Composer/Store pairs through list, direct/index lookup, search, export, and migration; assert one UUID, deterministic provenance, no contested hydration, and no guessed mutation.

### Tests for User Story 5

- [ ] T072 [P] [US5] Add equivalent/divergent replica list/search/export/direct-ID/index diagnostics, complementary Composer/Store behavior, and field-by-field FR-042 confirmation against the earlier unit matrix in `tests/integration/session-replica-reconciliation.test.ts`
- [ ] T073 [P] [US5] Extend the pre-existing Store expectation matrix with equivalent/divergent same-tier DB/transcript replica groups and deterministic discovery-order permutations in `tests/integration/store-expectation-state.test.ts`
- [ ] T074 [P] [US5] Add global-primary, workspace-membership-only, workspace partial fallback, same-tier-only comparison, off-scope omission, and fatal-infrastructure tests in `tests/integration/composer-source-arbitration.test.ts`
- [ ] T075 [P] [US5] Extend duplicate discovery, one-logical-row, deterministic-order, and complementary-source regressions in `tests/integration/store-stack-dedup.test.ts`, `tests/unit/store-stack-discover.test.ts`, and `tests/unit/store-stack-merge.test.ts`

### Implementation for User Story 5

- [X] T076 [US5] Apply the US2 grouping/equivalence engine to reconcile permitted same-role replicas, retain every equivalent occurrence, and keep complementary source roles separate in `src/core/session-catalog.ts`
- [ ] T077 [US5] Implement Composer global-primary/workspace-membership arbitration and partial workspace fallback in `src/core/session-catalog.ts` and `src/core/storage.ts`
- [ ] T078 [US5] Apply the already-tested US1 Store representation states to reconcile DB candidates only with same-tier DB peers and transcripts only with same-tier transcript peers without redefining the state matrix in `src/core/session-catalog.ts` and `src/core/store-stack/discover.ts`
- [ ] T079 [US5] Finalize equivalent provenance and ambiguous-summary projection with deterministic opaque references and typed CLI/library read failures in `src/core/session-catalog.ts`, `src/core/errors.ts`, `src/cli/errors.ts`, and `src/lib/errors.ts`
- [ ] T080 [US5] Skip ambiguous payloads exactly once in search/bulk export and emit one machine-readable diagnostic without a locator in `src/core/storage.ts`, `src/cli/commands/search.ts`, and `src/cli/commands/export.ts`
- [ ] T081 [US5] Expose deterministically ordered workspace memberships and plural per-instance `workspacePaths` while keeping locators private in `src/core/storage.ts`, `src/lib/index.ts`, and `src/cli/formatters/json.ts`
- [ ] T082 [US5] Keep native ID and Composer canonical path stable across filters/preferences while varying only matched-path metadata in `src/core/session-catalog.ts` and `src/core/storage.ts`

**Checkpoint**: Equivalent replicas appear once, divergent replicas remain one honest ambiguity, and complementary Composer/Store content still follows the merge contract.

---

## Phase 8: User Story 6 — Large-Corpus Operations Remain Bounded and Order-Independent (Priority: P2)

**Goal**: Bind read scope explicitly, coalesce only active work, retain at most `C+A`, and stream bulk operations without pinning the corpus.

**Independent Test**: Compare `N` and `2N` corpora under reversed list/get order, concurrent same-key reads, scope conflict, one rejection, bulk search/export, and disposal; assert identical results and the documented memory bound.

### Tests for User Story 6

- [ ] T083 [P] [US6] Add get-before-list/list-before-get, conflict-before-I/O, in-flight coalescing, rejection retry, `N`/`2N`, `C+A`, deliberate over-retention fault failure, public/core bulk `C=0`, and dispose assertions in `tests/integration/read-context-bounds.test.ts`
- [ ] T084 [P] [US6] Extend immutable options, finite capacity, eviction, retry, release, and disposed-error unit tests in `tests/unit/storage-context.test.ts`
- [ ] T085 [P] [US6] Extend public library operation-order, diagnostics continuation, lifecycle, `LibraryConfig.sourceReadLimits`/opaque-context override propagation, raise/lower and omitted/recognized-undefined default inheritance, unknown/`policyVersion`/null rejection before payload I/O, immutable context binding, per-session counter reset, identity independence, ordinary binding mismatch, and exact `READ_CONTEXT_OPTIONS_MISMATCH` rejection before I/O whenever caller-supplied `readContext` and per-call `sourceReadLimits` coexist across list/get/search/export in `tests/unit/lib-index.test.ts`

### Implementation for User Story 6

- [ ] T086 [US6] Construct `SessionReadContext` from one immutable data-source/scope/options binding and reject conflicting or disposed use before content I/O in `src/core/storage.ts`
- [ ] T087 [US6] Separate active promise coalescing from a completed-session LRU, default capacity to `C=1`, evict rejections, and implement `releaseSession()`/idempotent `dispose()` in `src/core/storage.ts`
- [ ] T088 [US6] Expose an additive opaque package-root `SessionReadContext` factory plus immutable lifecycle/source-limit options and `LibraryConfig.readContext`; keep internal binding/catalog/locator/limit-map state private, reject conflicting per-call bindings before I/O, reject any simultaneous caller-supplied `readContext` and per-call `sourceReadLimits` as `READ_CONTEXT_OPTIONS_MISMATCH`, make caller-supplied context ownership explicit, and preserve built-in `finally` disposal in `src/lib/config.ts`, `src/lib/types.ts`, and `src/lib/index.ts`
- [ ] T089 [US6] Run built-in and public-library search/bulk JSON/Markdown export with `C=0`, release each completed payload, continue supported diagnostics, and dispose contexts in `finally` in `src/core/storage.ts`, `src/lib/index.ts`, `src/cli/commands/search.ts`, and `src/cli/commands/export.ts`
- [ ] T090 [US6] Remove eager decoded-session retention from Store discovery and expose test-only ownership counters needed to prove `C+A` in `src/core/store-stack/discover.ts` and `src/core/storage.ts`

**Checkpoint**: Operation order is irrelevant, failures remain retryable/isolated, and doubling session count does not increase context-owned decoded-session retention above `C+A`.

---

## Phase 9: User Story 7 — Addressing, Provenance, and Release Safety Are Visible on Shipped Surfaces (Priority: P1)

**Goal**: Ship explicit scope/fidelity/timestamp contracts and prevent publication unless the exact artifact passes every required compatibility and runtime gate. This phase is mandatory and cannot be deferred from the corrective release.

**Independent Test**: Validate built CLI and library JSON/human output, help, packaged documentation/types, the documented fatal-stream migration, CJS/ESM imports, exact-tarball identity, and deliberately failing/zero/skipped/timed-out/cancelled release stages.

### Tests for User Story 7

- [ ] T091 [P] [US7] Add exact session-source precedence, message next/previous/session/epoch fallback, `epoch-unknown` non-anchoring, fake-clock/backbone/scope/discovery-order repetition, `Date.now()`/zero-argument-`new Date()` poison, approximate rendering, true error/thinking filtering, and structured tool tests in `tests/unit/parser.test.ts`, `tests/unit/cli-formatters-json.test.ts`, `tests/unit/cli-formatters-table.test.ts`, and `tests/unit/filter.test.ts`
- [ ] T092 [P] [US7] Execute the tagged v0.17 artifact to lock legacy fatal stream bytes, then exercise every registered CLI command and fatal JSON category—including list/show/search/export, migrate/migrate-session, backup/restore/list-backups, root option/usage parsing, command loading, not-found, I/O, and unexpected typed failures—and prove by built-process fixtures plus command-registry/category coverage that the corrective CLI preserves every pre-existing fatal JSON field name/type/value and exit category for the same fixture while allowing only documented additive fields, moves the object to `stderr` with empty `stdout`, preserves documented partial-success result/exit behavior, and fails coverage when a command or fatal category is unregistered; lock `SOURCE_LIMIT_CONFIGURATION_INVALID` to usage exit 2, fatal encoding/limit errors to I/O exit 4, and safe-fallback partial envelopes to exit 0; additionally prove valid repeated-different-field `--source-limit` propagation to every relevant command and reject unknown/`policyVersion`/duplicate field, syntax, range, cross-field, and runtime-limit errors before payload I/O in `tests/e2e/cli-fatal-json.test.ts`, `tests/unit/cli-commands.test.ts`, and `tests/compatibility/fixtures/v017/cli-fatal-output.json`
- [ ] T093 [P] [US7] Add exact packed-tarball ESM/CJS/declaration/CLI/fixture/docs/producer-version/pathless-alias smoke tests; load packed `dist/lib/index.d.ts` with the TypeScript compiler, enumerate package-root exports, resolve aliases/re-exports to their declaration symbols, and require contract JSDoc for every resulting symbol plus parameter/return/typed-error documentation for callable and constructable exports; verify shipped docs identify Compatibility Matrix v1; execute built-CLI documentation examples; and typecheck/run public-library examples in `tests/e2e/package-smoke.test.ts`
- [X] T094 [P] [US7] Add zero-test, allowed platform-skip, unexpected-skip, nonzero, timeout, cancellation, publish-after-failure mutation, and success tests in `tests/unit/verify-test-results.test.ts`
- [X] T095 [P] [US7] Add fail-closed workflow dependency and bypass mutation, Node 20.0.0/22.15.1/22.16.0/23.7.0/23.8.0/current-24-LTS/latest-26-Current matrix, tag/version, pack-once, checksum, clean-install, and publish-exact-tarball assertions in `tests/e2e/publish-workflow.test.ts`
- [ ] T096 [P] [US7] Treat `specs/016-harden-session-integrity/contracts/session-output.schema.json` as the frozen design oracle and validate list/show/search/export fixtures, pathless distinctions, required fields, canonical ordering, partial/ambiguous unions, every exact source-kind/bound/unit diagnostic combination, rejection of every wrong pairing, integer byte/count/row versus fractional ZIP-ratio observations, ZIP-fatal exclusion from success diagnostics, and no-locator guarantees without rewriting the schema to match implementation output in `tests/e2e/cli-json-schema.test.ts`

### Implementation for User Story 7

- [ ] T097 [US7] Implement Composer metadata, Store DB/meta, direct-message extrema, then epoch session-time precedence and message next/previous/valid-session/epoch fallback with explicit provenance, `epoch-unknown` non-anchoring, and no wall-clock/filesystem-time input in `src/core/parser.ts` and `src/core/storage.ts`
- [ ] T098 [US7] Mark inferred human times approximate, retain structured tools on error/thinking messages, and filter by actual message category in `src/cli/formatters/table.ts`, `src/cli/formatters/json.ts`, and `src/core/storage.ts`
- [ ] T099 [US7] Register the repeatable global `--source-limit` parser once, reject duplicate-field/syntax/range/cross-field errors before payload I/O, and propagate the frozen map through list/show/search/export, migrate/migrate-session, backup/restore/list-backups and their bound contexts; add complete scope/index-base, unique-suffix, cross-source opt-in, migration, backup sharing, completeness, Source Read Limits v1 syntax/risk, and actionable empty/ambiguity CLI help; route every registered command's fatal JSON object through shared safe serialization to `stderr` with empty `stdout` while preserving every pre-existing field name/type/value and exit category for the same fixture and adding only documented safe fields, retain nonfatal/partial result output on `stdout`, and expose command/limit registries that make bypasses test-detectable in `src/cli/index.ts`, `src/cli/errors.ts`, `src/cli/commands/list.ts`, `src/cli/commands/show.ts`, `src/cli/commands/search.ts`, `src/cli/commands/export.ts`, `src/cli/commands/migrate.ts`, `src/cli/commands/migrate-session.ts`, `src/cli/commands/backup.ts`, `src/cli/commands/restore.ts`, and `src/cli/commands/list-backups.ts`
- [ ] T100 [US7] Finalize additive public `listSessionSummaries()` row and session/message/tool/timestamp/source/diagnostic fields, exact pathless `workspace: "unknown"` behavior, and fixed zero-based library-read and one-based migration-selector contracts; then audit/fill contract JSDoc for every symbol reachable from the package-root export graph—including aliases, re-exports, all existing and feature-016 functions/types/classes/type guards/constants, and public context lifecycle members—in `src/lib/types.ts`, `src/lib/index.ts`, `src/lib/config.ts`, `src/lib/errors.ts`, `src/lib/backup.ts`, `src/lib/utils.ts`, `src/cli/formatters/table.ts`, and the package-root `MessageType`/`MESSAGE_TYPES` declarations in `src/core/types.ts`
- [X] T101 [P] [US7] Add the NodeNext CommonJS build tree and generated `.cjs` wrapper in `tsconfig.cjs.json` and `scripts/build-cjs.mjs`
- [X] T102 [US7] Make build/package scripts produce ESM, CJS, declarations, and CLI and include `README.md`, `LICENSE`, `CHANGELOG.md`, and `docs/compatibility.md` in the declared package contents in `package.json` and `package-lock.json`
- [X] T103 [P] [US7] Implement a documented per-platform skip allowlist and machine-verifiable rejection of zero tests, unexpected skips, failures, timeout, and cancellation in `scripts/verify-test-results.mjs`
- [X] T104 [US7] Remove test-failure swallowing; require install/typecheck/lint/nonzero-test/build success; validate the Node 20.0.0 project-compatibility floor despite upstream EOL, 22.15.1/22.16.0, 23.7.0/23.8.0, current 24 LTS, and latest 26 Current capability boundaries; then have the staged release workflow pack once, preserve a checksum-addressed candidate, pause behind the protected verification approval, and publish those exact bytes without rebuild or repack in `.github/workflows/npm-publish.yml`
- [X] T105 [P] [US7] Write the canonical logical-ID, physical-instance, fixed CLI/core/library/migration index-base and scope, workspace-I/O, fidelity/provenance, defensive text-decoding, exact inclusive Source Read Limits v1 default table/reset/error semantics, per-operation CLI/library override examples and increased-exposure warning, v0.16 safe-upgrade, v0.17 fatal-stream migration, and the packaged Compatibility Matrix v1 projection copied from the normative spec table, including built-CLI-tested and typechecked/runnable public-library examples, in `docs/compatibility.md`
- [X] T106 [P] [US7] Document the same shipped addressing, source, timestamp, platform-qualified backup-permission, upgrade, and executable-example guidance in `README.md`
- [X] T107 [P] [US7] Synchronize or canonically link the compatibility contract and its verified examples from `docs/readme_es.md`, `docs/readme_fr.md`, and `docs/readme_zh.md`
- [X] T108 [P] [US7] Add missing v0.12–v0.17 history, the v0.17 incremental-library and fatal-stream warning, and corrective-release guarantees/pinning/migration path in `CHANGELOG.md`
- [X] T109 [P] [US7] Require compatibility disposition, affected-version fixture, regression-test, migration-note, and source-fidelity evidence for 100% of feature 016 public returned-value changes in `.github/pull_request_template.md`, while retaining the existing v1.2.0 amendment in `.specify/memory/constitution.md`

**Checkpoint**: Every shipped surface explains the same contract, all schema/output tests pass, and no failed or untested revision can reach publication.

---

## Phase 10: Polish & Cross-Cutting Completion Gates

**Purpose**: Prove the integrated implementation, distributed artifact, and release evidence satisfy every story together.

- [ ] T110 [P] Aggregate and rerun the owning-story fault switches for wrong index/ID/path, off-scope hydration, bypassed recording with armed DB/transcript/KV/blob canaries, identity/backbone drift, tool reorder, unsafe fidelity, timestamp watermark, source-limit bypass/counter-not-reset/automatic-raise, temp leakage, memory overflow, and publish-after-failure in `tests/integration/session-integrity-faults.test.ts`
- [ ] T111 [P] Treat the Matrix v1 table in `spec.md` as normative, fail on any row/cell drift in both its design-time `contracts/compatibility-matrix-v1.md` and packaged `docs/compatibility.md` projections, execute every `Required` cell and verify every `Unsupported`/`N/A` declaration across live/backup/custom-path, both-backbone, scoped-partial/opt-in-complete, duplicate/complementary-source, and structured-output cases, and require an explicit matrix-version update for a new representation or carrier in `tests/e2e/compatibility-matrix-contract.test.ts`, `tests/e2e/cli-session-integrity.test.ts`, and `tests/helpers/session-integrity-fixtures.ts`
- [ ] T112 Implement and test a metadata-only, content-nonretaining Source Read Limits v1 preflight and exact-policy artifact-drift check in `scripts/preflight-source-limits.mjs` and `tests/unit/preflight-source-limits.test.ts`; create the non-sensitive instructions/evidence template in `docs/release-verification.md`; run the preflight only over authorized Cursor source carriers actually readable by v0.16—live/custom Composer roots and cursor-history backup ZIP/SQLite inputs, never the downstream vibe-history database/archive—and record outside the repository only maximum counts/sizes/ratios; require raising any exceeded legitimate default before release so unchanged consumers need no override; any raised default must update and re-lock `spec.md`, `research.md`, `data-model.md`, `contracts/internal-resolution.md`, `contracts/library-api.md`, `contracts/cli-json.md`, `quickstart.md`, `tasks.md`, implementation constants, tests, and packaged `docs/compatibility.md`, pass the exact-policy drift check, and restart T020, T022, T057, T060, T063, T069, T085, T088, T092, T099, T105, and T110–T112 before continuing
- [ ] T113 Run the preliminary full required validation; if any failure or unplanned tracked edit occurs, return to the owning task and rerun T112–T113 from the start; only after a clean pass, create the frozen item-level FR-001–FR-080/SC-001–SC-017 traceability, Compatibility Matrix v1 result map, and compatibility disposition/evidence for 100% of feature-016 public returned-value changes, plus contract, quickstart, runtime, and constitution gates with no unresolved exception, allowing only this planned checklist write before T114 in `specs/016-harden-session-integrity/checklists/implementation.md`
- [ ] T114 After all repository artifacts are frozen, run `npm ci`, typecheck, lint, format check, standard tests—including executable v0.16 fixture regeneration/hash/sensitive-scan/poison and preflight-policy suites—and build through the required scripts without modifying tracked inputs in `package.json`, fixing any failure only by returning to the owning task and then rerunning T112–T114 from the start
- [ ] T115 Run the staged release gate from the exact T114 revision so it packs once and preserves a checksum-addressed candidate; execute clean-install ESM/CJS/declaration/CLI/JSDoc/documentation-example and frozen-schema smoke tests against that exact tarball; then perform maintainer-owned live, JSON/Markdown export, backup create/read, and custom-path verification using only that tarball and owner-private storage, retaining only an external non-repository attestation with revision/tarball hash/platform/capabilities, abstract operations, aggregate limit measurements, salted nonretained ID hashes, low-level event totals, modes/residue counts, and pass/fail; any validation, pack/checksum, clean-install, smoke, approval, or manual-stage failure must block publication, discard the candidate, return to the owning task, and rerun T112–T115 from the start; only a passing approval may publish the preserved bytes without rebuild/repack; delete raw artifacts, leave the tracked tree/revision unchanged, and prohibit raw repository/CI evidence using `tests/e2e/package-smoke.test.ts`, `tests/e2e/cli-json-schema.test.ts`, and `docs/release-verification.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 — Setup**: Starts immediately and changes test infrastructure only.
- **Phase 2 — Foundational Contracts**: Depends on Phase 1 and blocks production story work.
- **Phase 3 — US1**: Depends on Phase 2; locked projector/consumer and defensive-parsing evidence T011–T020 must precede T021–T029.
- **Phase 4 — US2**: Depends on US1's stable identity/fidelity projection. It establishes the minimal same-role equivalence/ambiguous-row path required by scoped index round-trip; T035 and T036 may proceed in parallel before catalog integration.
- **Phase 5 — US3**: Depends on US1 source classification and US2 bound/ambiguous logical rows. T054 establishes the shared `readWrite` capability preflight before the checkpoint and conservatively rejects every multi-locator target, so read-side equivalent-replica selection never grants mutation authority.
- **Phase 6 — US4**: Private-temp and driver-specific probe code may be prepared from Phase 2 in parallel, but T065's shared capability-type extension waits for US3 T054; phase completion serializes private-workspace recovery before backup/Store integration and serializes Store/migration/backup integration after the corresponding US1/US3 edits.
- **Phase 7 — US5**: Depends on US1 identity/fidelity and US2 metadata-only catalog/scope/equivalence primitives. It completes read-side reconciliation and provenance without changing US3's conservative mutation refusal.
- **Phase 8 — US6**: Depends on US2 lazy inventory/hydration; it may use US5 logical rows without retaining their payloads.
- **Phase 9 — US7**: US7 remains P1 and non-deferrable, but its integrated shipped contract depends on the selected P2 replica and memory contracts being frozen; this dependency-driven placement after US5/US6 does not lower its priority or permit release without it. Public formatting can begin after field names stabilize, but release/documentation completion depends on all selected stories. T091–T096 establish failing output/release contracts; T097–T100 then run in order across shared runtime/public surfaces. After T100, T101, T103, and T105–T109 may run in parallel; T102 depends on T101, and T104 depends on both T102 and T103.
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

- Serialize ownership of `src/core/storage.ts`, `src/core/store-stack/merge.ts`, `src/core/types.ts`, `src/core/database/index.ts`, `src/core/migrate.ts`, `src/cli/commands/migrate-session.ts`, `src/lib/types.ts`, `src/lib/index.ts`, `src/core/backup.ts`, `package.json`, `.github/workflows/npm-publish.yml`, `.github/pull_request_template.md`, and the shared compatibility/release test and documentation artifacts.
- Parallel markers do not authorize concurrent edits to one of these hotspots unless the owning task has already landed.

### Requirement Coverage

| Requirement or outcome | Owning tasks |
|---|---|
| FR-001: native UUID is the sole public logical session ID | T006, T021, T028, T041, T043, T082, T100, T110 |
| FR-002: physical identity is separate from logical identity | T006, T038–T040, T043, T046, T076, T079–T081, T100, T105 |
| FR-003: fixed interface-specific index bases and scopes | T006, T032–T034, T041, T043, T046, T048, T053, T099–T100, T105–T107 |
| FR-004: v0.16 Composer projection precedes merging | T002, T011–T015, T021, T110 |
| FR-005: native Composer message IDs remain unchanged | T012, T014–T017, T021, T023, T028, T110 |
| FR-006: null-ID Composer compatibility IDs remain unchanged | T002, T011–T015, T017, T021, T110 |
| FR-007: matched messages inherit Composer identity | T015, T018, T023, T110 |
| FR-008: Store synthetic identity and collision policy | T012, T015, T017, T021–T023, T110 |
| FR-009: occurrence and transcript canonical-input policy | T017, T021–T022, T110 |
| FR-010: stable tool identity and Composer tool ordering | T002, T015, T017–T018, T021, T023, T027–T028, T110 |
| FR-011: resolved relationship references | T002, T015, T017, T024, T028, T110 |
| FR-012: identity version and origin metadata | T006, T017, T021, T028, T100 |
| FR-013: semantic merge order remains independent of identity | T015, T018, T023, T110 |
| FR-014: move/copy UUID semantics | T049, T051, T055 |
| FR-015: compatibility source signal | T002, T015–T016, T026, T029, T105, T108 |
| FR-016: additive actual source provenance | T006, T013, T016, T026, T028, T100, T105 |
| FR-017: completeness-sensitive replacement projection | T002, T012, T015, T017–T018, T027, T029, T110 |
| FR-018: degraded data cannot overwrite complete data | T002, T015–T016, T019, T025–T026, T029, T110 |
| FR-019: replacement-safe producer and unchanged-consumer atomicity | T002, T015–T016, T029, T110 |
| FR-020: repeated synchronization is idempotent | T002, T015–T016, T029, T110 |
| FR-021: Store database/transcript backbone selection | T013, T016, T019, T022, T025, T078, T111 |
| FR-022: complete Store representation replacement boundary | T013, T016, T019, T021–T025, T029, T078, T110 |
| FR-023: failed/partial Store representation handling | T013, T015–T016, T019, T025–T027, T029, T071, T078, T110 |
| FR-024: deterministic timestamp shape and source anchor | T015–T016, T091, T097, T100, T110 |
| FR-025: timestamp provenance vocabulary and repeatability | T091, T097, T100, T110 |
| FR-026: inferred human timestamps are approximate | T091, T098, T105–T107 |
| FR-027: complete-view updates do not use a timestamp watermark | T002, T015–T016, T029, T110 |
| FR-028: older middle insertions remain present | T012, T015, T023, T029, T110 |
| FR-029: exact-first/unambiguous-suffix workspace matching | T030, T035, T047, T099, T105–T107 |
| FR-030: scoped membership and default payload-I/O boundary | T001, T004, T031–T033, T037–T040, T042, T045, T110–T111 |
| FR-031: metadata/payload read classification | T004, T031, T036–T039, T045, T110–T111 |
| FR-032: scoped numeric round-trip and stable-ID reload | T003, T032–T034, T038–T043, T048, T052–T053, T110 |
| FR-033: scoped content has the correct ID/path | T003, T032–T034, T040–T047, T110–T111 |
| FR-034: scope-limited results are explicitly partial | T006–T009, T031, T034, T039, T043, T047, T071, T079–T080, T100, T110 |
| FR-035: cross-workspace source loading is explicit | T031, T045, T099, T105 |
| FR-036: canonical/matched/source workspace-path fields | T006, T033–T034, T040, T043, T046, T081–T082, T100, T110 |
| FR-037: canonical path is stable across filter/preference | T033, T040, T043, T046, T081–T082, T110 |
| FR-038: workspace discovery/list counts agree | T001, T033, T038, T044, T111 |
| FR-039: structured numeric rows declare their scope | T006, T032, T034, T041, T043, T046, T096, T100, T105 |
| FR-040: live/backup/custom-path parity | T001, T032–T034, T111, T115 |
| FR-041: complementary sources remain merge contributors | T001, T018–T019, T033, T038–T039, T072–T078, T110–T111 |
| FR-042: versioned same-role equivalence contract | T010, T017–T019, T033, T039, T072–T078, T110 |
| FR-043: equivalent collapse and divergent ambiguity | T001, T033–T034, T038–T039, T043, T072–T082, T110–T111 |
| FR-044: ambiguous rows never hydrate or resolve silently | T007–T009, T033–T034, T039, T043, T047, T072, T079–T080, T110 |
| FR-045: opaque diagnostic occurrence references | T006–T010, T033, T039, T043, T048, T079, T100 |
| FR-046: migration consumes active workspace scope | T003, T032, T048, T050–T053, T110 |
| FR-047: preview/apply bind and revalidate one target | T048–T055, T110 |
| FR-048: divergent destructive targets are refused | T048–T055, T072, T079, T110 |
| FR-049: Store-only/merged migration is refused | T048, T054, T110 |
| FR-050: existing unambiguous migration remains compatible | T048–T055, T110 |
| FR-051: temporary plaintext privacy is platform-qualified | T004, T020, T057–T064, T110, T114–T115 |
| FR-052: temporary workspaces are unique/exclusive | T001, T057–T064, T110 |
| FR-053: exhaustive cleanup and conservative recovery | T003–T004, T057–T064, T110, T114–T115 |
| FR-054: final archives are private by default where supported | T057, T060, T069, T110, T114–T115 |
| FR-055: overwrite/parent permissions remain safe | T057, T060, T069, T110 |
| FR-056: provider selection probes requested capabilities | T056, T059, T065, T067–T068, T071, T095 |
| FR-057: automatic selection falls back to a capable provider | T056, T059, T065, T067–T068, T071, T095 |
| FR-058: forced incapable providers fail actionably | T007–T009, T056, T059, T065, T067–T068, T071 |
| FR-059: capability failures never become false partial success | T019, T025, T056, T059–T060, T064–T065, T067–T068, T071, T110 |
| FR-060: supported runtimes succeed or fail explicitly | T005, T056, T059, T065–T068, T094–T095, T103–T104, T114–T115 |
| FR-061: decoded-session retention is bounded by `C+A` | T006, T010, T083–T090, T110 |
| FR-062: bulk operations stream and release payloads | T031, T083, T085, T089–T090, T110 |
| FR-063: read context binds immutable source/scope | T006, T083–T089, T110 |
| FR-064: context misuse returns typed errors | T007–T009, T083–T089 |
| FR-065: rejected resolution remains retryable/isolated | T083–T090, T110 |
| FR-066: shipped JSDoc/help/docs and executable examples | T003, T034, T043, T093, T099–T100, T102, T105–T108, T115 |
| FR-067: complete changelog and upgrade warnings | T013, T092, T105, T108 |
| FR-068: actionable empty/ambiguity diagnostics | T007–T009, T030, T032, T034, T047, T079–T080, T099, T105 |
| FR-069: exact-artifact gates and actual manifest producer | T005, T060, T070, T093–T096, T101–T104, T114–T115 |
| FR-070: runtime capability-boundary validation | T005, T056, T059, T065, T094–T095, T103–T104, T114–T115 |
| FR-071: stable-return/source-fidelity review contract | T006, T010–T018, T021–T029, T033, T039–T040, T046, T081, T096, T100, T105, T109, T113 |
| FR-072: distributed end-to-end off-scope evidence | T003–T004, T031–T034, T037, T042–T047, T093, T111, T114–T115 |
| FR-073: locked v0.16/v0.17 backward-compatibility suite | T002, T011–T016, T021–T029, T110, T114 |
| FR-074: cross-source/layout/runtime validation fixture matrix | T001, T012–T020, T030–T034, T048–T050, T056–T060, T072–T075, T083–T085, T091–T096, T111, T114–T115 |
| FR-075: mutation-proven integrity/release gates | T004, T010, T015–T018, T030–T033, T048, T057, T083, T092–T095, T110 |
| FR-076: tool activity rendering and message filtering | T017–T018, T091, T098, T110–T111 |
| FR-077: v0.16 identity/completeness/idempotency faults | T002, T005, T012, T015, T017–T018, T021–T029, T110, T114 |
| FR-078: locked v0.17 corrective convergence | T013, T016, T023–T029, T092, T108, T110, T114–T115 |
| FR-079: unknown fields and deterministic UTF-8/BOM policy | T007–T009, T020, T022, T025, T105, T110 |
| FR-080: versioned bounded JSONL, SQLite, and ZIP source parsing | T004, T006–T009, T020, T022, T037, T060, T063, T069, T088, T099, T105, T110–T112, T114 |
| SC-001: v0.16 session/message/tool identities remain stable | T002, T011–T015, T017–T018, T021–T024, T027–T029, T110 |
| SC-002: upgraded complete replacement is lossless/idempotent | T002, T012, T015–T016, T023–T029, T110 |
| SC-003: scoped reads hydrate zero unrelated payloads | T001, T004, T031–T047, T110–T111 |
| SC-004: scoped indices round-trip without global regressions | T003, T032–T034, T038–T043, T046, T048, T052–T053, T110 |
| SC-005: ambiguity and ineligible migration stop before writes | T048–T055, T072, T079, T110 |
| SC-006: equivalent/divergent/complementary groups and logical pagination are honest | T034, T043, T072–T082, T110–T111 |
| SC-007: platform-qualified private artifacts and cleanup | T057–T064, T069, T110, T114–T115 |
| SC-008: capable driver or one actionable error | T056, T059, T065–T068, T071, T095, T110, T114–T115 |
| SC-009: context and Source Read Limits v1 boundaries hold | T020, T022, T063, T069, T083–T090, T105, T110, T112, T114 |
| SC-010: timestamps/provenance are deterministic and honest | T015–T016, T091, T097–T100, T110 |
| SC-011: shipped surfaces explain the compatibility contract | T093, T099–T100, T105–T108, T115 |
| SC-012: every validation and registered fatal path blocks exact-artifact publish | T005, T092–T096, T099, T101–T104, T114–T115 |
| SC-013: every `required` Compatibility Matrix v1 cell passes | T001, T004, T020, T030–T034, T048, T056–T060, T072–T075, T083–T085, T091–T096, T111, T114–T115 |
| SC-014: 100% of feature 016 public changes have evidence | T005, T109, T113, T115 |
| SC-015: structured tools remain visible/filterable | T017–T018, T091, T098, T110–T111 |
| SC-016: required suite catches specified v0.16 regressions | T002, T005, T011–T015, T017–T018, T021–T029, T110, T114 |
| SC-017: required suite proves v0.17 one-replacement convergence | T005, T013, T016, T023–T029, T092, T110, T114–T115 |

---

## Parallel Execution Examples

### User Story 1

After T011–T013 establish the oracle inputs, run T014, T015, T016, T017, and T018 in parallel, then complete T019–T020. Execute the implementation sequence T021–T029 in listed order so the frozen identity and parsing contracts precede merge, relationship, fidelity, and public projection work.

### User Story 2

Run T030–T034 in parallel as failing acceptance slices. Implement T035 workspace matching and T036 I/O observation in parallel, then integrate them sequentially through T037–T047.

### User Story 3

Run T048 and T049 in parallel, then complete built-CLI acceptance T050. Execute T051–T055 in listed order so the bound target precedes CLI/library plumbing and final refusal/revalidation logic.

### User Story 4

Run T056–T060 in parallel. Execute T061–T064 in listed order to finish private-temp recovery and integration, run capability preparations T065 and T066 in parallel, then execute T067–T071 in listed order for provider, driver, archive, manifest, and failure integration.

### User Story 5

Run T072–T075 in parallel. After T076 defines grouping/equivalence, serialize T077 Composer arbitration and T078 Store arbitration through the shared catalog hotspot before ambiguity/public projection work.

### User Story 6

Run T083–T085 in parallel. Then complete immutable construction T086, core retention T087, and public lifecycle mapping T088 in order before integrating bulk operations T089 and discovery counters T090.

### User Story 7

Run T091–T096 in parallel as failing release/output contracts. Execute T097–T100 in listed order because they share runtime, formatter, and public-declaration surfaces. Once T100 stabilizes the public graph, run T101, T103, and T105–T109 in parallel; complete T102 only after T101, then complete T104 only after T102 and T103.

---

## Implementation Strategy

### MVP First: Compatibility-Safe Upgrade

1. Complete Setup and Foundational Contracts.
2. Lock v0.16/v0.17 evidence before production changes.
3. Complete US1 and run its independent unchanged-consumer synchronization test.
4. Stop if any pre-existing Composer session/message/tool key changes or the third sync writes.

The MVP is **US1 only** because it prevents irreversible archive-key drift. It is not a release candidate until the remaining P1 security, scope, migration, shipped-contract, and fail-closed release-safety stories also pass; US7 cannot be deferred.

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
- Core/CLI indices remain one-based; public library read indices remain zero-based; public migration selectors remain one-based. These are documented interface contracts, not runtime boolean options, and numeric indices remain ephemeral within their listing scope.
- Public `Session.id` remains the native Cursor UUID; physical locators never become public IDs.
- The unchanged-consumer compatibility contract excludes standalone `codeBlocks` and tool `files`; semantically required evidence must be projected into consumed fields or mark the view partial. Cursor-history owns the complete replacement-safe view and signal; the unchanged consumer owns atomic persistence and rollback.
- Fatal JSON errors migrate from v0.17 legacy stream placement to `stderr` in this corrective release; for the same fixture every pre-existing field name/type/value and exit category remains stable while documented additive fields are allowed. Nonfatal results remain on `stdout`, and T092/T108 provide regression evidence and migration guidance.
- Owner-only mode assertions apply on permission-aware platforms. Windows coverage verifies system-temporary-directory ACL inheritance, exclusive creation, cleanup, and typed failure without claiming independently unverified cross-user isolation.
- The Matrix v1 table in `spec.md` is normative; `specs/016-harden-session-integrity/contracts/compatibility-matrix-v1.md` is its design projection and packaged `docs/compatibility.md` is its shipped projection. T111 fails on any row/cell drift in either, and new representations or carriers require an explicit matrix-version update.
- The constitution v1.2.0 amendment already exists; T109 enforces 100% feature 016 evidence coverage in review rather than redefining it.
