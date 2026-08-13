# Quickstart: Validate Session Integrity and Compatibility Hardening

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

**Repository**: `/workspaces/patcomm/cursor-history`<br>
**Branch**: `016-harden-session-integrity`

This is the post-implementation verification path. A release candidate is not ready unless every
applicable section passes. Applicability is fixed by the normative specification and its design-time
contract projection at
[`contracts/compatibility-matrix-v1.md`](contracts/compatibility-matrix-v1.md), not discovered from
the implementation under test. The exact packed artifact must also contain the identical shipped
projection in `docs/compatibility.md`. The examples use absolute paths and the built CLI.

## 1. Required local gate

```bash
cd /workspaces/patcomm/cursor-history
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Expected:

- all commands exit 0;
- Vitest collects a nonzero number of tests and runs both locked compatibility suites;
- no required suite is skipped unexpectedly;
- `dist/lib/index.js`, `dist/lib/index.cjs`, `dist/lib/index.d.ts`, and
  `dist/cli/index.js` exist after build.

## 2. Locked v0.16 archive upgrade

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/compatibility/v016-projector-provenance.test.ts
npx vitest run tests/compatibility/v016-consumer-provenance.test.ts
npx vitest run tests/compatibility/v016-fixture-safety.test.ts
npx vitest run tests/compatibility/v016-composer-upgrade.test.ts
```

The cursor-history compatibility oracle is the released `v0.16.0` tag at commit
`e8a7abf8cea3419a9dda911e174a05f82a9b260e`, not a golden file produced by the
current implementation. The projector-provenance test must:

- verify the tag resolves to that exact commit and that the cursor-history-owned test projector records the
  tag, commit, relevant source paths, and source-blob hashes;
- exercise both tagged global projection and tagged workspace-fallback parser branches, including
  SQLite `rowid ASC`, placeholders, inclusion/filtering, branch handling, and bubble-ID selection;
- run the tagged projection through the generic cursor-history-owned downstream model and verify
  stable session/message/tool keys and their content/relationship/tool bindings, complete replacement
  eligibility, degraded non-overwrite, and repeated-input idempotence;
- verify the external-consumer reference records the owner-authorized upstream revision and declares
  that exact third-party adapter, digest, policy, SQLite transaction, rollback, and repeat-sync
  behavior are excluded from recurring CI and owned by release-blocking T113;
- compare the test projector against independently captured tagged-source results and fail if
  either the provenance or behavior drifts; and
- treat locked raw databases/JSON and expected-output fixtures as validation cases only. Fixtures
  MUST NOT define, regenerate, or silently update the projector algorithm.

Recurring CI MUST NOT copy, vendor, emulate, or execute a third-party adapter, digest, policy,
SQLite schema/transaction, rollback, or downstream archive. Before release, T113 uses the
owner-authorized external checkout at the recorded revision to run those exact behaviors: import the
v0.16 view, apply the complete candidate, force a mid-transaction failure and reopen the database,
retry successfully, then repeat synchronization and require zero writes. The no-consumer-change
guarantee is not approved until T113 passes.

The committed raw-layout SQLite fixture is generated deterministically from wholly synthetic
values. Its manifest records reproducible generation instructions, logical content, and SHA-256;
the required fixture-safety test regenerates the logical definition and scans every committed
fixture on every run, rejecting real user messages, paths, machine identifiers, credentials,
emails, and copied Cursor UUIDs. Synthetic Cursor-shaped identifiers are allowed only when declared
by the manifest.

Changing a fixture to agree with current code is therefore insufficient to approve an identity
change. Any intentional oracle update requires a new compatibility version and explicit transition
contract.

The fixture must contain:

- one native Cursor session UUID;
- native-ID and null/empty-ID Composer messages;
- multiple existing Composer tool calls;
- a Store-only turn at the start and another in the middle;
- matched Store enrichment;
- parent/branch/leaf changes;
- both preferred merge-source settings;
- a synthetic Store collision.

The recurring test imports the locked v0.16 Composer output through the generic downstream contract,
resolves the upgraded complete merge, applies it, then repeats the same input. It must prove:

- every old downstream session/message/tool key is byte-for-byte unchanged;
- native Composer IDs are unchanged;
- fallback Composer IDs still use the v0.16 zero-based Composer-only projection;
- matched messages use Composer IDs under both preferred sources;
- old Composer tool order is unchanged;
- new messages, enrichment, tools, and resolved parent/leaf data are present exactly once;
- incoming legacy `source` is `global` for the complete view;
- cursor-history emits one complete replacement-safe projection and compatibility signal;
- the next unchanged generic application performs zero writes.

