# Phase 0 Research: Session Integrity and Compatibility Hardening

**Branch**: `016-harden-session-integrity`<br>
**Date**: 2026-08-05<br>
**Scope**: Resolve the implementation choices required by
`/workspaces/patcomm/cursor-history/specs/016-harden-session-integrity/spec.md`.

All product decisions were settled in the specification. This document freezes the remaining
technical contracts so design and implementation can proceed without open questions.

## 1. Compatibility oracle and downstream key chain

**Decision**: Treat the released cursor-history `v0.16.0` tag at commit
`e8a7abf8cea3419a9dda911e174a05f82a9b260e` as the authoritative Composer projection algorithm.
Vendor a provenance-recorded, test-only port of the relevant projector/parser branches instead of
inferring behavior from fixtures. The global projector queries `bubbleId:<id>:%` in SQLite
`rowid ASC` order, emits one output message per row, preserves the released `[corrupted message]`
and `[empty message]` placeholders, and chooses `data.bubbleId` or the row-key suffix exactly as the
tag did. The workspace fallback freezes the tagged `parseChatData`, `parseComposerFormat`,
`parseSession`, and `parseMessage` branch behavior. Locked fixtures validate this oracle; they do
not define it.

Run that projector through a test-only copy of the unchanged vibe-history Cursor adapter and
replacement policy. For session UUID `S`, that consumer creates message key
`cursor:S:<source-message-id>` when the source ID is nonempty, otherwise
`cursor:S:msg:<zero-based-final-array-index>`, and tool key
`<normalized-message-key>:tc:<zero-based-tool-index>`. The harness exercises the actual atomic
session-replacement transaction and complete-message digest.

**Rationale**: The compatibility promise concerns durable keys and replacement behavior actually
used by the existing archive, not an approximation reconstructed from current code. A golden
consumer harness verifies session, message, tool, parent, digest, and idempotency behavior together
without adding a runtime dependency on vibe-history.

**Alternatives considered**: Snapshot only cursor-history JSON (insufficient to prove downstream
keys or replacement); depend on the live vibe-history repository (not reproducible); preserve every
v0.17 Store ID (explicitly outside the agreed contract).

## 2. Composer identity projection

**Decision**: Add the tagged v0.16 Composer projection step before cross-stack alignment. It
reproduces the released global and workspace-fallback sequence, inclusion, placeholder, filtering,
and branch behavior from the tagged source oracle above. A string ID with `length > 0` is preserved
byte-for-byte; a null, missing, or empty ID becomes
`msg:<zero-based-projection-index>`. The projection records `messageIdentityVersion: 1` and origin
`composer-native` or `composer-v0.16-index`. Native-versus-compatibility collisions that already
existed are retained and diagnosed internally; they are not “repaired” by changing a historical
key.

**Rationale**: The consumer derived fallback IDs from the final v0.16 Composer array. Assigning them
after Store insertion, filtering, or merge rendering would shift durable archive keys. Preserving
nonempty IDs without trimming also matches the released truthiness behavior.

**Alternatives considered**: Use final merged position (the reported corruption); hash old content
(changes all historical fallback keys); decorate IDs with workspace/source (breaks native fidelity
and public identity).

## 3. Store message and tool identities

**Decision**: Retain Store DB leaf hash and traversal ordinal while decoding. A DB-only candidate is
`store:v1:db:<lowercase-leaf-hash>:<one-based-occurrence-among-equal-hashes>`. A transcript-only
candidate is `store:v1:transcript:<sha256-canonical-json-v1>:<one-based-occurrence-among-equal-hashes>`.
Canonical JSON recursively sorts object keys, preserves array order and decoded Unicode strings,
and includes source-native role, exact extracted content, ordered structured tool activity, and
only relationships actually stored by that representation. It excludes paths, discovery order,
merged position, display timestamps, and inferred neighbor relationships.

Compute candidates and occurrence ordinals in representation-native order before merge. After
alignment, seed the used set with all frozen Composer IDs and allocate IDs only to unmatched Store
messages. A collision receives `:collision:<smallest-positive-unused-n>` in native order. DB and
transcript are replacement representations, so their identity namespaces are not forced to map.

