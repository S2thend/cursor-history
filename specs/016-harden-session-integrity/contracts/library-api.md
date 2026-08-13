# Public Library Contract

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

**Package**: `cursor-history`<br>
**Feature**: `016-harden-session-integrity`<br>
**Kind**: Direct TypeScript/JavaScript import; this is not a network API.

## Compatibility policy

This increment preserves existing function names, parameter positions, array/string result shapes,
native Cursor IDs, v0.16 Composer-derived keys, direct timestamp provenance tokens, and numeric
bases. New metadata is additive except for one explicit 0.18.0 corrective exception: released
v0.16/v0.17 public search-coordinate fields are corrected in place under locked affected-version
fixtures and migration guidance. Deprecated v0.17 source literals remain in declarations
temporarily so existing TypeScript consumers compile, but corrective runtime output uses the legacy
fidelity values `global` and `workspace-fallback`.

Every symbol reachable from the exact packed package-root declaration graph—including aliases and
re-exports—has shipped JSDoc describing its purpose and public contract. Callable and constructable
exports document parameters, applicable return values, thrown typed errors, index base,
scope/lifetime, and compatibility behavior. The declaration-graph audit walks the packed
`dist/lib/index.d.ts` graph rather than relying on a hand-maintained source-file list. Library
examples in shipped documentation are typechecked and executed against the exact packed artifact.

The confirmed no-consumer-change guarantee covers v0.16 Composer-only archives becoming complete
Composer-backed merged sessions. Complete v0.17 Store/merged input receives a documented one-time
replacement/convergence path; unstable v0.17 Store positional and cross-format IDs are not preserved.
An unchanged consumer receives Source Read Limits v1 defaults automatically. The release gate must
raise any default exceeded by an authorized Cursor source carrier actually readable by v0.16
(live/custom Composer roots or cursor-history backup ZIP/SQLite input) before publication; callers
do not need to opt into `sourceReadLimits` for the confirmed upgrade path. The downstream
vibe-history archive is exercised only by owner-authorized external T113, not by the recurring
repository harness or this source-limit preflight.

Canonical UUID arguments are case-insensitive logical selectors, but returned IDs preserve an
observed source spelling and Composer wins for Composer-backed sessions. This does not generalize
to arbitrary strings: compact 32-hex Store directory names and every other noncanonical identifier
remain case-sensitive and byte-exact.

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

export interface SourceReadLimitsV1 {
  readonly policyVersion: 'source-read-limits/v1';
  readonly jsonlRecordBytes: number;
  readonly jsonlSourceBytes: number;
  readonly jsonlRecordCount: number;
  readonly sqlitePageRows: number;
  readonly sqlitePageBytes: number;
  readonly sqliteValueBytes: number;
  readonly sqliteRowCount: number;
  readonly sqliteDecodedBytes: number;
  readonly zipCompressedBytes: number;
  readonly zipEntryCount: number;
  readonly zipEntryBytes: number;
  readonly zipAggregateBytes: number;
  readonly zipCompressionRatio: number;
}

export type SourceReadLimitsOverride = Partial<Omit<SourceReadLimitsV1, 'policyVersion'>>;

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

export type JsonlSourceBoundKind =
  | 'jsonl-record-bytes'
  | 'jsonl-source-bytes'
  | 'jsonl-record-count';

export type SqliteSourceBoundKind =
  | 'sqlite-page-rows'
  | 'sqlite-page-bytes'
  | 'sqlite-value-bytes'
  | 'sqlite-row-count'
  | 'sqlite-decoded-bytes';

export type ZipSourceBoundKind =
  | 'zip-compressed-bytes'
  | 'zip-entry-count'
  | 'zip-entry-bytes'
  | 'zip-aggregate-bytes'
  | 'zip-compression-ratio';

export type SourceBoundKind =
  | JsonlSourceBoundKind
  | SqliteSourceBoundKind
  | ZipSourceBoundKind;

export type JsonlSourceLimitDimension =
  | {
      sourceKind: 'jsonl';
      bound: 'jsonl-record-bytes' | 'jsonl-source-bytes';
      unit: 'bytes';
    }
  | {
      sourceKind: 'jsonl';
      bound: 'jsonl-record-count';
      unit: 'records';
    };

