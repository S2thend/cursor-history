# Internal Resolution Contract

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

**Feature**: `016-harden-session-integrity`<br>
**Audience**: Core, CLI, library, and test implementations

This contract defines load-bearing internal boundaries. They are not an invitation to export
physical locators from the npm library.

Source/carrier applicability is normative in the specification and projected without modification
in [`compatibility-matrix-v1.md`](compatibility-matrix-v1.md). Matrix v1 backup hydration is
Composer-only.

## Module ownership

| Module | Owns | Must not own |
|--------|------|--------------|
| `session-identity.ts` | v0.16 Composer projection, Store candidates, canonical hashes, collisions, relationship rewrites | Workspace filtering, file discovery, CLI formatting |
| `session-catalog.ts` | metadata inventory, UUID grouping, role classification, Store representation selection, replica reconciliation, bound rows | Conversation rendering, public path aliases, filesystem mutation |
| `workspace-scope.ts` | lexical normalization, exact/unique-suffix resolution, match diagnostics | Payload reads, logical ID changes |
| `storage.ts` | context lifecycle, listing/resolution/search orchestration, lazy hydration | Identity algorithms duplicated inline, destructive migration writes |
| `private-temp.ts` | exclusive private staging, tracked cleanup, residue error | ZIP/SQLite parsing semantics |
| `io-observer.ts` | immutable operation context and low-level filesystem/key-value/SQLite event emission | Resolver-only claims of physical I/O isolation |
| `source-read-limits.ts` | v1 defaults, override validation/freezing, scoped counters, safe typed limit details | Content identity, automatic limit escalation |
| `parser.ts` | UTF-8/BOM validation, unknown-field tolerance, bounded JSONL/SQLite decoding, timestamp/public projection | Heuristic transcoding, unbounded whole-source buffering |
| `zip-stream.ts` | bounded ZIP32/ZIP64 central reads, path/method validation, STORE/DEFLATE entry streams, CRC/limit checks | Session resolution, manifest trust decisions |
| `backup.ts` | private archive staging/publication, publication commit-point/mode handling, streamed file hashing, manifest producer metadata, archive orchestration | Session/message identity derived from producer metadata; deletion/rollback of a valid post-commit archive |
| `database/registry.ts` | capability profiles and per-operation provider selection | Store completeness policy |
| `migrate.ts` | bind/prepare/revalidate/apply exact eligible target | Numeric rediscovery after preparation |

## Core read context construction

These exports are internal core-module contracts, not package-root declarations. The package-root
library exposes the opaque lifecycle wrapper defined in `library-api.md`; it does not expose
`DataSourceBinding`, `BoundReadScope`, `OperationIoContext`, catalogs, or physical locators.

```ts
export interface SessionReadContextOptions {
  dataPath?: string;
  backupPath?: string;
  workspacePath?: string;
  includeCrossWorkspaceSources?: boolean;
  resolvedSessionCapacity?: number;
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
  sqliteDriver?: SqliteDriverName;
  sourceReadLimits?: Partial<Omit<SourceReadLimitsV1, 'policyVersion'>>;
  signal?: AbortSignal;
}

export function createSessionReadContext(
  options?: SessionReadContextOptions
): SessionReadContext;

/** Deprecated compatibility overload: explicitly global scope. */
export function createSessionReadContext(
  dataPath?: string,
  backupPath?: string
): SessionReadContext;
```

Construction performs deterministic lexical path normalization and binds global or requested
workspace scope immutably. Catalog creation may be lazy, but scope is never `undefined` and is never
set by whichever operation runs first.

```ts
interface SessionReadContext {
  readonly binding: DataSourceBinding;
  readonly scope: BoundReadScope;
  readonly resolvedSessionCapacity: number; // default 1
  readonly operationIo: OperationIoContext;
  releaseSession(key: string): void;
  dispose(): Promise<void>;
}
```

- Every core operation verifies that its positional compatibility arguments agree with the context.
- A mismatch fails before catalog or content I/O.
- Package-root calls using a caller-supplied opaque context must omit per-call `sourceReadLimits`;
  supplying both fails before I/O as `READ_CONTEXT_OPTIONS_MISMATCH`. The bound effective limit map
  is not exposed or re-compared through public API fields.