T113 separately proves the unchanged external consumer's exact key/digest comparison and real
SQLite replacement/rollback/reopen/retry/repeat-sync behavior. Repository results must not be
described as proving that external transaction.

## 3. Locked v0.17 convergence

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/compatibility/v017-convergence.test.ts
```

Expected:

- each locked complete v0.17 Store/merged fixture converges through one complete replacement;
- one native UUID remains one logical session;
- native Composer identities are correct;
- unstable v0.17 Store positional/cross-format IDs are not asserted as preserved;
- no logical content is duplicated;
- the next unchanged sync performs zero writes;
- degraded v0.17 fixtures produce the documented pin/retry diagnostic and never overwrite a
  complete stored view.

## 4. Real workspace A/B CLI round trip

The integration fixture must be built under an isolated absolute root such as
`/tmp/cursor-history-016-workspace-fixture` with:

- global index 1: newer session B in workspace B, containing only `needle-b`;
- global index 2: older session A in workspace A, containing only `needle-a`;
- scoped workspace-A index 1: session A;
- at least one shared UUID with an off-scope complementary contributor;
- low-level payload-I/O instrumentation and poison canaries.

After `npm run build`:

```bash
node /workspaces/patcomm/cursor-history/dist/cli/index.js \
  --json \
  --data-path /tmp/cursor-history-016-workspace-fixture \
  --workspace /fixtures/workspace-a \
  list --all

node /workspaces/patcomm/cursor-history/dist/cli/index.js \
  --json \
  --data-path /tmp/cursor-history-016-workspace-fixture \
  --workspace /fixtures/workspace-a \
  show 1

node /workspaces/patcomm/cursor-history/dist/cli/index.js \
  --json \
  --data-path /tmp/cursor-history-016-workspace-fixture \
  --workspace /fixtures/workspace-a \
  search needle-a

node /workspaces/patcomm/cursor-history/dist/cli/index.js \
  --json \
  --data-path /tmp/cursor-history-016-workspace-fixture \
  --workspace /fixtures/workspace-a \
  search needle-b

node /workspaces/patcomm/cursor-history/dist/cli/index.js \
  --json \
  --data-path /tmp/cursor-history-016-workspace-fixture \
  --workspace /fixtures/workspace-a \
  export 1 --format json --output /tmp/cursor-history-016-export/session-a.json
```

Expected:

- scoped list/show/export all identify A with index 1;
- each reusable index says `indexScope: "workspace"` and carries the full workspace-A path;
- `needle-a` is found with A's native ID and canonical/matched paths;
- `needle-b` has no match;
- B produces zero conversation-payload open/decode events;
- a known off-scope contributor makes the default view partial and visible;
- every source occurrence exposes all of its memberships through deterministically ordered
  `workspacePaths`, without collapsing a multi-membership global occurrence to one path;
- rerunning show with `--include-cross-workspace-sources` may complete only the already selected UUID
  and discloses the broadened source path.

Isolation evidence must be collected below the resolver. Instrument the real filesystem open/read,
SQLite open/prepare/query/backup, and key/value-read adapters with one propagated operation-context
identity, physical source instance, operation, table/key class, and `catalog-metadata` versus
`conversation-payload` classification. The same context carries its optional `AbortSignal` through
nested Store/backup operations. Install
workspace-B transcript lines, DB rows, Store blobs, and key/value entries that throw a distinctive
poison-canary error on any attempted payload touch. The test passes only when the low-level event log
contains zero off-scope payload events and no poison canary fires. Result-only assertions or a
resolver-level observer are not sufficient evidence. Exact and ambiguous workspace matching must
also finish before any candidate payload query.

Run the automated form:

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/e2e/cli-session-integrity.test.ts
npx vitest run tests/integration/workspace-io-boundary.test.ts
```

## 5. Workspace matching and ambiguity

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/unit/workspace-scope.test.ts
```

Cover separator/dot/trailing-separator normalization, drive/WSL forms, platform case behavior,
historical nonexistent paths, exact-over-suffix precedence, component-boundary suffixes, unique
suffix success, and multiple-suffix failure before payload I/O. Empty diagnostics must show the
normalized request and explain how to list valid workspaces.

## 6. Replica reconciliation

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/integration/session-replica-reconciliation.test.ts
```

Expected:

- equivalent same-role replicas produce one logical list row, one search result set, and one export;
- all equivalent occurrence provenance is retained;
- divergent replicas produce one ambiguous row/diagnostic and no contested payload;
- `listSessionSummaries()` returns one message-free, zero-based row for each equivalent or divergent
  logical group while existing `listSessions()` retains its full-session return type and pagination
  compatibility;
