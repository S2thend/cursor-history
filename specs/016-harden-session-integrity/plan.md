# Implementation Plan: Session Integrity and Compatibility Hardening

**Branch**: `016-harden-session-integrity` | **Date**: 2026-08-05 | **Spec**: [spec.md](/workspaces/patcomm/cursor-history/specs/016-harden-session-integrity/spec.md)<br>
**Input**: Feature specification from `/workspaces/patcomm/cursor-history/specs/016-harden-session-integrity/spec.md`

## Summary

Harden every session read and mutation path around one native logical session UUID while preserving
all v0.16 Composer-derived downstream keys. The implementation will build a metadata-only logical
session catalog, bind workspace and data-source scope before payload I/O, reconcile same-role
physical replicas, freeze Composer and Store identities before merge rendering, and expose fidelity,
provenance, paths, timestamp origin, and index scope as separate additive contracts. Complete views
continue to emit legacy `source: "global"` so an unchanged v0.16-compatible consumer performs its
existing atomic full-session replacement; degraded views emit `workspace-fallback` and cannot
overwrite complete data. cursor-history owns the complete replacement-safe projection and signal;
the unchanged vibe-history-compatible harness owns downstream persistence, transaction, and
rollback.

The same increment also binds destructive migration to an eligible Composer occurrence, centralizes
private temporary-file handling, selects SQLite drivers by required capability, bounds decoded
session retention, restores deterministic timestamp provenance, and applies conservative bounded
parsing to every changed Store/transcript/archive path. It also migrates every fatal JSON object to
stderr with a documented v0.17 script transition, ships tested public JSDoc/help/examples and a
versioned compatibility matrix, and makes the exact packed artifact pass all release gates before
publication.

## Technical Context

**Language/Version**: TypeScript 5.9.3 in strict mode; Node.js `>=20.0.0`; ES2022 and NodeNext ESM<br>
**Primary Dependencies**: Node standard library, Commander 14, JSZip 3.10, picocolors 1.1, better-sqlite3 v12 (no new runtime dependencies)<br>
**Storage**: Cursor Composer SQLite databases, Cursor Store `store.db`, Store JSONL transcripts, ZIP backup archives, and local filesystem metadata<br>
**Testing**: Vitest 4 unit/integration/compatibility/e2e tests, synthetic SQLite and JSZip fixtures,
built-CLI child-process tests, packed-package smoke tests, fault injection, and locked v0.16/v0.17
consumer baselines<br>
**Target Platform**: Linux, macOS, Windows, and WSL; permission-bit assertions are POSIX-specific
while uniqueness, system-user-temp/ACL inheritance, cleanup, and typed failures apply on every
platform; no unverified Windows cross-user-readability guarantee is made<br>
**Project Type**: Single TypeScript package exposing a CLI and direct-import public library<br>
**Performance Goals**: Metadata discovery remains linear in physical occurrences; scoped operations
hydrate zero unrelated payloads; ordinary read contexts retain at most `C=1` completed decoded
session plus active resolutions, while built-in bulk search/export use `C=0`; no decoded corpus is
retained solely by discovery<br>
**Constraints**: Preserve native IDs byte-for-byte; reproduce every v0.16 fallback Composer key;
keep existing JSON envelopes and library return types; require no vibe-history change for the
confirmed v0.16 Composer-only upgrade; keep Node 20 support; default workspace reads to payload I/O
isolation; default plaintext artifacts to owner-only where the platform exposes enforceable
permission controls; accept UTF-8 with optional BOM without guessing invalid/mixed encodings; never
guess a destructive target; send successful results to stdout and all fatal errors to stderr<br>
**Scale/Scope**: All CLI/library list, show, search, export, backup, and session-migration paths over
live data, supported backup layouts, and custom data roots; corpora with duplicate UUIDs, multiple
workspace memberships, complementary Composer/Store sources, and concurrent readers

## Constitution Check

*GATE: Passed before Phase 0 research and re-checked after Phase 1 design. No constitutional
exception remains.*

