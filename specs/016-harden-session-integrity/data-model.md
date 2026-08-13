# Data Model: Session Integrity and Compatibility Hardening

<!-- source-read-limits/v1 policy-sha256: b130f4fb03e3ef04f0f01527585ee939df0243e8105a44f6a23fe6d15c9f9108 -->

**Feature**: `016-harden-session-integrity`<br>
**Date**: 2026-08-05

## Model boundaries

The model deliberately separates four concepts that were previously overloaded:

```text
native UUID ──> LogicalSessionRecord
                  ├── WorkspaceMembership (0..n)
                  ├── SourceRoleGroup: composer
                  │     └── PhysicalSourceInstance (1..n)
                  └── SourceRoleGroup: store
                        ├── Store DB candidate(s)
                        └── transcript fallback candidate(s)

LogicalSessionRecord + bound ReadScope
                  └── ResolutionPlan
                        ├── ResolvedSessionView (complete | partial)
                        └── AmbiguousSessionSummary (no resolved payload)
```

Public logical identity never contains a workspace, source role, representation, index, or physical
locator. Locators are private implementation values; the only physical reference that may leave
core is an opaque, operation-scoped diagnostic reference for an ambiguity.

Source/carrier applicability comes only from the normative specification and its design projection
[`contracts/compatibility-matrix-v1.md`](contracts/compatibility-matrix-v1.md). In matrix v1,
supported backup archives contain Composer `state.vscdb` representations only. The packed package
repeats the same verified table in `docs/compatibility.md`.

## Shared value types

```ts
type SourceRole = 'composer' | 'store';

type SourceRepresentation =
  | 'composer-global'
  | 'composer-workspace'
  | 'store-db'
  | 'store-transcript'
  | 'store-metadata';

type ResolvedSource =
  | 'composer'
  | 'store-db'
  | 'store-transcript'
  | 'store-metadata'
  | 'merged';

type StoreDbExpectation = 'expected' | 'not-expected' | 'unknown';
type ComposerTier = 'global-primary' | 'workspace-fallback';

type ResolutionState = 'complete' | 'partial';
type SummaryResolutionState = ResolutionState | 'ambiguous';

type ResolutionReasonCode =
  | 'workspace-scope-omitted'
  | 'source-unavailable'
  | 'source-read-failed'
  | 'source-partial'
  | 'expected-store-db-unavailable'
  | 'store-db-expectation-unknown'
  | 'store-conversation-unavailable';

type InstanceResolutionState =
  | 'contributed'
  | 'equivalent-replica'
  | 'omitted-by-scope'
  | 'failed'
  | 'superseded';

type MessageIdentityOrigin =
  | 'composer-native'
  | 'composer-v0.16-index'
  | 'store-db-v1'
  | 'store-transcript-v1';

type ToolIdentityOrigin = 'source-native' | 'tool-v1';

type MessageTimestampSource =
  | 'composer-created-at'
  | 'composer-timing'
  | 'store-turn-timing'
  | 'inferred-previous'
  | 'inferred-next'
  | 'session-fallback'
  | 'unknown';

type SessionTimestampSource =
  | 'composer-metadata'
  | 'store-db-metadata'
  | 'store-meta'
  | 'direct-message'
  | 'epoch-unknown';

type IndexScope = 'global' | 'workspace';
type WorkspaceMatchKind = 'exact' | 'unique-suffix';
type ReplicaState = 'single' | 'equivalent' | 'divergent';

// Folded only when the source token satisfies canonical UUID syntax.
type LogicalSessionKey = string;
// Exact source-native record/key spelling; never derived from caller casing.
type PhysicalSessionId = string;

type TextEncodingState = 'utf8' | 'utf8-bom' | 'invalid-or-mixed';
type JsonlSourceBoundKind =
  | 'jsonl-record-bytes'
  | 'jsonl-source-bytes'
  | 'jsonl-record-count';
type SqliteSourceBoundKind =
  | 'sqlite-page-rows'
  | 'sqlite-page-bytes'
  | 'sqlite-value-bytes'
  | 'sqlite-row-count'
  | 'sqlite-decoded-bytes';
type ZipSourceBoundKind =
  | 'zip-compressed-bytes'
  | 'zip-entry-count'
  | 'zip-entry-bytes'
  | 'zip-aggregate-bytes'
  | 'zip-compression-ratio';
type SourceBoundKind =
  | JsonlSourceBoundKind
  | SqliteSourceBoundKind
  | ZipSourceBoundKind;

type JsonlSourceLimitDimension =
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
type SqliteSourceLimitDimension =
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
type ZipSourceLimitDimension =
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
```

All set-like public arrays are deduplicated before deterministic ordering: source-role arrays use
`SourceRole` declaration order; reason codes use `ResolutionReasonCode` declaration order;
workspace memberships use normalized-path code-point order; every public instance's
`workspacePaths` uses that same order; public source instances use the tuple source-role declaration
order, representation declaration order, lexicographic `workspacePaths` sequence, then instance-state
declaration order; and diagnostic occurrence references use stable payload-fingerprint order with
the opaque reference as final tie-breaker. Semantically ordered arrays—messages, branches, tools,
files, and other source-native sequences—retain their separately specified order.

## 1. DataSourceBinding (internal)

Identifies one immutable corpus for a read or mutation.

| Field | Type | Rules |
|-------|------|-------|
| `kind` | `'live' \| 'backup'` | Exactly one. |
| `dataPath` | absolute normalized path | Required for live; default Cursor root is resolved before binding. |
| `backupPath` | absolute normalized path | Required for backup. |
| `identity` | stable operation-local string | Derived from kind plus normalized source path; not public. |
| `sqliteDriverPreference` | driver name or `auto` | Immutable for the context. |

Validation:

- Live and backup paths are mutually exclusive.
- Changing either source after context construction raises a typed source-mismatch error before I/O.
- A custom path is part of index scope even when the displayed `indexScope` token is only `global`
  or `workspace`; documentation states that an index cannot cross data sources.

## 2. PhysicalSourceInstance (internal)

Represents one discoverable occurrence before logical reconciliation.

