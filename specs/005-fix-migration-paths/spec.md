# Feature Specification: Fix Migration File Path References

**Feature Branch**: `005-fix-migration-paths`
**Created**: 2025-12-25
**Status**: Draft
**Input**: User description: "Fix file path references not being updated when sessions are migrated between workspaces, with debug logging support"

## Problem Statement

When users migrate chat sessions between workspaces (using `migrate` or `migrate-session` commands), the file path references embedded in the session data are not updated to reflect the new workspace location. This causes Cursor to fail when trying to:
- Apply file changes (diffs) from migrated sessions
- Open files referenced in tool calls
- Navigate to file locations mentioned in the conversation

The root cause is that file paths are stored as absolute paths (e.g., `/Users/borui/Devs/project-a/src/file.ts`) in multiple locations within the session's bubble data, and the migration process only copies the data without updating these paths.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Move Session to New Workspace (Priority: P1)

A developer has a chat session in workspace A (`/Users/dev/projects/old-project`) that contains file edits and tool calls. They want to move this session to workspace B (`/Users/dev/projects/new-project`) so they can continue working on similar code in the new location.

**Why this priority**: This is the core bug fix - without it, migrated sessions with file changes are unusable. This affects both move and copy operations.

**Independent Test**: Migrate a session containing file edit operations from workspace A to workspace B, then view the session in the destination workspace. All file references should point to the destination workspace path.

**Acceptance Scenarios**:

1. **Given** a session in workspace A with file edits to `/old-project/src/app.ts`, **When** I migrate it to workspace B at `/new-project`, **Then** the file references should be updated to `/new-project/src/app.ts`

2. **Given** a session with tool calls referencing `/old-project/config.json`, **When** I move it to `/new-project`, **Then** the tool call parameters should reference `/new-project/config.json`

3. **Given** a session with code blocks containing file URIs, **When** I migrate it to a new workspace, **Then** all URI components (path, _formatted, _fsPath) should reflect the new workspace location

---

### User Story 2 - Copy Session Preserves Path Updates (Priority: P1)

A developer wants to duplicate a session to a different workspace while keeping the original intact. The copied session should have all file references updated to the destination workspace.

**Why this priority**: Copy mode is equally important as move mode - users expect both operations to produce functional sessions in the destination.

**Independent Test**: Copy a session with file operations from workspace A to workspace B, verify both the original (unchanged paths) and copy (updated paths) are correct.

**Acceptance Scenarios**:

1. **Given** a session in workspace A, **When** I copy it to workspace B, **Then** the original session retains its original file paths

2. **Given** a session in workspace A, **When** I copy it to workspace B, **Then** the copied session has all file paths updated to workspace B

---

### User Story 3 - Debug Mode for Troubleshooting (Priority: P1)

A developer or maintainer needs to diagnose migration issues by seeing detailed logs of what paths are being detected and transformed during migration.

**Why this priority**: Essential for development, testing, and troubleshooting. Debug logging enables confident implementation and helps users report issues with actionable details.

**Independent Test**: Run any migration command with `--debug` flag and verify detailed logs are shown including path transformations.

**Acceptance Scenarios**:

1. **Given** a migration command, **When** I add `--debug` flag, **Then** I see detailed logs of each bubble being processed

2. **Given** debug mode enabled, **When** a file path is updated, **Then** I see both the original and transformed path in the output

3. **Given** debug mode enabled, **When** paths outside the workspace are encountered, **Then** I see a log indicating they were skipped

4. **Given** no debug flag, **When** I run migration, **Then** only summary output is shown (no verbose logs)

---

### User Story 4 - Dry Run Shows Path Changes (Priority: P2)

A developer wants to preview what paths would change before committing to a migration.

**Why this priority**: Useful for confidence but not critical for the core fix.

**Independent Test**: Run migration with `--dry-run` flag and verify the output indicates file paths will be updated.

**Acceptance Scenarios**:

1. **Given** a session with file operations, **When** I run migrate with `--dry-run`, **Then** the preview should indicate that file paths will be updated to the destination workspace

---

### Edge Cases

- **Nested paths**: If the destination is a subdirectory of the source (e.g., `/project` to `/project/subdir`), the migration MUST error and abort to prevent data corruption from infinite replacement loops.
- **External paths**: File paths outside the source workspace root are silently preserved unchanged. Debug mode (FR-012) logs these for troubleshooting.
- What happens when file paths use different path separators (Windows vs Unix)?
- How should relative-looking paths that are actually absolute (like `relativeWorkspacePath` field) be handled?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST update `toolFormerData.params.relativeWorkspacePath` fields by replacing the source workspace prefix with the destination workspace prefix
- **FR-002**: System MUST update `toolFormerData.params.targetFile` fields by replacing the source workspace prefix with the destination workspace prefix
- **FR-003**: System MUST update `codeBlocks[].uri.path` fields by replacing the source workspace prefix with the destination workspace prefix
- **FR-004**: System MUST update `codeBlocks[].uri._formatted` fields to reflect the updated path
- **FR-005**: System MUST update `codeBlocks[].uri._fsPath` fields to reflect the updated path
- **FR-006**: System MUST preserve file paths that are outside the source workspace (do not modify paths that don't start with source workspace prefix)
- **FR-007**: System MUST handle path updates consistently for both move and copy operations
- **FR-008**: System MUST normalize path comparisons to handle trailing slashes and path separators correctly
- **FR-009**: System MUST support a `--debug` flag on migration commands that enables verbose logging
- **FR-010**: When debug mode is enabled, system MUST log each bubble ID being processed
- **FR-011**: When debug mode is enabled, system MUST log each path transformation showing "original -> new" format
- **FR-012**: When debug mode is enabled, system MUST log paths that are skipped (outside workspace) with reason
- **FR-013**: Debug output MUST be written to stderr to separate it from normal command output

### Key Entities

- **Bubble Data**: Individual message entries stored in globalStorage's cursorDiskKV table, containing tool calls and code blocks with embedded file paths
- **Tool Former Data**: Metadata about tool executions (read_file, apply_patch, write, edit_file) containing file path parameters
- **Code Blocks**: Code snippets with associated file URIs that link back to workspace files
- **Workspace Path**: The root directory path associated with a Cursor workspace

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of file paths within the source workspace prefix are correctly updated to the destination workspace after migration
- **SC-002**: Migrated sessions can be viewed and navigated without "file not found" errors when the destination workspace exists
- **SC-003**: File paths outside the source workspace remain unchanged after migration
- **SC-004**: Both move and copy operations produce functional sessions with correct file references
- **SC-005**: Debug mode provides sufficient information to diagnose path transformation issues without inspecting source code

## Clarifications

### Session 2025-12-25

- Q: What happens when the destination workspace path is a subdirectory of the source? → A: Error and abort migration (prevent data corruption)
- Q: How should files outside source workspace be handled during migration? → A: Silently preserve without warning (debug mode shows details)

## Assumptions

- The source and destination workspace paths are both absolute paths
- File paths stored in bubble data use forward slashes (even on Windows) for consistency
- The workspace root path can be reliably extracted from the workspace.json file
- Tool calls store file paths in a limited set of parameter field names (targetFile, relativeWorkspacePath, filePath, path)
- Implementation uses ES module imports (not CommonJS require) for consistency with existing codebase
