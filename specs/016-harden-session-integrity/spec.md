# Feature Specification: Session Integrity and Compatibility Hardening

**Feature Branch**: `016-harden-session-integrity`
**Created**: 2026-08-05
**Status**: Draft
**Input**: User description: "Harden cursor-history session integrity and backward compatibility after v0.17.0: preserve v0.16 Composer identities for incremental library consumers, keep native logical session IDs separate from physical locators, make complete merged and Store representation changes replace-safe without consumer changes, enforce workspace-scoped reads and migrations, reconcile duplicate physical instances, protect backup snapshots and archives, probe SQLite driver capabilities, bound read-context memory, document scoped indices and workspace matching, preserve timestamp provenance, and block publishing when tests fail."

## Clarifications

### Session 2026-08-05

- One native Cursor session UUID represents one logical session. The public session ID remains that UUID; workspace, source, index, and physical-location information are separate metadata.
- Existing archives in the compatibility scenario were populated from cursor-history v0.16.0 Composer data. Their session, message, and existing tool-call identifiers must survive the upgrade; parent, branch, and leaf relationships remain valid but may change when the complete resolved conversation changes.
- Composer identity is frozen before cross-source merging. Native message IDs remain unchanged; a Composer message without a native ID retains the identity derived from its position in the v0.16 Composer-only projection. New Store-only messages use a separate, versioned identity namespace.
- The legacy public source value is a completeness and replacement-safety signal. Actual provenance is reported separately. This allows existing incremental consumers to replace changed complete sessions without requiring consumer changes.
- Store transcripts and per-session Store databases are parallel physical representations, not a guaranteed migration chain. A change between complete representations is a whole-session replacement boundary; a degraded reverse transition must not overwrite complete data.
- Store metadata that indicates a possible conversation but has no usable database or transcript remains a degraded metadata-only logical row with additive `store-metadata` provenance; metadata that explicitly declares no conversation is omitted rather than fabricated as an empty session.
- A workspace filter is both a logical-membership filter and a message-content read boundary. Lightweight global metadata discovery is allowed, but unrelated workspace content is not.
- Same-UUID physical data is classified by source role before duplicate reconciliation. Composer and the resolved Store representation are complementary contributors. Multiple candidates competing for the same source role are replicas: equivalent replicas are reconciled, while divergent replicas are ambiguous.
- Workspace matching uses normalized exact matching first, then an unambiguous unique-suffix fallback.
- Store-only sessions and any session with more than one contributing source, including merged sessions, are not eligible for migration in this feature. A workspace, numeric index, native ID, or physical occurrence selector does not authorize partial migration; Store or atomic all-source migration requires a separate future contract.
- Timestamps are display and ordering metadata, not the correctness boundary for complete merged-session synchronization. Inferred values remain compatible with the current public shape but carry explicit provenance.
- Supported Node versions remain unchanged; database-driver selection is based on required capabilities, with an automatic fallback when available.
- JSON keeps its existing list shape and gains additive index-scope metadata. Physical locators are not exposed by default.
- Plaintext temporary snapshots and newly created backup archives are private to the current user by default on platforms that support file permissions.
- Cooperative cancellation and catchable process signals clean private temporary data before termination. Because `SIGKILL`, power loss, and kernel termination cannot run application cleanup, any resulting artifact remains owner-private and is conservatively recovered by a later operation only after ownership and process death are proven.
- This corrective release preserves each command's released JSON fatal-error stream and exit-category behavior. Normalizing all fatal JSON errors to stderr is a separate compatibility change and is not bundled into the session-integrity repair.
- Stable returned values used for persistence, comparison, addressing, deduplication, or incremental synchronization are a project-level compatibility contract. The project constitution is amended to require native-ID fidelity, deterministic versioned synthetic IDs, explicit completeness and provenance, and prior-version upgrade validation.
- The v0.16 Composer-only archive path receives byte-for-byte identity preservation. Because v0.17 already exposed transitional merged-source and Store behavior, its corrective transition is separately versioned and documented: no promise is made for unstable v0.17 Store positional or cross-format synthetic IDs, but affected complete sessions must converge through one full replacement without duplicate logical content and remain idempotent afterward.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Existing library backups upgrade without identity drift (Priority: P1)

A developer has an incremental archive populated from cursor-history v0.16 Composer sessions. After upgrading cursor-history, the same logical sessions may include Store-only turns and Store enrichment, but every previously persisted Composer session ID, message ID, and existing tool-call ID remains recognizable. Parent, branch, and leaf relationships continue to use stable message IDs, but may change when the complete resolved conversation changes. The unchanged consumer replaces the complete session when its resolved conversation changes, and a repeated synchronization is idempotent.

**Why this priority**: Identity drift can duplicate old messages, omit newly discovered turns, retain stale enrichment, and permanently damage a large incremental archive. It is the primary release-blocking compatibility risk.

**Independent Test**: Populate a consumer archive from a v0.16-compatible Composer fixture, resolve the same session as a merged session, synchronize it with the unchanged legacy replacement policy, and verify that all old identities remain stable, all new content is present once, and a third synchronization writes nothing.

**Acceptance Scenarios**:

1. **Given** a v0.16 Composer session containing both native-ID messages and a message without a native ID, **When** the same session is resolved after a Store-only message is inserted in the middle, **Then** every old downstream message identity remains unchanged and the new Store message receives a distinct stable identity.
2. **Given** a message matched across Composer and Store, **When** either source supplies the preferred conversation order, **Then** the matched message retains its Composer identity and existing Composer tool-call order.
3. **Given** an already archived complete Composer session, **When** the resolved merged conversation changes by insertion, deletion, reordering, enrichment, parent change, or tool-call change, **Then** the unchanged consumer recognizes a complete changed session and atomically replaces its full persisted view, leaving either the old complete view or the new complete view if synchronization fails.
4. **Given** an already archived complete session, **When** the current read is degraded or partial, **Then** the degraded view does not overwrite the complete archive.
5. **Given** a completed replacement, **When** the same resolved session is synchronized again, **Then** no session, message, parent, code-block, or tool-call record is added or changed.

