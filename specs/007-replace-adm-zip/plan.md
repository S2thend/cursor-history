# Implementation Plan: Replace adm-zip with ESM-Compatible Alternative

**Branch**: `007-replace-adm-zip` | **Date**: 2026-01-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-replace-adm-zip/spec.md`

## Summary

Replace the adm-zip dependency with jszip to resolve ESM bundling failures on Node.js v24+. The adm-zip library uses dynamic `require()` calls that Node.js v24 rejects in ESM contexts. jszip is a pure JavaScript implementation with proper ESM support that will enable downstream packages to bundle cursor-history as ESM format.

**Technical Approach**: Replace all `AdmZip` usage with jszip's Promise-based API, converting synchronous operations to async where needed. Maintain identical zip file structure and backwards compatibility.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode enabled)
**Primary Dependencies**: jszip (replacing adm-zip), commander, picocolors, better-sqlite3/node:sqlite
**Storage**: SQLite databases (state.vscdb), zip archives for backup
**Testing**: Vitest (test structure exists but no tests implemented yet)
**Target Platform**: Node.js 20 LTS+, cross-platform (macOS, Windows, Linux)
**Project Type**: Single project - CLI tool + library
**Performance Goals**: No regression beyond 10% for backup operations under 100MB
**Constraints**: Must work in both ESM and CommonJS contexts; backwards compatible with existing backup files
**Scale/Scope**: CLI tool for local use, typical backups <100MB with <100 workspace databases

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Simplicity First | ✅ PASS | Direct 1:1 library replacement, minimal code changes |
| II. CLI-Native Design | ✅ PASS | No change to CLI interface |
| III. Documentation-Driven | ✅ PASS | CHANGELOG update required for dependency change |
| IV. Incremental Delivery | ✅ PASS | Single focused PR with one concern |
| V. Defensive Parsing | ✅ PASS | Error handling for corrupt zips preserved |

**Technical Standards Check**:
- TypeScript strict mode: ✅ Maintained
- Minimize dependencies: ✅ jszip replaces adm-zip (no net increase)
- GUI Extensibility: ✅ No impact on core logic decoupling

## Project Structure

### Documentation (this feature)

```text
specs/007-replace-adm-zip/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (N/A - no new entities)
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (N/A - no API changes)
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── backup.ts        # PRIMARY: Replace AdmZip usage (6 instances)
│   ├── storage.ts       # SECONDARY: Replace AdmZip usage (1 instance)
│   └── database/        # No changes needed
├── cli/
│   └── commands/        # No changes needed
└── lib/
    └── index.ts         # No changes needed (exports remain same)

tests/
└── unit/
    └── backup/          # NEW: Add backup tests for jszip migration
```

**Structure Decision**: Single project structure maintained. Changes isolated to `src/core/backup.ts` and `src/core/storage.ts`. No structural changes to the codebase.

## Complexity Tracking

> No constitution violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A | N/A | N/A |

## Implementation Notes

### Key API Differences: adm-zip → jszip

| adm-zip (sync) | jszip (async) | Notes |
|----------------|---------------|-------|
| `new AdmZip()` | `new JSZip()` | Same pattern |
| `new AdmZip(path)` | `JSZip.loadAsync(buffer)` | Must read file first |
| `zip.addLocalFile(path, dir, name)` | `zip.file(path, content)` | Must read file content |
| `zip.addFile(name, buffer)` | `zip.file(name, buffer)` | Same pattern |
| `zip.readFile(path)` | `zip.file(path).async('nodebuffer')` | Async extraction |
| `zip.writeZip(path)` | `zip.generateAsync({type:'nodebuffer'})` | Then fs.writeFile |

### Functions Requiring Changes

1. **backup.ts**:
   - `createBackup()` - Already async, add jszip operations
   - `openBackupDatabase()` - Sync → Async (breaking change to signature)
   - `readBackupManifest()` - Sync → Async (breaking change to signature)
   - `validateBackup()` - Sync → Async (breaking change to signature)
   - `restoreBackup()` - Already sync but uses zip, convert to async
   - `listBackups()` - Calls readBackupManifest, needs async handling

2. **storage.ts**:
   - `readWorkspaceJsonFromBackup()` - Sync → Async
   - `findWorkspacesFromBackup()` - Already async, minor changes

### Breaking Changes

The following functions will change from sync to async:
- `openBackupDatabase()` → `openBackupDatabaseAsync()` (or update callers)
- `readBackupManifest()` → async
- `validateBackup()` → async

Since these are internal core functions, the library API (`src/lib/index.ts`) may need updates if it exposes them directly.
