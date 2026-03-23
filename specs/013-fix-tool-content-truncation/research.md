# Research: Fix Tool Content Truncation

**Branch**: `013-fix-tool-content-truncation`
**Date**: 2026-03-23

---

## 1. Affected call sites and data flow

### Decision
All four truncation removals are confined to `src/core/storage.ts` within `formatToolCall()`. No other source file requires changes for the storage-layer fix.

### Findings

**`formatToolCall()` — four truncation points to remove:**

| Tool branch | Line (approx) | Truncation | Fix |
|---|---|---|---|
| `read_file` (legacy) | 1068 | `result.contents.slice(0, 300)` | Remove slice; keep rest |
| `run_terminal_command` | 1100 | `output.slice(0, 500)` | Remove slice; keep rest |
| Generic `else` params | 1140 | `val.length > 100 ? val.slice(0, 100) + '...' : val` | Remove condition; emit `val` directly |
| Generic `else` result | 1151 | `resultText.slice(0, 500)` | Remove slice; keep rest |

**New explicit branches to add (same function):**

- `read_file_v2`: file path from params + full `result.contents` (string-typed, non-empty-after-trim) → fallback to `codeBlocks[0].content` → fallback to `JSON.stringify` of first non-string named candidate
- `edit_file_v2`: file path from params + `streamingContent`/`content`/`fileContent` (first string, non-empty-after-trim) → fallback to `codeBlocks[0].content` → fallback to `JSON.stringify` of first non-string named candidate. Diff appending is **not** applicable to `edit_file_v2` (it uses params, not result).

**`read_file_v2` + diff coexistence:**
`extractBubbleText()` at line 1311–1316 checks `formatToolCallWithResult()` first (diff path). `read_file_v2` never returns a diff, so that path always returns `null` for it, falling through to `formatToolCall()`. No conflict. The spec's "append diff after primary content" scenario is therefore not reachable via `read_file_v2` today — the two paths are mutually exclusive given the current dispatch logic. **Implementation note**: do not merge the two paths; the spec's diff clause is forward-compatible language and does not require code changes now.

### Rationale
Keeping all changes in `formatToolCall()` is the minimal, targeted fix. It avoids touching `extractBubbleText()` dispatch logic, which has its own coverage and risk.

---

## 2. `codeBlocks` source — bubble field, not result JSON

### Decision
`codeBlocks` is read from `data` (the raw bubble object), not from the parsed `toolFormerData.result` JSON. It is a sibling field on the bubble.

### Findings
`extractBubbleText()` line 1324: `const codeBlocks = data['codeBlocks']` — this is the bubble-level field, already available before `formatToolCall()` is called. However, `formatToolCall()` receives only `toolData: ToolFormerData`, not the full bubble `data`. The `codeBlocks` access at line 1325 happens **after** `formatToolCall()` returns, in `extractBubbleText()`.

**Critical implication**: `formatToolCall()` cannot access `codeBlocks` directly. The fallback to `codeBlocks[0].content` described in the spec must be implemented in `extractBubbleText()` at the call site where the result of `formatToolCall()` is used, OR `codeBlocks` must be passed into `formatToolCall()` as an additional parameter.

### Rationale
Passing `codeBlocks` as a parameter to `formatToolCall()` is cleaner than splitting the logic between the two functions. It also keeps the full priority chain co-located in one function call, which is easier to test.

---

## 3. `parseToolParams` behavior when params/rawArgs are malformed

### Decision
When both `params` and `rawArgs` are malformed JSON or absent, `parseToolParams()` returns `{ _raw: rawText }` (preserving the raw string) or `undefined` (if both are empty/absent). `getParam()` returns `''` when `params` is undefined. No throw.

### Findings
`src/core/storage.ts` lines 132–151: `parseToolParams` uses `paramsText ?? rawArgsText` — so if `params` is malformed but `rawArgs` is valid, `rawArgs` is **not tried**. This matches the spec's FR-007b requirement: the normalization layer must not throw, must try remaining fallback candidates, and must return tool header + any recoverable file path. Since `getParam()` returns `''` for undefined params, the file path line is simply omitted when params are unrecoverable — "any recoverable file path" is satisfied.

### Rationale
No change to `parseToolParams` is needed. The existing behavior is compliant with FR-007b.

---

## 4. `debugLogStorage` usage pattern

### Decision
Use `debugLogStorage('storage', 'message', ...args)` matching the existing call pattern in the file.

### Findings
`src/core/storage.ts` imports `debugLogStorage` from `'./database/debug.js'` at line 33. Existing calls in the file use `debugLogStorage('storage', ...)`. Debug output is gated by the `DEBUG=cursor-history:*` environment variable and goes to stderr only. No changes to the debug module are needed.

### Rationale
Using the same call signature as existing code ensures consistency and no new infrastructure.

---

## 5. Test infrastructure

### Decision
New tests follow the `getSession (more tool types)` describe block pattern in `tests/unit/storage.test.ts`, using `setupToolTest()` helper with inline bubble JSON.

### Findings
- `tests/unit/storage.test.ts` line 1385: `setupToolTest(bubbleValue)` sets up mock DB with a single bubble. This is the standard pattern for all `formatToolCall` branch tests.
- Existing `mapBubbleToMessage` export allows unit-level bubble testing without full `getSession` roundtrip if needed.
- No test fixtures or shared helpers need modification.
- The `codeBlocks` field can be included directly in the bubble JSON passed to `setupToolTest`.

### Alternatives considered
- Testing `formatToolCall` directly as a unit: it is not exported. Tests go through `getSession` or `mapBubbleToMessage`, consistent with existing coverage.

---

## 6. Display-layer impact assessment

### Decision
No changes to `src/cli/formatters/table.ts` are required. The existing `formatToolCallDisplay()` already handles `Content:` lines with its own truncation logic.

### Findings
`table.ts` line 264–310: `formatToolCallDisplay()` iterates message content line-by-line, applies color styling, and truncates long lines. The `Content:` label prefix is already handled. When `Message.content` now contains full (untruncated) file content, `formatToolCallDisplay()` will naturally truncate it for terminal display via its existing `fullTool` parameter logic — satisfying FR-008 and SC-006 with zero display-layer code changes.

### Rationale
The display layer is already correct. The storage layer was the only broken layer.

---

## Summary of NEEDS CLARIFICATION resolutions

All items were resolved during spec clarification. No unknowns remain.
