# Implementation Plan: Cursor Store Stack Support

**Branch**: `015-cursor-store-stack` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `specs/015-cursor-store-stack/spec.md`; factual basis [research.md](./research.md)

## Summary

Add **read-only** support for the Cursor "Store stack" (`~/.cursor/chats/<MD5(cwd)>/<uuid>/{meta.json,store.db}` + `~/.cursor/projects/<sanitized>/agent-transcripts/<uuid>/*.jsonl`) to cursor-history, fixing Issue #31 (WSL/CLI/agent users getting empty `list` results). Split into two phases: **P1** = read-only transcript JSONL discovery + `list`/`show`/`search`/`export` (text + tool calls), independent of store.db blob parsing, covering 100% of target users' sessions (local 191-file prototype verified zero parse failures); **P2** = `store.db` deep parse to complete title/tool results/session-level time. Add a standalone Store stack backend module, merged with the existing Composer stack pipeline at the `storage` layer, deduplicated across stacks by session ID, reusing 012's `session.source` + degraded warning. **No new dependencies** (reuses node:sqlite driver 006 + `node:crypto` + `node:fs`).

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode)  
**Primary Dependencies**: Existing — node:sqlite / better-sqlite3 (pluggable driver 006), commander, picocolors. New — **none** (MD5 via `node:crypto`; JSONL via `node:fs` + `JSON.parse`; all Node built-ins)  
**Storage**: Read-only — transcript JSONL (`~/.cursor/projects/**/agent-transcripts/*.jsonl`) + `store.db` SQLite (`~/.cursor/chats/**/store.db`, P2)  
**Testing**: vitest (existing); contract fixtures + redacted real samples  
**Target Platform**: Linux / macOS / Windows / WSL (`/mnt/...`)  
**Project Type**: single (CLI + library share `src/core/`)  
**Performance Goals**: Transcript parsing ≥10k lines/sec (prototype 5246 lines completed instantly); hundreds of sessions `list` <1s  
**Constraints**: Read-only (no writes to the Store stack), bounded memory (streaming line-by-line JSONL reads), any single file/line parse failure must not abort the whole run (defensive parsing)  
**Scale/Scope**: Personal single-machine; typically hundreds of sessions, single session ≤ several thousand lines

> No NEEDS CLARIFICATION — all technical points are covered by research.md.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Compliance | Notes |
|---|---|---|
| I. Simplicity First | ✅ | P1 only does transcript JSONL parsing (simplest path, prototype-verified); store.db Merkle graph parsing deferred to P2 (YAGNI) |
| II. CLI-Native | ✅ | Reuses existing list/show/search/export commands and flags; `--data-path` extended to point at `~/.cursor`; `--json` works on Store sessions |
| III. Documentation-Driven | ✅ | research.md + plan + data-model + contracts + quickstart; README adds Store stack path documentation |
| IV. Incremental Delivery | ✅ | P1 (transcript) is independently testable and deliverable, fully independent of P2; US1/US2 are independent MVP slices |
| V. Defensive Parsing | ✅ | error lines/empty files/corrupt store.db/protobuf-vs-JSON encoding uncertainty → all gracefully degrade (spec Edge Cases) |
| Technical Standards | ✅ | TypeScript strict, no new dependencies, node:sqlite reuse, core/CLI decoupling |
| GUI Extensible | ✅ | Store stack logic in `src/core/`, decoupled from CLI |

**Conclusion**: No violations, no Complexity Tracking exemption required.

## Project Structure

### Documentation (this feature)

