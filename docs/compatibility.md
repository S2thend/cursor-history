# Compatibility and Data-Integrity Contract

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

This document is the canonical shipped compatibility contract for cursor-history. It applies to
the CLI, the public library, live and custom Cursor data roots, and supported cursor-history backup
archives. It describes values that archive and incremental-sync consumers may persist or compare.

Two versioned policies appear below:

- message identity version `1`; and
- Source Read Limits policy `source-read-limits/v1` and Compatibility Matrix v1.

Changing either policy's identity inputs, limits, source/carrier cells, or preferred orientation
requires an explicit version change, release warning, regression fixtures, and migration guidance.

## Stable identity and physical instances

`Session.id` is the native Cursor conversation UUID. It is the one public logical-session identity
and is preserved byte-for-byte. A workspace path, source kind, list index, Store location, backup
path, or duplicate occurrence is never appended to it.

A logical session can have several physical source instances: Composer global/workspace records,
Store databases, Store transcripts, or copies in different workspaces. Physical locators are
private implementation details. Public ambiguity diagnostics may contain an opaque occurrence
reference, but that reference is scoped to one read and is neither a path nor mutation authority.
Equivalent replicas reconcile into one logical row. Divergent same-role replicas produce one
explicit ambiguity; cursor-history never picks or unions them silently.

### Message and tool identity version 1

Composer identity is projected exactly as v0.16 did *before* Store alignment or semantic
interleaving:

- A nonempty native Composer message ID is preserved byte-for-byte.
- A Composer message without a native ID is `msg:<zero-based-v0.16-Composer-projection-index>`.
- A matched Composer/Store message always keeps the Composer identity, independent of which source
  supplies display order or enrichment.
- An unmatched Store database message is
  `store:v1:db:<lowercase-leaf-hash>:<one-based-occurrence>`.
- An unmatched Store transcript message is
  `store:v1:transcript:<sha256-canonical-json-v1>:<one-based-occurrence>`.
- A Store-only collision appends the smallest available `:collision:<n>`. It never rewrites a
  native or v0.16-compatible Composer identity.

Store occurrence numbers are assigned in deterministic source-native order before merging.
Transcript canonical input includes source-native role, content, structured tool activity, and
relationships, but excludes physical paths, discovery order, merged-array position, and inferred
display metadata. Presentation order can therefore change without changing identity.

Existing Composer tool-call order is also frozen. Matched Store calls enrich the corresponding
Composer slot and unmatched Store calls append in Store-native order. A source-native tool ID is
preserved; a new call without one receives
`tool:v1:<stable-message-id>:<canonical-input-hash>:<one-based-occurrence>`. The v0.16 downstream
message-plus-zero-based-tool-ordinal key therefore remains stable. Parent and branch references are
rewritten to the resolved stable message IDs.

Resolved sessions and messages expose `messageIdentityVersion: 1`. Identity never depends on
timestamps, workspace paths, read limits, filesystem metadata, or current wall-clock time.

The public-library converter also preserves the released v0.16 runtime shape of every pre-existing
optional `Message` member: `toolCalls`, `thinking`, `tokenUsage`, `model`, `durationMs`, and
`metadata` remain own properties even when their value is `undefined`. Identity and provenance
members are additive.

## Numeric indices and scope

Numeric indices are ephemeral presentation addresses, not identities:

| Interface | Numeric base | Scope |
|---|---:|---|
| CLI commands and core APIs | One-based | The exact listing data source, workspace, catalog snapshot, and invocation |
| Public-library read APIs (`listSessionSummaries`, `listSessions`, `getSession`, search, and export) | Zero-based | The exact library data source, workspace, catalog snapshot, and invocation |
| Public-library migration selectors | One-based | The prepared migration data source, workspace, and target set |