export type SqliteSourceLimitDimension =
  | {
      sourceKind: 'sqlite';
      bound: 'sqlite-page-rows' | 'sqlite-row-count';
      unit: 'rows';
    }
  | {
      sourceKind: 'sqlite';
      bound: 'sqlite-page-bytes' | 'sqlite-value-bytes' | 'sqlite-decoded-bytes';
      unit: 'bytes';
    };

export type ZipSourceLimitDimension =
  | {
      sourceKind: 'zip';
      bound: 'zip-compressed-bytes' | 'zip-entry-bytes' | 'zip-aggregate-bytes';
      unit: 'bytes';
    }
  | {
      sourceKind: 'zip';
      bound: 'zip-entry-count';
      unit: 'records';
    }
  | {
      sourceKind: 'zip';
      bound: 'zip-compression-ratio';
      unit: 'ratio';
    };

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

export type GeneralSessionDiagnosticCode =
  | 'WORKSPACE_AMBIGUOUS'
  | 'SESSION_AMBIGUOUS'
  | 'SESSION_SCOPE_MISMATCH'
  | 'UNSUPPORTED_SESSION_MIGRATION'
  | 'DATABASE_CAPABILITY_MISSING'
  | 'TEMPORARY_ARTIFACT_CLEANUP_FAILED';

export interface GeneralSessionDiagnostic {
  code: GeneralSessionDiagnosticCode;
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  occurrenceCount?: number;
  occurrenceRefs?: string[];
  remedy?: string;
}

export interface SourceEncodingDiagnostic {
  code: 'SOURCE_ENCODING_INVALID';
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  sourceKind: 'jsonl' | 'sqlite';
  outcome: 'partial';
  remedy: string;
}

export type SourceLimitExceededDiagnostic = {
  code: 'SOURCE_LIMIT_EXCEEDED';
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  policyVersion: 'source-read-limits/v1';
  limit: number;
  observedAtLeast: number;
  outcome: 'partial';
  retryableWithOverride: true;
  remedy: string;
} & (JsonlSourceLimitDimension | SqliteSourceLimitDimension);

export type SessionDiagnostic =
  | GeneralSessionDiagnostic
  | SourceEncodingDiagnostic
  | SourceLimitExceededDiagnostic;
```

For source encoding/limit diagnostics, `sessionId` and `sourceRole` are required at runtime whenever
the failing contributor has already been associated with a logical session. They may be absent only
for an operation/catalog failure detected before UUID or role identification; omission never permits
attaching the diagnostic to a different session.

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
  workspace: string;                   // released v0.16 spelling; may be ~/...
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
   * Compatibility/fidelity signal. Runtime output in v0.18.0 is
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

Role arrays summarize physical contributors rather than mutually exclusive logical states. The
same role may be both loaded and omitted/failed when different representations or occurrences have
different outcomes; `sourceInstances` is authoritative at representation level.

Rules:

- `id` never receives a source/workspace/index suffix.
- `workspace` preserves the released v0.16 `coreSession.workspacePath` spelling, including `~/...`
  home contraction. `canonicalWorkspacePath` is the additive normalized full path, so the two may
  differ textually while identifying the same workspace. For every pathless result `workspace` is
  exactly `"unknown"`; `canonicalWorkspacePath` remains absent.
- `matchedWorkspacePath` is the full normalized path chosen by the active workspace filter and may
  differ from canonical path on a multi-membership session.
- `indexWorkspacePath` is required exactly when `indexScope === 'workspace'`.
- `resolvedSource` reports representation; `source` reports replacement safety. Consumers must not
  infer one from the other.
- For merged output, `activeBranchBubbleIds` and `activeBranchMessageIds` expose the same resolved
  selected branch. Leading, middle, and trailing Store-only active turns appear once, parent/leaf
  references use stable IDs, and Store sidechains are excluded. Composer-only legacy branch arrays
  remain byte-for-byte unchanged.
- `resolvedSource: 'store-transcript'` may replace an expected Store DB only after capable provider
  selection and DB snapshot/read setup succeeds and the DB is absent, empty, or
  source-corrupt/unreadable. Provider/capability/snapshot infrastructure failures reject with a
  typed error; they never return transcript fallback or `store-metadata` success.
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

Library projection preserves the released v0.16 own-property shape of the pre-existing optional
`Message` members `toolCalls`, `thinking`, `tokenUsage`, `model`, `durationMs`, and `metadata`, even
when their value is `undefined`. Additive identity/provenance members do not replace those keys.
There is one versioned identity-property exception: when v0.16 omitted `Message.id` or the source ID
was null/empty, v0.18 materializes exactly `msg:<zero-based-v0.16-Composer-projection-index>`. That
is the durable key the unchanged consumer already synthesized; a different ordinal, omission in the
resolved view, or any rewrite/removal of a nonempty native ID is a compatibility failure.

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

  /** Explicit per-operation overrides of documented Source Read Limits v1 defaults. */
  sourceReadLimits?: SourceReadLimitsOverride;

  /** Reuse an explicitly bound public read context. Other binding fields must agree. */
  readContext?: SessionReadContext;

  /** Cooperatively cancel this read and all nested parsing/snapshot work. */
  signal?: AbortSignal;
}
```