---

### User Story 2 - Workspace-scoped reads return and inspect only the intended data (Priority: P1)

A CLI or library user selects workspace A and receives session summaries, full sessions, search matches, and exports that belong to A. A displayed scoped index resolves to the same logical session throughout the operation. Sessions and message content belonging only to workspace B are neither mislabeled nor inspected.

**Why this priority**: Returning or inspecting another workspace's conversation is a correctness and privacy failure. Silent merged-session degradation also makes a valid result appear complete while omitting one source.

**Independent Test**: Create workspaces A and B with conflicting global and scoped ordering, distinct search needles, a shared logical session, and an off-scope source instance; exercise list, show, search, export, workspace discovery, and the public library while recording which message sources are opened.

**Acceptance Scenarios**:

1. **Given** global index 1 belongs to B and scoped index 1 belongs to A, **When** the user lists A and then shows or exports index 1 under the same scope, **Then** both operations return the resolvable session displayed for A; if the row is ambiguous, both operations return the same ambiguity group rather than selecting an occurrence.
2. **Given** only A contains `needle-a` and only B contains `needle-b`, **When** the user searches A, **Then** `needle-a` is found with A's correct session identity and path metadata, while B's message content is not searched.
3. **Given** a logical session has a source that cannot be read within A's default content boundary, **When** A is selected, **Then** the result is explicitly marked partial with omitted-source information rather than silently presented as a complete Store-only or Composer-only session.
4. **Given** live data, an archive, or a custom data path, **When** the same workspace-scoped operations are performed, **Then** they follow the same identity, filtering, and path rules.
5. **Given** a workspace remains addressable by the workspace filter, **When** workspaces are listed, **Then** that workspace appears with a count consistent with scoped listing.

---

### User Story 3 - Destructive migration resolves one explicit scoped target (Priority: P1)

A user previews and performs a session migration using a workspace-scoped numeric index. The preview and mutation refer to the same physical source instance, and the tool refuses to guess when the logical UUID is backed by multiple divergent or multi-source instances.

**Why this priority**: Selecting the wrong session for a destructive command can move or remove data from another workspace. A dry run that previews a different target does not provide meaningful protection.

**Independent Test**: Arrange conflicting global and workspace-local order for an eligible unambiguous Composer session, invoke migration by scoped index in preview and execution modes, and verify the exact source session and workspace before and after the operation; separately verify that divergent, Store-only, and merged targets are rejected.

**Acceptance Scenarios**:

1. **Given** workspace A's displayed index 1 is an eligible unambiguous Composer session and differs from global index 1, **When** the user previews and performs migration of index 1 under A, **Then** both phases bind and use A's displayed physical target.
2. **Given** a logical UUID has divergent same-role replicas, **When** migration is requested through any numeric, native-ID, or occurrence-reference selector, **Then** the operation fails before any write and reports the ambiguity; diagnostic occurrence references do not authorize mutation.
3. **Given** a Store-only or merged session, **When** migration is requested through any selector, **Then** preview and execution both report that the source type is unsupported and perform zero writes; selecting one physical occurrence does not enable a half-session migration.
4. **Given** a move or copy operation on an unambiguous Composer session, **When** it completes, **Then** a move retains the logical UUID and a true copy receives a new UUID.

---

### User Story 4 - Backup and database reads are private and reliable (Priority: P1)

A user reads live or archived Cursor history on any supported runtime without exposing plaintext chat databases to other local users. Temporary snapshots are always cleaned, database capabilities are validated before use, and an unsupported forced configuration fails clearly instead of silently returning an empty or degraded conversation.

**Why this priority**: Chat histories can contain credentials, source code, and private conversation. World-readable temporary files and silent database-driver degradation are high-severity security and data-integrity failures.

**Independent Test**: Exercise successful, malformed, interrupted, concurrent, and unsupported-capability backup reads; inspect resulting permissions, cleanup, user-visible outcomes, and whether any session is silently emptied.

**Acceptance Scenarios**:

1. **Given** a backup containing chat databases, **When** it is read successfully or parsing fails at any point, **Then** no plaintext temporary snapshot remains and no other local user can read it while it exists.
2. **Given** concurrent backup or Store-database reads, **When** temporary snapshots are created, **Then** each operation uses an isolated private location and cannot collide with another operation.
3. **Given** an automatically selected database provider lacks a capability required by the requested operation, **When** another capable provider is available, **Then** the operation succeeds through the capable provider.
4. **Given** the user explicitly forces an incapable provider, **When** the operation begins, **Then** it fails with an actionable capability error and does not return a zero-message partial session.
5. **Given** a newly created final backup archive on a permission-aware platform, **When** creation completes, **Then** it is readable only by its owner unless the user explicitly requests shared permissions.
6. **Given** backup creation, backup extraction, or a Store snapshot read, **When** temporary staging is required, **Then** every staging directory and plaintext database file is private, exclusively created, collision-resistant, and cleaned under the same failure rules.

---

### User Story 5 - Duplicate physical occurrences have deterministic, honest addressing (Priority: P2)

A user sees one logical conversation when equivalent physical replicas competing for the same source role share a native UUID. When same-role replicas have diverged, the user sees a clear ambiguity and can inspect diagnostic occurrence references without the application inventing a new public session ID or silently combining unrelated branches. Complementary Composer and Store contributors continue to follow the merge contract and are not duplicate conflicts merely because their payloads differ.

**Why this priority**: Duplicate rows, search matches, and exports inflate results and make direct-ID and destructive operations unpredictable. Blind merging can be worse than duplication when copies have diverged.

