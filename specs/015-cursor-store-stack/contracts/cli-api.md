# CLI API Contract: Cursor Store Stack Support

> Corresponds to `spec.md` FR-040 / FR-041. **No new commands** — existing commands automatically cover Store stack sessions through the storage layer. This contract describes their behavior on the Store stack.

## Affected Commands

### `cursor-history list`
- **New behavior**: In addition to the Composer stack, discovers and lists Store stack sessions (`~/.cursor/chats/` + transcripts).
- **Cross-stack deduplication**: The same session ID appears only once. Composer and Store representations are merged; the runtime-preferred stack supplies canonical order and true-conflict values while non-conflicting fields and unmatched messages from both stacks are preserved.
- **Source label**: Per-session `source` field.
- **Fidelity label**: Text listings include a compact fidelity column. Transcript, workspace-fallback, and partial Store sessions are marked `partial`; complete Store DB sessions are marked `metadata` because tokens and per-message timestamps remain unavailable; merged sessions are identified separately.
- **`--workspaces`**: Store stack workspaces are grouped by their `meta.json.cwd`.

### `cursor-history show <id|index>`
- Store stack sessions: display user/assistant text in order + `tool_use` (name + input parameters).
- Missing fields (tokens / per-msg timestamps / tool results [P1]) are rendered as placeholders or omitted, without errors.
- `store.db` is the primary conversation message source; when it yields messages they are authoritative and the transcript is not used to backfill them. The transcript supplies messages only as a fallback when `store.db` is absent, unreadable, or yields no messages (store.db metadata may still contribute title/createdAt).

### `cursor-history search <query>`
- Covers Store stack session text (user/assistant content).

### `cursor-history export [id|--all]`
- Store stack sessions export to md/json, including parsed fields + `source`.

## `--data-path` Semantics
- Default: the tool scans both the Composer stack root and the Store stack root (`~/.cursor/`) simultaneously; no `--data-path` required.
- If `--data-path` points to `~/.cursor` or a subdirectory of it → Store stack resolution takes precedence.

## `--json` Output Schema Extension
- The session object may report `source: 'global' | 'workspace-fallback' | 'transcript' | 'store-complete' | 'store-partial' | 'merged'` (`'store'` remains a legacy compatibility alias).
- A merged session additionally reports `sources: ('composer' | 'store')[]` and `preferredSource: 'composer' | 'store'`.
- Store session messages: `toolCalls[].result` (missing in P1), `tokenUsage`, and `model` may be absent.
- The `list` top level may optionally include `storeStack: { discovered, degraded }` statistics.

## Exit Codes (unchanged)
- `0` success; `3` data not found / invalid.
- If neither the Composer stack nor `~/.cursor/` exists → existing "No chat history found" (exit 0 + hint).

## Backward Compatibility
- Store-stack-only users: change from "reporting empty" to "listing sessions" (Issue #31 fix).
- Composer-stack-only users: behavior unchanged (skip if `~/.cursor/` does not exist).