The additive public lifecycle API is intentionally opaque: it exposes release/disposal controls but
not physical source locators or the internal catalog.

```ts
export interface SessionReadContextOptions {
  dataPath?: string;
  backupPath?: string;
  workspace?: string;
  includeCrossWorkspaceSources?: boolean;
  resolvedSessionCapacity?: number; // default 1; finite nonnegative integer
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
  sqliteDriver?: SqliteDriverName;
  sourceReadLimits?: SourceReadLimitsOverride;
  signal?: AbortSignal;
}

export interface SessionReadContext {
  readonly resolvedSessionCapacity: number;
  readonly disposed: boolean;
  releaseSession(sessionId: string): void;
  dispose(): Promise<void>;
}

export function createSessionReadContext(
  options?: SessionReadContextOptions
): SessionReadContext;
```

Supplying both `readContext` and per-call binding fields is allowed only when they match the
context's immutable binding. A mismatch or use after disposal fails with the documented typed error
before catalog or content I/O. `sourceReadLimits` is stricter: it must be omitted whenever
`readContext` is supplied; providing both fails as `READ_CONTEXT_OPTIONS_MISMATCH` rather than being
ignored or compared against an opaque effective map. Built-in operations dispose their own contexts
in `finally`; a caller that supplies a context owns its lifecycle.

`workspace` accepts a full historical path or a component-aligned suffix. It is normalized
lexically and need not exist on the current machine. Exact match wins; one unique suffix is accepted;
multiple suffixes throw `WorkspaceAmbiguityError` before conversation payload I/O.

`sqliteDriver` is now honored by the bound operation. It is a forced preference: if it lacks a
required capability, the operation throws instead of silently falling back.

Changed Store/transcript/archive parsers accept deterministic UTF-8 with one optional leading BOM,
ignore unknown supported-record fields, and never guess, transcode, or replacement-decode invalid or
mixed encoding. JSONL, SQLite, and ZIP processing use the exact inclusive Source Read Limits v1
defaults defined by the normative specification. A caller may raise or lower fields explicitly for
one operation; the validated values are copied and frozen. Global, environment-derived,
input/manifest-driven, automatic-retry, and unlimited overrides are forbidden. Encoding and limit
failures surface through the typed errors below as partial diagnostics only when a safe contributor
remains, otherwise as one fatal error. Limit policy and override values never participate in public
identity, hashing, equivalence, deduplication, or incremental synchronization.

Within `SourceReadLimitsOverride`, an omitted recognized field or recognized field whose value is
`undefined` inherits its default; `null` is invalid. Unknown own keys and `policyVersion` are rejected
before source content I/O even if their value is `undefined`.

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

The released public search shape remains, with corrected field semantics in 0.18.0:

```ts
export interface SearchResult {
  session: Session;
  /** Complete original source line containing the first case-insensitive match. */
  match: string;
  /** Zero-based index of the matched message in the complete `session.messages` array. */
  messageIndex: number;
  /** Complete adjacent source lines before the match, bounded by `config.context`. */
  contextBefore?: string[];
  /** Complete adjacent source lines after the match, bounded by `config.context`. */
  contextAfter?: string[];
  /** Zero-based UTF-16 code-unit offset in the complete original message content. */
  offset?: number;
}
```