| Principle | Pre-research gate | Post-design evidence |
|-----------|-------------------|----------------------|
| I. Simplicity First | PASS | No new runtime package; focused core helpers replace repeated identity, catalog, scope, I/O-observation, source-limit, bounded-archive, and private-temp logic. The narrow ZIP32/ZIP64 STORE/DEFLATE stream adapter is justified because whole-buffer JSZip extraction cannot satisfy the constitution's bounded-memory rule at compatibility-safe archive limits. Metadata discovery and payload hydration are separated only because privacy and memory requirements demand it. |
| II. CLI-Native Design | PASS | New opt-ins are explicit long flags with help examples. Successful output remains on stdout and existing human-readable fatal output remains on stderr; every fatal JSON object moves to stderr. Locked fixtures preserve every pre-existing JSON error field name/type/value and exit category while permitting documented additive fields; the shipped v0.17 warning/migration fixture documents only the intentional fatal-JSON stream transition. |
| III. Documentation-Driven | PASS | Every symbol reachable from the exact packed package-root declaration graph receives contract JSDoc, including aliases and re-exports; every command/option receives complete help; README/library examples are executable/typechecked tests; compatibility docs, localized guidance, changelog history, v0.17 warning, and corrective-release migration guidance are package-smoke inputs. |
| IV. Incremental Delivery | PASS | The design orders executable compatibility baselines before identity changes, then catalog/scope, mutation, security/runtime, and release surfaces. Each stage has an independently runnable regression gate. |
| V. Defensive Parsing | PASS | Changed parsers accept UTF-8 with optional BOM, ignore unknown fields, reject invalid/mixed encodings through typed partial/fatal outcomes without heuristic transcoding, and enforce JSONL/SQLite/ZIP entry and aggregate bounds. Malformed source data yields explicit partial fidelity where recoverable; infrastructure/capability failures remain typed failures. Discovery is metadata-only and decoded retention is bounded. |
| VI. Stable Public Contracts and Source Fidelity | PASS | Native UUIDs/IDs are untouched, the tagged v0.16 projector is the identity oracle, synthetic IDs are deterministic and versioned before merge, fidelity is separate from provenance, v0.16/v0.17 transitions are release-blocking, and existing public shapes change additively. Privacy-safe manual testing on maintainer-owned real Cursor live/export/backup data is a recorded release gate. |

Technical standards also pass: the design keeps strict TypeScript, Node 20+, Vitest, minimal
dependencies, and core logic independent from CLI formatting.

## Project Structure

### Documentation (this feature)

```text
specs/016-harden-session-integrity/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   ├── cli-json.md
│   ├── compatibility-matrix-v1.md
│   ├── internal-resolution.md
│   ├── library-api.md
│   └── session-output.schema.json
└── checklists/
    ├── implementation.md
    └── requirements.md
```

`tasks.md` is the executable, dependency-ordered implementation inventory.

### Source Code (repository root)

