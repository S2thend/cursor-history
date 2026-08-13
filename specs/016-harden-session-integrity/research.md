# Phase 0 Research: Session Integrity and Compatibility Hardening

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

**Branch**: `016-harden-session-integrity`<br>
**Date**: 2026-08-13<br>
**Scope**: Resolve the implementation choices required by
`/workspaces/patcomm/cursor-history/specs/016-harden-session-integrity/spec.md`.

All product decisions were settled in the specification. This document freezes the remaining
technical contracts so design and implementation can proceed without open questions.

## 1. Compatibility oracle and downstream key chain

**Decision**: Treat the released cursor-history `v0.16.0` tag at commit
`e8a7abf8cea3419a9dda911e174a05f82a9b260e` as the authoritative Composer projection algorithm.
Keep a provenance-recorded, cursor-history-owned test projector for the relevant released
projector/parser branches rather than inferring behavior from fixtures. The global projector queries
`bubbleId:<id>:%` in SQLite `rowid ASC` order, emits one output message per row, preserves the
released `[corrupted message]` and `[empty message]` placeholders, and chooses `data.bubbleId` or the
row-key suffix exactly as the tag did. The workspace fallback freezes the tagged `parseChatData`,
`parseComposerFormat`, `parseSession`, and `parseMessage` branch behavior. Locked wholly synthetic
Cursor fixtures validate this cursor-history oracle; they do not define it.

Recurring repository CI then passes those projections through a deliberately generic downstream
model owned by cursor-history. For session UUID `S`, that model freezes the public compatibility
key `cursor:S:<source-message-id>` when the source ID is nonempty, otherwise
`cursor:S:msg:<zero-based-final-array-index>`, and the tool key
`<normalized-message-key>:tc:<zero-based-tool-index>`. It verifies each key's content,
relationship, and tool binding, complete-view replacement eligibility, degraded non-overwrite, and
repeated-input idempotence. It is explicitly not an implementation or emulation of vibe-history or
another third-party consumer, and its internal fingerprint is not a third-party digest contract.
Repository tests and fixtures do not contain copied third-party adapter, digest, comparison policy,
persistence engine, SQLite schema/transaction, rollback, or downstream archive bytes.

The exact no-vibe-history-change guarantee is a separate release-blocking T113 certification. With
owner authorization, T113 uses an external checkout at the recorded upstream revision and runs that
project's unchanged adapter, exact comparison policy and digest, and real SQLite persistence path.
It imports the v0.16 view, applies the complete candidate view, forces a mid-transaction failure,
reopens the database to prove full old-state rollback, retries successfully, and repeats the sync to
prove zero further writes. The revision/license reference may be recorded in the repository, but no
third-party implementation or downstream database is copied into recurring CI. cursor-history owns
only the complete, replacement-safe projection and compatibility signal supplied to that consumer;
it does not claim an arbitrary consumer's transactional persistence.

**Rationale**: The compatibility promise concerns durable keys and actual replacement behavior in
the existing archive. A repository-owned generic model provides deterministic recurring regression
coverage for everything cursor-history controls without copying all-rights-reserved third-party
implementation. Owner-authorized T113 provides the exact integration evidence that a generic model
cannot honestly supply. Both gates are required, so this separation does not weaken the
no-consumer-change guarantee.

**Alternatives considered**: Copy or vendor the third-party implementation and downstream archive
(licensing and provenance risk); claim the generic model proves the exact third-party transaction
(false); depend on an adjacent checkout during recurring CI (not reproducible or self-contained);
preserve every v0.17 Store ID (explicitly outside the agreed contract).

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
by a transcript. Only after capable provider selection and DB snapshot/read setup succeeds may an
expected data/source outcome—DB missing, empty, or source-corrupt/unreadable—select a usable
transcript, and that result remains degraded. A complete transcript is replacement-safe only in
`not-expected`; in `unknown` it remains degraded. An incomplete transcript is always degraded.
Driver-capability, provider-selection, snapshot-setup, and other database-infrastructure failures
are fatal typed failures, never transcript fallback. Metadata without usable conversation content emits a degraded `store-metadata` row when
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