For tool calls, preserve a native ID byte-for-byte when present. Otherwise use
`tool:v1:<stable-message-id>:<sha256-canonical-tool-input>:<one-based-occurrence>`, with origin
metadata. Every resolved runtime/JSON call has a nonempty ID and origin; published TypeScript fields
remain optional only so previously compiled source still type-checks. Existing Composer compatibility
remains governed by unchanged tool array positions;
matched calls occupy the Composer positions and unmatched Store calls append in Store order. Within
each already aligned message, pair calls with a fixed Composer-to-Store orientation and these passes:

1. exact nonempty native call ID plus exact tool name;
2. exact canonical request signature: exact tool name and recursively sorted `params`;
3. exact tool name only when one candidate lacks `params`.

Each pass is stable one-to-one: choose the earliest unmatched Composer call, then the earliest
unmatched Store call, and resolve duplicates by native occurrence order. Calls with differing
present `params` never match. Status, result, error, duration, standalone `files`, and other
enrichment are not matching inputs, so ignored fields cannot change pairing or the compatibility
tool sequence. Ordered files may remain part of a Store-only modern synthetic tool ID, but never the
unchanged-consumer matching/equivalence contract. If file evidence is semantically required, it
must first be projected into a consumed field or the source is partial.

The unchanged vibe-history consumer has no attachment field: it persists message `content`, derives
code blocks from that content, and maps the tool-call `name`, `status`, `params`, `result`, and
`error` fields. It does not consume standalone cursor-history `codeBlocks` or tool `files` values.
Therefore this feature adds no standalone attachment array that the compatibility consumer would
silently ignore. Source attachment evidence is supported only when its source adapter can losslessly
and deterministically project the
user-visible evidence into fields the unchanged adapter actually consumes: message `content`
(including fenced code blocks), or tool-call `name`, `status`, `params`, `result`, and `error`.
Those normalized fields participate in replacement and replica equivalence; a standalone
`codeBlocks`/`files` value is insufficient unless the same evidence is present in a consumed field.
Any raw attachment block that cannot be represented there marks the source partial and prevents legacy
`source: global`. Never dereference an external URI/target merely to parse, hash, or compare it.

**Rationale**: Source-native inputs are deterministic and independent of presentation order. Full
SHA-256 lowercase hexadecimal avoids silent truncation collisions, while occurrence and collision
suffixes handle legitimate repetition. Scoping synthetic tool identities by stable message ID
prevents cross-message collision.

**Alternatives considered**: Final array index (unstable under insertion); transcript line number
alone (unstable and content-blind); attempt DB/transcript cross-format IDs (no proven shared native
identity); include result/enrichment in a synthetic tool base hash (would change identity when an
existing call is enriched).

## 4. Merge alignment, order, tools, and relationships

**Decision**: Split merge into `computeAlignment(composer, store)` and
`renderAlignment(plan, preferredSource)`. Alignment always uses the same Composer-to-Store
orientation and deterministic tie-breaks; preferred source affects rendered order/scalar conflict
values, not pair selection. Every matched pair receives the Composer identity. Composer tools keep
their existing order, matched Store fields enrich those slots, and unmatched Store tools append.

After rendering, rewrite parent/branch/leaf relationships through the pair-to-stable-ID map. Add
`parentMessageId`, `isSidechain`, and `activeBranchMessageIds`. Preserve Composer-only
`activeBranchBubbleIds` byte-for-byte; for merged views, set it to the resolved stable active branch
so the unchanged consumer includes Store gaps when rebuilding parents and leaves.

**Rationale**: Merely overwriting the final ID is insufficient if switching the preferred backbone
changes which repeated messages pair. The unchanged consumer derives tool IDs from ordinal and
parents from `activeBranchBubbleIds` or array order, so both compatibility paths must be maintained.

**Alternatives considered**: Run alignment once per preferred backbone (pairing drift); concatenate
Composer then Store (incorrect conversation order); put Store tools before Composer tools (breaks
existing tool keys); expose only `parentMessageId` (the unchanged consumer would ignore it).

## 5. Legacy fidelity and additive provenance

**Decision**: Keep `ChatSession.source` as the legacy replacement-safety signal at runtime:

- `global`: complete Composer-global, complete Store DB, complete transcript-only when no DB is
  expected, or a complete permitted merge;
- `workspace-fallback`: Composer fallback, partial DB, transcript fallback after an expected DB
  fails/empties, or any view missing/failed because of scope;
- no resolved session value for divergent replicas.

Determine Store completeness with a deterministic three-state `StoreDbExpectation` before reading
payload:

- `expected` when a per-session `store.db` exists or metadata explicitly says
  `hasConversation: true`;