```text
src/
├── core/
│   ├── session-identity.ts       # new: frozen message/tool identities and canonical hashes
│   ├── session-catalog.ts        # new: metadata inventory, logical grouping, replicas, selection
│   ├── workspace-scope.ts        # new: historical-path normalization and deterministic matching
│   ├── private-temp.ts           # new: owner-only staging and exhaustive cleanup
│   ├── io-observer.ts            # new: low-level filesystem/database boundary instrumentation
│   ├── source-read-limits.ts     # new: v1 defaults, override validation, counters, typed details
│   ├── zip-stream.ts             # new: bounded ZIP32/ZIP64 central metadata and entry streams
│   ├── errors.ts                 # new: typed scope/session/migration/temp failures
│   ├── index.ts                  # core public exports and JSDoc boundary
│   ├── storage.ts                # resolution orchestration and bounded read contexts
│   ├── types.ts                  # core session/context/diagnostic declarations
│   ├── parser.ts                 # public/export serialization and timestamp provenance
│   ├── migrate.ts                # prepare, revalidate, then apply a bound Composer target
│   ├── backup.ts                 # secure archive creation/extraction and manifest version
│   ├── database/
│   │   ├── index.ts              # public driver preference compatibility entry point
│   │   ├── types.ts              # operation capability profiles
│   │   ├── registry.ts           # per-operation capable-provider selection
│   │   ├── errors.ts
│   │   └── drivers/
│   │       ├── node-sqlite.ts
│   │       └── better-sqlite3.ts
│   └── store-stack/
│       ├── discover.ts           # metadata inventory separated from selected hydration
│       ├── store-db.ts           # leaf hashes/order, private snapshot, explicit failure fidelity
│       ├── transcript.ts         # line-order canonical identity input
│       ├── merge.ts              # orientation-stable alignment and preferred-source rendering
│       └── types.ts
├── cli/
│   ├── index.ts
│   ├── errors.ts
│   ├── commands/
│   │   ├── session-lookup.ts
│   │   ├── migrate-session.ts
│   │   ├── migrate.ts
│   │   ├── list.ts
│   │   ├── show.ts
│   │   ├── search.ts
│   │   ├── export.ts
│   │   ├── backup.ts
│   │   ├── restore.ts
│   │   └── list-backups.ts
│   └── formatters/
│       ├── json.ts
│       └── table.ts
└── lib/
    ├── config.ts
    ├── errors.ts
    ├── index.ts
    ├── types.ts
    ├── backup.ts
    └── utils.ts

tests/
├── helpers/
│   ├── contract-assertions.ts
│   ├── io-probe.ts
│   ├── run-cli.ts
│   ├── session-integrity-fixtures.ts
│   └── v016-consumer.ts
├── compatibility/
│   ├── fixtures/
│   │   ├── v016/
│   │   │   ├── composer-global-state.vscdb # deterministic synthetic raw-layout fixture
│   │   │   ├── projector-manifest.json
│   │   │   ├── vibe-history-consumer-manifest.json # pinned revision/source blobs/schema assumptions
│   │   │   ├── fixture-manifest.json       # logical inventory/generation/hash/privacy record
│   │   │   ├── workspace-fallback.json
│   │   │   ├── tagged-output.json
│   │   │   ├── legacy-consumer-archive.sqlite # pinned vibe-history schema, synthetic data only
│   │   │   └── merged-store-source.json
│   │   └── v017/
│   │       ├── provenance.json
│   │       ├── complete-merged.json
│   │       ├── degraded-store.json
│   │       ├── transcript-complete.json
│   │       ├── store-db-complete.json
│   │       └── cli-fatal-output.json
│   ├── support/generate-v016-fixtures.ts
│   ├── support/v016-projector.ts
│   ├── v016-fixture-safety.test.ts
│   ├── v016-projector-provenance.test.ts
│   ├── v016-consumer-provenance.test.ts
│   ├── v016-composer-upgrade.test.ts
│   └── v017-convergence.test.ts
├── e2e/
│   ├── cli-session-integrity.test.ts
│   ├── cli-fatal-json.test.ts
│   ├── cli-json-schema.test.ts
│   ├── compatibility-matrix-contract.test.ts
│   ├── package-smoke.test.ts
│   └── publish-workflow.test.ts
├── integration/
│   ├── workspace-index-roundtrip.test.ts
│   ├── workspace-io-boundary.test.ts
│   ├── session-replica-reconciliation.test.ts
│   ├── session-integrity-faults.test.ts
│   ├── store-expectation-state.test.ts
│   ├── defensive-source-parsing.test.ts
│   ├── store-stack-dedup.test.ts
│   ├── composer-source-arbitration.test.ts
│   ├── drivers.test.ts
│   ├── migrate-session-scope.test.ts
│   ├── backup-snapshot-security.test.ts
│   ├── private-temp-signal-recovery.test.ts
│   └── read-context-bounds.test.ts
└── unit/
    ├── backup.test.ts
    ├── cli-commands.test.ts
    ├── cli-errors.test.ts
    ├── cli-formatters-json.test.ts
    ├── cli-formatters-table.test.ts
    ├── filter.test.ts
    ├── lib-backup.test.ts
    ├── lib-errors.test.ts
    ├── lib-index.test.ts
    ├── message-identity.test.ts
    ├── migrate.test.ts
    ├── parser.test.ts
    ├── preflight-source-limits.test.ts
    ├── session-replica-equivalence.test.ts
    ├── storage-context.test.ts
    ├── store-stack-discover.test.ts
    ├── store-stack-merge.test.ts
    ├── store-stack-store-db.test.ts
    ├── verify-test-results.test.ts
    ├── workspace-scope.test.ts
    └── database-capabilities.test.ts

scripts/
├── build-cjs.mjs                   # create the advertised CommonJS tree/wrapper with TypeScript
├── preflight-source-limits.mjs     # metadata-only private archive/default compatibility check
└── verify-test-results.mjs         # reject zero tests, failures, and unexpected skips

.github/workflows/npm-publish.yml
.github/pull_request_template.md
package.json
package-lock.json
vitest.config.ts
tsconfig.cjs.json
README.md
docs/readme_es.md
docs/readme_fr.md
docs/readme_zh.md
docs/compatibility.md
docs/release-verification.md
CHANGELOG.md
CLAUDE.md
specs/016-harden-session-integrity/checklists/implementation.md
.specify/memory/constitution.md       # existing v1.2.0 compatibility amendment retained
```