- `dispose()` is idempotent. Built-in callers invoke it in `finally`.
- The optional `AbortSignal`, context identity, and low-level audit observer propagate through every
  nested adapter/parser/snapshot call; cancellation reaches the same cleanup `finally` path.
- Active promises and completed decoded values use separate maps. On success, LRU insertion evicts
  down to `C`; on rejection, the entry is removed immediately.
- Metadata-only catalog values may live for the context lifetime because they contain no decoded
  conversation payload.

## Metadata discovery and payload instrumentation

```ts
export interface SessionCatalog {
  readonly source: DataSourceBinding;
  readonly rowsById: ReadonlyMap<string, LogicalSessionRecord>;
  readonly workspaces: readonly WorkspaceMembership[];
}

export function discoverSessionCatalog(
  context: SessionReadContext
): Promise<SessionCatalog>;

export function hydrateSourceInstance(
  instance: PhysicalSourceInstance,
  context: SessionReadContext
): Promise<HydratedSourceContribution>;
```

Discovery may read directory names, `workspace.json`, Store `meta.json`, UUID-bearing keys, database
schema metadata, and other explicitly classified membership metadata. It does not read Composer
bubble values, session preview/title content, transcript lines, Store leaves, tool payload, code, or
attachments.

Hydration asserts that:

1. the logical UUID was already selected in the bound catalog scope;
2. the instance is permitted by the content boundary or explicit related-source opt-in;
3. the logical row is not divergent/ambiguous;
4. the context is not disposed.

The actual filesystem, SQLite, and key/value adapters emit at a private test/audit seam immediately
before performing each open/read/prepare/query/get/backup:

```ts
type OperationIoContext = {
  contextId: string;
  dataSourceIdentity: string;
  sourceReadLimits: Readonly<SourceReadLimitsV1>;
  signal?: AbortSignal;
  emit?: (event: AdapterIoEvent) => void;
};

type AdapterIoEvent = {
  adapter: 'filesystem' | 'sqlite' | 'key-value';
  operation: 'open' | 'read' | 'prepare' | 'query' | 'get' | 'backup';
  contextId: string;
  dataSourceIdentity: string;
  logicalSessionId?: string;
  sourceRole?: SourceRole;
  representation?: SourceRepresentation;
  resourceClass: string;
  classification: 'catalog-metadata' | 'conversation-payload';
};
```

`resourceClass` is a reviewed safe class, never a raw path, SQL value/key, or content. Unknown or
unclassified reads fail closed as `conversation-payload`. A high-level resolver observer may mirror
events for diagnostics but is not isolation evidence. Release tests require zero off-scope payload
events and use poison-canary off-scope DB rows, transcript files, and key/value blobs that throw if
an adapter touches them; result-only assertions are insufficient.

Every adapter call receives the same immutable `OperationIoContext`; nested Store snapshot and
backup paths do not create an unobserved context. SQLite emits `prepare` before statement
preparation, `query` before execution/iteration, and `backup` before online snapshot I/O.

## Workspace resolution

```ts
export function resolveWorkspaceScope(
  request: string,
  memberships: readonly string[]
): WorkspaceScopeResult;

type WorkspaceScopeResult =
  | { kind: 'matched'; path: string; matchKind: 'exact' | 'unique-suffix' }
  | { kind: 'not-found'; normalizedRequest: string };
```

Ambiguous suffix candidates throw `WorkspaceAmbiguityError` rather than returning a third union
case. The function:

1. parses supported file URIs and platform path forms;
2. normalizes separators/dot segments/trailing separators without filesystem access;
3. applies source-platform case rules;
4. coalesces equal normalized candidates;
5. prefers exact;
6. compares suffixes only on complete path components.

No caller may reimplement matching with string `endsWith`.

## Logical listing and bound addresses

```ts
export interface ListSessionOptions {
  limit?: number;
  offset?: number;
  all?: boolean;
}

export type LogicalSessionRow = ResolvedSessionSummary | AmbiguousSessionSummary;

export interface LogicalSessionPage {
  rows: LogicalSessionRow[];
  totalLogicalRows: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function listSessionRows(
  options: ListSessionOptions,
  context: SessionReadContext
): Promise<LogicalSessionPage>;

export function bindSessionAddress(
  identifier: number | string,
  numericBase: 0 | 1,
  context: SessionReadContext
): Promise<BoundSessionAddress>;
```

