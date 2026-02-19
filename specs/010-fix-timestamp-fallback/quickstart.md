# Quickstart: Fix Timestamp Fallback for Pre-2025-09 Sessions

**Branch**: `010-fix-timestamp-fallback` | **Date**: 2026-02-19

## What This Changes

This fix improves timestamp accuracy for messages in Cursor sessions created before September 2025. Instead of showing the current time for old messages, the system now extracts timestamps from alternative data fields and interpolates for messages with no timestamp source.

## Files to Modify

1. **`src/core/storage.ts`** - Main changes:
   - Extend `RawBubbleData.timingInfo` with `clientRpcSendTime` and `clientSettleTime`
   - Add `extractTimestamp()` function (direct timestamp extraction)
   - Add `fillTimestampGaps()` function (neighbor interpolation + session fallback)
   - Update `getSession()` bubble mapping to use new functions
   - Update `getGlobalSession()` bubble mapping to use new functions

2. **`tests/unit/storage.test.ts`** - New test cases:
   - `extractTimestamp()` unit tests (priority chain, validation)
   - `fillTimestampGaps()` unit tests (interpolation patterns)
   - Regression tests (existing `createdAt` behavior unchanged)

## Development Workflow

```bash
# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Test manually with real data
node dist/cli/index.js show 1 --json | jq '.messages[].timestamp'
```

## Key Design Decisions

- **Two-pass approach**: Extract direct timestamps first, then fill gaps. Keeps extraction and interpolation logic separate and testable.
- **Prefer "next" neighbor**: User messages precede assistant responses, so the next assistant's `clientRpcSendTime` is the closest approximation to the user's send time.
- **Validation threshold**: `> 1_000_000_000_000` ensures values are Unix milliseconds, not seconds.
- **No public API changes**: `Message.timestamp` type remains `Date`. Downstream consumers see better timestamps with no code changes needed.
