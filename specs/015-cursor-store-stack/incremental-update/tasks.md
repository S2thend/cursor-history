# PR #32 Incremental Update: Implementation Tasks

**Feature:** `015-cursor-store-stack`
**Created:** 2026-07-19
**Status:** Implemented and verified locally (pending commit)

## Constraints

- Keep all Store access read-only.
- Preserve current CLI and library function signatures for external callers.
- Do not add dependencies.
- Do not create another cross-stack conflict policy outside the existing merge layer.
- Add only the focused regression tests listed below.
- Do not commit automatically; request developer approval after all tasks and verification are complete.

## Completed Baseline

- [x] P01: cross-stack field and message merge — commit `cb65226`
- [x] P02: remove default consecutive-message folding — commit `cb65226`

## Task 1 — Normalize Store paths and isolate discovery failures

**Problems:** P07, P10

**Primary files:**

- `src/lib/platform.ts`
- `src/core/store-stack/discover.ts`
- `tests/unit/lib-platform.test.ts`
- `tests/unit/store-stack-discover.test.ts`

**Work:**

- [x] Add one Store-root resolver for explicit paths, environment paths, Store roots, and descendants under `chats`, `projects`, and `acp-sessions`.
- [x] Use the same resolver in `getStoreStackRoot()` and cross-stack preferred-source detection.
- [x] Replace unguarded Store directory enumeration with safe per-directory helpers and debug diagnostics.
- [x] Verify a Store root, `chats` descendant, `projects` descendant, and `CURSOR_DATA_PATH` resolve to the same root.
- [x] Verify one unreadable transcript directory does not hide a valid sibling session.

## Task 2 — Complete the asynchronous Store data model

**Problems:** P09, P05, P04

**Primary files:**

- `src/core/store-stack/store-db.ts`
- `src/core/store-stack/transcript.ts`
- `src/core/store-stack/discover.ts`
- `src/core/store-stack/types.ts`
- `src/core/parser.ts`
- `src/core/storage.ts`
- `src/core/store-stack/merge.ts`
- Store-focused unit and integration tests

**Work:**

- [x] Replace direct `node:sqlite` access with `backupDatabase()` plus `openDatabase()` and make Store DB parsing asynchronous.
- [x] Propagate asynchronous Store discovery through storage and tests.
- [x] Return explicit transcript parse state instead of inferring presence from message count.
- [x] Treat valid `system` leaves as intentionally ignored without marking the Store DB partial.
- [x] Add `lastUpdatedAt` to `StoreSession`; use valid `updatedAtMs`, otherwise `createdAt`.
- [x] Carry Store update time through summaries, full sessions, merge, JSON, Markdown, and library conversion.
- [x] Verify the configured `better-sqlite3` driver can parse the Store fixture.
- [x] Verify a WAL-backed source snapshot exposes the latest committed content.
- [x] Verify parsed, partial, empty/error-only, missing, unsupported, and unreadable transcript states do not collapse into one state.
- [x] Verify update-time preservation and the creation-time fallback.

## Task 3 — Reuse one resolved session context and aggregate workspaces

**Problems:** P11, P06

**Primary files:**

- `src/core/storage.ts`
- `src/core/types.ts`
- `src/cli/commands/list.ts`
- `src/lib/index.ts`
- `tests/unit/storage.test.ts`
- `tests/unit/cli-commands.test.ts`

**Work:**

- [x] Add an internal operation-scoped `SessionReadContext` containing cached Store sessions and current summaries.
- [x] Reuse it in search, library listing, CLI export-all, and library export-all.
- [x] Resolve looped sessions by ID and known summary without rediscovering the Store corpus.
- [x] Build `listWorkspaces()` from deduplicated session summaries and group by normalized final workspace path.
- [x] Make workspace preflight accept either a Composer root or Store root.
- [x] Verify Store-only, Composer-only, and mixed-stack workspace counts.
- [x] Instrument one multi-session operation and verify Store discovery runs once, including concurrent readers.