Do not translate or reuse a number across interfaces, a changed workspace filter, live versus
backup data, a custom data path, or a later catalog snapshot. Persist and reuse the native session
UUID instead. Unfiltered direct-ID behavior remains unchanged; a direct ID used with a workspace
must belong to that bound workspace or it fails without loading the off-scope conversation.

For unchanged Composer input, equal-`createdAt` rows retain the stable discovery order used by
v0.16. A Composer-backed merged or ambiguous row keeps that legacy tie position. Store-only and
other new rows without a v0.16 Composer position follow the legacy tie group and use native UUID as
their deterministic tie-break. This protects existing unfiltered numeric addresses for the tie
case without making numeric indices durable across later catalog changes.

Migration resolves both its one-based numeric selectors and native UUID selectors through this
complete scoped logical catalog, including ambiguous rows. An ambiguous row retains the number
shown by list and returns the same typed ambiguity (with the same safe UUID and opaque occurrence
references) by number or ID. It is never skipped, shifted, treated as not found, hydrated, or
mutated.

Every reusable structured index declares either:

```json
{ "index": 1, "indexScope": "global" }
```

or:

```json
{
  "index": 1,
  "indexScope": "workspace",
  "indexWorkspacePath": "/full/normalized/workspace-a"
}
```

`indexWorkspacePath` is required for workspace scope and absent for global scope. A custom data root
or backup remains part of the index lifetime even though its `indexScope` token is `global`.

## Workspace matching and payload I/O

Workspace paths are normalized lexically; historical and foreign-platform paths need not exist on
the current machine. Normalization handles supported file URIs, separators, dot segments,
non-root trailing separators, supported drive/WSL forms, and source-platform case rules.

Matching is deterministic:

1. A normalized exact path wins.
2. If no exact match exists, exactly one candidate whose complete trailing path components match
   is accepted as `unique-suffix`.
3. Multiple suffix candidates fail with `WORKSPACE_AMBIGUOUS` before conversation payload I/O.
4. No candidate returns an actionable empty result.

By default, a workspace is both a logical membership filter and a conversation-payload I/O
boundary. Lightweight global metadata may be read to discover UUIDs and memberships, but message
content, Store leaves, transcript lines, tools, code blocks, and attachments outside the selected
workspace are not opened. If a selected UUID has a known off-scope contributor, the result is
explicitly partial rather than silently presented as a complete single-source session.

The CLI `--include-cross-workspace-sources` and library
`includeCrossWorkspaceSources: true` opt in to complementary contributors only for UUIDs already
selected in the workspace. They do not scan unrelated conversation payload, and every broadened
source is disclosed.

`canonicalWorkspacePath` is the additive normalized full path. The public library's existing
`workspace` field preserves the released `coreSession.workspacePath` spelling, including v0.16's
`~/...` home contraction, so it can differ textually from `canonicalWorkspacePath` while identifying
the same Composer workspace. Selecting Store as the merge backbone cannot overwrite either Composer
attribution. `matchedWorkspacePath` reports the full membership selected by the filter.
`workspaceMemberships` and `sourceInstances` report normalized, deterministically ordered
memberships and source roles without exposing raw locators. A pathless core/CLI value is `null`; the
public-library compatibility alias is exactly `"unknown"`.

## Fidelity, provenance, and replacement safety

The legacy `source` field is a compatibility/fidelity signal:

- `source: "global"` means complete and safe for a whole-session replacement.
- `source: "workspace-fallback"` means partial/degraded and unsafe to overwrite a complete view.

It does **not** identify the current representation. Additive `resolvedSource` (`composer`,
`store-db`, `store-transcript`, `store-metadata`, or `merged`), `sources`, `preferredSource`,
`resolution`, `workspaceMemberships`, and `sourceInstances` carry actual provenance. Deprecated
v0.17 source literals remain accepted temporarily by TypeScript declarations, but corrective
runtime output uses the two fidelity values above.

