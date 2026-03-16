# Feature Specification: Retrieve Session by Composer ID or Index

**Feature Branch**: `011-session-by-id-or-index`  
**Created**: 2026-03-15  
**Status**: Draft  
**Input**: User description: "Update both the cli and lib APIs to support retrieving session history by composer ID or index. The show and export commands should both be updated."

## Clarifications

### Session 2026-03-15

- Q: Are "composer ID" and "session ID" the same identifier or two different identifiers for lookup? → A: One canonical identifier per session; "composer ID" and "session ID" mean the same value (two names for it).
- Q: When session is not found, should the error always include the valid index range or be generic? → A: When a composer ID is provided: generic session-not-found message including the invalid composer ID. When an index is provided: use existing messaging that includes the valid index range.
- Q: Library API shape: one function (index or ID) or separate functions? → A: Single function that accepts either type (e.g. getSession(identifier: number | string)).
- Q: When resolving by composer ID, search only current workspace or all workspaces? → A: Match existing behavior for index: if a workspace filter is applied, apply the same filter when resolving by ID.
- Q: Should multi-session export accept a mix of indices and IDs? → A: If multi-session export exists, allow the list to support either indices or composer IDs but no mixing; otherwise no change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View a Session by Composer ID (Priority: P1)

A user has a composer ID (e.g. from another tool, log, or URL) and wants to view that specific chat session. They can run the "show" command with that ID and see the full conversation, without having to look up the session's position in the list.

**Why this priority**: This is the main new capability. Users who have an ID from elsewhere get a direct way to open that session.

**Independent Test**: Can be fully tested by running show with a valid composer ID and verifying the correct session is displayed.

**Acceptance Scenarios**:

1. **Given** a valid composer ID known to exist in history, **When** the user runs the show command with that ID, **Then** the system displays that session's full conversation.
2. **Given** a valid composer ID, **When** the user runs the export command with that ID, **Then** the system exports that session to the chosen format (e.g. Markdown or JSON).
3. **Given** an invalid or unknown composer ID, **When** the user runs show or export with that value, **Then** the system reports a generic session-not-found error that includes the invalid composer ID.

---

### User Story 2 - View a Session by Index (Priority: P1)

A user who lists sessions and sees them numbered (1, 2, 3, …) can continue to use that number to view or export a session. Behavior remains consistent with current product: index refers to the session’s position in the list (e.g. 1 = first/most recent).

**Why this priority**: Preserves existing behavior and ensures current users are not broken.

**Independent Test**: Can be tested by running show and export with numeric indices and verifying the same session is shown as before the change.

**Acceptance Scenarios**:

1. **Given** a list of sessions where the first is index 1, **When** the user runs show with 1, **Then** the system displays the first session.
2. **Given** the same list, **When** the user runs export with a valid index, **Then** the system exports that session.
3. **Given** an index greater than the number of sessions (e.g. 99 when only 5 exist), **When** the user runs show or export, **Then** the system reports that the session was not found using existing messaging that includes the valid index range.

---

### User Story 3 - Programmatic Retrieval by ID or Index (Priority: P2)

A developer or script uses the library API to fetch a session via a single function that accepts either a numeric index (e.g. 0 for first in zero-based usage) or a composer ID string. The same retrieval and export capabilities available from the CLI are available by that single identifier (index or ID) from the library.

**Why this priority**: Parity between CLI and library keeps automation and tooling simple.

**Independent Test**: Can be tested by calling the library with an index and with an ID and asserting the returned session matches the intended one.

**Acceptance Scenarios**:

1. **Given** the library is used with a valid session index, **When** the client requests that session, **Then** the library returns the corresponding session data.
2. **Given** the library is used with a valid composer ID, **When** the client requests that session, **Then** the library returns the corresponding session data.
3. **Given** an invalid or unknown identifier (ID or out-of-range index), **When** the client requests that session, **Then** the library signals an error (e.g. session not found) in a way the caller can handle.

---

### Edge Cases

- What happens when the user supplies a string that is numeric (e.g. "1")? The system treats it as an index so that "show 1" and "show 2" continue to work as today.
- How does the system distinguish index from ID? Index is a positive integer or numeric string (e.g. 1, 2, "1", "2"); ID is a non-numeric or UUID-like string. The system applies one consistent rule (e.g. numeric → index, otherwise → ID).
- What happens when the user supplies an ID that does not exist? The system reports a generic session-not-found message that includes the invalid composer ID (no fallback to treating it as an index).
- What happens when the user supplies an index that is zero or negative or out of range? The system reports session not found using existing messaging that includes the valid index range.
- If multi-session export exists and the user supplies a list: the list MUST be either all indices or all composer IDs; mixed lists (e.g. 1,id,3) are not required. If multi-session export does not exist, no change to export behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The show command MUST accept either a session index (positive integer) or a composer ID and display that session’s conversation.
- **FR-002**: The export command MUST accept either a session index or a composer ID and export that session to the requested format. If multi-session export is supported, a single invocation MAY accept a list of identifiers that are either all indices or all composer IDs (no mixing within one list).
- **FR-003**: When the user provides a numeric value (e.g. "1", "2"), the system MUST interpret it as an index (position in the list), not as an ID.
- **FR-004**: When the user provides a non-numeric identifier that matches a known composer ID, the system MUST retrieve that session by ID. When a workspace filter is in effect, composer ID lookup MUST use the same workspace scope as index lookup (same as existing list/show behavior).
- **FR-005**: The library API MUST expose a single retrieval function that accepts either an index (e.g. zero-based number) or a composer ID (string), consistent with CLI behavior.
- **FR-006**: The library API MUST allow exporting a session by the same single-identifier shape (index or composer ID) when export is supported.
- **FR-007**: When an identifier does not match any session, the system MUST report a session-not-found error and MUST NOT return or export a different session. When the user provided a composer ID: the message MUST be a generic session-not-found message that includes the invalid composer ID. When the user provided an index: the message MUST use existing behavior that includes the valid index range.
- **FR-008**: Listing sessions (e.g. list command or equivalent) MAY expose both index and ID so users can use either for show and export.

### Key Entities

- **Session**: A single chat conversation; has one stable identifier (composer ID) and a position (index) in the ordered list.
- **Index**: The session’s position in the list (e.g. 1-based in CLI, 0-based in library as today).
- **Composer ID**: The single canonical identifier for a session (e.g. UUID-like). "Composer ID" and "session ID" refer to the same value; both terms may appear in the documentation.

## Assumptions

- There is one canonical identifier per session (referred to as composer ID); this feature accepts that ID for lookup alongside index.
- Index ordering (e.g. 1 = first/most recent) and ID format are already defined by the existing product; this feature only adds ID as an accepted input alongside index.
- Export formats (e.g. Markdown, JSON) and options do not change; only the way the target session is specified (index or ID).
- The same distinction between index and ID applies in both CLI and library (numeric → index, non-numeric → ID). When a workspace filter is configured, resolving by composer ID uses the same workspace scope as resolving by index.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can view any known session by supplying either its list index or its composer ID via the show command, with no need to look up index when they have the ID.
- **SC-002**: Users can export any known session by supplying either its list index or its composer ID via the export command.
- **SC-003**: Callers of the library can retrieve or export a session by index or by composer ID; behavior is consistent with the CLI (same session returned for the same identifier).
- **SC-004**: Invalid or unknown identifiers result in a clear, actionable error (e.g. session not found) in both CLI and library, with no silent wrong-session result.
- **SC-005**: Existing usage by index (e.g. show 1, export 2) continues to work unchanged.
