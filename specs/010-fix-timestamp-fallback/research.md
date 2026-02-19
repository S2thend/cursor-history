# Research: Fix Timestamp Fallback for Pre-2025-09 Sessions

**Branch**: `010-fix-timestamp-fallback` | **Date**: 2026-02-19

## R1: Timestamp Fallback Locations

**Decision**: There are exactly 2 locations in `src/core/storage.ts` where `data.createdAt ? new Date(data.createdAt) : new Date()` is used for per-message timestamps:

1. **Line 499** in `getSession()` - Global storage code path, mapping bubble rows to messages
2. **Line 779** in `getGlobalSession()` - Global-only storage code path, same mapping pattern

Both are inside `.map()` callbacks that process bubble rows from `cursorDiskKV` table queries.

**Rationale**: A third occurrence at line 698 in `listGlobalSessions()` handles *session-level* `createdAt` (from composer metadata), not per-message timestamps. This is not part of the bug scope since session creation time comes from a different data source.

**Alternatives considered**: Fixing in `parser.ts` was considered but rejected -- the parser handles workspace-storage sessions which have a different data format (generation-based with `unixMs` timestamps). The bug only affects global-storage bubble data.

## R2: Available Timestamp Fields in Old Bubble Data

**Decision**: The `timingInfo` object on old-format assistant bubbles contains these fields (all Unix milliseconds):

| Field | Availability | Meaning |
|-------|-------------|---------|
| `clientStartTime` | Common on assistant bubbles | When the client started processing |
| `clientEndTime` | Common on assistant bubbles | When the client finished processing |
| `clientRpcSendTime` | Present on old-format assistant bubbles | When the RPC request was sent (best proxy for "message time") |
| `clientSettleTime` | Sometimes present | When the response settled/completed |

**Rationale**: `clientRpcSendTime` is the best timestamp proxy because it represents the moment the user's request triggered the assistant response -- closest to "when the message happened." The existing `extractTimingInfo()` function only uses `clientStartTime` and `clientEndTime` for duration calculation, not timestamp resolution.

**Alternatives considered**: Using `clientStartTime` as the secondary fallback, but `clientRpcSendTime` is semantically more appropriate (it's the request initiation time, not the processing start time).

## R3: Session Creation Time Availability

**Decision**: Session creation time (`summary.createdAt`) is available in both affected code paths:

- In `getSession()`: The `summary` variable (type `ChatSessionSummary`) is resolved at line 424-425 before bubble processing begins. `summary.createdAt` is a `Date` object.
- In `getGlobalSession()`: The `summary` variable is resolved at line 745-746 from `listGlobalSessions()`. `summary.createdAt` is also a `Date` object.

Both already have session-level timestamp context. It just needs to be threaded into the message mapping.

**Rationale**: No additional database queries or parameter changes needed. The session summary is already fetched and available in scope.

## R4: Interpolation Strategy for User Messages

**Decision**: Use a two-pass approach:

- **Pass 1**: Extract direct timestamps from each bubble's own data (`createdAt` > `clientRpcSendTime` > `clientSettleTime` > `clientEndTime`). Mark unresolvable bubbles as `null`.
- **Pass 2**: Fill `null` timestamps by scanning neighbors. Prefer the next message's timestamp (user message → next assistant response approximation). Fall back to previous message's timestamp.

**Rationale**: A single-pass approach cannot interpolate from "next" messages since they haven't been processed yet. Two passes keep the logic clean and separated (extraction vs. gap-filling). The "prefer next" heuristic is based on the typical chat pattern: user sends message, assistant responds immediately, so the assistant's `clientRpcSendTime` is within seconds of the user's actual send time.

**Alternatives considered**:
- Single pass with lookahead: More complex, harder to test, same result.
- Using session `createdAt` for all unresolved messages: Less accurate. A session might span hours; individual interpolation is closer to reality.
- Averaging prev/next timestamps: Over-engineering for approximate data. The next message's time is a sufficient approximation.

## R5: Validation Threshold for Unix Millisecond Timestamps

**Decision**: Use `> 1_000_000_000_000` (September 9, 2001 in milliseconds) as the validity threshold. This distinguishes Unix milliseconds from Unix seconds and rejects clearly invalid values (0, negative, small numbers).

**Rationale**: The issue report uses this exact threshold. Cursor was first released in 2023, so any legitimate timestamp will be well above this threshold. This also guards against the case where a value might be in seconds rather than milliseconds (a common data format confusion).

**Alternatives considered**: Using a tighter threshold like `> 1_600_000_000_000` (September 2020) to reject pre-Cursor timestamps. Rejected because it's unnecessarily restrictive and the broader threshold is sufficient for validation.

## R6: Impact on Existing Tests

**Decision**: Existing tests in `tests/unit/storage.test.ts` use mock bubbles with explicit `createdAt` fields. These will not be affected by the change since `createdAt` remains the primary source. New tests need to cover:

1. `extractTimestamp()` function with various field combinations
2. `fillTimestampGaps()` function with various gap patterns
3. Integration: `getSession()` with mock bubbles lacking `createdAt` but having `timingInfo`

**Rationale**: The change is additive (new fallback chain) and backward-compatible (existing `createdAt` path unchanged). Existing tests provide regression coverage for the happy path.