| Field | Type | Rules |
|-------|------|-------|
| `logicalSessionId` | string | Deterministic source-native spelling returned publicly. |
| `logicalSessionKey` | `LogicalSessionKey` | Canonical UUID key used for case-insensitive logical grouping; a noncanonical identifier remains exact. |
| `physicalSessionId` | `PhysicalSessionId` | Exact workspace record ID, SQLite key, or Store directory token used by the locator; never case-folded for I/O. |
| `sourceRole` | `SourceRole` | Composer or resolved Store contribution. |
| `representation` | `SourceRepresentation` | Describes physical encoding, not fidelity. |
| `locator` | discriminated private union | Exact DB/record/file location; never serialized. |
| `workspacePaths` | normalized path array | Verified memberships only; deduplicated deterministically. |
| `fidelityHint` | internal state | Metadata-time expectation, not a final completeness claim. |
| `storeDbExpectation` | `StoreDbExpectation` or absent | Set on Store instances from metadata inventory before payload hydration. |
| `sourceOrder` | integer | Stable within its storage representation. |
| `payloadState` | `unread \| loading \| loaded \| failed` | Payload is lazy. |
| `payloadFingerprint` | string or absent | Equivalence v1, computed only when a competing group must be reconciled. |
| `occurrenceRef` | opaque string or absent | Generated only for diagnostic output inside one bound source/context. |

Internal locator variants include Composer global DB/record, Composer workspace DB/record, Store DB,
Store transcript, and Store metadata. Composer locators preserve both the exact workspace record ID
and exact global SQLite key when both participate. No formatter or public-library mapper accepts a
locator type. Compact 32-hex identifiers without canonical UUID separators are not UUID-folded.

## 3. WorkspaceMembership

```ts
interface WorkspaceMembership {
  workspacePath: string;
  sourceRoles: SourceRole[];
  contributingInstanceCount: number;
}
```

Rules:

- A path is a normalized full path; different raw spellings of the same normalized path collapse.
- One logical session may belong to several workspaces and counts once in each workspace listing.
- `contributingInstanceCount` describes metadata membership, not authorization to mutate an
  occurrence.
- The active match is represented separately as `matchedWorkspacePath` and `workspaceMatchKind`.

## 4. ReplicaGroup (internal)

Groups candidates competing for the same logical UUID, source role, representation, and fidelity
tier.

```ts
interface ReplicaGroup {
  logicalSessionId: string;
  sourceRole: SourceRole;
  representation: SourceRepresentation;
  equivalenceVersion: 1;
  candidates: PhysicalSourceInstance[];
  state: ReplicaState;
  selected?: PhysicalSourceInstance;
}
```

Equivalence v1 participates:

- ordered stable message IDs and roles;
- source timestamp values proven to be directly stored in the physical payload (the values
  themselves, not their provenance annotations);
- exact content and structured thinking/error content;
- parent, branch, leaf, and sidechain relationships;
- ordered tool activity, code blocks derived from message content, and attachment evidence
  losslessly projected into message `content` or consumed tool-call `name`, `status`, `params`,
  `result`, and `error` fields.

It excludes physical paths/locators, discovery order, `timestampSource` and all other
provenance-only annotations, workspace match, and inferred/session-fallback/epoch display timestamp
values. It also excludes standalone cursor-history `codeBlocks` and tool `files` outside the frozen
generic downstream compatibility projection; semantically required evidence from either must
already be projected into a covered public field or the contribution is partial. Thus changing only
provenance annotations or ignored
standalone values is equivalent, but changing an actually stored timestamp or consumed value is
divergent. Equivalent candidates select a deterministic representative and retain all
source-instance provenance. Divergent candidates have no selected payload.

### 4.1 Composer tier arbitration

Composer arbitration occurs before Composer/Store merging and has a fixed direction:

```text
permitted composer-global candidates
  -> reconcile only against composer-global candidates
  -> one usable reconciled global contribution ------> Composer contribution (primary)
  -> no usable global contribution
       -> permitted composer-workspace candidates
       -> reconcile only against composer-workspace candidates
       -> usable workspace contribution --------------> Composer contribution (partial fallback)
       -> no usable workspace contribution ------------> unavailable/fatal according to failure class
```

Rules:

- `composer-global` is `global-primary`; `composer-workspace` is `workspace-fallback`. The tiers are
  never compared as replicas and are never unioned to repair one another.
- Competing permitted occurrences are compared only within the same tier. One is `single`, equal
  equivalence-v1 fingerprints are `equivalent`, and unequal fingerprints are `divergent` with no
  selected payload.
- A divergent global tier is an ambiguous logical session and cannot be hidden by workspace
  fallback. Fallback is considered only when the global tier is absent or source-unavailable
  without a divergent usable group.
- When a usable global contribution exists, workspace records contribute only membership and
  source-instance provenance and are marked `superseded`; their differing payload does not create
  an ambiguity.
- Composer workspace content is selected only when no permitted usable global exists. Every such
  view is partial and maps to legacy `source: 'workspace-fallback'`, including when no global
  occurrence was discovered.
- Source corruption/unreadability may permit the partial workspace fallback. Driver capability,
  snapshot infrastructure, and other operation-level failures are fatal and never become a
  fallback session.
- Under workspace scope, only permitted same-tier instances are compared. Known off-scope
  occurrences are recorded as omitted and make the view partial unless related-source loading was
  explicitly enabled. One global record linked to multiple memberships remains one physical
  occurrence, not multiple replicas.

### 4.2 Store DB expectation and representation selection

`StoreDbExpectation` is computed from catalog metadata before any Store conversation payload is
read. The classification is deterministic and uses this precedence:

1. `expected` if a per-session `store.db` was inventoried, even if it later disappears, or any
   authoritative per-session metadata explicitly has `hasConversation: true`.
2. `not-expected` if no DB was inventoried and authoritative metadata explicitly has
   `hasConversation: false`, or if the UUID is present only in the canonical transcript layout,
   inventory completed successfully, and no per-session Store directory or metadata exists.
3. `unknown` if a per-session directory/metadata exists without a DB and without an explicit
   Boolean, metadata declarations conflict or are unsupported, or inventory could not prove the
   `not-expected` conditions.

Evidence for `expected` wins conflicting negative evidence. Filesystem modification time, message
content, read time, and a failed payload open never participate in expectation classification.

The selected Store representation follows this exhaustive table. Transcript fallback rows apply
only after capable provider selection and DB snapshot/read setup succeeds; capability,
provider-selection, snapshot-setup, or other infrastructure failures take the fatal final row:

