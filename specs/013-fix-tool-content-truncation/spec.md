# Feature Specification: Fix Tool Content Truncation

**Feature Branch**: `013-fix-tool-content-truncation`
**Created**: 2026-03-23
**Status**: Draft
**Input**: Bug report #25 — `read_file_v2` / `edit_file_v2` tool content is always truncated in `Message.content`

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Access Full File Content from read_file_v2 (Priority: P1)

A developer using the library API retrieves a session that includes a `read_file_v2` tool call. They expect `Message.content` to contain the full file content that Cursor read, so they can process, search, or display it without reaching into raw internal fields.

**Why this priority**: This is the primary data-loss bug. Users inspecting what files were read during a Cursor session currently get empty content (silently dropped), making the history useless for file-content auditing and search.

**Independent Test**: Fetch any session containing a `read_file_v2` message via the library API. Verify that `message.content` contains the complete text of the file that was read, matching what is stored in the raw result data.

**Acceptance Scenarios**:

1. **Given** a session with a `read_file_v2` tool message whose result holds a non-empty file body as a string, **When** a consumer reads `message.content`, **Then** it contains the complete file text with no truncation.
2. **Given** a `read_file_v2` result where `contents` is present but is not a string (e.g., an object or array), **When** `message.content` is read, **Then** the system skips `contents` and falls back to the next content source in priority order without crashing.
3. **Given** a `read_file_v2` result where `contents` is absent but `codeBlocks[0].content` is a non-empty string, **When** `message.content` is read, **Then** `codeBlocks[0].content` is used as the full content.
4. **Given** a `read_file_v2` result where both `contents` and `codeBlocks[0].content` are absent or non-string, **When** `message.content` is read, **Then** the system falls back to `JSON.stringify` of whichever chain candidates were present but non-string (`contents`, `codeBlocks[0].content`), and returns at minimum the tool header and file path if none of the chain candidates yield usable content.
5. **Given** a `read_file_v2` result whose JSON is malformed, **When** `message.content` is read, **Then** the system still evaluates any remaining fallback candidates that do not depend on parsed `result` data, and returns at minimum the tool header and file path if none yield usable content.
6. **Given** a `read_file_v2` result with both usable primary content and a valid `diff`, **When** `message.content` is read, **Then** it renders the selected primary content first and the diff after it.
7. **Given** a `read_file_v2` result with no usable primary content but a valid `diff`, **When** `message.content` is read, **Then** the diff is still preserved in the output.

---

### User Story 2 - Access Full Edit Content from edit_file_v2 (Priority: P1)

A developer uses the library to inspect what Cursor wrote during a session via `edit_file_v2` tool calls. They expect `Message.content` to contain the full streaming edit content (the new file text), not a 100-character snippet, with the same robust fallback behavior as `read_file_v2`.

**Why this priority**: Same severity as Story 1. The streaming edit content represents the full result of a code-generation action; truncation makes it impossible to reconstruct what Cursor produced.

**Independent Test**: Fetch a session containing an `edit_file_v2` message. Verify that `message.content` contains the complete content value without any `...` truncation marker.

**Acceptance Scenarios**:

1. **Given** a session with an `edit_file_v2` tool message whose `streamingContent` parameter is a non-empty string exceeding 100 characters, **When** a consumer reads `message.content`, **Then** the full content is present and the string does not end with `...`.
2. **Given** an `edit_file_v2` message where `streamingContent` is absent, whitespace-only, or not a string, **When** `message.content` is read, **Then** the system falls back in this order: `codeBlocks[0].content`, `content`, `fileContent`, then `JSON.stringify` of the first named candidate that was present but non-string, without crashing.
3. **Given** an `edit_file_v2` tool call with a `userDecision` of `rejected`, **When** `message.content` is read, **Then** the full content is still included along with the rejection status.

---

### User Story 3 - Full Terminal Command Output (Priority: P2)

A developer reviewing terminal command history expects `Message.content` to contain the complete command output, not a 500-character preview. Long build logs, test results, or compiler errors are often longer than 500 characters and must not be cut off.

**Why this priority**: Secondary to the primary data-loss bugs but still results in incomplete data. The 500-char limit is an arbitrary storage-layer truncation that belongs only at the display layer.

**Independent Test**: Fetch a session with a `run_terminal_command` message whose output exceeds 500 characters. Verify `message.content` contains the full output.

**Acceptance Scenarios**:

1. **Given** a session with a `run_terminal_command` message whose output exceeds 500 characters, **When** a consumer reads `message.content`, **Then** the full output is present with no `...` suffix.
2. **Given** a `run_terminal_command` message with an empty output, **When** `message.content` is read, **Then** only the tool header and command are shown, without an output section.

---

### User Story 4 - Full File Content from legacy read_file (Priority: P2)

A developer retrieves sessions that used the older `read_file` tool. They expect the full file content in `Message.content`, not a 300-character preview. The fix is minimal: remove only the 300-char truncation; all other existing logic stays unchanged.

**Why this priority**: The legacy tool is less common in modern sessions but the truncation is the same class of bug. The fix is a one-line change with no behavior risk beyond the slice removal.

**Independent Test**: Fetch a session with a `read_file` message whose result `contents` exceeds 300 characters. Verify `message.content` contains the full content.

**Acceptance Scenarios**:

1. **Given** a session with a `read_file` message whose `result.contents` exceeds 300 characters, **When** `message.content` is read, **Then** the full content is present with no `...` suffix.
2. **Given** a `read_file` message with `result.contents` of exactly 300 characters or fewer, **When** `message.content` is read, **Then** behaviour is identical to before (no regression).

---

### User Story 5 - CLI Display Continues to Respect Truncation Controls (Priority: P2)

A user running `cursor-history show` from the terminal expects that `--fullread` controls how much file content is shown, and that the default view shows a manageable preview. The storage-layer fixes must not alter terminal output behavior.

**Why this priority**: Without this constraint, fixing the storage layer floods terminal output by default. Display-layer truncation controls remain the authoritative place for length decisions.

**Independent Test**: Run `cursor-history show <index>` on a session with a `read_file_v2` call. Without `--fullread`, verify the output shows a preview. With `--fullread`, verify the full content appears.

**Coverage Note**: Implementation remains scoped to `src/core/storage.ts`, but existing CLI/formatter tests should be reviewed. If there is no direct non-regression coverage for read-file preview vs `--fullread`, add targeted tests even if no CLI code changes are required.

**Acceptance Scenarios**:

1. **Given** a session with a `read_file_v2` or `read_file` message, **When** the user runs `show` without `--fullread`, **Then** the terminal shows a truncated preview (consistent with existing read-file display behavior).
2. **Given** a session with a `read_file_v2` or `read_file` message, **When** the user runs `show --fullread`, **Then** the terminal shows the complete file content.
3. **Given** a session with an `edit_file_v2` message, **When** the user runs `show`, **Then** terminal output follows the same display-level truncation rules as `read_file_v2` — the content flows through `formatToolCallDisplay()` as a `Content:` line and is subject to the same `fullTool` truncation logic.

---

### Edge Cases