When a usable Store database and a transcript coexist and all known relevant Store occurrences are
inside the permitted scope, this is a Required supported state. The database is the sole Store
conversation backbone; the transcript is retained as a `superseded` source instance for provenance.
cursor-history neither rejects this combination nor heuristically unions transcript content into
the usable database view. Scope projection happens first: a known DB or transcript outside the
default workspace payload-I/O boundary is omitted, never opened, and makes the scoped Store view
explicitly partial even if that representation would normally be superseded. Explicit selected-UUID
cross-workspace loading may restore completeness only while disclosing the broadened source.

A complete changed view is compared and replaced as a whole. The comparison covers ordered stable
message identities, roles, content, parent/branch relationships, consumed tool-call data, derived
code blocks, and supported attachment evidence. An unsupported raw attachment that cannot be
represented losslessly in consumed message/tool fields makes the result partial. cursor-history
does not dereference external attachment targets merely to identify or compare content.

A timestamp maximum is not an incremental-sync boundary: a valid new merged message can appear in
the middle or carry a fallback time older than a stored maximum. Consumers should compare the
complete replacement-safe view, not append only messages newer than `maxTimestamp`.

## Timestamp provenance

Every resolved public message has a deterministic timestamp/provenance pair. Direct source tokens
remain unchanged:

- `composer-created-at`
- `composer-timing`
- `store-turn-timing`

When a timestamp is missing, cursor-history uses the next directly stored timestamp if available
(`inferred-next`), otherwise the previous directly stored timestamp (`inferred-previous`), then a
deterministic source-derived session time (`session-fallback`), and finally the Unix epoch
(`unknown`). A legacy non-null time whose origin cannot be proved is preserved byte-for-byte as
`unknown` and is not used to infer neighboring messages. Inferred and unknown values never chain,
and filesystem mtime/read time is never used.

Session creation/update provenance is one of `composer-metadata`, `store-db-metadata`, `store-meta`,
`direct-message`, or `epoch-unknown`. Human output labels inferred values as approximate; JSON and
the library always return the timestamp with its provenance. Merge preference and workspace scope
do not change canonical session times.

### Explicitly versioned v0.16 fallback corrections

The corrective release preserves every v0.16 session/message/tool identity and every identity-to-
content, relationship, and tool binding. Three scalar fallback values may intentionally differ,
but only when the corresponding source value was absent:

- A message with no directly stored timestamp may replace v0.16's historical session-time fallback
  with the deterministic next/previous/session/epoch policy above and an explicit inferred source.
- When Composer stores neither `lastUpdatedAt` nor `updatedAt`, `metadata.lastModified` no longer
  uses v0.16's read-time-dependent value. It uses the deterministic session policy and exposes
  `lastUpdatedAtSource` as `direct-message` or `epoch-unknown`.
- A pathless Composer workspace no longer exposes v0.16's internal
  `(workspace: <directory-id>)` placeholder as a path. The public library returns `"unknown"`;
  core/CLI structured output returns `workspacePath: null` and omits canonical path metadata.

Compatibility certification for the full-session projection permits only those three
predicate-guarded scalar changes; the separate search-result coordinate correction below is not a
session projection or identity change. A changed
native or compatibility ID, message order/content binding, parent/branch relationship, tool binding,
direct source timestamp, stored Composer update time, or real workspace path is a regression.

### 0.18.0 public search-coordinate correction

v0.16 and v0.17 returned placeholder/snippet-relative values in existing public-library search
fields. 0.18.0 directly corrects those fields under a locked, versioned exception:

- `messageIndex` is the zero-based index of the matched message in the complete returned
  `session.messages` array;
- `offset` is the zero-based UTF-16 code-unit offset of the first case-insensitive match in that
  message's complete original `content`;
- `match` is the complete original source line containing that position; and
- `contextBefore` and `contextAfter` contain complete adjacent source lines, bounded by the
  requested line count.