## Task 4 — Export the resolved session consistently

**Problem:** P03

**Primary files:**

- `src/cli/commands/export.ts`
- `src/core/parser.ts`
- `src/lib/index.ts`
- Export and parser tests

**Work:**

- [x] Use `workspace?.path ?? session.workspacePath` for CLI exports.
- [x] Make JSON and Markdown exporters fall back to `session.workspacePath` themselves.
- [x] Preserve single-source and merged provenance in JSON and Markdown.
- [x] Reuse the Task 3 context for export-all instead of rediscovering sessions.
- [x] Verify single and all-session JSON/Markdown exports for a Store-only session; keep Composer output compatible.

## Task 5 — Complete structured-tool output

**Problem:** P08

**Primary files:**

- `src/cli/formatters/table.ts`
- `src/cli/formatters/json.ts`
- `src/core/parser.ts`
- Focused formatter and parser tests

**Work:**

- [x] Add one shared serializer for all defined `ToolCall` fields.
- [x] Keep normal display concise and make `--tool` show full params, status, result, error, and files.
- [x] Use the shared serializer in CLI JSON and export JSON.
- [x] Prevent Markdown from emitting a duplicate structured tool already represented by embedded Composer tool text.
- [x] Verify one complete successful call, one error call, one embedded Composer call, and an additional merged call.

## Review Follow-up Corrections

- [x] Reject ordinary `projects`/`chats` ancestors during Store-root discovery while accepting an explicitly supplied Store child path.
- [x] Add `partial` transcript state for valid messages mixed with malformed or unsupported lines.
- [x] Select duplicate-UUID transcripts atomically so messages, state, and path stay from one source.
- [x] Preserve transcript state through summaries, full sessions, merge, CLI/export JSON, Markdown, and the library API.
- [x] Normalize Windows workspace separators and case before aggregation.
- [x] Bind read contexts to one data source and share in-flight Store and Composer discovery.
- [x] Remove implementation problem numbers from source and test comments.
- [x] Decode current protobuf assistant nodes, recognize `tool-call`, and join standalone `tool-result` blobs by `toolCallId`.
- [x] Treat a keyed tool-result leaf consumed by its matching call as complete while leaving unkeyed or unmatched results partial.
- [x] Add a full Composer-global SQLite + Store transcript integration fixture for the same session ID.
- [x] Normalize Store `<user_query>` wrappers during alignment and merge Composer synthetic tool markers with the matching Store natural-language tool turn.
- [x] Replace five POSIX-only custom-path/file-URI assertions with native cross-platform expectations.

## Final Review Follow-up

- [x] P13: align `spec.md`, `data-model.md`, and README with transcript-authoritative, Store-fallback-only behavior.
- [x] P14: add a failing mixed assistant/tool filter regression, then implement multi-category filter membership without changing the primary display label.
- [x] Document Store paths, relevant environment variables, Windows/WSL usage, and native dependency limitations without automatic dependency mutation.
- [x] Clarify the canonical main-transcript path, keep subagent transcripts separate, require reliable workspace paths instead of reversing lossy directory names, and align ACP's low-priority compatibility status across the spec and research.
- [x] Show the remaining metadata limitations for `store` and `store-complete` sessions instead of implying that a complete Store DB provides tokens or per-message timestamps.
- [x] Normalize pure numeric strings at the library boundary so retrieval and both export formats use the documented zero-based index semantics, including workspace-scoped lookup.
- [x] Run the focused regressions, full Windows gates, both SQLite drivers, and package dry runs. The shared Windows `node_modules` mismatch was confirmed as environmental; a fresh isolated WSL install and full suite now pass.
- [ ] Do not add or commit Superpowers planning documents; do not commit any implementation without explicit developer approval.

## P15 — store.db primary source (transcript fallback)

