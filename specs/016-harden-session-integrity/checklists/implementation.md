# Implementation Revalidation Checklist: Session Integrity and Compatibility Hardening

**Purpose**: Revalidate item-level implementation evidence after post-audit corrective work and
before the exact-revision release gates
**Created**: 2026-08-12
**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Tasks**: [tasks.md](../tasks.md)

## Status: IN PROGRESS — Previous Freeze Invalidated

- The prior revision's preliminary required suite passed 1,452 of 1,452 executed tests; its single skip matched
  the checked allowlist. Typecheck, lint, formatting, and both module builds passed.
- Source Read Limits v1 policy drift and seven preflight tests passed on that prior revision. The authorized
  Composer-carrier preflight remained within every default and reported no exceeded field.
- The prior owner-private, no-sampling v0.16 differential covered 498 sessions, 5,832 messages, and
  666 tool calls. It evaluated 248,004 session identity pairs, 123,753 session-order pairs,
  68,024,448 message pairs, and 443,556 tool pairs.
- That exhaustive differential found zero duplicate, missing, ambiguous, reverse-unmatched, or
  cross-associated session/message/tool identities and zero ordering inversions.
- Every then-documented non-excepted v0.16 public value and own-property shape matched. The differences
  were 60 missing-source message timestamps, 81 missing-source session update values, and two
  pathless workspace sentinels; every occurrence satisfied its documented predicate and none
  changed an identity or content/relationship/tool binding.
- The prior one-time owner-authorized external pinned-consumer SQLite transition retained all 7,480 logical persisted
  rows; both candidate upgrade and repeated sync wrote zero rows and produced an identical logical
  database snapshot.
- Raw source, identifiers, paths, content, timestamps, databases, and stable derived hashes
  remain outside the repository. Recurring tests use only deterministic, input-free synthetic data.

Those observations are historical evidence only. Subsequent high-priority fixes changed runtime,
tests, package metadata, contracts, and release workflow behavior. Every `PASS` token in the tables
below records that prior run and is **not** current release approval. T116–T134 are now
implemented in the current tree; the reopened T110–T115 gates must complete from the corrected 0.18.0
revision before any table can be refrozen.

## Functional Requirement Traceability

The task IDs below are the owning implementation/test tasks in [tasks.md](../tasks.md). `PASS` means
the owning tasks are complete and their required test/document evidence passed the preliminary gate.

