# Changelog

All notable changes to this project will be documented in this file.

## [0.11.2] - 2026-02-20

### Changed

- **Improved test coverage for `src/core/`**: Added 31 tests for `extractTokenUsage`, `extractContextWindowStatus`, `extractPromptDryRunInfo`, and `extractSessionUsage`. Core statement coverage raised from 77.39% to 82.13%, now passing the 80% threshold.
- **Code formatting**: Applied Prettier formatting across all source and test files.

## [0.11.1] - 2026-02-20

### Fixed

- **Timestamp fallback for pre-2025-09 sessions** ([#13](https://github.com/S2thend/cursor-history/issues/13)): Messages from sessions created before September 2025 no longer display the current time. The system now extracts timestamps from `timingInfo.clientRpcSendTime` (available on old-format assistant messages), interpolates timestamps for user messages from neighboring assistant messages, and falls back to session creation time when no per-message timestamps exist.