- [x] Translate `research-store-db-vs-transcript.md` to English, preserving all evidence, links, code samples, and conclusions (no change to research meaning).
- [x] Reverse the Store source-selection order in `src/core/store-stack/discover.ts`: a present `store.db` is parsed first; when it yields ≥1 message (complete or partial) its messages win and the transcript does not participate; DB metadata is adopted whenever the DB parses; the transcript fills in only when the DB is absent, unreadable, or empty.
- [x] Add internal diagnostics-only `StoreDbState` and `TranscriptUse` types to `src/core/store-stack/types.ts` and emit the resolution reason via `debugLogStorage`.
- [x] Update `source` semantics doc in `src/core/types.ts`, `src/lib/types.ts`, and `src/core/store-stack/types.ts`; update module header comments in `discover.ts` and `store-db.ts`.
- [x] Rewrite the `store-stack-discover.test.ts` regression block from "transcript authoritative" to "store.db authoritative (P15)": complete-DB-wins, complete-DB-over-partial-transcript, partial-DB-wins (`store-partial`), empty-DB → transcript fallback (DB metadata retained), unreadable-DB → transcript fallback, and accurate empty/degraded sources when no transcript fallback exists. Update the stale `store-stack-store-db.test.ts` describe label.
- [x] Update `spec.md` (US3, FR-020/021/031, store.db entity), `data-model.md`, `plan.md` (superseded note at the P2 decision; history preserved), `contracts/cli-api.md`, `contracts/library-api.md`, and `README.md` to DB-first semantics.
- [x] Append P15 to `problems.md` and `solutions.md`, preserving the completed P13 history; do not overwrite existing user edits to `problems.md` / `solutions.md` / `quickstart.md`.
- [x] Keep `store.db` DAG decoding rules unchanged; add no CLI params, public parse state, or migration steps.

## Final Verification

- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run the focused Store, storage, formatter, export, and library tests changed by these tasks.
- [x] Run `npm test`; fix the five Windows custom-path/file-URI test failures and verify the complete Windows suite.
- [x] Run `npm run build`.
- [x] Run `git diff --check` for the incremental change.
- [x] Update `solutions.md` statuses to Implemented/Verified only after the matching checks pass.
- [x] Run the complete Windows Node 24 suite: 29 files and 811 tests pass after the P15 source-resolution regressions were added.
- [x] Run the complete Windows Node 20 fallback suite before the latest two integration cases were added: 28 files, 788 tests pass, and the unavailable `node:sqlite` driver test is skipped as expected; `better-sqlite3` ABI 115 read/write succeeds. A current Node 20 runtime is not installed in this checkout's Windows environment, so the new cases remain covered by the current Windows and isolated WSL Node 24 runs rather than being claimed as rerun on Node 20.
- [x] Run the complete Ubuntu WSL Node 24 isolated suite from a fresh install: 29 files and 808 tests pass; typecheck, lint, format check, and build are clean. This WSL checkpoint immediately predates the final platform-neutral Library error-semantics correction and expanded assertions, which were rerun through the current full Windows suite only.
- [x] Pin Prettier 3.9.5 in `package.json` and `package-lock.json` so fresh Windows/WSL installs use the same formatter implementation.
- [x] Verify the reporting WSL Store session with both SQLite drivers: `Grep` retains params, result, status, and files, and the Store DB is complete.
- [x] Verify real WSL discovery from the Store root, `chats`, `projects`, `CURSOR_DATA_PATH`, and the mounted Windows Composer path.
- [x] Verify real WSL search, workspace aggregation, single JSON/Markdown export, and 10-session export-all.
- [x] Verify real Windows merged data (`48/50` sampled sessions merged). The mounted Windows Composer and WSL Store datasets have no overlapping IDs, so their combined WSL listing correctly remains single-source; merged behavior is covered by the real Windows run and the hybrid SQLite/Store fixture.
