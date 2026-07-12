# 015 — Cursor Store Stack Support · Research Report

> Related Issue: https://github.com/S2thend/cursor-history/issues/31
> Date: 2026-07-11
> Status: Research complete (primary evidence + external multi-source + adversarial verification)

---

## 1. Background & Goals

Issue #31: A WSL2 user runs `cursor-history list` and gets `No chat history found.`, yet the disk holds 110 `~/.cursor/chats/**/store.db` + 109 `~/.cursor/projects/**/agent-transcripts/*.jsonl`.

Root cause (located in prior root-cause analysis and confirmed by 4 adversarial-verification agents): **cursor-history only supports Cursor's legacy "Composer stack" (`workspaceStorage/*/state.vscdb` + `globalStorage/state.vscdb`); it has neither path discovery nor schema parsing for Cursor 3.x's "Store stack" (`~/.cursor/chats/**/store.db` + transcript JSONL).**

This research aims to nail down the Store stack's on-disk structure, `store.db` schema, transcript JSONL format, and workspace→project-path mapping, to serve as the factual basis for the subsequent spec/plan.

---

## 2. Research Method

| Evidence source | Means | Coverage |
|---|---|---|
| **Local primary evidence** | Direct reads of the local `C:\Users\YUYU\.cursor\` (190 transcript JSONL) + `globalStorage/state.vscdb` (node:sqlite queries) | Transcript format, naming scheme, overlap relationship between the two stacks |
| **External multi-source** | 8-agent research workflow (find×4 + adversarial verify×4), scraping 9 independent reverse-engineering projects/docs | store.db DDL, blob structure, cursaves behavior, transcript cross-validation |
| **Self-scraped primary source** | For key DDL divergences, personally scraped `tiann/hapi#824` (main probe issue) for triangulation | store.db DDL confirmed verbatim |

Confidence grading: **High** (≥2 independent sources + primary evidence), **Medium** (single source but credible), **Low** (inference/not yet falsified).

---

## 3. Core Mental Model: Two Independent Replay Stacks + One Cross-Stack Transcript Layer

```
┌─────────────────────────────────────────────────────────────────┐
│  Stack A: Composer stack (tool's current state, fully supported) │
│    workspaceStorage/*/state.vscdb  → ItemTable.composer.composerData
│    globalStorage/state.vscdb       → cursorDiskKV: composerData:<id>,
│                                       bubbleId:<cid>:<bid>, checkpointId:*, …
│    Message shape: bubble {type:1|2, text, toolFormerData, tokenCount, …} │
│    Tool names: read_file / edit_file / run_terminal_command / …  │
├─────────────────────────────────────────────────────────────────┤
│  Stack B: Store stack (this feature's target, zero support)      │
│    ~/.cursor/chats/<ws_hash>/<id>/store.db  (legacy stream-json) │
│    ~/.cursor/acp-sessions/<id>/{store.db,meta.json}  (ACP)       │
│    Message shape: blob Merkle graph, leaves = {role, content[blocks]} │
│    Tool names: Read / Write / StrReplace / Grep / Glob / Shell / … │
├─────────────────────────────────────────────────────────────────┤
│  Transcript layer: cross-stack sidecar (attachable under A or B) │
│    ~/.cursor/projects/<sanitized>/agent-transcripts/<id>/*.jsonl │
└─────────────────────────────────────────────────────────────────┘
```

**Decisive primary evidence (local machine)**: All 190 transcript session IDs **(190/190)** exist in the Composer stack's `composerData` → on a vscdb machine, the transcripts are a sidecar of the Composer stack.
**External evidence (vibe-replay, macOS)**: On their machine, store.db IDs and composerData IDs are **mutually disjoint** → on a store.db machine, transcripts attach under the Store stack.
**Conclusion**: The transcript layer is the only cross-stack universal entry point; **the Issue author's machine simply has no Composer stack**, so the tool finds nothing.

---

## 4. Store Stack On-Disk Layout

### 4.1 Two Store Variants (schema verbatim-identical)