Listing rules:

- Exactly one row per native UUID in the bound scope.
- Sort logical rows by descending `createdAt`. For an equal-time tie, preserve the stable v0.16
  discovery order of every Composer-backed UUID, including merged and ambiguous Composer rows.
  Place rows with no v0.16 Composer position after those legacy rows, then use native UUID as the
  deterministic tie-break only among those new-only rows.
- Assign presentation indices only after grouping/filtering/sorting.
- A bound address stores logical ID, permitted occurrence keys, data-source identity, scope, and
  index base. Follow-up resolution does not list globally or reinterpret the number.
- Direct ID under workspace scope passes through the same membership check.
- Reusing an ambiguous index/ID returns the same typed ambiguity.
- Pagination windows and `totalLogicalRows` are computed over scoped logical rows before hydration,
  including one row for every ambiguous UUID. Summary adapters return every row in the window. The
  full-session library adapter may omit an ambiguous row after one diagnostic, but preserves that
  logical total, `hasMore`, and the original row indices; it does not refill from a later window.
- `ResolvedSessionSummary` is exactly the full resolved metadata projection plus required
  `title: string | null`, `preview: string`, `messageCount: number`, and
  `resolutionState: 'complete' | 'partial'` equal to `resolution.state`. It contains no `messages`.

The current positional `listSessions`/`getSession` core entry points may remain as adapters, but they
must construct or verify this context and delegate to bound rows.

## Replica selection

```ts
export function reconcileReplicaGroup(
  group: ReplicaGroup,
  context: SessionReadContext
): Promise<ReconciledReplicaGroup>;
```

Processing order:

1. Classify complementary roles before comparison. Composer-global/workspace and Store
   DB/transcript are separate primary/fallback tiers, not competing replicas.
2. Reconcile permitted Composer globals only with globals. A usable global is primary; workspace
   records then supply membership/provenance only. Reconcile workspace candidates only if no
   permitted usable global exists; every selected workspace contribution is partial. A divergent
   global group is ambiguous and never falls through to workspace fallback.
3. Classify `StoreDbExpectation` before payload hydration: DB present or explicit
   `hasConversation:true` is `expected`; explicit false or a fully inventoried transcript-only
   UUID with no directory/metadata is `not-expected`; unresolved/conflicting evidence is
   `unknown`, with positive evidence winning.
4. Project known Store occurrences through the workspace payload-I/O scope before hydration. Any
   omitted DB or transcript makes the scoped Store view partial and is never opened, even when it
   would otherwise be superseded; selected-UUID cross-workspace opt-in may admit it only with
   disclosure. Then attempt the permitted Store DB first. A usable complete or partial DB remains
   the sole Store conversation backbone; when every known relevant Store occurrence is permitted,
   a coexisting transcript is a Required input retained as `superseded` provenance and never fills DB gaps. An
   after capable provider selection and DB snapshot/read setup, an absent/empty/source-corrupt or
   unreadable expected DB may fall back to transcript but remains partial;
   transcript is complete only for `not-expected`; `unknown` remains partial. When conversation
   may exist but none is usable, including a `not-expected` session with an unusable transcript or
   other positive conversation evidence, resolve degraded `store-metadata`. Omission is allowed
   only for explicit `hasConversation:false` with no positive conversation evidence. A divergent
   DB group is ambiguous and never falls through to transcript. Provider-selection, capability,
   snapshot-setup, and other database-infrastructure failures are fatal, never fallback.
5. Hydrate same-tier competitors only when necessary to establish equivalence.
6. Hash ordered stable identities, roles, directly stored timestamp values, content, relationships,
   tools, code derived from message content, and attachment evidence already losslessly projected
   into message content or consumed tool-call fields.
   Exclude physical location, discovery order,
   `timestampSource`/other provenance-only annotations, and all inferred display timestamps.
7. One candidate -> single; equal hashes -> equivalent; unequal -> divergent.

A divergent result carries safe metadata and opaque diagnostic refs only. It never selects newest,
first, preferred workspace, or preferred source.

