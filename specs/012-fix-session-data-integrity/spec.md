# Feature Specification: Fix Session Data Integrity

**Feature Branch**: `012-fix-session-data-integrity`
**Created**: 2026-03-18
**Status**: Draft
**Input**: User description: "Bug: listSessions() / getSession() can return all messages as role: 'user' and drop assistant/tool data"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Library consumers get complete conversation data (Priority: P1)

A developer using the `cursor-history` library API calls `getSession()` for a session that has assistant bubbles and tool activity in global storage. They receive the full chronological conversation including assistant messages, tool call metadata, and thinking blocks — not just user prompts.

**Why this priority**: This is the core data integrity bug. Without this fix, the library returns materially incorrect session history. Every downstream consumer is affected.

**Independent Test**: Can be fully tested by calling `getSession()` against a session with known global bubble data containing type=2 (assistant) bubbles and verifying the returned messages include both `user` and `assistant` roles.

**Acceptance Scenarios**:

1. **Given** a session whose global `cursorDiskKV` contains both type=1 (user) and type=2 (assistant) bubbles, **When** `getSession()` is called, **Then** the returned messages include both `role: 'user'` and `role: 'assistant'` entries in chronological order.
2. **Given** a session whose global storage read fails before usable bubble data can be loaded (DB locked, query error, missing DB, missing table, or no bubbles for the composer), **When** `getSession()` falls back to workspace parsing, **Then** the returned session includes a `source` indicator marking it as degraded/fallback data, and debug logging explains why global loading failed.
3. **Given** a session where global loading succeeds but some assistant bubbles have empty extracted text, **When** `getSession()` processes those bubbles, **Then** those bubbles are preserved in the output with placeholder content rather than silently dropped.
4. **Given** a session where most global bubbles parse successfully but one bubble row contains malformed JSON, **When** `getSession()` processes the session, **Then** the parseable bubbles are returned, the malformed row is represented as a corrupted placeholder message with `metadata.corrupted = true`, the session remains `source: 'global'`, and debug logging records the parse failure.

---

### User Story 2 - Structured tool call data is available on messages (Priority: P2)

A developer consuming session data through the library API accesses `message.toolCalls` to programmatically inspect what tools the AI used during a conversation. The `toolCalls` array is populated with structured data (tool name, parameters, result, status) instead of being always empty.

**Why this priority**: The `ToolCall` type exists in both core and library types, and `toolCalls` is declared on the `Message` interface, but it is never populated. This is a gap between the declared API contract and actual behavior.

**Independent Test**: Can be tested by calling `getSession()` on a session with known tool activity (e.g., `read_file`, `edit_file_v2`) and verifying `message.toolCalls` contains structured entries.

**Acceptance Scenarios**:

1. **Given** an assistant bubble with `toolFormerData.name` set (e.g., `read_file`), **When** the bubble is mapped to a message, **Then** `message.toolCalls` contains a structured entry with `name`, `params`, `result`, and `status`.
2. **Given** a tool bubble with `toolFormerData.additionalData.status === 'error'`, **When** mapped to a message, **Then** the tool call entry has `status: 'error'`.
3. **Given** a tool bubble with `toolFormerData.status === 'cancelled'`, **When** mapped to a message, **Then** the tool call entry has `status: 'cancelled'`.
4. **Given** a tool bubble with `toolFormerData.name` set but no explicit status fields, **When** mapped to a message, **Then** the tool call entry defaults to `status: 'completed'`.

---

### User Story 3 - Fallback sessions are clearly marked as degraded (Priority: P2)

A developer listing sessions via `listSessions()` or inspecting a session via `getSession()` can distinguish between sessions loaded from full global bubble data and sessions reconstructed from workspace/composer metadata. Degraded sessions are clearly marked so consumers don't mistake prompt snapshots for full conversations.

**Why this priority**: Without this distinction, consumers cannot tell whether a session with only user messages is genuinely user-only or is a degraded fallback. This causes silent data quality issues downstream.

**Independent Test**: Can be tested by forcing a global storage failure (e.g., missing global DB) and verifying the returned session carries a `source` metadata field indicating workspace-fallback origin.

**Acceptance Scenarios**:

1. **Given** a session loaded successfully from global `cursorDiskKV` bubbles, **When** returned to the caller, **Then** the session metadata indicates `source: 'global'`.
2. **Given** a session where global loading failed and workspace parsing was used, **When** returned to the caller, **Then** the session metadata indicates `source: 'workspace-fallback'`.
3. **Given** a degraded session from workspace fallback, **When** displayed via CLI `show` command, **Then** a visual indicator warns the user that this is partial data.

---

### User Story 4 - Debug logging for global storage failures (Priority: P3)

A developer or maintainer troubleshooting why sessions appear user-only can enable debug logging to see exactly why global storage loading fell back or where individual bubble parsing degraded the result. The logging distinguishes between: no global DB, no `cursorDiskKV` table, no bubbles for composer, DB open failure, and malformed bubble parse failure.

**Why this priority**: The current silent `catch {}` blocks make it impossible to diagnose the root cause. Debug logging is essential for maintainability but doesn't affect end-user data.

**Independent Test**: Can be tested by enabling `DEBUG=cursor-history:*` and triggering each failure mode, then verifying the appropriate debug message appears.

**Acceptance Scenarios**:

1. **Given** `DEBUG=cursor-history:*` is set and the global DB file doesn't exist, **When** `getSession()` falls back, **Then** a debug message logs "Global DB not found at [path]".
2. **Given** debug logging is enabled and the global DB exists but `cursorDiskKV` table is missing, **When** `getSession()` falls back, **Then** a debug message logs "cursorDiskKV table not found".
3. **Given** debug logging is enabled and bubble query throws an error, **When** `getSession()` falls back, **Then** a debug message logs the error details.

---

### Edge Cases

- What happens when a bubble has `toolFormerData` with a `name` but no `params`, `result`, or `status`? The tool call should still be created with available fields; missing params and result default to `undefined`, and status defaults to `completed`.
- What happens when `extractBubbleText()` returns empty string for a user bubble (type=1)? User bubbles with empty content should also be preserved with placeholder content, consistent with assistant bubble handling.
- What happens when the global DB is locked by a running Cursor instance? The existing `openDatabase` read-only mode should handle this via WAL. If it fails, the fallback should fire with appropriate debug logging.
- What happens when a session has zero bubbles in global storage but exists in workspace storage? The workspace fallback should activate and the session should be marked as `source: 'workspace-fallback'`.
- What happens when `toolFormerData.params` contains invalid JSON? The tool call should still be created, and `toolCalls[].params` should preserve the raw payload in an object-shaped sentinel such as `{ _raw: '...' }`.
- What happens when `toolFormerData.name` is present but neither `toolFormerData.status` nor `toolFormerData.additionalData.status` is set? The tool call should still be created and default to `status: 'completed'`.
- What happens when one global bubble row is malformed JSON but the rest of the session is readable? The session should still be returned as `source: 'global'`; parseable bubbles are preserved, the malformed bubble becomes a corrupted placeholder message with `metadata.corrupted = true`, and the parse failure is logged for debugging.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST NOT silently swallow errors when global storage loading fails in `getSession()`. Errors MUST be logged via the existing debug logging system (`DEBUG=cursor-history:*`) before falling back to workspace parsing.
- **FR-002**: System MUST preserve assistant bubbles (type=2) that have empty extracted text content, using the visible placeholder `[empty message]` in the `content` field instead of silently filtering them out. This is consistent with existing `[Thinking]` and `[Error]` inline marker patterns.
- **FR-003**: System MUST populate `message.toolCalls` with structured tool call data when `toolFormerData` contains a tool name, in addition to the existing flattened text rendering. If `toolFormerData.params` is invalid JSON, `toolCalls[].params` MUST preserve the raw payload using an object-shaped sentinel such as `{ _raw: '...' }` rather than widening the public type to include strings. If no explicit tool status is present, the system MUST default `toolCalls[].status` to `'completed'`.
- **FR-004**: System MUST expose an optional `source` field on `ChatSession` (core) and `Session` (library) indicating whether the session was loaded from global bubble data (`'global'`) or reconstructed from workspace metadata (`'workspace-fallback'`). The field defaults to `undefined` for backward compatibility. For backup-loaded sessions, the `source` value reflects which data was actually available in the backup (not the access method).
- **FR-005**: System MUST distinguish in debug output between workspace-fallback reasons (global DB not found, `cursorDiskKV` table missing, no bubbles for composer, DB open/query error) and malformed bubble JSON parse errors encountered during otherwise successful global loads.
- **FR-006**: The `content.length > 0` filter in bubble-to-message mapping MUST be replaced with logic that preserves messages with empty content but annotates them, so that no bubbles are silently discarded.
- **FR-007**: The workspace/composer fallback parser MUST NOT present prompt snapshots as equivalent to full conversation history. Sessions from this path MUST be distinguishable from global-sourced sessions.
- **FR-008**: The `getGlobalSession()` function MUST apply the same fixes (empty bubble preservation, toolCalls population, debug logging) as `getSession()`.
- **FR-009**: System MUST NOT downgrade a session to `source: 'workspace-fallback'` solely because one or more individual global bubble rows fail to parse. It MUST preserve all parseable global bubbles and insert one corrupted placeholder message for each malformed row, with debug logging for the parse failure.
- **FR-010**: Corrupted placeholder messages created for malformed bubble rows MUST set `message.metadata.corrupted` to `true` so consumers can detect degraded message data programmatically.

