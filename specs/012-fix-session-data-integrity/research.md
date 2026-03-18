# Research: Fix Session Data Integrity

**Branch**: `012-fix-session-data-integrity` | **Date**: 2026-03-18

## R1: Debug Logging Pattern

**Decision**: Extend existing `debugLog()` in `src/core/database/debug.ts` with a storage-specific namespace.

**Rationale**: The existing debug module uses `[cursor-history:sqlite]` prefix and checks `DEBUG` / `CURSOR_HISTORY_DEBUG` env vars. Storage debug messages should use `[cursor-history:storage]` prefix to distinguish from database driver messages. Same env var triggers both.

**Alternatives considered**:
- New debug module in `src/core/` — rejected, unnecessary file when we can add a function to the existing module or create a thin wrapper.
- Using `console.warn()` directly — rejected, inconsistent with existing pattern and not controllable via env var.

## R2: Empty Bubble Placeholder Pattern

**Decision**: Use `[empty message]` as the placeholder content string, following the existing `[Thinking]\n...` and `[Error]...` inline marker patterns.

**Rationale**: The display layer in `table.ts` already detects markers via `isToolCall()`, `isThinking()`, `isError()` functions that check for string prefixes. An `[empty message]` marker is consistent and can be detected the same way if needed.

**Alternatives considered**:
- Empty string with `metadata.corrupted = true` — rejected per clarification; visible placeholder preferred.
- `[no content]` — rejected; `[empty message]` is more descriptive and matches the noun pattern of other markers.

## R3: Malformed Bubble Handling

**Decision**: When a bubble row's JSON fails to parse, create a corrupted placeholder message with `content: '[corrupted message]'`, `metadata: { corrupted: true, bubbleType: undefined }`, and `role: 'assistant'` (safe default since we can't determine type). The session remains `source: 'global'`.

**Rationale**: Per FR-009, a single malformed row should not downgrade the entire session. The corrupted placeholder preserves the bubble's position in the chronological sequence.

**Alternatives considered**:
- Skip malformed rows entirely — rejected, this is the current bug behavior.
- Abort global loading and fall back to workspace — rejected per FR-009.

## R4: toolCalls Population from toolFormerData

**Decision**: Extract structured `ToolCall` from `toolFormerData` during bubble-to-message mapping in `getSession()` and `getGlobalSession()`. This is done alongside (not instead of) the existing text rendering via `extractBubbleText()`.

**Rationale**: The `ToolCall` type already exists in both `src/core/types.ts` and `src/lib/types.ts` with `name`, `status`, `params`, `result`, `error`, `files` fields. The `toolFormerData` object in bubble data contains all of these. Currently only `extractBubbleText()` reads `toolFormerData` and flattens it to text.

**Key mapping**:
- `name` ← `toolFormerData.name`
- `status` ← `'error'` if `additionalData.status === 'error'`, `'cancelled'` if `status === 'cancelled'`, else `'completed'`
- `params` ← `JSON.parse(toolFormerData.params)` with `{ _raw: rawString }` fallback for invalid JSON
- `result` ← `toolFormerData.result`
- `files` ← extracted from params using `getParam()` helper for file path fields

## R5: Source Field Threading

**Decision**: Add optional `source?: 'global' | 'workspace-fallback'` to `ChatSession` (core) and `Session` (lib). Set it at the point where the session is constructed in `getSession()` and `getGlobalSession()`.

**Rationale**: The field is set based on which code path successfully produced the session data. In `getSession()`, the global path sets `source: 'global'`, the workspace fallback path sets `source: 'workspace-fallback'`. In `getGlobalSession()`, it's always `'global'`. The `convertToLibrarySession()` function threads it through.

**Alternatives considered**:
- Separate method to query source — rejected, adds API surface for a simple field.
- Required field — rejected per clarification, optional for backward compatibility.

## R6: Existing Type Readiness

**Finding**: Both `src/core/types.ts` and `src/lib/types.ts` already have `metadata?: { corrupted?: boolean; bubbleType?: number }` on the `Message` interface. The `ToolCall` interface is fully defined in both. The `convertToLibrarySession()` in `src/lib/index.ts` already maps `msg.toolCalls` and `msg.metadata` through. Only `source` needs to be added to `ChatSession` and `Session`.

## R7: Bubble Mapping Deduplication

**Finding**: The bubble-to-message mapping logic is duplicated between `getSession()` (lines 482-517) and `getGlobalSession()` (lines 772-807). Both have the same `content.length > 0` filter bug and both lack `toolCalls` population. The fix must be applied to both locations. Consider extracting a shared `mapBubbleToMessage()` helper to avoid future drift.

**Decision**: Extract a shared helper function `mapBubbleToMessage(row, debugContext)` that both `getSession()` and `getGlobalSession()` call. This reduces duplication and ensures FR-008 compliance.
