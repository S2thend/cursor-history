# Data Model: Fix Timestamp Fallback for Pre-2025-09 Sessions

**Branch**: `010-fix-timestamp-fallback` | **Date**: 2026-02-19

## Entity Changes

### RawBubbleData (modified)

The existing `RawBubbleData` interface in `src/core/storage.ts` needs two new optional fields in its `timingInfo` property.

**Current:**
```typescript
timingInfo?: {
  clientStartTime?: number;
  clientEndTime?: number;
};
```

**Updated:**
```typescript
timingInfo?: {
  clientStartTime?: number;
  clientEndTime?: number;
  clientRpcSendTime?: number;   // Unix ms - when RPC request was sent (old format, assistant only)
  clientSettleTime?: number;    // Unix ms - when response settled (old format, sometimes present)
};
```

**Validation rules:**
- All `timingInfo` numeric fields must be > 1,000,000,000,000 to be considered valid Unix millisecond timestamps
- Invalid values are treated as absent (skipped in fallback chain)

### Message (unchanged)

The `Message` interface in `src/core/types.ts` already has `timestamp: Date` which is the output of the resolution chain. No changes needed to the public interface.

### ChatSessionSummary (unchanged)

Already has `createdAt: Date` which will be used as a fallback source. No changes needed.

## New Functions

### extractTimestamp(data, sessionCreatedAt?)

**Purpose**: Extract the best available timestamp from a single bubble's data.

**Inputs:**
- `data`: `RawBubbleData & { createdAt?: string }` - The parsed bubble JSON
- `sessionCreatedAt` (optional): `Date` - The session's creation timestamp for last-resort fallback

**Output:** `Date | null`
- Returns `Date` if a direct timestamp is found from any source
- Returns `null` if no direct timestamp is available (needs interpolation)
- Note: Does NOT fall back to session creation time -- that happens after gap-filling

**Priority chain:**
1. `data.createdAt` (ISO string → Date)
2. `data.timingInfo.clientRpcSendTime` (Unix ms → Date, if > 1_000_000_000_000)
3. `data.timingInfo.clientSettleTime` (Unix ms → Date, if > 1_000_000_000_000)
4. `data.timingInfo.clientEndTime` (Unix ms → Date, if > 1_000_000_000_000)
5. Return `null`

### fillTimestampGaps(messages, sessionCreatedAt?)

**Purpose**: Fill null timestamps in a message array by interpolating from neighbors, then applying session-level fallback.

**Inputs:**
- `messages`: `Array<{ timestamp: Date | null; [key: string]: unknown }>` - Messages with potentially null timestamps
- `sessionCreatedAt` (optional): `Date` - Session creation time for final fallback

**Output:** Mutates the array in place. After this function:
- All `timestamp` fields are non-null `Date` objects
- Gaps filled preferring the next message's timestamp, then previous
- Any remaining nulls set to `sessionCreatedAt` or `new Date()` as absolute last resort

**Algorithm:**
1. For each message with `timestamp === null`:
   - Scan forward for first message with non-null timestamp → use it
   - If none found, scan backward for last message with non-null timestamp → use it
2. For any still-null timestamps: use `sessionCreatedAt ?? new Date()`

## Data Flow

```
Bubble JSON from SQLite
        │
        ▼
extractTimestamp(data)          ← Pass 1: Direct extraction
        │
        ▼
Message[] with some null timestamps
        │
        ▼
fillTimestampGaps(messages, sessionCreatedAt)  ← Pass 2: Interpolation + fallback
        │
        ▼
Message[] with all timestamps resolved (Date objects)
        │
        ▼
Existing code (CLI display, JSON export, library API)
```

## Affected Code Paths

| Code Path | Location | Change |
|-----------|----------|--------|
| `getSession()` bubble mapping | `storage.ts:477-509` | Replace inline timestamp with `extractTimestamp()` call, add `fillTimestampGaps()` after mapping |
| `getGlobalSession()` bubble mapping | `storage.ts:757-789` | Same change as above |
| `RawBubbleData` interface | `storage.ts:1286-1309` | Add `clientRpcSendTime` and `clientSettleTime` to `timingInfo` |