| Requirement | Owning tasks | Historical result (current gate is reopened) |
|---|---|---|
| FR-001 native UUID is the sole public logical session ID | T006, T021, T028, T041, T043, T082, T100, T110 | PASS |
| FR-002 physical identity is separate from logical identity | T006, T038–T040, T043, T046, T076, T079–T081, T100, T105, T117 | PASS |
| FR-003 fixed interface-specific index bases and scopes | T006, T032–T034, T041, T043, T046, T048, T053, T099–T100, T105–T107, T119, T124, T127 | PASS |
| FR-004 v0.16 Composer projection precedes merging | T002, T011–T015, T021, T110, T116, T125, T132 | PASS |
| FR-005 native Composer message IDs remain unchanged | T012, T014–T017, T021, T023, T028, T110, T116, T125, T132 | PASS |
| FR-006 null-ID Composer compatibility IDs remain unchanged | T002, T011–T015, T017, T021, T110, T116, T125, T132 | PASS |
| FR-007 matched messages inherit Composer identity | T015, T018, T023, T110, T116 | PASS |
| FR-008 Store synthetic identity and collision policy | T012, T015, T017, T021–T023, T110 | PASS |
| FR-009 occurrence and transcript canonical-input policy | T017, T021–T022, T110 | PASS |
| FR-010 stable tool identity and Composer tool ordering | T002, T015, T017–T018, T021, T023, T027–T028, T110, T116, T125, T132 | PASS |
| FR-011 resolved relationship references | T002, T015, T017, T024, T028, T110, T116 | PASS |
| FR-012 identity version and origin metadata | T006, T017, T021, T028, T100 | PASS |
| FR-013 semantic merge order remains independent of identity | T015, T018, T023, T110, T116 | PASS |
| FR-014 move/copy UUID semantics | T049, T051, T055 | PASS |
| FR-015 compatibility source signal | T002, T015–T016, T026, T029, T105, T108, T125 | PASS |
| FR-016 additive actual source provenance | T006, T013, T016, T026, T028, T100, T105 | PASS |
| FR-017 completeness-sensitive replacement projection | T002, T012, T015, T017–T018, T027, T029, T110, T116, T125, T132 | PASS |
| FR-018 degraded data cannot overwrite complete data | T002, T015–T016, T019, T025–T026, T029, T110, T132 | PASS |
| FR-019 replacement-safe producer and unchanged-consumer atomicity | T002, T015–T016, T029, T110, T113, T125, T132 | PASS |
| FR-020 repeated synchronization is idempotent | T002, T015–T016, T029, T110, T113, T132 | PASS |
| FR-021 Store database/transcript backbone selection and Required coexistence | T013, T016, T019, T022, T025, T078, T111, T122, T127–T128 | PASS |
| FR-022 complete Store representation replacement boundary | T013, T016, T019, T021–T025, T029, T078, T110 | PASS |
| FR-023 failed/partial Store representation handling | T013, T015–T016, T019, T025–T027, T029, T071, T078, T110 | PASS |
| FR-024 deterministic timestamp shape and source anchor | T015–T016, T091, T097, T100, T110 | PASS |
| FR-025 timestamp provenance vocabulary and repeatability | T091, T097, T100, T110 | PASS |
| FR-026 inferred human timestamps are approximate | T091, T098, T105–T107 | PASS |
| FR-027 complete-view updates do not use a timestamp watermark | T002, T015–T016, T029, T110 | PASS |
| FR-028 older middle insertions remain present | T012, T015, T023, T029, T110 | PASS |
| FR-029 exact-first/unambiguous-suffix workspace matching | T030, T035, T047, T099, T105–T107, T124 | PASS |
| FR-030 scoped membership and default payload-I/O boundary | T001, T004, T031–T033, T037–T040, T042, T045, T110–T111, T117, T122 | PASS |
| FR-031 metadata/payload read classification | T004, T031, T036–T039, T045, T110–T111, T122–T123 | PASS |
| FR-032 scoped numeric round-trip and stable-ID reload | T003, T032–T034, T038–T043, T048, T052–T053, T110, T117, T124 | PASS |
| FR-033 scoped content has the correct ID/path | T003, T032–T034, T040–T047, T110–T111, T117 | PASS |
| FR-034 scope-limited results are explicitly partial | T006–T009, T031, T034, T039, T043, T047, T071, T079–T080, T100, T110, T117, T122 | PASS |
| FR-035 cross-workspace source loading is explicit | T031, T045, T099, T105, T122 | PASS |
| FR-036 canonical/matched/source workspace-path fields | T006, T033–T034, T040, T043, T046, T081–T082, T100, T110, T117 | PASS |
| FR-037 canonical path is stable across filter/preference | T033, T040, T043, T046, T081–T082, T110, T117 | PASS |
| FR-038 workspace discovery/list counts agree | T001, T033, T038, T044, T111 | PASS |
| FR-039 structured numeric rows declare their scope | T006, T032, T034, T041, T043, T046, T096, T100, T105, T119, T127 | PASS |
| FR-040 live/backup/custom-path parity | T001, T032–T034, T111, T115, T122 | PASS pending exact-tarball repetition in T115 |
| FR-041 complementary sources remain merge contributors | T001, T018–T019, T033, T038–T039, T072–T078, T110–T111, T116, T122 | PASS |
| FR-042 versioned same-role equivalence contract | T010, T017–T019, T033, T039, T072–T078, T110 | PASS |
| FR-043 equivalent collapse and divergent ambiguity | T001, T033–T034, T038–T039, T043, T072–T082, T110–T111 | PASS |
| FR-044 ambiguous rows never hydrate or resolve silently | T007–T009, T033–T034, T039, T043, T047, T072, T079–T080, T110 | PASS |
| FR-045 opaque diagnostic occurrence references | T006–T010, T033, T039, T043, T048, T079, T100 | PASS |
| FR-046 migration consumes active workspace scope | T003, T032, T048, T050–T053, T110, T124, T127 | PASS |
| FR-047 preview/apply bind and revalidate one target | T048–T055, T110, T124 | PASS |
| FR-048 divergent destructive targets are refused | T048–T055, T072, T079, T110, T124 | PASS |
| FR-049 Store-only/merged migration is refused | T048, T054, T110, T124, T127 | PASS |
| FR-050 existing unambiguous migration remains compatible | T048–T055, T110, T124, T127 | PASS |
| FR-051 temporary plaintext privacy is platform-qualified | T004, T020, T057–T064, T110, T114–T115 | PASS pending exact-tarball repetition in T115 |
| FR-052 temporary workspaces are unique/exclusive | T001, T057–T064, T110 | PASS |
| FR-053 exhaustive cleanup and conservative recovery | T003–T004, T057–T064, T110, T114–T115, T121, T129–T131, T133 | PASS pending exact-tarball repetition in T115 |
| FR-054 final archives are private by default where supported | T057, T060, T069, T110, T114–T115, T121, T131 | PASS pending exact-tarball repetition in T115 |
| FR-055 overwrite/parent permissions and publication identity remain safe | T057, T060, T069, T110, T121, T127–T131 | REVALIDATION REQUIRED |
| FR-056 provider selection probes requested capabilities | T056, T059, T065, T067–T068, T071, T095 | PASS |
| FR-057 automatic selection falls back to a capable provider | T056, T059, T065, T067–T068, T071, T095 | PASS |
| FR-058 forced incapable providers fail actionably | T007–T009, T056, T059, T065, T067–T068, T071 | PASS |
| FR-059 capability failures never become false partial success | T019, T025, T056, T059–T060, T064–T065, T067–T068, T071, T110 | PASS |
| FR-060 supported runtimes succeed or fail explicitly | T005, T056, T059, T065–T068, T094–T095, T103–T104, T114–T115, T126–T127 | PASS for local runtime; matrix remains a release workflow gate |
| FR-061 decoded-session retention is bounded by `C+A` | T006, T010, T083–T090, T110 | PASS |
| FR-062 bulk operations stream and release payloads | T031, T083, T085, T089–T090, T110 | PASS |
| FR-063 read context binds immutable source/scope | T006, T083–T089, T110 | PASS |
| FR-064 context misuse returns typed errors | T007–T009, T083–T089 | PASS |
| FR-065 rejected resolution remains retryable/isolated | T083–T090, T110 | PASS |
| FR-066 shipped JSDoc/help/docs and executable examples | T003, T034, T043, T093, T099–T100, T102, T105–T108, T115, T126–T127, T134 | PASS pending exact-tarball repetition in T115 |
| FR-067 complete changelog and upgrade warnings | T013, T092, T105, T108, T118–T119, T127 | REVALIDATION REQUIRED |
| FR-068 actionable empty/ambiguity diagnostics | T007–T009, T030, T032, T034, T047, T079–T080, T099, T105 | PASS |
| FR-069 exact-artifact gates and actual manifest producer | T005, T060, T070, T093–T096, T101–T104, T114–T115, T123, T126–T127, T134 | PASS in contract tests; exact candidate remains T115 |
| FR-070 runtime capability-boundary validation | T005, T056, T059, T065, T094–T095, T103–T104, T114–T115, T126–T127 | PASS in workflow contract; hosted runtime matrix remains release gate |
| FR-071 stable-return/source-fidelity review contract | T006, T010–T018, T021–T029, T033, T039–T040, T046, T081, T096, T100, T105, T109, T113, T118–T119, T127–T128, T132–T134 | REVALIDATION REQUIRED |
| FR-072 distributed end-to-end off-scope evidence | T003–T004, T031–T034, T037, T042–T047, T093, T111, T114–T115 | PASS pending exact-tarball repetition in T115 |
| FR-073 locked v0.16/v0.17 backward-compatibility suite | T002, T011–T016, T021–T029, T110, T114, T125, T132 | PASS |
| FR-074 cross-source/layout/runtime validation fixture matrix | T001, T012–T020, T030–T034, T048–T050, T056–T060, T072–T075, T083–T085, T091–T096, T111, T114–T115, T122, T124, T126 | PASS pending hosted/exact-tarball repetition |
| FR-075 mutation-proven integrity/release gates | T004, T010, T015–T018, T030–T033, T048, T057, T083, T092–T095, T110, T123, T130–T134 | PASS |
| FR-076 tool activity rendering and message filtering | T017–T018, T091, T098, T110–T111 | PASS |
| FR-077 v0.16 identity/completeness/idempotency faults | T002, T005, T012, T015, T017–T018, T021–T029, T110, T114, T125, T132 | PASS |
| FR-078 locked v0.17 corrective convergence | T013, T016, T023–T029, T092, T108, T110, T114–T115 | PASS pending exact-tarball repetition in T115 |
| FR-079 unknown fields and deterministic UTF-8/BOM policy | T007–T009, T020, T022, T025, T105, T110 | PASS |
| FR-080 versioned bounded JSONL, SQLite, and ZIP source parsing | T004, T006–T009, T020, T022, T037, T060, T063, T069, T088, T099, T105, T110–T112, T114, T120 | PASS |
| FR-081 corrected complete-message public search coordinates | T118, T127–T128, T110, T113–T115 | REVALIDATION REQUIRED |
| FR-082 integrity-gated and confined restore publication | T127–T130, T110, T114–T115 | REVALIDATION REQUIRED |