Truncated display snippets, ellipses, mixed case, astral characters, and lowercase expansion do not
change the coordinate space. Consumers that persisted v0.16/v0.17 search coordinates must
recompute them after upgrading. These values are not identities; the correction changes no
session, message, or tool ID and no non-search session field.

Public-library JSON exports in 0.18.0 also include an additive zero-based session `index`, matching
the library read APIs. Tagged v0.16/v0.17 exports omitted `index`; there is no released one-based
export value to migrate.

## Defensive text decoding

Supported text is deterministic UTF-8 with at most one optional leading UTF-8 BOM. Unknown fields
that are not needed to understand a supported record are ignored. Invalid or mixed encoding is not
guessed, transcoded, or replacement-decoded because doing so could silently change content and
identity. `SOURCE_ENCODING_INVALID` is an explicit partial diagnostic only when a documented safe
contributor remains; otherwise it is fatal.

## Source Read Limits v1

**Policy identifier**: `source-read-limits/v1`

The defaults are inclusive: equality is accepted and the first raw byte, record, row, entry, or
ratio above a bound produces `SOURCE_LIMIT_EXCEEDED`.

| Field | Inclusive default | Counter scope |
|---|---:|---|
| `jsonlRecordBytes` | 67,108,864 bytes (64 MiB) | One nonempty record, excluding CR/LF |
| `jsonlSourceBytes` | 4,294,967,296 bytes (4 GiB) | One transcript, including BOM/newlines |
| `jsonlRecordCount` | 2,000,000 | Nonempty records in one transcript |
| `sqlitePageRows` | 256 rows | One keyset/row-ID metadata page |
| `sqlitePageBytes` | 268,435,456 bytes (256 MiB) | Declared payload bytes admitted to one page; payloads materialize sequentially |
| `sqliteValueBytes` | 134,217,728 bytes (128 MiB) | One SQLite text/blob value before materialization |
| `sqliteRowCount` | 5,000,000 rows | One logical-session hydration, reset separately for a metadata catalog scan |
| `sqliteDecodedBytes` | 8,589,934,592 bytes (8 GiB) | One logical-session hydration, reset separately for a metadata catalog scan |
| `zipCompressedBytes` | 17,179,869,184 bytes (16 GiB) | One archive container before loading |
| `zipEntryCount` | 65,536 central-directory records | One archive, including directory and duplicate records |
| `zipEntryBytes` | 8,589,934,592 bytes (8 GiB) | One entry's uncompressed streamed output |
| `zipAggregateBytes` | 17,179,869,184 bytes (16 GiB) | All uncompressed streamed output in one archive |
| `zipCompressionRatio` | 200:1 | Each nonempty entry and the aggregate |

One optional leading UTF-8 BOM counts toward source bytes and is stripped before record decoding.
JSONL counters reset for each transcript. SQLite page counters reset per page; row and decoded-byte
counters reset for each logical-session hydration and separately for a metadata catalog scan, after
the previous session is released. ZIP entry counters reset per entry and aggregate counters reset
per archive. Bulk operations do not accumulate these per-source/session/archive limits over the
whole corpus.

SQLite value lengths are checked before materialization and admitted payloads are fetched
sequentially after a bounded metadata page. ZIP central-directory claims are checked before
extraction and actual streamed output is checked again. ZIP ratio is
`uncompressed / max(compressed, 1)`; a zero-byte compressed representation claiming nonempty output
fails. Input data and manifests cannot raise a limit.

A limit failure never silently truncates a complete result. It is an actionable partial result only
when another documented safe contributor remains; otherwise it is fatal for that source/session or
archive. Any ZIP bound failure is fatal for archive read, validation, or restore. Temporary data is
cleaned on every path.