| Expectation | DB outcome | Transcript outcome | Selected representation | Resolution consequence |
|-------------|------------|--------------------|-------------------------|------------------------|
| any | complete with recoverable conversation | any, with all known relevant Store occurrences permitted by scope | `store-db` | Complete on the Store side; transcript is `superseded`. |
| any | complete with recoverable conversation | a known DB or transcript occurrence omitted by scope | `store-db` when the DB is permitted; otherwise the permitted fallback | Partial with omitted-source reason; the off-scope occurrence is never opened even if it would otherwise be `superseded`. |
| any | partial with recoverable conversation | any | `store-db` | Partial with `source-partial`; transcript never fills DB gaps. |
| `expected` | absent, empty, or source-corrupt/unreadable | complete transcript | `store-transcript` | Partial with `expected-store-db-unavailable`. |
| `expected` | absent, empty, or source-corrupt/unreadable | partial transcript | `store-transcript` | Partial with unavailability and `source-partial`. |
| `not-expected` | absent | complete transcript | `store-transcript` | Complete on the Store side. |
| `not-expected` | absent | partial transcript | `store-transcript` | Partial with `source-partial`. |
| `unknown` | absent | usable transcript | `store-transcript` | Partial with `store-db-expectation-unknown` (and `source-partial` when applicable). |
| `expected` or `unknown` | no usable conversation | none | `store-metadata` | Partial with `store-conversation-unavailable`. |
| `not-expected` | absent | unusable/empty, but transcript or other positive conversation evidence exists | `store-metadata` | Partial with `store-conversation-unavailable`. |
| `not-expected` with explicit `hasConversation: false` | absent | none, and no other positive conversation evidence | no logical conversation row | Metadata is not fabricated into an empty session. |
| any | capability/snapshot infrastructure failure | any | none | Fatal typed failure; never transcript fallback or `store-metadata`. |

Multiple DB candidates are replicas only of other DB candidates at the same fidelity tier;
multiple transcript candidates are likewise compared only with transcripts of the same tier. DB
and transcript are primary/fallback representations and are never classified as divergent replicas
merely because their payloads differ. A divergent DB group is ambiguous and cannot be hidden by a
transcript fallback; a divergent selected transcript group is likewise ambiguous.

## 5. LogicalSessionRecord (internal catalog row)

```ts
interface LogicalSessionRecord {
  id: string;
  logicalSessionKey: LogicalSessionKey;
  legacyComposerDiscoveryOrdinal?: number;
  canonicalWorkspacePath?: string;
  workspaceMemberships: WorkspaceMembership[];
  composerGlobalGroups: ReplicaGroup[];
  composerWorkspaceGroups: ReplicaGroup[];
  storeDbGroups: ReplicaGroup[];
  storeTranscriptGroups: ReplicaGroup[];
  storeDbExpectation?: StoreDbExpectation;
  summaryState: SummaryResolutionState;
  createdAtHint?: Date;
  updatedAtHint?: Date;
}
```

Rules:

- `id` is the sole public logical ID and is always the native UUID.
- Canonical UUID syntax groups by `logicalSessionKey` case-insensitively, but `id` retains one
  observed source spelling with Composer precedence. Noncanonical IDs use their exact bytes as the
  key.
- `legacyComposerDiscoveryOrdinal` captures the v0.16 `localeCompare()` workspace-discovery
  position before reconciliation and controls equal-`createdAt` compatibility order.
- Composer global/workspace groups and Store DB/transcript groups first obey their fixed
  primary/fallback arbitration; different fidelity tiers are not compared as replicas or merged
  blindly.
- Complementary Composer and selected Store contributions are merged after same-role reconciliation.
- A divergent required group changes `summaryState` to `ambiguous` and prevents a normal resolved
  session.
- The canonical path is frozen independently of active scope and preferred merge source. Composer
  attribution wins for Composer-backed sessions; only Store-only sessions may use reliable Store cwd.

## 6. BoundReadScope and workspace matching (internal)

```ts
interface BoundReadScope {
  dataSource: DataSourceBinding;
  requestedWorkspace?: string;
  matchedWorkspacePath?: string;
  workspaceMatchKind?: WorkspaceMatchKind;
  includeCrossWorkspaceSources: boolean;
}
```

State transition:

```text
unbound request
  -> normalize candidates and request
  -> exact match found --------------------> bound exact
  -> no exact + one component suffix ------> bound unique-suffix
  -> no exact + many suffixes --------------> WorkspaceAmbiguityError
  -> no exact + no suffix ------------------> empty scoped catalog + diagnostic
```

This transition completes before any conversation payload is opened. With no workspace request,
the context binds an explicit global scope rather than an undefined/mutable state.

### 6.1 AdapterIoEvent and OperationIoContext (internal test/audit seam)

```ts
interface OperationIoContext {
  contextId: string;
  dataSourceIdentity: string;
  sourceReadLimits: Readonly<SourceReadLimitsV1>;
  signal?: AbortSignal;
  emit?: (event: AdapterIoEvent) => void; // core/test seam; not a public locator API
}

interface AdapterIoEvent {
  adapter: 'filesystem' | 'sqlite' | 'key-value';
  operation: 'open' | 'read' | 'prepare' | 'query' | 'get' | 'backup';
  contextId: string;
  dataSourceIdentity: string;
  logicalSessionId?: string;
  sourceRole?: SourceRole;
  representation?: SourceRepresentation;
  resourceClass: string; // stable safe class, never a raw path, SQL value, key, or content
  classification: 'catalog-metadata' | 'conversation-payload';
}
```

Rules:

- The filesystem, SQLite, and key/value adapters emit an event immediately before each actual
  open/read, statement prepare/query, online backup, or key/value read. A resolver-level observer
  may mirror these events but cannot substitute for them.
- One immutable `OperationIoContext` propagates through catalog discovery, hydration, parsing,
  snapshot/backup, and cleanup. Nested adapters copy `contextId`, `dataSourceIdentity`, the validated
  frozen `sourceReadLimits`, `signal`, and the audit emitter rather than constructing an unbound
  context.
- Adapter operations must select a reviewed resource class. An absent or unknown classification is
  treated as `conversation-payload`, never as metadata.
- Metadata classes are restricted to membership/inventory fields. Titles, previews, transcript
  lines, bubbles/leaves, tool inputs/results, code, and attachments are payload regardless of the
  container in which they appear.
- Scope tests assert the low-level event log and install off-scope poison-canary database rows,
  transcript files, and key/value blobs that throw on any touch. A result-only assertion cannot
  prove the I/O boundary.

## 7. StableMessageIdentity

```ts
interface StableMessageIdentity {
  value: string;
  version: 1;
  origin: MessageIdentityOrigin;
  sourceOrdinal: number;
  baseFingerprint?: string;
  occurrence?: number;
  collisionOrdinal?: number;
}
```

Identity allocation order:

1. Produce the locked v0.16 Composer-only projection.
2. Preserve every nonempty Composer native ID; assign missing/empty identities as
   `msg:<zero-based-v0.16-index>`.
3. Compute Store representation candidates and equal-fingerprint occurrences in source-native order.
4. Compute a preferred-source-independent Composer-to-Store alignment.
5. Matched Store nodes inherit the paired Composer identity.
6. Seed used IDs with all frozen Composer values; allocate unmatched Store candidates in Store-native
   order, adding the smallest positive `:collision:<n>` suffix when required.
7. Rewrite all relationships through the alignment/identity map.

Native-versus-compatibility Composer collisions remain visible because changing either token would
break released keys. Internal processing uses `(logical session, physical occurrence, source
ordinal)` to distinguish them; it does not silently mutate public identity.

