# CLI and Structured Output Contract

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

**Command**: `cursor-history`<br>
**Feature**: `016-harden-session-integrity`

## Global addressing and scope options

```text
--json
--data-path <path>
-w, --workspace <path>
--include-cross-workspace-sources
--source-limit <field>=<IEC-size-or-integer>  # repeatable
```

- `--workspace` accepts a normalized full historical path or one unambiguous component suffix.
- Normalized exact match wins. A unique suffix is used only when exact matching finds none.
- Ambiguous suffixes fail before conversation payload is opened.
- By default the workspace is both the logical membership scope and conversation-payload I/O
  boundary.
- `--include-cross-workspace-sources` may broaden reads only to contributors of UUIDs already
  selected in scope. It never scans unrelated conversation payload and discloses every broadened
  contributor.
- `--source-limit` raises or lowers one documented Source Read Limits v1 field for this invocation.
  Byte fields accept decimal bytes or an exact `KiB`, `MiB`, or `GiB` suffix using powers of 1024;
  count/row/ratio fields accept decimal positive safe integers only. Values use
  `^[1-9][0-9]*(KiB|MiB|GiB)?$`: no sign, decimal fraction, exponent, whitespace, or alternate
  suffix is accepted. Repeating the flag for different fields is allowed; repeating one field is
  rejected rather than silently taking a discovery-order winner. Unknown fields and
  `policyVersion` are rejected. The final map is validated and frozen before source content I/O.
  There is no `unlimited` value and no global,
  environment-derived, input/manifest-driven, or automatic-retry override. Raising a bound can
  increase resource exposure; it never changes identity or deduplication semantics.

`source-read-limits/v1` uses these exact inclusive defaults; equality passes:

| Field | Inclusive default |
|---|---:|
| `jsonlRecordBytes` | `67_108_864` |
| `jsonlSourceBytes` | `4_294_967_296` |
| `jsonlRecordCount` | `2_000_000` |
| `sqlitePageRows` | `256` |
| `sqlitePageBytes` | `268_435_456` |
| `sqliteValueBytes` | `134_217_728` |
| `sqliteRowCount` | `5_000_000` |
| `sqliteDecodedBytes` | `8_589_934_592` |
| `zipCompressedBytes` | `17_179_869_184` |
| `zipEntryCount` | `65_536` |
| `zipEntryBytes` | `8_589_934_592` |
| `zipAggregateBytes` | `17_179_869_184` |
| `zipCompressionRatio` | `200` |

Limit diagnostics pair fields exactly: JSONL/SQLite/ZIP byte bounds use `bytes`; JSONL record and
ZIP entry counts use `records`; SQLite page/total row bounds use `rows`; only
`zip-compression-ratio` uses `ratio`. Byte/count/row observations are positive integers. A first
failing ZIP ratio observation is a positive number and may be fractional.

- Addressing/scope options apply uniformly to `list`, `show`, `search`, `export`, `migrate`, and
  `migrate-session`. `--source-limit` also applies to source-reading `backup`, `restore`, and
  `list-backups` paths where the named carrier bound is relevant; irrelevant fields remain harmless
  validated configuration rather than changing another carrier's behavior.

Numeric CLI and migration indices are one-based. An index is ephemeral and valid only with the same
data path/backup, workspace scope, and catalog snapshot that produced it. Once selected, the command
uses the bound UUID and occurrence set rather than resolving the number again.

## Common structured fields

Every JSON item containing a reusable `index` contains exactly one of:

```json
{
  "index": 1,
  "indexScope": "global"
}
```

or:

```json
{
  "index": 1,
  "indexScope": "workspace",
  "indexWorkspacePath": "/full/normalized/workspace-a"
}
```

`indexWorkspacePath` is required for `workspace` scope and absent for `global` scope. Physical
locators are never included.

Resolved session/summary objects may add:

