# Feature Specification: Replace adm-zip with ESM-Compatible Alternative

**Feature Branch**: `007-replace-adm-zip`
**Created**: 2026-01-03
**Status**: Draft
**Input**: GitHub Issue #8 - adm-zip dynamic require breaks ESM bundling on Node.js v24+

## User Scenarios & Testing

### User Story 1 - Downstream Package ESM Bundling (Priority: P1)

As a developer building an application that depends on cursor-history and bundles it for distribution (like cursor-history-mcp), I want the library to work when bundled as ESM format so that I can distribute modern ESM packages that work on Node.js v24+.

**Why this priority**: This is the core problem reported in the issue. Without this, downstream packages cannot use ESM output format on Node.js v24+, forcing them to use CommonJS which contradicts modern ESM-first development practices.

**Independent Test**: Can be fully tested by bundling cursor-history into an ESM package using tsup/esbuild and running it on Node.js v24+. Success means no "Dynamic require of 'fs' is not supported" errors.

**Acceptance Scenarios**:

1. **Given** a downstream package that depends on cursor-history with `noExternal: [/.*/]` bundler config, **When** bundled as ESM format and executed on Node.js v24+, **Then** all backup-related operations work without dynamic require errors.

2. **Given** cursor-history is imported as `import { createBackup } from 'cursor-history'`, **When** the createBackup function is called in an ESM context, **Then** the backup zip file is created successfully.

---

### User Story 2 - Existing Backup Functionality Preservation (Priority: P1)

As an existing cursor-history user, I want all backup operations (create, restore, validate, list) to continue working exactly as before so that my existing workflows are not disrupted.

**Why this priority**: Equal priority to P1 because breaking existing functionality would be unacceptable. The migration must be transparent to users.

**Independent Test**: Can be fully tested by running the existing test suite and manually testing all backup commands (`cursor-history backup`, restore, validate, list).

**Acceptance Scenarios**:

1. **Given** a Cursor data directory with chat history, **When** I run `cursor-history backup`, **Then** a valid backup zip file is created with manifest.json and all database files.

2. **Given** a valid backup zip file, **When** I run `cursor-history restore <backup-file>`, **Then** all files are extracted to the correct locations with verified checksums.

3. **Given** a backup zip file, **When** I run `cursor-history backup validate <backup-file>`, **Then** the manifest is read and all file checksums are verified correctly.

4. **Given** a backup directory, **When** I run `cursor-history backup list`, **Then** all zip files are enumerated with their manifest information.

---

### User Story 3 - Backup Data Source Operations (Priority: P2)

As a user browsing history from a backup file, I want to list and view sessions from backup files so that I can access historical data without restoring.

**Why this priority**: Lower priority than core backup operations but still essential for the complete feature set. Uses zip reading functionality.

**Independent Test**: Can be tested by running `cursor-history list --backup <file>` and `cursor-history show 1 --backup <file>` against a backup archive.

**Acceptance Scenarios**:

1. **Given** a valid backup zip file, **When** I run `cursor-history list --backup <file>`, **Then** all sessions from workspace databases inside the backup are listed.

2. **Given** a valid backup zip file, **When** I run `cursor-history show 1 --backup <file>`, **Then** the session content is displayed correctly from the backup.

---

### Edge Cases

- What happens when the new library encounters a corrupted zip file? Should return meaningful error message, not crash.
- What happens when a zip file created by the old adm-zip library is read by the new library? Must be fully backwards compatible.
- What happens when reading very large backup files (>1GB)? Should handle memory efficiently without exhausting heap.
- What happens when a file path in the zip uses Windows-style separators on Unix or vice versa? Cross-platform path handling must work correctly.
- What happens when concurrent backup operations attempt to write to the same output file? Should fail gracefully with clear error.

## Requirements

### Functional Requirements

- **FR-001**: System MUST replace adm-zip with an ESM-compatible zip library that does not use dynamic require() calls
- **FR-002**: System MUST support creating zip archives with the same file structure as before (manifest.json, database files in nested directories)
- **FR-003**: System MUST support reading/extracting files from zip archives by path
- **FR-004**: System MUST support adding files to zip archives from local filesystem paths
- **FR-005**: System MUST support adding files to zip archives from Buffer content
- **FR-006**: System MUST support writing complete zip archives to disk
- **FR-007**: System MUST handle cross-platform path separators in zip entries (forward slashes inside zip, platform-specific outside)
- **FR-008**: System MUST read zip archives created by the previous adm-zip implementation (backwards compatibility)
- **FR-009**: Backup creation MUST produce identical zip structure to current implementation
- **FR-010**: System MUST work in both ESM and CommonJS module contexts

### Key Entities

- **Backup Archive**: A zip file containing manifest.json and database files (state.vscdb) in directory structure mirroring Cursor's storage layout
- **Manifest**: JSON file at zip root describing backup contents including file paths, checksums, creation timestamp, and statistics
- **Database Files**: SQLite files stored at paths like `globalStorage/state.vscdb` and `workspaceStorage/{id}/state.vscdb`

## Success Criteria

### Measurable Outcomes

- **SC-001**: All existing backup-related tests pass without modification to test logic (import changes allowed)
- **SC-002**: Downstream packages can bundle cursor-history as ESM and execute on Node.js v24+ without dynamic require errors
- **SC-003**: Backup files created by the new implementation can be read by cursor-history versions using adm-zip (forwards compatibility)
- **SC-004**: Backup files created by previous adm-zip versions can be read by the new implementation (backwards compatibility)
- **SC-005**: No increase in backup creation time beyond 10% for typical backup sizes (under 100MB)

## Assumptions

- jszip is selected as the replacement library based on the issue recommendation (pure JavaScript, actively maintained, ESM-compatible)
- jszip's Promise-based API is acceptable; synchronous operations in current code will be converted to async where needed
- The backup.ts and storage.ts files are the only files requiring changes
- The existing test coverage for backup operations is sufficient to validate the migration

## Out of Scope

- Changing the backup file format or manifest structure
- Adding new backup features beyond what currently exists
- Supporting additional zip libraries or making the zip library pluggable
- Performance optimizations beyond maintaining current performance levels