**Independent Test**: Provide equivalent and divergent same-UUID replicas competing for the same source role, plus a same-UUID Composer/Store pair with intentionally complementary content; verify that replicas follow duplicate policy while the Composer/Store pair follows the cross-source merge policy in listing, lookup, search, export, and migration.

**Acceptance Scenarios**:

1. **Given** two same-role physical replicas with one UUID and equivalent resolved payloads, **When** sessions are listed, searched, or exported, **Then** they appear once as one logical session with both source occurrences recorded.
2. **Given** two same-role replicas with one UUID and divergent resolved payloads, **When** the logical list is produced, **Then** it emits one row marked ambiguous with occurrence count and source roles but no raw physical locator by default.
3. **Given** an ambiguous logical row, **When** its numeric index or native ID is used for content resolution, **Then** the system returns the same typed ambiguity with opaque diagnostic occurrence references and does not select an occurrence.
4. **Given** an ambiguous logical row, **When** default search or bulk export runs, **Then** its conversation payload is not searched or exported and exactly one machine-readable diagnostic is emitted for the skipped group.
5. **Given** a Composer-backed session enriched by Store data whose working directory differs, **When** the session is read through either membership, **Then** the existing public workspace path remains the Composer canonical path, the matched path reflects the active filter, and each source path remains independently attributable.
6. **Given** the same logical session under different filters, **When** it is resolved completely, **Then** its native ID and canonical path remain stable while the matched workspace metadata reflects the active scope.

---

### User Story 6 - Large-corpus operations remain bounded and order-independent (Priority: P2)

A user can search or export a large history without retaining the entire decoded corpus in memory. Library operations behave correctly regardless of whether a scoped listing was called before a session read, and failures are isolated to the affected session.

**Why this priority**: Eager corpus caching turns normal bulk operations into an avoidable memory risk and makes correctness depend on an undocumented call order.

**Independent Test**: Search and export two progressively larger corpora with the same maximum session size, measure peak retained history, reverse the normal list/read call order, and inject one resolution failure.

**Acceptance Scenarios**:

1. **Given** a large history, **When** the user searches or exports all sessions, **Then** completed sessions are released or bounded rather than retained for the entire operation.
2. **Given** a read context with an explicitly bound data source and workspace scope, **When** session retrieval occurs before listing or after listing, **Then** both legal operation orders return the same result; a conflicting scope fails before any message content is read.
3. **Given** one session fails to resolve, **When** the operation continues where supported, **Then** failed state is not cached as a successful result and unrelated sessions remain readable.

---

### User Story 7 - Addressing, provenance, and release safety are visible on shipped surfaces (Priority: P2)

A CLI user, library developer, and package maintainer can tell whether an index is global or workspace-scoped, how a workspace name was matched, which timestamps are inferred, and whether a release passed its tests. Compatibility warnings and upgrade behavior are available in the installed package rather than only in development specifications.

**Why this priority**: Correct internal behavior is insufficient when users cannot understand the address they are reusing or the fidelity of returned data. A release workflow that ignores failing tests can ship known regressions despite complete local coverage.

**Independent Test**: Inspect CLI help, human-readable output, JSON, library documentation, localized documentation, the changelog, packaged files, and a deliberately failing release test run.

**Acceptance Scenarios**:

1. **Given** a workspace path, **When** matching is attempted, **Then** normalized exact matching wins; if no exact match exists, exactly one normalized component-suffix candidate resolves, while multiple suffix candidates return an ambiguity.
2. **Given** JSON session summaries from scoped and unscoped listings, **When** a machine consumer inspects them, **Then** it can distinguish the index scope and use the native session ID without receiving a physical locator by default.
3. **Given** a message with an inferred timestamp, **When** it is displayed or exported, **Then** the provenance is explicit and the value is not presented as a directly stored precise time.
4. **Given** any required release test fails, **When** the publication workflow runs, **Then** package publication is blocked.
5. **Given** a user upgrades from v0.16 or evaluates v0.17 compatibility, **When** they read shipped documentation and release notes, **Then** they can find the scoped-index contract, source/provenance contract, incremental-consumer warning, and supported upgrade path.
6. **Given** a proposed change to a returned value used for persistence, comparison, addressing, deduplication, or incremental synchronization, **When** it is reviewed for release, **Then** the constitutional compatibility check and applicable prior-version regression suite are required before approval.

### Edge Cases

- A native Composer message ID exactly equals a candidate compatibility or Store synthetic ID. Native and previously persisted compatibility identities take precedence; the new Store identity receives the deterministic collision form and no older identity is rewritten.
- Several identical Store messages produce the same canonical content signature. A deterministic occurrence value distinguishes them without depending on the final merged array position.
- A Store-only turn is inserted at the start or middle of a conversation, has a real timestamp older than the stored maximum, or has no directly stored timestamp. A complete-session update still includes it.
- A session changes from a parsed transcript to a complete Store database, from complete Store data to a failed transcript fallback, or between preferred Composer and Store ordering.
- A representation changes but the complete normalized conversation does not. The result remains idempotent even if provenance metadata changes.
- A workspace filter matches one membership of a multi-workspace session while another source belongs only to a different workspace.
- The same native UUID appears in a folder workspace, a workspace-file entry, a backup, and Store metadata, with either identical or divergent content.
- A requested suffix matches two workspaces, including paths that no longer exist on the current machine.
- A direct session ID identifies one logical session with multiple physical instances, while a numeric index identifies the scoped logical row displayed to the user.
- A scoped direct-ID read names a session outside the selected workspace. The unfiltered ID contract remains unchanged, but the scoped operation returns a scope mismatch without hydrating off-scope content.
- A migration target becomes unavailable after preview but before mutation. The operation must not silently re-resolve to a different instance.
- A backup is malformed after a plaintext database has been materialized, a database close fails, two reads start in the same clock tick, or backup creation encounters a pre-existing predictable staging path.
- A database module can be loaded but lacks the backup capability required for a consistent snapshot.
- All available database providers lack a required capability, or the user explicitly forces an incapable provider.
- A message timestamp is inferred from a previous message, a later message, or the session time; existing v0.16 data may contain a different historical fallback value.
- A legacy serialized message supplies a timestamp without enough source information to determine whether it was stored or inferred; its provenance remains unknown rather than being relabeled as direct.
- A large operation resolves one exceptionally large session among many small sessions and one session rejects during resolution.
- A test command exits nonzero even though earlier validation stages passed. Publication remains blocked.