```json
{
  "source": "global",
  "resolvedSource": "merged",
  "sources": ["composer", "store"],
  "preferredSource": "store",
  "resolution": {
    "state": "complete",
    "expectedSourceRoles": ["composer", "store"],
    "loadedSourceRoles": ["composer", "store"],
    "omittedSourceRoles": [],
    "failedSourceRoles": [],
    "reasonCodes": []
  },
  "canonicalWorkspacePath": "/work/a",
  "matchedWorkspacePath": "/work/a",
  "workspaceMatchKind": "exact",
  "workspaceMemberships": [
    {
      "workspacePath": "/work/a",
      "sourceRoles": ["composer", "store"],
      "contributingInstanceCount": 2
    }
  ],
  "sourceInstances": [
    {
      "sourceRole": "composer",
      "representation": "composer-global",
      "workspacePaths": ["/work/a"],
      "state": "contributed"
    },
    {
      "sourceRole": "store",
      "representation": "store-db",
      "workspacePaths": ["/work/a"],
      "state": "contributed"
    }
  ],
  "messageIdentityVersion": 1
}
```

The compatibility `workspacePath` remains the canonical path. `source` is fidelity:
`global` means complete/replacement-safe; `workspace-fallback` means partial/unsafe to overwrite
complete data. Actual representation is `resolvedSource`, including `store-metadata` when Store
metadata indicates a possible conversation but no conversation representation is usable. Every
resolved session also emits `createdAt`, `createdAtSource`, `lastUpdatedAt`, and
`lastUpdatedAtSource`; source values are `composer-metadata`, `store-db-metadata`, `store-meta`,
`direct-message`, or `epoch-unknown`.

When no canonical path is known, core/CLI JSON emits `"workspacePath": null` and omits
`canonicalWorkspacePath`. This is intentionally distinct from the public-library compatibility
alias `workspace: "unknown"`.

All set-like arrays are canonical before formatting: source roles are `composer`, then `store`;
reason codes follow declaration order; workspace memberships and every required source-instance
`workspacePaths` use normalized-path code-point order; source instances sort by role,
representation declaration order, lexicographic `workspacePaths`, then state declaration order;
and diagnostic refs sort by stable payload fingerprint with opaque-ref tie-breaker. Pathless source
instances emit `workspacePaths: []`. Formatters never apply discovery order.

This canonical ordering does not replace the released Composer catalog order. Equal-`createdAt`
Composer-backed rows retain the v0.16 workspace discovery ordinal produced by
`String.localeCompare()` before the stable timestamp sort. Only rows without that legacy ordinal
use the new code-point/UUID tie-break.

## `list --json`

The existing top-level object remains and gains additive scope and diagnostics fields:

```json
{
  "count": 2,
  "indexScope": "workspace",
  "indexWorkspacePath": "/work/a",
  "sessions": [
    {
      "index": 1,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "id": "native-session-uuid",
      "title": "Example",
      "preview": "First user message…",
      "messageCount": 4,
      "source": "global",
      "resolvedSource": "merged",
      "sources": ["composer", "store"],
      "preferredSource": "store",
      "resolution": {
        "state": "complete",
        "expectedSourceRoles": ["composer", "store"],
        "loadedSourceRoles": ["composer", "store"],
        "omittedSourceRoles": [],
        "failedSourceRoles": [],
        "reasonCodes": []
      },
      "createdAt": "2026-08-05T12:00:00.000Z",
      "createdAtSource": "composer-metadata",
      "lastUpdatedAt": "2026-08-05T12:10:00.000Z",
      "lastUpdatedAtSource": "direct-message",
      "workspacePath": "/canonical/path",
      "canonicalWorkspacePath": "/canonical/path",
      "matchedWorkspacePath": "/work/a",
      "workspaceMatchKind": "exact",
      "workspaceMemberships": [
        {
          "workspacePath": "/work/a",
          "sourceRoles": ["composer", "store"],
          "contributingInstanceCount": 2
        }
      ],
      "sourceInstances": [
        {
          "sourceRole": "composer",
          "representation": "composer-global",
          "workspacePaths": ["/work/a"],
          "state": "contributed"
        },
        {
          "sourceRole": "store",
          "representation": "store-db",
          "workspacePaths": ["/work/a"],
          "state": "contributed"
        }
      ],
      "messageIdentityVersion": 1,
      "resolutionState": "complete"
    },
    {
      "index": 2,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "id": "ambiguous-native-uuid",
      "resolutionState": "ambiguous",
      "sourceRoles": ["composer"],
      "occurrenceCount": 2,
      "diagnosticOccurrenceRefs": ["occurrence:opaque-a", "occurrence:opaque-b"]
    }
  ],
  "diagnostics": [
    {
      "code": "SESSION_AMBIGUOUS",
      "message": "The logical session has divergent Composer replicas.",
      "sessionId": "ambiguous-native-uuid",
      "occurrenceCount": 2,
      "occurrenceRefs": ["occurrence:opaque-a", "occurrence:opaque-b"],
      "remedy": "Resolve the duplicate data outside this command and retry."
    }
  ]
}
```

