# Feature Specification: Pluggable SQLite Driver

**Feature Branch**: `006-pluggable-sqlite-driver`
**Created**: 2026-01-02
**Status**: Draft
**Input**: User description: "Make SQLite database driver configurable and hot-pluggable to support multiple drivers (better-sqlite3, node:sqlite, sql.js) for Node.js version compatibility"

## Clarifications

### Session 2026-01-02

- Q: How should the library handle node:sqlite's experimental flag requirement (Node 22.5-23.x)? → A: Auto-detect by attempting import, fall back silently if unavailable
- Q: How should the library provide visibility into driver selection? → A: Debug mode logging (via DEBUG/CURSOR_HISTORY_DEBUG env var) + API function, with manual override support

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Driver Selection (Priority: P1)

As a user running cursor-history on different Node.js versions, I want the library to automatically select a compatible SQLite driver so that I don't encounter runtime errors due to native module compatibility issues.

**Why this priority**: This is the core value proposition - solving the Node.js v24+ ESM compatibility issue with better-sqlite3 that breaks the current MCP server. Without this, the tool fails completely on newer Node.js versions.

**Independent Test**: Can be fully tested by running cursor-history on Node.js v24 (where better-sqlite3 fails) and verifying it automatically falls back to node:sqlite, successfully listing chat sessions.

**Acceptance Scenarios**:

1. **Given** a user has Node.js v24+ installed, **When** they run cursor-history without any configuration, **Then** the system automatically selects an available driver (node:sqlite) and operates normally
2. **Given** a user has Node.js v20 with better-sqlite3 installed, **When** they run cursor-history, **Then** the system uses better-sqlite3 (faster native driver)
3. **Given** no compatible driver is available, **When** the user runs cursor-history, **Then** they receive a clear error message explaining which drivers to install or Node.js version to use

---

### User Story 2 - Manual Driver Selection (Priority: P2)

As a developer integrating cursor-history as a library, I want to explicitly choose which SQLite driver to use so that I have control over dependencies and performance characteristics in my application.

**Why this priority**: Power users and integrators need fine-grained control, but most users will rely on auto-detection. This enables advanced use cases without blocking the majority.

**Independent Test**: Can be tested by configuring a specific driver via environment variable or config option and verifying that driver is used regardless of auto-detection order.

**Acceptance Scenarios**:

1. **Given** a developer sets `CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3`, **When** they import cursor-history, **Then** the library uses better-sqlite3 exclusively
2. **Given** a developer passes `{ sqliteDriver: 'node:sqlite' }` in LibraryConfig, **When** they call library functions, **Then** node:sqlite is used
3. **Given** a developer specifies a driver that isn't available, **When** they run the application, **Then** they receive a clear error message listing available alternatives

---

### User Story 3 - Runtime Driver Switching (Priority: P3)

As a developer building tools that process databases from multiple sources, I want to switch SQLite drivers at runtime so that I can optimize for different use cases within the same application session.

**Why this priority**: This is an advanced feature for edge cases like processing a mix of local and remote databases. Most users will never need this, but it enables sophisticated integrations.

**Independent Test**: Can be tested by calling a driver switch function mid-session and verifying subsequent database operations use the new driver.

**Acceptance Scenarios**:

1. **Given** an application is running with better-sqlite3, **When** the developer calls `setDriver('node:sqlite')`, **Then** all subsequent database operations use node:sqlite
2. **Given** a driver switch is requested while a database connection is open, **When** the switch occurs, **Then** existing connections continue working and only new connections use the new driver

---

### Edge Cases

- What happens when the preferred driver fails during operation (e.g., memory corruption)?
  - The system surfaces the error clearly; automatic fallback during operation is not attempted to avoid data corruption
- How does the system handle driver-specific features that don't exist in all drivers?
  - The abstraction layer exposes only the common subset of features (prepare, get, all, run, exec, close)
- What happens if a user upgrades Node.js mid-project?
  - Auto-detection re-evaluates on each application start; no cached driver preference persists
- How does the system handle node:sqlite's experimental flag requirement (Node 22.5-23.x)?
  - Auto-detect by attempting dynamic import; if import fails (flag not enabled or Node < 22.5), silently fall back to next available driver

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a driver abstraction interface that encapsulates SQLite database operations (prepare, get, all, run, exec, close)
- **FR-002**: System MUST support at least two driver implementations: better-sqlite3 and node:sqlite
- **FR-003**: System MUST auto-detect available drivers on startup with priority: node:sqlite first (no native bindings, ESM compatible), then better-sqlite3 as fallback
- **FR-004**: System MUST allow manual driver selection via environment variable (`CURSOR_HISTORY_SQLITE_DRIVER`)
- **FR-005**: System MUST allow manual driver selection via LibraryConfig option (`sqliteDriver`)
- **FR-006**: System MUST provide clear error messages when no compatible driver is available
- **FR-007**: System MUST maintain backward compatibility - existing code using `openDatabase()` and `openDatabaseReadWrite()` must continue working without changes
- **FR-008**: System MUST expose a `getActiveDriver()` function that returns the name of the currently active driver
- **FR-009**: System MUST support runtime driver switching via a `setDriver()` function
- **FR-010**: System MUST validate driver availability before attempting to use it
- **FR-011**: System MUST log driver selection details to stderr when `DEBUG` or `CURSOR_HISTORY_DEBUG` environment variable is set

### Key Entities

- **DatabaseDriver**: Represents a pluggable SQLite driver implementation with name, availability check, and factory method
- **Database**: Abstract interface for database connections with prepare, exec, close methods
- **Statement**: Abstract interface for prepared statements with get, all, run methods
- **DriverRegistry**: Singleton that manages available drivers and current selection

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: cursor-history successfully runs on Node.js v20, v22, and v24+ without code changes by the user
- **SC-002**: Users can override driver selection within 30 seconds by setting an environment variable
- **SC-003**: Library consumers can configure driver via code with a single configuration option
- **SC-004**: All existing tests pass without modification (backward compatibility)
- **SC-005**: Driver auto-selection completes in under 100ms at application startup
- **SC-006**: Error messages for missing drivers include actionable remediation steps (which package to install or Node.js version to use)

## Assumptions

- **A-001**: node:sqlite (built into Node.js 22.5+) provides sufficient API compatibility with better-sqlite3 for cursor-history's use cases (prepare, get, all, run, exec)
- **A-002**: The synchronous API of both drivers is functionally equivalent for the operations used
- **A-003**: Performance differences between drivers are acceptable for typical cursor-history workloads (reading chat history databases)
- **A-004**: sql.js (WebAssembly) driver is out of scope for initial implementation but the architecture should allow adding it later
- **A-005**: Driver configuration persists only for the current process; no file-based configuration caching is needed

## Out of Scope

- Async/promise-based SQLite drivers (sqlite3, sqlite packages with async APIs)
- sql.js WebAssembly driver (can be added in future iteration)
- Connection pooling or advanced database management features
- Automatic migration of databases between SQLite versions
- GUI for driver configuration