Every emitted result contains `offset`. It points to the first case-insensitive match in original
content even when the query is in a non-first message, the message is multiline, earlier content
contains astral characters, or lowercasing expands a source code point. Snippet ellipses never
participate. v0.16/v0.17 callers that persisted the old placeholder `messageIndex`, snippet-relative
`offset`, or truncated `match` must recompute those search coordinates after upgrading; they are
not stable content identities. No session, message, tool, or non-search value changes under this
exception.

JSON produced by `exportSessionToJson()` and `exportAllSessionsToJson()` includes the session's
zero-based public-library `index`, consistent with list/get/export selectors. This field is additive:
tagged v0.16 and v0.17 JSON exports omitted `index`; neither released a one-based export value.

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
presentation indices may have gaps when an ambiguous row is diagnosed. It never pulls a later
logical row into the page to replace an omitted ambiguity. Consumers requiring a one-to-one catalog
page use `listSessionSummaries()`.

Summary indices use the same zero-based public-read base as `listSessions()` and `getSession()`.
They are ephemeral within the same data source, workspace scope, catalog snapshot, and invocation;
persist the native session ID instead.

## Migration additions

```ts
export interface MigrateSessionConfig {
  // Existing sessions, destination, mode, dryRun, force, dataPath remain.
  /** Scope numeric or ID selection to this historical workspace path. */
  workspace?: string;
  /** Explicit per-operation overrides for bounded source reads during preparation. */
  sourceReadLimits?: SourceReadLimitsOverride;
  /** Cooperatively cancel before mutation or between bounded preparation/application steps. */
  signal?: AbortSignal;
}

export interface MigrateWorkspaceConfig {
  // Existing source, destination, mode, dryRun, force, and dataPath remain.
  /** Explicit per-operation overrides for bounded source reads during preparation. */
  sourceReadLimits?: SourceReadLimitsOverride;
  /** Cooperatively cancel before mutation or between bounded preparation/application steps. */
  signal?: AbortSignal;
}
```

Migration's existing documented numeric selectors remain one-based, unlike the public read APIs.
Numeric and native-ID migration selectors resolve through the same complete scoped logical catalog,
including ambiguous rows. An ambiguous row retains its listed ordinal and throws the same
`SessionAmbiguityError` by number or UUID before any write; it is never skipped or shifted. Dry-run
and execution bind the same eligible Composer occurrence. A read-side equivalent-replica
winner is not mutation authority: multiple physical Composer locators or a shared global record
whose mutation affects another membership are rejected. Divergent, Store-only, and merged sessions
also throw `UnsupportedSessionMigrationError` or `SessionAmbiguityError` before any write. Move
retains UUID; copy returns a new UUID.

Canonical UUID matching binds two identities internally: the logical folded key and the exact
source-native workspace/global record keys. Dry-run and apply return the Composer-compatible public
spelling but read and mutate only the frozen exact physical keys. A sole opposite-case global
carrier may be selected; multiple case-only global carriers refuse before writes even if their
payloads are equivalent. Noncanonical identifiers are never folded.

Scoped preparation may project off-scope IDs, array positions, selected IDs, and pane pointers as
metadata, but it never materializes an off-scope `composer.composerData` value. Only the selected
workspace occurrence is hydrated. Session and workspace migration prepare and revalidate the full
requested set before the first write; one missing, ambiguous, divergent, ineligible, or changed
member makes both dry-run and apply refuse with zero mutation.

Workspace-wide migration applies the same eligibility rules and cannot move only one half of a
merged session. Migration limit overrides are validated and frozen before source reads and never
weaken the prepare/revalidate/first-write boundary.

## Backup additions

The existing backup configuration gains:

```ts
export interface BackupConfig {
  // Existing fields remain.
  /** Request platform-default/shared final archive permissions. Default false. */
  sharedPermissions?: boolean;
  /** Explicit per-operation overrides of documented Source Read Limits v1 defaults. */
  sourceReadLimits?: SourceReadLimitsOverride;
  /** Cooperatively cancel creation/read and run the normal private-artifact cleanup path. */
  signal?: AbortSignal;
}

export interface RestoreConfig {
  // Existing fields remain.
  /** Explicit per-operation overrides of documented Source Read Limits v1 defaults. */
  sourceReadLimits?: SourceReadLimitsOverride;
}

export interface SourceReadOptions {
  sourceReadLimits?: SourceReadLimitsOverride;
  signal?: AbortSignal;
}

export function validateBackup(
  backupPath: string,
  options?: SourceReadOptions
): Promise<BackupValidation>;

export function listBackups(
  directory?: string,
  options?: SourceReadOptions
): Promise<BackupInfo[]>;
```