- direct UUID and reused row index return the same typed ambiguity;
- complementary Composer plus selected Store data still merges;
- Store DB remains primary and transcript remains fallback;
- physical paths/locators never alter UUID or equivalence and never appear in normal output.

Run the Store expectation and Composer arbitration matrices explicitly:

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/integration/store-expectation-state.test.ts
npx vitest run tests/integration/composer-source-arbitration.test.ts
```

The `StoreDbExpectation` is fixed from metadata before payload hydration:

| Expectation | DB outcome | Transcript outcome | Required result |
|---|---|---|---|
| `expected` | usable and complete | any, with all known relevant Store occurrences permitted | complete `store-db`, legacy `source: "global"`; transcript is `superseded` provenance |
| any | usable in the selected scope | a known DB or transcript occurrence is outside the default I/O boundary | explicit partial Store view; off-scope representation is omitted and never opened, even if normally `superseded` |
| `expected` | usable but partial | any | partial `store-db`, `source: "workspace-fallback"`; transcript does not replace it |
| `expected` | missing, empty, or source-corrupt/unreadable after capable provider and snapshot/read setup | usable | degraded `store-transcript`, `source: "workspace-fallback"`, with expected-DB reason |
| `expected` | provider-selection, capability, snapshot-setup, or other DB infrastructure failure | any | one fatal typed error; no transcript fallback and no empty/partial success |
| `not-expected` | absent | complete | complete `store-transcript`, `source: "global"` |
| `not-expected` | absent | incomplete | degraded `store-transcript`, `source: "workspace-fallback"` |
| `not-expected` | absent | present but unusable/corrupt | degraded `store-metadata`, `source: "workspace-fallback"`; the transcript file is positive conversation evidence |
| `unknown` | absent | usable | degraded `store-transcript`, `source: "workspace-fallback"` |
| any state with evidence a conversation may exist | no usable payload | none | degraded metadata-only row with reason, not a fabricated empty complete session |
| explicit `hasConversation: false` with no positive DB/transcript evidence | absent | none | omit the non-conversation metadata row |

Composer arbitration must independently prove:

- permitted usable Composer-global data is the high-fidelity content primary; Composer-workspace
  records add membership/provenance but do not overwrite its payload;
- a global record and workspace encoding are complementary tiers, not divergent replicas merely
  because their payloads differ;
- equivalent or divergent candidates are reconciled only against candidates in the same permitted
  global tier; one global record referenced by multiple memberships remains one physical occurrence;
- Composer-workspace content is used only when no permitted usable global exists, is always partial,
  and carries a stable missing/source-corrupt fallback reason;
- a database capability or snapshot-infrastructure failure is fatal rather than a workspace
  fallback; and
- under scope, only permitted same-tier instances are compared. Known off-scope instances stay
  unopened and make the view partial unless the explicit related-source opt-in was used.

## 7. Scoped destructive migration

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/integration/migrate-session-scope.test.ts
```

Then inspect a dry-run against the A/B fixture:

```bash
node /workspaces/patcomm/cursor-history/dist/cli/index.js \
  --json \
  --data-path /tmp/cursor-history-016-workspace-fixture \
  --workspace /fixtures/workspace-a \
  migrate-session 1 /fixtures/destination --dry-run
```

Expected:

- the preview binds A's exact eligible Composer occurrence;
- execution revalidates that occurrence and cannot switch to global index 1/B;
- direct unfiltered eligible Composer ID and numeric behavior remain compatible;
- the numeric catalog includes ambiguous rows in their displayed positions; selecting one by index
  or UUID returns the same typed ambiguity and zero writes, without shifting later indices;
- a changed fingerprint fails before any write;
- equivalent multiple Composer locators and a global record shared with another membership are
  rejected rather than selecting the read representative;
- divergent, Store-only, and merged sessions fail in both preview/execution before source or
  destination writes;
- move retains UUID and copy receives a new UUID.