## Requirements *(mandatory)*

### Functional Requirements

**Logical and Message Identity**

- **FR-001**: The system MUST expose the native Cursor UUID as the sole public logical session ID.
- **FR-002**: The system MUST represent physical source occurrences, workspace memberships, and physical locators separately from the public logical session ID.
- **FR-003**: Numeric indices MUST be documented and treated as ephemeral addresses scoped to the listing context that produced them.
- **FR-004**: Before cross-source merging, the system MUST establish Composer message identities using behavior compatible with the final Composer-only sequence produced by v0.16.
- **FR-005**: A Composer message with a native ID MUST retain that ID without modification.
- **FR-006**: A Composer message without a native ID MUST receive the compatibility identity `msg:<v0.16-composer-index>`, where the index is the zero-based array position used by v0.16 vibe-history (`msg:${zeroBasedComposerIndex}`), derived before merging from the v0.16 Composer-only projection so existing downstream keys remain unchanged.
- **FR-007**: A message matched between Composer and Store MUST inherit the Composer identity regardless of preferred source or final message position.
- **FR-008**: A Store-only database message MUST normally use `store:v1:db:<leaf-hash>:<occurrence>`, and a Store-only transcript message MUST normally use `store:v1:transcript:<canonical-hash>:<occurrence>`. If that candidate exactly collides with a frozen native/compatibility identity or an earlier Store assignment, the Store message MUST use `<candidate>:collision:<n>`, where `n` is the smallest positive integer not already assigned while candidates are processed in deterministic source-native order. Native and compatibility identities MUST never be rewritten to resolve a collision.
- **FR-009**: `occurrence` MUST be the deterministic one-based ordinal among equal fingerprints in that representation's source-native order, assigned before cross-source merging. Transcript canonical input MUST include its source-native role, content, structured tool activity, and source-native relationships while excluding physical path, discovery order, merged-array position, and inferred display metadata.
- **FR-010**: Existing Composer tool-call ordering and identity MUST remain stable; Store enrichment MAY match or append calls but MUST NOT reorder existing calls. Every resolved runtime and structured-output tool call MUST carry a nonempty native or deterministic versioned identity plus identity origin, scoped by its stable message identity when synthetic. Public declaration fields MAY remain optional only for source compatibility.
- **FR-011**: Parent, branch, and leaf references MUST use resolved stable message identities. Existing identity tokens MUST remain unchanged, while relationships MUST be recomputed when insertion, deletion, branching, or reordering changes the resolved conversation.
- **FR-012**: `messageIdentityVersion` and identity origin MUST be available to programmatic consumers as additive metadata.
- **FR-013**: Merging MUST preserve semantically correct relative conversation order; identity preservation MUST NOT require concatenating all Composer messages before all Store messages.
- **FR-014**: Moving a logical session MUST retain its native UUID, while creating a true independent copy MUST assign a new UUID.

**Incremental Consumer Compatibility and Source Fidelity**

- **FR-015**: The legacy public source value MUST remain `global` for a complete, replacement-safe resolved session and `workspace-fallback` for a degraded session that is unsafe to overwrite complete data.
- **FR-016**: Actual source provenance and contributing physical sources MUST be available through additive `resolvedSource` and `sources` metadata without requiring existing consumers to interpret provenance through the legacy `source` value.
- **FR-017**: A complete changed session MUST trigger the legacy full-session replacement behavior when consumed by an unchanged v0.16-compatible incremental consumer. Its completeness-sensitive comparison MUST cover the complete ordered message identities, roles, content, relationships, consumed tool-call data, code blocks derived from message content, supported attachment evidence represented in those consumed fields, and other persisted session/message data; a presentation-only or provenance-only change MUST NOT create duplicate logical content. Because the unchanged consumer has no standalone attachment field and derives code blocks from message content, attachment evidence is complete only when represented losslessly and deterministically in message `content` (including fenced code) or the tool-call name/status/params/result/error fields it consumes. A standalone attachment, code-block, or tool-file value that the unchanged adapter ignores is insufficient. Any other raw attachment block MUST make the source partial, and the system MUST NOT dereference an external URI or target merely to compute identity or equality.
- **FR-018**: A degraded current session MUST NOT overwrite a previously stored complete session under the default compatibility policy.
- **FR-019**: A complete-session replacement MUST atomically apply the full current message set, including insertions, deletions, reordering, enrichment, parents, code blocks, and tool calls. A failed replacement MUST leave the previously persisted complete view unchanged and MUST NOT leave mixed old/new child records.
- **FR-020**: Repeating synchronization against an unchanged resolved session MUST be idempotent.
- **FR-021**: A Store database that yields a usable conversation MUST be the Store-side conversation backbone; a transcript supplies the Store-side conversation only when the database is absent, unreadable, or yields no recoverable conversation. A fully parsed transcript-only session with no expected database MUST be complete, while a transcript used after an expected database fails MUST be degraded.
- **FR-022**: A complete Store representation change MUST be treated as a whole-session replacement boundary; the system MUST NOT claim that transcript and Store-database synthetic message IDs are necessarily identical.
- **FR-023**: A failed or partial Store representation MUST carry degraded fidelity and MUST NOT replace a previously complete view. When metadata indicates that a conversation may exist but neither database nor transcript yields usable content, the logical row MUST remain degraded with additive `store-metadata` provenance; an explicit no-conversation record MUST be omitted.

The legacy `source` compatibility value MUST follow this replacement-safety matrix:

| Resolved state | Fidelity | Legacy `source` | Existing complete archive may be replaced |
|---|---|---|---|
| Complete Composer conversation with no known failed or omitted contributor | Complete | `global` | Yes, when the complete view changed |
| Complete Store database conversation with no known failed or omitted contributor | Complete | `global` | Yes, when the complete view changed |
| Fully parsed transcript-only conversation when no Store database was discovered or expected | Complete | `global` | Yes, when the complete view changed |
| Complete Composer/Store merge in which every permitted known contributor was resolved completely | Complete | `global` | Yes, when the complete view changed |
| Composer workspace fallback, partial Store database, or otherwise partial source | Degraded | `workspace-fallback` | No |
| Transcript used because an expected Store database was absent, unreadable, failed, or yielded no recoverable conversation | Degraded | `workspace-fallback` | No |
| A known contributor omitted by workspace scope, read failure, or unavailable permission | Degraded | `workspace-fallback` | No |
| Divergent same-role replicas | Unresolved ambiguity | No resolved-session value | No |

A contributor is known or expected when discovery metadata identifies its physical occurrence or the selected source format declares it, without requiring its conversation payload to be read. A modern consumer may inspect a degraded new session, but the legacy compatibility signal remains non-overwriting.

**Timestamp Semantics**

- **FR-024**: Every public message MUST retain a timestamp in the existing backward-compatible shape. When no valid source timestamp exists, any required fallback MUST be deterministic and MUST NOT depend on read time or filesystem time. A session timestamp used as fallback MUST itself come from deterministic source data; public session times MUST expose additive `createdAtSource` and `lastUpdatedAtSource` provenance, and a fixed unknown epoch MUST NOT be treated as a source-derived session anchor.
- **FR-025**: Existing direct `timestampSource` values (`composer-created-at`, `composer-timing`, and `store-turn-timing`) MUST remain unchanged. Additive values MUST distinguish `inferred-previous`, `inferred-next`, `session-fallback`, and `unknown`; legacy values whose origin cannot be established MUST be `unknown`, never relabeled as directly stored. Identical source input MUST produce the same timestamp and provenance on every read.
- **FR-026**: Human-readable output MUST mark inferred timestamps as approximate rather than directly stored precise times.
- **FR-027**: Complete Cursor and merged-session update correctness MUST be based on stable identities and the complete ordered resolved view, not on whether a message timestamp exceeds a stored maximum.
- **FR-028**: A newly discovered middle message MUST be preserved even when its directly stored or inferred timestamp is older than other already archived messages.

**Workspace Scope, Addressing, and Paths**

- **FR-029**: Workspace matching MUST prefer a normalized exact path match. If no exact match exists and exactly one normalized component-suffix candidate exists, that candidate MUST resolve; zero candidates MUST return no match, and multiple candidates MUST report ambiguity before any conversation payload is read or any mutation begins. Suffixes MUST align on complete path components rather than arbitrary string endings.
- **FR-030**: A workspace filter MUST select logical sessions by verified workspace membership and MUST limit message-content reads to matching physical occurrences by default. Pathless or differently scoped contributors MUST be omitted and make the resolution partial unless cross-source loading was explicitly authorized.
- **FR-031**: The system MAY read lightweight global metadata needed to discover session membership, but titles, previews, transcript lines, database leaves, messages, tool calls, code blocks, and attachments count as conversation payload and MUST NOT be inspected from unrelated workspaces during any scoped CLI or library operation.
- **FR-032**: A numeric index used with a workspace filter MUST resolve against the same scoped logical listing that displayed it. Once a row is selected, every follow-up full-session load MUST use its stable logical ID and bound occurrence context rather than reinterpreting the numeric index against another listing.
- **FR-033**: Scoped list, show, search, export, bulk export, and public-library operations MUST associate returned content with the correct native ID and path metadata. An unfiltered direct native-ID lookup retains its existing meaning; a scoped direct-ID read MUST verify membership and MUST NOT hydrate an off-scope session.
- **FR-034**: When scope prevents a complete merge, the system MUST return an explicit partial resolution rather than silently presenting an incomplete view as complete. Structured output MUST distinguish resolution state, expected source roles, loaded source roles, omitted or failed roles, and stable reason codes; human-readable show/export output MUST warn about the omission.
- **FR-035**: Loading source content outside the default workspace boundary MUST require explicit caller or user opt-in, MUST be limited to contributors of logical sessions already selected in scope, and MUST disclose every broadened membership/path.
- **FR-036**: The existing public `workspace`/`workspacePath` value MUST represent a stable `canonicalWorkspacePath`; `matchedWorkspacePath`, `workspaceMemberships`, `sourceInstances`, and per-source paths are additive concepts. A Composer-backed session MUST retain its deterministic v0.16-compatible Composer attribution, a Store-only session MAY use a reliable Store working directory, and an unknown path MUST remain absent or explicitly unknown rather than be fabricated from lossy data.
- **FR-037**: Preferred source and active filter MUST NOT change the canonical path. `matchedWorkspacePath` MUST contain the full normalized membership selected by the active exact or unique-suffix match, and all per-source paths MUST remain associated with their source role and occurrence through a deterministically ordered collection rather than collapsing a multi-membership occurrence to one path.
- **FR-038**: Every filterable workspace MUST appear in workspace discovery, and its session count MUST equal the number of logical rows returned by listing that workspace. A multi-membership logical session MAY count once in each applicable workspace, so workspace-count totals need not equal the deduplicated global total.
- **FR-039**: Every structured item containing a reusable numeric index MUST include `indexScope` with value `global` or `workspace`. A workspace-scoped item MUST also carry the full resolved `indexWorkspacePath`; global items MUST omit it or represent absence consistently. The existing top-level list shape remains unchanged and physical locators remain omitted by default.
- **FR-040**: Scope, identity, path, search, and export behavior MUST be consistent across live data, backups, and custom data paths, including historical paths that do not exist on the current machine.