For a v0.16 message whose public `id` was missing, null, or empty, step 2 also materializes that exact
compatibility token in the resolved public `id` property. This is the same key the unchanged
consumer already synthesized and is the sole permitted non-additive message-ID shape transition;
every nonempty native ID and every unrelated pre-existing property shape remain exact.

## 8. StableToolIdentity

```ts
interface StableToolIdentity {
  value: string;
  version: 1;
  origin: ToolIdentityOrigin;
  parentMessageId: string;
  sourceOrdinal: number;
}
```

Rules:

- A source-native call ID, when present, is preserved byte-for-byte.
- A call without a native ID uses the `tool:v1:<message-id>:<canonical-input-hash>:<occurrence>`
  namespace.
- Calls are paired inside an already aligned message with one fixed Composer-to-Store orientation
  and three non-overlapping passes:
  1. exact nonempty native call ID plus exact tool name;
  2. exact canonical request signature: exact name and recursively code-point-sorted `params`;
  3. exact name only when at least one of the two candidates lacks `params`.
- Every pass is stable one-to-one: visit the earliest unmatched Composer call first, choose the
  earliest unmatched Store call, and break duplicate signatures by native occurrence order. Calls
  with differing present `params` never match.
- Status, result, error, duration, and other later enrichment are excluded from matching and
  synthetic identity inputs.
- Standalone `files` are excluded from compatibility matching and equivalence. They may participate
  in a Store-only modern synthetic tool ID, but semantically required file evidence must be
  projected into a consumed field before matching or the contribution is partial.
- Composer tool slots never reorder. Matched Store data enriches the corresponding slot; unmatched
  Store calls append in Store-native order.
- The v0.16 downstream compatibility key remains message-key plus zero-based tool array index; the
  additive modern ID does not replace that legacy consumer behavior.

### 8.1 Attachment compatibility projection

The unchanged v0.16 consumer has no attachment field, derives code blocks from message content, and
does not consume standalone cursor-history `codeBlocks` or `ResolvedToolCall.files`. Supported
source attachment evidence is therefore projected deterministically and losslessly into message
`content` (including fenced code) or consumed tool-call `name`, `status`, `params`, `result`, and
`error` fields. Those resulting consumed values—not a new attachment object or ID—participate in
digest and replica equivalence. A raw attachment block that cannot be represented losslessly in
those fields makes its source/session partial with
`source-partial`, so it cannot emit `source: 'global'`. Parsing, projection, and hashing use only
stored metadata/content and never open, download, stat, or hash an external attachment target.

## 9. ResolvedMessage and ResolvedToolCall

```ts
interface ResolvedMessage {
  id: string;                         // guaranteed nonempty in resolved output
  messageIdentityVersion: 1;
  identityOrigin: MessageIdentityOrigin;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;                    // always present in public output
  timestampSource: MessageTimestampSource;
  source?: 'composer' | 'store' | 'both';
  parentMessageId?: string;
  isSidechain?: boolean;
  toolCalls?: ResolvedToolCall[];
  // existing code/thinking/token/model/duration/metadata fields remain
}

interface ResolvedToolCall {
  id: string;
  identityOrigin: ToolIdentityOrigin;
  // existing name/status/params/result/error/files fields remain
}
```

Input/parser types may remain nullable while parsing malformed data, but the resolved public
boundary must allocate an ID and deterministic timestamp/provenance for every emitted message and a
nonempty ID plus identity origin for every emitted tool call.

Timestamp state transition for a missing direct value:

```text
next directly stored value exists -> inferred-next
else previous directly stored exists -> inferred-previous
else valid session creation exists -> session-fallback
else -> 1970-01-01T00:00:00.000Z + unknown
```

An inferred timestamp never becomes the input for another inference. A legacy non-null timestamp
whose direct origin cannot be established retains its existing public serialized value
byte-for-byte with `timestampSource: 'unknown'`; it is neither relabeled as direct nor used as an
inference anchor.

Session timestamps are resolved independently of message presentation order:

```ts
interface ResolvedSessionTimestamps {
  createdAt: Date;
  createdAtSource: SessionTimestampSource;
  lastUpdatedAt: Date;
  lastUpdatedAtSource: SessionTimestampSource;
}
```

For each field, use this deterministic precedence:

1. for a Composer-backed view, the corresponding valid stored metadata value from the selected
   Composer contribution (`composer-global` before `composer-workspace`);
2. for a Store-only view, the corresponding valid selected Store DB metadata value, then valid
   Store metadata;
3. the earliest directly stored message timestamp for `createdAt`, or latest for
   `lastUpdatedAt`, considering contributed sources in fixed Composer-then-Store source order and
   native source order rather than preferred rendered order;
4. `1970-01-01T00:00:00.000Z` with `epoch-unknown`.

Invalid/non-finite metadata is skipped. An `epoch-unknown` session time and a message time with
`timestampSource: 'unknown'` cannot anchor `session-fallback`. Preferred backbone, filter,
discovery order, and wall-clock read time cannot change either session value or provenance.

## 10. ResolutionPlan (internal)

```ts
interface ResolutionPlan {
  logicalSession: LogicalSessionRecord;
  scope: BoundReadScope;
  expectedSourceRoles: SourceRole[];
  permittedInstances: PhysicalSourceInstance[];
  omittedInstances: PhysicalSourceInstance[];
  selectedComposerTier?: ComposerTier;
  storeDbExpectation?: StoreDbExpectation;
  selectedStoreRepresentation?: 'store-db' | 'store-transcript' | 'store-metadata';
  preferredSource: SourceRole;
  state: 'ready' | 'ambiguous';
}
```

Rules:

- The plan is immutable once the first payload read begins.
- Cross-workspace opt-in can add only instances of the already scoped UUID.
- An ambiguous plan cannot hydrate contested payload or become a `ResolvedSessionView`.
- A failed expected Store DB may select transcript fallback, but the view remains partial because an
  expected primary failed.

## 11. ResolvedSessionView (core/public projection)

```ts
interface SessionResolution {
  state: ResolutionState;
  expectedSourceRoles: SourceRole[];
  loadedSourceRoles: SourceRole[];
  omittedSourceRoles: SourceRole[];
  failedSourceRoles: SourceRole[];
  reasonCodes: ResolutionReasonCode[];
}

interface PublicSourceInstance {
  sourceRole: SourceRole;
  representation: SourceRepresentation;
  workspacePaths: string[];
  state: InstanceResolutionState;
}

interface ResolvedSessionView {
  id: string;
  index: number;                       // core/CLI one-based
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  source: 'global' | 'workspace-fallback';
  resolvedSource: ResolvedSource;
  sources: SourceRole[];
  preferredSource?: SourceRole;
  resolution: SessionResolution;
  createdAt: Date;
  createdAtSource: SessionTimestampSource;
  lastUpdatedAt: Date;
  lastUpdatedAtSource: SessionTimestampSource;
  workspacePath: string | null;        // core/CLI compatibility alias
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
  workspaceMatchKind?: WorkspaceMatchKind;
  workspaceMemberships: WorkspaceMembership[];
  sourceInstances: PublicSourceInstance[];
  messageIdentityVersion: 1;
  messages: ResolvedMessage[];
  activeBranchBubbleIds?: string[];
  activeBranchMessageIds?: string[];
  // existing title/time/count/usage/workspaceId fields remain
}
```