New final archives are owner-only on permission-aware platforms by default. A default overwrite
preserves the existing archive's mode exactly and never changes the parent directory. On POSIX,
explicit `sharedPermissions` requests the ordinary non-executable mode `0666 & ~currentUmask`.
Temporary plaintext remains private regardless of final sharing, and the process umask is never
modified. On Windows, creation uses the system per-user temporary location, inherited access
controls, exclusive paths, and the same cleanup/typed-residue contract; this release does not claim
independently verified cross-user ACL isolation.

Every newly created backup manifest records the exact running package version as `producer`. Older
or absent producer values remain readable. This field is diagnostic provenance only and never
participates in logical/session/message identity, replica equivalence, deduplication, or
incremental-sync comparison.

New manifests keep the enclosing `manifest.version` at `1.0.0` and carry an additive, optional,
canonical metadata-only Composer workspace inventory whose own independently validated
`schemaVersion` is `1`. Existing v1 readers may ignore the unknown optional field. The inventory contains
one workspace path, sorted materialized native UUIDs, verified global-counterpart UUIDs, and
verified workspace-linked global-only UUIDs per archived workspace database. A scoped
backup read uses this inventory to select physical carriers without extracting unrelated databases;
it never extracts the shared global database. Legacy single-workspace archives remain scoped
readable, while a legacy multi-workspace archive lacking this inventory throws
`BackupWorkspaceScopeMetadataError` before any conversation database extraction. Explicit
cross-workspace opt-in may open a separate workspace database only for a UUID already admitted by
the selected workspace inventory.

All public session-ID arguments compare UUID hexadecimal letters case-insensitively. Returned IDs
retain a deterministic source-native spelling, with Composer spelling preferred for a
Composer-backed logical session. A differently-cased argument or Store occurrence never rewrites
that public value. Equivalent case variants reconcile; divergent variants reject resolution with
the ordinary typed logical-session ambiguity.

Rename/link to the requested final path is the publication commit point. If a later mode read,
identity check, or mode adjustment fails, `createBackup()` rejects with
`BackupPublishedPermissionError`; `details.published` is always `true` because that commit point was
crossed. Details also include `pathIdentityVerified`, `requestedMode`, and `actualMode`, which is the
last mode safely observed on the staged archive inode or `null`, never the mode of an unverified
replacement path. Only `pathIdentityVerified: true` proves that `details.outputPath` still names the
completed archive and permits the remedy to advise inspection/correction of that file. When false,
the path is untrusted and the remedy requires establishing which file, if any, is the completed
archive before recovery. Callers must not interpret either branch as rollback or blindly retry with
force. When the verified inode already has the requested mode, the implementation skips `chmod`.
On permission-aware platforms, mode handling opens the final path without following links, verifies
that its regular-file device/inode identity exactly matches the private staging inode using lossless
bigint values, applies any change only through the bound descriptor, and rechecks descriptor and
path. A nonregular or replaced path raises the same typed post-publication failure without changing
the replacement's mode.

If non-force link publication commits but cleanup of its private sibling cannot be completed
safely, `createBackup()` rejects with `BackupPublishedCleanupError` and code
`BACKUP_PUBLISHED_CLEANUP_FAILED`. Details include `published: true`, output
`pathIdentityVerified`, verified `residuePaths`, and `unverifiedResiduePaths`. Verified paths still
name the completed archive inode; unverified paths must not be deleted or chmodded until their
identity is established. This error is distinct from permission adjustment failure, and callers
must not blindly delete, chmod, or force-retry either the output or a residue path.

`validateBackup()` reports manifest size/checksum mismatches in `corruptedFiles`. `restoreBackup()`
uses the same inspection result as its mutation admission set: a mixed-validity archive may return
success with warnings after restoring only intact entries, while every size- or checksum-invalid
entry is reported as skipped and its destination remains untouched even when `force` is true. An
empty/no-intact archive or any non-directory ZIP entry absent from the manifest is rejected before
destination mutation. Before publication, restore also validates the finite type/path layout,
rejects duplicate destinations and path indirection outside the Cursor user root, and—unless
forced—rejects if any validated destination already exists.