**Physical Occurrences and Ambiguity**

- **FR-041**: Same-UUID occurrences in complementary Composer and resolved-Store source roles MUST follow the cross-representation merge policy and MUST NOT be classified as divergent replicas solely because their payloads differ. Store database and transcript candidates MUST follow the Store-side primary/fallback rule rather than being blindly merged.
- **FR-042**: Multiple occurrences competing for the same source role MUST be compared using a versioned resolved-payload equivalence contract. Ordered stable identities, roles, directly stored timestamp values, content, relationships, tool activity, code blocks derived from message content, and supported attachment evidence already projected into message content or consumed tool-call fields participate; `timestampSource`, physical paths, locators, discovery order, other provenance-only metadata, ignored standalone attachment/code-block/tool-file fields, and derived display fallback values do not.
- **FR-043**: Equivalent same-role replicas MUST reconcile into one source contribution and one logical list/search/export result while retaining all occurrence provenance. Divergent same-role replicas MUST appear as one ambiguous logical row and MUST NOT be selected, unioned, or assigned another logical session ID.
- **FR-044**: Reusing an ambiguous row's index or native ID MUST return the same typed ambiguity. Default direct-ID, show, search, export, and bulk-export operations MUST NOT consume its unresolved conversation payload and MUST emit exactly one machine-readable diagnostic for each skipped ambiguity group.
- **FR-045**: Ambiguity diagnostics or an explicit diagnostic read MAY expose opaque occurrence references unique within the bound data source. These references MUST remain separate from the native public ID, are never migration authorization, and expose no raw physical locator by default.

**Migration Safety**

- **FR-046**: Session migration MUST consume the active workspace scope when resolving a numeric identifier.
- **FR-047**: Migration preview and execution MUST use the same bound logical identity and physical source target. Revalidation, source-read, destination-preflight, and capability checks MUST occur before the first write; a changed or invalid target MUST fail rather than re-resolve to another occurrence.
- **FR-048**: A destructive operation MUST refuse divergent same-role replicas before performing any write. Numeric indices, native IDs, and diagnostic occurrence references MUST NOT override that refusal in this feature.
- **FR-049**: Migration MUST reject Store-only and merged sessions before the first write, even when an individual physical occurrence is known or explicitly selected. Enabling Store or atomic all-source migration requires a separately specified contract and is outside this feature.
- **FR-050**: Existing unambiguous Composer direct-ID and unfiltered numeric migration behavior MUST remain compatible.

**Backup Privacy and Cleanup**

- **FR-051**: Plaintext chat-database snapshots and temporary staging used by backup creation, backup extraction, or Store reads MUST be accessible only to the current user on permission-aware platforms.
- **FR-052**: Each backup-creation, backup-extraction, or Store-snapshot operation MUST exclusively create a unique private temporary location, MUST never reuse a pre-existing filesystem entry, and MUST not collide with concurrent operations.
- **FR-053**: Temporary plaintext data MUST be removed after success, cooperative cancellation, every catchable interruption, and every failure path, including parse, open, close, and malformed-input failures. Cleanup MUST be safe to repeat and MUST attempt every known artifact even if one removal fails; any possible residue MUST be reported by path without disclosing content and MUST NOT be described as successful cleanup. After an uncatchable termination such as `SIGKILL`, power loss, or kernel termination, immediate removal cannot be guaranteed; the artifact MUST remain owner-private and a later operation MUST recover it conservatively only after validating the application marker, current ownership, and that the creating process is no longer alive.
- **FR-054**: Newly created final backup archives MUST be private to the current user by default on permission-aware platforms; broader access requires explicit opt-in.
- **FR-055**: Overwriting an existing archive MUST NOT broaden its permissions unintentionally, and the system MUST NOT alter parent-directory permissions.

**Database Capability and Failure Fidelity**

- **FR-056**: Automatic database-provider selection MUST verify every capability required by the requested operation rather than relying only on provider availability.
- **FR-057**: When an automatically preferred provider lacks a required capability and another capable provider is available, the operation MUST use the capable provider.
- **FR-058**: When the user explicitly forces an incapable provider, the system MUST return an actionable typed error identifying the missing capability and available remedy.
- **FR-059**: A capability or snapshot failure MUST NOT be silently converted into a successful zero-message or misleading partial session. If automatic selection finds no provider satisfying the complete capability set, resolution MUST fail once with an actionable error before session content is returned.
- **FR-060**: All advertised operations MUST work or fail explicitly across every supported runtime version; the supported runtime range remains compatible with Node 20 and later.

**Read Lifecycle and Resource Bounds**

- **FR-061**: Every read context MUST have a documented finite decoded-session retention capacity `C`. Excluding currently active resolutions `A` and caller-owned result payloads, it MUST retain no more than `C` completed decoded sessions and no more than `C + A` decoded sessions in total.
- **FR-062**: Built-in bulk search and export MUST use a finite-capacity or no-retention mode, release completed payloads as they become unnecessary, and release all context-owned decoded sessions when the operation is disposed.
- **FR-063**: A read context MUST bind an explicit immutable data source and workspace scope before content operations begin. Every supported operation order MUST produce the same result; a conflicting scope MUST fail before content is read.
- **FR-064**: Scope conflicts and invalid context usage MUST produce typed, actionable errors.
- **FR-065**: A rejected session resolution MUST not remain cached as a successful result or prevent unrelated sessions from being processed where continuation is supported.

**Documentation, Diagnostics, and Release Quality**