- What happens when `result.contents` is a non-empty string containing only whitespace? (Treated as empty for primary-content selection — skipped to the next candidate per FR-004. A valid `diff` may still be appended or emitted on its own.)
- What happens when `streamingContent` or `result.contents` is an extremely large string (e.g., > 1 MB)?
- What happens when both `result.contents` and `codeBlocks[0].content` are present — which takes priority? (`result.contents` takes priority per FR-003.)
- What happens when both usable primary content and a valid `diff` are present in `read_file_v2`? (Render the selected primary content first, then the diff.)
- What happens when `codeBlocks` exists but `codeBlocks[0].content` is not a string? (Skip it; it becomes a candidate for the JSON.stringify fallback.)
- What happens when the JSON.stringify fallback produces a very large string? (No size cap — consistent with the general no-truncation policy. Library consumers own their memory budget.)
- What happens when `result` JSON parses successfully but none of the named chain candidates (`contents`, `codeBlocks[0].content`) are present at all? (No content section is emitted; tool header and file path are returned.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The normalization layer MUST remove the 300-character truncation from the `read_file` (legacy) tool branch. All other logic in that branch MUST remain unchanged.
- **FR-002**: The normalization layer MUST remove the 500-character truncation from the `run_terminal_command` / `run_terminal_cmd` / `execute_command` tool branch. All other logic in that branch MUST remain unchanged.
- **FR-002b**: The normalization layer MUST remove the 100-character truncation on string params and the 500-character truncation on result fields from the generic tool branch (the `else` fallback). All other logic in that branch MUST remain unchanged.
- **FR-003**: The normalization layer MUST add an explicit case for `read_file_v2`. It MUST select primary content using the following priority chain, stopping at the first successful extraction:
  1. `result.contents` — if present and a string, use it in full
  2. `codeBlocks[0].content` — if present and a string, use it in full
  3. JSON.stringify fallback — if any of the above candidates were present but not a string, `JSON.stringify` the first such non-string candidate; try in the same order (`result.contents` before `codeBlocks[0].content`)
  4. No primary content section if none of the named chain candidates were present or yielded a non-empty result
  If a valid `diff` is present in `toolFormerData.result`, the normalization layer MUST append that diff after the selected primary content. If no usable primary content is found, a valid diff MAY be emitted on its own.
- **FR-004**: If a candidate in the `read_file_v2` primary-content chain exists but is not a string, or is a string containing only whitespace, the normalization layer MUST skip it and try the next candidate — it MUST NOT throw an exception. Skipped primary content MUST NOT prevent a valid `diff` from being appended or emitted on its own.
- **FR-005**: The normalization layer MUST add an explicit case for `edit_file_v2` that extracts the full content using this priority chain, stopping at the first successful extraction: `streamingContent` (param) -> `codeBlocks[0].content` -> `content` -> `fileContent` -> JSON.stringify fallback over those same named candidates in that same order. Whitespace-only strings at any step MUST be skipped, consistent with FR-004, and no character-count truncation may be applied at the storage layer.
- **FR-006**: The normalization layer MUST continue to include the target file path in the content representation for `read_file_v2` and `edit_file_v2`, as it does for all other file-touching tools.
- **FR-007a**: For `read_file_v2`, when `toolFormerData.result` is missing or malformed JSON, the normalization layer MUST NOT throw. It MUST still evaluate any fallback candidates that do not depend on parsed `result` data, and if none yield usable content it MUST return the tool header and any recoverable file path.
- **FR-007b**: For `edit_file_v2`, when `toolFormerData.params` is missing or malformed, or when `rawArgs` is missing or malformed, the normalization layer MUST NOT throw. It MUST still evaluate remaining fallback candidates that are still available, and if none yield usable content it MUST return the tool header and any recoverable file path.
- **FR-008**: The CLI display layer MUST continue to apply its existing preview/full-content truncation logic (controlled by `--fullread`) to `read_file_v2` and `read_file` content. The storage-layer change MUST NOT alter default terminal output length.
- **FR-009**: When the normalization layer skips malformed named candidates or encounters malformed payloads in the `read_file_v2` or `edit_file_v2` extraction path, it MUST emit a storage-layer diagnostic via `debugLogStorage()`. Diagnostics MUST follow the project's existing debug-gated stderr behavior and MUST NOT be embedded into `Message.content`.
- **FR-010**: `toolCalls[].result` on the library `Message` object MUST remain unchanged — this fix targets `Message.content` only.

### Key Entities

- **Tool message**: A `Message` representing a Cursor tool invocation, identified by its `[Tool: ...]` marker. Has `toolCalls` (structured raw data) and `content` (normalized string).
- **read_file_v2 result**: JSON stored in `toolFormerData.result`; the `contents` key holds the full text of the file that was read.
- **edit_file_v2 params**: Parsed parameters for `edit_file_v2`; the `streamingContent` key holds the full text of the edit output.
- **Content priority chain**: The ordered list of candidate sources tried in sequence when extracting content for `read_file_v2` and `edit_file_v2`. For `read_file_v2`: `result.contents` → `codeBlocks[0].content` → JSON.stringify of the first non-string candidate from that same list. If a valid `diff` is present, it is appended after the selected primary content or emitted on its own if no usable primary content exists. For `edit_file_v2`: `streamingContent` (param) → `codeBlocks[0].content` → `content` → `fileContent` → JSON.stringify of the first non-string candidate from that same list. The fallback only re-visits candidates already named in the chain that were skipped due to being non-string — it does not search additional fields.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any `read_file_v2` tool message with a string `result.contents`, `message.content` length equals the length of `result.contents` — no `...` suffix present.
- **SC-002**: For any `edit_file_v2` tool message, `message.content` includes the full content from the first usable source in the agreed chain (`streamingContent` -> `codeBlocks[0].content` -> `content` -> `fileContent` -> JSON.stringify fallback) with no `...` suffix present.
- **SC-003**: For any `run_terminal_command` tool message with output longer than 500 characters, `message.content` contains the complete output — no `...` suffix present.
- **SC-004**: For any `read_file` (legacy) tool message with `result.contents` longer than 300 characters, `message.content` contains the complete content — no `...` suffix present.
- **SC-005**: Zero regressions in existing tool-call formatting for named tools: `message.content` for `list_dir`, `grep`, `edit_file`, `search_replace`, `create_file`, and `write_file` is byte-for-byte identical before and after the change. Generic tools now emit full param values and full result fields (no truncation).
- **SC-006**: CLI `show` output for `read_file_v2` and `read_file` messages without `--fullread` shows a preview, not the full content (display-layer truncation remains in effect).
- **SC-007**: No new unhandled exceptions when processing malformed, missing, or non-string content fields for any of the four affected tool types.
- **SC-008**: When `DEBUG` or `CURSOR_HISTORY_DEBUG` is enabled, malformed `read_file_v2` or `edit_file_v2` content candidates produce a `[cursor-history:storage]` diagnostic on stderr while message extraction continues.

## Assumptions

- `read_file_v2` stores file content in `result.contents` as a string. If a schema variant uses a different key, that is a separate investigation.
- `edit_file_v2` stores edit output primarily in the `streamingContent` parameter key. `content` and `fileContent` are lower-priority fallback candidates rather than confirmed primary schema fields.
- The content priority chain (FR-003 / FR-005) applies to `read_file_v2` and `edit_file_v2` only. Legacy `read_file` keeps its existing logic with only the truncation slice removed (FR-001).
- `edit_file_v2` produces large unstructured text (not a diff), so it should be formatted similarly to file-content display, not as a diff block.
- Display-layer truncation for `read_file_v2` should follow the same default preview behavior as `read_file` (currently 100-char default in `formatToolCallDisplay`), since both represent file-read output.
- This fix is scoped to `Message.content` normalization only. `toolCalls[].result`, token usage, and timestamp extraction are out of scope.

## Clarifications

### Session 2026-03-23

- Q: What is the scope of the JSON.stringify fallback — does it search broadly across all fields, or only fields already named in the priority chain? → A: The fallback only re-visits candidates already named in the priority chain that were skipped because they were non-string. It does not scan any additional fields. For `read_file_v2` the candidates are `result.contents` and `codeBlocks[0].content`; for `edit_file_v2` the candidates are `streamingContent` (param), `codeBlocks[0].content`, `content`, and `fileContent`.
- Q: Should the generic tool branch truncation (100-char params, 500-char result) be removed as part of this fix? → A: Yes — remove both truncations from the generic branch, same as the named tools.
- Q: Should whitespace-only strings in the priority chain be treated as empty and skipped, or preserved as-is? → A: Treat whitespace-only as empty — skip to next candidate (consistent with how terminal output is already trimmed before emptiness check).
- Q: Should `read_file_v2` preserve `diff` content as part of `Message.content`? → A: Yes. A valid `diff` is appended after the selected primary content; if no usable primary content exists, the valid diff may still be emitted on its own.
- Q: Should `edit_file_v2` look at `content` and `fileContent` too? → A: Yes, but only after the existing higher-priority chain `streamingContent` -> `codeBlocks[0].content`.
- Q: What is the warning mechanism for malformed candidates in this storage-layer fix? → A: Follow the project's existing storage-layer convention: use `debugLogStorage()` so diagnostics go to debug-gated stderr, not into `Message.content`.
- Q: How should malformed `edit_file_v2` payloads be described in requirements? → A: Refer to malformed or missing `params` / `rawArgs`, not malformed `result` JSON, because `edit_file_v2` content extraction is param-based.

## Root Cause Clarifications (confirmed against codebase)

- The normalization layer has a dedicated branch for `read_file` (legacy). `read_file_v2` and `edit_file_v2` fall through to the generic formatter, which truncates string params at 100 chars and checks only `output|result|content|text` in the result — missing `contents`.
- A late fallback in `extractBubbleText()` can return `result.contents`, but for tool bubbles with `toolFormerData.name` set the function returns early from `formatToolCall()` — that fallback is unreachable for these cases.
- `--fullread` / `--tool` CLI flags only affect display-layer truncation in `formatToolCallDisplay()`. They cannot recover content already dropped or truncated during storage-layer extraction.
- The fix belongs in `formatToolCall()` in the normalization layer, not in the display layer.
