# Research: Expose Bubble ID on Message Type

**Date**: 2026-04-06 | **Branch**: `014-expose-bubble-id`

## R1: Where is bubble ID already resolved?

**Decision**: The core `Message.id` field is already populated in `mapBubbleToMessage()` at `src/core/storage.ts:276` via `data.bubbleId ?? getBubbleRowId(row.key)`. No new extraction logic is needed.

**Rationale**: The bubble UUID is extracted from two sources with clear priority:
1. `data.bubbleId` — the `bubbleId` field in the parsed bubble JSON
2. `getBubbleRowId(row.key)` — the last segment of the `bubbleId:{sessionId}:{uuid}` row key

Both paths are already tested and reliable. The `id` field on core `Message` is `string | null`.

**Alternatives considered**: None — the data is already extracted.

## R2: Where is the bubble ID lost?

**Decision**: The library mapping function `convertToLibrarySession()` at `src/lib/index.ts:127-150` explicitly omits `msg.id` when mapping core messages to library messages. The fix is to add `id: msg.id ?? undefined` to the message mapping.

**Rationale**: The library `Message` type at `src/lib/types.ts:78-111` does not define an `id` field. The CLI JSON formatter at `src/cli/formatters/json.ts:109` already outputs `id: m.id`, so CLI JSON is already correct for P1.

**Alternatives considered**: None — single point of omission.

## R3: Structure of `fullConversationHeadersOnly`

**Decision**: The active branch manifest is an array of objects with structure `{ bubbleId: string; type: number; serverBubbleId?: string }`. Extract just the `bubbleId` strings to populate `activeBranchBubbleIds`.

**Rationale**: Confirmed from `src/core/migrate.ts:358`:
```typescript
const newBubbleHeaders: Array<{ bubbleId: string; type: number; serverBubbleId?: string }> = [];
```
The `type` and `serverBubbleId` fields are internal metadata not needed by consumers. Exposing just the ordered list of `bubbleId` strings is sufficient for branch identification.

**Alternatives considered**:
- Expose full header objects (bubbleId + type + serverBubbleId): Rejected — leaks internal structure, consumers only need IDs to cross-reference against `Message.id`.
- Expose as a `Set<string>` instead of `string[]`: Rejected — order matters (represents conversation sequence).

## R4: Where is composerData already fetched during session reads?

**Decision**: `composerData` is already fetched in both session read paths and can be reused:
- `getSession()` at `src/core/storage.ts:758-760`: `composerDataRow` variable
- `getGlobalSession()` at `src/core/storage.ts:1025-1027`: `composerRow` variable

Currently both only pass the value to `parseComposerSessionUsage()`. The same parsed JSON can be used to extract `fullConversationHeadersOnly`.

**Rationale**: No additional database queries needed. The composer data row is already in memory.

**Alternatives considered**: Separate query for `fullConversationHeadersOnly` — rejected, unnecessary when the data is already fetched.

## R5: Export functions gap

**Decision**: `exportToJson()` at `src/core/parser.ts:467-490` does not include `m.id` in its message mapping. Add it. `exportToMarkdown()` does not need changes (human-readable format, IDs not useful inline).

**Rationale**: JSON export should include all structured data for machine consumption. Markdown export is for human reading; embedding UUIDs would add noise.

**Alternatives considered**: Include IDs in Markdown as HTML comments — rejected, adds complexity for minimal value.

## R6: Workspace-fallback path for bubble IDs

**Decision**: When `getSession()` falls back to workspace storage (`src/core/storage.ts:800-838`), messages are parsed via `parseChatData()` which reads from `composer.composerData` in the workspace `ItemTable`. The `parseChatData` path constructs messages differently and may not have individual bubble UUIDs. In this case, `Message.id` will be `null` in core / `undefined` in library, which is correct behavior per spec FR-003.

**Rationale**: Workspace-fallback is already marked as degraded (`source: 'workspace-fallback'`). Consumers can check `session.source` to know if IDs are reliable.

**Alternatives considered**: None — graceful degradation is the established pattern.

## R7: `activeBranchBubbleIds` in workspace-fallback path

**Decision**: The workspace-fallback path reads composer data from `ItemTable` via `getComposerData()`, which returns the raw composer objects. The `fullConversationHeadersOnly` field should be accessible from these objects. However, the workspace-fallback `parseChatData()` pipeline constructs `ChatSession` differently and does not have access to individual composer metadata per session. For the fallback path, `activeBranchBubbleIds` will be `undefined`.

**Rationale**: The fallback path's `parseChatData()` receives the full composers array but maps them to sessions without per-session metadata like `fullConversationHeadersOnly`. Adding this would require refactoring `parseChatData()`, which is out of scope for an additive feature. The global path (primary path) covers the normal case.

**Alternatives considered**: Thread `fullConversationHeadersOnly` through `parseChatData()` — deferred, significant refactor for a degraded-mode edge case.
