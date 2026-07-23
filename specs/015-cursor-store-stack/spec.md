# Feature Specification: Cursor Store Stack Support

**Feature Branch**: `015-cursor-store-stack`
**Created**: 2026-07-11
**Status**: Draft
**Input**: Add Cursor "Store stack" support to cursor-history, fixing Issue #31 (WSL/CLI/agent users see "No chat history found" from `cursor-history list`). Factual basis is in `research.md` in the same directory.

---

## User Scenarios & Testing

### User Story 1 - Store stack users can see the session list (Priority: P1)

**Who**: Users who only use the Cursor CLI/agent (WSL, remote, headless desktops), whose sessions live under `~/.cursor/` (Store stack) rather than the traditional `workspaceStorage/` (Composer stack).

**Journey**: When running `cursor-history list`, they see their real agent session list (identifier, message count, owning workspace) instead of "No chat history found".

**Why this priority**: This is the core pain point of Issue #31 — the tool is **completely unusable** for this user group. Without resolving it, the tool has zero value for Store stack users.

**Independent Test**: In an environment that has only Store stack data and no Composer stack vscdb, running `cursor-history list` should return ≥1 session.

**Acceptance Scenarios**:
1. **Given** a machine with only `~/.cursor/chats/<hash>/<uuid>/{meta.json}` and `~/.cursor/projects/.../agent-transcripts/*.jsonl` (no `workspaceStorage/`), **When** running `cursor-history list`, **Then** list these sessions instead of reporting empty.
2. **Given** a Store stack session with real conversation, **When** running `cursor-history list`, **Then** display that session (identifier, message count, source workspace path).
3. **Given** Store stack sessions from multiple different workspaces, **When** running `cursor-history list --workspaces`, **Then** show them grouped by workspace ownership.

---

### User Story 2 - View Store stack session content (Priority: P1)

**Journey**: The user runs `cursor-history show <id>` to see the session's conversation flow: user messages, assistant replies, tool calls (tool name + input params), and can run `search` / `export`.

**Why this priority**: Listing sessions is only the first step; viewing/searching/exporting content is the core value of the tool. Together with US1 it forms the MVP, and it does not depend on the complex parsing of store.db.

**Independent Test**: `cursor-history show <store-stack-session>` outputs an ordered conversation containing the user's question, the assistant's answer, and tool calls.

**Acceptance Scenarios**:
1. **Given** a Store stack session, **When** running `show <id>`, **Then** display user/assistant messages + tool calls (name + input params) in order.
2. **Given** the same session, **When** running `search <query>`, **Then** match the text within that session.
3. **Given** the same session, **When** running `export <id>`, **Then** export markdown/json containing the parsed fields.

---

### User Story 3 - Reconstruct Store sessions from `store.db` first (Priority: P2)

**Journey**: A Store stack session's conversation is reconstructed from `store.db` (the primary message source). When `store.db` is absent, unreadable, or yields no recoverable messages, the transcript JSONL supplies the messages instead; a transcript-only session still works.

**Why this priority**: `store.db` holds the authoritative, branch-aware session state (active-root DAG, tool results keyed by `toolCallId`, full content). Transcripts are a lossy, version-dependent Agent-side export; treating them as the message backbone would drop tool results, reorder retries, and mis-pair tool calls. The transcript is therefore a fallback, not the primary source. Cross-source message-level enrichment is out of scope for this increment — it requires deterministic matching that is unsafe across branches, retries, and compaction.

**Independent Test**: A Store session with both a readable `store.db` (with messages) and a transcript uses only the `store.db` messages and title; a session whose `store.db` yields no messages falls back to the transcript (keeping `store.db` metadata); a session with no `store.db` uses the transcript; a session with neither shows an accurate empty or degraded state.

**Acceptance Scenarios**:
1. **Given** a session has a readable `store.db` (with messages) and a transcript, **When** running `show`, **Then** use the `store.db` messages as authoritative and do not merge transcript messages into them.
2. **Given** a session's `store.db` yields no messages (or is unreadable) but a transcript is available, **When** running `show`, **Then** fall back to the transcript messages while keeping any `store.db` metadata.
3. **Given** a session has only `meta.json` (`hasConversation:false`, no `store.db`), **When** running `show`, **Then** show a friendly "empty session" notice instead of crashing.