| Outcome | Stable code | Exit/stream contract |
|---|---|---|
| Invalid override, before source I/O | `SOURCE_LIMIT_CONFIGURATION_INVALID` | Usage-error category `2`; fatal JSON on stderr |
| Invalid/mixed encoding with a safe contributor | `SOURCE_ENCODING_INVALID` | Partial success `0`; diagnostic in the successful envelope |
| Limit exceeded with a safe contributor | `SOURCE_LIMIT_EXCEEDED` | Partial success `0`; diagnostic in the successful envelope |
| Fatal encoding or limit failure | `SOURCE_ENCODING_INVALID` or `SOURCE_LIMIT_EXCEEDED` | I/O-error category `4`; fatal JSON on stderr |

`SOURCE_LIMIT_EXCEEDED` details identify `policyVersion`, `sourceKind`, `bound`, `limit`,
`observedAtLeast`, `unit`, `outcome`, `retryableWithOverride: true`, and an actionable remedy. For
byte/count/row bounds, `observedAtLeast` is the first observed failing positive integer (normally
`limit + 1`); the first failing ZIP ratio is positive and may be fractional. Units are `bytes` for
byte bounds, `records` for JSONL-record/ZIP-entry counts, `rows` for SQLite row bounds, and `ratio`
only for compression ratio. Configuration-error details identify the invalid field, optional safe
primitive value, received type, violated constraint, and remedy. Diagnostics never expose source
content or a physical locator.

Overrides are explicit, positive safe integers for one operation. Omitted recognized library fields
or fields whose value is `undefined` inherit defaults; `null`, unknown own keys, and attempts to set
`policyVersion` fail before source content I/O with `SOURCE_LIMIT_CONFIGURATION_INVALID`. The final
map must satisfy:

- `jsonlRecordBytes <= jsonlSourceBytes`
- `sqlitePageRows <= sqliteRowCount`
- `sqliteValueBytes <= sqlitePageBytes <= sqliteDecodedBytes`
- `zipEntryBytes <= zipAggregateBytes`

A platform string must also fit the runtime's safe string limit. There is no `unlimited`, global,
environment-derived, input/manifest-driven, automatic-retry, or mutable override. Limits and
overrides do not affect identity, hashing, replica equivalence, deduplication, or incremental-sync
results.

When a caller supplies a pre-bound `readContext`, `sourceReadLimits` must have been fixed when that
context was created and must be omitted from the individual call. Supplying both fails before I/O
with `READ_CONTEXT_OPTIONS_MISMATCH`; an opaque effective map is never silently ignored or compared.

The repeatable CLI syntax is:

```bash
cursor-history --source-limit jsonlRecordBytes=128MiB \
  --source-limit jsonlSourceBytes=8GiB list --all
```

Byte fields accept decimal bytes or an exact `KiB`, `MiB`, or `GiB` suffix (powers of 1024).
Count/row/ratio fields accept decimal positive safe integers only. The CLI grammar is
`^[1-9][0-9]*(KiB|MiB|GiB)?$`; signs, fractions, exponents, whitespace, and alternate suffixes are
rejected, and suffixes are valid only for byte fields. Repeating different fields is allowed;
repeating the same field is an error.

The option applies to `list`, `show`, `search`, `export`, `migrate`, and `migrate-session`, plus
source-reading `backup`, `restore`, and `list-backups` paths when the named carrier bound is relevant.
An irrelevant field remains validated but does not alter another carrier.

The equivalent public-library override is passed on that operation only:

```ts
import { listSessions } from 'cursor-history';

const page = await listSessions({
  sourceReadLimits: {
    jsonlRecordBytes: 128 * 1024 * 1024,
    jsonlSourceBytes: 8 * 1024 * 1024 * 1024,
  },
});

console.log(page.pagination.total);
```

Raising a bound increases memory, CPU, disk, and decompression exposure. Raise only the field needed
for a trusted source, keep the override local to one operation, and do not retry automatically.
Unchanged consumers receive the defaults and need no override for the supported v0.16 upgrade path.

## SQLite driver capability