## Stable identity functions

```ts
export const MESSAGE_IDENTITY_VERSION = 1 as const;
export const REPLICA_EQUIVALENCE_VERSION = 1 as const;

export function projectV016ComposerMessages(
  input: ComposerParseInput
): ProjectedComposerMessage[];

export function prepareStoreIdentityCandidates(
  representation: StoreDbMessageRecord[] | TranscriptMessageRecord[]
): StoreIdentityCandidate[];

export function computeAlignment(
  composer: readonly ProjectedComposerMessage[],
  store: readonly StoreIdentityCandidate[]
): AlignmentPlan;

export function allocateResolvedIdentities(
  plan: AlignmentPlan
): ResolvedIdentityMap;

export function renderAlignment(
  plan: AlignmentPlan,
  identities: ResolvedIdentityMap,
  preferredSource: SourceRole
): ResolvedMessage[];

export function rewriteResolvedRelationships(
  messages: ResolvedMessage[],
  identities: ResolvedIdentityMap,
  composerBranch?: readonly string[]
): ResolvedRelationships;

export function matchAlignedToolCalls(
  composer: readonly ComposerToolCall[],
  store: readonly StoreToolCall[]
): ToolCallAlignment;
```

Canonical hash v1:

- UTF-8 JSON;
- object keys sorted by code-point order recursively;
- arrays remain ordered;
- undefined object members omitted and undefined array positions encoded as `null`;
- finite numbers use JSON number spelling; non-finite values are rejected from identity input;
- strings remain exact decoded strings with standard JSON escaping;
- SHA-256 lowercase full 64 hexadecimal characters.

Transcript message hash input uses keys `role`, `content`, `toolActivity`, and
`sourceRelationships`. Synthetic Store-only tool hash input may use call name, normalized structured
input/files, and source-native relationship/call metadata, but excludes result/status enrichment
that may arrive later. Its file component is modern identity data only and never participates in
compatibility pairing or replica equivalence. All inputs are versioned by function/schema, not by
relying on JavaScript property insertion order.

Tool matching has fixed Composer-to-Store orientation and stable one-to-one passes: exact nonempty
native ID plus exact name; exact canonical request signature (exact name and recursively sorted
`params`); then exact name only when at least one candidate lacks `params`. Each pass visits the
earliest unmatched Composer call and chooses the earliest matching unmatched Store call; duplicates
retain native order. Differing present `params` never match. Status, result, error, duration,
standalone `files`, and enrichment are excluded. Matched Store data enriches the fixed Composer slot,
while unmatched Store calls append in Store-native order. Semantically required file evidence must
already be projected into a consumed field or make the contribution partial.

Every resolved tool call has a nonempty `id` and `identityOrigin`; optional library declaration
members exist only for TypeScript source compatibility and do not weaken this runtime boundary.

There is no resolved attachment object or attachment identity. The unchanged consumer derives code
blocks from message `content` and does not consume standalone cursor-history `codeBlocks` or
`ResolvedToolCall.files`. Supported source attachment evidence is projected deterministically and
losslessly into message `content` (including fenced code) or consumed tool-call `name`, `status`,
`params`, `result`, and `error` fields before hashing; those consumed fields participate in
equivalence. A raw attachment block not losslessly representable there marks the
contribution/session partial with `source-partial` and prevents legacy `global` fidelity. Projection
and hashing never dereference an external target.

## Session resolution

```ts
export function resolveSessionAddress(
  address: BoundSessionAddress,
  context: SessionReadContext
): Promise<ResolvedSessionView>;
```

Resolution sequence:

```text
bound logical row
 -> reject divergent group
 -> select permitted source instances
 -> mark known off-scope instances omitted
 -> hydrate/reconcile required same-role instances
 -> select Store DB, transcript fallback, or metadata-only state
 -> build v0.16 Composer identities
 -> compute fixed-orientation alignment
 -> allocate unmatched Store identities/collisions
 -> render preferred semantics and stable tool order
 -> rewrite parent/branch/leaf IDs
 -> fill deterministic timestamp/provenance
 -> derive deterministic session timestamps/provenance
 -> calculate fidelity + actual provenance + path projections
 -> cache/release according to C
```

