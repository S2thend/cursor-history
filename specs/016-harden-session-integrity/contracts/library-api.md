# Public Library Contract

**Package**: `cursor-history`<br>
**Feature**: `016-harden-session-integrity`<br>
**Kind**: Direct TypeScript/JavaScript import; this is not a network API.

## Compatibility policy

This increment preserves existing function names, parameter positions, array/string result shapes,
native Cursor IDs, v0.16 Composer-derived keys, direct timestamp provenance tokens, and numeric bases.
New metadata is additive. Deprecated v0.17 source literals remain in declarations temporarily so
existing TypeScript consumers compile, but corrective runtime output uses the legacy fidelity values
`global` and `workspace-fallback`.

The confirmed no-consumer-change guarantee covers v0.16 Composer-only archives becoming complete
Composer-backed merged sessions. Complete v0.17 Store/merged input receives a documented one-time
replacement/convergence path; unstable v0.17 Store positional and cross-format IDs are not preserved.

## Additive public types

```ts
export type SourceRole = 'composer' | 'store';

export type SourceRepresentation =
  | 'composer-global'
  | 'composer-workspace'
  | 'store-db'
  | 'store-transcript'
  | 'store-metadata';

export type ResolvedSource =
  | 'composer'
  | 'store-db'
  | 'store-transcript'
  | 'store-metadata'
  | 'merged';
export type ResolutionState = 'complete' | 'partial';
export type IndexScope = 'global' | 'workspace';

export type SessionTimestampSource =
  | 'composer-metadata'
  | 'store-db-metadata'
  | 'store-meta'
  | 'direct-message'
  | 'epoch-unknown';

export type ResolutionReasonCode =
  | 'workspace-scope-omitted'
  | 'source-unavailable'
  | 'source-read-failed'
  | 'source-partial'
  | 'expected-store-db-unavailable'
  | 'store-db-expectation-unknown'
  | 'store-conversation-unavailable';

export interface SessionResolution {
  state: ResolutionState;
  expectedSourceRoles: SourceRole[];
  loadedSourceRoles: SourceRole[];
  omittedSourceRoles: SourceRole[];
  failedSourceRoles: SourceRole[];
  reasonCodes: ResolutionReasonCode[];
}

export interface WorkspaceMembership {
  workspacePath: string;
  sourceRoles: SourceRole[];
  contributingInstanceCount: number;
}

export interface SessionSourceInstance {
  sourceRole: SourceRole;
  representation: SourceRepresentation;
  workspacePaths: string[];
  state:
    | 'contributed'
    | 'equivalent-replica'
    | 'omitted-by-scope'
    | 'failed'
    | 'superseded';
}

export interface SessionDiagnostic {
  code: string;
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  occurrenceCount?: number;
  occurrenceRefs?: string[];
  remedy?: string;
}
```

`SessionSourceInstance` never exposes a DB path, transcript path, record key, Store directory, or
other physical locator. Opaque `occurrenceRefs` are present only in ambiguity diagnostics and are
valid only for that bound data source/read operation.

Set-like arrays have one runtime order: source-role arrays use `composer`, then `store`; reason
codes use their declaration order; `workspaceMemberships` and every `workspacePaths` use normalized
path code-point order; `sourceInstances` sort by source-role order, representation declaration
order, lexicographic `workspacePaths`, then state declaration order; and occurrence references sort
by stable payload fingerprint with opaque reference as tie-breaker. Message, branch, tool, and file
arrays retain their defined semantic/source order.

## Session contract

Existing fields remain. The following fields are additive:

```ts
export interface Session {
  id: string;                           // unchanged native Cursor UUID
  workspace: string;                   // compatibility alias of canonical path
  timestamp: string;
  /** Provenance for `timestamp`, which remains the compatibility creation-time field. */
  createdAtSource?: SessionTimestampSource;
  /** Provenance for existing `metadata.lastModified`. */
  lastUpdatedAtSource?: SessionTimestampSource;
  messages: Message[];
  messageCount: number;

  /** Zero-based for public read APIs; additive and optional for source compatibility. */
  index?: number;
  indexScope?: IndexScope;
  indexWorkspacePath?: string;

  /**
   * Compatibility/fidelity signal. Runtime output in the corrective release is
   * 'global' when complete/replacement-safe and 'workspace-fallback' when degraded.
   * Other literals are retained as deprecated v0.17 transition declarations.
   */
  source?:
    | 'global'
    | 'workspace-fallback'
    | 'transcript'
    | 'store'
    | 'store-complete'
    | 'store-partial'
    | 'merged';

  resolvedSource?: ResolvedSource;
  sources?: SourceRole[];
  preferredSource?: SourceRole;
  resolution?: SessionResolution;

  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
  workspaceMatchKind?: 'exact' | 'unique-suffix';
  workspaceMemberships?: WorkspaceMembership[];
  sourceInstances?: SessionSourceInstance[];

  messageIdentityVersion?: 1;
  activeBranchBubbleIds?: string[];
  activeBranchMessageIds?: string[];

  // Existing usage, transcriptState, and metadata fields remain.
}
```

