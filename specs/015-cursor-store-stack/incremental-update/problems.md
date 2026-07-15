# PR #32 Incremental Update: Problem Inventory

**Feature:** `015-cursor-store-stack`
**Baseline:** PR #32, commit `bf7d91f`
**Created:** 2026-07-15
**Status:** Active

## Purpose

This document is the canonical problem list for the incremental update to feature 015. The numbering below follows the current discussion and must remain stable in the later solution and task documents.

The basic Store-only `list`, `show`, `search`, and `export` path works. The remaining problems are mainly in cross-stack resolution, metadata preservation, command consistency, compatibility, fault isolation, and repeated discovery work.

## Problem Inventory

### P01 — Cross-stack deduplication can keep lower-fidelity data

When the same session ID exists in both the Composer and Store stacks, the current merge keeps the Composer entry because it is collected first. A Composer `workspace-fallback` session can therefore replace a Store transcript that contains more complete assistant messages and tool calls. The current result depends on insertion order instead of an explicit conflict policy.

**Impact:** A mixed-stack user may see an incomplete session even though a more complete representation exists on disk.

### P02 — Consecutive structured tool calls can be folded together

The CLI identifies consecutive duplicate messages using only `role` and `content`. Store transcripts may contain consecutive assistant messages with empty text but different structured tool calls. These messages are treated as duplicates, so later tool calls can disappear from normal output and `--only tool` output.

**Impact:** Tool history can be silently omitted from displayed sessions.

### P03 — Store exports can lose workspace and source metadata

Store sessions already carry `workspacePath` and `source`, but the CLI export path resolves workspace information through Composer workspaces only. A Store session can consequently be exported with `workspacePath: null`, and exported JSON does not currently preserve the session source.

**Impact:** Exported data can disagree with `list` and `show`, and consumers cannot reliably identify where a session came from.

### P04 — Store update timestamps are discarded

Store `meta.json` can provide `updatedAtMs`, but the Store session model carries only `createdAt`. The unified mapping then assigns `lastUpdatedAt = createdAt` even when Cursor supplied a distinct update time.

**Impact:** Session ordering, display, exports, and library results can report an incorrect last-update time.

### P05 — Transcript state and Store DB completeness are conflated

The current fallback decision uses parsed message count as a proxy for transcript presence. A missing transcript, an empty transcript, an error-only transcript, and an unsupported transcript can therefore enter the same path. Separately, an intentionally ignored valid Store DB leaf such as a `system` message is treated like an unparseable leaf and can mark an otherwise intact database as partial.

**Impact:** The reported source and completeness state may not describe the actual condition of the stored data.

### P06 — `list --workspaces` remains Composer-only

Normal session listing merges Store sessions, but workspace preflight and workspace aggregation still use the Composer `workspaceStorage` path. In a Store-only environment, `list --workspaces` can exit as if Cursor data were missing or return no Store workspaces.

**Impact:** Store support is inconsistent across two modes of the same command.

### P07 — Some Store custom-path forms are not resolved

Store discovery recognizes a Store root in limited forms. It does not consistently normalize a `chats` or `projects` subdirectory back to its Store root, and `CURSOR_DATA_PATH` is not treated as a Store-root candidate when no explicit CLI path is supplied.

**Impact:** Equivalent custom-path configurations can produce different discovery results.

### P08 — Structured tool display and serialization are incomplete

The Store structured-tool renderer truncates parameters regardless of the full-tool option and omits available status, result, error, and file information. JSON serializers omit supported `error` and `files` fields. Markdown export can also duplicate a tool when both embedded Composer text and structured tool data describe the same call.

**Impact:** Tool information can be incomplete, inconsistent between formats, or duplicated.

### P09 — Store DB parsing bypasses the shared SQLite layer

The Store DB parser loads `node:sqlite` directly instead of using the project database registry. It therefore ignores the configured SQLite driver and does not use the existing `better-sqlite3` fallback. It also copies only the main database file, so active WAL content may be absent from the parsed snapshot.

**Impact:** Store-only deep parsing can fail on supported Node versions, ignore user configuration, or read stale data.

### P10 — One unreadable transcript directory can abort discovery

Enumeration of an individual `agent-transcripts` directory is not isolated from filesystem errors. A permission failure or removal race can throw out of Store discovery instead of skipping only the affected directory.

**Impact:** One damaged or inaccessible project can prevent otherwise valid Store and Composer sessions from being listed.

### P11 — Top-level operations repeatedly parse the Store corpus

Store discovery eagerly parses every transcript. `getSession` first lists all sessions and then discovers Store sessions again. Search, export-all, and public library operations call this path repeatedly for each session, causing the full corpus to be scanned many times during one operation.

**Impact:** Work grows close to quadratically with the number of Store sessions and can become slow on real histories containing hundreds of sessions.

## Verification and Documentation Gaps

- PR #32 currently has no associated GitHub Actions run or commit status.
- Local type checking and linting pass, and the new Store-focused tests pass.
- The full test suite in the current Windows environment reports 697 passing and 5 failing tests. The failures concern existing custom `dataPath`/`globalStorage` and Windows file-URI behavior; their relationship to this PR has not been established.
- `git diff --check` reports trailing whitespace in several feature documents.
- Public README coverage for Store paths and configuration is missing.
- The implementation reads complete transcript files with `readFileSync().split(...)`, while the plan describes streaming, bounded-memory parsing.

## Current Discussion State

| Problem | State |
|---|---|
| P01–P04 | Initial direction provided; ready for ordered design and implementation |
| P05 | Deliberately deferred for further discussion |
| P06 | Initial architectural direction provided |
| P07–P08 | Problem confirmed; solution direction not discussed yet |
| P09–P11 | Retained for later discussion |
