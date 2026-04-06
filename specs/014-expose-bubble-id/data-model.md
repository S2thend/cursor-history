# Data Model: Expose Bubble ID on Message Type

**Date**: 2026-04-06 | **Branch**: `014-expose-bubble-id`

## Entity Changes

### Message (library type — `src/lib/types.ts`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Optional | Stable bubble UUID from Cursor's `cursorDiskKV` key. Absent when unavailable (e.g., workspace-fallback). |

**Mapping from core**: `msg.id` (`string | null`) → `msg.id ?? undefined` (`string | undefined`)

**Source**: `data.bubbleId` from bubble JSON, falling back to last segment of row key `bubbleId:{sessionId}:{uuid}`.

**No change to core type** — `Message.id: string | null` already exists at `src/core/types.ts:67`.

---

### ChatSession (core type — `src/core/types.ts`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `activeBranchBubbleIds` | `string[]` | Optional | Ordered bubble UUIDs of the active conversation branch. Absent when `fullConversationHeadersOnly` is missing, empty, invalid, or intentionally omitted in workspace-fallback mode. |

**Source**: `fullConversationHeadersOnly` array in the global `composerData:{sessionId}` row from `cursorDiskKV`. Each valid element is `{ bubbleId: string; type: number; serverBubbleId?: string }` — extract ordered `bubbleId` strings only. Ignore malformed entries; return `undefined` if no valid IDs remain.

---

### Session (library type — `src/lib/types.ts`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `activeBranchBubbleIds` | `string[]` | Optional | Ordered bubble UUIDs of the active conversation branch. Absent when data unavailable. |

**Mapping from core**: Direct passthrough — `coreSession.activeBranchBubbleIds` → `session.activeBranchBubbleIds` (omit if `undefined`).

## Relationships

```
Session (1) ──has many──▶ Message (N)
   │                          │
   │ activeBranchBubbleIds    │ id
   │ (ordered string[])       │ (string, unique within session)
   │                          │
   └──cross-reference────────┘
     Consumer can check: message.id ∈ session.activeBranchBubbleIds
     to determine if message is on active branch
```

## Identity & Uniqueness

- `Message.id` (bubble UUID): Unique within a session. Cross-session uniqueness expected but not guaranteed.
- `activeBranchBubbleIds` entries: Subset of message IDs in the session. May not cover all messages (orphaned rewind bubbles excluded). Intentionally omitted for `workspace-fallback` sessions because message IDs are degraded there.

## Null/Undefined Semantics

| Scenario | `Message.id` (core) | `Message.id` (lib) | `activeBranchBubbleIds` |
|----------|--------------------|--------------------|------------------------|
| Normal global read | `string` (UUID) | `string` | `string[]` (when manifest exists) |
| Bubble has no UUID | `null` | `undefined` (omitted) | N/A |
| Workspace-fallback | `null` | `undefined` (omitted) | `undefined` (omitted) |
| Old Cursor version (no rewind) | `string` (UUID) | `string` | `undefined` (omitted) |
| Empty manifest | `string` (UUID) | `string` | `undefined` (treat `[]` as absent) |
| Invalid composer JSON / malformed manifest | `string` (UUID) | `string` | `undefined` (fail soft) |