An ambiguous row has no contested preview/title/message payload. Empty output retains
`{"count":0,"sessions":[]}` and adds the active scope fields plus an actionable diagnostic when the
workspace did not match.

Each non-ambiguous list item is exactly a `ResolvedSessionSummary`: the full resolved metadata plus
required `title`, `preview`, `messageCount`, and `resolutionState`, with no `messages` key.
`resolutionState` equals `resolution.state`.

`count` is the number of scoped logical rows represented by `sessions`, including one row per
ambiguous UUID; it is not the count of successfully hydrated conversation payloads.

`list --workspaces --json` counts one logical UUID once per membership. A multi-membership session
may count once in both A and B, so the sum can exceed the deduplicated global total.

## `show --json`

`show` returns the existing single-session object with additive index, path, fidelity, provenance,
resolution, and identity fields. Every emitted message has:

```json
{
  "id": "stable-message-id",
  "messageIdentityVersion": 1,
  "identityOrigin": "composer-native",
  "role": "assistant",
  "content": "...",
  "timestamp": "2026-08-05T12:00:00.000Z",
  "timestampSource": "composer-timing",
  "parentMessageId": "stable-parent-id",
  "toolCalls": [
    {
      "id": "native-or-tool-v1-id",
      "identityOrigin": "source-native",
      "name": "read_file",
      "status": "completed"
    }
  ]
}
```

The three released direct timestamp-source literals are unchanged. New values are
`inferred-previous`, `inferred-next`, `session-fallback`, and `unknown`. JSON always contains a
timestamp/provenance pair for resolved messages.

Every emitted runtime/JSON tool call contains a nonempty `id` and `identityOrigin`. Source
attachment evidence has no new JSON member: supported evidence is projected losslessly into message
`content` (including fenced code) or consumed tool-call `name`, `status`, `params`, `result`, and
`error` fields. Standalone cursor-history `codeBlocks` and tool-call `files` do not satisfy the
unchanged-consumer compatibility contract. An unrepresentable raw block makes the session partial,
and parsing/hashing never dereferences its external target.

A partial session still returns successfully but includes `source: "workspace-fallback"`,
`resolution.state: "partial"`, and reasons. Human output prints a visible warning before the
conversation. An ambiguous UUID/index is a fatal typed error and yields no fake empty session.

## `search --json`

The existing envelope remains:

```json
{
  "query": "needle-a",
  "count": 1,
  "totalMatches": 1,
  "indexScope": "workspace",
  "indexWorkspacePath": "/work/a",
  "results": [
    {
      "index": 1,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "sessionId": "native-session-uuid",
      "workspacePath": "/canonical/path",
      "matchedWorkspacePath": "/work/a",
      "matchCount": 1,
      "snippets": []
    }
  ],
  "diagnostics": []
}
```

Search opens only permitted payload. Each ambiguous group is skipped once and produces exactly one
diagnostic. `count` and `totalMatches` count resolved search results only. An empty result preserves
the existing envelope and includes scope/diagnostics.

CLI snippet `matchPositions` remain relative to each displayed snippet for highlighting. They are
not the public-library `SearchResult.offset`. In 0.18.0 the library directly corrects its released
fields to use the complete returned message array, complete original content in UTF-16 code units,
and complete original source lines; the CLI envelope and its one-based session row address retain
their existing bases.

## `export --json`

Each export-result file item gains its bound address:

