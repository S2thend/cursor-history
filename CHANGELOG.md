# Changelog

All notable changes to this project will be documented in this file.

## [0.18.0] - 2026-08-13

This is the corrective release following v0.17.0. Its canonical compatibility and migration
contract is [docs/compatibility.md](./docs/compatibility.md).

### Added

- **Versioned identity and provenance**: Added message identity version 1, stable Store-only
  namespaces, explicit `resolvedSource`/`sources`/`resolution`, workspace membership/source-instance
  metadata, and timestamp provenance without changing native Cursor session IDs.
- **Self-describing scoped indices**: Structured numeric results now identify global/workspace scope
  and the resolved workspace path. Logical summary rows separate public UUIDs from private physical
  instances and report replica ambiguity rather than silently selecting content.
- **Bounded source reads**: Added deterministic UTF-8/BOM handling and the inclusive
  `source-read-limits/v1` policy for JSONL, SQLite, and ZIP inputs, with validated per-operation CLI
  and library overrides.
- **Release compatibility gates**: Added locked v0.16/v0.17 fixtures and a recurring
  cursor-history-owned key/binding, complete/degraded replacement, and idempotence contract. Exact
  unchanged-consumer adapter, digest, SQLite transaction, rollback/reopen/retry, and repeated-sync
  certification remains an owner-authorized external pre-release gate. Exact-package validation and
  a fail-closed publish path prevent unverified bytes from being released.

### Changed

- **Fidelity versus provenance**: Corrective runtime output uses legacy `source: "global"` for a
  complete replacement-safe view and `source: "workspace-fallback"` for a partial view. Actual
  Composer/Store representation is additive in `resolvedSource`, `sources`, and `resolution`.
- **Workspace contract**: Matching is normalized exact-first, followed only by one unambiguous
  complete-component suffix. A workspace is a conversation-payload I/O boundary by default;
  complementary cross-workspace contributors for already selected UUIDs require explicit opt-in.
- **UUID case semantics**: Session-ID lookup, grouping, and Composer/Store association now treat
  hexadecimal letter case as insignificant. Returned IDs preserve a real source-native spelling,
  prefer Composer spelling for Composer-backed sessions, and report divergent case-only physical
  variants as ambiguity instead of guessing or normalizing a durable public key.
- **Workspace-scoped backup boundary**: New backups retain the enclosing manifest version `1.0.0`
  and add an optional canonical metadata-only inventory with independently validated
  `schemaVersion: 1`, preserving compatibility with v1 readers that ignore additive fields. It
  records Composer workspace/UUID inventory, including verified key-only membership for global-only
  workspace links. Scoped reads use it without extracting unrelated workspace
  databases and never materialize the shared global database; selected workspace content is
  disclosed as partial when that carrier is omitted. Legacy single-workspace archives remain
  scoped-readable, while legacy multi-workspace archives fail before database extraction with
  `BACKUP_WORKSPACE_SCOPE_METADATA_REQUIRED` and actionable recreation guidance.
- **Backup publication**: Temporary plaintext workspaces are private and exhaustively cleaned. New
  final archives default to owner-only permissions on POSIX; broader final access requires
  `--shared`/`sharedPermissions`, and overwrite preserves the existing mode by default. Windows
  uses the system per-user temporary location and inherited ACLs without claiming independently
  verified cross-user isolation.
- **Backup publication commit point**: Rename/link to the final path commits the valid archive. A
  later mode/identity failure returns typed `BACKUP_PUBLISHED_PERMISSION_FAILED` details with
  `published: true`, `pathIdentityVerified`, requested mode, and the last safely observed archive
  mode or `null`. Only a verified path may receive manual-mode guidance; an unverified/replaced path
  is explicitly untrusted. CLI exits nonzero without claiming rollback or recommending blind
  `--force`. Matching modes skip redundant `chmod`; descriptor binding prevents a replacement from
  receiving the permission change. A committed non-force archive whose private sibling cannot be
  cleaned safely returns distinct `BACKUP_PUBLISHED_CLEANUP_FAILED` with verified and unverified
  residue paths; replacement occupants are never deleted or chmodded and unverified paths must not
  be handled blindly.
- **Fatal JSON stream migration**: Every fatal `--json` object now goes to stderr and leaves stdout
  empty. Successful output remains on stdout and nonfatal diagnostics remain in successful result
  envelopes. For the same locked v0.17 failure fixture, existing error field names, types, values,
  and exit-category meaning are preserved; documented safe fields may be added. Scripts that parsed
  fatal JSON from stdout must parse stderr after a nonzero exit.
- **Public search-coordinate correction**: Existing public-library `messageIndex`, `offset`,
  `match`, and context fields now address the complete returned message array, complete original
  content in zero-based UTF-16 code units, and complete original source lines. v0.16/v0.17 returned
  placeholder or snippet-relative values; consumers that persisted those coordinates must
  recompute them. Locked affected-release fixtures prove identities and non-search session values
  do not change.
- **Public JSON export index**: Library JSON exports now include an additive zero-based `index`
  consistent with library read selectors. Tagged v0.16/v0.17 exports omitted this field; this is
  not a migration from a released one-based export value.