The v0.18.0 supported runtime majors are Node 20.x and 22.x–26.x. Node 20.0.0 remains the exact
project floor; Node 21 is not advertised because the packaged native SQLite dependency does not
support it. Driver choice is made per operation from the actual capabilities required (`read`,
`readWrite`, or `onlineBackup`), not merely from successful module import. In automatic mode,
cursor-history prefers `node:sqlite` when capable and otherwise falls back to an installed, capable
`better-sqlite3`. The `node:sqlite` online-backup API begins at Node 22.16.0 and 23.8.0; earlier
runtimes may import the module without that capability.

An explicitly forced driver never falls back. A missing capability produces
`DATABASE_CAPABILITY_MISSING`; no capable automatic provider produces
`NO_CAPABLE_DATABASE_DRIVER`. Both errors identify the operation, missing capabilities,
alternatives, and remedy without exposing data or physical locators. A Store snapshot capability
failure is fatal and is never swallowed into an empty/partial session or transcript fallback.

## Backup confidentiality and publication

Temporary plaintext SQLite snapshots and staging files live in an exclusive private workspace. On
POSIX, the directory is `0700` and files are `0600`; cleanup runs through normal, exceptional,
cancellation, and handled-signal paths. Conservative stale recovery only removes proven-dead,
owned cursor-history workspaces. `SIGKILL`, power loss, and kernel termination cannot guarantee
immediate cleanup, so the private directory protects any residue until the next safe recovery.

New final backup archives default to `0600` on POSIX. Force-overwriting an archive preserves its
existing mode unless sharing is explicitly requested. `--shared` or
`sharedPermissions: true` selects `0666 & ~currentUmask`; it never broadens temporary plaintext,
changes the process umask, or changes parent-directory permissions.

Rename/link to the requested final path is the publication commit point. If a subsequent mode read
or adjustment fails, the operation returns `BACKUP_PUBLISHED_PERMISSION_FAILED`. Its safe details
report `published: true`, the output path, `pathIdentityVerified`, requested mode, and the last mode
safely observed on the archive inode (or `null`). `published` means the commit point was crossed;
only `pathIdentityVerified: true` proves that the output path still names that inode and permits an
inspect/correct-mode remedy. When it is false, callers must treat the pathname as untrusted, must
not chmod it based on this error, and must establish which file—if any—is the completed archive.
The CLI exits nonzero; this is not proof of rollback and is not a reason to blindly retry with
`--force`. When the verified published inode already has the requested mode, cursor-history skips
`chmod`.
Permission handling is bound to the archive inode rather than only its pathname: cursor-history
opens the final path without following links, compares lossless device/inode identity with private
staging, changes mode only through that descriptor, and rechecks both descriptor and final path.
A nonregular target or replacement race returns the same typed post-publication failure and never
changes the replacement's permissions.
If non-force publication commits but its private sibling cannot be removed safely,
`BACKUP_PUBLISHED_CLEANUP_FAILED` reports output-path identity plus verified `residuePaths` and
`unverifiedResiduePaths`. Never blindly delete, chmod, or force-retry an unverified path; a
concurrent replacement is left untouched.

Restore uses the same integrity result for validation and mutation. It restores only entries whose
manifest size and checksum pass, reports integrity mismatches as skipped, and leaves skipped
destinations untouched even with `--force`. A mixed-validity archive may restore its intact subset;
an empty inventory or archive with no intact entries fails with zero writes. Unmanifested file
payloads, manifest type/path mismatches, duplicate destinations, non-forced collisions anywhere in
the validated destination set, and observed descendant symlink/path indirection are rejected.
`--force` permits replacement only after those integrity and confinement checks pass.
The selected Cursor user root is canonicalized and every descendant path is checked again before
publication. Non-force publication is atomic no-clobber. Forced replacement and rollback publish a
new owner-private same-directory inode, so they do not truncate a static hard-linked destination or
its off-root peer. If a later failure cannot roll every actually published entry back, cursor-history
throws `RESTORE_ROLLBACK_INCOMPLETE` with safe manifest-relative residual paths instead of reporting
zero remaining changes. Rollback first verifies the device/inode recorded at publication and leaves
a concurrently replaced leaf untouched while reporting it as residual. Because Node 20 has no
portable directory-relative no-follow creation API,
cursor-history does not claim atomic protection against a hostile local process swapping an
ancestor between the final check and directory-entry publication; use an owner-controlled tree.
This intentionally corrects v0.16/v0.17 behavior in which integrity warnings could still accompany
restored corrupt bytes. In v0.18.0, `filesRestored` counts only integrity-valid published entries and
warning paths identify skipped entries; callers must not infer that a warned entry was written.