- `not-expected` when metadata explicitly says `hasConversation: false`, or a transcript-only UUID
  has no per-session Store directory/metadata;
- `unknown` when a per-session directory/metadata exists, the DB is absent, and no explicit Boolean
  answers the question.

A fully usable expected DB is complete; a usable but partial DB remains degraded and is not replaced
by a transcript. If an expected DB is missing, empty, or source-corrupt/unreadable, a usable
transcript may recover content but remains degraded. A complete transcript is replacement-safe only
in `not-expected`; in `unknown` it remains degraded. An incomplete transcript is always degraded.
Driver-capability and snapshot-infrastructure failures are fatal typed failures, never transcript
fallback. Metadata without usable conversation content emits a degraded `store-metadata` row when
there is evidence a conversation may exist, or is omitted when metadata explicitly says there is no
conversation and no positive representation evidence. A present but unreadable/corrupt transcript
is positive conversation evidence even when the DB was `not-expected`, so it yields degraded
`store-metadata` rather than disappearing.

Add `resolvedSource: 'composer' | 'store-db' | 'store-transcript' | 'store-metadata' | 'merged'`, coarse
`sources`, and an explicit `resolution` object. Keep released v0.17 source literals in TypeScript as
deprecated transition vocabulary so existing TypeScript consumers still compile, but new resolved
outputs emit only the two compatibility values above.

**Rationale**: The unchanged consumer already atomically replaces a changed session marked
`global` and refuses a degraded `workspace-fallback`. Additive provenance preserves truth without
teaching the old consumer a new replacement state.

**Alternatives considered**: Continue emitting `merged`/`store-complete` (old consumer does not
replace); redefine `sources` as fidelity (conflates concerns); require consumer changes (contrary to
the confirmed migration goal).

## 6. v0.16 and v0.17 transition boundaries

**Decision**: Guarantee no-consumer-change migration only for v0.16 Composer-only archives becoming
complete Composer-backed merged sessions. Their Composer-derived keys stay byte-identical; a changed
complete view triggers one atomic replacement and the next sync is a no-op. Lock complete v0.17
Store/merged baselines to one corrective `global` replacement, zero duplicate logical content, and
a subsequent no-op, while explicitly not preserving unstable v0.17 positional/cross-format Store
IDs. A degraded v0.17 input or corrective view gets pin/retry/manual guidance, not the same promise.

**Rationale**: The verified legacy policy handles complete-source transitions but cannot safely
replace from a degraded incoming view. Claiming more would misstate empirical consumer behavior.

**Alternatives considered**: Preserve all v0.17 IDs (not stable enough and not agreed); allow a
degraded corrective view to replace (can destroy complete data); silently append the delta (misses
middle insertions, deletions, parents, and enrichment).

## 7. Metadata catalog and scoped payload I/O

**Decision**: Introduce a metadata-only `SessionCatalog`. Discovery records native UUID, source
role/representation, verified memberships, fidelity hints, and private locators without parsing
conversation payload. Titles, previews, bubbles, transcript lines, Store leaves, tools, code blocks,
and attachments are hydrated lazily only after a logical row and workspace content boundary are
bound. Store discovery is split into instance inventory and selected-instance hydration; it no
longer returns one eager `Map<uuid, decoded-session>`.

Default workspace scope is both membership selection and payload-I/O isolation. Lightweight global
metadata may locate memberships, but off-scope contributors remain omitted and make the view
partial. Explicit `includeCrossWorkspaceSources` may load contributors only for UUIDs already
selected in the bound scope and records each broadened path.

Prove the boundary below the resolver: all filesystem opens/reads, SQLite opens and queries, and
key/value reads flow through shared adapters that automatically record operation, physical source,
table/key class, and whether it is catalog metadata or conversation payload. Tests also install
off-scope poison-canary DB rows, transcript files, and blobs that throw on any touch. A voluntary
high-level observer is diagnostic convenience only and cannot be the sole evidence of isolation.

**Rationale**: Current eager Store discovery both reads unrelated conversations and pins every
decoded Store session, so neither result-only filtering nor an LRU around final sessions can satisfy
privacy or memory requirements.

**Alternatives considered**: Filter after current Store parsing (too late); treat workspace as only
a presentation filter (rejected product behavior); scan arbitrary off-scope content to discover
matches (privacy violation).

## 8. Logical sessions and replica reconciliation