**Structure Decision**: Keep the existing single-package architecture. Core owns identity,
resolution, storage, and typed failures; the library maps core values without re-resolving indices;
the CLI only binds options and formats results. Feature-specific helpers are added where one policy
is shared across several existing modules, rather than creating a new package or service layer.

The fail-closed publish workflow, exact-artifact verification, upgrade warning, and shipped
compatibility contract in US7 are mandatory P1 release gates for this corrective release. They are
not polish that may be deferred after implementation. Their integrated completion is scheduled
after the selected P2 replica and memory stories only because the shipped contract and exact
artifact must describe and verify those finalized behaviors; dependency order does not lower US7's
priority or permit publication without it.

## Implementation Strategy

### 1. Lock released behavior before changing resolution

- Vendor a provenance-recorded, test-only port of the exact cursor-history `v0.16.0` projector at
  commit `e8a7abf8cea3419a9dda911e174a05f82a9b260e`, including global row ordering,
  placeholder/malformed-message behavior, and all tagged workspace parser branches. Fixtures
  validate the port; they do not define it. Run its output through the minimal unchanged
  vibe-history identity, digest, parent, and atomic-replacement harness pinned to
  `S2thend/vibe-history` revision `698701775144f7d8875330e1f8caec9ddfc27744`. Record the copied
  adapter/type/digest/policy/engine/SQLite-target/schema source paths and Git blob hashes plus the
  archive schema/migration assumptions in a checked-in manifest, and make conformance tests reject
  vendored-consumer drift without consulting a live adjacent repository. Execute the pinned
  replacement statements against a real deterministic SQLite archive, inject a failure between
  deletion and insertion, reopen it, and accept only complete old-or-new state.
- Lock representative v0.17 complete Store/merged output separately. Its test promises one
  replacement and convergence, not preservation of unstable Store positional IDs.
- Make both suites part of the ordinary `npm test` command and prove they fail under identity,
  source-fidelity, tool-order, append-only, and idempotency fault injections.

### 2. Establish stable identities and orientation-independent merge plans

- Reproduce the exact v0.16 Composer-only emitted message sequence, preserving every nonempty
  native ID and assigning `msg:<zero-based-v0.16-index>` before filtering or Store alignment can
  affect order.
- Retain Store DB leaf hashes/traversal order and transcript line order/canonical inputs. Compute
  representation-local candidates and occurrences before alignment; allocate collision suffixes
  only to unmatched Store messages after Composer matches are known.
- Compute alignment in a fixed Composer-to-Store orientation, then render the same plan using the
  preferred source for scalar/content conflicts. A matched pair always uses the Composer identity.