```text
specs/015-cursor-store-stack/
├── plan.md              # this file
├── research.md          # Phase 0 (complete: WSL hands-on + prototype validation)
├── spec.md              # specification
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1
│   ├── cli-api.md
│   └── library-api.md
├── checklists/
│   └── requirements.md
└── scripts/
    └── transcript-parser-prototype.mjs   # research prototype (reproducible)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── store-stack/             # NEW — Store stack backend (independent of, and cohesive against, the Composer stack)
│   │   ├── paths.ts             # ~/.cursor/ root location + MD5(cwd) + sanitized name utilities
│   │   ├── transcript.ts        # JSONL role-nested parsing → Message (P1 core)
│   │   ├── discover.ts          # scans chats/ + projects/, produces StoreSession[] (P1)
│   │   ├── store-db.ts          # store.db reads: meta hex decoding + blobs Merkle traversal (P2)
│   │   └── types.ts             # intermediate types such as StoreSession / TranscriptLine
│   ├── storage.ts               # CHANGE — listSessions/getSession/findWorkspaces merge the two stacks + dedup
│   ├── parser.ts                # CHANGE — unified Store → ChatSession/Message mapping
│   └── types.ts                 # CHANGE — ChatSession.source extended with 'store'|'transcript'
├── lib/
│   ├── platform.ts              # CHANGE — add getStoreStackRoot() / cross-platform ~/.cursor location
│   ├── index.ts                 # CHANGE — pass-through Store sessions (type conversion)
│   └── types.ts                 # CHANGE — public types add source
└── cli/
    └── commands/                # no changes needed (list/show/search/export go through the storage layer and benefit automatically)

tests/
├── unit/
│   ├── store-stack-paths.test.ts        # MD5(cwd) / sanitized
│   ├── store-stack-transcript.test.ts   # role-nested parsing + edge cases
│   └── store-stack-discover.test.ts
├── fixtures/
│   ├── transcripts/             # redacted real JSONL samples
│   └── store-db/                # contract fixtures (constructed minimal store.db, P2)
└── integration/
    └── store-stack-list-show.test.ts    # end-to-end: list/show in a Store-stack-only environment
```

**Structure Decision**: Add a new `store-stack/` submodule under the existing `src/core/` (peer to `storage.ts`/`parser.ts` but cohesive), rather than scattering changes — the Store stack data structures differ substantially from the Composer stack (role-nested vs bubble, different tool-name vocabulary, no KV table), so an independent module reduces coupling (constitution: GUI Extensible + simplicity). Integration points are concentrated in `storage.ts` (merge/dedup) and `parser.ts` (unified mapping); CLI commands need zero changes (they go through the storage layer and benefit automatically).

### Phased Delivery and Dependencies

- **P1 (MVP, unblocks the Issue #31 fix)**: `discover.ts` first registers `chats` and ACP session metadata, then attaches transcript JSONL messages using that metadata; it then flows through `storage.ts` merge/dedup → `parser.ts` mapping → `lib`/types source extension → tests (contract fixtures + redacted samples) → README.
  - On completion, `list`/`show`/`search`/`export` are usable for Store stack sessions (text + tool calls).
- **P2 (store-only fallback)**: after transcript discovery completes, `store-db.ts` (meta hex + blobs Merkle + leaf decoding) supplies messages only for sessions without a transcript. Transcript-backed sessions do not open `store.db`; this keeps the Issue #31 P1 path independent of best-effort P2 parsing.

### store.db Parser Design (P2)

`store.db` is evaluated only after transcript attachment and only for store-only sessions. It never enriches or replaces transcript-backed sessions, so P2 parsing cannot add SQLite work, warnings, or parse-risk to the P1 list/show/search/export path.

1. Open `store.db` read-only with the pluggable driver (006).
2. `meta`: `SELECT value FROM meta WHERE key='0'` → hex decode → UTF-8 → `JSON.parse` → extract `name/createdAt/latestRootBlobId/...`.
3. `blobs` Merkle traversal: take the root blob `data` from `latestRootBlobId` → scan protobuf frames (tag `0x0a`+`0x20`+32B = message leaf hash; `0x12`+`0x12`+32B = subtree hash) → recursively fetch leaves → attempt `JSON.parse` on leaf `data` (success = message; failure = gracefully handle per protobuf wire format or skip).
4. **Double-confirmation strategy for encoding uncertainty** (research §10.1.2):
   - Contract fixture: construct a minimal store.db per the hapi#824 DDL (known JSON leaves) to verify the parser reconstructs it correctly.
   - Real dump: a real store.db generated locally by the Issue author or after fixing the agent, to confirm the leaf encoding (JSON/protobuf/prefixed).
   - Any failure → degrade `source` to `'transcript'`, do not throw (defensive).

### Risks and Fallbacks

| Risk | Mitigation |
|---|---|
| store.db blob encoding does not match expectations | Double-confirmation + degrade to transcript layer (P1 already provides the floor, non-blocking) |
| store.db held by Cursor (WAL lock) | Read-only open + failure degradation; reference cursaves' temp-copy + WAL checkpoint pattern |
| Transcript format changes in the future | Tolerate and ignore unknown part types/fields (constitution V); format detection is extensible (hindsight: three shapes — flat/type-nested/role-nested) |
| Cross-stack dedup false positives | Strictly by session ID (uuid); no merge if IDs do not overlap (research §8) |
| `~/.cursor/` does not exist | Early existence check, skip the Store stack, no impact on the Composer stack |

## Complexity Tracking

No constitution violation; this section is empty.