## 8. Snapshot/archive security

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/unit/backup-publication.test.ts
npx vitest run tests/integration/backup-snapshot-security.test.ts
```

On POSIX the test runs a child process under `umask 000` and observes artifacts while open:

- each operation directory is unique and mode `0700`;
- every plaintext DB/staging file is mode `0600`;
- newly created final archive is `0600` by default;
- `--shared` affects only the final archive;
- parent directory mode is unchanged;
- force-overwrite does not broaden an existing archive unexpectedly;
- rename/link is the publication commit point; a later injected mode failure keeps a valid readable
  archive inode and raises `BACKUP_PUBLISHED_PERMISSION_FAILED` with `published: true`,
  `pathIdentityVerified`, requested mode, and the last safely observed archive-inode mode or `null`;
- a true identity flag proves `outputPath` still names that inode and permits inspect/correct mode
  advice; a false flag makes the path untrusted, never reports a replacement-path mode, and requires
  identity recovery before the user modifies anything;
- the post-publication failure exits nonzero, leaves no unpublished staging residue, never claims
  rollback or recommends blind `--force`, and a matching published mode causes zero `chmod` calls;
- after a non-force link commit, private sibling cleanup verifies the published device/inode before
  unlinking; exhausted or unverifiable cleanup raises `BACKUP_PUBLISHED_CLEANUP_FAILED` with
  `published: true`, output `pathIdentityVerified`, verified `residuePaths`, and
  `unverifiedResiduePaths`, never touches a replacement occupant, and never recommends blind delete,
  chmod, or force retry;
- permission handling uses a no-follow open, lossless device/inode match to the private staging
  archive, descriptor-only chmod, and final descriptor/path revalidation; injected replacement and
  nonregular-path races fail without changing the replacement mode;
- mixed-validity restore publishes only entries whose manifest size and checksum pass, reports each
  size or checksum mismatch as skipped, and leaves its existing destination unchanged with and
  without force; empty/no-intact archives and unmanifested non-directory entries are rejected before
  destination mutation;
- manifest type/path mismatches, duplicate destinations, any initial non-force collision in the
  complete validated destination set, and symlink/path-indirection escapes fail before the first
  publication;
- every admitted payload is copied into a private same-directory inode; force atomically replaces
  the directory entry without writing through an existing hard link, while non-force atomically
  no-clobbers a destination that appears after preflight;
- rollback revalidates the device/inode recorded at each publication commit before touching its
  destination and republishes prior bytes through the same private-inode replacement path; a
  concurrently replaced leaf remains untouched, and an injected incomplete rollback throws
  `RESTORE_ROLLBACK_INCOMPLETE` with only safe manifest-relative residuals instead of returning
  `filesRestored: 0`;
- the selected user root is canonicalized and descendants are rechecked before each publication; tests
  prove static leaf-link rejection and unchanged sibling hard links but do not claim to eliminate a
  hostile concurrent ancestor swap in an owner-controlled tree on Node 20, which lacks a portable
  directory-relative no-follow creation primitive;
- ZIP parse, snapshot, DB open, parse, close, and cleanup failure injections attempt all cleanup;
- successful/failing/concurrent runs leave zero plaintext residue;
- a forced removal failure returns `TEMPORARY_ARTIFACT_CLEANUP_FAILED` with paths but no content.

The security suite must also exercise process termination in dedicated child processes, never by
signaling the Vitest worker itself:

- pause after a private directory and plaintext snapshot exist, send `SIGINT`, `SIGTERM`, and
  `SIGHUP` separately, and verify the coordinated handler attempts every registered cleanup before
  preserving signal termination semantics;
- verify normal `AbortSignal` cancellation reaches the same nested `finally` cleanup path;
- send `SIGKILL` to a child after artifact creation and verify immediate cleanup is not falsely
  claimed: any residue remains inside a current-owner `0700` directory with `0600` files and a valid
  private marker;
- start the next operation and verify conservative stale recovery removes that directory only after
  checking the exact application prefix, marker version, current owner, and, on Linux, matching
  readable PID-namespace tokens before PID/process-start evidence proves the owner process dead;
- inject a different Linux PID-namespace token while reusing a locally meaningful numeric PID and a
  mismatched start token, and verify the directory is retained as owner-status-uncertain; likewise
  retain a legacy Linux marker without namespace identity; and
- include malformed namespace/other markers, live-owner markers, wrong-owner candidates where
  testable, and symlink traps. Uncertain or unrelated paths must remain untouched and must never be
  followed recursively.

The catchable-signal children must leave zero plaintext residue. The `SIGKILL` child must demonstrate
privacy containment followed by next-run recovery, not an impossible immediate-cleanup guarantee.

Windows skips POSIX mode-bit and independently verified cross-user-isolation assertions. It still
verifies use of the system per-user temporary location and inherited access controls, uniqueness,
exclusive creation, cleanup, no collision/path reuse, and typed failures.

## 9. SQLite capability boundaries

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/unit/database-capabilities.test.ts
npx vitest run tests/integration/drivers.test.ts
```

Required simulated profile:

- `node:sqlite` imports and supports reads but has no `backup` function;
- `better-sqlite3` supports read plus online backup;
- auto read may choose node:sqlite;
- auto Store/backup snapshot chooses the capable fallback;
- explicitly forced node:sqlite throws `DATABASE_CAPABILITY_MISSING` with remedy;
- `LibraryConfig.sqliteDriver` reaches selection;
- capability failure never returns a successful zero-message or false partial Store session;
- `setDriver(): void` remains synchronous and the next awaited operation observes the forced choice.

CI runs source-level install/typecheck/lint/full tests/build on Node 24.x, because the Vite 7
development toolchain requires Node 20.19+. It then installs the same checksum-addressed packed
candidate as a production dependency without repository development dependencies and exercises it on Node 20.0.0,
22.15.1/22.16.0, 23.7.0/23.8.0, 24.x, 25.x, and 26.x. The runtime smoke observes automatic backup
provider selection and forced `node:sqlite` unavailable/missing/supported outcomes. Those jobs do
not run repository development scripts, but package installation may still build a native runtime
dependency and require its platform compiler/toolchain. Node 20 is
upstream EOL but remains the explicit project floor; Node 21 is not part of the advertised
`20.x || 22.x || 23.x || 24.x || 25.x || 26.x` contract. The 24 LTS and 26 Current labels are
release-date facts for v0.18.0, not an evergreen alias for a different major.

## 10. Read-context order and memory

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/integration/read-context-bounds.test.ts
```

Expected:

- get-before-list equals list-before-get;
- a conflicting source/scope fails before payload I/O;
- concurrent same-key resolution coalesces as one active read;
- a rejected resolution is removed and a retry can succeed;
- ordinary contexts retain at most `C=1` completed session plus active `A`;
- bulk search/export use `C=0` and release each completed payload;
- instrumented `N` and `2N` corpora never exceed `C+A` context-owned decoded sessions;
- eager Store discovery retains no decoded conversation corpus;
- disposal leaves zero context-owned decoded sessions.

## 11. Timestamp and message rendering

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/unit/message-identity.test.ts
npx vitest run tests/unit/cli-formatters-json.test.ts
npx vitest run tests/unit/cli-formatters-table.test.ts
npx vitest run tests/unit/filter.test.ts
```

Verify direct timestamp tokens are unchanged; missing values use next direct, previous direct,
session fallback, then fixed epoch/unknown; identical input is byte-deterministic; no wall-clock read
time appears. Human output marks inferred time approximate. Error/thinking messages remain selected
by their real type and render all structured tool calls.

Run the locked public search-coordinate correction and library export-index regressions:

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/compatibility/v017-fixture-provenance.test.ts
npx vitest run tests/unit/lib-index.test.ts
```

For tagged v0.16/v0.17, verify the locked legacy search result used placeholder
`messageIndex: 0`, a snippet-relative `offset`, and an ellipsized `match`. For 0.18.0, verify the
existing fields directly report the zero-based complete `session.messages` position, the first
case-insensitive match's zero-based UTF-16 offset in complete original content, and the complete
original line plus bounded complete neighboring lines. Cover non-first/multiline/mixed-case,
astral-character, and lowercase-expansion inputs; compare every session/message/tool identity and
non-search value unchanged. Consumers that persisted v0.16/v0.17 search coordinates must recompute
them after upgrade.

Also assert single and bulk public-library JSON export add the same zero-based `index` without
mutating the source object. Tagged v0.16/v0.17 exports omitted this field; do not treat it as a
released one-based-value migration.

Session-level timestamp provenance is part of the same deterministic test. Assert
`createdAtSource`/`lastUpdatedAtSource` use valid Composer metadata first for Composer-backed views;
Store DB metadata then Store metadata for Store-only views; earliest/latest direct message time next;
and Unix epoch with `epoch-unknown` last. An `epoch-unknown` session time cannot anchor a message's
`session-fallback`. Repeat under different fake wall clocks, preferred merge backbones, workspace
filters, and discovery orders; the session and message timestamp/provenance pairs must remain
byte-for-byte equal. Install a wall-clock poison that fails on `Date.now()` or a zero-argument
`new Date()` in projection/fallback code so the assertion cannot pass accidentally.

Tool alignment must cover duplicate and near-duplicate calls. Within an already aligned message,
match in a fixed Composer-to-Store orientation using: exact nonempty native call ID plus exact name;
then exact name/canonical `params`; then name-only only when one candidate lacks `params`. Every pass
is stable one-to-one: earliest unmatched Composer call pairs with the
earliest unmatched Store call, and repeated identical candidates resolve by native occurrence order.
Calls with differing present `params` never match; status/result/error/duration enrichment and
standalone `files` do not participate in compatibility matching or replica equivalence. Include a
pair that differs only in standalone `files` and assert it still occupies one Composer slot rather
than appending an extra Store call; if that file evidence cannot first be projected into a consumed
field, assert partial fidelity. Matched calls retain their Composer slots, duplicate Composer order
never changes, and unmatched Store calls append in Store-native order. Every resolved runtime/JSON
call must have a nonempty native or `tool:v1:*` ID and matching origin; the optional TypeScript
declaration exists only for source compatibility.

Attachment coverage uses evidence that can be represented losslessly in message `content`
(including fenced code) or consumed tool-call `name`, `status`, `params`, `result`, and `error`
fields, plus a raw image/URI block that cannot. Assert supported evidence is projected
deterministically into those unchanged-consumer fields and participates in replacement
digests/replica equivalence. Also assert that standalone cursor-history `codeBlocks`,
`ToolCall.files`, or a new attachment member are insufficient because the unchanged adapter ignores
them. The unrepresentable block must mark the source partial and prevent legacy
`source: "global"`. Arm the external URI as a poison target and prove it is never opened merely for
parsing, identity, or comparison.

Repeat serialization under reversed discovery order. Source-role/reason arrays must use declaration
order; memberships and each source instance's `workspacePaths` must use normalized code-point order;
source instances must use role/representation/paths/state order; and diagnostic refs must use stable
fingerprint order. Semantic message/branch/tool/code-block arrays retain semantic order.

## 12. Fault-injection proof

First run the carrier and public-override suites together:

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run \
  tests/integration/defensive-source-parsing.test.ts \
  tests/integration/backup-snapshot-security.test.ts \
  tests/unit/lib-index.test.ts \
  tests/e2e/cli-fatal-json.test.ts
```

