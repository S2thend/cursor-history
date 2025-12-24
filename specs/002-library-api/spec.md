# Feature Specification: Library API for Cursor History Access

**Feature Branch**: `002-library-api`
**Created**: 2025-12-22
**Status**: Draft
**Input**: User description: "Make cursor-history a library for accessing cursor history"

**IMPORTANT**: This is a **library interface** for direct import and use in TypeScript/JavaScript projects, NOT a network/REST API. Developers will import functions directly: `import { listSessions } from 'cursor-history'`

## Clarifications

### Session 2025-12-22

- Q: Database Connection Lifecycle → A: Auto-close connections after each API call (stateless) - library opens/closes database for every operation
- Q: Error Handling Strategy for Locked Database Files → A: Throw descriptive error immediately when database is locked, allowing developers to implement their own retry logic
- Q: API Surface Design Pattern → A: Functional exports (named functions) - `listSessions(config?)`, `getSession(index, config?)`
- Q: Pagination Strategy for Large Result Sets → A: Cursor-based pagination with limit/offset - `listSessions({limit: 50, offset: 0})`
- Q: Handling Corrupted Database Entries → A: Skip corrupted entries and log warnings, continue processing valid entries
- Q: Default Data Path Configuration → A: Library uses platform-specific default Cursor data paths (same as CLI) but accepts optional `dataPath` in config for custom installations

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Programmatic Access to Chat Sessions (Priority: P1)

Developers need to programmatically access Cursor chat history from their own applications without using the CLI, enabling integration into custom tools, analytics dashboards, or automation workflows.

**Why this priority**: This is the core value proposition - exposing existing functionality as a reusable library. Without this, developers are forced to use the CLI or duplicate the database reading logic.

**Independent Test**: Can be fully tested by importing the library, calling `listSessions()`, and verifying it returns the same data as the CLI `list` command. Delivers immediate value for developers who need session metadata.

**Acceptance Scenarios**:

1. **Given** a developer has installed the library, **When** they import and call `listSessions()`, **Then** they receive an array of chat sessions with metadata (workspace, timestamp, message count)
2. **Given** a developer wants session details, **When** they call `getSession(index)`, **Then** they receive the full chat session with all messages and metadata
3. **Given** a developer needs to filter by workspace, **When** they call `listSessions({workspace: '/path'})`, **Then** only sessions from that workspace are returned

---

### User Story 2 - Search Functionality (Priority: P2)

Developers need to programmatically search across chat history to find specific conversations, errors, or code patterns for analysis or debugging purposes.

**Why this priority**: Builds on P1 by adding search capabilities. Useful for analytics and debugging, but sessions can still be accessed without search.

**Independent Test**: Can be tested by calling `searchSessions(query)` and verifying results match the CLI `search` command output. Delivers value for developers building search or analytics features.

**Acceptance Scenarios**:

1. **Given** a developer wants to find conversations, **When** they call `searchSessions(query)`, **Then** they receive matching sessions with context snippets
2. **Given** a developer specifies context lines, **When** they call `searchSessions(query, {context: N})`, **Then** results include N lines of surrounding context
3. **Given** no matches exist, **When** search is performed, **Then** an empty array is returned without errors

---

### User Story 3 - Export and Format Conversion (Priority: P3)

Developers need to export chat sessions in various formats (JSON, Markdown) for archival, sharing, or processing with other tools.

**Why this priority**: Useful for backup and integration scenarios, but not essential for basic library usage. Can be achieved by manually formatting the session data returned from P1.

**Independent Test**: Can be tested by calling `exportSession(index, format)` and verifying the output matches CLI export format. Delivers value for backup and integration workflows.

**Acceptance Scenarios**:

1. **Given** a developer wants JSON export, **When** they call `exportSession(index, 'json')`, **Then** they receive a JSON string representation of the session
2. **Given** a developer wants Markdown export, **When** they call `exportSession(index, 'markdown')`, **Then** they receive a formatted markdown document
3. **Given** a developer wants to export all sessions, **When** they call `exportAllSessions(format)`, **Then** all sessions are exported in the specified format

---

### User Story 4 - Custom Data Path Configuration (Priority: P2)

Developers need to specify custom Cursor data paths to support non-standard installations, testing scenarios, or accessing multiple Cursor profiles.

**Why this priority**: Important for flexibility and testing, but most users will use the default path. Supports advanced use cases.

**Independent Test**: Can be tested by initializing the library with a custom path and verifying it reads from that location instead of the default. Delivers value for advanced users and testing scenarios.

**Acceptance Scenarios**:

1. **Given** a developer has a custom Cursor installation, **When** they call `listSessions({dataPath: '/custom/path'})`, **Then** the library reads from the specified path
2. **Given** an invalid path is provided, **When** API functions are called with that path, **Then** a clear error is thrown indicating the path issue
3. **Given** no custom path is specified, **When** API functions are called without config, **Then** they use the platform-default Cursor data path