Compatibility aliases:

- Core/CLI `workspacePath` equals `canonicalWorkspacePath` when known; structured output uses `null`
  when unknown.
- Library `workspace` preserves the released v0.16 `coreSession.workspacePath` spelling (including
  `~/...` home contraction), while additive `canonicalWorkspacePath` carries the normalized full
  path. The two may differ textually while identifying the same workspace. For pathless sessions,
  `workspace` is exactly `"unknown"` and `canonicalWorkspacePath` remains absent.
- Library `timestamp` serializes `createdAt`, and existing `metadata.lastModified` serializes
  `lastUpdatedAt`; their additive source fields carry the provenance above.
- Complete/replacement-safe maps to `source: 'global'`; any degraded/unsafe view maps to
  `source: 'workspace-fallback'`.
- cursor-history's ownership ends at this complete replacement-safe projection and signal. Recurring
  CI models only its public key/binding and complete/degraded/idempotence contract. The unchanged
  compatibility consumer owns its exact adapter, digest, policy, persistence transaction, and
  rollback; only owner-authorized external T113 at the recorded upstream revision makes exact
  downstream claims. Its real Composer-only, empty-Store lane claims v0.16 upgrade compatibility;
  its separate wholly fictional Composer-plus-Store lane claims complete replacement,
  rollback/reopen/retry, and repeated-sync behavior. Neither claim substitutes for the other.
- For merged sessions, `activeBranchBubbleIds` and `activeBranchMessageIds` contain the same
  resolved selected-branch sequence. Leading, middle, and trailing Store-only active turns appear
  once; Store sidechains do not. Parent and leaf references use those resolved IDs.
- Deprecated v0.17 literals remain accepted by declarations during transition but are not emitted by
new resolution.

## 12. ResolvedSessionSummary and AmbiguousSessionSummary

```ts
interface ResolvedSessionSummary {
  id: string;
  index: number; // core/CLI one-based; public-library summary projection zero-based
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  title: string | null;
  preview: string;
  messageCount: number;
  resolutionState: ResolutionState;
  source: 'global' | 'workspace-fallback';
  resolvedSource: ResolvedSource;
  sources: SourceRole[];
  preferredSource?: SourceRole;
  resolution: SessionResolution;
  createdAt: Date;
  createdAtSource: SessionTimestampSource;
  lastUpdatedAt: Date;
  lastUpdatedAtSource: SessionTimestampSource;
  workspacePath: string | null;
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
  workspaceMatchKind?: WorkspaceMatchKind;
  workspaceMemberships: WorkspaceMembership[];
  sourceInstances: PublicSourceInstance[];
  messageIdentityVersion: 1;
}
```

A resolved summary contains the complete resolved metadata projection plus the existing lightweight
`title`, `preview`, and `messageCount`. `resolutionState` is required and equals
`resolution.state`. It never contains `messages`, message-nested tools, or branch arrays.

```ts
interface AmbiguousSessionSummary {
  id: string;
  index: number; // core/CLI one-based; public-library summary projection zero-based
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  resolutionState: 'ambiguous';
  sourceRoles: SourceRole[];
  occurrenceCount: number;
  diagnosticOccurrenceRefs: string[];
  canonicalWorkspacePath?: string;
  matchedWorkspacePath?: string;
}
```

Contested title, preview, messages, timestamps, paths from individual payloads, and migration
locators are absent. Reusing its UUID or index raises the same `SESSION_AMBIGUOUS` typed failure.

## 13. IndexAddress (internal bound address)

```ts
interface IndexAddress {
  displayedIndex: number;
  publicBase: 0 | 1;
  scope: IndexScope;
  indexWorkspacePath?: string;
  dataSourceIdentity: string;
  logicalSessionId: string;
  permittedInstanceKeys: string[];
}
```

- Core/CLI read indices are one-based.
- Public library list/get/show/export read indices remain zero-based.
- Public-library JSON exports add the same zero-based `index`. Tagged v0.16/v0.17 exports omitted
  that property, so it is additive metadata rather than a released one-based-value correction.
- Public migration configuration retains its documented one-based numeric selectors.
- The bound address cannot be reused with another context, data path, backup, or workspace.

### 13.1 PublicSearchResultProjection

```ts
interface PublicSearchResultProjection {
  session: Session;
  match: string; // complete original source line
  messageIndex: number; // zero-based in session.messages
  offset?: number; // zero-based UTF-16 code units in complete message content
  contextBefore?: string[]; // complete adjacent source lines
  contextAfter?: string[]; // complete adjacent source lines
}
```

Rules:

- Locate the first case-insensitive match against complete original message content before any
  snippet truncation or ellipsis is introduced.
- Map lowercase-expansion positions back to the original string; the exposed offset always indexes
  the returned message's original JavaScript string in UTF-16 code units.
- `match` contains the full original line that contains `offset`. Context arrays contain full
  neighboring lines and at most the requested line count on each side.
- The 0.18.0 values directly replace the released v0.16/v0.17 placeholder/snippet-relative values
  under one versioned corrective exception. Session/message/tool identities and every non-search
  session field remain unchanged.

## 14. SessionDiagnostic and typed errors

```ts
type GeneralSessionDiagnosticCode =
    | 'WORKSPACE_AMBIGUOUS'
    | 'SESSION_AMBIGUOUS'
    | 'SESSION_SCOPE_MISMATCH'
    | 'UNSUPPORTED_SESSION_MIGRATION'
    | 'DATABASE_CAPABILITY_MISSING'
    | 'TEMPORARY_ARTIFACT_CLEANUP_FAILED';

interface GeneralSessionDiagnostic {
  code: GeneralSessionDiagnosticCode;
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  occurrenceCount?: number;
  occurrenceRefs?: string[];
  remedy?: string;
}

interface SourceEncodingDiagnostic {
  code: 'SOURCE_ENCODING_INVALID';
  message: string;
  sessionId?: string;
  sourceRole?: SourceRole;
  sourceKind: 'jsonl' | 'sqlite';
  outcome: 'partial';
  remedy: string;
}

type SourceLimitExceededDiagnostic = {
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

type SessionDiagnostic =
  | GeneralSessionDiagnostic
  | SourceEncodingDiagnostic
  | SourceLimitExceededDiagnostic;
```