## Success Criterion Traceability

| Criterion | Owning tasks | Historical result (current gate is reopened) |
|---|---|---|
| SC-001 v0.16 session/message/tool identities remain stable | T002, T011–T015, T017–T018, T021–T024, T027–T029, T110, T116, T125, T132 | PASS |
| SC-002 upgraded complete replacement is lossless/idempotent | T002, T012, T015–T016, T023–T029, T110, T113, T132 | PASS |
| SC-003 scoped reads hydrate zero unrelated payloads | T001, T004, T031–T047, T110–T111, T117, T122–T123 | PASS |
| SC-004 scoped indices round-trip without global regressions | T003, T032–T034, T038–T043, T046, T048, T052–T053, T110, T117, T119, T124, T127 | PASS |
| SC-005 ambiguity and ineligible migration stop before writes | T048–T055, T072, T079, T110, T124 | PASS |
| SC-006 equivalent/divergent/complementary groups and logical pagination are honest | T034, T043, T072–T082, T110–T111 | PASS |
| SC-007 platform-qualified private artifacts and cleanup | T057–T064, T069, T110, T114–T115, T121, T129–T131, T133 | PASS pending exact-tarball repetition |
| SC-008 capable driver or one actionable error | T056, T059, T065–T068, T071, T095, T110, T114–T115, T126 | PASS pending hosted matrix |
| SC-009 context and Source Read Limits v1 boundaries hold | T020, T022, T063, T069, T083–T090, T105, T110, T112, T114, T120 | PASS |
| SC-010 timestamps/provenance are deterministic and honest | T015–T016, T091, T097–T100, T110 | PASS |
| SC-011 shipped surfaces explain the compatibility contract | T093, T099–T100, T105–T108, T115, T126–T127, T134 | PASS pending exact-tarball repetition |
| SC-012 every validation and registered fatal path blocks exact-artifact publish | T005, T092–T096, T099, T101–T104, T114–T115, T123, T126–T127, T134 | PASS in contract/fault tests; protected release gate remains |
| SC-013 every `required` Compatibility Matrix v1 cell passes | T001, T004, T020, T030–T034, T048, T056–T060, T072–T075, T083–T085, T091–T096, T111, T114–T115, T122, T126–T127 | REVALIDATION REQUIRED |
| SC-014 100% of feature 016 public changes have evidence | T005, T109, T113, T115–T134 | REVALIDATION REQUIRED |
| SC-015 structured tools remain visible/filterable | T017–T018, T091, T098, T110–T111 | PASS |
| SC-016 required suite catches specified v0.16 regressions | T002, T005, T011–T015, T017–T018, T021–T029, T110, T114, T132 | PASS |
| SC-017 required suite proves v0.17 one-replacement convergence | T005, T013, T016, T023–T029, T092, T110, T114–T115 | PASS pending exact-tarball repetition |
| SC-018 search coordinates exactly identify complete returned data | T118, T127–T128, T110, T113–T115 | REVALIDATION REQUIRED |
| SC-019 post-publication permission failure reports final-path identity honestly | T121, T127–T128, T131, T110, T114–T115 | REVALIDATION REQUIRED |
| SC-020 corrupt or unsafe restore entries never reach a destination | T127–T130, T110, T114–T115 | REVALIDATION REQUIRED |