Fidelity mapping is centralized in one exhaustive function:

```ts
export function toLegacyFidelity(
  resolution: SessionResolution,
  selectedStoreState?: SelectedStoreState
): 'global' | 'workspace-fallback';
```

No parser/formatter independently infers `source`. Complete transcript-only with no expected DB may
be `global`; transcript used after an expected DB failure is `workspace-fallback`.

cursor-history guarantees the completeness and replacement-safety of this projection and signal;
it does not persist an arbitrary consumer's database. Recurring repository CI validates only the
generic public key/binding and complete/degraded/idempotence contract. The unchanged consumer owns
its exact adapter, digest, policy, transaction, rollback, and repeat-sync behavior; only
release-blocking T113 may assert those behaviors after running the owner-authorized external
checkout at the recorded upstream revision.

Session `createdAt`/`lastUpdatedAt` are independent of preferred rendering. A Composer-backed
view uses valid stored metadata from its selected Composer contribution. A Store-only view uses
selected Store DB metadata, then Store meta. Otherwise creation uses the earliest directly stored
message and update uses the latest, considering fixed Composer-then-Store/native source order; if
none exists, use Unix epoch with `epoch-unknown`. Provenance is `composer-metadata`,
`store-db-metadata`, `store-meta`, `direct-message`, or `epoch-unknown`. Legacy non-null message values
with unprovable origin are preserved as `unknown` but cannot anchor inference, and an
`epoch-unknown` session time cannot supply `session-fallback`.

Before public projection, set-like arrays are deduplicated and ordered centrally: every source-role
array by `composer`, then `store`; reason codes by declaration order; workspace memberships and each
required public source-instance `workspacePaths` by normalized path code-point order; source
instances by role, representation declaration order, lexicographic `workspacePaths`, then state
declaration order; diagnostic refs by stable payload fingerprint and then opaque ref. Semantic
message/branch/tool/file arrays retain their specified source order. Formatters never re-sort these
arrays independently.

## Defensive parsing boundary

```ts
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

export const SOURCE_READ_LIMITS_V1_DEFAULTS: Readonly<SourceReadLimitsV1>;
```

| Field | Inclusive v1 default |
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

- Text is UTF-8 with at most one leading UTF-8 BOM. Unknown fields and SQLite columns are ignored.
- Invalid/mixed encoding is never replacement-decoded, guessed, or transcoded. It emits
  `SOURCE_ENCODING_INVALID` as partial only when a documented safe contributor remains; otherwise
  it is fatal.
- All limits are raw-byte/integer inclusive defaults: equality passes and the first unit above emits
  `SOURCE_LIMIT_EXCEEDED`, never a silently truncated complete view. JSONL counts one transcript;
  SQLite page limits apply to keyset/row-ID metadata pages and sequential payload fetches, while
  row/decoded totals reset per logical-session hydration and separately per catalog scan; ZIP
  compressed, central-directory, and streamed-output counters reset per archive.
- ZIP applies ratio `uncompressed / max(compressed, 1)` to each nonempty entry and the aggregate; a
  zero-byte compressed entry claiming nonempty output fails. Metadata claims never raise a limit.
- A validated `Partial<Omit<SourceReadLimitsV1, 'policyVersion'>>` override is copied and frozen into
  `OperationIoContext`. It may raise or lower defaults per operation but cannot come from globals,
  environment, input, or a manifest; cannot request `unlimited`; and never triggers automatic retry.
  Values must be positive safe integers, obey the documented cross-field inequalities and runtime
  string-materialization bound, or fail before content I/O with
  `SOURCE_LIMIT_CONFIGURATION_INVALID`.
- An omitted recognized field or recognized own property with value `undefined` inherits the
  default; `null` is invalid. Reject every unknown own key and any `policyVersion` override before
  content I/O, including unknown keys whose value is `undefined`.
- `SOURCE_LIMIT_EXCEEDED` safe details contain `policyVersion`, `sourceKind`, named `bound`, `limit`,
  `observedAtLeast`, `unit`, partial/fatal `outcome`, `retryableWithOverride: true`, and an actionable
  remedy, never content or a locator. The diagnostic is an exact source-kind/bound/unit
  discriminator: byte bounds use `bytes`, JSONL/ZIP counts use `records`, SQLite row bounds use
  `rows`, and only ZIP compression ratio uses `ratio`. Byte/count/row observations are positive
  integers; the exact first failing ZIP ratio may be fractional.