Prove the boundary below the resolver: all filesystem opens/reads, SQLite opens, statement prepares,
queries, online backups, and key/value reads flow through shared adapters that automatically record
operation, operation-context identity, physical source, safe resource class, and whether it is
catalog metadata or conversation payload. The same immutable context carries its optional
`AbortSignal` and low-level observer through every nested adapter. Tests also install off-scope
poison-canary DB rows, transcript files, and blobs that throw on any touch. A voluntary high-level
resolver observer is diagnostic convenience only and cannot be the sole evidence of isolation.

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

Keep the public library's existing `workspace` value as the released v0.16
`coreSession.workspacePath` spelling, including `~/...` home contraction. Expose the normalized full
path separately as additive `canonicalWorkspacePath`; the two spellings may differ without changing
workspace identity. A Composer-backed session freezes the deterministic unfiltered Composer
attribution verified by the v0.16 fixture (configuration workspace before folder, then normalized
lexicographic ordering); Store cwd never overwrites it. A Store-only session may use a reliable cwd.
Add `matchedWorkspacePath`, `workspaceMemberships`, and per-source paths.

Treat v0.16's `(workspace: <directory-id>)` fallback as an internal placeholder, not stored path
fidelity. When no path exists, the versioned corrective result is public `"unknown"` and core/CLI
`null`; this exception cannot authorize a change to any real Composer path.

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

Logical catalogs remain sorted by descending `createdAt`. When timestamps tie, a Composer-backed
UUID uses the stable Composer discovery ordinal that v0.16's timestamp-only stable sort preserved;
replica reconciliation, merging, or ambiguity classification cannot replace that ordinal with an
ID sort. Rows that have no v0.16 Composer ordinal follow the Composer-backed tie group and sort by
native UUID. Thus repeated reads remain deterministic while existing Composer numeric positions do
not change solely because the new resolver introduced an ID tie-break.

Existing CLI JSON envelopes gain additive scope/diagnostic members. Library functions keep their
released array/string return shapes and use `LibraryConfig.onDiagnostic` for safe continuation;
without a diagnostic handler, an ambiguity that would otherwise be skipped throws a typed error.
Opaque occurrence references are diagnostic, context-bound, contain no path, and never authorize
mutation.

Add `listSessionSummaries()` as a separate additive public API. It uses the existing public-read
zero-based indices and pagination inputs, returns exactly one payload-free summary per logical row
in the requested catalog window, and can therefore represent divergent rows without fabricating an
empty session. Existing `listSessions()` retains its full-session result type and released
pagination shape; it diagnoses/skips an ambiguous row according to the existing continuation
policy rather than returning a union.

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
native-UUID tie-breaking for every equal-time row (deterministic but breaks v0.16 Composer numeric
positions); return new library envelopes (breaking); expose raw DB paths (security and abstraction
leak).

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
Numeric and direct-ID selectors resolve through the same complete scoped logical catalog, including
ambiguous rows. An ambiguous row retains the presentation index shown by list and produces the same
`SessionAmbiguityError` (UUID and opaque occurrence references) whether selected by number or UUID;
it is never skipped, shifted, treated as not found, or converted into mutation authority.

**Rationale**: UUID alone cannot identify which physical record to mutate, and rediscovery can turn
a safe preview into a different destructive target. The feature deliberately has no Store or
all-source migration contract.

**Alternatives considered**: Resolve numeric input globally (original bug); reuse the representative
chosen for equivalent reads (still guesses a destructive locator); first matching physical record
(unsafe); occurrence-reference override (diagnostics are not authority); move only Composer half of
merged session (creates split state).

## 12. Read context lifecycle and retention

**Decision**: Construct `SessionReadContext` with immutable data path/backup identity, normalized
workspace scope, cross-workspace opt-in, diagnostic sink, optional `AbortSignal`, optional low-level
audit observer, and completed-session capacity. Preserve a deprecated positional global overload
for source compatibility. Propagate the same signal/context identity into filesystem, key/value,
SQLite prepare/query/backup, parser, and private-temp operations. Use a separate in-flight promise
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

