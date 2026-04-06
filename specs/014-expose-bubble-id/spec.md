# Feature Specification: Expose Bubble ID on Message Type

**Feature Branch**: `014-expose-bubble-id`  
**Created**: 2026-04-06  
**Status**: Draft  
**Input**: User description: "expose bubbleId on Message type for stable message identification and branch reconstruction"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stable Message Identification via Library API (Priority: P1)

A developer integrating `cursor-history` as a library needs to uniquely identify messages across repeated reads of the same session. Currently the library `Message` type omits the bubble UUID that the core layer already resolves, forcing consumers to fall back to positional array indices as identifiers. With this feature, consumers receive a stable, content-addressable ID on every message returned by the library API.

**Why this priority**: This is the primary ask. Without stable IDs, downstream tools like `vibe-history` rely on implicit storage ordering guarantees. Exposing the existing bubble UUID removes that fragile assumption with zero new data extraction work.

**Independent Test**: Can be fully tested by calling `getSession()` through the library API and verifying that each returned message carries an `id` field matching the bubble UUID stored in the underlying database.

**Acceptance Scenarios**:

1. **Given** a session with messages in the database, **When** a consumer calls `getSession(identifier)` via the library API, **Then** each message in the returned session has an `id` field containing the bubble UUID string.
2. **Given** a session where some bubbles have a `bubbleId` field in their data and others only have the UUID in the row key, **When** the session is read, **Then** all messages still have their `id` populated (from whichever source is available).
3. **Given** a session read twice without any writes occurring between reads, **When** the consumer compares message IDs from both reads, **Then** the IDs are identical for corresponding messages.
4. **Given** a session accessed via the CLI JSON output, **When** the output is parsed, **Then** each message object includes the `id` field with the bubble UUID.

---

### User Story 2 - Active Branch Identification (Priority: P2)

A developer building a conversation history viewer needs to distinguish which messages belong to the current active conversation branch versus orphaned messages from rewound branches. Cursor stores a manifest of active-branch bubble IDs in session metadata. By exposing this data on the session object, consumers can cross-reference message IDs against the active branch manifest to determine which messages are current.

**Why this priority**: This enables branch-aware conversation rendering, which is a significant capability upgrade. However, it depends on P1 (message IDs must be exposed first for the cross-reference to work) and serves a narrower set of consumers.

**Independent Test**: Can be tested by reading a session that has been rewound in Cursor, verifying the session object contains an `activeBranchBubbleIds` array, and confirming that only a subset of returned message IDs appear in that array (the rest being orphaned).

**Acceptance Scenarios**:

1. **Given** a session with a linear conversation (no rewinds), **When** the session is read, **Then** the `activeBranchBubbleIds` array contains the IDs of all messages in order.
2. **Given** a session where the user rewound and continued from an earlier point, **When** the session is read, **Then** `activeBranchBubbleIds` lists only the current active branch's message IDs, while the full message array also contains orphaned messages from the rewound branch.
3. **Given** a session where the active branch manifest is absent or empty in session metadata (e.g., older Cursor versions), **When** the session is read, **Then** `activeBranchBubbleIds` is absent/undefined (not an empty array).
4. **Given** a session where `composerData` is invalid JSON, the manifest is not an array, or some manifest entries are malformed, **When** the session is read, **Then** the session still loads without throwing, malformed entries are ignored, and `activeBranchBubbleIds` is omitted if no valid bubble IDs remain.
5. **Given** a session read from workspace-fallback storage, **When** the session is read, **Then** `activeBranchBubbleIds` is absent/undefined even if workspace metadata contains branch information, because stable message IDs are not reliably available in degraded mode.

---

### Edge Cases