```json
{
  "count": 1,
  "files": [
    {
      "index": 1,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "sessionId": "native-session-uuid",
      "path": "/exports/session.json"
    }
  ],
  "diagnostics": []
}
```

Single export fails for ambiguity. `--all` skips each ambiguity exactly once, reports it once, and
never writes a file for contested payload. Partial JSON/Markdown export is permitted only with an
explicit fidelity warning embedded in the output; it never presents itself as complete.

The session JSON written to disk contains the same identity, index-scope, path, resolution,
timestamp, relationship, and tool metadata as `show --json`. Markdown includes human-readable
fidelity and approximate-timestamp labels.

This CLI file-result/session index remains one-based. Separately, JSON strings returned by the
public-library export functions add a zero-based session `index`; tagged v0.16/v0.17 library
exports omitted that key, so this is additive metadata rather than a released-value correction.

## `migrate-session`

The command consumes the parent `--workspace` option:

```bash
cursor-history --workspace /work/a migrate-session 1 /work/destination --dry-run
cursor-history --workspace /work/a migrate-session 1 /work/destination
```

Dry-run and execution share one target preparation contract. A scoped number selects the row shown
by scoped list, then binds an exact eligible Composer occurrence. Execution revalidates the same
occurrence/fingerprint and refuses any change before the first write.

Canonical UUID syntax is case-insensitive only at the logical selection layer. The prepared target
retains the Composer-compatible public spelling plus the exact workspace record ID and exact global
SQLite key; apply reads and mutates only those frozen source spellings. A sole opposite-case global
carrier is eligible, but multiple case-only global keys produce a typed pre-write refusal.
Noncanonical identifiers, including compact 32-hex Store directory names, remain byte-sensitive.

Scoped preparation may inspect off-scope ID/index/selected-ID/pane-pointer metadata needed for
membership, but it never loads an off-scope `composer.composerData` value. Only the selected
occurrence is hydrated. Workspace-wide and multi-selector migration prepare every member before the
first mutation, so one missing, ambiguous, divergent, changed, or ineligible member leaves all
sources and destinations unchanged in both dry-run and apply.

The one-based migration catalog includes ambiguous logical rows. Selecting such a row by its shown
number returns the same `SESSION_AMBIGUOUS` details as selecting its UUID; the row is not omitted,
later numbers do not shift, and neither selector reads or writes contested content.

Equivalent duplicate physical locators, a global record shared with another workspace membership,
Store-only, merged, and divergent sessions fail in preview and execution. A read representative or
diagnostic occurrence reference cannot bypass this refusal. Unfiltered numeric and direct native-ID
behavior for an eligible single-occurrence Composer session remains compatible.

JSON migration results add `sessionId`, normalized source/matched paths, eligibility, and dry-run
precondition summary, but never a locator. A changed target returns `MIGRATION_TARGET_CHANGED`.
`sessionId` always uses the bound source-native Composer spelling rather than caller casing.

## `backup`

Add:

```text
--shared    Create the final archive with explicitly broader platform-default access
```

Without `--shared`, a newly created final archive is owner-only (`0600` on POSIX). Force-overwrite
preserves an existing mode exactly. On POSIX, `--shared` explicitly selects the ordinary
non-executable mode `0666 & ~currentUmask`. Temporary plaintext snapshots/staging remain owner-only
even when the final archive is shared, and no command changes the process umask. On Windows the
operation uses the system per-user temporary location, inherited access controls, exclusive paths,
and the same cleanup guarantees without claiming independently verified cross-user ACL isolation.

Every newly created manifest reports the exact running package version as `producer`; older or
missing producer values remain readable. The field is diagnostic provenance and does not affect
session/message identity, replica equivalence, deduplication, or incremental synchronization.
The optional Composer workspace inventory is an additive v1 member: the enclosing
`manifest.version` remains `1.0.0`, while the inventory independently reports and validates
`schemaVersion: 1`. Legacy v1 manifests may omit it.