It must cover UTF-8, one optional leading UTF-8 BOM, ignored unknown fields/columns, deterministic
typed invalid/mixed-encoding outcomes, and below/equal/first-unit-above cases for every inclusive
`source-read-limits/v1` default: the defensive-source suite owns JSONL `67_108_864`-byte record,
`4_294_967_296`-byte source, and `2_000_000` records; SQLite `256`-row/`268_435_456`-byte page,
`134_217_728`-byte value, `5_000_000` rows, and `8_589_934_592` decoded bytes; backup security owns
ZIP `17_179_869_184`-byte compressed container, `65_536` central records, `8_589_934_592`-byte entry,
`17_179_869_184`-byte aggregate, and `200:1` entry/aggregate ratio. Generate sparse or
bounded-stream fixtures rather than committing giant files.

The tests verify raw-byte accounting, JSONL per-transcript resets, SQLite keyset-page/sequential
payload reads and per-session/separate-catalog resets, while backup security owns ZIP metadata
preflight plus streamed output rechecks. The library and built-CLI suites cover immutable
per-operation overrides for every applicable public read command, unknown/duplicate fields, every
syntax/cross-field/runtime error before payload I/O, no global/environment/input/manifest override,
no automatic retry at a higher bound, and identity independence. No exceeded limit is accepted as a
truncated complete result. Partial is allowed only when a documented safe contributor remains;
every fatal case is singular, actionable, and leaves no temporary plaintext residue. Cancellation
between bounded units uses the same `AbortSignal` and cleanup path.

The standard suite must include deliberately activated faults and assert that its guard tests fail
for each one:

- reload a summary by numeric index instead of bound UUID;
- return a wrong session ID or workspace path;
- hydrate workspace-B payload under workspace A;
- bypass low-level instrumentation while a workspace-B transcript, DB row, key/value entry, or Store
  blob poison canary is armed;
- let preferred Store identity replace a matched Composer ID;
- assign null-ID Composer fallback after merge insertion;
- reorder old Composer tools;
- emit `source: "merged"` for a complete compatibility view;
- use timestamp watermark/append-only update for a middle insertion;
- leak a sensitive temp artifact;
- retain more than `C+A` decoded sessions;
- allow publish after a required command fails or zero tests are collected.

This may use an internal fault switch or injected pure dependencies; it does not require a new
mutation-testing runtime package.

