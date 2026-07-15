# PR #32 Incremental Update: Solutions

**Feature:** `015-cursor-store-stack`
**Baseline:** PR #32, commit `bf7d91f`
**Created:** 2026-07-15
**Status:** Incremental

## Purpose

This document records accepted solutions for the problems in [`problems.md`](./problems.md). A problem is added here only after its direction has been discussed and accepted. Each section moves through `Accepted`, `Implemented`, and `Verified` as work progresses.

## P01 — Merge Composer and Store representations without silent loss & P02 — Preserve every rendered message

**Status:** Accepted (implementation in progress — pending review)

### Decision

Sessions with different IDs remain independent. Sessions with the same ID are treated as two representations of the same logical conversation and are merged field by field instead of selecting one complete object and discarding the other.

The merge follows three rules:

1. If only one source provides a value, keep that value.
2. If both sources provide equivalent values, keep one value and record both sources.
3. If both sources provide different values, apply the conflict priority for the current runtime environment.

### Conflict priority

| Runtime environment | Preferred source for a true conflict |
|---|---|
| WSL | Store |
| Windows | Composer |
| macOS | Composer |
| Native Linux | No new platform override; preserve the current default Composer-first resolution order |

An explicit CLI path or environment configuration that clearly selects one storage tree takes precedence over platform inference. If only one source exists, that source is used directly.

WSL must be detected separately from native Linux. The current `detectPlatform()` function groups both environments under `linux`, so runtime detection must be extended before the platform priority is applied.

### Session-field merge

Scalar metadata such as title, workspace path, creation time, and update time is filled from either source when the other side is missing it. A true scalar conflict is resolved by the platform priority above.

Source-specific information is additive and must not be removed merely because the preferred source lacks it. Examples include Composer token/model data and Store structured tool-call data.

### Message merge

Message order and message time are separate concerns. The canonical order comes from the source's own ordered structure and must not be reconstructed by sorting timestamps:

- Composer uses its active branch / ordered bubble representation.
- Store uses the ordered `latestRoot` message references and ordered turn structure from `store.db`; transcript-only fallback preserves JSONL line order.

Modern Composer bubble records provide a native per-bubble `createdAt` value. Older Composer records may expose lifecycle timing fields or may require interpolation. Store protobuf can expose recorded conversation- or turn-level timing fields, but those fields are not guaranteed to be populated and must only be attached to a message when their semantic mapping is proven.

The merged message model therefore treats a per-message timestamp as optional. A timestamp is assigned only when it is directly stored and can be mapped to that message or turn. Session-level `createdAt`, `updatedAt`, or `conversation_started_timestamp_ms` values must not be copied onto every message. Missing message timestamps remain absent and are omitted from display and export rather than replaced with a fabricated fallback.

When a timestamp is retained, its origin is recorded so a directly stored timestamp cannot be confused with an inferred value:

```ts
timestamp?: Date;
timestampSource?: 'composer-created-at' | 'composer-timing' | 'store-turn-timing';
```

Timestamp comparison is auxiliary only. It is never the sole message identity rule and never overrides the source-native sequence.

The preferred source supplies the backbone message order. The two ordered message sequences are aligned using stable content signals:

- message role;
- normalized text content;
- tool name and normalized tool parameters;
- relative position in the conversation.

Matched messages are merged field by field. Missing fields are filled from the other representation. Unmatched messages from either source are preserved in the relative position implied by surrounding matched messages.

The role/content/tool signature is used only for P01 cross-stack alignment. It is not a general instruction to deduplicate messages after loading or merging.

### P02 default display behavior

Human-readable CLI output preserves every message produced by the resolved session and renders the messages once in their canonical array order. Consecutive duplicate folding is removed from the default `show` path.

The renderer does not collapse messages based on role, content, timestamp, tool calls, or any other equality signature. Two messages remain two displayed events even when all currently visible fields are identical. This prevents the presentation layer from hiding meaningful differences in structured tool calls, model data, token usage, duration, provenance, or fields added in later versions.

Filtering such as `show --only tool` selects messages by type and then renders every selected message without a second deduplication pass. JSON output and export continue to preserve the resolved message sequence.

No replacement collapse flag is added in this increment. An explicit opt-in presentation feature may be considered later, but it must not participate in P01 merge correctness and must never modify the underlying resolved session.

### Provenance

A merged session must be distinguishable from a single-source session. The target provenance contract is:

```ts
{
  source: 'merged',
  sources: ['composer', 'store'],
  preferredSource: 'composer' | 'store'
}
```

Messages produced by the merge carry an optional origin marker:

```ts
source: 'composer' | 'store' | 'both'
```

This provenance is additive. Existing single-source values such as `global`, `workspace-fallback`, `transcript`, `store-complete`, and `store-partial` remain valid.

### Expected behavior

- Windows and macOS keep Composer as the backbone and use Store data to fill non-conflicting gaps.
- WSL keeps Store as the backbone and uses Composer data to fill non-conflicting gaps.
- Native Linux receives no new special override and keeps the current default conflict order.
- A lower-priority source is never discarded before its non-conflicting fields and unmatched messages have been considered.
- The final session records that both sources participated and which source won true conflicts.
- Message order follows the selected source's stored sequence, not timestamp sorting.
- Directly stored message or turn times are displayed when available; missing times are omitted.
- Session creation, update, and conversation-start times remain session-level metadata and are not presented as per-message times.
- Human-readable output renders every resolved message and never folds consecutive duplicates by default.
- Distinct structured tool-call messages remain visible in both normal output and `--only tool` output, including when their text content is empty.

### Related problem boundaries

- **P04 can be implemented in the same data-model pass but remains distinct.** P04 preserves the session-level `updatedAtMs` value and uses `createdAtMs` only when no update time exists. It does not provide a missing per-message timestamp and must not affect message order.
- **P03 consumes the P01 result but remains distinct.** Export must preserve the merged workspace and provenance fields after cross-stack resolution instead of independently resolving Composer-only metadata.

### Minimal verification

- Same ID and equivalent content produces one session marked as merged.
- On WSL, a true conflict selects Store while preserving unique Composer fields.
- On Windows/macOS, a true conflict selects Composer while preserving unique Store fields.
- Distinct messages and tool calls from either source remain present after the merge.
- Messages remain in source-native order when timestamps are missing, equal, or non-monotonic.
- A directly stored Composer message time or mapped Store turn time is retained with its source.
- A message without a directly mapped time has no rendered/exported timestamp.
- Store session creation, update, and conversation-start timestamps are not duplicated onto every message.
- Empty-text assistant messages with different structured tool calls are treated as distinct.
- Consecutive messages with identical role and content are each rendered separately and no default `×N` folding marker is produced.
- `--only tool` preserves and renders every matching structured tool-call message in source-native order.

## Solution Status

| Problem | Solution status |
|---|---|
| P01–P02 | Accepted (in progress) |
| P03–P11 | Not recorded yet |
