# Implementation Plan: Fix Tool Content Truncation

**Branch**: `013-fix-tool-content-truncation` | **Date**: 2026-03-23 | **Spec**: [spec.md](spec.md)

## Summary

Remove five storage-layer truncations in `formatToolCall()` that cause `Message.content` to be incomplete, and add two explicit branches for `read_file_v2` and `edit_file_v2` with robust priority-chain content extraction. All changes are in `src/core/storage.ts`. No public API, type, or display-layer changes are needed.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode)
**Primary Dependencies**: Node.js built-in only; no new deps
**Storage**: N/A (read-only access to existing SQLite; no schema changes)
**Testing**: Vitest — unit tests in `tests/unit/storage.test.ts`
**Target Platform**: Node.js 20 LTS+
**Project Type**: Single project (CLI + library sharing `src/core/`)
**Performance Goals**: No throughput target; strings are never truncated at storage layer regardless of size
**Constraints**: No public API breakage; `Message.toolCalls[].result` unchanged; display-layer behavior unchanged by default
**Scale/Scope**: Single function (`formatToolCall`) in one file; two new branches + four one-line removals

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Simplicity First | ✅ Pass | Minimal change: remove slices, add two branches in one function. No new abstractions. |
| II. CLI-Native Design | ✅ Pass | No CLI interface changes. stdout/stderr contract preserved. |
| III. Documentation-Driven | ✅ Pass | CLAUDE.md and CHANGELOG update required at PR time. |
| IV. Incremental Delivery | ✅ Pass | Each of the four fix types is independently testable and releasable. |
| V. Defensive Parsing | ✅ Pass | Priority chain skips malformed/non-string candidates; `debugLogStorage()` on failures; no throw. |

No gate violations. Complexity Tracking table not required.

## Project Structure

### Documentation (this feature)

```text
specs/013-fix-tool-content-truncation/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── quickstart.md        ← Phase 1 output
└── tasks.md             ← Phase 2 output (/speckit.tasks)
```

### Source Code (affected files only)

```text
src/
└── core/
    └── storage.ts       ← all logic changes (formatToolCall function)

tests/
└── unit/
    └── storage.test.ts  ← new test cases in existing describe block
```

**Structure Decision**: Single project, no new files, no structural changes.

## Phase 0: Research — Complete

See [research.md](research.md). All questions resolved:

| Question | Resolution |
|---|---|
| Where is `codeBlocks` sourced from? | Bubble object (`data`), not `toolFormerData`. Must be passed into `formatToolCall()` or handled in `extractBubbleText()` at call site. |
| Does `read_file_v2` ever produce a diff? | No. `formatToolCallWithResult()` handles diffs exclusively; `read_file_v2` never matches that path. Diff coexistence clause in spec is forward-compatible; no code change needed now. |
| Does `parseToolParams` try `rawArgs` when `params` is malformed? | No — it uses `paramsText ?? rawArgsText` (first non-null). If `params` is malformed JSON, `rawArgs` is not tried. FR-007b is still satisfied: no throw, tool header + any recoverable path returned. |
| How is `debugLogStorage` called? | `debugLogStorage('storage', message, ...args)`. Import already present. |
| Does display layer need changes? | No. `formatToolCallDisplay()` already truncates for terminal via `fullTool` flag. |

## Phase 1: Design

### A. `formatToolCall()` signature change

To implement the `codeBlocks` fallback for `read_file_v2` and `edit_file_v2`, `formatToolCall()` needs access to the bubble-level `codeBlocks` field. Two options:

**Option A** (chosen): Add an optional `codeBlocks?: Array<{ content?: unknown }>` parameter to `formatToolCall()`. Default to `undefined`. Only used in `read_file_v2` and `edit_file_v2` branches.

**Option B** (rejected): Handle `codeBlocks` in `extractBubbleText()` after `formatToolCall()` returns. Rejected because it splits the priority chain across two functions, making it harder to test and reason about.

The existing `codeBlocks` extraction at line 1324–1329 of `extractBubbleText()` (the 200-char truncated version for all tool types) will be **removed** for `read_file_v2` and `edit_file_v2` since those branches now handle it internally. The generic fallback at line 1324–1329 remains for all other named tool types.

### B. Content extraction helpers (inline, no new exported functions)

Two private helpers within `formatToolCall()` logic:

**`pickStringContent(candidates: Array<{ label: string; value: unknown }>)`** — inline logic (not a separate function, to keep simplicity):
- Iterate candidates in order
- For each: if `typeof value === 'string' && value.trim().length > 0` → return `{ text: value, usedLabel: label }`
- If `typeof value !== 'string'` and value is not `undefined`/`null` → record as JSON.stringify candidate
- After loop: if no string found but a stringify candidate exists → return `{ text: JSON.stringify(firstNonStringCandidate), usedLabel: label }`
- Otherwise → return `null`

### C. `read_file_v2` branch design

