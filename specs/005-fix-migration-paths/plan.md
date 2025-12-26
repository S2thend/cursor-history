# Implementation Plan: Fix Migration File Path References

**Branch**: `005-fix-migration-paths` | **Date**: 2025-12-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-fix-migration-paths/spec.md`

## Summary

Fix file path references in migrated sessions by updating absolute paths in bubble data during migration. The `copyBubbleDataInGlobalStorage()` function currently only updates bubble IDs but leaves file paths pointing to the source workspace. This change adds path transformation for all file references (toolFormerData.params, codeBlocks[].uri) and includes debug logging for troubleshooting.

## Technical Context

**Language/Version**: TypeScript 5.0+ (strict mode enabled)
**Primary Dependencies**: better-sqlite3, commander, picocolors
**Storage**: SQLite (globalStorage/state.vscdb, workspaceStorage/*/state.vscdb)
**Testing**: Vitest (unit/integration tests)
**Target Platform**: Node.js 20 LTS (cross-platform: macOS, Windows, Linux)
**Project Type**: Single project (CLI + library)
**Performance Goals**: N/A (batch migration, not latency-sensitive)
**Constraints**: Must use ES module imports; must not break existing migration functionality
**Scale/Scope**: Handles sessions with thousands of bubbles

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Simplicity First | ✅ PASS | Single function enhancement in existing module; no new dependencies |
| II. CLI-Native Design | ✅ PASS | Debug output to stderr; existing --dry-run flag enhanced |
| III. Documentation-Driven | ✅ PASS | Debug logging aids troubleshooting; spec includes acceptance scenarios |
| IV. Incremental Delivery | ✅ PASS | Core fix + debug logging are independently testable |
| V. Defensive Parsing | ✅ PASS | Preserves external paths; handles missing fields gracefully |

## Project Structure

### Documentation (this feature)

```text
specs/005-fix-migration-paths/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── migrate.ts       # MODIFY: Add path transformation in copyBubbleDataInGlobalStorage
│   └── types.ts         # MODIFY: Add debug option to migration types
├── cli/
│   └── commands/
│       ├── migrate.ts         # MODIFY: Add --debug flag
│       └── migrate-session.ts # MODIFY: Add --debug flag
└── lib/
    └── platform.ts      # EXISTING: normalizePath, pathsEqual utilities

tests/
├── unit/
│   └── migrate-paths.test.ts  # NEW: Unit tests for path transformation
└── integration/
    └── migrate-debug.test.ts  # NEW: Integration tests for debug output
```

**Structure Decision**: Single project structure maintained. Changes are confined to existing core/migrate.ts with minimal CLI command updates.

## Complexity Tracking

No complexity violations. All changes follow the simplest solution pattern:
- Path transformation is string prefix replacement (simple)
- Debug logging uses stderr (standard)
- No new abstractions or patterns introduced