- Each bounded unit checks the context `AbortSignal`; parse/limit/cancellation paths dispose every
  private artifact through the same nested `finally` chain.

## Search and bulk export

```ts
export function searchSessionsInContext(
  query: string,
  options: SearchOptions,
  context: SessionReadContext
): Promise<OperationResult<SearchResult[]>>;

interface OperationResult<T> {
  value: T;
  diagnostics: SessionDiagnostic[];
}
```

Core search snippets carry both display-relative ranges and authoritative complete-content ranges:

```ts
interface SearchSnippet {
  messageRole: MessageRole;
  text: string;
  matchPositions: [number, number][]; // relative to display text only
  messageIndex: number; // zero-based complete session message array
  contentMatchPositions: [number, number][]; // UTF-16 ranges in original content
}
```

Case-insensitive matching maps lowercase-expanded positions back to the original JavaScript string.
The library adapter uses the first `contentMatchPositions` start, finds its complete original source
line, and selects complete adjacent lines; it never reverse-engineers coordinates from ellipsized
`text`. The v0.16/v0.17 placeholder/snippet-relative result is locked separately as an affected-
release baseline for the 0.18.0 corrective exception. JSON export projection maps the core
one-based row index to a zero-based public-library `index` without mutating the cached core object;
tagged v0.16/v0.17 exports had no `index` field.

The internal result envelope is not the public-library return shape. CLI can serialize diagnostics;
library adapters call `onDiagnostic` or throw according to the public contract.

Bulk loops:

- create/bind a capacity-0 context unless a compatible one is supplied;
- iterate bound logical rows once;
- resolve by bound address/UUID, never summary index;
- release each decoded session in per-row `finally`;
- emit one diagnostic and no payload/file for each ambiguity group;
- dispose context in outer `finally`.

## Migration preparation and application

```ts
export function bindMigrationTargets(
  selectors: readonly (number | string)[],
  options: MigrationBindingOptions,
  context: SessionReadContext
): Promise<BoundMigrationTarget[]>;

export function prepareSessionMigration(
  target: BoundMigrationTarget,
  destination: string,
  options: MigrationOptions
): Promise<PreparedSessionMigration>;

export function applySessionMigration(
  prepared: PreparedSessionMigration
): Promise<SessionMigrationResult>;
```

`PreparedSessionMigration` contains the exact private source locator, destination preflight,
capability profile, mode, source fingerprint, and proposed copy UUID. It is never public JSON.

Binding requires exactly one eligible Composer locator and a mutation footprint confined to the
bound source workspace. A representative selected to read equivalent replicas is not reused for
mutation; equivalent multiple locators, multiple same-workspace records, and a global record shared
with another membership are rejected before preparation.

Both numeric and direct-ID selectors first address the complete scoped logical catalog, including
ambiguous rows. Ambiguity retains its displayed ordinal; selecting it by number or UUID throws the
same `SessionAmbiguityError` with the same safe UUID/occurrence references. Binding never filters an
ambiguity first, shifts later indices, reports a false not-found, or reads contested payload.

Before first write, `applySessionMigration` rechecks data-source identity, exact record/UUID,
fingerprint, source/destination state, and required `readWrite` capability. Any mismatch throws
`MigrationTargetChangedError`; it does not rediscover another record. Dry-run returns a safe
projection of the same prepared object.

## Private temporary workspace

```ts
export interface PrivateTempWorkspaceOptions {
  prefix: string;
  parent?: string; // defaults to os.tmpdir(); parent permissions are never changed
  signal?: AbortSignal; // owning operation; cleanup remains best-effort and idempotent
}

export function createPrivateTempWorkspace(
  options: PrivateTempWorkspaceOptions
): PrivateTempWorkspace;

interface PrivateTempWorkspace {
  readonly path: string;
  readonly marker: {
    formatVersion: 1;
    uid?: number;
    pid: number;
    pidNamespaceToken?: string; // Linux boot ID + namespace inode when procfs is verifiable
    processStartToken: string;
    createdAt: string;
  };
  createFile(name: string): string;
  register(path: string): void;
  dispose(): void;
}
```