### Key Entities

- **Message**: Extended with populated `toolCalls` field and preserved even when `content` is empty. Corrupted placeholder messages set `metadata.corrupted = true`.
- **ToolCall**: Already defined in types; now actually populated from `toolFormerData` during bubble mapping. Invalid JSON params are preserved in `params` via an object-shaped sentinel (for example `{ _raw: '...' }`) so the public type remains object-only.
- **ChatSession / Session**: Extended with optional `source` field (`source?: 'global' | 'workspace-fallback'`). Defaults to `undefined` for backward compatibility. Non-breaking addition following the same pattern as `tokenUsage`, `model`, and `durationMs`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For sessions with global bubble data containing type=2 rows, `getSession()` returns messages with both `user` and `assistant` roles — not just `user`.
- **SC-002**: `message.toolCalls` is populated for 100% of messages that have `toolFormerData.name` set in the underlying bubble data.
- **SC-003**: Zero assistant bubbles are silently discarded due to empty content extraction. All bubbles present in the DB appear in the returned message array.
- **SC-004**: Sessions loaded from workspace fallback are distinguishable from global-sourced sessions via the `source` metadata field.
- **SC-005**: When debug logging is enabled, every global storage fallback event produces a log entry explaining the specific failure reason.
- **SC-006**: Existing tests continue to pass. No regressions in CLI output formatting or library API return types.
- **SC-007**: For every malformed global bubble row preserved as a corrupted placeholder message, the returned message has `metadata.corrupted === true`.

## Clarifications

### Session 2026-03-18

- Q: Should adding `source` to the public types be a breaking change or a non-breaking addition? → A: Optional field (`source?: 'global' | 'workspace-fallback'`), non-breaking. Follows existing pattern of optional field additions.
- Q: What `source` value should backup-loaded sessions use? → A: Reuse `'global'` or `'workspace-fallback'` based on which data was actually available in the backup. Source reflects data completeness, not access method.
- Q: Should the placeholder for empty bubbles be visible user-facing text or metadata-only? → A: Visible placeholder `[empty message]` in the `content` field, consistent with existing `[Thinking]` and `[Error]` inline marker patterns.
- Q: How should malformed individual global bubble rows be handled when the rest of the session loads successfully? → A: Keep `source: 'global'`, preserve all parseable bubbles, and insert a corrupted placeholder message for each malformed bubble with debug logging.
- Q: How should invalid `toolFormerData.params` be represented in `toolCalls[].params`? → A: Preserve the raw payload in an object-shaped sentinel such as `{ _raw: '...' }` so the tool call is retained without widening the public type to include strings.
- Q: What status should a tool call use when `toolFormerData.name` exists but no explicit status is present? → A: Default the tool call status to `completed`.
- Q: Should corrupted placeholder messages expose machine-readable corruption metadata? → A: Yes. Corrupted placeholder messages must set `metadata.corrupted = true`.