Rename/link to the final output path is the publication commit point. If a later permission read or
identity/adjustment step fails, the CLI exits nonzero with a fatal
stderr object whose `code` is `BACKUP_PUBLISHED_PERMISSION_FAILED`. Safe `details` contain
`published: true`, `outputPath`, `pathIdentityVerified`, `requestedMode`, and `actualMode`, which is
the last safely observed staged-archive inode mode or `null` and never a possible replacement-path
mode. Publication always crossed its commit point. Only `pathIdentityVerified: true` proves that
`outputPath` still names the completed archive and permits inspect/correct advice for that file; a
false value makes the path untrusted and requires identity recovery first. The command neither
claims rollback nor advises a blind `--force` retry. If the verified published mode already equals
the requested mode, no permission-change call is made.
The permission step is bound to the published regular-file inode rather than merely the pathname:
no-follow open, lossless device/inode comparison, descriptor-only mode adjustment, and final
descriptor/path revalidation prevent a replacement path from receiving the chmod. Identity or
nonregular-path failure uses the same typed nonzero post-publication result.

If non-force link publication commits but its private sibling name cannot be removed safely, the CLI
instead emits `BACKUP_PUBLISHED_CLEANUP_FAILED`. Its details contain `published: true`,
`outputPath`, output `pathIdentityVerified`, `residuePaths` only for names verified to remain bound
to the completed archive inode, and `unverifiedResiduePaths` for names whose identity could not be
established. The CLI never deletes or chmods a replacement occupant, never treats an unverified path
as safe to remove, and never recommends blind deletion, chmod, or `--force` retry.

## Diagnostics and fatal errors

Successful/best-effort commands put nonfatal diagnostics in their existing stdout JSON envelope.
Existing human-readable fatal errors continue to use stderr. Every fatal JSON object is written to
stderr. For a fatal branch that already emits
a JSON error object, the same locked failure fixture retains every pre-existing field name, type,
and value and the same exit-category meaning; `code` and safe `details` are additive, so the entire
object is not required to remain byte-for-byte identical:

```json
{
  "error": "The logical session has divergent Composer replicas.",
  "code": "SESSION_AMBIGUOUS",
  "details": {
    "sessionId": "native-session-uuid",
    "sourceRole": "composer",
    "occurrenceCount": 2,
    "occurrenceRefs": ["occurrence:opaque-a", "occurrence:opaque-b"]
  }
}
```

No error details contain content or a raw physical locator. Built-CLI fixtures first lock the v0.17
object/exit baseline, then assert the intentional versioned transition of every fatal JSON object
from stdout to stderr. The release warning and migration guide tell scripts that previously parsed
fatal JSON from stdout to read stderr instead. Successful result bytes remain on stdout.

The fatal-path coverage inventory is closed over the command registry, not a hand-picked sample. It
includes `list`, `show`, `search`, `export`, `migrate`, `migrate-session`, `backup`, `restore`, and
`list-backups`, plus root option/usage parsing, command-loading failures, not-found failures, I/O
failures, and unexpected typed failures. Every registered command maps each reachable fatal JSON
category to a built-process fixture or a registry-backed proof. Adding a command or fatal category
without such coverage fails the release gate. This inventory is separate from Compatibility Matrix
v1, which covers source representations and carriers.

Restore warnings are successful result data, not fatal diagnostics. For a mixed-validity archive,
structured and human output report every size- or checksum-mismatched path as skipped and
`filesRestored` counts only integrity-valid entries. A corrupt entry never modifies its destination,
including under `--force`; an empty/no-intact archive, an unmanifested non-directory entry, or an
unsafe/ambiguous destination layout follows the existing restore-failure category before mutation.
Each valid payload is published from a private same-directory inode: `--force` atomically replaces
the directory entry without writing through an existing hard link, and non-force atomically refuses
to clobber a destination created after preflight. Private sibling cleanup is device/inode-bound and
never unlinks a replacement occupant. After any publication, a later failure performs no automatic
destination rollback because portable Node path APIs cannot atomically bind an identity comparison
to replace or unlink. Every current leaf remains untouched. The fatal stderr object uses
`RESTORE_ROLLBACK_INCOMPLETE` and safe details `publishedFileCount`, `residualFileCount`,
manifest-relative `residualFiles`, verified `residueCount`/`residuePaths`, unverified
`unverifiedResidueCount`/`unverifiedResiduePaths`, and `remedy`; unverified classification dominates
for the same temporary path. It does not emit a misleading result with `filesRestored: 0` and
directs recovery from a known-good backup. Static leaf links are rejected and other hard links to a
forced destination remain unchanged. The documented owner-controlled-tree limitation still
excludes a hostile concurrent ancestor swap on runtimes without directory-relative no-follow
creation.