Errors add stable `code` and typed safe details. Raw locators and conversation content never appear.
Context errors additionally use `READ_CONTEXT_SOURCE_MISMATCH`,
`READ_CONTEXT_SCOPE_MISMATCH`, `READ_CONTEXT_OPTIONS_MISMATCH`, and `READ_CONTEXT_DISPOSED`;
migration revalidation uses
`MIGRATION_TARGET_CHANGED`; driver exhaustion uses `NO_CAPABLE_DATABASE_DRIVER`.
Post-publication archive mode failure uses `BACKUP_PUBLISHED_PERMISSION_FAILED` and safe details:

```ts
interface BackupPublishedPermissionErrorDetails {
  published: true;
  outputPath: string;
  pathIdentityVerified: boolean;
  requestedMode: number;
  actualMode: number | null; // null only when post-commit mode observation failed
  remedy: string;
}

interface BackupPublishedCleanupErrorDetails {
  published: true;
  outputPath: string;
  pathIdentityVerified: boolean;
  residueCount: number;
  residuePaths: string[]; // verified to remain bound to the published archive inode
  unverifiedResidueCount: number;
  unverifiedResiduePaths: string[]; // identity unknown; never delete/chmod blindly
  remedy: string;
}
```

Both post-commit errors mean publication committed, not that it rolled back. Only
`pathIdentityVerified: true` proves that `outputPath` still names the completed archive.

## 15. SessionReadContext (internal with public factory)

```ts
interface SessionReadContextOptions {
  dataPath?: string;
  backupPath?: string;
  workspacePath?: string;
  includeCrossWorkspaceSources?: boolean; // default false
  resolvedSessionCapacity?: number;       // default 1
  onDiagnostic?: (value: SessionDiagnostic) => void;
  sourceReadLimits?: Partial<Omit<SourceReadLimitsV1, 'policyVersion'>>;
  signal?: AbortSignal;
}

interface SessionReadContextState {
  binding: DataSourceBinding;
  scope: BoundReadScope;
  catalogPromise?: Promise<SessionCatalog>;
  activeResolutions: Map<string, Promise<ResolvedSessionView>>;
  completedLru: Map<string, ResolvedSessionView>;
  capacity: number;
  io: OperationIoContext;
  disposed: boolean;
}
```

Validation and lifecycle:

- Capacity is a finite nonnegative integer. Default is 1; built-in bulk operations pass 0.
- Active resolutions `A` are separate from the completed LRU. The context owns at most `C+A`
  decoded sessions; caller-returned objects are outside context ownership.
- A rejection is removed immediately and remains retryable.
- Cancellation is observed at bounded parser/adapter boundaries and reaches the same nested
  `try/finally` cleanup path as an operation failure.
- `releaseSession()` evicts one completed value; `dispose()` is idempotent and clears all completed
  values after active work settles/cancels according to the caller.
- Any operation after disposal fails with the typed disposed error.

## 16. BoundMigrationTarget (internal only)

```ts
interface BoundMigrationTarget {
  logicalSessionId: string;
  composerLocator: InternalComposerLocator;
  sourceWorkspacePath: string;
  dataSourceIdentity: string;
  occurrenceFingerprint: string;
  eligibility:
    | 'eligible-composer'
    | 'multiple-composer-occurrences'
    | 'shared-membership'
    | 'ambiguous'
    | 'store-only'
    | 'merged';
}
```

State transition:

```text
selector + immutable scope
  -> resolve numeric or direct-ID selector in the complete scoped logical catalog, including ambiguity rows
  -> project only ID/index/selected-ID/pane-pointer metadata across candidate workspaces
  -> bind logical row and exact Composer workspace/global occurrence spellings
  -> reject multiple physical targets, shared mutation footprint, ambiguity, Store-only, or merged
  -> hydrate only the selected occurrence and validate source, destination, driver capabilities, fingerprint
  -> bind and prepare every requested batch member
  -> if any member refuses or changes, stop with zero writes
  -> dry-run returns immutable plan OR execution revalidates
  -> first write
  -> move keeps UUID; copy assigns a new UUID
```

All validation through the second revalidation completes before the first write. Read-side
equivalence may choose a deterministic representative but never authorizes mutation of one among
several equivalent locators. A global Composer record shared by another workspace membership is not
confined to the requested mutation scope and is likewise rejected. A diagnostic occurrence
reference cannot be converted to a `BoundMigrationTarget`.
An ambiguous row never becomes a `BoundMigrationTarget`: its one-based numeric position remains
occupied, and numeric/UUID selection returns the same typed ambiguity before destination preflight
or any write.
Logical UUID matching never substitutes for physical authority: the logical key is derived with
`logicalSessionIdKey(logicalSessionId)`, while apply reads, copies, moves, and deletes only the exact
`composerLocator.sessionId` and optional `composerLocator.globalSessionId`. More than one case-only
global key is a pre-write ambiguity even when read reconciliation judged the payloads equivalent.
Catalog and selected-hydration source-read counters are separate boundaries. A migration batch is
the complete prepared array of these targets; no member is applied until the whole array passes.

## 17. PrivateTempWorkspace and BackupSnapshot (internal)

```ts
interface PrivateTempWorkspace {
  directoryPath: string;
  markerPath: string;
  marker: PrivateTempMarker;
  trackedPaths: Set<string>;
  state: 'open' | 'disposing' | 'disposed' | 'residue';
}

interface PrivateTempMarker {
  formatVersion: 2;
  uid?: number;
  pid: number;
  pidNamespaceToken?: string; // Linux boot ID + namespace inode; absence is uncertain
  processStartToken: string;
  createdAt: string;
}

interface BackupSnapshot {
  workspace: PrivateTempWorkspace;
  databasePath: string;
  database?: Database;
  state: 'created' | 'open' | 'closed' | 'cleaned' | 'residue';
}

interface PublishedBackupArchive {
  outputPath: string;
  identity: { device: bigint; inode: bigint };
  pathIdentityVerified: boolean;
  requestedMode: number;
  actualMode: number | null; // last safely observed archive-inode mode, never replacement mode
  state:
    | 'staged'
    | 'published'
    | 'published-permission-failed'
    | 'published-cleanup-failed';
  residuePaths?: string[];
  unverifiedResiduePaths?: string[];
}

interface StagedRestoreEntry {
  manifestPath: string;
  temporaryPath: string;
  integrity: 'size-and-checksum-valid';
  destinationPath?: string; // assigned only after archive-wide preflight permits restore
}

interface PublishedRestoreEntry {
  manifestPath: string;
  destinationPath: string;
  state: 'published' | 'recovery-required';
}

interface RestoreRecoveryFailure {
  publishedFileCount: number;
  residualFiles: string[]; // canonical manifest-relative paths
  residuePaths: string[]; // verified owner-private cleanup residue only
  unverifiedResiduePaths: string[]; // dominates verified classification for the same path
}
```