## 13. Packed-artifact smoke and publication gate

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/e2e/package-smoke.test.ts
npm pack --json
```

The automated release workflow must:

1. verify the tag equals `package.json` version;
2. run source `npm ci`, typecheck, lint, the complete nonempty test suite, and build on Node 24,
   whose runtime satisfies the development toolchain;
3. fail on nonzero commands, zero tests, unexpected skip, timeout, or cancellation;
4. bind tag, revision, package version, tarball path, and a directly computed trusted SHA-256, then
   pack exactly once;
5. install only that checksum-addressed tarball as a production dependency without repository
   development dependencies on Node 20.0.0,
   22.15.1, 22.16.0, 23.7.0, 23.8.0, 24.x, 25.x, and 26.x and assert the automatic/forced SQLite
   capability outcome at each boundary; run no repository development script there, while allowing
   ordinary native dependency installation to use a compiler/toolchain when the platform requires it;
6. run the full clean-install ESM import, CommonJS `require`, public declaration/JSDoc, CLI,
   documentation-example, frozen-schema, real SQLite backup, and fixture smoke on Node 24 against
   those exact bytes;
7. verify README, LICENSE, CHANGELOG, localized documentation/logo, and canonical compatibility
   documentation are included;
8. make protected approval depend on both source/full-package gates and every runtime-candidate job;
9. publish the preserved checksum-addressed tarball bytes without rebuilding or repacking.

The smoke must also confirm a newly created backup manifest reports the exact packed artifact's
package version rather than the historical hard-coded `0.9.2`, that locked old/absent producer
metadata remains readable, and that changing only `producer` changes no identity, equivalence,
deduplication, or incremental-sync result.

Structured list/show/search/export fixtures are validated against
`/workspaces/patcomm/cursor-history/specs/016-harden-session-integrity/contracts/session-output.schema.json`
as part of the e2e suite.

The package smoke must lock pathless compatibility rather than normalizing both surfaces to the same
sentinel. For a pathless resolved session:

- the public library returns the exact legacy alias `workspace: "unknown"` and omits
  `canonicalWorkspacePath`;
- core and CLI structured JSON return `workspacePath: null`, omit canonical workspace metadata, and
  never emit the string `"unknown"` as a real path; and
- round-tripping through list, show, search, and JSON export preserves those exact distinctions.

Run built-CLI fatal-output regressions without wholesale command mocks:

```bash
cd /workspaces/patcomm/cursor-history
npx vitest run tests/e2e/cli-fatal-json.test.ts
```

Freeze affected v0.17 commands' error object and exit-category baselines before changing streams.
Then assert existing human-readable fatal errors remain on stderr and every fatal JSON object is
emitted on stderr while stdout contains no fatal object. The deliberate migration under test is the
fatal-JSON stream change, not a new human-readable stream contract. For the same locked fixture,
every pre-existing JSON field name, type, and value and
the exit category remain unchanged; documented additive stable `code`, safe `details`, and remedy
fields are permitted, so whole-object byte equality is not required. No stack, content, or raw
locator may appear. Explicitly reported partial success remains exit `0` in the successful stdout
envelope.

The v0.17 warning and migration fixture explicitly tell scripts that parsed fatal JSON from stdout
to parse stderr after this versioned transition. Registry-closed tests cover every fatal path for
`list`, `show`, `search`, `export`, `migrate`, `migrate-session`, `backup`, `restore`, and
`list-backups`, plus root option/usage parsing, command loading, not-found, I/O, capability, cleanup,
encoding, source-limit, and unexpected typed failures. Adding a command or fatal category without a
fixture fails coverage. The tests compare stream placement, every locked pre-existing field
name/type/value, allowed additive fields, and exit category, proving this is a deliberate stream
migration rather than accidental output drift.

## 14. Documentation review

Before release, compare:

- `/workspaces/patcomm/cursor-history/README.md`
- `/workspaces/patcomm/cursor-history/docs/readme_es.md`
- `/workspaces/patcomm/cursor-history/docs/readme_fr.md`
- `/workspaces/patcomm/cursor-history/docs/readme_zh.md`
- `/workspaces/patcomm/cursor-history/CHANGELOG.md`
- installed package help and `.d.ts` output

Each surface must explain logical UUID versus physical occurrence, scoped index lifetime, numeric
bases, exact/unique-suffix workspace matching, default I/O boundary, explicit related-source opt-in,
complete versus partial fidelity, actual provenance, inferred timestamps, v0.17 warning/pinning, and
the safe v0.16 Composer-only incremental-upgrade path. It also documents the fatal JSON stderr
migration, the 0.18.0 public-search coordinate correction and additive export index, the backup
publication commit/failure contract, Composer-only backup scope in Compatibility Matrix v1, usable
DB/transcript coexistence, and producer-version semantics.

Walk every symbol reachable from the exact packed package-root declaration graph—including aliases
and re-exports—and require contract JSDoc; callable and constructable exports cover parameters,
applicable returns, and thrown typed errors. Inspect every command/option for complete `--help`.
The package e2e gate executes all shipped CLI examples against the built CLI and typechecks/runs all
shipped library examples. One frozen structured-output schema oracle is used by the built-CLI test
and rerun unchanged against the exact packed artifact.

The feature-016 implementation checklist must map 100% of public values used for persistence,
comparison, addressing, deduplication, or incremental synchronization to a compatibility
disposition, affected-version fixture, regression test, and migration note. The PR template makes
the same evidence an ongoing per-PR gate; this release does not claim to quantify future unsubmitted
changes.

## 15. Privacy-safe maintainer verification

The release sequence is deliberately ordered so every repository write precedes the final validated
revision and the packed bytes never change afterward:

1. Implement and test the metadata-only preflight, build a candidate, and run that preflight on the
   authorized source carriers below before freezing the repository.
2. If a legitimate source exceeds a default, update every normative/projection artifact, constant,
   test, and document, then restart the affected implementation and preflight work.
3. Before freezing, run the documented owner-private full-corpus differential between the official
   v0.16.0 tag and the candidate over the same Composer-only source, including every released
   library value/shape and the pinned unchanged-consumer SQLite transition. Real input may reveal a
   structural class, but no real value, redaction, hash, ordering, or derived artifact may enter a
   committed fixture; reproduce the class manually with fixed fictional values, rerun its regression
   and fixture safety gates, and restart the preflight. Do not sample, cap, time-limit, or stop after
   an early success; use exhaustive all-candidate association even if that manual pass is quadratic.
4. Run the preliminary full validation. Any failure or unplanned tracked edit returns to its owning
   task and restarts at the preflight and private differential. After a clean pass, write the one
   planned implementation checklist and make no other repository change.
5. Freeze that revision and run the unconditional final install/typecheck/lint/format/test/build
   gates. Pack once only after they pass, retain the checksum-addressed tarball, and smoke only those
   bytes.
6. Run the maintainer-owned content checks and protected approval against that same tarball. Any
   validation, pack/checksum, clean-install, smoke, approval, or manual-stage failure blocks
   publication, discards the candidate, and restarts at the preflight; success authorizes publication
   of the preserved tarball without rebuild, repack, or tracked-file changes.

The maintainer uses only data they own and are authorized to inspect. Exercise the candidate against
maintainer-owned real Cursor live data, a real JSON/Markdown export, a newly created/read backup
archive, and an explicitly chosen custom data path. Do not use contributor, employer, customer,
shared-machine, or CI-user history. Before exercising content reads, run the documented read-only
Source Read Limits v1 preflight over
maintainer-authorized Cursor source carriers actually readable by cursor-history v0.16: live/custom
Composer roots and cursor-history backup ZIP/SQLite inputs. It may inspect ZIP central metadata and
SQLite length/count aggregates but must not retain decoded content. Do not point it at the downstream
vibe-history database/archive; that artifact is validated only by owner-authorized external T113. If any
legitimate count, size, or ratio exceeds a v1 default, stop the release and raise that default before
rerunning the gates; synchronize the normative spec, design/data model, all three contracts, this
quickstart, tasks, implementation constant, and packaged documentation, then pass the exact-policy
drift check before refreezing, revalidating, and packing a new candidate. Do not ask the unchanged incremental consumer to add an
override after upgrade.

Keep all raw commands, exports, archives, and temporary evidence in a maintainer-private directory
outside the repository. Verify that directory and evidence files are owner-only before use. Never
attach an archive, database, transcript, exported conversation, raw CLI output, or unredacted debug
log to an issue, pull request, CI artifact, or release record.

The retained verification record contains only:

- tested revision/tag, package-tarball SHA-256, platform, Node version, and driver/capability profile;
- abstract operation labels such as `live-list`, `live-scoped-search`, `custom-path-export`, and
  `backup-read`, with redacted counts and pass/fail;
- one-run salted hashes of session IDs (the salt is not retained) and abstract workspace labels such
  as A/B, never UUIDs or paths;
- complete/partial/ambiguous fidelity states, low-level metadata/payload event totals, and confirmation
  that off-scope payload events and poison-canary hits were zero; and
- permission/cleanup results expressed as modes and residue counts, without artifact paths.
- aggregate maximum Source Read Limits measurements and pass/fail against the proposed defaults,
  without record content or stable source identifiers.

Inspect the redacted record before retaining it and delete the private raw exports/backup/evidence
according to the maintainer's secure local-data procedure. This manual gate corroborates real Cursor
layouts; it never replaces or redefines the tagged oracle, locked fixtures, automated isolation
instrumentation, or release-blocking tests.