On Windows, cursor-history uses the system per-user temporary directory, inherited access controls,
exclusive paths, and the same cleanup/error contract. This release does not claim independently
verified cross-user ACL isolation on Windows. The strict `0700`/`0600` owner-only guarantee is
therefore POSIX-qualified.

Backup manifests report the actual running package version as `producer`. That value is diagnostic
provenance only and never participates in identity, equivalence, deduplication, or synchronization.
Compatibility Matrix v1 supports Composer `state.vscdb` data in backup archives; Store databases,
transcripts, metadata-only rows, and merged source sets are not present in that carrier.

## Upgrade guidance for incremental consumers

### v0.16 Composer-only archive to v0.18.0

This is the confirmed no-consumer-change path, including consumers such as vibe-history whose
existing archive contains only output produced by cursor-history v0.16:

1. Keep a restorable copy of the existing downstream archive and pin its known v0.16 baseline.
2. Upgrade cursor-history without changing the consumer's session, message, or tool key logic.
3. On the first read, every old Composer-derived key is byte-for-byte unchanged. A complete
   Composer-backed merged result continues to report `source: "global"`; actual provenance is
   additive (`resolvedSource: "merged"`, `sources`, and `resolution`).
4. If the complete view changed, the unchanged consumer's existing transaction replaces the whole
   session atomically. cursor-history supplies the replacement-safe view and signal; the consumer,
   not cursor-history, owns downstream deletion/insertion, commit, and rollback.
5. Repeat the same synchronization. Identical input produces zero additional writes.

Store-only insertions may appear at the start or middle, matched messages may gain content/tool
enrichment, and parent/branch metadata may change without changing old keys. Do not gate this sync
on `maxTimestamp`; compare the complete view. A partial `workspace-fallback` result must never
overwrite a complete archived session.

The guarantee is deliberately limited to a v0.16 Composer-only archive becoming a complete
Composer-backed merged session. It is not a general promise for every Store-only or cross-format
transition.

### v0.17 Store/merged data

v0.17 introduced transitional Store, merged-source, positional-message, and timestamp behavior.
Projects that persist cursor-history library output for incremental backup should pin v0.16 or
validate the 0.18.0 corrective transition before upgrading.

For a complete affected v0.17 Store/merged fixture, the corrective path is one whole-session
replacement, no duplicate logical content, and no writes on the next unchanged sync. Unstable v0.17
Store positional or cross-format synthetic IDs are not preserved. A degraded v0.17 input or
corrective view must not replace complete data; pin, retry with a complete source, or migrate
manually. Back up the downstream archive before this one-time convergence.

## Fatal JSON stream migration from v0.17

Some v0.17 command-owned fatal JSON branches wrote their error object to stdout. In 0.18.0, every
fatal JSON object is written to stderr and stdout is empty. Successful result bytes
remain on stdout; nonfatal best-effort diagnostics remain inside their successful JSON envelope.
Existing human-readable fatal errors already use stderr.

For a locked failure fixture, pre-existing error field names, types, values, and exit-category
meaning remain unchanged. Safe `code` and `details` fields may be added, so whole-object byte
equality is not promised. Scripts that parsed fatal JSON from stdout must migrate:

```bash
if cursor-history --json show "$SESSION_ID" >result.json 2>error.json; then
  jq . result.json
else
  jq . error.json >&2
fi
```

