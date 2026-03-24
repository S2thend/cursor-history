# Data Model: Fix Tool Content Truncation

**Branch**: `013-fix-tool-content-truncation`
**Date**: 2026-03-23

No new entities or schema changes are introduced by this feature. The fix operates entirely within the normalization layer that maps raw bubble data to the existing `Message` type.

---

## Affected fields (existing types, no schema changes)

### `Message.content` (string)

The only field changed by this fix. Previously truncated for four tool types; after the fix it contains full content for all affected types.

| Tool | Before | After |
|---|---|---|
| `read_file` (legacy) | `result.contents` sliced at 300 chars | `result.contents` in full |
| `run_terminal_command` | `result.output` sliced at 500 chars | `result.output` in full |
| Generic tool params | each string param sliced at 100 chars | each string param in full |
| Generic tool result | result text sliced at 500 chars | result text in full |
| `read_file_v2` | silently dropped (`result.contents` not checked) | full content via priority chain |
| `edit_file_v2` | `streamingContent` sliced at 100 chars | full content via priority chain |

### Content priority chain (new concept, not a new type)

For `read_file_v2`:
1. `toolFormerData.result` → parsed JSON → `contents` (string, non-whitespace)
2. bubble `codeBlocks[0].content` (string, non-whitespace)
3. JSON.stringify of first non-string named candidate from the above list
4. No content section if none present

For `edit_file_v2`:
1. `toolFormerData.params` / `rawArgs` → parsed → `streamingContent` (string, non-whitespace)
2. `content` param (string, non-whitespace)
3. `fileContent` param (string, non-whitespace)
4. bubble `codeBlocks[0].content` (string, non-whitespace)
5. JSON.stringify of first non-string named candidate from the above list
6. No content section if none present

### `ToolFormerData` (internal interface, no public change)

No new fields. The fix reads existing fields: `name`, `params`, `rawArgs`, `result`, `status`, `additionalData`.

### `Message.toolCalls[].result` (unchanged)

Explicitly out of scope per FR-010. Raw data is preserved as-is.

---

## Validation rules

- A candidate string is considered valid only if `typeof candidate === 'string' && candidate.trim().length > 0`
- JSON.stringify fallback: applies only when the candidate was present but not a valid string (i.e., existed but failed the type/whitespace check)
- Malformed JSON in `result` or `params`/`rawArgs`: caught by existing try/catch; diagnostic emitted via `debugLogStorage()`; extraction continues with remaining candidates