- **Restore-warning correction**: v0.16/v0.17 could report an integrity warning and still restore
  the invalid entry. v0.18.0 treats size and checksum validation as the publication gate:
  `filesRestored` counts only intact published entries, warnings identify skipped paths, and callers
  must no longer assume a warned file was written.
- **Explicit Node runtime range**: The package now advertises Node 20.x and 22.x–26.x rather than
  the overbroad `>=20` range. Node 20.0.0 remains the exact compatibility floor; Node 21 is excluded
  because the packaged native SQLite fallback does not support it. Source checks run on a
  development-tool-compatible Node 24 runtime, while the same checksum-addressed tarball is tested
  separately on every advertised major and the 22.x/23.x SQLite backup capability boundaries.
- **Versioned v0.16 compatibility exceptions**: A missing/null/empty Composer message `id` is
  materialized as exactly `msg:<zero-based-v0.16-Composer-projection-index>`, the same durable key
  the unchanged consumer already synthesized; every nonempty native ID remains byte-for-byte exact.
  Three source-absent scalar fallbacks are also intentionally corrected: inferred message timestamps
  become deterministic with provenance, missing Composer update times no longer use read time, and
  pathless `(workspace: <directory-id>)` placeholders become public `"unknown"`/structured `null`.
  All other non-additive public values and own-property/null/omission shapes remain exact.

### Fixed

- **v0.16 Composer identity preservation**: Composer identity is frozen before Store merge. Native
  IDs remain byte-for-byte unchanged; missing IDs reproduce the v0.16 Composer-only positional key;
  Store-only messages use a separate versioned namespace. Existing Composer tool-call order and
  ordinal-derived downstream keys remain stable.
- **Incremental replacement safety**: A v0.16 Composer-only archive can upgrade to a complete
  Composer-backed merged session without changing the consumer. The first changed sync uses the
  consumer's existing whole-session atomic replacement and the next identical sync performs no
  session/content mutations. The consumer still executes one existing `sync_metadata`
  schema-version upsert statement per synchronization; a fresh target may initialize that metadata
  row, while later same-version upserts are value-preserving bookkeeping outside the content count.
  Middle insertions, enrichment, relationships, and tools no longer rely on a timestamp watermark.
- **v0.17 convergence path**: Complete affected v0.17 Store/merged sessions converge through one
  documented whole-session replacement with no duplicate logical content and then become
  idempotent. Unstable v0.17 Store positional/cross-format synthetic IDs are intentionally not
  preserved. Partial/degraded data never overwrites a complete archive.
- **Workspace-scoped integrity**: Follow-up reads and migration targets bind the scoped UUID and
  eligible physical occurrence. Returned content, session ID, workspace path, dry-run, and mutation
  cannot drift to an unfiltered row. Numeric and UUID migration selectors use the same complete
  scoped logical catalog, so ambiguous rows retain their displayed index and produce the same typed
  zero-write refusal instead of shifting later targets.
- **Replica and memory behavior**: Equivalent physical replicas reconcile once; divergent replicas
  produce a typed ambiguity. Read contexts have explicit immutable scope and bounded completed-value
  retention so search and bulk export need not pin the decoded corpus.
- **Store DB/transcript coexistence**: A usable Store database plus transcript is a supported
  Required scenario when all known relevant occurrences are permitted. The database remains the
  sole Store conversation backbone and the transcript is retained as superseded provenance rather
  than rejected or heuristically merged. A known off-scope representation is never opened and makes
  a workspace-scoped view explicitly partial.
- **SQLite capability selection**: Driver selection checks the capability required by each
  operation. Automatic mode can fall back to a capable provider, while an explicitly forced
  incapable driver fails with an actionable typed error rather than silently degrading Store data.
- **Cross-version PID-namespace-safe stale cleanup**: New temporary-workspace markers use format v2
  and carry boot-scoped Linux PID-namespace identity (boot ID plus namespace inode) when procfs
  exposes it. The version boundary makes older v1 binaries reject new live markers before any
  numeric-PID probe. The current reader retains valid v1 Linux markers as legacy/uncertain and
  interprets v2 PID/start-token evidence only in the same verified namespace; a different host boot
  or namespace and missing, malformed, or unreadable identity are retained rather than risking
  deletion of another namespace's live private workspace.
- **Restore integrity and confinement**: Restore now publishes only entries whose manifest size and
  checksum pass, rejects empty inventories and unmanifested file payloads, skips corrupt entries
  without touching their destinations, rejects unsafe type/path combinations and duplicate targets,
  and preflights every non-forced collision. Non-force publication is atomic no-clobber and forced
  replacement uses a new same-directory inode instead of writing through hard links. Because
  portable Node path APIs cannot atomically compare and mutate a destination entry, any failure
  after publication fails closed without automatic rollback: all published paths remain untouched
  and `RESTORE_ROLLBACK_INCOMPLETE` reports every safe manifest-relative residual plus verified and
  unverified private cleanup residue at top level. Recover from a known-good backup. Destinations should remain
  owner-controlled because Node 20 has no portable directory-relative no-follow primitive against
  a hostile concurrent ancestor swap.

