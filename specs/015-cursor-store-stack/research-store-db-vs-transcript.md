# Research on Cursor `store.db` vs `agent-transcripts` Read Priority

> Date: 2026-07-23
>
> Scope: GitHub primary source code, commit permalinks; blogs or secondhand accounts are not used as the basis for conclusions
> Conclusion status: Sufficient to overturn the premise that "if a usable transcript exists, `store.db` is not read"

## 1. Conclusion

This source-code investigation supports the following judgments:

1. `~/.cursor/chats/<workspace>/<session>/store.db` is the primary session state store. Its `meta.latestRootBlobId` points to the current root, and `blobs` holds both message leaves and binary DAG nodes that describe branch relationships. To recover the session branch currently visible in Cursor, you should traverse from this root rather than scanning all blobs or sorting only by SQLite `rowid`.
2. `~/.cursor/projects/<project>/agent-transcripts/...` is a side-channel record produced by the Cursor Agent system, not a complete inventory of all Cursor conversations. External implementations will encounter sessions with "only `store.db`, no JSONL", and will also separately discover sub-agent JSONL.
3. transcript is a version-dependent, capability-unstable lossy representation. Observed gaps include tool result, images, reasoning, compaction, model, token, per-turn time, and stable message IDs; under different Cursor versions or runtime modes, JSONL may occasionally carry thinking markers or user images that the DB parsing result lacks.
4. The most credible engineering strategy has already been implemented in practice by vibe-replay: **SQLite primary source → transcript whitelist enhancement → transcript fallback when SQLite is unavailable**. This is the opposite of the current project's direction of "return directly as long as transcript has any messages".
5. "Having read `store.db`" does not automatically equal "having read the current complete session". VibeLens uses `rowid` to approximate order, and VibeCodingTracker scans all blobs and explicitly does not traverse the DAG; these strategies fit their respective analysis scenarios but should not be directly reused for canonical session reconstruction in `show`/`export`.

Therefore, this project should change the existing priority to:

```text
store.db latestRoot active DAG
  ├─ Success: serves as the backbone for message order, roles, text, tool calls/results
  │        └─ transcript only supplements fields validated through whitelist and deterministic matching
  └─ Missing / unreadable / no recoverable messages: transcript degraded fallback
```

## 2. Evidence Overview

