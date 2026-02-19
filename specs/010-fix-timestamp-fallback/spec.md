# Feature Specification: Fix Timestamp Fallback for Pre-2025-09 Sessions

**Feature Branch**: `010-fix-timestamp-fallback`
**Created**: 2026-02-19
**Status**: Draft
**Input**: GitHub Issue #13 - Messages from pre-2025-09 sessions display current time instead of actual timestamps

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Accurate Timestamps for Old Assistant Messages (Priority: P1)

A user with Cursor sessions from before September 2025 views a session using `cursor-history show` or the library API. Assistant messages from these old sessions have timing information available (`timingInfo.clientRpcSendTime`) but the system currently ignores it, falling back to the current time. The user sees these messages displayed with the actual time they were sent, not the current time.

**Why this priority**: This is the core bug fix. 16.6% of all bubbles (763 out of 4,592 in the verified dataset) have accurate timestamps available via `timingInfo.clientRpcSendTime` that are simply not being read. This is the highest-value fix with zero approximation needed.

**Independent Test**: Can be fully tested by viewing an old session (pre-2025-09) containing assistant messages and verifying their timestamps reflect the actual send time rather than the current time.

**Acceptance Scenarios**:

1. **Given** a session from before September 2025 with assistant bubbles that have `timingInfo.clientRpcSendTime`, **When** the user runs `cursor-history show <index>`, **Then** the assistant message timestamps reflect the actual `clientRpcSendTime` value, not the current time.
2. **Given** a session from before September 2025 exported via `cursor-history export <index>`, **When** the user inspects the exported JSON or Markdown, **Then** timestamps on assistant messages match the actual `clientRpcSendTime` value.
3. **Given** a session from September 2025 or later where bubbles have `createdAt`, **When** the user views the session, **Then** timestamps still use `createdAt` as before (no regression).

---

### User Story 2 - Interpolated Timestamps for Old User Messages (Priority: P2)

A user with pre-2025-09 sessions views a conversation. User messages (type=1) from old sessions have no timestamp source at all -- no `createdAt` and no `timingInfo`. Instead of showing the current time, the system approximates the user message timestamp from the nearest assistant message that does have timing information. Since user messages immediately precede assistant responses, this provides a close approximation.

**Why this priority**: This addresses the remaining 26.9% of bubbles (1,237) that have no direct timestamp source. While the timestamps are approximate, they are far more useful than the current time. The interpolation depends on the P1 fix being in place first.

**Independent Test**: Can be tested by viewing an old session where user messages (bubble type 1) lack `createdAt` and `timingInfo`, and verifying they display a timestamp derived from a neighboring assistant message rather than the current time.

**Acceptance Scenarios**:

1. **Given** an old session where bubble[0] is a user message with no timestamp and bubble[1] is an assistant message with `timingInfo.clientRpcSendTime`, **When** the user views the session, **Then** bubble[0] displays the timestamp from bubble[1] (the next assistant message) as an approximation.
2. **Given** an old session where a user message has no timestamp and no subsequent message has a timestamp either, but a previous message does, **When** the user views the session, **Then** the user message displays the timestamp from the nearest previous message with a timestamp.
3. **Given** a new session (post-2025-09) where all bubbles have `createdAt`, **When** the user views the session, **Then** no interpolation occurs and all timestamps come directly from `createdAt` (no regression).

---

### User Story 3 - Session-Level Fallback for Edge Cases (Priority: P3)

In rare cases, an entire old session may have no per-message timestamps at all (no `createdAt`, no `timingInfo` on any message). Instead of displaying the current time for every message, the system falls back to the session's own creation timestamp, providing at least the correct date.

**Why this priority**: This is an edge-case fallback. Most old sessions have at least some assistant messages with `timingInfo`, so this covers the rare scenario where no messages have any timestamp source. The session creation time is less precise but still far better than the current time.

**Independent Test**: Can be tested by creating a mock session where no bubbles have `createdAt` or `timingInfo`, and verifying all messages display the session's creation timestamp.

**Acceptance Scenarios**:

1. **Given** a session where no bubbles have `createdAt` or any `timingInfo` fields, **When** the user views the session, **Then** all messages display the session's creation timestamp rather than the current time.
2. **Given** a session where no bubbles have any timestamp source and the session creation time is also unavailable, **When** the user views the session, **Then** the system falls back to the current time (last resort, same as current behavior).