- What happens when a bubble has neither a `bubbleId` field in its data nor a parseable UUID in its row key? The `id` field should be absent/undefined, indicating no stable identifier is available.
- What happens when `activeBranchBubbleIds` contains bubble IDs that don't match any message in the session (e.g., data corruption)? The array is exposed as-is; filtering or validation is the consumer's responsibility.
- What happens when `fullConversationHeadersOnly` is present but empty? Treat it as unavailable and omit `activeBranchBubbleIds`.
- What happens when `composerData` or `fullConversationHeadersOnly` is malformed? Session reads must not fail; invalid manifest data should be ignored and `activeBranchBubbleIds` should be omitted if no valid IDs remain.
- What happens when a session is read from workspace-fallback storage (degraded mode) where global bubble data is unavailable? Messages constructed from workspace data may not have bubble UUIDs; their `id` should be absent/undefined, and `activeBranchBubbleIds` should also be absent/undefined so consumers are not given a partial branch-matching contract.
- What happens during session migration with copy mode? Copied sessions receive new bubble UUIDs; the `id` field reflects the new UUID, and `activeBranchBubbleIds` is updated to match the new IDs (existing migration behavior already handles this).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The library `Message` type MUST include an optional `id` field of type string that contains the bubble UUID when available.
- **FR-002**: The `id` field MUST be populated from the same source the core layer already uses: the `bubbleId` field in bubble data, falling back to the UUID extracted from the database row key.
- **FR-003**: When no bubble UUID is available (e.g., workspace-fallback sessions), the `id` field MUST be absent/undefined, not an empty string or placeholder.
- **FR-004**: The library `Session` type MUST include an optional `activeBranchBubbleIds` field containing an ordered array of bubble UUID strings representing the current active conversation branch.
- **FR-005**: The `activeBranchBubbleIds` field MUST be sourced from the active branch manifest stored in session metadata.
- **FR-006**: When the active branch manifest is absent or empty in session metadata, the `activeBranchBubbleIds` field MUST be absent/undefined (not an empty array).
- **FR-007**: CLI JSON output MUST include the `id` field on each message object and the `activeBranchBubbleIds` field on the session object when available.
- **FR-008**: Existing CLI table/text output MUST NOT change. The bubble ID and active branch data are only surfaced in JSON output and the library API.
- **FR-009**: Exported formats (Markdown and JSON via the export command) MUST include the message `id` when available.
- **FR-010**: Parsing of `composerData` and `fullConversationHeadersOnly` MUST fail soft. Invalid JSON, non-array manifests, or malformed header objects MUST NOT throw or block session reads; invalid entries MUST be ignored, and `activeBranchBubbleIds` MUST be absent/undefined if no valid bubble IDs remain.
- **FR-011**: When a session is sourced from workspace-fallback storage, `activeBranchBubbleIds` MUST be absent/undefined even if workspace metadata contains branch information, because reliable branch matching requires stable message-level bubble IDs.

### Key Entities

- **Message**: Extended with an `id` field representing the stable bubble UUID from Cursor's internal storage. Uniquely identifies a message within a session.
- **Session**: Extended with an `activeBranchBubbleIds` field representing the ordered list of bubble UUIDs on the current active conversation branch, as determined by Cursor's internal branch manifest.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of messages returned by the library API carry an `id` field when the underlying bubble data contains a UUID (no data loss from the existing core layer).
- **SC-002**: Consumers can identify active-branch messages by comparing message `id` values against `activeBranchBubbleIds`, with zero false positives or negatives relative to the source data.
- **SC-003**: Message IDs are stable across repeated reads of the same session — identical IDs returned for the same messages on every read.
- **SC-004**: Zero breaking changes to existing library consumers — the new fields are optional additions, not modifications to existing fields.
- **SC-005**: All existing tests continue to pass without modification (additive change only).
- **SC-006**: Sessions with malformed branch metadata still load successfully, with `activeBranchBubbleIds` omitted when valid branch IDs cannot be recovered.

## Assumptions

- The active branch manifest is stored in `fullConversationHeadersOnly`; valid header objects contain a `bubbleId` string which is extracted in order.
- Bubble UUIDs in the database are unique within a session. Cross-session uniqueness is expected but not required by this feature.
- The active branch manifest is only present in sessions created by Cursor versions that support conversation rewinding. Older sessions will simply not have this data.
- The core `Message.id` field (which can be null) maps to an optional string in the library layer — null core values become undefined (omitted) in the library, consistent with how other optional fields are handled.
- Workspace-fallback sessions may still contain raw branch metadata in `composer.composerData`, but this feature intentionally omits `activeBranchBubbleIds` there because stable `Message.id` values are not reliably available.

## Out of Scope

- Branch tree reconstruction logic (determining parent-child relationships between branches). This feature exposes the raw data; consumers are responsible for building tree structures.
- Filtering messages by active/orphaned status. The feature provides the data for consumers to implement their own filtering.
- Modifying the bubble query to separate active from orphaned bubbles at the database level. All bubbles continue to be returned in insertion order.
- Adding bubble ID display to CLI table/text output (only JSON output is affected).
- Exposing active-branch metadata for workspace-fallback sessions. Degraded reads continue to omit `activeBranchBubbleIds`.

## Dependencies

- Depends on the existing core `Message.id` field being reliably populated (already implemented in the storage layer).
- Depends on the active branch manifest being accessible from session metadata in the storage layer (already read during migration; needs to be threaded through session reads).