**Decision**: Group all physical occurrences by native UUID, then arbitrate each source role before
cross-role merging. Composer-global is the high-fidelity primary. Reconcile competing permitted
global occurrences only against other globals; when one usable global payload exists, it supplies
Composer content while workspace records contribute membership/provenance only. Composer-workspace
is a fallback only when no permitted usable global exists, and every such resolved view is partial.
A missing or source-corrupt global may fall back with reason codes; driver/snapshot infrastructure
failure remains fatal. Global and workspace encodings are never called divergent merely because
their payloads differ. Under a scoped read, compare only permitted same-tier instances; known
off-scope instances are omitted and make the result partial unless cross-workspace loading was
explicitly enabled. One global record referenced by several workspace memberships is one physical
occurrence, not several replicas.

Composer and the selected Store representation are complementary. Store DB is primary and
transcript follows the expectation state machine in section 5. Multiple candidates competing at the
same role/representation/fidelity tier are replicas. Equivalence v1 hashes ordered stable IDs,
roles, directly stored timestamp values, content, relationships, tools, code blocks, and
supported attachment evidence already projected into message `content` or consumed tool-call
fields. It excludes
`timestampSource` and other provenance-only annotations,
path, locator, discovery order, and inferred display timestamps.

Equivalent replicas collapse into one contribution retaining all occurrence provenance. Divergent
replicas produce one `ambiguous` logical summary and exactly one diagnostic; normal direct-ID,
index, search, export, and migration paths cannot hydrate, union, or select their contested payload.

**Rationale**: One UUID must remain one logical public session, while complementary data must still
enrich it and same-role conflicts must never be guessed. Excluding location/provenance prevents
identical copies from appearing different.

**Alternatives considered**: Disable dedup in scoped lists (duplicate search/export); suffix public
IDs (breaks native identity); newest/first winner (silent data selection); union divergent payloads
(fabricated conversation).

## 9. Workspace matching and path roles

**Decision**: Normalize historical paths lexically without requiring existence: decode supported
file URIs, normalize separators and dot segments, remove non-root trailing separators, map supported
drive/WSL forms consistently, and apply source-platform case rules. Resolve normalized exact first;
only if absent, accept exactly one candidate whose complete trailing components match. Multiple
suffix candidates throw `WorkspaceAmbiguityError` before payload I/O; no candidate returns an
actionable empty result.

Keep `workspacePath` (core/JSON) and `workspace` (library) as compatibility aliases for
`canonicalWorkspacePath`. A Composer-backed session freezes the deterministic unfiltered Composer
attribution verified by the v0.16 fixture (configuration workspace before folder, then normalized
lexicographic ordering); Store cwd never overwrites it. A Store-only session may use a reliable cwd.
Add `matchedWorkspacePath`, `workspaceMemberships`, and per-source paths.

**Rationale**: Exact-only matching broke suffix workflows, arbitrary `endsWith` is ambiguous, and
using the selected Store backbone for `workspacePath` recreates AC5. Historical/foreign paths may
not exist locally.

**Alternatives considered**: Exact-only (regression); arbitrary suffix (false matches); realpath
(historical paths fail); let active filter become canonical (metadata drift).

## 10. Index and diagnostic contracts

**Decision**: Every reusable structured index carries `indexScope: 'global' | 'workspace'` and a
workspace-scoped item also carries full `indexWorkspacePath`. CLI/core indices stay one-based;
public-library read lookups stay zero-based; the library migration configuration retains its
published one-based selectors. A bound row contains UUID plus the permitted occurrence set, so
follow-up never reinterprets its number. Scoped direct IDs verify membership; unfiltered direct-ID
behavior remains unchanged.

Existing CLI JSON envelopes gain additive scope/diagnostic members. Library functions keep their
released array/string return shapes and use `LibraryConfig.onDiagnostic` for safe continuation;
without a diagnostic handler, an ambiguity that would otherwise be skipped throws a typed error.
Opaque occurrence references are diagnostic, context-bound, contain no path, and never authorize
mutation.

Canonicalize every new set-like public array before serialization: source roles use
`composer, store`; reason/state enums use declaration order; workspace memberships and every
source-instance `workspacePaths` array use normalized Unicode code-point path order; source
instances use role, representation, ordered paths, then state; and diagnostic occurrence refs use
their context-stable fingerprint order. Semantic arrays—messages, branches, tools, and code
blocks—retain their resolved/source-native semantic order. Identical public source-instance entries
need no private-locator tie-break because swapping byte-identical entries cannot change the
serialized value.