## Compatibility Matrix v1 Historical Result Map (Revalidation Required)

Executable matrix coverage is locked by
`tests/e2e/compatibility-matrix-contract.test.ts`, `tests/e2e/cli-session-integrity.test.ts`, and
`tests/helpers/session-integrity-fixtures.ts`. `Unsupported` means rejection passed; `N/A` means no
successful carrier fixture is permitted.

| Scenario | Live | Custom | Backup | Historical result |
|---|---|---|---|---|
| Composer global | PASS | PASS | PASS | Complete Composer |
| Composer workspace fallback | PASS | PASS | PASS | Degraded Composer fallback |
| Store database conversation | PASS | PASS | N/A | Complete Store database |
| Transcript with no discovered/expected database | PASS | PASS | N/A | Complete transcript primary |
| Transcript fallback after capable DB setup: expected DB absent, empty, or source-corrupt/unreadable | PASS | PASS | N/A | Degraded transcript fallback; capability/infrastructure failure remains fatal |
| Usable database coexists with transcript, all known occurrences permitted | PASS | PASS | N/A | Complete database backbone; transcript retained as superseded provenance |
| Scoped Store UUID has known DB/transcript occurrence outside boundary | REVALIDATION REQUIRED | REVALIDATION REQUIRED | N/A | Explicit partial; off-scope representation unopened |
| Complete merge, Composer-preferred | PASS | PASS | N/A | Complete merged, Composer-preferred |
| Complete merge, Store-preferred | PASS | PASS | N/A | Complete merged, Store-preferred |
| Scoped merge with contributor outside default boundary | PASS | PASS | N/A | Explicit partial |
| Scoped merge with selected-UUID cross-workspace opt-in | PASS | PASS | N/A | Complete and disclosed |
| Store metadata without usable payload | PASS | PASS | N/A | Metadata-only degraded row |
| Equivalent Composer replicas | PASS | PASS | PASS | One logical row |
| Divergent Composer replicas | PASS | PASS | PASS | One ambiguity row |
| Equivalent Store replicas | PASS | PASS | N/A | One logical row |
| Divergent Store replicas | PASS | PASS | N/A | One ambiguity row |
| Automatic union/selection of divergent replicas | REJECTED | REJECTED | REJECTED | Never silently resolved |