---

### Edge Cases

- What happens when Cursor database files are locked or in use by Cursor? → Library throws a descriptive error immediately (e.g., `DatabaseLockedError`) without automatic retries, allowing developers to implement their own retry strategy
- How does the library handle corrupted or incomplete database entries? → Library skips corrupted entries, logs warnings to console, and continues processing valid entries without throwing errors
- What happens when workspace paths contain special characters or are symlinks?
- How does the library behave when run on unsupported platforms?
- What happens when attempting to access sessions from very old Cursor versions with different schema?
- How are large sessions (thousands of messages) handled for memory efficiency? → Pagination support via `limit` and `offset` parameters allows developers to retrieve sessions in manageable chunks

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Library MUST expose all core functionality currently available in the CLI (list, show, search, export)
- **FR-002**: Library MUST provide TypeScript type definitions for all public APIs and data structures
- **FR-003**: Library MUST support configuration via options object (custom data path, workspace filtering)
- **FR-004**: Library MUST return structured data (objects/arrays) instead of formatted strings
- **FR-005**: Library MUST handle database access errors gracefully with descriptive error messages, throwing specific error types (e.g., DatabaseLockedError, DatabaseNotFoundError) without automatic retries
- **FR-006**: Library MUST be usable as both CommonJS and ES modules
- **FR-007**: Library MUST not depend on CLI-specific dependencies (commander, picocolors for output)
- **FR-008**: Library MUST preserve all data from the current storage layer without loss
- **FR-009**: Library MUST support read-only access (no modification of Cursor databases)
- **FR-010**: Library MUST work on the same platforms as the current CLI (Windows, macOS, Linux)
- **FR-011**: Library MUST provide pagination or streaming options for large result sets using limit/offset parameters (e.g., `{limit: 50, offset: 0}`)
- **FR-012**: Library MUST allow consumers to implement their own formatters/presenters
- **FR-013**: Library MUST use stateless API design - database connections are opened and closed automatically for each API call, requiring no manual connection management
- **FR-014**: Library MUST expose functionality as named function exports (e.g., `listSessions(config?)`, `getSession(index, config?)`) rather than class-based or factory patterns
- **FR-015**: Library MUST handle corrupted database entries gracefully by skipping them, logging warnings to console, and continuing to process valid entries
- **FR-016**: Library MUST use platform-specific default paths for Cursor data (matching CLI behavior) when no `dataPath` config is provided, and accept optional `dataPath` parameter for custom installations

### Key Entities

- **API Functions**: Named function exports providing stateless access to cursor history (e.g., `listSessions`, `getSession`, `searchSessions`, `exportSession`)
- **Session**: Represents a chat conversation with metadata (workspace, timestamp, messages)
- **Message**: Individual message in a session (user/assistant, content, timestamp, tool calls, thinking)
- **SearchResult**: Search match with session reference, matched content, and optional context
- **LibraryConfig**: Configuration options for library initialization (data path, workspace filters)

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Developers can retrieve all chat sessions with fewer than 5 lines of code
- **SC-002**: Library handles sessions with 1000+ messages without memory issues or performance degradation
- **SC-003**: TypeScript autocomplete works for all public APIs in major IDEs (VS Code, WebStorm)
- **SC-004**: Library can be installed and used in Node.js projects within 2 minutes (install + first API call)
- **SC-005**: All CLI functionality is available through library APIs with feature parity
- **SC-006**: Library exports are properly tree-shakeable, allowing consumers to import only needed functionality

## Assumptions *(mandatory)*

- Cursor's database schema remains consistent with current implementation (state.vscdb structure)
- Library will be published to npm as a separate package or as part of cursor-history with dual CLI/library mode
- Developers using the library have Node.js >= 16 (same as current CLI requirements)
- Library consumers are familiar with async/await patterns for database operations
- Default behavior matches CLI behavior (e.g., workspace detection, path resolution)
- Library will use the same better-sqlite3 dependency for database access
- No real-time streaming of live chat sessions is required (snapshot-based access only)

## Dependencies *(include if feature relies on external factors)*

- **better-sqlite3**: Required for SQLite database access (existing dependency)
- **Node.js File System APIs**: For path resolution and file access
- **Existing storage.ts and parser.ts modules**: Will be refactored to separate business logic from CLI presentation

## Out of Scope *(include if boundaries need clarification)*

- **Write operations**: Library will not support modifying, deleting, or creating chat sessions
- **Real-time updates**: No event listeners or watchers for database changes
- **Authentication/Authorization**: No access control (relies on filesystem permissions)
- **Database migration**: No automatic handling of schema changes between Cursor versions
- **CLI removal**: The CLI tool will remain functional and use the library internally
- **Browser support**: Library is Node.js-only, not for browser environments
- **Alternative storage formats**: Only supports current SQLite-based Cursor storage
