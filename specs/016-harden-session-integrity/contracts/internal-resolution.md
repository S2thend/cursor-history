# Internal Resolution Contract

**Feature**: `016-harden-session-integrity`<br>
**Audience**: Core, CLI, library, and test implementations

This contract defines load-bearing internal boundaries. They are not an invitation to export
physical locators from the npm library.

## Module ownership

| Module | Owns | Must not own |
|--------|------|--------------|
| `session-identity.ts` | v0.16 Composer projection, Store candidates, canonical hashes, collisions, relationship rewrites | Workspace filtering, file discovery, CLI formatting |
| `session-catalog.ts` | metadata inventory, UUID grouping, role classification, Store representation selection, replica reconciliation, bound rows | Conversation rendering, public path aliases, filesystem mutation |
| `workspace-scope.ts` | lexical normalization, exact/unique-suffix resolution, match diagnostics | Payload reads, logical ID changes |
| `storage.ts` | context lifecycle, listing/resolution/search orchestration, lazy hydration | Identity algorithms duplicated inline, destructive migration writes |
| `private-temp.ts` | exclusive private staging, tracked cleanup, residue error | ZIP/SQLite parsing semantics |
| `database/registry.ts` | capability profiles and per-operation provider selection | Store completeness policy |
| `migrate.ts` | bind/prepare/revalidate/apply exact eligible target | Numeric rediscovery after preparation |

## Read context construction

```ts
export interface SessionReadContextOptions {
  dataPath?: string;
  backupPath?: string;
  workspacePath?: string;
  includeCrossWorkspaceSources?: boolean;
  resolvedSessionCapacity?: number;
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
  sqliteDriver?: SqliteDriverName;
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
  releaseSession(key: string): void;
  dispose(): Promise<void>;
}
```

- Every core operation verifies that its positional compatibility arguments agree with the context.
- A mismatch fails before catalog or content I/O.
- `dispose()` is idempotent. Built-in callers invoke it in `finally`.
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
before performing each open/read/query/get:

```ts
type AdapterIoReadEvent = {
  adapter: 'filesystem' | 'sqlite' | 'key-value';
  operation: 'open' | 'read' | 'query' | 'get';
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
- Sort logical rows by the existing deterministic session ordering; use native UUID as the final
  stable tie-breaker.
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
4. Attempt Store DB first. A usable partial DB remains selected and transcript never fills it. An
   absent/empty/source-corrupt expected DB may fall back to transcript but remains partial;
   transcript is complete only for `not-expected`; `unknown` remains partial. When conversation
   may exist but none is usable, including a `not-expected` session with an unusable transcript or
   other positive conversation evidence, resolve degraded `store-metadata`. Omission is allowed
   only for explicit `hasConversation:false` with no positive conversation evidence. A divergent
   DB group is ambiguous and never falls through to transcript. Capability or snapshot failures are
   fatal, never fallback.
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

Before first write, `applySessionMigration` rechecks data-source identity, exact record/UUID,
fingerprint, source/destination state, and required `readWrite` capability. Any mismatch throws
`MigrationTargetChangedError`; it does not rediscover another record. Dry-run returns a safe
projection of the same prepared object.

## Private temporary workspace

```ts
export interface PrivateTempWorkspaceOptions {
  prefix: string;
  parent?: string; // defaults to os.tmpdir(); parent permissions are never changed
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
    processStartToken: string;
    createdAt: string;
  };
  createFile(name: string): string;
  register(path: string): void;
  dispose(): void;
}
```

The directory is unique/exclusive and `0700` on POSIX. `createFile` uses exclusive creation and
`0600`. For online backup, create the target privately, close the creation handle, then allow the
driver to overwrite it inside the private directory. `dispose()` attempts every registered artifact
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
only exact-prefix directories owned by the current user with a valid private marker and removes one
only when PID plus process-start token proves the owner dead (including PID reuse); uncertain
candidates remain untouched. `SIGKILL`, power loss, and kernel termination cannot run cleanup, so
immediate deletion is not guaranteed; `0700`/`0600` privacy plus conservative next-run recovery
is the explicit limit.

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

Core throws typed errors with stable codes. CLI maps them to exit category and safe JSON; library
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