The directory is unique/exclusive and `0700` on POSIX. `createFile` uses exclusive creation and
`0600`. On Windows, use the system per-user temporary location, inherit its access controls, and
retain the same uniqueness/no-reuse/cleanup rules without claiming separately verified cross-user
ACL isolation. For online backup, create the target privately, close the creation handle, then allow
the driver to overwrite it inside the private directory. `dispose()` attempts every registered artifact
and directory even when one action fails, is safe to repeat, and throws a paths-only typed residue
error after all attempts.

Backup/Store callers use nested cleanup:

```ts
const temp = createPrivateTempWorkspace({ prefix: 'cursor-history-' });
let db: Database | undefined;
try {
  // snapshot/open/parse
} finally {
  try {
    db?.close();
  } finally {
    temp.dispose();
  }
}
```

If both operation and cleanup fail, preserve the operation error as cause and surface cleanup
residue in structured details; never report cleanup success.

Every live workspace is registered in one process-level registry. Coordinated `SIGINT`,
`SIGTERM`, and `SIGHUP` handlers perform synchronous best-effort disposal once and then preserve
normal platform signal termination semantics. Before new temporary work, stale recovery examines
only exact-prefix directories owned by the current user with a valid private marker. On Linux, the
marker records a boot-scoped PID-namespace token (boot ID plus namespace inode) when procfs exposes
one. Recovery interprets PID plus process-start token only after the marker and recovering process
have readable, equal namespace tokens; a different host boot or namespace and missing or unreadable
namespace provenance remain owner-status-uncertain and are never deleted. Same-namespace death and
PID reuse remain recoverable. Non-Linux platforms retain their existing process-liveness proof
without claiming Linux namespace validation. `SIGKILL`, power loss, and kernel termination cannot
run cleanup, so immediate deletion is not guaranteed; `0700`/`0600` privacy plus conservative
next-run recovery is the explicit limit.

### Backup manifest producer contract

- A newly created manifest records the exact `package.json` version embedded in the running packed
  artifact as `producer`; it never uses a historical hard-coded literal.
- A missing or older producer value remains readable.
- `producer` is diagnostic provenance only and is excluded from logical/session/message identity,
  replica equivalence, deduplication, and incremental-sync comparisons.
- The packed-artifact smoke creates and rereads an archive and asserts the producer equals the exact
  artifact under test.

### Backup publication commit contract

- Publishing the complete staging inode by rename/link to the final path is the commit point.
- Capture the private stage's lossless bigint device/inode identity. Open the final path without
  following links, require the same regular-file identity, change mode only through that descriptor,
  and recheck descriptor and final path afterward. A nonregular path or replacement race fails and
  never chmods the replacement.
- Read the verified published mode and return without `chmod` when it equals the requested mode.
- A mode read, identity, or adjustment failure after commit never unlinks or rolls back the archive
  inode that crossed the commit point. Throw `BackupPublishedPermissionError` with code
  `BACKUP_PUBLISHED_PERMISSION_FAILED`, `published: true`, output path,
  `pathIdentityVerified`, requested mode, and `actualMode` as the last safely observed staged-archive
  inode mode or `null`, never a possible replacement-path mode. Preserve the filesystem cause.
- Only `pathIdentityVerified: true` proves the final path still names the staged archive and permits
  an inspect/correct remedy for that file. A false value makes the path untrusted and requires the
  user to establish which file, if any, is the completed archive before recovery.
- The CLI maps this typed failure to a nonzero I/O exit and stderr fatal output. It must not report
  rollback or recommend a blind `--force` retry. All unpublished private staging paths are still
  disposed in `finally`.
- After non-force link publication, clean the private sibling only while its no-follow device/inode
  identity matches the committed archive. Exhausted or unverifiable cleanup throws
  `BackupPublishedCleanupError`/`BACKUP_PUBLISHED_CLEANUP_FAILED` with `published: true`, output
  `pathIdentityVerified`, verified `residuePaths`, and `unverifiedResiduePaths`. Never unlink a
  replacement occupant or blindly delete, chmod, or force-retry an unverified path.