Rules:

- Directory creation is exclusive and unique; POSIX mode is `0700` on permission-aware platforms.
- The marker and plaintext files are exclusive and POSIX `0600` on permission-aware platforms.
- On Windows, the directory is created beneath the system per-user temporary location with
  inherited access controls and the same uniqueness, no-reuse, cleanup, and typed-residue rules.
  This feature does not claim independently verified cross-user ACL isolation.
- Close and cleanup are nested `try/finally`; cleanup attempts all tracked paths.
- Every open workspace is registered in one process-level registry. Coordinated handlers for
  `SIGINT`, `SIGTERM`, and `SIGHUP` perform synchronous best-effort disposal once, then preserve the
  platform's signal termination semantics. Cooperative cancellation still uses normal `finally`.
- Before a new operation, stale recovery considers only exact application-prefix directories owned
  by the current user with a valid marker. New workspaces emit format v2; the version is an
  authorization boundary so a v1 reader rejects the marker before probing a namespace-local PID.
  The current reader accepts valid v1 markers for recognition, but on Linux retains them as
  legacy/owner-status-uncertain even if they carry an unknown namespace field. For v2 on Linux it
  first requires a readable marker and current boot-scoped PID-namespace token (boot ID plus
  namespace inode) with an exact match; a host-boot or namespace mismatch or an unreadable identity
  is retained as owner-status-uncertain, while malformed v2 and unknown versions are invalid. Only
  within a verified v2 namespace may the marker's PID/start token prove that the creating process is
  dead or the PID has been reused. Non-Linux platforms retain their platform-specific owner-process
  proof without claiming Linux PID-namespace validation.
- `SIGKILL`, power loss, and kernel termination cannot run handlers, so immediate cleanup is not
  guaranteed. The `0700`/`0600` boundary contains residue until conservative next-run recovery.
- A possible residue produces `TEMPORARY_ARTIFACT_CLEANUP_FAILED` with paths only.
- Newly created final archives are `0600` unless explicit shared permission was requested; default
  overwrite preserves the existing mode, explicit POSIX sharing uses `0666 & ~currentUmask`, and no
  path changes a parent directory or the process umask.
- Rename/link to `outputPath` transitions `staged -> published` and is the commit point. Every
  `BACKUP_PUBLISHED_PERMISSION_FAILED` therefore reports `published: true`; the operation does not
  delete or roll back the archive inode that crossed that point.
- Permission work opens the final path without following links, requires a regular file whose
  lossless bigint device/inode identity equals the private staging identity, operates only through
  that bound descriptor, and rechecks descriptor plus final path. A replacement/nonregular target
  fails without chmodding the replacement.
- If the published inode already has `requestedMode`, the operation succeeds without `chmod`.
  Otherwise a failed mode read/identity check/adjustment transitions to
  `published-permission-failed`, removes unpublished staging residue, and raises details with
  `published: true`, `pathIdentityVerified`, and the last safely observed archive-inode mode or
  `null`. Only a true identity flag proves `outputPath` still names the staged archive and permits
  inspect/correct advice; a false flag makes the path untrusted and `actualMode` never describes its
  possible replacement. CLI exits nonzero and never recommends a blind force overwrite.
- After non-force hard-link publication, sibling cleanup operates only while a no-follow identity
  check proves that the private name still refers to the published archive device/inode. A changed
  pathname occupant is never deleted. Exhausted or unverifiable cleanup transitions to
  `published-cleanup-failed` and throws `BACKUP_PUBLISHED_CLEANUP_FAILED` with
  `pathIdentityVerified`, verified `residuePaths`, and `unverifiedResiduePaths`. The error never
  advises blind deletion, chmod, or force retry.
- A restore entry enters the staged publication collection only after its streamed bytes match both
  the manifest size and checksum. Invalid entries remain diagnostics only and never receive a
  destination path.
- Manifest file type and normalized path must agree with the finite backup layout. Every
  non-directory ZIP entry other than the manifest must appear exactly once in the manifest; an
  empty/no-intact archive or unmanifested file entry is rejected before destination mutation. All
  destinations, duplicate aliases, existing collisions, and ancestor confinement are preflighted
  before the first write; symlinks or other path indirection that could escape the Cursor user root
  fail closed.
- The explicitly selected user root is canonicalized, descendants are inspected without following
  links, and that chain is checked again before each publication. Every admitted payload is first
  copied into a private same-directory inode. Force commits by atomic rename, replacing only the
  directory entry and leaving other hard links to the old inode unchanged; non-force commits by an
  atomic no-clobber link. Static leaf links are rejected. This is observed-path confinement, not a
  claim of atomic protection against a hostile concurrent ancestor swap in an owner-controlled tree
  on Node 20, which lacks a portable directory-relative no-follow creation primitive.
- Non-force restore publication cleans its private sibling only while the sibling's no-follow
  device/inode identity matches the committed inode. A concurrently replaced sibling is untouched;
  an unverifiable name is reported as unverified temporary residue rather than guessed removable.
- A mixed-validity restore may publish intact entries with warnings. Skipped corrupt destinations
  are not opened, copied, truncated, backed up, or included in rollback, even when force is enabled.
- Failure recovery tracks only validated entries actually published during the current operation.
  Once any entry is published, portable Node implementations perform no automatic destination
  rollback because identity observation cannot be atomically coupled to replace or unlink. Every
  current leaf remains untouched and every published manifest-relative path becomes a residual.
  `RESTORE_ROLLBACK_INCOMPLETE` carries the published count, canonical residual set, and separate
  top-level verified/unverified owner-private cleanup residue sets from both publication and outer
  workspace disposal; it never returns a false `filesRestored: 0` result or lets cleanup mask the
  destination recovery requirement.

## 18. BackupManifest and source parsing policy