The v0.16 differential may therefore accept a changed message timestamp only when the candidate
proves an inferred/unknown source, and a changed `metadata.lastModified` only when Composer stored
no update value and the candidate source is `direct-message` or `epoch-unknown`. These are versioned
scalar fallback corrections: all identities, order, content, relationships, tools, direct source
timestamps, and stored session metadata remain exact.

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
where available, pid, a process-start token, creation time, and on Linux a boot-scoped PID-namespace
token (boot ID plus namespace inode) when procfs exposes one. Before a new operation, recover only
directories with the exact application prefix, current owner, a valid marker, and an owner process
proven dead (including start-token mismatch). Linux PID/start-token evidence is interpreted only
after marker and current namespace tokens are both readable and equal; a different host boot or
namespace and missing or unreadable namespace identity remain uncertain and are never deleted. This
prevents a numeric PID from another namespace or host using a shared temporary parent from being
mistaken for a dead or reused local PID. Non-Linux behavior remains based on its available
process-liveness evidence without claiming namespace validation. `SIGKILL`, power loss, and kernel
termination cannot guarantee immediate cleanup, so privacy comes from the private directory and the
next operation performs conservative stale recovery.

Backup creation writes a complete private sibling staging archive and then publishes it. New final
archives default to `0600`; force-overwrite cannot broaden the existing mode; broader permissions
require `sharedPermissions: true` / `--shared`. On POSIX, explicit sharing uses the ordinary
non-executable file mode `0666 & ~currentUmask`; reading the current umask is allowed, but the process
umask is never changed. A default force-overwrite preserves the existing archive mode exactly after
the complete private staging file is ready; explicit sharing may set the ordinary shared mode. The
backup manifest producer version comes from the package build rather than the current hard-coded
`0.9.2`. It equals the version of the running packed artifact that created the archive. Older
manifests remain readable, and this diagnostic provenance field is excluded from session/message
identity, replica equivalence, archive deduplication, and incremental synchronization decisions.

The successful rename or hard link to the final output path is the publication commit point. Every
later mode-observation, identity, or mode-adjustment failure therefore reports
`BACKUP_PUBLISHED_PERMISSION_FAILED` with `published: true`; the error does not mean publication was
rolled back. Its details include the final output path, `pathIdentityVerified`, requested mode, and
`actualMode`, which is only the last mode safely observed on the staged archive inode (or `null`)
and never describes an unverified replacement path. A true identity flag proves the path still
names that archive and permits an inspect/correct remedy. A false flag makes the path untrusted and
requires the user to establish which file, if any, is the completed archive before recovery. The
operation exits nonzero and never recommends a blind `--force` retry. Read the published mode before
changing it and skip `chmod` when it already matches, avoiding an unnecessary new failure surface. Bind this work to the archive itself: open
the final path without following links, compare regular-file device/inode identity to the private
stage with lossless bigint values, apply any mode change through that descriptor, then recheck both
descriptor and final path. A nonregular path or replacement race is the same typed post-publication
failure and must never change permissions on the replacement.

Non-force publication uses a hard link as the commit point, so the private sibling name may still
refer to the same completed archive inode afterward. Cleanup retries only while a no-follow stat
proves that the sibling's lossless device/inode identity still matches the published archive; if a
concurrent actor replaced the sibling pathname, cleanup leaves that replacement untouched. An
exhausted or unverifiable cleanup fails distinctly with `BACKUP_PUBLISHED_CLEANUP_FAILED`, because
the archive was published successfully and this is not a permission-adjustment failure. Safe
details contain `published: true`, `outputPath`, output `pathIdentityVerified`, verified
`residuePaths`, and `unverifiedResiduePaths`. Verified residue paths are names proven still bound to
the completed archive inode; unverified paths are merely possible temporary residue and must not be
deleted, chmodded, or force-retried until identity is established. The output path is likewise
trusted only when `pathIdentityVerified` is true. The CLI exits nonzero and never describes either
post-commit error as rollback.

On Windows, create each operation under the system-provided user temporary directory and inherit
its ACLs; still require unique exclusive paths, collision resistance, complete cleanup, and typed
residue failures. Do not claim an independently verified cross-user unreadability guarantee until
dedicated ACL creation and multi-user tests exist. The strict `0700`/`0600` owner-only guarantee is
therefore scoped to permission-aware POSIX platforms.

**Rationale**: A private parent closes the exposure window during SQLite backup, while explicit
modes protect each plaintext file. Process umask is global and unsafe under concurrent operations.
Staged publication prevents deletion of a valid old archive before the replacement is complete;
the explicit commit point also makes a post-publication partial failure honest without destroying
the usable result.