## Public Returned-Value Dispositions

| Public contract | Disposition | Evidence |
|---|---|---|
| `Session.id` | Preserved native Cursor UUID; locators remain separate | `tests/integration/session-integrity-faults.test.ts`, FR-001–FR-002 |
| Numeric indices | Existing per-interface bases preserved; additive scope metadata; v0.16 equal-time order restored | `tests/integration/workspace-index-roundtrip.test.ts`, `tests/unit/storage.test.ts` |
| Native Composer `Message.id` | Preserved byte-for-byte | `tests/compatibility/v016-composer-upgrade.test.ts` |
| Missing-ID Composer message key | Explicit `msg:<v0.16-index>` compatibility identity | `tests/compatibility/v016-fixture-safety.test.ts` |
| Store-only message identity | New versioned namespace; no public session-ID mutation | `tests/unit/store-stack-merge.test.ts`, identity contracts |
| Composer tool identity/order | Existing order and ordinal-derived keys preserved | v0.16 projector/consumer regressions |
| Relationship and branch references | Rewritten only through stable message identities | v0.16 merge and relationship fault tests |
| `source` | Legacy fidelity signal retained for unchanged-consumer replacement policy | Generic recurring complete/degraded contract plus owner-authorized external T113 certification |
| `resolvedSource`, `sources`, `resolution` | Additive actual provenance | library/CLI contract and schema tests |
| `workspace` and workspace paths | Real v0.16 spelling retained; additive canonical/matched/source paths | library compatibility and scoped-path tests |
| Pathless workspace placeholder | Versioned correction to public `"unknown"` / structured `null` | `tests/compatibility/v016-versioned-exceptions.test.ts` |
| Message timestamp | Direct source values retained; missing-source fallback is deterministic and labeled | timestamp provenance tests and versioned-exception mutations |
| `metadata.lastModified` | Stored update retained; missing-source read-time value is deterministically corrected | timestamp/session provenance tests and full-corpus source validation |
| Optional own-property/null/omission shape | v0.16 legacy fields retained; new provenance fields additive | `tests/compatibility/v016-fixture-safety.test.ts`, exhaustive differential |
| Set-like provenance arrays | Additive and canonically ordered | public API shape and replica-order tests |
| Ambiguity/partial diagnostics | Additive typed state; never a silently selected payload | replica reconciliation and CLI schema tests |
| Fatal CLI JSON stream | Explicit versioned stdout-to-stderr migration; locked fields/exit meaning retained | `tests/e2e/cli-json-schema.test.ts`, changelog warning |
| Migration selection/results | Existing eligible direct-ID/index behavior retained; unsafe targets are typed refusals | migration scope/preview/apply tests |