```ts
interface BackupManifest {
  version: '1.0.0'; // additive optional members do not change the v1 envelope
  producer?: string; // exact package version for new archives; absent/legacy values remain readable
  composerWorkspaceInventory?: {
    schemaVersion: 1; // independently versioned and validated optional member
    workspaces: BackupComposerWorkspaceInventoryEntry[];
  };
  // existing manifest members remain
}

interface SourceReadLimitsV1 {
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

const SOURCE_READ_LIMITS_V1_DEFAULTS: SourceReadLimitsV1 = {
  policyVersion: 'source-read-limits/v1',
  jsonlRecordBytes: 67_108_864,
  jsonlSourceBytes: 4_294_967_296,
  jsonlRecordCount: 2_000_000,
  sqlitePageRows: 256,
  sqlitePageBytes: 268_435_456,
  sqliteValueBytes: 134_217_728,
  sqliteRowCount: 5_000_000,
  sqliteDecodedBytes: 8_589_934_592,
  zipCompressedBytes: 17_179_869_184,
  zipEntryCount: 65_536,
  zipEntryBytes: 8_589_934_592,
  zipAggregateBytes: 17_179_869_184,
  zipCompressionRatio: 200,
};

interface SourceParsingPolicy {
  acceptedTextEncoding: 'utf8-with-optional-leading-bom';
  ignoreUnknownFields: true;
  limits: Readonly<SourceReadLimitsV1>;
}

interface SourceLimitFailureBase {
  code: 'SOURCE_LIMIT_EXCEEDED';
  policyVersion: 'source-read-limits/v1';
  limit: number;
  observedAtLeast: number;
  retryableWithOverride: true;
  remedy: string;
}

type SourceLimitFailure =
  | (SourceLimitFailureBase &
      (JsonlSourceLimitDimension | SqliteSourceLimitDimension) & {
        outcome: 'partial' | 'fatal';
      })
  | (SourceLimitFailureBase &
      ZipSourceLimitDimension & {
        outcome: 'fatal';
      });

type SourceParsingDiagnostic =
  | {
      code: 'SOURCE_ENCODING_INVALID';
      sourceKind: 'jsonl' | 'sqlite';
      outcome: 'partial' | 'fatal';
      remedy: string;
    }
  | SourceLimitFailure
  | {
      code: 'SOURCE_LIMIT_CONFIGURATION_INVALID';
      outcome: 'fatal';
      invalidField: string;
      invalidValue?: string | number;
      receivedType: string;
      violatedConstraint: string;
      remedy: string;
    };
```

Rules:

- Every newly created manifest uses the version of the running package artifact as `producer`.
- The optional Composer workspace inventory retains the enclosing `manifest.version` at `1.0.0`
  and independently carries `schemaVersion: 1`; an older v1 reader may ignore the additive member.
  Missing or historical values remain readable. `producer` is diagnostic provenance only and is
  excluded from logical/message identity, replica equivalence, deduplication, and incremental-sync
  comparisons.
- Text accepts deterministic UTF-8 with one optional leading BOM. Unknown fields/columns are
  ignored. Invalid or mixed encoding is never guessed, transcoded, or replacement-decoded; it yields
  a typed partial outcome only when a safe fallback remains, otherwise one typed fatal outcome.
- JSONL is incremental and bounded per record/source/count; SQLite uses keyset/row-ID metadata pages,
  preflights value lengths, fetches payloads sequentially, and is bounded per page/value/row/decoded
  aggregate; ZIP bounds the compressed container, preflights central-directory
  entry/count/aggregate/ratio metadata, and rechecks streamed output during private materialization.
  A limit is never reported as successful truncation.
- `SourceReadLimitsV1` defaults are inclusive. Raw-byte counters accept equality and fail the first
  unit above. JSONL resets per transcript, SQLite aggregate counters reset per logical-session
  hydration and separately per metadata catalog scan, and ZIP counters reset per archive.
- A caller may provide a validated partial per-operation override copied into the immutable operation
  context. There is no global/environment/input/manifest override, no `unlimited` value, and no
  automatic retry at a higher limit. Limits and overrides are excluded from every identity,
  equivalence, deduplication, and incremental-sync comparison.
- Policy constants are centralized and documented; repeated input bytes produce the same outcome.

## 19. DatabaseCapabilityProfile

```ts
type DatabaseCapability = 'read' | 'readWrite' | 'onlineBackup';

interface DatabaseCapabilityProfile {
  driver: 'node:sqlite' | 'better-sqlite3';
  available: boolean;
  capabilities: ReadonlySet<DatabaseCapability>;
  unavailableReason?: string;
}
```

Logical session maps use a private ASCII case-folded UUID key. `Session.id` and every physical
locator retain an exact spelling observed in source data. Composer spelling wins for a
Composer-backed row; otherwise selection is deterministic among the preferred source tier.
Equivalent case variants reconcile, while divergent variants enter the ordinary ambiguous state.
The caller's letter case is never used as a physical-occurrence selector.

Selection rules:

- Read-only discovery requests `read`; migration requests `readWrite`; snapshots request `read` and
  `onlineBackup`.
- Auto selection chooses the preferred capable driver, then a capable fallback.
- Forced selection never falls back and reports its missing set plus remedies.
- Capability/infrastructure failure cannot be mapped to a valid zero-message or partial content
  result.

## Aggregate invariants

1. One native UUID produces at most one logical row per listing scope.
2. Every resolved public message has a stable nonempty ID, deterministic timestamp, and provenance.
3. Preferred source can change rendered values/order but never pair selection, matched Composer ID,
   canonical workspace path, or existing Composer tool positions.
4. A complete view is replacement-safe; a partial view is never allowed to overwrite complete data.
5. No scoped payload opens before workspace binding, and no unrelated UUID payload opens under the
   cross-workspace opt-in.
6. An ambiguous logical row has no normal resolved payload and no mutation target.
7. Numeric addresses are meaningful only inside the data source, scope, base, and context that
   produced them.
8. Sensitive temporary plaintext is private throughout its lifecycle and residue is never silently
   reported as cleaned.
9. Context-owned decoded memory never exceeds `C+A`.
10. Locked v0.16 identities and replacement signals remain byte-for-byte stable; locked complete
    v0.17 input converges once and becomes idempotent.
11. Replica equivalence includes directly stored timestamp values but excludes timestamp provenance
    annotations and every inferred display timestamp value.
12. Unknown supported fields do not change a result; invalid/mixed encoding and every exceeded
    source bound produce deterministic typed outcomes without silent truncation or guessed text.
13. Backup producer metadata reports the creating artifact but never participates in identity or
    incremental equality.
14. Public search coordinates address complete original returned data in UTF-16 units; display
    snippets never define them.
15. Publication is irreversible at rename/link: a later permission failure remains an explicit
    typed partial failure with the valid archive preserved.
16. Legacy equal-time Composer order is derived from the v0.16 `localeCompare()` discovery ordinal;
    new set-like code-point ordering never rewrites that ordinal.
17. UUID casing may collapse logical identity but never exact physical mutation keys; noncanonical
    and compact 32-hex identifiers remain byte-sensitive.
18. A migration batch performs zero writes until every target is bound, hydrated within scope,
    eligible, and revalidated.
19. A merged active branch includes every selected leading/middle/trailing Store-only turn once,
    excludes Store sidechains, and exposes one resolved parent/leaf chain through both branch fields.
