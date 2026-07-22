# PR #32 Incremental Update: Solutions

**Feature:** `015-cursor-store-stack`
**Baseline:** PR #32, commit `bf7d91f`
**Created:** 2026-07-15
**Updated:** 2026-07-20
**Status:** Implemented and verified locally (pending commit)

## Purpose

This document records accepted solutions for the problems in [`problems.md`](./problems.md). A problem is added here only after its direction has been discussed and accepted. Each section moves through `Accepted`, `Implemented`, and `Verified` as work progresses.

## P01 — Merge Composer and Store representations without silent loss & P02 — Preserve every rendered message

**Status:** Implemented and verified in commit `cb65226`

### Decision

Sessions with different IDs remain independent. Sessions with the same ID are treated as two representations of the same logical conversation and are merged field by field instead of selecting one complete object and discarding the other.

The merge follows three rules:

1. If only one source provides a value, keep that value.
2. If both sources provide equivalent values, keep one value and record both sources.
3. If both sources provide different values, apply the conflict priority for the current runtime environment.

### Conflict priority

| Runtime environment | Preferred source for a true conflict |
|---|---|
| WSL | Store |
| Windows | Composer |
| macOS | Composer |
| Native Linux | No new platform override; preserve the current default Composer-first resolution order |

An explicit CLI path or environment configuration that clearly selects one storage tree takes precedence over platform inference. If only one source exists, that source is used directly.

WSL must be detected separately from native Linux. The current `detectPlatform()` function groups both environments under `linux`, so runtime detection must be extended before the platform priority is applied.

### Session-field merge

Scalar metadata such as title, workspace path, creation time, and update time is filled from either source when the other side is missing it. A true scalar conflict is resolved by the platform priority above.

Source-specific information is additive and must not be removed merely because the preferred source lacks it. Examples include Composer token/model data and Store structured tool-call data.

### Message merge

Message order and message time are separate concerns. The canonical order comes from the source's own ordered structure and must not be reconstructed by sorting timestamps:

- Composer uses its active branch / ordered bubble representation.
- Store uses the ordered `latestRoot` message references and ordered turn structure from `store.db`; transcript-only fallback preserves JSONL line order.

Modern Composer bubble records provide a native per-bubble `createdAt` value. Older Composer records may expose lifecycle timing fields or may require interpolation. Store protobuf can expose recorded conversation- or turn-level timing fields, but those fields are not guaranteed to be populated and must only be attached to a message when their semantic mapping is proven.

The merged message model therefore treats a per-message timestamp as optional. A timestamp is assigned only when it is directly stored and can be mapped to that message or turn. Session-level `createdAt`, `updatedAt`, or `conversation_started_timestamp_ms` values must not be copied onto every message. Missing message timestamps remain absent and are omitted from display and export rather than replaced with a fabricated fallback.

When a timestamp is retained, its origin is recorded so a directly stored timestamp cannot be confused with an inferred value:

```ts
timestamp?: Date;
timestampSource?: 'composer-created-at' | 'composer-timing' | 'store-turn-timing';
```

Timestamp comparison is auxiliary only. It is never the sole message identity rule and never overrides the source-native sequence.

The preferred source supplies the backbone message order. The two ordered message sequences are aligned using stable content signals:

- message role;
- normalized text content;
- tool name and normalized tool parameters;
- relative position in the conversation.

Matched messages are merged field by field. Missing fields are filled from the other representation. Unmatched messages from either source are preserved in the relative position implied by surrounding matched messages.

The role/content/tool signature is used only for P01 cross-stack alignment. It is not a general instruction to deduplicate messages after loading or merging.

### P02 default display behavior

Human-readable CLI output preserves every message produced by the resolved session and renders the messages once in their canonical array order. Consecutive duplicate folding is removed from the default `show` path.

The renderer does not collapse messages based on role, content, timestamp, tool calls, or any other equality signature. Two messages remain two displayed events even when all currently visible fields are identical. This prevents the presentation layer from hiding meaningful differences in structured tool calls, model data, token usage, duration, provenance, or fields added in later versions.

Filtering such as `show --only tool` selects messages by type and then renders every selected message without a second deduplication pass. JSON output and export continue to preserve the resolved message sequence.

No replacement collapse flag is added in this increment. An explicit opt-in presentation feature may be considered later, but it must not participate in P01 merge correctness and must never modify the underlying resolved session.

### Provenance

A merged session must be distinguishable from a single-source session. The target provenance contract is:

```ts
{
  source: 'merged',
  sources: ['composer', 'store'],
  preferredSource: 'composer' | 'store'
}
```

Messages produced by the merge carry an optional origin marker:

```ts
source: 'composer' | 'store' | 'both'
```

This provenance is additive. Existing single-source values such as `global`, `workspace-fallback`, `transcript`, `store-complete`, and `store-partial` remain valid.

### Expected behavior