### Post-audit returned-value dispositions (current 0.18.0 scope)

| Public contract | Disposition | Affected released versions | Regression evidence | Migration note |
|---|---|---|---|---|
| Public search `messageIndex`, `offset`, `match`, `contextBefore`, `contextAfter` | Directly corrected under one versioned exception: complete returned message-array index, complete-content UTF-16 offset, and complete original lines; identities/non-search values unchanged | v0.16.0 and v0.17.0 | `tests/compatibility/fixtures/v017/search-coordinate-correction.json`, `tests/compatibility/v017-fixture-provenance.test.ts`, `tests/unit/lib-index.test.ts` | Recompute persisted search coordinates after upgrading to 0.18.0; do not treat them as content identities |
| Public-library JSON export `index` | Additive zero-based metadata consistent with public read APIs | None: tagged v0.16.0/v0.17.0 exports omitted the key | `tests/compatibility/v016-fixture-safety.test.ts`, `tests/compatibility/v017-fixture-provenance.test.ts`, `tests/unit/lib-index.test.ts` | Accept or ignore the new field; there is no released one-based value to translate |
| `BackupPublishedPermissionError.details` | Additive typed post-commit failure with `published: true`, `pathIdentityVerified`, final path, requested mode, last safely observed archive mode or `null`, and a conditional remedy; only a verified path is described as the published archive | None: new in v0.18.0 | `tests/unit/backup-publication.test.ts`, `tests/integration/backup-snapshot-security.test.ts`, CLI error tests | If verified, inspect/correct that archive; if unverified, treat the pathname as untrusted and do not chmod it from the error; never assume rollback or blindly force-retry |
| `BackupPublishedCleanupError.details` | Additive typed post-commit failure with `published: true`, independently verified final-path identity, verified residue paths, unverified residue paths, counts, and a conditional remedy; force rename abandons the old staging name, while non-force cleanup is device/inode-bound | None: new in v0.18.0 | `tests/unit/backup-archive-publication.test.ts`, `tests/integration/backup-snapshot-security.test.ts`, library/CLI error tests | Keep/inspect the output only when verified; delete only verified residue paths after confirming no operation is active; never blindly delete unverified paths or retry with `--force` |
| Coexisting DB/transcript `sourceInstances` | Required normal result: DB contributes backbone and transcript is `superseded` provenance | v0.17 did not expose the finalized provenance contract | Matrix/store-expectation live and custom carrier fixtures | No content union; consumers may ignore additive provenance, but must not reject the session as unsupported |
| Restore `filesRestored`/`warnings` and `RESTORE_ROLLBACK_INCOMPLETE` | Count only validated published entries; integrity-mismatched entries are skipped; empty/unmanifested inventories reject; hard-linked leaves are replaced without write-through; publication/rollback are committed-inode-bound; a concurrent destination replacement is left untouched and reported as a typed manifest-relative residual instead of a false zero-change result | v0.16.0 and v0.17.0 could warn yet restore corrupt bytes; typed rollback error is new in v0.18.0 | `tests/unit/restore-publication.test.ts` and `tests/integration/backup-snapshot-security.test.ts` mixed/all-corrupt, empty/unmanifested, hard-link, actual rollback, rollback-failure, concurrent-replacement, path/type/collision/duplicate/confinement fixtures | Treat warnings as skipped; on typed rollback failure stop Cursor, do not alter a concurrent replacement, and recover listed entries from a known-good backup |