### Upgrade warning and migration

- Incremental library consumers that persist cursor-history output should keep v0.16 pinned until
  they can validate the 0.18.0 corrective transition. Back up the downstream archive before the
  first corrective sync.
- The no-consumer-change guarantee is scoped to confirmed v0.16 Composer-only archives becoming
  complete Composer-backed merged sessions. It does not claim preservation of every v0.17
  Store-only or cross-format synthetic ID.
- For complete v0.17 Store/merged data, allow one full replacement and verify that the next sync is
  a no-op. For degraded data, pin/retry from complete sources or migrate manually; do not replace a
  complete archived session.
- Numeric indices remain presentation addresses: CLI/core and library migration selectors are
  one-based, while public-library reads are zero-based. Reuse native session IDs, not numbers, across
  invocations or scopes.
- Recompute any persisted v0.16/v0.17 public search `messageIndex`, `offset`, `match`, or context
  values after upgrading; 0.18.0 corrects their coordinate space directly. Treat the newly emitted
  zero-based library JSON export `index` as additive metadata.

## [0.17.0] - 2026-08-03

### Added

- **Cursor Store stack support**: Added Store transcript and per-session `store.db` discovery,
  parsing, Composer/Store merge, Store metadata, and platform-specific preferred merge ordering.
- **Operation-scoped reads**: Added read-context plumbing and stable-ID follow-up loading that fixed
  the central workspace-filtered index-versus-global-index bug reported in #33 for show, search,
  export, and public-library reads.
- **Structured tool rendering**: Preserved tool calls on error/thinking messages without
  reclassifying the message category.

### Compatibility warning

- v0.17 is unsafe to adopt without validation for projects that persist library output as
  incremental database keys. Store insertion/merge can move Composer messages that lack native IDs,
  transitional merged `source` values may not trigger an existing consumer's replacement policy,
  and timestamp-watermark ingestion can miss valid middle insertions or Store fallback times.
- Existing v0.16 Composer-only archives should remain pinned to v0.16, or consumers should wait for
  the corrective release after its owner-authorized external unchanged-consumer certification has
  passed. Back up downstream data before testing an upgrade.
- Some command-owned fatal `--json` paths in v0.17 write their error object to stdout. The corrective
  release intentionally normalizes all fatal JSON to stderr while preserving the locked fields and
  exit-category semantics. Automation must account for that documented stream migration.
- v0.17 Store positional and cross-format synthetic IDs are transitional and are not a future
  compatibility promise.

## [0.16.0] - 2026-07-03

### Fixed

- Preserved session visibility while moving/copying records across mixed Cursor global and
  workspace storage.
- Recovered modern Cursor sessions without a workspace stamp while keeping global recovery and
  storage scoped to the active custom data path.
- Hardened migration path rewriting and mixed-storage recovery behavior.

## [0.15.0] - 2026-04-06

### Added

- Exposed stable native Composer bubble IDs in public `Message` values, JSON, and Markdown output.
- Exposed ordered active-branch bubble IDs when Cursor provides `fullConversationHeadersOnly`.

## [0.14.0] - 2026-03-24

### Fixed

- Preserved full tool payloads for file reads/edits, terminal commands, and generic tool
  parameters/results while retaining bounded default CLI previews.
- Restored pnpm build compatibility and synchronized the release lockfile.

## [0.13.0] - 2026-03-20

### Fixed

- Preserved empty and malformed global bubbles as explicit placeholders rather than dropping them,
  including corruption metadata and bubble type where known.
- Recovered structured tool calls from `toolFormerData`, including invalid-JSON raw sentinels.
- Added `global` versus `workspace-fallback` fidelity signaling and actionable diagnostics for
  global-load fallback.
- Documented the supported pnpm development workflow.

## [0.12.1] - 2026-03-19

### Added

- Added `.code-workspace` path support.

### Changed

- Updated session listing and workspace handling for workspace-file projects.

## [0.12.0] - 2026-03-18

### Added

- Accepted native Composer IDs as well as numeric indices in `show` and `export`.
- Added Chinese, French, and Spanish README translations.

### Changed

- Refactored CLI and library behavior for consistent session addressing and platform path handling.
- Corrected package export ordering so TypeScript declarations are selected before import/require
  targets.

## [0.11.2] - 2026-02-20

### Changed

- **Improved test coverage for `src/core/`**: Added 31 tests for `extractTokenUsage`,
  `extractContextWindowStatus`, `extractPromptDryRunInfo`, and `extractSessionUsage`. Core statement
  coverage raised from 77.39% to 82.13%, passing the 80% threshold.
- **Code formatting**: Applied Prettier formatting across source and test files.

## [0.11.1] - 2026-02-20

### Fixed

- **Timestamp fallback for pre-2025-09 sessions** ([#13](https://github.com/S2thend/cursor-history/issues/13)):
  Extracted timestamps from `timingInfo.clientRpcSendTime`, interpolated missing user-message times
  from neighboring assistant messages, and fell back to session creation time when no per-message
  timestamp existed. Later releases add explicit provenance so inferred values are not presented as
  directly stored source data.