---

### User Story 4 - Mixed-stack machines neither duplicate nor lose sessions (Priority: P2)

**Journey**: If a single machine has both Composer stack (vscdb) and Store stack (chats/) sessions, the list the user sees neither duplicates nor loses sessions, and can identify which sessions have lower fidelity.

**Why this priority**: Desktop Cursor (GUI) users may have both stacks (transcript sidecars often span stacks, research §8). Deduplication errors mislead users; unclear fidelity makes users think data is lost.

**Independent Test**: On a test fixture where both stacks contain the same session ID, `list` shows that session only once, and the low-fidelity session has a clear marker.

**Acceptance Scenarios**:
1. **Given** the same session ID appears in both stacks simultaneously, **When** running `list`, **Then** it appears only once (source chosen by fidelity priority).
2. **Given** a Store stack session missing tokens/per-message time, **When** running `show`, **Then** present it with a "degraded fidelity" marker (reusing the 012 `session.source` mechanism).

---

### Edge Cases

- `~/.cursor/` does not exist at all (pure Composer stack users): behavior is consistent with the current state, no errors, no impact on existing commands.
- Transcript JSONL contains error lines (`{type:"error"}`), empty files, oversized files: skip/tolerate, do not crash.
- `meta.json` has `hasConversation:false` (session created with no messages, no `store.db`): clearly mark as an empty session or reasonably skip.
- `chats/<hash>/<uuid>/` has `meta.json` but `store.db` is corrupted/locked (WAL lock): degrade to the transcript layer, do not crash.
- `store.db` blobs are protobuf rather than JSON (encoding to be finally confirmed, research §10.1.2): the parser must be tolerant and degrade on failure.
- Cross-platform paths: Linux/macOS `~/.cursor/`, Windows `%USERPROFILE%\.cursor\`, and WSL `/mnt/...` are all covered.
- Timestamp-named temporary session directories (`projects/<13-digit-timestamp>/`, no workspace): classify as "unassociated workspace".
- Transcript text containing `[REDACTED]`: display as-is, do not attempt to restore.

---

## Requirements

### Functional Requirements

**Discovery & Paths**
- **FR-001**: The system MUST discover Store stack sessions in addition to the existing Composer stack discovery: scan `~/.cursor/chats/<hash>/<uuid>/{meta.json,store.db}` and the observed main-transcript layout `~/.cursor/projects/<sanitized>/agent-transcripts/<uuid>/<uuid>.jsonl`. The legacy flat form `agent-transcripts/<uuid>.jsonl` remains supported. Files under `<uuid>/subagents/` are separate conversations and MUST NOT be merged into the main session.
- **FR-002**: The system MUST correctly locate the `~/.cursor/` root on Linux/macOS/Windows (including WSL `/mnt/...`), and support `--data-path` override.
- **FR-003**: The system MUST identify Store workspace ownership from a reliable absolute path, preferring `meta.json.cwd`. The lossy `<sanitized>` project directory MAY be retained as provenance but MUST NOT be reverse-decoded into a guessed absolute path. When no reliable path exists, classify the session as "unassociated workspace".

**Transcript Layer Parsing (MVP / P1)**
- **FR-010**: The system MUST parse the role-nested line format of transcript JSONL and map it to the existing `Message` structure (user/assistant text + tool calls).
- **FR-011**: The system MUST map `tool_use` content (Store stack tool vocabulary: Read/Write/StrReplace/Grep/Glob/Shell/TodoWrite, etc.) to the existing `ToolCall` representation.
- **FR-012**: The system MUST tolerate error lines, empty files, and single-line parse failures (skip that line/file, do not abort the whole run).

**store.db Primary Parsing (P2)**
- **FR-020**: A present `store.db` MUST be parsed first as the PRIMARY message source (session metadata + active-root blob DAG). When it yields any messages (complete or partial), those messages are authoritative and the transcript MUST NOT participate. The transcript supplies messages only as a fallback when the DB is unreadable or yields zero messages. The system MUST NOT heuristically merge or enrich across the two sources.
- **FR-021**: When `store.db` parsing fails, yields no messages, or is missing, the system MUST preserve the session's accurate empty or degraded state (falling back to the transcript when available) and must not block other sessions.

**Unification & Deduplication**
- **FR-030**: The system MUST unify Store stack sessions into the same `ChatSession`/`Message` model as the Composer stack, and annotate the source (e.g. `source: store | transcript | composer`).
- **FR-031**: The system MUST deduplicate across stacks by session ID so the same session is not repeated. Within the Store stack, `store.db` is the primary message source and the transcript is fallback-only; Composer/Store conflict resolution follows the explicit cross-stack merge policy.
- **FR-032**: Store stack source sessions (missing token/per-message time) MUST be presented with a "degraded fidelity" marker, reusing the 012 mechanism.

**Command Coverage**
- **FR-040**: `list` / `show` / `search` / `export` MUST cover Store stack sessions as well (at least the P1 transcript layer fields).
- **FR-041**: `--only` message type filtering, `--json` output, and pagination MUST also take effect for Store stack sessions.

### Key Entities

- **Store stack session (Session)**: located at `~/.cursor/chats/<hash>/<uuid>/`; identifier = uuid; workspace = `meta.json.cwd`.
- **Transcript record (Transcript)**: `~/.cursor/projects/<sanitized>/agent-transcripts/<uuid>/<uuid>.jsonl` (plus the supported legacy flat form); role-nested lines; provides text + tool calls, missing title/tool results/time/tokens. Nested `subagents/` transcripts are not part of the main session.
- **store.db**: per-session SQLite containing session metadata tables + a content-addressed blob graph (leaves = messages, tool results joined by `toolCallId`); the PRIMARY Store message source — the transcript is used only when it is absent, unreadable, or empty (research §5, P15).
- **Source identifier (Source)**: distinguishes whether a session/message comes from the Composer stack, the Store stack store.db, or the transcript layer only — determines fidelity presentation.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Under the Issue #31 reproduction scenario (only `~/.cursor/chats/` + transcripts, no vscdb stack), `cursor-history list` returns ≥1 session and no longer reports "No chat history found".
- **SC-002**: For real Store stack transcript corpora, ≥99.9% of sessions can be fully parsed and displayed (no silent loss or crash due to format anomalies).
- **SC-003**: The `show` output of a Store stack session contains the three categories: user messages, assistant replies, and tool calls (name + input params).
- **SC-004**: On a mixed-stack machine, sessions with duplicate cross-stack session IDs appear only once in `list`.
- **SC-005**: Fields missing from Store stack sessions (tokens/per-message time) are presented with a clear marker, so users can distinguish "degraded fidelity" from complete sessions.
- **SC-006**: The four commands `list`/`show`/`search`/`export` all work correctly on Store stack sessions (P1 scope).

---

## Assumptions

- The transcript JSONL role-nested format is the stable Cursor 3.x format (research §6; hindsight naming + 191 files verified on the local machine).
- `<workspace-hash>` = MD5(cwd) holds for the legacy `chats/` variant (research §4.4, precisely verified on two WSL samples).
- The `store.db` table structure (`blobs`/`meta`) is confirmed by three sources (research §5.1); blob leaf encoding (JSON/protobuf) is an implementation-time final confirmation item and does not block the MVP (P1 does not depend on it).
- Desktop GUI Cursor mainly uses the Composer stack; the Store stack is mainly produced by CLI/agent — the two stacks may coexist (transcript sidecars span stacks).
- The read-only `~/.cursor/acp-sessions/` variant is retained as a low-priority compatibility path documented by external evidence; it is not required to satisfy the Issue #31 acceptance scenario.
- The scope of this feature is limited to **read-only** (list/show/search/export); it does not write to or migrate the Store stack (migration for the Composer stack is already covered by 003/005).

---

## Out of Scope

- Writing/migrating/deleting sessions in the Store stack (this feature is read-only).
- Auxiliary data layers such as `agentKv` / checkpoint / `ai-tracking` (research §3, not the primary session data).
- Restoring `[REDACTED]` redacted content in transcripts.