**Alternatives considered**: Shared timestamp filenames (predictable/collision-prone); rely only on
umask (often produces `0644`); swallow cleanup errors (claims success with residue); delete or roll
back a valid archive after publication (destructive and may lose the only completed copy); advise
blind `--force` retry (can overwrite the valid archive); change parent-directory permissions
(outside authority).

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

**Decision**: Declare the finite engine range
`20.x || 22.x || 23.x || 24.x || 25.x || 26.x`, with Node 20.0.0 as the exact floor. Node 21 is
excluded because the packaged `better-sqlite3` v12 line does not advertise it; a broad `>=20.0.0`
claim would therefore promise a runtime that cannot satisfy the fallback contract. The release
matrix runs the same packed candidate on Node 20.0.0, exact capability boundaries
22.15.1/22.16.0 and 23.7.0/23.8.0, and 24.x/25.x/26.x. Node 20 is upstream EOL at this release date
but remains an explicit project compatibility contract. Update `better-sqlite3` within major v12
to a release that supports Node 26 while retaining and testing its Node 20 source-build path;
v12.10.0 is the minimum researched candidate. Do not adopt v13 because it would violate the settled
Node 20 contract.

Run source-level install/typecheck/lint/full-test/build gates on Node 24, a runtime supported by the
Vite 7 development toolchain (which requires Node 20.19+), rather than trying to execute that
toolchain on the Node 20.0 product floor. Split publication into required source validation, a
pack-once candidate stage, a fail-closed exact-candidate runtime matrix, full package verification,
a protected verification approval, and a dependent publish job. The runtime matrix installs the
checksum-addressed package as a production dependency without the repository's development
dependencies and executes its public CLI/library on every supported boundary. It does not run
repository development scripts there, but it also does not claim that a native runtime dependency
can never build from source or require its platform compiler/toolchain. The jobs observe both
automatic provider choice and forced `node:sqlite` backup behavior.
Remove all failure swallowing. Before repository
freeze, run the metadata-only authorized source-limit preflight and relock all affected artifacts if
a legitimate source exceeds a default. Freeze tracked evidence, then run install, typecheck, lint,
nonempty tests, and build. Pack once; record tag/version and SHA-256; install the exact tarball into a
clean project; smoke ESM import, CommonJS `require`, CLI version plus a real fixture command,
declarations, schema, JSDoc, and documentation examples; then pause for maintainer-owned
live/export/backup/custom-path verification against the same bytes. Any failure discards the
candidate and restarts the preflight-through-pack sequence. Only a passing protected approval may
publish the preserved tarball without rebuild, repack, or tracked-file changes. Generate the
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
make each localized file link clearly to the canonical contract). Every symbol reachable from the
exact packed package-root TypeScript declaration graph—including aliases and re-exports—receives
contract JSDoc; callable and constructable exports cover parameters, applicable returns, and thrown
typed errors. Every command/option receives complete help, built-CLI documentation examples execute
in tests, and library examples typecheck and run.
Document v0.12-current history, the v0.17 warning/pinning path, corrective source/provenance
semantics, all three frozen numeric bases, exact/unique suffix matching, partial states,
cross-workspace opt-in, timestamp provenance, and v0.16/v0.17 upgrade boundaries.
Empty/ambiguous results receive stable error/diagnostic codes and remedies.

Keep the existing human-readable fatal-output convention on stderr and move every fatal JSON object
to stderr in this release, including command-owned v0.17 branches that previously wrote JSON to
stdout. The versioned migration applies to fatal JSON stream placement; it does not claim a new
human-readable stream migration. For the same locked failure fixture, preserve
every pre-existing JSON field name, type, and value and its exit-code category; additive safe
codes/details remain permitted, so do not require whole-object byte equality. Lock
both the v0.17 baseline and the intentional stdout-to-stderr transition with built-CLI fixtures, and
ship an explicit warning plus migration example for scripts that parsed fatal JSON from stdout.
Successful results remain on stdout; nonfatal best-effort diagnostics stay in their successful JSON
envelope. Freeze the pathless compatibility aliases exactly: public-library `workspace` is the
string `"unknown"`, while core/CLI structured `workspacePath` is `null` and canonical workspace
metadata remains absent.

**Rationale**: Development specs are excluded from the current package and cannot serve library
consumers. Compatibility decisions must be visible before upgrade and available from installed
artifacts.