**Rationale**: This makes presentation addresses self-describing without another JSON-shape break,
and it prevents silent library skips while preserving return types.

**Alternatives considered**: Stable/global numeric indices (impossible across changing lists);
return new library envelopes (breaking); expose raw DB paths (security and abstraction leak).

## 11. Migration target binding

**Decision**: Replace mutation-time `resolveSessionIdentifiers()` rediscovery with
`bindMigrationTargets()`. It returns a private `BoundMigrationTarget` containing logical UUID,
exact eligible Composer locator, source workspace, data-source identity, eligibility, and a
precondition fingerprint. Prepare resolves scope, target, destination, capability, and all
preconditions before the first write; dry-run reports that exact plan; execution revalidates the
same target and then applies it. The deterministic representative chosen for equivalent read
replicas is not mutation authority: an eligible target must have exactly one Composer locator within
the bound mutation footprint. Equivalent duplicate locators, two records in one matched workspace,
or a shared global record whose mutation would affect another membership are rejected. Divergent,
Store-only, and merged sessions are rejected for both single-session and workspace-wide migration.

**Rationale**: UUID alone cannot identify which physical record to mutate, and rediscovery can turn
a safe preview into a different destructive target. The feature deliberately has no Store or
all-source migration contract.

**Alternatives considered**: Resolve numeric input globally (original bug); reuse the representative
chosen for equivalent reads (still guesses a destructive locator); first matching physical record
(unsafe); occurrence-reference override (diagnostics are not authority); move only Composer half of
merged session (creates split state).

## 12. Read context lifecycle and retention

**Decision**: Construct `SessionReadContext` with immutable data path/backup identity, normalized
workspace scope, cross-workspace opt-in, diagnostic sink, and completed-session capacity. Preserve a
deprecated positional global overload for source compatibility. Use a separate in-flight promise
map for concurrent coalescing and an LRU for completed values. Default `C=1`; built-in search,
export-all, and streaming core loops use `C=0`. Rejects are removed immediately. Expose
`releaseSession()` and idempotent `dispose()`, and dispose all built-in contexts in `finally`.

**Rationale**: One retained value preserves useful immediate reuse without corpus growth. Separate
in-flight state yields the required `C+A` accounting. Immutable construction removes list-before-get
order coupling.

**Alternatives considered**: Unbounded memoization (current leak); default `C=0` everywhere
(unnecessary repeated single-session loads); one global cache (cross-scope contamination); mutable
first-call binding (order-sensitive).

## 13. Timestamp fallback and provenance

**Decision**: Keep a timestamp on every public message. Preserve direct provenance tokens exactly:
`composer-created-at`, `composer-timing`, and `store-turn-timing`. For each missing value, use the
next directly stored timestamp if one exists (`inferred-next`), otherwise the previous directly
stored timestamp (`inferred-previous`), otherwise a deterministic source-derived session timestamp
(`session-fallback`), otherwise Unix epoch with `unknown`. A legacy non-null message timestamp whose
direct origin cannot be proven is preserved byte-for-byte with source `unknown`, but it is not an
anchor for neighboring inference. Never infer from another inferred/unknown value, filesystem
mtime, or current wall clock.

Expose `createdAtSource` and `lastUpdatedAtSource` as
`composer-metadata | store-db-metadata | store-meta | direct-message | epoch-unknown`. For a
Composer-backed view, valid stored Composer session metadata wins. For Store-only views, valid DB
metadata wins, then valid Store metadata. Otherwise use the earliest/latest directly stored message
timestamp, or the Unix epoch with `epoch-unknown`. Preferred merge backbone, workspace filter, and
read time cannot change the canonical session timestamps. A session time labeled `epoch-unknown`
cannot be used as a `session-fallback` anchor. Human output marks non-direct values approximate;
JSON/library always provide timestamp and provenance.

**Rationale**: This preserves the required public shape while making repeated reads deterministic
and honest. Synchronization compares the complete stable resolved view, so middle insertion cannot
depend on maximum timestamp.

**Alternatives considered**: Remove timestamps (breaking); use read time (nondeterministic); chain
forward inferred values (can compound fabricated precision); use max timestamp as watermark
(already misses valid middle insertions).

## 14. Private snapshots and archive publication