| Project | Actual Read Scope | Primary Source and Fallback Strategy | Most Important Evidence for This Project |
|---|---|---|---|
| [CHATS-lab/VibeLens](https://github.com/CHATS-lab/VibeLens/tree/3060ace860be2b81de461ccbbacf5fee0cd3b8bf) | Main session reads `store.db`; JSONL used for project paths and sub-agents | DB primary source; main session not overridden by JSONL | Directly calls DB complete state, calls transcript partial export |
| [tuo-lei/vibe-replay](https://github.com/tuo-lei/vibe-replay/tree/4907c9a77a4a1437520e601fcee34e61bc39586b) | `store.db`, global `state.vscdb`, agent transcript JSONL, SDK DB | SQLite-first; JSONL targeted enhancement; fallback only on DB failure | Landed selector almost identical to this recommendation; reads along `latestRootBlobId` |
| [Mai0313/VibeCodingTracker](https://github.com/Mai0313/VibeCodingTracker/tree/ab909cf5afc6458f847b64db42fc966b57ffa208) | Extracts assistant, tool results, context metrics from each `store.db` | Reads DB only, does not depend on transcript | Independently confirms assistant protobuf nodes, JSON tool result, `toolCallId` in DB; also demonstrates the limitation of "full blob scan" |
| [entireio/cli](https://github.com/entireio/cli/tree/0f52986e207b0f7054f5483f9fb8120a130a2e42) | Cursor Agent JSONL transcript | transcript-only, oriented toward Agent checkpoint/import | Code explicitly acknowledges transcript lacks model, token, per-turn time, and cannot detect modified files from it |
| [getagentseal/codeburn](https://github.com/getagentseal/codeburn/tree/6e3c57a9ff95a624f1d9affa7384d32a67f359b7) | Cursor IDE's `state.vscdb` and Cursor Agent transcript are two providers | Does not treat both as the same general session source | `cursor-agent` discovers sessions only from `agent-transcripts`; JSONL parsing only consumes user/assistant text and `tool_use` |

## 3. Per-Project Source Code Review

### 3.1 VibeLens: DB is the Complete Primary State, transcript is a Partial Export

VibeLens's Cursor parser module states the responsibilities of the two formats very directly:

- `store.db` stores **complete session state**; JSON leaves contain `text`, `tool-call`, `tool-result`, `image`, `reasoning`, binary nodes form a Merkle DAG, and the DAG is the source of truth for branch order.[cursor.py L1-L25](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L1-L25)
- `agent-transcripts` is called a "write-only export" and **partial**; the missing items listed in the source are tool result, image, reasoning, compaction marker; VibeLens only uses it to recover project paths and discover sub-agent files.[cursor.py L27-L35](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L27-L35)
- The main session discovery target is each `chats/<workspace>/<sid>/store.db`, not the transcript files.[cursor.py L135-L186](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L135-L186)
- Standalone `role: tool` messages in the DB are indexed by `toolCallId`, then attached to the assistant's `tool-call`.[cursor.py L229-L252](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L229-L252) [cursor.py L326-L343](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L326-L343)
- sub-agent is an exception: VibeLens separately constructs sub-trajectories from `subagents/*.jsonl`, and explicitly notes that these files only carry text + `tool_use`, with no tool result.[cursor.py L254-L286](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L254-L286) [cursor.py L584-L597](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L584-L597)

However, VibeLens does not actually traverse the DAG along the active root. It queries `SELECT data FROM blobs ORDER BY rowid`, discards binary DAG nodes, and keeps only all role-bearing JSON blobs.[cursor.py L197-L214](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L197-L214) [cursor.py L289-L323](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L289-L323)

This shows that two different issues must not be conflated:

- **Coverage scope**: DB is indeed richer than transcript.
- **Canonical order**: If retries, forks, or abandoned nodes exist, `rowid` is only an observational approximation; only the DAG along `latestRootBlobId` can definitively bound the current branch.

### 3.2 vibe-replay: SQLite-first, JSONL Enhancement, Fallback After Failure

vibe-replay is the most direct design sample in this investigation. Its `parseCursorSessionWithDependencies()` works in the following order:

1. When a session ID is present, it calls the SQLite parser first.[parser.ts L60-L82](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L60-L82)
2. After SQLite succeeds, it keeps SQLite/global-state as the source of truth, only supplements missing thinking markers and user images from JSONL, then immediately returns the DB primary result.[parser.ts L89-L120](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L89-L120)
3. Only when the SQLite schema is incompatible or parsing fails does it fall back to JSONL; if there is no JSONL, it returns an explicit error.[parser.ts L83-L87](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L83-L87) [parser.ts L124-L144](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L124-L144)
4. It also discovers SQLite-only sessions with no JSONL at all; the actual scenario given in the source is devcontainer/SSH remote: the Cursor server extension writes the DB on the remote side, but the host machine does not generate JSONL.[sqlite-reader.ts L1171-L1196](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/sqlite-reader.ts#L1171-L1196)

There is also a clear primary-secondary relationship inside the DB: it first parses the per-session `store.db`; if the global `state.vscdb` also contains the session, it merges global-state information; only when there is no Store result does it fall back to global state alone.[sqlite-reader.ts L1599-L1622](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/sqlite-reader.ts#L1599-L1622)

For `store.db`, it reads `meta.latestRootBlobId`, then extracts child blob IDs and `agentKv` references from the root node, parsing only the messages associated with that root.[sqlite-reader.ts L1647-L1707](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/sqlite-reader.ts#L1647-L1707) This is closer to Cursor's current session branch than scanning all blobs.

Its enhancement rules still warrant cautious scrutiny: thinking is paired by the **positional index** of the assistant turn, only supplementing missing thinking; user images are also paired by user turn index.[parser.ts L645-L676](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L645-L676) [parser.ts L694-L725](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L694-L725) This approach is enough to show that transcript can serve as an enhancement, but it does not prove that "merge by position" is safe across all branch, retry, and compaction scenarios.

Another boundary that must be preserved is the Cursor SDK Agent: vibe-replay comments note that such Agents may have only JSONL, no IDE chat `store.db`, with tool results in the SDK `index.db`.[parser.ts L157-L177](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L157-L177) Therefore DB-first must not be implemented as "drop the session if there is no DB".

### 3.3 VibeCodingTracker: Independently Verifies DB Contents, But Does Not Provide Canonical Session Replay

VibeCodingTracker's Cursor module describes `store.db` as a content-addressed blob store that holds the whole conversation, and independently confirms:

- The assistant turn is located at field 4 of the protobuf DAG node; field 26 is the time; field 5 is the context metric.
- The tool result is located in a standalone JSON blob.

See [cursor.rs L1-L19](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L1-L19). Its analysis entry iterates over all `chats/*/*/store.db`; a single library that fails to parse is recorded as a diagnostic, and only when all libraries fail does it report an overall error.[cursor.rs L118-L153](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L118-L153)

The actual parsing runs in two passes: it first indexes JSON tool results, then parses protobuf assistant nodes, and only counts tool calls where `role == assistant`.[cursor.rs L609-L674](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L609-L674) Read results are linked precisely via the stable `toolCallId`, rather than guessed by neighboring position.[cursor.rs L911-L934](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L911-L934) [cursor.rs L957-L1009](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L957-L1009)

However, it explicitly "does not traverse the DAG", only reading the field 4/5/26 of interest.[cursor.rs L1042-L1058](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L1042-L1058) For tool-usage statistics, this choice is simple and robust; for session display, it may mix historical branches or inactive nodes into the result, so it cannot serve as the order model for `show`/`export`.

### 3.4 Entire CLI: transcript is Cursor Agent Adapter Input, and Its Capabilities Are Explicitly Limited

Entire's type name is simply `CursorAgent`. It distinguishes between the IDE's nested JSONL and the CLI's flat JSONL, and parses both uniformly under `agent-transcripts`.[cursor.go L29-L49](https://github.com/entireio/cli/blob/0f52986e207b0f7054f5483f9fb8120a130a2e42/cmd/entire/cli/agent/cursor/cursor.go#L29-L49) [cursor.go L77-L110](https://github.com/entireio/cli/blob/0f52986e207b0f7054f5483f9fb8120a130a2e42/cmd/entire/cli/agent/cursor/cursor.go#L77-L110)

It also directly documents the limitations of transcript:

- `ModifiedFiles` is left empty, because transcript does not contain tool-use information usable for file detection, so it can only rely on Git state.[cursor.go L124-L144](https://github.com/entireio/cli/blob/0f52986e207b0f7054f5483f9fb8120a130a2e42/cmd/entire/cli/agent/cursor/cursor.go#L124-L144)
- The import parser notes that Cursor transcript does not record model or token usage.[agentimport/cursor.go L17-L20](https://github.com/entireio/cli/blob/0f52986e207b0f7054f5483f9fb8120a130a2e42/cmd/entire/cli/agentimport/cursor.go#L17-L20)
- Real records have no per-turn UUID and timestamp, so it uses the JSONL line number as the turn key and the whole transcript file mtime as the time fallback.[agentimport/cursor.go L58-L87](https://github.com/entireio/cli/blob/0f52986e207b0f7054f5483f9fb8120a130a2e42/cmd/entire/cli/agentimport/cursor.go#L58-L87)

Such transcript-only projects can well accomplish the narrow goal of "saving Agent checkpoints / extracting prompts", but their existence cannot counter-prove that transcript is a complete session format.

### 3.5 CodeBurn: Cursor IDE and Cursor Agent Are Separate Data Sources

CodeBurn registers both as different providers:

- `cursor` reads `bubbleId`/`agentKv` from the global `state.vscdb`.[cursor.ts L78-L105](https://github.com/getagentseal/codeburn/blob/6e3c57a9ff95a624f1d9affa7384d32a67f359b7/src/providers/cursor.ts#L78-L105)
- `cursor-agent` only discovers flat/nested/subagent transcripts under `~/.cursor/projects/**/agent-transcripts`, and marks the provider as `cursor-agent`.[cursor-agent.ts L155-L215](https://github.com/getagentseal/codeburn/blob/6e3c57a9ff95a624f1d9affa7384d32a67f359b7/src/providers/cursor-agent.ts#L155-L215) [cursor-agent.ts L496-L543](https://github.com/getagentseal/codeburn/blob/6e3c57a9ff95a624f1d9affa7384d32a67f359b7/src/providers/cursor-agent.ts#L496-L543)
- The JSONL transcript parser only handles `role=user/assistant`; the assistant side only extracts text and `tool_use`, without restoring `tool_result`.[cursor-agent.ts L240-L289](https://github.com/getagentseal/codeburn/blob/6e3c57a9ff95a624f1d9affa7384d32a67f359b7/src/providers/cursor-agent.ts#L240-L289)

This again shows that `agent-transcripts` is the data plane for the Agent adapter, not "the unified source of truth for all Cursor conversations".

## 4. Actual Coverage Boundaries of the Two Formats

### 4.1 `store.db`

High-confidence facts:

- Each session has its own standalone SQLite DB; `meta` provides `latestRootBlobId`, name, creation time, model, and other session information.
- `blobs` stores user, assistant, system, tool messages and content blocks; modern assistant messages are also embedded inside protobuf DAG nodes.
- Tool call and tool result can be precisely linked via `toolCallId`.
- The DAG can express the current root and historical branches, so the DB is not just another serialization of transcript.

Limitations:

- The local DB does not equate to possessing all displayable information. Reasoning text may be encrypted by the provider; token/billing information may also be absent.
- The parser must be compatible with pure JSON leaves, protobuf nodes, `cursorDiskKV` references, and active WAL.
- Scanning all blobs or sorting by `rowid` abandons the active-root semantics, and cannot claim to have recovered the canonical current branch.

### 4.2 `agent-transcripts`

High-confidence facts:

- Produced by the Cursor Agent/IDE Agent path, containing flat/nested JSONL of the main Agent and sub-agents; not every DB session has a corresponding file.
- Suitable for quickly extracting user/assistant text, partial `tool_use`, Agent checkpoints, and sub-agent records.
- The fields observed in real samples differ across projects, indicating that it is not a stable public contract whose completeness can be assumed fixed.

Typical gaps:

- tool result, stable `toolCallId` pairing, or complete tool parameters;
- images, reasoning, compaction marker;
- model, token, per-message time, stable message ID;
- non-Agent conversations and SQLite-only/remote sessions.

Version differences also matter: in VibeLens's samples transcript lacks image/reasoning, while in vibe-replay's samples transcript supplements thinking and images. The two are not contradictory; together they prove: **transcript cannot be assigned cross-version "complete" or "authoritative" semantics, and can only be used according to its actual field capabilities.**

## 5. Recommendations for the Current Project

### 5.1 Primary Source Selection

For sessions where both sources exist:

1. First read `meta.latestRootBlobId`.
2. Traverse the active DAG from this root, keeping only reachable messages and tool results.
3. The DB result constitutes the session backbone and canonical order.
4. transcript must not override DB-existing text, roles, tool parameters, or tool results.

Do not adopt the following two alternative schemes:

- Treating all role-bearing blobs as the current session after `SELECT ... ORDER BY rowid`;
- Scanning all protobuf/JSON blobs and then ignoring parent-child references.

The former may contain abandoned branches, and the latter may also duplicate the same message between standalone leaves and protobuf nodes.

### 5.2 transcript Fallback

Only in these cases should transcript be promoted to a message source:

- The session has no `store.db` (including transcript-only Agent/SDK/sub-agent);
- The DB cannot be opened, the schema is unsupported, or the root node is unrecoverable;
- The DB is readable but the active root has no recoverable messages.

Fallback results must retain explicit provenance and a fidelity warning, and must not be marked as complete equivalent to DB reconstruction.

### 5.3 transcript Enhancement

It is recommended to first limit enhancement to whitelist fields:

- Plaintext thinking that the DB lacks and transcript explicitly contains;
- User image references that the DB lacks and transcript can parse;
- Sub-agent sub-trajectories that the DB does not have;
- Metadata such as project paths that does not change message content or order.

Enhancement requires at minimum a consistent session UUID. If the enhancement needs to land on specific messages, it should also require that role, normalized text, tool signatures, or stable IDs can correspond deterministically. Matching only by "the Nth user/assistant turn" can serve as a compatibility heuristic for a specific version, but should not become the integrity contract for this project.

If the first phase lacks real enhancement samples, the safest delivery remains: **DB primary source + transcript pure fallback**; enhancement is added after samples and matching rules are clarified.

### 5.4 State Model

It is recommended to separate source and parse quality internally:

```ts
type StoreDbState =
  | 'missing'
  | 'unreadable'
  | 'unsupported'
  | 'empty'
  | 'partial'
  | 'complete';

type TranscriptUse = 'unused' | 'supplement' | 'fallback' | 'only-source';

interface StoreResolution {
  primarySource: 'store-db' | 'transcript';
  storeDbState: StoreDbState;
  transcriptState: TranscriptState;
  transcriptUse: TranscriptUse;
}
```

Here, `complete` should only mean "all known message shapes reachable from the active root are handled by the current parser", not "all of Cursor's future private fields are understood".

### 5.5 Decision Matrix

| `store.db` | transcript | Result |
|---|---|---|
| Readable and active root complete | Any | DB backbone; whitelist-only enhancement |
| Readable but some nodes unsupported | Available | DB backbone marked partial; do not fully replace with transcript, supplement fields by deterministic rules if needed |
| Missing/unreadable/no valid root | Available | transcript fallback, marked lossy |
| Readable | Missing | DB-only session displayed normally |
| Missing | sub-agent JSONL | transcript-only sub-session/sub-trajectory |
| Both unavailable | metadata available | metadata-only or handled per existing empty-session rules |

## 6. Remaining Uncertainties

This investigation is sufficient to determine the primary-source priority, but the following still require local real samples or subsequent version verification:

- Cursor has not published the `store.db` protobuf/DAG schema; `latestRootBlobId`, field 4/5/26, and the child hash rules all come from reverse-engineered implementations and may change in future versions.
- The missing fields of transcript are not a fixed set. VibeLens and vibe-replay observe image/reasoning differently, indicating that detection must be based on actual content block capabilities, not hard-coded by Cursor version number.
- The persistence combinations of main Agent, sub-agent, Cursor SDK Agent, IDE Agent, and remote/devcontainer sessions are not consistent; current evidence does not support covering all forms with a single "every session must have A+B" rule.
- There is no confirmed cross-format per-message stable ID between DB and transcript. vibe-replay's role-index enhancement is a heuristic; the risk of mismatches after branching, retries, and compaction still needs to be verified with real dual-source samples.
- When the provider encrypts reasoning, the plaintext cannot be recovered even if the DB structure is complete. This counts as source data unavailability, and should not be misreported by the parser state as a structural parse failure.
- The combinations of active WAL, `cursorDiskKV` references, and deeper DAG nodes across versions still need to remain fault-tolerant; "reachable from the root" can serve as the current session boundary, but unknown nodes should result in partial, not silently complete.

These uncertainties affect enhancement details and integrity markers, not the overall conclusion of "DB primary source, transcript fallback / whitelist enhancement".

## 7. Corrections to Existing Spec Conclusions

The existing [research.md](./research.md) describes transcript as "the only cross-stack universal entry point", and further defines transcript as the lead MVP primary source; [plan.md](./plan.md) and [spec.md](./spec.md) subsequently solidified this into "if a usable transcript exists, do not read the DB". The primary source-code evidence in this investigation shows that this conclusion mistakenly extrapolates "high coverage in a batch of local samples" into "the format itself covers all sessions and is complete enough".

What needs to be corrected is not a single conditional branch, but the source-of-truth model:

- Session discovery must jointly scan DB and transcript, and cannot use the presence of either to infer the necessary presence of the other;
- Main session reconstruction is governed by the `store.db` active root;
- transcript serves as an Agent-specific degraded/enhancement source;
- sub-agent, SDK Agent, and remote SQLite-only sessions each retain their own true storage boundaries.

## 8. Permalink Index

- VibeLens commit [`3060ace`](https://github.com/CHATS-lab/VibeLens/commit/3060ace860be2b81de461ccbbacf5fee0cd3b8bf)
  - [Module notes on full DB / partial transcript](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L1-L80)
  - [DB main session discovery and parsing](https://github.com/CHATS-lab/VibeLens/blob/3060ace860be2b81de461ccbbacf5fee0cd3b8bf/src/vibelens/ingest/parsers/cursor.py#L135-L252)
- vibe-replay commit [`4907c9a`](https://github.com/tuo-lei/vibe-replay/commit/4907c9a77a4a1437520e601fcee34e61bc39586b)
  - [SQLite-first, JSONL enhance/fallback](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/parser.ts#L60-L177)
  - [`latestRootBlobId` and Store/global-state priority](https://github.com/tuo-lei/vibe-replay/blob/4907c9a77a4a1437520e601fcee34e61bc39586b/packages/provider-cursor/src/cursor/sqlite-reader.ts#L1599-L1707)
- VibeCodingTracker commit [`ab909cf`](https://github.com/Mai0313/VibeCodingTracker/commit/ab909cf5afc6458f847b64db42fc966b57ffa208)
  - [`store.db` fields and tool result parsing](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L1-L19)
  - [Implementation boundary of not traversing the DAG](https://github.com/Mai0313/VibeCodingTracker/blob/ab909cf5afc6458f847b64db42fc966b57ffa208/src/core/src/session/cursor.rs#L1042-L1058)
- Entire CLI commit [`0f52986`](https://github.com/entireio/cli/commit/0f52986e207b0f7054f5483f9fb8120a130a2e42)
  - [Cursor Agent transcript paths and capability limitations](https://github.com/entireio/cli/blob/0f52986e207b0f7054f5483f9fb8120a130a2e42/cmd/entire/cli/agent/cursor/cursor.go#L77-L144)
  - [Missing model/token/per-turn time](https://github.com/entireio/cli/blob/0f52986e207b0f7054f5483f9fb8120a130a2e42/cmd/entire/cli/agentimport/cursor.go#L17-L87)
- CodeBurn commit [`6e3c57a`](https://github.com/getagentseal/codeburn/commit/6e3c57a9ff95a624f1d9affa7384d32a67f359b7)
  - [Cursor Agent transcript discovery and parsing](https://github.com/getagentseal/codeburn/blob/6e3c57a9ff95a624f1d9affa7384d32a67f359b7/src/providers/cursor-agent.ts#L155-L289)