### Restore admission and destination contract

- Normalize each manifest path and require an exact type/path shape from the finite Composer backup
  layout before extraction. Every non-directory ZIP entry other than `manifest.json` must be
  represented exactly once. Reject an empty manifest, no-intact archive, unmanifested file entry,
  traversal, aliases that resolve to one destination, type/path mismatches, and unsupported files.
- Stream each entry into private staging, but admit it to the publication set only after both its
  manifest size and checksum pass. A corrupt entry remains a warning/diagnostic and never receives
  a destination.
- Derive all destinations beneath the Cursor user root, then preflight the complete set before the
  first publication. Reject symlink or other path indirection that can escape confinement. Without
  force, any existing validated destination rejects the whole restore with zero writes; force does
  not relax path, integrity, duplicate, or confinement validation.
- Copy each validated payload into a newly created private same-directory inode. Forced publication
  uses atomic rename to replace the directory entry without opening/truncating its old inode, so
  other hard links remain unchanged. Non-forced publication uses an atomic hard-link no-clobber
  commit and fails if a destination appears after preflight.
- Canonicalize the explicitly selected user root, inspect descendants without following links, and
  repeat that inspection immediately before each directory-entry commit. On the supported Node 20
  runtime there is no portable directory-relative no-follow creation primitive, so this contract
  handles observed/static leaf links and multiply linked regular-file destinations but does not
  claim atomic resistance to a hostile concurrent ancestor swap in an owner-controlled tree.
- A mixed-validity archive may publish its intact subset and report every size or checksum mismatch
  as skipped. Rollback includes only validated entries actually published before a later failure and
  records their committed device/inode identity. Rollback touches a destination only while it still
  matches that identity; a concurrent leaf replacement remains untouched and is reported as a safe
  manifest-relative residual. Eligible prior bytes are republished through the same private-inode
  atomic-replacement path. An incomplete
  rollback throws `RestoreRollbackError`/`RESTORE_ROLLBACK_INCOMPLETE` with the published count and
  only canonical manifest-relative residual paths, never a false `filesRestored: 0` result.

## Database capability registry

```ts
export type DatabaseCapability = 'read' | 'readWrite' | 'onlineBackup';

export interface DatabaseOperationRequest {
  operation: 'read-session' | 'migrate' | 'backup' | 'store-snapshot';
  required: ReadonlySet<DatabaseCapability>;
  forcedDriver?: SqliteDriverName;
}

export function selectDatabaseDriver(
  request: DatabaseOperationRequest
): Promise<DatabaseDriver>;
```

- Driver profiles are cached per provider/runtime, not selected once globally.
- `node:sqlite` imports with optional `backup`; the function must exist for `onlineBackup`.
- Driver adapters probe the constructor/open and statement operations cursor-history actually uses.
- Auto preference order is node:sqlite then better-sqlite3 among capable profiles.
- Forced mode has no fallback.
- Preference precedence is operation/library config, then process `setDriver`, then environment,
  then auto.
- `parseStoreDb` distinguishes malformed/partial source data from infrastructure/capability failure;
  the latter propagates exactly once.

## Error propagation

Core throws typed errors with stable codes, including `SOURCE_ENCODING_INVALID` and
`SOURCE_LIMIT_EXCEEDED`. CLI maps them to the applicable existing exit category and safe JSON on
stderr for every fatal outcome; library
re-exports/maps them without wrapping in a bare error. Continuation is allowed only where the
operation contract explicitly supports diagnostics (list/search/bulk export). A rejected individual
resolution is removed from the active/cache maps and does not block unrelated rows.

## Compatibility adapters

During implementation, existing core positional signatures may delegate into the new bound model.
Adapters must satisfy all of the following:

- unfiltered numeric behavior remains unchanged;
- unfiltered direct native-ID behavior remains unchanged;
- scoped numbers and IDs use the immutable scope;
- summaries are followed by stable UUID/bound address, never a fresh numeric lookup;
- old `source` TypeScript literals remain accepted but are not emitted by new resolution;
- old `setDriver(): void` remains synchronous;
- no adapter can construct a public physical locator or silently downgrade a typed error.