- Preserve Composer tool-call positions, append unmatched Store calls deterministically, retain
  native tool-call IDs when exposed, and synthesize versioned tool identities for calls without one;
  every resolved runtime/JSON call has a nonempty ID and origin while declaration fields stay
  optional only for source compatibility.
  Match calls in fixed Composer-to-Store passes: exact native ID/name, then exact name/canonical
  `params`, then name-only only when one side lacks `params`; use one-to-one native occurrence order
  and never match differing present `params`. Standalone `files` never affect compatibility pairing
  or equivalence; project semantically required file evidence into a consumed field or mark partial.
- Do not add a standalone attachment field that the unchanged compatibility consumer would ignore.
  Losslessly project supported attachment evidence into message `content` (including fenced code)
  or the tool-call name/status/params/result/error fields consumed by the unchanged adapter; a
  standalone code-block/files field is insufficient. Mark any unrepresentable raw attachment block
  partial and never dereference an external target merely to parse or compare it.
- Rebuild parent/branch/leaf relationships from resolved IDs. Keep Composer-only
  `activeBranchBubbleIds` byte-identical; for merged output, populate it with the resolved stable
  active-message sequence for the unchanged consumer and expose `activeBranchMessageIds` as the
  clearer additive alias.

### 3. Separate logical catalog discovery from permitted payload hydration

- Discover only safe metadata and source-instance locators first; do not parse previews, bubbles,
  transcript lines, Store leaves, tools, or attachments during global membership discovery.
- Group physical instances by native UUID and source role. Reconcile permitted Composer-global
  occurrences first; a usable global is the primary content source and Composer-workspace contributes
  membership only, while workspace content is a partial fallback only when no usable permitted
  global exists. Compare replicas only within the same fidelity tier.
- Classify Store DB expectation as `expected`, `not-expected`, or `unknown` from DB presence and
  explicit metadata before hydration. Apply the complete/partial/fatal DB/transcript state machine
  before comparing same-tier Store replicas; never call a transcript complete when an expected or
  unknown DB is absent/unusable.
- Collapse equivalent replicas under equivalence contract v1 while retaining occurrence
  provenance. Represent divergent groups as one ambiguous summary; never hydrate or resolve them
  through a normal read path.
- Canonically order every new set-like output array: fixed enum order for roles/reasons, normalized
  code-point path order for memberships and each source instance's `workspacePaths`, and
  role/representation/paths/state order for source instances. Keep semantic message, branch, tool,
  and code-block arrays in their resolved/source-native order.
- Resolve workspace paths by normalized exact match, otherwise one full-component suffix. Bind the
  full matched path and content boundary before any payload access.
- Preserve the deterministic v0.16 Composer canonical path independently from filter and merge
  preference. A Store cwd may be canonical only for Store-only sessions.
- Default scoped hydration to matching contributors. An explicitly bound
  `includeCrossWorkspaceSources` option may broaden reads only for UUIDs already selected by the
  scope and must disclose every broadened source.
- Route real filesystem opens/reads, SQLite opens/queries, and key/value reads through shared testable
  adapters. SQLite statement preparation and online backup emit the same operation-context-bound
  audit events. Release tests combine these automatic events with off-scope poison payloads;
  resolver self-reporting alone is not accepted as proof of isolation.

### 4. Bind addressing and mutation once

- Make list rows carry a bound logical selection. Numeric follow-up uses that selection's UUID and
  occurrence set, never another numeric lookup; scoped direct IDs verify membership.
- Add the message-free, zero-based public `listSessionSummaries()` catalog API so equivalent and
  divergent UUID groups each occupy one addressable row without changing `listSessions()`' released
  full-session return type.
- Add `indexScope` and workspace-only `indexWorkspacePath` to every reusable structured index while
  retaining core/CLI one-based behavior, public-library read APIs' zero-based behavior, and the
  library migration configuration's documented one-based behavior.
- Replace migration's string-ID rediscovery with an internal `BoundMigrationTarget`. Prepare and
  validate the eligible single Composer occurrence, source/destination, fingerprint, and database
  capabilities before the first write; dry-run and apply share the same preparation.
- Treat replica reconciliation as read-only evidence, not mutation authority. Migration requires
  exactly one Composer locator with a mutation footprint confined to the bound source workspace;
  equivalent duplicate locators or a shared global record affecting other memberships are rejected
  rather than selecting the read representative.