**Decision**: Centralize a `PrivateTempWorkspace`. Each operation uses an exclusive `mkdtemp`
directory, mode `0700` on POSIX, and exclusive files created with `wx` and `0600`. SQLite snapshot
destinations are precreated privately inside that directory before the driver backup overwrites
them. Cleanup is idempotent, runs in `finally`, attempts every artifact even after a close/removal
failure, and reports a typed paths-only residue error. Do not change process-wide `umask` or parent
permissions.

Register every active workspace in one process-level cleanup registry. A single coordinated
`SIGINT`, `SIGTERM`, and `SIGHUP` handler performs synchronous best-effort cleanup and then preserves
the platform's signal termination semantics; cooperative `AbortSignal` cancellation still exits
through normal `finally`. Each directory contains a private marker with format version, current uid
where available, pid, a process-start token, and creation time. Before a new operation, recover only
directories with the exact application prefix, current owner, a valid marker, and an owner process
proven dead (including start-token mismatch); uncertain candidates are never deleted. `SIGKILL`,
power loss, and kernel termination cannot guarantee immediate cleanup, so privacy comes from the
private directory and the next operation performs conservative stale recovery.

Backup creation writes a complete private sibling staging archive and then publishes it. New final
archives default to `0600`; force-overwrite cannot broaden the existing mode; broader permissions
require `sharedPermissions: true` / `--shared`. On POSIX, explicit sharing uses the ordinary
non-executable file mode `0666 & ~currentUmask`; reading the current umask is allowed, but the process
umask is never changed. A default force-overwrite preserves the existing archive mode exactly after
the complete private staging file is ready; explicit sharing may set the ordinary shared mode. The
backup manifest producer version comes from the package build rather than the current hard-coded
`0.9.2`.

**Rationale**: A private parent closes the exposure window during SQLite backup, while explicit
modes protect each plaintext file. Process umask is global and unsafe under concurrent operations.
Staged publication prevents deletion of a valid old archive before the replacement is complete.

**Alternatives considered**: Shared timestamp filenames (predictable/collision-prone); rely only on
umask (often produces `0644`); swallow cleanup errors (claims success with residue); change parent
directory permissions (outside authority).

## 15. SQLite capability selection

**Decision**: Give each driver a capability profile for `read`, `readWrite`, and `onlineBackup`.
Selection occurs per operation and capability set, not through one sticky import winner. The
`node:sqlite` probe treats `backup` as optional and advertises `onlineBackup` only when it is a
function; automatic mode prefers it when capable and falls back to `better-sqlite3`. An explicitly
forced incapable driver never falls back and returns a typed error naming driver, operation,
missing capabilities, alternatives, and remedy. Store snapshot capability errors propagate instead
of becoming an empty/partial session.

Keep public `setDriver(): void` synchronous by recording the preference immediately; validate it at
the next awaited DB operation. Wire `LibraryConfig.sqliteDriver` into the same context selection.
Preference priority is operation/library configuration, then the most recent `setDriver` value,
then `CURSOR_HISTORY_SQLITE_DRIVER`, then automatic selection.

**Rationale**: Official Node documentation records `node:sqlite` earlier than the online backup API;
`sqlite.backup` arrived in Node 23.8.0 and 22.16.0. Import availability therefore does not prove the
operation is safe. Keeping the public return type avoids another compatibility change.

**Alternatives considered**: Import-only availability (current defect); globally select one driver
(different operations need different capabilities); change `setDriver` to `Promise<void>` (avoidable
public return-contract change); catch snapshot errors as Store fallback (false success).

Primary references:

- [Node.js SQLite API and `sqlite.backup` history](https://nodejs.org/api/sqlite.html#sqlitebackupsourceDb-path-options)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)

## 16. Runtime/dependency and release pipeline

**Decision**: Keep `engines.node >=20.0.0`. The release matrix covers Node 20.0.0, exact capability
boundaries 22.15.1/22.16.0 and 23.7.0/23.8.0 in focused driver tests, current 24.x LTS, and current
26.x stable. Update `better-sqlite3` within major v12 to a release that supports Node 26 while
retaining a Node 20 source-build path; v12.10.0 is the minimum researched candidate. Do not adopt
v13 because it would violate the settled Node 20 contract.

Split publication into required validation jobs and a dependent publish job. Remove all failure
swallowing. Run install, typecheck, lint, nonempty tests, and build; pack once; record tag/version and
SHA-256; install the exact tarball into a clean project; smoke ESM import, CommonJS `require`, CLI
version plus a real fixture command, and declarations; publish that same tarball. Generate the
currently advertised but missing `dist/lib/index.cjs` rather than removing the `require` export.
Use a second TypeScript CommonJS output under `dist/cjs/`, place a generated
`dist/cjs/package.json` with `{"type":"commonjs"}`, and make `dist/lib/index.cjs` require that
tree. A small build script and `tsconfig.cjs.json` are sufficient; no bundler dependency is needed.
Run Vitest with machine-readable results and a small verifier that requires a positive executed-test
count, zero failures/timeouts/cancellations, and only an explicit per-platform allowlist of skipped
tests. The ordinary `npm test` script invokes this release-blocking verifier, so the publish workflow
does not implement weaker test semantics than local validation.

**Rationale**: Node 22.15 imports `node:sqlite` but lacks backup, and the existing Node-24-only
workflow hides that supported failure. Current `better-sqlite3` 12.5 omits Node 26 from its engine
range. The packed artifact, not the source tree, is the product; smoking it catches missing exports
and excluded documentation.

**Alternatives considered**: Raise minimum Node (rejected decision); only test latest Node (misses
capability boundaries); rebuild in publish job (artifact drift); delete CommonJS export (breaking an
advertised surface); add a bundler only for the wrapper (avoidable dependency); use better-sqlite3
v13 (drops Node 20).

Primary reference:

- [better-sqlite3 v12.10.0 release notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.10.0)

## 17. Documentation, diagnostics, and package contents

**Decision**: Ship `CHANGELOG.md` and a canonical compatibility contract in the npm package alongside
README/LICENSE/dist. Update CLI help, canonical README, library API docs, and localized READMEs (or
make each localized file link clearly to the canonical contract). Document v0.12-current history,
the v0.17 warning/pinning path, corrective source/provenance semantics, index scope, exact/unique
suffix matching, partial states, cross-workspace opt-in, timestamp provenance, and v0.16/v0.17
upgrade boundaries. Empty/ambiguous results receive stable error/diagnostic codes and remedies.

Preserve each command's released fatal JSON stream and exit-category behavior in this corrective
release, and lock it with built-CLI regressions. New error codes/details are additive wherever an
error object already exists. Normalizing every fatal JSON error to stderr would itself break scripts
and is deferred to a separately reviewed compatibility transition; this plan introduces no new
stdout error path. Freeze the pathless compatibility aliases exactly: public-library `workspace` is
the string `"unknown"`, while core/CLI structured `workspacePath` is `null` and canonical workspace
metadata remains absent.

**Rationale**: Development specs are excluded from the current package and cannot serve library
consumers. Compatibility decisions must be visible before upgrade and available from installed
artifacts.

**Alternatives considered**: Specs-only documentation (not shipped); changelog only (insufficient
API contract); silently alter workspace matching/source semantics (violates constitution VI).

## 18. Test architecture and release-blocking fault evidence

**Decision**: Combine small deterministic unit tests with real SQLite/ZIP/filesystem integration and
built-CLI/package e2e tests. Instrument the actual filesystem, SQLite query, and key/value adapter
boundaries, then combine their event log with poison-canary off-scope payloads that fail if touched;
a resolver-level observer alone is not accepted as proof. Run POSIX permission tests in a child
process under `umask 000` and
inject failures at ZIP parse, secure creation, snapshot, DB open/parse/close, cleanup, target
revalidation, context cache, and workflow gates. Compatibility fixtures deliberately inject wrong
final-position IDs, Store-preferred matched IDs, Composer tool reordering, wrong legacy source,
append-only updates, wrong paths/IDs, off-scope opens, leaked temp files, and publish-after-failure;
the suite must fail for each mutation.

Before release, also run a privacy-safe manual gate against maintainer-owned real Cursor live data,
an exported backup, and a custom path. Record only revision, platform, redacted command names/counts,
hashed IDs, abstract workspace labels, fidelity states, payload-I/O event totals, and pass/fail—never
message content, raw paths, database contents, or the archive itself.

**Rationale**: Existing wholesale mocks can assert return values while missing permissions, I/O
isolation, CLI option plumbing, driver capabilities, and packed-entry failures. Mutation-proven
regressions establish that tests protect the load-bearing lines.

**Alternatives considered**: Unit mocks only (already left gaps); manual release verification
(nonrepeatable); introduce a mutation-testing runtime dependency (unnecessary—a focused fault harness
is simpler).