- **FR-066**: CLI help, the canonical README, public-library documentation, and the changelog MUST ship in the published package and explain logical IDs, physical instances, global and scoped indices, source completeness, actual provenance, workspace matching, and timestamp provenance. Localized documentation MUST remain synchronized or link to the canonical contract; development specs MUST NOT be the only documentation source.
- **FR-067**: The shipped changelog MUST cover every previously undocumented release from v0.12 through the current release. The v0.17 entry MUST warn incremental library consumers about message-position, merged-source, and timestamp-watermark risks and recommend pinning or validating before upgrade; the corrective release MUST explain the legacy `source` fidelity mapping, additive provenance fields, the v0.16 preservation guarantee, and the documented one-time v0.17 convergence path.
- **FR-068**: Empty workspace-filter results and ambiguous matches MUST provide actionable diagnostics rather than an unexplained absence of history.
- **FR-069**: Required tests, type validation, linting, build validation, and a clean-install smoke check of the packed CLI, public library, and type declarations MUST all succeed for the exact revision being published. Nonzero results, zero required tests collected, unexpected skips, timeouts, or cancellation MUST block publication and MUST never be converted into a successful release step.
- **FR-070**: Release validation MUST cover the minimum supported runtime, every runtime boundary at which required database capabilities differ, and the latest stable runtime available at release time.
- **FR-071**: The project constitution and review workflow MUST treat returned values used for persistence, comparison, addressing, deduplication, or incremental synchronization as stable public contracts, preserving native source identity and requiring an explicit transition for any changed value or meaning. Newly exposed set-like arrays MUST use a documented canonical order independent of physical discovery order, while semantic conversation arrays retain their documented source/resolved order.
- **FR-072**: Release evidence MUST exercise the distributed CLI and public library end to end and MUST demonstrate zero off-scope conversation-payload hydration events; wholesale mocks of the behavior under test are not sufficient evidence.
- **FR-073**: A release-blocking backward-compatibility regression suite MUST preserve locked v0.16 and v0.17 baselines. The v0.16 fixture MUST exercise Composer import, upgraded merged resolution, first atomic replacement, and repeated idempotent synchronization with no consumer modification, comparing every pre-existing public session ID, message ID, tool-call ID, and compatibility signal byte-for-byte.
- **FR-074**: Applicable validation fixtures MUST cover live data, backups, custom data paths, conflicting scoped/global order, complementary and duplicate sources, both preferred merge orders, Store representation changes, native and missing Composer IDs, middle insertions, timestamp provenance, backup cleanup/permissions, context operation order/retention, and database capability failures. Backup fixtures are limited to representations supported by the backup contract.
- **FR-075**: The verification suite MUST fail when faults are introduced that substitute an index for a stable ID, attach a wrong path or ID, hydrate off-scope content, prefer a Store identity over a matched Composer identity, leak a sensitive temporary artifact, exceed the decoded-session retention bound, or continue publication after required validation fails.
- **FR-076**: Structured tool activity attached to error or thinking messages MUST remain visible in applicable human-readable and structured output, and message-type filtering MUST classify a message by its actual category rather than misclassifying it solely because tool activity is present.
- **FR-077**: The compatibility regression suite MUST cover native-ID and missing-ID Composer messages, Store-only insertions at the start and middle, matched enrichment, parent and tool-call changes, both preferred merge backbones, synthetic Store collisions, degraded non-overwrite behavior, complete Store-representation transitions, and a deliberately injected identity-position regression that proves the suite fails when a v0.16 key drifts.
- **FR-078**: The locked v0.17 transition fixture MUST verify the documented change from transitional provenance/Store behavior to the corrective contract. It MUST NOT promise preservation of unstable v0.17 Store positional or cross-format synthetic IDs, but MUST produce one complete logical session through one full replacement, zero duplicate logical content, correct native Composer identities, and zero writes on the next unchanged synchronization.

### Key Entities

