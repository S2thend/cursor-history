# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **Session data integrity**: `getSession()` and `getGlobalSession()` now preserve empty bubbles as `[empty message]`, retain malformed global rows as `[corrupted message]` placeholders with `metadata.corrupted = true`, and populate `message.metadata.bubbleType` when the source bubble type is known.
- **Structured tool call recovery**: `message.toolCalls` is now populated from `toolFormerData`, including default `completed` status handling and `{ _raw: ... }` sentinels when tool params contain invalid JSON.
- **Degraded session signaling**: Sessions now expose `source: 'global' | 'workspace-fallback'`, the library threads it through, CLI JSON includes it, and `show` warns when output is coming from workspace fallback data.
- **Global load diagnostics**: Fallbacks no longer fail silently. Storage-level debug logs now distinguish missing global DBs, missing `cursorDiskKV`, zero-bubble composers, query/open failures, and malformed bubble rows.

## [0.11.2] - 2026-02-20

### Changed

- **Improved test coverage for `src/core/`**: Added 31 tests for `extractTokenUsage`, `extractContextWindowStatus`, `extractPromptDryRunInfo`, and `extractSessionUsage`. Core statement coverage raised from 77.39% to 82.13%, now passing the 80% threshold.
- **Code formatting**: Applied Prettier formatting across all source and test files.

## [0.11.1] - 2026-02-20

### Fixed

- **Timestamp fallback for pre-2025-09 sessions** ([#13](https://github.com/S2thend/cursor-history/issues/13)): Messages from sessions created before September 2025 no longer display the current time. The system now extracts timestamps from `timingInfo.clientRpcSendTime` (available on old-format assistant messages), interpolates timestamps for user messages from neighboring assistant messages, and falls back to session creation time when no per-message timestamps exist.