Rules:

- `id` never receives a source/workspace/index suffix.
- `workspace` equals `canonicalWorkspacePath` when known. For every pathless result it is exactly
  `"unknown"`; `canonicalWorkspacePath` remains absent.
- `matchedWorkspacePath` is the full normalized path chosen by the active workspace filter and may
  differ from canonical path on a multi-membership session.
- `indexWorkspacePath` is required exactly when `indexScope === 'workspace'`.
- `resolvedSource` reports representation; `source` reports replacement safety. Consumers must not
  infer one from the other.
- A complete changed session can be compared/replaced as a whole. Timestamp maxima are not an
  incremental correctness boundary.
- `timestamp`/`createdAtSource` and `metadata.lastModified`/`lastUpdatedAtSource` are deterministic
  pairs. Composer metadata wins for Composer-backed sessions; Store DB metadata then Store metadata
  wins for Store-only sessions; otherwise earliest/latest directly stored message time is used,
  then Unix epoch with `epoch-unknown`. Preferred merge source, filter, and read time cannot alter
  them.

## Message and tool contracts

```ts
export type MessageIdentityOrigin =
  | 'composer-native'
  | 'composer-v0.16-index'
  | 'store-db-v1'
  | 'store-transcript-v1';

export type MessageTimestampSource =
  | 'composer-created-at'
  | 'composer-timing'
  | 'store-turn-timing'
  | 'inferred-previous'
  | 'inferred-next'
  | 'session-fallback'
  | 'unknown';

export interface Message {
  /** Kept optional in declarations for source compatibility; nonempty on resolved output. */
  id?: string;
  messageIdentityVersion?: 1;
  identityOrigin?: MessageIdentityOrigin;
  parentMessageId?: string;
  isSidechain?: boolean;

  timestamp: string;
  timestampSource?: MessageTimestampSource;

  // Existing role/content/source/tool/thinking/token/model/duration/metadata fields remain.
}

export interface ToolCall {
  /** Additive modern identity; existing consumers may continue to use array ordinal. */
  id?: string;
  identityOrigin?: 'source-native' | 'tool-v1';

  // Existing name/status/params/result/error/files fields remain.
}
```

Resolved-message identity rules:

- native Composer ID: preserved byte-for-byte;
- missing/empty Composer ID: `msg:<zero-based-v0.16-Composer-projection-index>`;
- unmatched Store DB: `store:v1:db:<leaf-hash>:<one-based-occurrence>`;
- unmatched Store transcript: `store:v1:transcript:<canonical-hash>:<one-based-occurrence>`;
- matched Composer/Store: Composer identity regardless of preferred source;
- Store collision: append the smallest positive `:collision:<n>` without rewriting Composer IDs.

Within each aligned message, tool calls match in fixed Composer-to-Store orientation: (1) exact
nonempty native call ID plus exact name, (2) exact canonical request signature of name, recursively
sorted `params`, then (3) exact name when at least one candidate lacks `params`. Each pass pairs
earliest unmatched Composer with earliest matching unmatched Store call; differing present `params`
never match. Status/result/error/duration and standalone `files` do not participate. Composer calls
retain their order, matched Store calls enrich those slots, and unmatched Store calls append in
Store-native order. Ordered files may distinguish a Store-only modern synthetic ID, but cannot alter
unchanged-consumer pairing/equivalence; required file evidence must be projected into a consumed
field or mark the source partial.

Every resolved public message has a timestamp and provenance at runtime. The three released direct
tokens remain byte-identical. Inferred values are deterministic and never derived from wall-clock
read time. A legacy non-null value with unprovable origin is preserved byte-for-byte as `unknown`
and cannot anchor neighboring inference.

Although `ToolCall.id` and `identityOrigin` remain optional in TypeScript declarations for source
compatibility, every resolved runtime/library/JSON tool call contains a nonempty ID and identity
origin.

