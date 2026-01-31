# Research: Message Type Filter

**Feature**: 008-message-type-filter
**Date**: 2026-01-11

## Research Questions

### 1. How are message types currently detected?

**Finding**: The codebase already has detection functions in `src/cli/formatters/table.ts`:

```typescript
function isToolCall(content: string): boolean {
  return content.startsWith('[Tool:');
}

function isThinking(content: string): boolean {
  return content.startsWith('[Thinking]');
}

function isError(content: string): boolean {
  return content.startsWith('[Error]');
}
```

These markers are set by the storage layer (`src/core/storage.ts`) during bubble text extraction.

**Decision**: Reuse existing detection functions for filter classification.
**Rationale**: DRY principle; these functions are already battle-tested for display purposes.
**Alternatives considered**:
- Parsing raw bubble data for type fields → rejected (more complex, duplicates logic)
- Adding type field to Message interface during storage → rejected (requires broader changes)

### 2. Where should filtering logic live?

**Finding**: Two options:
1. In `formatSessionDetail()` (formatter layer) - filter during display
2. New `filterMessages()` utility function called before formatting

**Decision**: Create a new `filterMessages()` function in `table.ts` that filters before display.
**Rationale**:
- Keeps `formatSessionDetail()` focused on formatting
- Makes filter logic reusable for JSON output
- Clear separation of concerns
**Alternatives considered**:
- Inline filtering in `formatSessionDetail()` → rejected (mixing concerns)
- Filter in storage layer → rejected (over-engineering for display-time feature)

### 3. How to classify "assistant" messages?

**Finding**: Assistant messages (`type: 2` in bubble data) can be:
- Tool calls (start with `[Tool:`)
- Thinking blocks (start with `[Thinking]`)
- Errors (start with `[Error]`)
- Plain assistant text (none of the above)

**Decision**: `assistant` filter shows only plain assistant text (excludes tool/thinking/error).
**Rationale**: Users asking for "assistant" want explanatory text, not tool outputs. Per clarification session, these are mutually exclusive categories.
**Alternatives considered**:
- Include all `type: 2` messages → rejected (user clarified they want separate types)

### 4. How to handle library API integration?

**Finding**: Library API in `src/lib/` wraps core functions. Current `getSession()` returns full session with all messages.

**Decision**: Add optional `messageFilter` to `LibraryConfig` type. Filter applied after session retrieval.
**Rationale**: Matches CLI behavior; keeps core storage unchanged; simple addition to existing config pattern.
**Alternatives considered**:
- Filter in storage layer → rejected (too invasive for display feature)
- New `getFilteredSession()` function → rejected (unnecessary API proliferation)

### 5. CLI option naming

**Finding**: Existing options in `show` command:
- `-s, --short` - display option
- `-t, --think` - display option (show full thinking)
- `--tool` - display option (show full tool details)
- `-e, --error` - display option

**Decision**: Use `--only <types>` for filtering.
**Rationale**:
- Distinct from existing `--tool` (display option vs filter)
- Clear semantics: "show only these types"
- Follows patterns like `git log --only`
**Alternatives considered**:
- `--filter` → less intuitive
- `--type` → could be confused with existing type flags
- `--include` → implies others might be included by default

## Summary

No NEEDS CLARIFICATION items remain. The implementation path is clear:

1. Add `MessageType` type alias: `'user' | 'assistant' | 'tool' | 'thinking' | 'error'`
2. Add `filterMessages()` function using existing detection helpers
3. Add `--only` option to show command with validation
4. Pass filter to formatter; handle empty results
5. Expose in library via `LibraryConfig.messageFilter`