- Reject divergent, Store-only, and merged targets, including workspace-wide flows that would move
  only a Composer half. Revalidate the bound locator/fingerprint immediately before mutation.

### 5. Make resource and failure boundaries explicit

- Construct read contexts from immutable data source, backup, normalized workspace,
  cross-workspace opt-in, diagnostics sink, optional `AbortSignal`, low-level audit observer, and
  cache capacity. Propagate that operation context through filesystem, key/value, SQLite prepare,
  query, and backup adapters. Coalesce in-flight reads separately, retain completed sessions in an
  LRU of default `C=1`, use `C=0` for bulk operations, evict rejections, and dispose in `finally`.
- Centralize the exact inclusive `source-read-limits/v1` defaults specified in `spec.md`: JSONL
  record/source/count; SQLite keyset-page rows/bytes, value, row, and decoded totals; and ZIP
  compressed-container, central-directory count, entry, aggregate, and ratio. Copy and freeze any
  validated explicit per-operation override; never source limits from globals, environment, input,
  or manifests and never retry automatically at a higher value. Decode JSONL incrementally from raw
  bytes, iterate SQLite metadata pages and fetch admitted payloads sequentially, and replace
  whole-container/entry ZIP materialization with central-directory preflight plus bounded streaming.
  Reset counters per transcript, logical-session hydration/separate catalog scan, or archive as
  specified. Return typed partial/fatal diagnostics according to whether a safe complete contributor
  remains.
- Implement the archive boundary in a focused Node-20-compatible `zip-stream.ts` adapter using
  bounded filesystem ranges and streams: validate ZIP32/ZIP64 central records and safe normalized
  entry names, support the existing backup contract's STORE and DEFLATE methods, reject encryption
  or unknown methods, stream CRC/checksum verification and extraction, and never expose partially
  materialized archive content as valid. Keep JSZip only where its streaming creation path can
  consume file streams and emit a file stream without aggregate buffers; it is not the trusted
  extraction/preflight boundary.
- Derive session creation/update times only from valid stored Composer metadata, then Store DB/meta
  for Store-only sessions, then direct message extrema, and finally a fixed epoch marked
  `epoch-unknown`; expose session-time provenance. Fill missing message timestamps from direct source
  neighbors, then only a deterministic non-unknown session time, otherwise epoch/`unknown`. Preserve
  an existing legacy timestamp with unprovable origin as `unknown` without using it as an inference
  anchor. Never use wall-clock or filesystem times.
- Centralize sensitive staging in an exclusive private directory (`0700` where supported), with
  exclusive files (`0600`), idempotent all-artifact cleanup, and typed residue reporting. Use it for
  backup creation/extraction and Store snapshots.
- Register active private workspaces for graceful `SIGINT`/`SIGTERM`/`SIGHUP` cleanup and cooperative
  cancellation. Mark each workspace with owner/pid/process-start/version metadata and conservatively
  recover only proven-dead, current-owner stale directories on the next operation; document that
  `SIGKILL` and power loss cannot guarantee immediate cleanup.
- Stage final archives privately and publish only a complete archive. New archives are `0600` by
  default; force-overwrite never broadens existing permissions; broader access requires `--shared`
  or the additive library option.
- Select a SQLite provider per requested `read`, `readWrite`, and `onlineBackup` capabilities.
  Automatic mode falls back; an explicit incapable choice yields one actionable typed error.
  Preserve synchronous `setDriver(): void` by recording preference synchronously and validating it
  at the next awaited database operation.

### 6. Finish public surfaces and release evidence

- Keep the released `source` TypeScript literals as deprecated transition inputs, but emit only
  `global` for complete/replacement-safe views and `workspace-fallback` for partial views. Expose
  actual representation and completeness through additive fields. Expose deterministic
  `createdAtSource`/`lastUpdatedAtSource` alongside session times and freeze them in schema and
  compatibility tests.