- Windows and macOS keep Composer as the backbone and use Store data to fill non-conflicting gaps.
- WSL keeps Store as the backbone and uses Composer data to fill non-conflicting gaps.
- Native Linux receives no new special override and keeps the current default conflict order.
- A lower-priority source is never discarded before its non-conflicting fields and unmatched messages have been considered.
- The final session records that both sources participated and which source won true conflicts.
- Message order follows the selected source's stored sequence, not timestamp sorting.
- Directly stored message or turn times are displayed when available; missing times are omitted.
- Session creation, update, and conversation-start times remain session-level metadata and are not presented as per-message times.
- Human-readable output renders every resolved message and never folds consecutive duplicates by default.
- Distinct structured tool-call messages remain visible in both normal output and `--only tool` output, including when their text content is empty.

### Related problem boundaries

- **P04 can be implemented in the same data-model pass but remains distinct.** P04 preserves the session-level `updatedAtMs` value and uses `createdAtMs` only when no update time exists. It does not provide a missing per-message timestamp and must not affect message order.
- **P03 consumes the P01 result but remains distinct.** Export must preserve the merged workspace and provenance fields after cross-stack resolution instead of independently resolving Composer-only metadata.

### Minimal verification

- Same ID and equivalent content produces one session marked as merged.
- On WSL, a true conflict selects Store while preserving unique Composer fields.
- On Windows/macOS, a true conflict selects Composer while preserving unique Store fields.
- Distinct messages and tool calls from either source remain present after the merge.
- Messages remain in source-native order when timestamps are missing, equal, or non-monotonic.
- A directly stored Composer message time or mapped Store turn time is retained with its source.
- A message without a directly mapped time has no rendered/exported timestamp.
- Store session creation, update, and conversation-start timestamps are not duplicated onto every message.
- Empty-text assistant messages with different structured tool calls are treated as distinct.
- Consecutive messages with identical role and content are each rendered separately and no default `×N` folding marker is produced.
- `--only tool` preserves and renders every matching structured tool-call message in source-native order.

## P03 — Export the resolved session without re-resolving metadata

**Status:** Implemented and verified locally (pending commit)

Export uses the already resolved `ChatSession` as its authoritative input. It must not independently choose between Composer and Store metadata.

- Resolve the export workspace as `Composer workspace path ?? session.workspacePath`.
- Make `exportToJson()` and `exportToMarkdown()` fall back to `session.workspacePath` when no explicit workspace path is supplied.
- Preserve `source`, `sources`, and `preferredSource` in JSON.
- Include a readable source line in Markdown for both merged and single-source Store sessions.
- Apply the same behavior to single export, export-all, and library exports.

This completes export consistency without creating a second cross-stack conflict policy.

## P04 — Preserve Store update time as session metadata

**Status:** Implemented and verified locally (pending commit)

`StoreSession` gains `lastUpdatedAt`. For chat metadata, use a valid `updatedAtMs`; otherwise use `createdAt`. ACP or transcript-only sessions use their best session-level filesystem time and fall back to `createdAt`.

When multiple Store metadata locations contribute to one session, retain the latest valid update time. `mapStoreSession()`, list summaries, cross-stack summary merge, JSON output, Markdown output, and library conversion all use this field. It remains session metadata and is never copied onto messages.

## P05 — Separate transcript state from Store DB completeness

**Status:** Implemented and verified locally (pending commit)

Transcript parsing returns both messages and an explicit state:

```ts
type TranscriptState =
  | 'missing'
  | 'parsed'
  | 'partial'
  | 'empty'
  | 'error-only'
  | 'unsupported'
  | 'unreadable';
```

`StoreSession` records `transcriptState` separately from Store DB `completeness`.

- `parsed`: transcript messages remain authoritative.
- `partial`: usable messages coexist with malformed or unsupported lines; those usable transcript messages remain authoritative and the partial state stays visible as provenance.
- Only transcript states with no usable messages may use `store.db` as an explicit fallback, while retaining the transcript state for provenance.
- A valid `system` Store DB leaf is intentionally ignored and does not make the database partial.
- Missing blobs, malformed leaves, and unmatched tool results remain partial.
- If no fallback succeeds, the session remains visible with its accurate empty/degraded state.

Message count is no longer used as a proxy for transcript presence.

## P06 — Build workspaces from the resolved session set

**Status:** Implemented and verified locally (pending commit)

`list --workspaces` aggregates the same deduplicated summaries returned by `listSessions({ all: true })`.

- Group by normalized final `workspacePath` after cross-stack resolution.
- Count a merged session once.
- Preserve existing Composer workspace metadata when available.
- Create a stable Store workspace identity for Store-only paths.
- Keep transcript-only sessions without a path in one explicit unknown workspace bucket.
- The CLI preflight succeeds when either the Composer root or the resolved Store root exists.

No separate Composer-only workspace discovery result is allowed to define user-visible workspace counts.

## P07 — Normalize every supported Store path through one resolver

**Status:** Implemented and verified locally (pending commit)

Introduce one Store-root resolver used by discovery and conflict-priority detection.

Resolution order:

1. Explicit CLI data path when it identifies a Store tree.
2. `CURSOR_DATA_PATH` when it identifies a Store tree.
3. `CURSOR_STORE_ROOT`.
4. Default `~/.cursor`.

The resolver accepts the Store root itself and descendants under `chats`, `projects`, or `acp-sessions`, then normalizes them back to the Store root. A Composer `workspaceStorage` path does not hide an independently configured or default Store root.