---

### Edge Cases

- What happens when `timingInfo.clientRpcSendTime` contains an invalid value (e.g., 0, negative, or unreasonably small number)? The system should ignore it and proceed to the next fallback.
- What happens when a session has a mix of new-format bubbles (with `createdAt`) and old-format bubbles (with `timingInfo` only)? Each bubble should use whatever timestamp source is available for that specific bubble.
- What happens when `timingInfo.clientRpcSendTime` is present but contains a value in seconds rather than milliseconds? The system should validate that the value is a reasonable Unix millisecond timestamp (> 1,000,000,000,000) before using it.
- What happens when interpolation would assign a user message a timestamp that is later than the message that follows it? The approximation should still use the nearest neighbor's timestamp; exact ordering within the approximation is acceptable since the true timestamp is unknown.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST use `bubble.createdAt` as the primary timestamp source when present (ISO string format, available on sessions from September 2025 onward).
- **FR-002**: System MUST use `timingInfo.clientRpcSendTime` as the secondary timestamp source when `createdAt` is absent (Unix milliseconds, available on assistant messages from pre-2025-09 sessions).
- **FR-003**: System MUST use `timingInfo.clientSettleTime` or `timingInfo.clientEndTime` as tertiary timestamp sources when both `createdAt` and `clientRpcSendTime` are absent.
- **FR-004**: System MUST validate that `timingInfo` timestamp values are reasonable Unix millisecond timestamps (greater than 1,000,000,000,000, i.e., after September 2001) before using them.
- **FR-005**: System MUST interpolate timestamps for messages with no direct timestamp source by using the timestamp from the nearest neighboring message that has a resolved timestamp, preferring the next message over the previous one.
- **FR-006**: System MUST fall back to the session's creation timestamp when no per-message timestamps are available from any source (direct or interpolated).
- **FR-007**: System MUST only fall back to the current time (`new Date()`) as an absolute last resort when neither per-message timestamps nor session creation time are available.
- **FR-008**: System MUST apply the improved timestamp resolution consistently across all consumers: CLI display (`show`), JSON export, Markdown export, and library API.
- **FR-009**: System MUST not change timestamp behavior for sessions that already have `createdAt` on all bubbles (no regression for post-2025-09 sessions).

### Key Entities

- **Bubble Timestamp**: The resolved timestamp for a single message bubble, derived from a priority chain of sources: `createdAt` > `clientRpcSendTime` > `clientSettleTime`/`clientEndTime` > neighbor interpolation > session creation time > current time.
- **TimingInfo**: Existing timing data on assistant bubbles from pre-2025-09 sessions, containing `clientStartTime`, `clientEndTime`, `clientRpcSendTime`, and `clientSettleTime` fields (Unix milliseconds).

## Assumptions

- The `timingInfo.clientRpcSendTime` field on old-format assistant bubbles contains an accurate Unix millisecond timestamp representing when the request was sent. This is verified against real data stores.
- Old-format sessions (pre-2025-09) consistently have `timingInfo` on assistant messages (type=2) but not on user messages (type=1). This pattern is verified across 264 sessions.
- Interpolating a user message's timestamp from the next assistant message's `clientRpcSendTime` provides a close enough approximation (within seconds of the actual send time) to be useful for display and export purposes.
- The `clientSettleTime` field, if present, is also a valid Unix millisecond timestamp and represents a meaningful point in the message lifecycle.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Messages from pre-2025-09 sessions that have `timingInfo.clientRpcSendTime` display their actual send time instead of the current time (eliminates incorrect timestamps for ~16.6% of bubbles).
- **SC-002**: Messages from pre-2025-09 sessions that lack any direct timestamp display an approximate time derived from neighboring messages instead of the current time (addresses ~26.9% of bubbles that currently show wrong timestamps).
- **SC-003**: All messages across all session eras display a timestamp from the correct time period of the session, never the current time unless no historical timestamp source exists at all.
- **SC-004**: Existing timestamp behavior for post-2025-09 sessions remains unchanged (zero regressions).
- **SC-005**: The library API returns the same improved timestamps, ensuring downstream consumers (including vibe-history unified layer) receive accurate historical data.