- Preserve library array/string return shapes. Deliver continuation diagnostics through a callback;
  without one, a public operation that cannot safely continue throws a typed error. Existing CLI
  JSON envelopes may add a `diagnostics` member.
- Freeze pathless compatibility as library `workspace: "unknown"` versus core/CLI JSON
  `workspacePath: null`. Keep existing human-readable fatal output on stderr and migrate every fatal
  JSON object to stderr. For each locked fixture,
  preserve every pre-existing error field name/type/value and exit-category meaning while allowing
  documented additive fields; do not assert whole-object byte equality after additions. Lock the
  intentional v0.17 stdout-to-stderr change with built-CLI fixtures, and ship a warning plus script
  migration example.
- Render structured tool calls on error/thinking messages and classify filters by actual message
  category. Mark inferred human timestamps as approximate.
- Ship CHANGELOG and compatibility documentation, correct the backup manifest producer version,
  and provide comprehensive help/empty-result/ambiguity guidance. The producer is the exact running
  package version, old manifests remain readable, and producer metadata never participates in
  session/message identity, replica equivalence, or incremental deduplication.
- Audit the exact packed package-root declaration graph and add contract JSDoc to every reachable
  symbol, including aliases and re-exports; add full help for every command/option; execute CLI
  examples against the built artifact while typechecking and running library examples.
- Treat the Matrix v1 table in `spec.md` as the sole normative finite release contract and
  `contracts/compatibility-matrix-v1.md` as its design-time projection. The package ships a second
  verified projection in `docs/compatibility.md`; an automated drift test must compare every
  row/cell in both projections to the specification. Every `Required` cell must pass,
  `Unsupported` cells must fail with the documented typed outcome, and `N/A` cells are excluded by
  rationale. The current backup carrier is Composer-only.
- Produce a real CommonJS artifact for the already-advertised `require` export using a second
  TypeScript output tree plus a small generated `.cjs` wrapper, without adding a bundler dependency.
  Before repository freeze, run the metadata-only authorized source-limit preflight and relock every
  affected artifact if a legitimate source exceeds a default. Then freeze all tracked evidence and
  run the unconditional final automated gates. The staged release workflow packs once from that
  exact revision, preserves the checksum-addressed candidate, clean-installs and smokes its ESM,
  CJS, CLI, declarations, schema, JSDoc, and examples, then pauses for the privacy-safe
  maintainer-owned live/export/backup/custom-path gate. Any automated or manual failure discards the
  candidate and restarts the preflight-through-pack sequence; only a passing protected approval may
  publish those exact bytes without rebuild, repack, or tracked-file changes.

## Validation Matrix

| Area | Required evidence |
|------|-------------------|
| v0.16 compatibility | Native and missing Composer IDs, old tool ordinals, Store insertions at start/middle, both preferred sources, enrichment/parent/tool changes, supported attachment evidence projected into message content or consumed tool-call fields, ignored standalone attachment/code-block/tool-file fields, collisions, atomic replacement, third-sync no-op |
| v0.17 convergence | Locked complete Store/merged baselines converge through one full replacement, produce no duplicate logical content, preserve native Composer IDs, then no-op; degraded transition explicitly excluded |
| Workspace/I/O | Conflicting A/B global and scoped order; exact and unique-suffix matches; ambiguity before payload open; low-level adapter events plus poison canaries prove zero off-scope payload reads; opt-in disclosure; live/backup/custom paths |
| Replicas | Composer global-primary/workspace-fallback arbitration; equivalent and divergent same-tier occurrences; complementary cross-role merge; every Store DB expectation/availability/transcript state; stable set-like array order; unsupported raw attachments force partial fidelity; one logical result/diagnostic per UUID |
| Migration | Scoped numeric dry-run/apply same bound occurrence; direct/unfiltered compatibility for eligible Composer targets; equivalent multi-locator/shared-membership, divergent, Store-only, and merged rejection before writes; revalidation race |
| Security | Real POSIX `umask 000` mode checks and owner-only containment; Windows per-user temp/inherited-ACL, uniqueness, cleanup, and typed-failure checks without an unverified cross-user claim; success/failure/close/cleanup injection, concurrent private directories, graceful-signal cleanup, SIGKILL residue containment and next-run stale recovery, final archive permissions |
| Defensive parsing | UTF-8 and leading BOM, ignored unknown fields, typed invalid/mixed-encoding outcomes, below/equal/above every Source Read Limits v1 field, invalid/per-operation override behavior, JSONL and SQLite counter resets, ZIP compressed/entry/count/aggregate/ratio rejection, no automatic raise, and bounded cancellation cleanup |
| SQLite | Importable `node:sqlite` without backup, automatic fallback, explicit-driver error, config propagation, no false partial Store result |
| Runtime | Node 20.0.0 project-compatibility floor (upstream EOL); 22.15.1 and 22.16.0 capability boundary; current 24.x LTS; latest 26.x Current release; deterministic simulated capability profiles |
| Memory/lifecycle | Get-before-list and list-before-get equivalence, scope conflict before I/O, in-flight coalescing, rejected retry, `N`/`2N` within `C+A`, bulk `C=0`, disposal |
| Release | Typecheck/lint/test/build failures, zero tests, skip, timeout, or cancellation block publish; exact tarball ESM/CJS/CLI/type/JSDoc/help/example/schema smoke and checksum identity; fatal JSON is on stderr with locked object/exit compatibility and migration warning; producer version matches the running artifact; privacy-safe recorded manual checks on maintainer-owned real Cursor live/export/backup data |