- **Logical Session**: One Cursor conversation identified by its native UUID. It may have several physical source instances and workspace memberships but only one public logical ID.
- **Physical Source Instance**: One concrete occurrence of a logical session in Composer storage, Store storage, a transcript, live data, or an archive. It has provenance, zero or more workspace associations, fidelity, and an internal locator.
- **Resolved Session View**: The ordered, user-visible conversation produced from the permitted source instances, including completeness status, contributing sources, messages, parents, and tool calls.
- **Stable Message Identity**: A versioned identity assigned before cross-source ordering. It is native Composer identity when available, a v0.16 compatibility identity for legacy Composer messages, or a Store-only synthetic identity.
- **Workspace Membership**: A verified association between a logical session and a workspace. A session can have several memberships; one may match the active filter.
- **Index Scope**: The context that gives a numeric index meaning, including whether it is global or workspace-scoped and the data source/filter under which it was produced.
- **Source Fidelity**: The backward-compatible indication that a resolved session is complete and replacement-safe or degraded and unsafe to overwrite complete data.
- **Source Provenance**: The actual physical representations that contributed to a result, independent of the compatibility fidelity signal.
- **Timestamp Provenance**: One existing source-specific direct value, an inferred-previous, inferred-next, session-fallback, or unknown classification explaining the public message time without rewriting established direct values.
- **Read Context**: Operation-scoped state that binds data source and workspace scope while sharing bounded discovery work.
- **Backup Snapshot**: A temporary plaintext database representation used to obtain a consistent read and requiring private access and guaranteed cleanup.
- **Database Capability Profile**: The set of operations a database provider can perform on the active runtime, used to determine whether it is suitable for a requested operation.
- **Source Role**: A contributor category used before duplicate reconciliation. Composer and the selected Store representation are complementary roles; multiple candidates within one role are replicas.
- **Replica Equivalence Version**: The documented version of the resolved-payload comparison used to reconcile or reject same-role physical replicas without letting locators or discovery order alter the result.
- **Diagnostic Occurrence Reference**: An opaque address for one physical occurrence within a bound data source. It supports ambiguity diagnostics but is never a logical session ID or migration authorization.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the v0.16 compatibility fixture, 100% of pre-existing session IDs, Composer message IDs, and existing tool-call IDs remain unchanged after Store merging. Every resulting parent, branch, and leaf reference resolves to a present stable message ID, and any changed relationship corresponds to a changed resolved conversation.
- **SC-002**: A v0.16 import followed by an upgraded complete-session synchronization produces zero duplicate old messages, zero missing new messages, current enrichment and parent relationships, and zero writes on the next unchanged synchronization.
- **SC-003**: Under the default non-opt-in workspace boundary, 100% of returned content belongs to the requested workspace and zero unrelated conversation-payload sources are hydrated across scoped list, show, search, export, bulk-export, and library scenarios.
- **SC-004**: Every scoped index round-trips to the displayed logical session or ambiguity group under the same scope, while unfiltered direct native-ID and unfiltered numeric-index behavior remains unchanged.
- **SC-005**: In all ambiguity tests, read operations report divergent same-role replicas and 100% of destructive operations stop before the first write unless an eligible unambiguous Composer target is explicitly bound; Store-only and merged targets always remain rejected.
- **SC-006**: Equivalent same-role replicas produce one logical list row, one logical search result set, and one logical bulk export; divergent same-role replicas are never silently selected or combined, while complementary Composer/Store contributors still merge.
- **SC-007**: On permission-aware platforms, 100% of temporary plaintext snapshots and newly created backup archives are owner-only by default; induced success, failure, concurrency, cooperative-cancellation, and catchable-signal tests leave zero temporary database files; and an induced uncatchable-termination artifact remains private and is removed by the next operation after stale-owner validation.
- **SC-008**: On every supported runtime in the validation matrix, each advertised database operation either succeeds through a capable provider or returns one actionable capability error; no capability failure produces a false successful empty session.
- **SC-009**: Across instrumented corpora of `N` and `2N` sessions, context-owned decoded sessions never exceed the documented `C + A` bound, built-in bulk operations do not retain completed session payloads beyond that bound, and context disposal leaves zero context-owned decoded sessions.
- **SC-010**: 100% of public/structured sessions and messages retain their required timestamp shape and carry additive timestamp provenance; repeated reads of identical source input produce byte-for-byte identical session/message timestamp-provenance pairs, and inferred or unknown values are never presented as directly stored precise times.
- **SC-011**: Users can determine from every shipped documentation surface whether a displayed index is scoped, how workspace matching works, which source fidelity was returned, and how to upgrade an incremental v0.16 archive safely.
- **SC-012**: Every simulated nonzero validation result, zero-test collection, unexpected skip, timeout, and cancellation prevents package publication; the packed artifact smoke check identifies the same validated revision that is published.
- **SC-013**: Every compatibility and integrity scenario passes for each applicable supported source combination across live layouts, supported backup layouts, and custom data paths, including Composer-preferred and Store-preferred platforms.
- **SC-014**: The amended project constitution requires compatibility analysis and prior-version validation for 100% of changes to returned values used for persistence, comparison, addressing, deduplication, or incremental synchronization.
- **SC-015**: In fixtures containing structured tool activity on error and thinking messages, 100% of applicable tool activity is rendered and each message remains selectable through its true message-type filter.
- **SC-016**: The standard required test command runs the v0.16 compatibility suite and detects 100% of the specified injected identity, completeness-signal, and idempotency regressions before publication.
- **SC-017**: The standard required test command runs the v0.17 transition suite; every documented affected complete-session fixture converges in one replacement with zero duplicate logical content and performs zero writes on the next unchanged synchronization.

## Assumptions

- Existing v0.16 compatibility archives contain Composer data only; they do not contain historical Store-only synthetic message identities that must be preserved.
- v0.17 outputs are an affected released contract and therefore receive a locked transition fixture and explicit migration/pinning guidance, but unstable v0.17 Store positional or cross-format synthetic IDs are not reclassified as durable historical identities.
- The confirmed unchanged compatibility consumer synthesizes a missing message ID from the final array position and replaces a complete session when the legacy source is replacement-safe and its complete persisted view changes.
- The native Cursor session UUID is the authoritative logical identity shared by Composer and Store representations of the same conversation.
- Store transcripts and per-session Store databases do not expose a confirmed shared native per-message identity. Correctness across those representations therefore relies on whole-session replacement rather than an unproven cross-format identity mapping.
- Complete-session replacement is an existing consumer capability; this feature supplies backward-compatible signals that select it and does not require consumer code changes for the confirmed v0.16 upgrade path.
- Backup archives and temporary snapshots contain sensitive user data and therefore use private defaults.
- The project continues to support Node 20 and later by selecting a provider with the capabilities required for each operation.
- Workspace filters default to content isolation. Users who explicitly request cross-workspace source inclusion accept the broader read scope.
- Exact workspace paths may refer to historical or cross-platform locations that are not present on the current machine, so matching cannot require filesystem existence.
- Path normalization applies the documented separator, dot-segment, trailing-separator, and platform case rules consistently to both exact and component-suffix matching.

## Out of Scope

- Changing, suffixing, or replacing Cursor's native public session UUID.
- Making numeric indices globally stable across scopes, data changes, or separate invocations.
- Requiring transcript and Store-database synthetic messages to keep one identical cross-format ID.
- Preserving unstable v0.17 Store positional or cross-format synthetic IDs; the supported v0.17 path is documented whole-session convergence.
- Modifying, migrating, deleting, or repairing Cursor Store files as part of read resolution.
- Automatically merging divergent same-UUID physical copies without explicit user direction.
- Migrating one member of a divergent same-role replica group; occurrence references are diagnostic-only in this feature.
- Defining or performing Store-only or merged-session migration; this feature rejects both until a separately specified atomic migration contract exists.
- Requiring changes to `vibe-history` or another compatible existing consumer for the confirmed v0.16 Composer-only upgrade path.
- Treating inferred timestamps or a maximum timestamp as proof that a merged-session message is new.
- Encrypting final backup archives or managing cloud backup destinations.
- Replacing the existing JSON list shape with a new top-level envelope in this compatibility release.
