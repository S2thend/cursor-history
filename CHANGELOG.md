# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **Timestamp fallback for pre-2025-09 sessions** ([#13](https://github.com/S2thend/cursor-history/issues/13)): Messages from sessions created before September 2025 no longer display the current time. The system now extracts timestamps from `timingInfo.clientRpcSendTime` (available on old-format assistant messages), interpolates timestamps for user messages from neighboring assistant messages, and falls back to session creation time when no per-message timestamps exist.