| Category | Exit code |
|----------|-----------|
| Existing success category | 0 |
| Existing general-error category | 1 |
| Existing usage-error category | 2 |
| Existing not-found category | 3 |
| Existing I/O-error category | 4 |
| `SOURCE_LIMIT_CONFIGURATION_INVALID` | 2 (usage error) |
| `BACKUP_PUBLISHED_CLEANUP_FAILED` | 4 (I/O error) |
| `RESTORE_ROLLBACK_INCOMPLETE` | 4 (I/O error) |
| Fatal `SOURCE_ENCODING_INVALID` | 4 (I/O error) |
| Fatal `SOURCE_LIMIT_EXCEEDED` | 4 (I/O error) |
| Explicit safe-fallback partial result for encoding/limit diagnostics | 0 (successful result envelope) |

The table names the existing exit categories for new typed failures; it does not authorize an
unversioned category remap. The explicit source-policy rows fix categories for newly introduced
codes. Human-readable fatal errors and warnings use stderr; successful content uses stdout.

`SOURCE_ENCODING_INVALID` and `SOURCE_LIMIT_EXCEEDED` follow the same rule. Invalid/mixed encoding
is never guessed or replacement-decoded, and oversized JSONL/SQLite/ZIP input is never silently
truncated into a complete result. A safe fallback may produce an explicit partial success envelope;
otherwise one fatal JSON object is emitted on stderr.

`SOURCE_LIMIT_EXCEEDED` safe `details` contain `policyVersion`, `sourceKind`, `bound`, `limit`,
`observedAtLeast`, `unit`, partial/fatal `outcome`, `retryableWithOverride: true`, and a remedy. When
a streaming reader cannot cheaply know the final size, `observedAtLeast` is the first observed
failing value, normally integer `limit + 1` for byte/count/row bounds; for
`zip-compression-ratio` it is the exact first positive failing ratio and may be fractional. Invalid,
fractional, non-finite, unsafe-integer, zero,
negative, cross-field-inconsistent, or runtime-unmaterializable overrides fail before content I/O as
`SOURCE_LIMIT_CONFIGURATION_INVALID`; its safe `details` contain `invalidField`, optional primitive
`invalidValue`, `receivedType`, `violatedConstraint`, and `remedy`. Neither error exposes source
content or a physical locator.

## Message-type rendering

- An error or thinking message retains its true category even when it has structured tool calls.
- `--message-type error` and `--message-type thinking` select those messages by category.
- Structured tool calls remain visible in table, JSON, and export renderers for those categories.
- The presence of a tool call does not reclassify the whole message as `tool`.

## Required help examples

The shipped `--help` and README include at least:

```bash
# Round-trip a workspace-scoped one-based index
cursor-history --json --workspace /work/a list --all
cursor-history --json --workspace /work/a show 1

# Search without reading unrelated workspace payload
cursor-history --json --workspace /work/a search needle-a

# Explicitly include complementary contributors of already selected UUIDs
cursor-history --workspace /work/a --include-cross-workspace-sources show 1

# Preview a safely bound Composer-only migration
cursor-history --workspace /work/a migrate-session 1 /work/destination --dry-run

# Request a shared final archive; private is the default
cursor-history backup --shared
```

Every public command and option has complete shipped help. Each CLI example in shipped README/help
is executed against the built CLI, and the same frozen structured-output schema is validated against
the built CLI and exact packed artifact. The finite source/carrier cases are normative in
[`../spec.md`](../spec.md), repeated in the design-time
[`compatibility-matrix-v1.md`](compatibility-matrix-v1.md), and shipped in
`docs/compatibility.md`; matrix v1 supports Composer-only backup archives.