| Variant | Path | Sidecar |
|---|---|---|
| **legacy stream-json** | `~/.cursor/chats/<workspace-hash>/<session-uuid>/store.db` | No meta.json |
| **ACP** | `~/.cursor/acp-sessions/<session-uuid>/{store.db, meta.json}` | `meta.json` |

> Source: hapi#824 (cursor-agent v2026.06.04 measured, verbatim). Issue #31 author's path `~/.cursor/chats/<ws_hash>/<id>/{store.db, meta.json}` exhibits features of both → **the author's exact variant requires primary-evidence confirmation** (see §10).

### 4.2 Cross-Platform Root Paths (inferred, **Medium confidence**)

- Linux/WSL: `~/.cursor/` (issue author measured)
- macOS: `~/.cursor/` (vibe-replay measured)
- Windows: `~/.cursor/` = `C:\Users\<user>\.cursor\` (local measurement: has `projects/`, but no `chats/`)
- Possible third variant (cursor-agent CLI): `~/.config/cursor/chats/<project_hash>/<uuid>/store.db` (observed by agentgrep, **version-dependent, Low confidence**)

### 4.3 Transcript Directory Naming Scheme (local primary evidence, **High confidence**)

`~/.cursor/projects/<sanitized>/` takes three forms:
- **Sanitized absolute path**: `D:\1\Backend` → `d-1-Backend`; `/Users/x/proj` → `Users-x-proj`. Rule: Linux strips leading `/`, `/`→`-`; Windows lowercases the drive letter, `:`/`\`/`/`→`-`. **Lossy, irreversible** (cursaves' `sanitize_project_path` only applies it forward, never in reverse).
- **Timestamp**: `1783664993216` (13-digit Unix-ms, = a transient session without a workspace, e.g. launched from the welcome screen).
- **Special**: `empty-window`, `C-Users-...-Temp-<uuid>` (temp directories).

**`repo.json` does not exist** (local count=0, cursaves whole-repo grep returns 0 hits) → Issue #31's proposal to "map via repo.json" **does not hold**.

### 4.4 `chats/` Path Layout & workspace-hash (WSL measured, 2026-07-11, **High confidence**)

Measured on WSL Ubuntu with cursor-agent installed (v`2026.07.09`); the legacy stream-json variant's full path:

```
~/.cursor/chats/<workspace-hash>/<session-uuid>/{meta.json, store.db}
```

- **`<workspace-hash>` = MD5(absolute cwd)** —— verified precisely on two samples:
  - `MD5("/mnt/d/1_yuyu_proj/cursor-history")` = `46d408964d3ec2a21d9a23d01b13d82c` ✓
  - `MD5("/mnt/c/Users/YUYU")` = `a89cc59fcba69f653802eca7c3790533` ✓
  - → **Forward-predictable** (cwd → MD5 → locate directory); note this is a **different algorithm** from the vscdb `workspaceStorage/` hash (non-MD5) — do not conflate them.
- This layout matches Issue #31 author's description **exactly** (`~/.cursor/chats/<ws_hash>/<id>/{store.db,meta.json}`) — the author was not mistaken.
- `meta.json` is written at session creation; `store.db` is written only after `hasConversation:true` (an actual conversation has occurred).

---

## 5. store.db Schema (**High confidence**, three sources confirmed)

### 5.1 DDL (hapi#824 verbatim + agentlytics + vibe-replay behavior cross-confirmed)

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
```
Both variants (legacy / ACP) are **byte-level identical**.

### 5.2 `meta` Table

