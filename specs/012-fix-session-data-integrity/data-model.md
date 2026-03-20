# Data Model: Fix Session Data Integrity

**Branch**: `012-fix-session-data-integrity` | **Date**: 2026-03-18

## Changed Entities

### ChatSession (core: `src/core/types.ts`)

**New field**:

```typescript
export interface ChatSession {
  // ... existing fields ...
  /** Data source: 'global' (full bubble data) or 'workspace-fallback' (degraded prompt snapshots) */
  source?: 'global' | 'workspace-fallback';
}
```

- Optional, defaults to `undefined`
- Set during session construction in `getSession()` and `getGlobalSession()`
- No migration needed — purely additive

### Session (library: `src/lib/types.ts`)

**New field**:

```typescript
export interface Session {
  // ... existing fields ...
  /** Data source indicating completeness: 'global' (full conversation) or 'workspace-fallback' (degraded) */
  source?: 'global' | 'workspace-fallback';
}
```

- Mapped from `ChatSession.source` in `convertToLibrarySession()`
- Optional, non-breaking

### Message (core + library) — No type changes needed

Both `src/core/types.ts` and `src/lib/types.ts` already have:

```typescript
export interface Message {
  toolCalls?: ToolCall[];
  metadata?: {
    corrupted?: boolean;
    bubbleType?: number;
  };
}
```

**Behavioral change only**: `toolCalls` will now be populated from `toolFormerData`. `metadata.corrupted` will be set for malformed bubble rows.

### ToolCall (core + library) — No type changes needed

Already defined with all needed fields:

```typescript
export interface ToolCall {
  name: string;
  status: 'completed' | 'cancelled' | 'error';
  params?: Record<string, unknown>;
  result?: string;
  error?: string;
  files?: string[];
}
```

**Behavioral change only**: Now actually populated during bubble mapping.

## New Helper Function

### `mapBubbleToMessage()` (new in `src/core/storage.ts`)

Extracted from duplicated logic in `getSession()` and `getGlobalSession()`:

```typescript
function mapBubbleToMessage(
  row: { key: string; value: string }
): Message | null
```

**Responsibilities**:
- Parse bubble JSON (return corrupted placeholder on parse failure)
- Determine role from `data.type` (1=user, 2=assistant)
- Extract text via `extractBubbleText()`
- Use `[empty message]` placeholder when text is empty
- Extract structured `toolCalls` from `toolFormerData`
- Extract `tokenUsage`, `model`, `durationMs`
- Set `metadata.corrupted` and `metadata.bubbleType`
- Debug log parse failures

**Returns**: `Message` (never filters — always returns a message or corrupted placeholder)

### `extractToolCalls()` (new in `src/core/storage.ts`)

```typescript
function extractToolCalls(
  data: Record<string, unknown>
): ToolCall[] | undefined
```

**Responsibilities**:
- Check for `toolFormerData.name`
- Parse `params` with `{ _raw: rawString }` fallback
- Determine status: error > cancelled > completed
- Extract file paths from params
- Return `undefined` if no tool call data

## State Transitions

No state machines or lifecycle changes. This is a data extraction fix.

## Validation Rules

- `source` must be `'global'` or `'workspace-fallback'` when set
- `toolCalls[].status` must be one of `'completed' | 'cancelled' | 'error'`
- `toolCalls[].params` must be `Record<string, unknown>` (use `{ _raw: string }` sentinel for invalid JSON)
- `metadata.corrupted` is `true` only for malformed bubble rows