The unchanged consumer has no attachment member, derives code blocks from message `content`, and
does not consume standalone cursor-history `codeBlocks` or `ToolCall.files`. Supported source
attachment evidence is projected deterministically and losslessly into message `content` (including
fenced code) or consumed tool-call `name`, `status`, `params`, `result`, and `error` fields. Those
consumed values participate in persistence/digest and replica equivalence. An unsupported raw
attachment block makes the source/session partial and cannot emit `source: 'global'`. No projection
or hash dereferences an external attachment target.

## LibraryConfig additions

```ts
export interface LibraryConfig {
  // Existing dataPath, workspace, limit, offset, context, backupPath,
  // sqliteDriver, and messageFilter fields remain.

  /**
   * Permit source contributors outside the matched workspace only for logical
   * UUIDs already selected by that workspace. Default false.
   */
  includeCrossWorkspaceSources?: boolean;

  /** Receive safe continuation diagnostics for skipped ambiguity groups. */
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
}
```

`workspace` accepts a full historical path or a component-aligned suffix. It is normalized
lexically and need not exist on the current machine. Exact match wins; one unique suffix is accepted;
multiple suffixes throw `WorkspaceAmbiguityError` before conversation payload I/O.

`sqliteDriver` is now honored by the bound operation. It is a forced preference: if it lacks a
required capability, the operation throws instead of silently falling back.

## Read functions

The following released signatures remain:

```ts
export function listSessions(config?: LibraryConfig): Promise<PaginatedResult<Session>>;
export function getSession(indexOrId: number | string, config?: LibraryConfig): Promise<Session>;
export function searchSessions(query: string, config?: LibraryConfig): Promise<SearchResult[]>;
export function exportSessionToJson(indexOrId: number | string, config?: LibraryConfig): Promise<string>;
export function exportSessionToMarkdown(indexOrId: number | string, config?: LibraryConfig): Promise<string>;
export function exportAllSessionsToJson(config?: LibraryConfig): Promise<string>;
export function exportAllSessionsToMarkdown(config?: LibraryConfig): Promise<string>;
```

Read API numeric selectors remain zero-based. Under a workspace configuration, both numeric and
native-ID selectors verify the bound membership; an ID from another workspace throws
`SessionScopeMismatchError` without hydrating it. Unfiltered direct-ID behavior is unchanged.

`PaginatedResult<T>` may add a `diagnostics?: SessionDiagnostic[]` member without altering `data` or
`pagination`. A new additive summary API exposes ambiguous catalog rows without fabricating an empty
full session:

```ts
export interface ResolvedSessionSummary
  extends Omit<
    Session,
    'messages' | 'source' | 'activeBranchBubbleIds' | 'activeBranchMessageIds'
  > {
  index: number;
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  title: string | null;
  preview: string;
  messageCount: number;
  resolutionState: ResolutionState;
  source: 'global' | 'workspace-fallback';
  resolvedSource: ResolvedSource;
  sources: SourceRole[];
  resolution: SessionResolution;
  createdAtSource: SessionTimestampSource;
  lastUpdatedAtSource: SessionTimestampSource;
  workspaceMemberships: WorkspaceMembership[];
  sourceInstances: SessionSourceInstance[];
  messageIdentityVersion: 1;
  metadata: NonNullable<Session['metadata']> & { lastModified: string };
}

export interface AmbiguousSessionSummary {
  id: string;
  index: number;
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  resolutionState: 'ambiguous';
  sourceRoles: SourceRole[];
  occurrenceCount: number;
  diagnosticOccurrenceRefs: string[];
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
}

export type SessionSummary = ResolvedSessionSummary | AmbiguousSessionSummary;

export function listSessionSummaries(
  config?: LibraryConfig
): Promise<PaginatedResult<SessionSummary>>;
```

`ResolvedSessionSummary` carries the complete resolved session metadata plus the existing
lightweight `title`, `preview`, and `messageCount`; `resolutionState` is required and equals
`resolution.state`. It never contains `messages` or message-nested tools.

`listSessions()` continues returning only full `Session` objects. If it encounters an ambiguous row,
it reports it through `diagnostics`/`onDiagnostic` and does not parse the contested payload. Search
and bulk export keep their existing array/string return types: with `onDiagnostic`, they skip each
ambiguous group exactly once and call the handler once; without a handler, they throw the typed
ambiguity rather than silently omit data. Direct get/show/export always throw for ambiguity.

Pagination is over scoped logical catalog rows before hydration. Therefore both
`listSessionSummaries().pagination.total` and `listSessions().pagination.total` count every scoped
logical row, including one row for each ambiguous UUID; `hasMore` is computed from that same total.
`listSessionSummaries().data` has one item per row in the requested window. `listSessions().data`
contains only the resolvable full sessions in that window, so it may be shorter than `limit` and its
presentation indices may have gaps when an ambiguous row is diagnosed. Consumers requiring a
one-to-one catalog page use `listSessionSummaries()`.