**Alternatives considered**: Preserve command-specific stdout fatal errors (conflicts with the
CLI-native constitutional contract); specs-only documentation (not shipped); changelog only
(insufficient API contract); silently alter workspace matching/source semantics (violates
constitution VI).

## 18. Test architecture and release-blocking fault evidence

**Decision**: Combine small deterministic unit tests with real SQLite/ZIP/filesystem integration and
built-CLI/package e2e tests. The locked raw-layout SQLite fixture is generated deterministically
from wholly synthetic values, includes generation provenance/logical inventory/SHA-256, and is
scanned for real paths, emails, tokens, machine identifiers, or copied user data. Instrument the
actual filesystem, SQLite open/prepare/query/backup, and key/value adapter boundaries, then combine
their event log with poison-canary off-scope payloads that fail if touched; a resolver-level observer
alone is not accepted as proof. Run POSIX permission tests in a child
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

The frozen CLI JSON schema is validated by one executable oracle used first against built-CLI
fixtures and again against the exact packed artifact; implementation output may not rewrite the
schema to pass. Feature-016 compatibility governance is complete only when every changed or new
public value is mapped to its prior-release fixture, disposition, test, and migration note. This is
a 100% evidence goal for this feature and a required per-PR review practice, not a claim that one
release can quantify every future change.

**Alternatives considered**: Unit mocks only (already left gaps); manual release verification
(nonrepeatable); introduce a mutation-testing runtime dependency (unnecessary—a focused fault harness
is simpler).

## 19. Defensive parsing and bounded source reads

**Decision**: Treat supported text as UTF-8 with at most one leading UTF-8 BOM. Ignore unknown
object fields/SQLite columns for forward compatibility. Do not heuristically detect or transcode
invalid/mixed encodings and do not replace invalid bytes with `U+FFFD`, because either choice can
silently change content hashes and synthetic identity. Return a typed source-partial diagnostic
when another safe contributor remains; otherwise return the operation's typed fatal parse error.

Adopt inclusive policy `source-read-limits/v1`: JSONL record `67_108_864` bytes (`64 MiB`), source
`4_294_967_296` bytes (`4 GiB`), and `2_000_000` nonempty records; SQLite metadata page `256` rows
and `268_435_456` bytes (`256 MiB`), individual value `134_217_728` bytes (`128 MiB`),
`5_000_000` rows, and `8_589_934_592` decoded bytes (`8 GiB`); ZIP compressed container
`17_179_869_184` bytes (`16 GiB`), `65_536` central records, entry `8_589_934_592` bytes (`8 GiB`),
aggregate uncompressed `17_179_869_184` bytes (`16 GiB`), and per-entry/aggregate ratio `200:1`.
Equality passes and the first raw-byte/count unit above fails.

Process JSONL incrementally by raw-byte line with fatal UTF-8 decoding per bounded record; count the
optional BOM/newlines in source bytes and nonempty records only. Iterate SQLite with keyset/row-ID
metadata pages, preflight each SQLite-reported value length, and fetch admitted payloads
sequentially rather than calling payload `.all()`. Reset SQLite aggregate counters per logical
session and separately per metadata-only catalog scan so bulk operations do not accumulate an
entire corpus. Inspect ZIP central-directory metadata before extraction, bound the compressed file,
and recheck actual streamed output and `uncompressed / max(compressed, 1)` ratios while
materializing privately. Replace whole-container/entry archive reads and aggregate-buffer archive
creation with bounded streams. Cancellation is checked between bounded units and flows through the
same nested cleanup path.

Expose a partial per-operation override in library/context/backup/restore configuration and a
repeatable CLI `--source-limit <field>=<IEC-size-or-integer>`. Validate positive safe integers,
runtime string bounds, and cross-field relationships before content I/O; copy/freeze the result.
Permit explicit raising or lowering, but no unlimited, global, environment, input/manifest,
automatic-retry, or mutable override. Limits never feed identity/equivalence/deduplication. A safe
alternate contributor yields a typed partial; no fallback makes a session/source fatal, while any
ZIP bound failure makes the archive read/validation/restore fatal.