```
[Tool: Read File v2]
File: <path from params: targetFile | path | file | effectiveUri>
Content: <full content from priority chain>
Status: <emoji> <status>
User Decision: <emoji> <decision>   (if present)
```

Priority chain for content:
1. Parse `toolData.result` JSON → `result.contents` (string, trimmed non-empty)
2. `codeBlocks?.[0]?.content` (string, trimmed non-empty)
3. JSON.stringify of first non-string candidate encountered above
4. No `Content:` line if nothing found

On `toolData.result` parse failure: log `debugLogStorage('storage', 'read_file_v2: failed to parse result JSON', e)`. Continue with `codeBlocks` fallback.

### D. `edit_file_v2` branch design

```
[Tool: Edit File v2]
File: <path from params: targetFile | path | file | relativeWorkspacePath>
Content: <full content from priority chain>
Status: <emoji> <status>
User Decision: <emoji> <decision>   (if present)
```

Priority chain for content (all from parsed params):
1. `streamingContent` (string, trimmed non-empty)
2. `codeBlocks?.[0]?.content` (string, trimmed non-empty)
3. `content` (string, trimmed non-empty)
4. `fileContent` (string, trimmed non-empty)
5. JSON.stringify of first non-string named candidate encountered above
6. No `Content:` line if nothing found

On `parseToolParams` returning `{ _raw: ... }` sentinel: log `debugLogStorage('storage', 'edit_file_v2: params/rawArgs could not be parsed as object', ...)`. Continue; no Content line.

### E. Truncation removals (surgical)

| Location | Change |
|---|---|
| `read_file` branch ~L1068 | `result.contents.slice(0, 300).replace(/\n/g, '\\n')` → `result.contents` (remove both the slice **and** the `.replace(/\n/g, '\\n')` — it was a display hack tied to the preview; real newlines are correct for library API and `formatToolCallDisplay()` already handles them) |
| `run_terminal_command` branch ~L1100 | `output.slice(0, 500)` → `output`; remove `output.length > 500 ? '...' : ''` |
| Generic `else` params ~L1140 | `val.length > 100 ? val.slice(0, 100) + '...' : val` → `val` |
| Generic `else` result ~L1151–1152 | `resultText.slice(0, 500)` → `resultText`; remove ternary suffix |

Note on `read_file` `replace(/\n/g, '\\n')`: This replacement was a display hack tied to the 300-char preview — it compressed multiline content onto one visual line. It is removed alongside the slice. Real newlines are correct for the library API; `formatToolCallDisplay()` already iterates content line-by-line and handles them correctly.

### F. Test plan

> **Note**: `tasks.md` is the authoritative and complete test list. This section is a design reference only — it may not reflect additions made during clarification (debugLogStorage assertion, generic result field test, diff-append tests).

New test cases in `tests/unit/storage.test.ts`, in the existing `describe('getSession (more tool types)')` block using `setupToolTest()`:

1. **`read_file_v2` — full `result.contents`**: result JSON with `contents` > 300 chars → `message.content` contains full string, no `...`
2. **`read_file_v2` — `codeBlocks` fallback**: result JSON missing `contents`; bubble has `codeBlocks[0].content` → used in full
3. **`read_file_v2` — JSON.stringify fallback**: result JSON has `contents` as non-string (e.g., object) → `JSON.stringify` of that object in content
4. **`read_file_v2` — malformed result JSON**: `toolData.result = '{'` → no throw; returns tool header + file path
5. **`read_file_v2` — whitespace-only contents**: `contents: '   '` → skipped; codeBlocks fallback used
6. **`edit_file_v2` — full `streamingContent`**: param > 100 chars → full in content, no `...`
7. **`edit_file_v2` — `content` param fallback**: no `streamingContent`; `content` param present → used
8. **`edit_file_v2` — `codeBlocks` fallback**: no string params; `codeBlocks[0].content` present → used
9. **`edit_file_v2` — malformed params**: `params = '{'`; `rawArgs` absent → no throw; returns tool header
10. **`run_terminal_command` — output > 500 chars**: full output in content, no `...`
11. **`read_file` legacy — `result.contents` > 300 chars**: full content, no `...`
12. **Generic tool — string param > 100 chars**: full param value, no `...`
13. **Non-regression — `list_dir`**: content identical to pre-fix (path only, no truncation was applied before)
14. **Non-regression — `edit_file`**: `oldString`/`newString` still truncated at 100 (those truncations are intentional and remain — see note below)

**Note on `edit_file` old/new string truncation**: The spec does not include `edit_file` (legacy, non-v2) in the truncation removals. The 100-char truncation on `oldString`/`newString` in the `edit_file` branch is intentional — these are search-replace strings, not file content, and truncating them in the display is acceptable. They are **not** in scope for this fix.

## Contracts

No API contracts to generate — this is a pure internal normalization fix with no new public endpoints, exports, or protocol changes.

## Agent context

Run after plan approval:
```bash
bash .specify/scripts/bash/update-agent-context.sh claude
```