## P08 — Use one complete structured-tool representation

**Status:** Implemented and verified locally (pending commit)

Add shared structured-tool serialization/formatting helpers and use them from human-readable output, CLI JSON, and export JSON.

- Normal `show` remains concise and may truncate long parameters.
- `show --tool` renders full parameters, status, result, error, and files.
- JSON preserves every defined `ToolCall` field.
- Markdown renders structured calls once.
- When embedded Composer `[Tool: ...]` content already represents a call, Markdown does not append the same structured call again.

This work does not change message order or perform message deduplication.

## P09 — Parse Store DB through the shared SQLite registry

**Status:** Implemented and verified locally (pending commit)

Remove the direct `node:sqlite` dependency from `store-db.ts`.

`parseStoreDb()` becomes asynchronous and performs this flow:

1. Create a temporary destination path.
2. Use `backupDatabase(source, destination)` for a WAL-consistent snapshot.
3. Open the snapshot with `openDatabase(destination)`.
4. Parse through the shared `Database` interface.
5. Close the database and remove the temporary snapshot in `finally`.

This makes Node 20 use the available `better-sqlite3` fallback and respects `CURSOR_HISTORY_SQLITE_DRIVER`. Store discovery and its callers become asynchronous as required; no parallel duplicate parsing of the same Store root is introduced.

## P10 — Isolate filesystem failures per Store directory

**Status:** Implemented and verified locally (pending commit)

All Store directory enumeration uses safe helpers that catch errors at the narrowest directory boundary, write a debug diagnostic through `debugLogStorage`, and continue with sibling directories.

An unreadable or concurrently removed `agent-transcripts` directory skips only that directory. Valid Store projects and all Composer results remain available.

## P11 — Reuse one Store discovery result per top-level operation

**Status:** Implemented and verified locally (pending commit)

Add an operation-scoped `SessionReadContext` in the core storage layer. It holds the Store sessions discovered for the operation and, when relevant, the already listed summaries.

- `listSessions()` and `getSession()` accept an optional internal context.
- Direct public calls create a context automatically, preserving current signatures for callers.
- Search, CLI export-all, library listing, and library export-all create one context and reuse it for every resolved session.
- Per-session resolution uses the known summary and cached Store session instead of calling `listSessions()` and `discoverStoreSessions()` again.
- Use session IDs inside loops rather than re-resolving mutable list indexes.

The required result is one Store corpus discovery per top-level operation. Composer database reads may remain per session in this increment.

## Implementation Chain

The remaining work is intentionally grouped by shared files and dependency direction:

1. **Path and discovery safety:** P07 + P10.
2. **Store data foundation:** P09 + P05 + P04.
3. **Operation-scoped resolution:** P11 + P06.
4. **Resolved export:** P03.
5. **Tool output completeness:** P08.

P09 precedes P11 so the context is designed around the final asynchronous Store discovery API. P05 and P04 are completed in the same Store model pass. P03 consumes the final resolved session and therefore follows P01, P06, and P11.

### P12 — Decode modern Store tool records

**Status:** Implemented and verified against the reporting WSL session (pending commit).

The Store DB reader now supports both legacy plain-JSON leaves and current protobuf assistant nodes whose field 4 contains the message JSON. It recognizes `tool-call` blocks, preserves their arguments, indexes standalone `tool-result` blobs, and joins results strictly by `toolCallId`. A keyed result leaf consumed by a matching call is not classified as an orphan; unkeyed or unmatched results remain unattached and keep the database partial.

### P13 — Keep Store DB as a fallback-only source

**Status:** Implemented and verified locally (pending commit)

Transcript messages remain authoritative whenever parsing yields usable messages. `store.db` is consulted only when no usable transcript messages are available. The feature spec, data model, and README will be aligned with that behavior; transcript and Store messages will not be heuristically merged or enriched.

### P14 — Use category membership for message filtering

**Status:** Implemented and verified locally (pending commit)

Display formatting may retain one primary label, but filter matching becomes multi-category. A natural-language assistant response with structured tool calls matches both `assistant` and `tool`; a tool-only marker or structured tool-only message matches only `tool`. Existing user, thinking, and error behavior remains unchanged.

## Solution Status

| Problem | Solution status |
|---|---|
| P01–P02 | Implemented and verified (`cb65226`) |
| P03–P11 | Implemented and verified locally (pending commit) — Windows, Node 20 fallback, and isolated WSL gates are recorded in `tasks.md`; the five former Windows path failures are fixed |
| P12 | Implemented and verified on the reporting WSL Store session: `Grep` params/result/files render, both SQLite drivers pass, and Store completeness is `complete` |
| P13–P14 | Implemented and verified locally (pending commit) |

Hybrid end-to-end coverage now uses an actual temporary Composer `globalStorage/state.vscdb` together with the checked-in Store transcript fixture. Matching strips an enclosing Store `<user_query>` transport wrapper and treats a Composer `[Tool: ...]` display marker as equivalent to the same structured Store tool turn, preserving the Store natural-language text while retaining Composer metadata.