## Migration additions

```ts
export interface MigrateSessionConfig {
  // Existing sessions, destination, mode, dryRun, force, dataPath remain.
  /** Scope numeric or ID selection to this historical workspace path. */
  workspace?: string;
}
```

Migration's existing documented numeric selectors remain one-based, unlike the public read APIs.
Dry-run and execution bind the same eligible Composer occurrence. A read-side equivalent-replica
winner is not mutation authority: multiple physical Composer locators or a shared global record
whose mutation affects another membership are rejected. Divergent, Store-only, and merged sessions
also throw `UnsupportedSessionMigrationError` or `SessionAmbiguityError` before any write. Move
retains UUID; copy returns a new UUID.

Workspace-wide migration applies the same eligibility rules and cannot move only one half of a
merged session.

## Backup additions

The existing backup configuration gains:

```ts
export interface BackupConfig {
  // Existing fields remain.
  /** Request platform-default/shared final archive permissions. Default false. */
  sharedPermissions?: boolean;
}
```

New final archives are owner-only on permission-aware platforms by default. A default overwrite
preserves the existing archive's mode exactly and never changes the parent directory. On POSIX,
explicit `sharedPermissions` requests the ordinary non-executable mode `0666 & ~currentUmask`.
Temporary plaintext remains private regardless of final sharing, and the process umask is never
modified.

## Driver selection compatibility

```ts
export function setDriver(name: SqliteDriverName): void;
```

The return type remains `void`. The function records the forced preference synchronously; the next
awaited database operation verifies all required capabilities and returns a typed error if the forced
driver is incapable. Per-operation `LibraryConfig.sqliteDriver` wins, followed by the most recent
`setDriver` value, the environment preference, and automatic selection. This avoids the current
discarded-promise race without changing a released return value.

## Typed errors

All new error classes extend `Error`, include a stable `code`, expose only safe structured details,
and have exported type guards:

| Class | Code | Required safe details |
|-------|------|-----------------------|
| `WorkspaceAmbiguityError` | `WORKSPACE_AMBIGUOUS` | request and matching normalized workspace paths |
| `SessionAmbiguityError` | `SESSION_AMBIGUOUS` | UUID, source role, occurrence count, opaque refs |
| `SessionScopeMismatchError` | `SESSION_SCOPE_MISMATCH` | UUID and requested/matched scope |
| `ReadContextSourceMismatchError` | `READ_CONTEXT_SOURCE_MISMATCH` | requested source kind/path |
| `ReadContextScopeMismatchError` | `READ_CONTEXT_SCOPE_MISMATCH` | requested and bound scopes |
| `ReadContextDisposedError` | `READ_CONTEXT_DISPOSED` | remedy to create a new context |
| `DatabaseCapabilityError` | `DATABASE_CAPABILITY_MISSING` | driver, operation, missing capabilities, alternatives, remedy |
| `NoCapableDriverError` | `NO_CAPABLE_DATABASE_DRIVER` | operation, required capabilities, remedies |
| `UnsupportedSessionMigrationError` | `UNSUPPORTED_SESSION_MIGRATION` | UUID and source category |
| `MigrationTargetChangedError` | `MIGRATION_TARGET_CHANGED` | UUID and retry remedy; no locator |
| `TemporaryArtifactCleanupError` | `TEMPORARY_ARTIFACT_CLEANUP_FAILED` | possible residue paths only |

Existing library wrappers must pass these types through; they must not turn them into a bare
`Error("Failed to ...")`.

## Incremental-consumer compatibility example

```ts
const baseline = await getSession('native-session-uuid', {
  dataPath: '/archived/v016/cursor-data',
});

// After upgrade, a complete Composer-backed merge still reports `global`.
const current = await getSession('native-session-uuid', {
  dataPath: '/current/cursor-data',
});

if (current.source === 'global' && digest(current) !== digest(baseline)) {
  await replaceSessionAtomically(current);
}
```

No timestamp watermark is needed: the whole resolved view detects middle insertions, deletions,
enrichment, tool changes, and relationship changes. A repeat read of unchanged input produces the
same identities, timestamp/provenance pairs, digest, and zero replacement writes.

Release regressions snapshot a v0.16 Composer fixture's session, message, and ordinal-derived tool
keys byte-for-byte before and after Store enrichment, preferred-backbone changes, Store-only gaps,
and a second sync. They also lock stable source/fidelity values, exact pathless aliases, session and
message timestamp/provenance pairs, parent/branch rewrites, and existing Composer tool order.