- **1 row**, key = `'0'`, value = **hex-encoded UTF-8 JSON** (vibe-replay `SELECT value FROM meta WHERE key='0'` → hex→utf8→`JSON.parse`; agentlytics confirms "hex-encoded JSON").
- Fields (hapi#824 verbatim, all 7 enumerated): `agentId`, `latestRootBlobId`, `name`, `mode`, `createdAt`, optional `lastUsedModel`, optional `isRunEverything`.
  - `isRunEverything` is single-source from hapi#824 only (**Medium confidence**); the other 6 are multi-source (**High**).
- Sample: `{"agentId":"d5c2d589-…","name":"Cursor Session TTL","mode":"auto-run","lastUsedModel":"gpt-5.4-high"}`

### 5.3 `meta.json` (both variants, **High confidence**)

**ACP variant** (hapi#824 verbatim):
```json
{"schemaVersion":1,"cwd":"<absolute path>","title":"<optional>"}
```

**legacy `chats/` variant** (WSL measured, 2026-07-11):
```json
{"schemaVersion":1,"createdAtMs":1783737832293,"hasConversation":false,"updatedAtMs":1783737833338,"cwd":"/mnt/d/1_yuyu_proj/cursor-history"}
```
- Fields: `schemaVersion, createdAtMs, hasConversation, updatedAtMs, cwd`. Differs from ACP (no `title`, adds `createdAtMs/updatedAtMs/hasConversation`). Issue #31 author says their meta.json has `title`; local samples do not → may be a version difference, or `title` is only generated once content exists.
- **Both variants carry the `cwd` absolute path** → §7's path-mapping difficulty is solved by Cursor itself; no reverse sanitization needed.
- `hasConversation:false` = session created but no messages (no store.db at this point).

### 5.4 `blobs` Table = Content-Addressed Merkle Graph

- `id` = 64-hex SHA-256 content hash. `meta.latestRootBlobId` → root tree blob.
- **Tree nodes** = protobuf frames, 34-byte records (agentlytics `parseTreeBlob`):
  - tag `0x0a` + `0x20` + 32 bytes = **message leaf** hash
  - tag `0x12` + `0x20` + 32 bytes = **subtree** hash (agentlytics recurses into both; vibe-replay only byte-scans `0x0a 0x20` one level → observed sessions are shallower)
- **Message leaf blobs decode to JSON** (agentlytics / vibe-replay both succeed with `JSON.parse`):
  - vibe-replay `CursorMessage`: `{role: system|user|assistant|tool, content: string | CursorBlock[], providerOptions?}`
  - agentlytics sees OpenAI form: `{role, content, tool_calls:[{function:{name, arguments}}], model?}` → **message shape varies by provider** (Anthropic form or OpenAI form)
  - `CursorBlock`: `{type, text?, toolCallId?, toolName?, args?, result?, experimental_content?, providerOptions?, signature?}`
- Root blob (viewed as UTF-8) also contains string references `agentKv:blob:<64-hex>` → pointing to an optional `cursorDiskKV` table in the same DB (request-level message blobs).
- **Encoding dispute reconciled**: agentgrep says protobuf (no official schema, generic walk by wire format); agentlytics/vibe-replay succeed with `JSON.parse` on leaves. Most credible reading: **tree/index blobs are protobuf frames; message leaf blobs store JSON** (possibly with a protobuf length prefix that the JSON parser tolerates).

### 5.5 Fields **Not Present** in store.db (**High confidence**)

- No per-message timestamps (only one session-level timestamp `meta.createdAt`)
- No token counts (vibe-replay hardcodes "Token usage is unavailable")
- No thinkingDurationMs / model (unless inside providerOptions)
→ Full fidelity (time/token/model) still requires the Composer stack's vscdb `bubbleId` rows; Store stack sessions **cannot obtain these**.

---

## 6. Transcript JSONL Layer (**High confidence**, local primary evidence + 4 external sources)

### 6.1 Line Format = Anthropic/AI-SDK "role-nested" Form

```jsonc
// Each line
{"role":"user"|"assistant", "message":{"content":[{"type":"text"|"tool_use", …}]}}
// Error lines (more common in subagents/)
{"type":"error","error":"Provider Error …"}
```
Source: hindsight (vectorize-io) names this "role-nested", explicitly for **Cursor 3.x** (build 3.6.31 single source, **Medium confidence**; 3.0 released 2026-04-02). Local file mtimes go back as far as 2026-02-24 → existed even in the 3.x pre-release.

### 6.2 Enumeration (local exhaustive: 27 projects / 5238 lines)

| Dimension | Observed value |
|---|---|
| Top-level role | Only `assistant` (≈4300), `user` (≈930); **no** system/tool/developer |
| message keys | Only `content`; **no** id/model/usage/timestamp |
| content part types | Only `text{type,text}` + `tool_use{type,name,input}` |
| `tool_use` | **No** Anthropic-standard `id` field |
| Missing | **No** `tool_result` (forums confirm transcripts deliberately omit tool output), **no** `thinking`/`image`/`redacted_reasoning` (thinking is heuristically inferred from text by cursor-trace) |
| Layout | **Nested**: `agent-transcripts/<sessionId>/<sessionId>.jsonl`; subagent: `…/subagents/<subagentId>.jsonl` |
| session ID | = filename = the composerId within that stack |

Tool-name vocabulary (Store stack, measured): `Read, ReadFile, Write, StrReplace, Edit, Delete, Grep, Glob, Shell, WebSearch, WebFetch, TodoWrite, ReadLints, SemanticSearch, CreatePlan`.

### 6.3 Completeness Gaps

The transcript layer is **content-incomplete**: it has user/assistant text + tool calls (name + input args), but **no tool returns, no timestamps, no tokens, no model**; assistant text often carries `[REDACTED]` desensitization markers.

### 6.4 Prototype Validation: Transcript Layer Usable as MVP Data Source (2026-07-11, local measurement)

Script `scripts/transcript-parser-prototype.mjs` parses all real local transcripts:

| Metric | Result |
|---|---|
| File count | 191 |
| Total lines | 5246 |
| **JSON.parse failures** | **0** (zero parse failures) |
| Empty files | 1 |
| error lines (`{type:"error"}`) | 3 (correctly skipped) |
| Valid message lines | 5243 |
| Messages per file | min 0 / max 247 / mean 27.5 |

- **role-nested parsing is robust**: 191 files, 5246 lines, zero failures. roles only `assistant` (4310) / `user` (933); parts only `text` (4305) / `tool_use` (5244).
- **Full Store-stack tool vocabulary** (top): Read 1656, StrReplace 727, Shell 529, Glob 443, ReadFile 399, Grep 344, Write 304, ApplyPatch 218, TodoWrite 167, ReadLints 107, rg 87, updateCurrentStep 48, Delete 47, CreatePlan 39, WebSearch/WebFetch/SemanticSearch/Task/AskQuestion/Subagent(…).
- **Message mapping is clear**: `user_query` → user text; assistant text (including `[REDACTED]`); `tool_use` → `ToolCall{name, params:input}`.
- **Conclusion**: The transcript layer is an **immediately usable MVP data source** (session list + user/assistant text + tool calls), covering 100% of Issue #31 author's session scenarios and **completely independent** of store.db blob parsing. Title/time/token/tool-returns are deferred to the store.db deep parse (§9).

---

## 7. workspace → Project Path Mapping (implementation difficulty)

| Session type | Path source | Reliability |
|---|---|---|
| ACP store.db | `meta.json.cwd` (absolute path) | **High** (direct) |
| legacy stream-json store.db | **`meta.json.cwd` (absolute path)** (WSL measured); `<workspace-hash>` = MD5(cwd) forward-predictable | **High** (direct) |
| Composer stack | `workspaceStorage/<hash>/workspace.json`'s `folder`/`workspace` URI; 3.0+ `composer.composerHeaders.workspaceIdentifier.uri` | **High** (cursaves already verified) |
| Transcript directory | `<sanitized>` name (lossy, forward-only) | **Low** (hint only, not the sole source) |

**Conclusion**: Both ACP and legacy variants' `meta.json` **carry the `cwd` absolute path** (WSL measured) → path mapping is no longer the hard part; `<workspace-hash>` = MD5(cwd) is forward-predictable. **No approach depends on repo.json** (which does not exist).

---

## 8. Session ID Model

- **Intra-stack alignment**: transcript filename = store.db's session uuid (Store stack) = composerId (Composer stack).
- **Cross-stack disjoint**: store.db sessions and composerData session IDs do not overlap on the same machine (vibe-replay macOS measurement).
- The local exception (190/190 transcripts ⊂ composerData) is because this machine **has no store.db**; all transcripts attach to the Composer stack.
→ **Cross-stack discovery must dedupe by session ID**; the same ID will not appear in both stacks at once.

---

## 9. Field Coverage Matrix (determines each command's fidelity)

| Capability | Composer stack (current) | Store stack store.db | Transcript JSONL |
|---|:-:|:-:|:-:|
| Session list/title | ✅ | ✅ (meta.name) | ⚠️ (no title; needs store.db/meta) |
| Project path | ✅ | ✅ (`meta.json.cwd`, §5.3) | ❌ (lossy) |
| User/assistant text | ✅ | ✅ | ✅ |
| Tool calls (name + input) | ✅ | ✅ | ✅ |
| Tool returns | ✅ | ✅ (block.result) | ❌ |
| Timestamps (per-msg) | ⚠️ (73%) | ❌ (session-level only) | ❌ |
| token/model | ✅ | ❌ | ❌ |
| thinking | ✅ | ⚠️ (providerOptions) | ❌ (folded into text) |

→ **Minimum viable (MVP)**: read transcript JSONL → session list + text + tool calls (missing title/time/token/tool-returns).
→ **Full fidelity**: read store.db (Store stack sessions) or vscdb (Composer stack sessions).

---

## 10. Open Questions / Points Needing the Issue Author's Primary Evidence

### 10.0 Local + WSL Exploration Findings (2026-07-11, verified)

To obtain a real `store.db` primary sample, both the local Windows machine and WSL Ubuntu were explored:

| Environment | `store.db` | `chats/` | `acp-sessions/` | Transcript JSONL | Composer stack |
|---|:-:|:-:|:-:|:-:|:-:|
| Windows `C:\Users\YUYU\.cursor\` | ❌ | ❌ | ❌ | ✅ 191 | ✅ `%APPDATA%\Cursor` |
| WSL Ubuntu `/home/yuyu/.cursor/` | ❌ (network blocker) | ✅ (3 sessions, meta.json only) | ❌ | ❌ | ❌ |

- **WSL Ubuntu follow-up**: Installed cursor-agent v`2026.07.09` + OAuth login succeeded (`~/.config/cursor/auth.json` present); `agent -p` sessions created `~/.cursor/chats/<MD5(cwd)>/<uuid>/meta.json` (3 of them, all `hasConversation:false`), **but store.db was never generated** — the agent could not reach the session endpoint.
- **Root cause (network, not storage)**: WSL NAT mode + Windows proxy (Clash-style TUN, fake-IP `198.18.0.x`). `api2.cursor.sh` (login) is let through by the proxy (http 200); `agentn.global.api5.cursor.sh` (sessions) is not covered by the rules → timeout. Fix: in the proxy software, add `agentn.global.api5.cursor.sh` (or `*.cursor.sh`) to the proxied-rule list, then re-run `agent -p`.
- Windows `~/.cursor`'s only DB is `ai-tracking/ai-code-tracking.db` (16MB, an AI attribution DB); no Store-stack data.
- **Already confirmed without needing store.db** (see §4.4 / §5.3): legacy `chats/` path layout = `~/.cursor/chats/<MD5(cwd)>/<uuid>/{meta.json,store.db}`; `<workspace-hash>` = MD5(cwd); meta.json contains the `cwd` absolute path.
- **Still needs a real store.db to confirm**: only §10.1 item 2 (blob leaf encoding). Routes: ① fix the proxy and generate locally ② ask the Issue author to dump it.

### 10.1 Points Still Needing Primary-Evidence Confirmation

Points that could not be 100% confirmed from local/external sources during research (the local machine has no `chats/store.db`):

1. ✅ **Store variant = legacy `chats/`** (WSL measured): `~/.cursor/chats/<MD5(cwd)>/<uuid>/{meta.json,store.db}`, consistent with Issue #31 author's description. meta.json schema already measured (§5.3).
2. ✅ **store.db blob leaf encoding** (2026-07-11 WSL real-store.db empirical, **closed**): **message leaf = pure JSON** (`{role, content}`, OpenAI/Anthropic form), **tree/index blob = protobuf frame** (`0x0a 0x20` + 32-byte hash). Real sample (cursor-agent successful session, 48KB / 11 blobs = 4 JSON + 7 protobuf): meta(key='0') = hex-JSON `{agentId, latestRootBlobId, name, mode, isRunEverything, createdAt}` (`isRunEverything` empirically confirmed, not single-source); first JSON leaf = `{"role":"system","content":"You are an AI coding assistant, powered by Composer..."}`. DDL matches hapi#824 verbatim. The user's WSL `agent -p` retry succeeded (returned "pong") and produced this real store.db, incidentally validating the Issue #31 list scenario (discover finds 5 Store sessions, no longer reports empty).
3. ✅ **workspace-hash algorithm = MD5(absolute cwd)** (WSL measured, exact match on two samples, §4.4).
4. ⏳ **ACP `acp-sessions/` path**: Both the local machine and the Issue author use `chats/` (legacy); `acp-sessions/` has not been observed. The ACP variant path (hapi#824) should still be supported for other users, but priority is low.

**Suggested confirmation command for the author** (WSL, using this tool's bundled node:sqlite, no need to install the sqlite3 CLI):
```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1], { readOnly: true });
console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table'\").all());
console.log(db.prepare(\"SELECT * FROM meta\").all());
console.log('blobs count:', db.prepare('SELECT COUNT(*) c FROM blobs').get());
" ~/.cursor/chats/<a-ws_hash>/<a-session_id>/store.db
```
Plus `cat …/meta.json` and `ls ~/.cursor/`.

---

## 11. Impact on Implementation (initial architecture options, left for spec to detail)

1. **Path discovery**: Add a Store-stack discoverer next to `getDefaultCursorDataPath` / `findWorkspaces`, scanning `~/.cursor/{chats,acp-sessions}` + `~/.cursor/projects` (transcripts).
2. **New storage backend**: `src/core/store-stack/` (largely non-overlapping with the existing vscdb paths), implementing:
   - `store.db` reading (meta hex decode + blobs Merkle-graph traversal + leaf JSON parsing)
   - transcript JSONL reading (role-nested parsing)
   - unified mapping onto existing `ChatSession`/`Message` types (adding `source: 'store' | 'transcript'`)
3. **Session merging**: dedupe across stacks by session ID, deciding precedence (higher-fidelity wins: store.db > transcript).
4. **Fidelity-degraded display**: Store-stack sessions lack token/time; reuse 012's `session.source` + degraded-warning mechanism.
5. **MVP slicing**: first ship "read-only transcript-JSONL discovery + list/text/tool calls" (covers the Issue author's 100% session scenarios), then add the store.db deep parse to complete fidelity.

---

## 12. References

**Primary evidence / verbatim schema**
- tiann/hapi#824 (store.db DDL + meta shape + path layout, verbatim main probe): https://github.com/tiann/hapi/issues/824
- vibe-replay sqlite-reader.ts (meta hex decode + blobs traversal + CursorMessage type): https://raw.githubusercontent.com/tuo-lei/vibe-replay/main/packages/provider-cursor/src/cursor/sqlite-reader.ts
- agentlytics editors/cursor.js (parseTreeBlob 0x0a/0x12 + OpenAI-form normalization): https://github.com/f/agentlytics

**Overall storage model**
- vibe-replay blog (two-stack model + transcript cross-stack + disjoint-ID measurement): https://vibe-replay.com/blog/cursor-local-storage/
- cursaves docs + source (authoritative on vscdb + workspace.json mapping + does not read store.db): https://github.com/Callum-Ward/cursaves
- agentgrep (cursor-agent CLI path variants + protobuf wire format): https://agentgrep.org/backends/cursor-cli/

**Transcript JSONL format**
- hindsight retain.py (role-nested naming + Cursor 3.6.31): https://raw.githubusercontent.com/vectorize-io/hindsight/main/hindsight-integrations/cursor/scripts/retain.py
- hindsight issue #2464: https://github.com/vectorize-io/hindsight/issues/2464
- cursor-trace (thinking heuristic): https://github.com/dwqs/cursor-trace
- Cursor 3.0 changelog (2026-04-02): https://cursor.com/changelog/3-0

**Issue**
- #31: https://github.com/S2thend/cursor-history/issues/31