## Reopened Gates

- [ ] Requirements and research contain no unresolved clarification or exception.
- [ ] `contracts/internal-resolution.md`, `contracts/library-api.md`, `contracts/cli-json.md`, and
  `contracts/compatibility-matrix-v1.md` agree with the runtime and public types.
- [ ] `quickstart.md`, `README.md`, localized documentation, `CHANGELOG.md`, and packaged
  `docs/compatibility.md` describe the same addressing, identity, timestamp, workspace, and upgrade
  contract.
- [ ] `.specify/memory/constitution.md` remains authoritative, including Stable Public Contracts and
  Source Fidelity; no implementation or release exception dilutes a MUST rule.
- [ ] `.github/pull_request_template.md` requires compatibility disposition, affected-version
  fixtures, regression evidence, migration notes, and source-fidelity review.
- [ ] The publish workflow is fail-closed and its manifest-producing runtime matrix, clean-install,
  test, build, pack-once, checksum, smoke, and protected-approval paths are contract tested.
- [ ] No raw private evidence or external vibe-history checkout is a recurring CI dependency.
- [ ] T114 confirms no copied proprietary third-party implementation or generated downstream
  database remains in reachable branch history; T132 establishes only the clean current tree.
- [ ] T112 and T113 have been rerun from the corrected 0.18.0 revision. T114 must run from the revision containing this checklist;
  T115 must preserve and verify one tarball from that exact revision before protected approval.

## Current Decision

The previous freeze is revoked. T116–T134, including artifact/ledger reconciliation T127–T128,
are implemented in the current tree; T110–T115 remain reopened. Neither freeze nor publication is approved until every
unchecked gate above is satisfied from one unchanged 0.18.0 revision and the checklist is
deliberately refrozen.