Each admitted payload is copied to a newly created private same-directory inode. Forced restore
atomically replaces the destination directory entry without opening or truncating its previous
inode, so other hard links remain byte-for-byte unchanged. Non-forced restore uses an atomic
no-clobber commit, including against a destination created after preflight. Private sibling cleanup
is device/inode-bound and never unlinks a replacement occupant. After any publication, a later
failure performs no automatic destination rollback because portable Node path APIs cannot bind an
identity comparison atomically to replace or unlink. Every current destination remains untouched.
`restoreBackup()` throws `RestoreRollbackError` with code `RESTORE_ROLLBACK_INCOMPLETE`, a published
count, every safe manifest-relative published residual, and separate top-level verified and
unverified private cleanup residue sets from publication and outer workspace disposal. An
unverified classification dominates a verified classification for the same path. The function does
not return a misleading `filesRestored: 0` result; callers must stop Cursor and recover from a
known-good backup.

The exported `RestoreRollbackError` class name and `RESTORE_ROLLBACK_INCOMPLETE` code remain stable
for compatibility. They signal that manual recovery is required; they do not assert that an
automatic rollback mutation was attempted.

The selected user root is canonicalized and descendant paths are rechecked immediately before each
publication. This rejects observed/static leaf links and safely replaces multiply linked regular
files without writing through their old inode. On supported runtimes without a portable
directory-relative no-follow creation primitive, it is not an atomic security boundary against a
hostile local process swapping an ancestor between that check and the final commit; callers must
use an owner-controlled destination tree.

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
| `ReadContextOptionsMismatchError` | `READ_CONTEXT_OPTIONS_MISMATCH` | conflicting public option names and remedy; no bound locator/value dump |
| `ReadContextDisposedError` | `READ_CONTEXT_DISPOSED` | remedy to create a new context |
| `DatabaseCapabilityError` | `DATABASE_CAPABILITY_MISSING` | driver, operation, missing capabilities, alternatives, remedy |
| `NoCapableDriverError` | `NO_CAPABLE_DATABASE_DRIVER` | operation, required capabilities, remedies |
| `UnsupportedSessionMigrationError` | `UNSUPPORTED_SESSION_MIGRATION` | UUID and source category |
| `MigrationTargetChangedError` | `MIGRATION_TARGET_CHANGED` | UUID and retry remedy; no locator |
| `BackupPublishedPermissionError` | `BACKUP_PUBLISHED_PERMISSION_FAILED` | `published: true`, final output path, `pathIdentityVerified`, requested mode, last safely observed archive-inode mode or `null`, and identity-conditional remedy |
| `BackupPublishedCleanupError` | `BACKUP_PUBLISHED_CLEANUP_FAILED` | `published: true`, final output path, `pathIdentityVerified`, verified residue paths, unverified residue paths, and no-blind-delete/force remedy |
| `RestoreRollbackError` | `RESTORE_ROLLBACK_INCOMPLETE` | published-file count, residual count, canonical manifest-relative residual paths, verified and unverified private cleanup residue counts/paths, and recovery remedy |
| `TemporaryArtifactCleanupError` | `TEMPORARY_ARTIFACT_CLEANUP_FAILED` | possible residue paths only |
| `SourceEncodingError` | `SOURCE_ENCODING_INVALID` | source kind, partial/fatal outcome, remedy; no content |
| `SourceLimitError` | `SOURCE_LIMIT_EXCEEDED` | policy version, source kind, named bound, limit, observed-at-least, unit, partial/fatal outcome, override remedy; no content |
| `SourceLimitConfigurationError` | `SOURCE_LIMIT_CONFIGURATION_INVALID` | invalid field, optional primitive value, received type, violated constraint, and remedy; no source content |

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
and a second sync. Store-only gaps cover leading, middle, and trailing active-branch positions under
both preferred backbones. They also lock stable source/fidelity values, exact pathless aliases,
session and message timestamp/provenance pairs, resolved active-branch parent/leaf rewrites,
sidechain exclusion, v0.16 `localeCompare()` discovery precedence, and existing Composer tool order.

The finite carrier/source coverage and exclusions for these APIs are normative in
[`../spec.md`](../spec.md), repeated in the design-time
[`compatibility-matrix-v1.md`](compatibility-matrix-v1.md), and shipped in
`docs/compatibility.md`. The supported backup carrier is Composer-only in matrix v1.