Use a focused Node-20-compatible archive adapter rather than adding a runtime package: bounded
filesystem range reads locate and validate ZIP32/ZIP64 central records; normalized paths reject
traversal and duplicate contested names; STORE and DEFLATE entries stream through checksum/CRC and
limit counters; encryption and unknown compression methods fail explicitly. Existing JSZip may
remain only on the creation side with streamed file inputs and streamed output. This avoids trusting
whole-buffer `loadAsync()`/entry materialization while retaining compatibility with archives the
project already creates.

**Rationale**: Conservative deterministic decoding protects identity stability and avoids hiding
corruption. Per-input limits satisfy defensive parsing even when the overall read context retains
only one completed session; an LRU alone cannot bound one enormous transcript, row, or archive. The
defaults leave high headroom for Cursor source carriers consumed by v0.16, whose normal
cursor-history backup entry count and compression ratio are small, while explicit per-operation
overrides avoid converting the defaults into hard compatibility ceilings. Before release, a
metadata-only preflight over maintainer-authorized live/custom Composer roots and cursor-history
backup ZIP/SQLite inputs records counts/sizes/ratios; any legitimate exceedance raises the v1
default before release so an unchanged incremental consumer needs no configuration. The downstream
vibe-history database/archive is validated only by owner-authorized external T113, not by the
recurring repository harness or this parser preflight.

**Alternatives considered**: Replacement decoding (changes content/identity); heuristic charset
detection (nondeterministic and adds dependency); whole-file JSONL/SQLite materialization (unbounded);
keeping whole-buffer JSZip extraction (a 16 GiB finite bound is not a practical memory bound); adding
a second ZIP dependency (unnecessary for the narrow existing STORE/DEFLATE backup contract); ZIP
extraction before limit checks (resource-exhaustion exposure).

## 20. Versioned compatibility matrix

**Decision**: Make the Matrix v1 table in [`spec.md`](spec.md) the sole normative finite source,
carrier, and preferred-orientation coverage contract. Keep
[`contracts/compatibility-matrix-v1.md`](contracts/compatibility-matrix-v1.md) as the design-time
projection, repeat the matrix in packaged `docs/compatibility.md`, and fail validation when any row
or cell in either projection drifts. Every `Required` cell is
release-blocking, every `Unsupported` cell has a tested typed outcome, and every `N/A` cell carries
a rationale. The current backup archive carrier is Composer-only; Store/merged coverage applies to
live and custom data roots, not to backup archives. Capability discovery cannot remove a required
cell. A materially new representation/carrier or changed supported outcome advances the matrix
version.

The live/custom row for a usable Store DB coexisting with a transcript is `Required`, not
`Unsupported`. The DB is the sole Store conversation backbone and the transcript remains visible
only as a `superseded` source instance. This is ordinary discovery/arbitration, not heuristic
content union and not a reason to reject an otherwise complete session. That complete result assumes
all known relevant Store occurrences are permitted by the active scope. Scope projection occurs
first: a known DB or transcript occurrence outside the default payload-I/O boundary is omitted,
never opened, and makes the scoped Store view explicitly partial even when it would normally be
superseded. Explicit selected-UUID cross-workspace loading may restore completeness only while
disclosing the broadened contributor.

**Rationale**: A dynamic phrase such as “all applicable combinations” lets the implementation
silently shrink its own test surface. A versioned finite table makes omissions and future scope
changes reviewable.

**Alternatives considered**: Full Cartesian product (includes impossible combinations and obscures
real gaps); implementation-discovered matrix (self-fulfilling); prose-only examples (not finite).

## 21. Corrective public search coordinates and additive export indices

**Decision**: Release 0.18.0 directly corrects the existing public-library `SearchResult` fields
whose v0.16 and v0.17 implementation returned placeholder or snippet-relative values.
`messageIndex` is the zero-based index of the matched message in the complete returned
`session.messages` array. `offset` is the zero-based UTF-16 code-unit offset of the first
case-insensitive match in that message's complete original `content`. `match` is the complete
original line containing that position; `contextBefore` and `contextAfter` are complete adjacent
original lines, bounded by the requested line count. Snippet truncation and ellipses remain an
internal/core CLI concern and never define public coordinates.

Lock both tagged releases by tag, commit, and source-blob identity. The correction suite covers a
non-first message, multiline content, mixed case, astral characters, and a lowercase mapping that
expands in UTF-16. It compares identity and all non-search session values separately and permits no
collateral change. Migration guidance tells consumers that persisted search coordinates from
v0.16/v0.17 must be recomputed after upgrading; they were not stable content identifiers.