## Executable addressing examples

Round-trip a one-based CLI index only under the same workspace and data source:

```bash
cursor-history --json --workspace /work/a list --all
cursor-history --json --workspace /work/a show 1
cursor-history --json --workspace /work/a search needle-a
cursor-history --json --workspace /work/a export 1 --format json
```

Load complementary sources only for already selected UUIDs, preview a safely bound migration, and
choose final archive permissions explicitly:

```bash
cursor-history --workspace /work/a --include-cross-workspace-sources show 1
cursor-history --workspace /work/a migrate-session 1 /work/destination --dry-run
cursor-history backup
cursor-history backup --shared
```

Public-library read indices are zero-based, but IDs are the reusable address:

```ts
import { getSession, listSessions } from 'cursor-history';

const workspace = '/work/a';
const page = await listSessions({ workspace, limit: 20 });
const first = page.data[0];

if (first) {
  const session = await getSession(first.id, { workspace });
  console.log({
    id: session.id,
    fidelity: session.source,
    representation: session.resolvedSource,
    messageCount: session.messageCount,
  });
}
```

## Compatibility Matrix v1

`Required` cells are release-blocking scenarios. `Unsupported` cells describe behavior the product must reject rather than silently approximate. `N/A` means the carrier cannot contain that representation under the supported contract. Supported backup archives capture Composer `state.vscdb` data only; they do not capture Store databases, Store transcripts, Store metadata, or merged source sets.

| Source representation or resolution scenario | Live default path | Custom data path | Supported backup | Expected result / preferred orientation |
|---|---|---|---|---|
| Composer global | Required | Required | Required | Complete Composer |
| Composer workspace fallback | Required | Required | Required | Degraded Composer fallback |
| Store database conversation | Required | Required | N/A | Complete Store database |
| Store transcript with no discovered or expected database | Required | Required | N/A | Complete transcript primary |
| Store transcript fallback after capable DB setup: expected DB absent, empty, or source-corrupt/unreadable | Required | Required | N/A | Degraded transcript fallback |
| Usable Store database coexists with a Store transcript and all known relevant Store occurrences are permitted | Required | Required | N/A | Complete Store database backbone; transcript retained as superseded provenance |
| Workspace-scoped Store UUID has a known database or transcript occurrence outside the default I/O boundary | Required | Required | N/A | Explicit partial Store view; off-scope representation omitted and never opened, even when otherwise superseded |
| Complete Composer/Store merge, Composer-preferred ordering | Required | Required | N/A | Complete merged, Composer-preferred |
| Complete Composer/Store merge, Store-preferred ordering | Required | Required | N/A | Complete merged, Store-preferred |
| Scoped merged UUID with a known contributor outside the default workspace I/O boundary | Required | Required | N/A | Explicit partial with omitted contributor; never silent single-source completeness |
| Scoped merged UUID with explicit selected-UUID cross-workspace contributor opt-in | Required | Required | N/A | Complete merged with every broadened contributor disclosed |
| Store metadata indicating a possible conversation but no usable payload | Required | Required | N/A | Metadata-only degraded row |
| Equivalent same-role Composer replicas | Required | Required | Required | One reconciled logical row |
| Divergent same-role Composer replicas | Required | Required | Required | One unresolved ambiguity row |
| Equivalent same-role Store replicas | Required | Required | N/A | One reconciled logical row |
| Divergent same-role Store replicas | Required | Required | N/A | One unresolved ambiguity row |
| Automatic selection or union of divergent replicas | Unsupported | Unsupported | Unsupported | Reject; never resolve silently |

Adding a source representation, carrier, or preferred-orientation rule requires a new matrix
version or an explicit classification of every new cell before release. Every `Required` cell needs
an executable fixture, every `Unsupported` cell needs a rejection test, and `N/A` cells must not be
reported as successful supported coverage.
