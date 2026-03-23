# Quick Start: Fix Tool Content Truncation

**Branch**: `013-fix-tool-content-truncation`

## What this fixes

Four storage-layer truncations in `src/core/storage.ts` `formatToolCall()` that caused `Message.content` to be incomplete:

1. `read_file` legacy — 300-char cap on `result.contents` (remove slice)
2. `run_terminal_command` — 500-char cap on `result.output` (remove slice)
3. Generic tool branch — 100-char cap on string params, 500-char cap on result text (remove both)
4. `read_file_v2` — `result.contents` silently dropped (add explicit branch)
5. `edit_file_v2` — `streamingContent` param truncated at 100 chars (add explicit branch)

## Key constraint

`codeBlocks` lives on the bubble object (`data`), not inside `toolFormerData`. `formatToolCall()` only receives `toolFormerData`. The `codeBlocks` fallback for `read_file_v2` / `edit_file_v2` must therefore be passed in as a parameter or handled in `extractBubbleText()` at the call site.

## Files changed

- `src/core/storage.ts` — only file with logic changes
- `tests/unit/storage.test.ts` — new test cases

## Running tests

```bash
npm test
```

## Verifying the fix manually

```bash
npm run build
node dist/cli/index.js show <index-of-session-with-read_file_v2>
node dist/cli/index.js show <index> --fullread   # should show full file content
```