Library JSON exports in 0.18.0 include an `index` whose base is the existing zero-based public-read
base. This is additive metadata: tagged v0.16 and v0.17 JSON exports omitted `index` entirely. The
single- and bulk-export projections must agree and must not mutate a shared core session object.
Accordingly, release notes must not describe this as correcting released one-based leakage; that
leak existed only on the unreleased feature branch.

**Rationale**: Keeping knowingly wrong search values under new aliases would leave existing callers
on the broken fields and create two competing coordinate systems. A narrow, versioned corrective
exception is easier to validate and migrate. UTF-16 explicitly matches JavaScript string indexing,
while complete source lines make `match` and context useful without coupling them to display
snippet width. Additive export metadata can adopt the already documented library base without a
breaking migration.

**Alternatives considered**: Preserve the wrong fields and add corrected aliases (permanent
ambiguity); define offsets inside snippets (not stable under context/truncation); count Unicode
scalar values (incompatible with JavaScript string offsets); call export `index` a v0.16/v0.17
correction (refuted by tagged output evidence); omit export indices forever (loses useful scoped
metadata).

## 22. Integrity-gated partial restore

**Decision**: Treat manifest size and checksum validation as the admission boundary for restore
publication. An entry is added to the staged restore set only after both checks pass. Every
non-directory ZIP entry other than `manifest.json` must appear exactly once in the manifest; an
empty manifest, unmanifested file entry, or archive with no intact restorable entry is rejected
before destination mutation. A mixed-validity archive restores its intact subset and reports every
size or checksum mismatch as skipped; it never copies a corrupt staged payload and never touches a
pre-existing destination for that entry, including with force enabled. Independently validate the
finite mapping from backup-file type to normalized path, reject duplicate/aliased destinations, and
preflight the complete destination set and its existing ancestors without following symlinks before
the first write.

Copy every admitted entry into a newly created private same-directory inode and publish by an atomic
directory-entry operation. Without force, a hard-link commit provides no-clobber semantics, so a
destination created after preflight wins with no overwrite. With force, rename atomically replaces
the destination entry without opening or truncating its old inode; if that inode has another hard
link, the other name and bytes are unaffected. After a non-force link commit, clean the private
publication sibling only while its no-follow device/inode identity still matches the committed
inode. A replacement occupant is never removed; a failed identity observation is reported as
unverified temporary residue rather than guessed safe-to-delete residue.

Snapshot an existing destination without following a leaf symlink. At each publication commit,
record the published device/inode identity. On a later failure, rollback first verifies that the
destination still names that exact inode. Only then may it republish prior bytes through the same
private-inode replacement path or remove a newly created leaf. A concurrent replacement is left
untouched and its manifest-relative entry is included in the typed residual set. If any prior state
cannot be restored, throw `RESTORE_ROLLBACK_INCOMPLETE` with the count of published entries and only
safe manifest-relative residual paths rather than returning a result that falsely says
`filesRestored: 0`.

Node 20 does not provide a portable `openat`-style directory descriptor API for binding every
ancestor and creating the destination relative to it. Canonicalize the explicitly selected user
root, reject links and non-directories beneath that trust boundary, preflight the complete set, and
repeat the descendant-chain check immediately before each directory-entry publication. Document
honestly that this handles static/dangling leaf links and multiply linked regular-file destinations
but cannot prove atomic resistance to a hostile local process swapping an ancestor in the final
check/commit interval. Restore destinations therefore remain an owner-controlled-tree requirement.
The separate final-backup permission step can and does bind its chmod to an already-open inode.

**Rationale**: Reporting a checksum mismatch while subsequently publishing the same bytes converts
an integrity warning into known data corruption. Filtering at admission makes validation and
mutation share one source of truth and preserves useful recovery from otherwise mixed archives.

**Alternatives considered**: Restore corrupt bytes after warning (unsafe); reject every mixed
archive (unnecessarily loses intact recovery); overwrite corrupt destinations with placeholders
(destructive and not present in the archive contract); trust the manifest's declared file type or
use a lexical `startsWith` confinement check (both permit off-contract or symlink-directed writes);
claim atomic ancestor-swap prevention without a directory-relative primitive (not technically
honest on the supported Node 20 runtime).