The authoritative finite source/carrier coverage and exclusions are defined by the Matrix v1 table
in [`spec.md`](spec.md). Packaged `docs/compatibility.md` and design-time
[`contracts/compatibility-matrix-v1.md`](contracts/compatibility-matrix-v1.md) are verified
projections; every row/cell in both must match the specification. Every cell marked `Required` is a
release gate; implementation capability discovery cannot shrink that matrix.

## Requirement Traceability

| Specification range | Primary design location | Verification location |
|---------------------|-------------------------|-----------------------|
| FR-001–FR-014: logical/message/tool identity and relationships | `research.md` §§1–4; `data-model.md` §§1, 7–9; identity/internal contracts | Quickstart §§2, 11, 12 |
| FR-015–FR-023: fidelity, provenance, replacement, Store representation | `research.md` §§5–6; resolved-session/library contracts | Quickstart §§2–3 |
| FR-024–FR-028: deterministic timestamp provenance and complete-view updates | `research.md` §13; public session/message provenance model and JSON/library contracts | Quickstart §§2, 11 |
| FR-029–FR-040: workspace matching, payload boundary, paths, scoped indices and additive summaries | `research.md` §§7, 9–10; catalog/scope/library/CLI contracts | Quickstart §§4–5 |
| FR-041–FR-045: source roles, equivalent/divergent replicas, diagnostics | `research.md` §8; replica and ambiguous-summary models | Quickstart §6 |
| FR-046–FR-050: bound destructive migration | `research.md` §11; migration model/internal/library/CLI contracts | Quickstart §7 |
| FR-051–FR-055: private temp data and final archives | `research.md` §14; private-temp/backup models | Quickstart §8 |
| FR-056–FR-060: capability-aware SQLite and Node support | `research.md` §§15–16; database capability contract | Quickstart §9 |
| FR-061–FR-065: bounded, order-independent read contexts | `research.md` §12; read-context model/internal contract | Quickstart §10 |
| FR-066–FR-075: shipped docs/JSDoc/examples, producer metadata, release gates, compatibility/fault evidence | `research.md` §§14, 16–18; package/library/CLI contracts | Quickstart §§12–14 |
| FR-076–FR-078: tool rendering and locked v0.16/v0.17 regressions | merge/render contracts and compatibility oracle | Quickstart §§2–3, 11–12 |
| FR-079–FR-080: encoding forward compatibility and bounded source parsing | `research.md` §19; parser/internal contracts | Quickstart §12 |

## Complexity Tracking

No constitutional violation or exception is carried by this design. All new helpers centralize
already repeated cross-cutting invariants and remain inside the existing core.
