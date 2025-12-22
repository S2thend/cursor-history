# Feature Specification: Cursor Chat History CLI

**Feature Branch**: `001-chat-history-cli`
**Created**: 2025-12-18
**Status**: Draft
**Input**: User description: "CLI tool like cat/ls to list and show Cursor chat history"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - List Chat Sessions (Priority: P1)

As a developer, I want to see a list of all my Cursor chat sessions so I can find a
specific conversation I had with the AI assistant.

**Why this priority**: This is the foundational capability - users need to discover what
chats exist before they can view them. Without listing, the tool provides no value.

**Independent Test**: Can be fully tested by running the list command and verifying it
displays chat sessions with identifying information (date, title/preview).

**Acceptance Scenarios**:

1. **Given** the user has Cursor installed with existing chat history, **When** they run
   the list command, **Then** they see the 20 most recent chat sessions sorted by date
   (most recent first).

2. **Given** the user has Cursor installed with existing chat history, **When** they run
   the list command with `--limit N` flag, **Then** they see only the specified number of
   most recent sessions. Use `--all` to show all sessions.

3. **Given** the user has no Cursor chat history, **When** they run the list command,
   **Then** they see a helpful message indicating no chats were found.

4. **Given** the user has Cursor installed, **When** they run the list command with JSON
   output flag, **Then** they receive machine-parseable JSON output.

---

### User Story 2 - View Chat Content (Priority: P2)

As a developer, I want to view the full content of a specific chat session so I can
read the conversation history, copy code snippets, or recall information discussed.

**Why this priority**: Viewing content is the primary value proposition after discovery.
Users list chats to find one, then view it.

**Independent Test**: Can be fully tested by selecting a chat ID from the list and
verifying the full conversation renders with messages, code blocks, and timestamps.

**Acceptance Scenarios**:

1. **Given** a valid chat session ID, **When** the user runs the show command with that
   ID, **Then** they see the full conversation with all messages displayed in
   chronological order.

2. **Given** a valid chat session ID, **When** the user runs the show command, **Then**
   code blocks within messages are displayed with syntax highlighting (in terminal) or
   properly formatted (in JSON output).

3. **Given** an invalid or non-existent chat ID, **When** the user runs the show command,
   **Then** they see a clear error message explaining the chat was not found.

4. **Given** a valid chat session ID, **When** the user runs the show command with JSON
   output flag, **Then** they receive the full conversation as structured JSON.

---

### User Story 3 - Search Chat History (Priority: P3)

As a developer, I want to search across all my chat sessions for specific keywords so I
can find conversations about particular topics without manually browsing each one.

**Why this priority**: Search significantly improves usability for users with many chats
but is not essential for basic functionality. List + View provides a complete MVP.

**Independent Test**: Can be fully tested by searching for a known keyword and verifying
matching chats are returned with context snippets.

**Acceptance Scenarios**:

1. **Given** the user has chat history containing the word "authentication", **When**
   they search for "authentication", **Then** they see a list of matching chats with
   the relevant snippet highlighted.

2. **Given** a search term that exists in multiple chats, **When** the user searches,
   **Then** results are sorted by relevance (number of matches or recency).

3. **Given** a search term with no matches, **When** the user searches, **Then** they
   see a message indicating no results found.

4. **Given** a search with results, **When** the user adds the `--show` flag with a
   result number, **Then** they see the full content of that chat (combines search + view).

---

### User Story 4 - Export Chat History (Priority: P4)

As a developer, I want to export my chat history to Markdown or JSON format so I can
archive conversations, share them, or process them with other tools.

**Why this priority**: Export is a power-user feature that extends the tool's utility
but is not required for basic viewing and discovery.

**Independent Test**: Can be fully tested by exporting a chat and verifying the output
file is valid Markdown/JSON that preserves conversation structure.

**Acceptance Scenarios**:

1. **Given** a valid chat session ID, **When** the user exports to Markdown, **Then**
   they receive a well-formatted Markdown file with headers, code blocks, and timestamps.

2. **Given** a valid chat session ID, **When** the user exports to JSON, **Then** they
   receive a structured JSON file matching a documented schema.

3. **Given** the user wants to export all chats, **When** they run export with `--all`
   flag, **Then** all chats are exported to the specified directory.

4. **Given** an export target path that already exists, **When** the user exports
   without `--force`, **Then** they see a warning and are not overwritten.

---

### Edge Cases

- What happens when Cursor is not installed or chat history location is not found?
  - Display helpful error with guidance on expected locations.

- What happens when chat history files are corrupted or partially written?
  - Skip corrupted entries, display what can be read, warn user about skipped items.

- What happens when Cursor updates and changes storage format?
  - Detect unknown formats gracefully, suggest updating the tool.

- What happens when chat contains very long messages or code blocks?
  - Support pagination or truncation with `--full` flag to show complete content.

- What happens on Windows vs macOS vs Linux?
  - Auto-detect OS and check appropriate data directories.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST detect Cursor's chat history storage location automatically
  based on the operating system (Windows, macOS, Linux).

- **FR-002**: System MUST list all available chat sessions with: session identifier,
  creation date, and a preview of the first message or title.

- **FR-003**: System MUST display the full content of a selected chat session including
  all messages with their roles (user/assistant), timestamps, and code blocks.

- **FR-004**: System MUST support JSON output format via `--json` flag for all commands
  to enable scripting and piping to other tools.

- **FR-005**: System MUST provide clear, actionable error messages when chat history
  cannot be found, read, or parsed.

- **FR-006**: System MUST handle chats with code blocks, preserving language annotations
  and formatting for terminal display.

- **FR-007**: System MUST support searching across all chat content with keyword matching
  and display matching snippets with context.

- **FR-008**: System MUST export individual or all chats to Markdown format preserving
  conversation structure.

- **FR-009**: System MUST work in both interactive terminals (with colors/formatting)
  and non-interactive contexts (piped output, scripts).

- **FR-010**: System MUST provide `--help` documentation with usage examples.

- **FR-011**: System MUST use flag-based invocation pattern: `cursor-history --list`,
  `cursor-history --show <id>`, `cursor-history --search <term>`, `cursor-history --export <id>`.

- **FR-012**: System MUST support listing workspaces/directories that have chat history
  via `--list-workspaces` or similar flag.

- **FR-013**: System MUST support filtering chat sessions by workspace via `--workspace <path>`
  or `--dir <path>` flag. Default behavior lists chats from current working directory
  if it has history, otherwise lists all.

- **FR-014**: System MUST support custom data path via `--data-path <path>` flag and
  `CURSOR_DATA_PATH` environment variable. Flag takes precedence over env var, which
  takes precedence over auto-detection.

### Key Entities

- **Workspace**: A directory/project that was open in Cursor. Contains zero or more chat
  sessions. Identified by its filesystem path.

- **Chat Session**: A single conversation with the AI assistant within a workspace.
  Contains a numeric index (for CLI reference), creation timestamp, and a collection of
  messages. May have a title derived from first message.

- **Message**: A single exchange within a chat session. Has a role (user or assistant),
  content (text and/or code blocks), and timestamp.

- **Code Block**: Embedded code within a message. Has content, optional language
  annotation, and preserves original formatting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can list their chat sessions within 2 seconds of running the command.

- **SC-002**: Users can view any chat's full content within 3 seconds of running the
  show command.

- **SC-003**: Search returns results within 5 seconds for chat histories up to 1000
  sessions.

- **SC-004**: The tool works on Windows (PowerShell), macOS (zsh/bash), and Linux
  (bash) without platform-specific installation steps beyond the binary.

- **SC-005**: Users can pipe output to other tools (grep, jq, etc.) for further
  processing.

- **SC-006**: First-time users can successfully list and view a chat within 1 minute
  of installation (including reading --help).

## Clarifications

### Session 2025-12-18

- Q: What CLI command structure should be used? → A: Flag pattern (`cursor-history --list`, `cursor-history --show <id>`)
- Q: What identifier format for chat sessions? → A: Numeric index from list output (e.g., `--show 3`)
- Q: How is chat history organized? → A: By working directory/workspace; tool should support listing and filtering by directory
- Q: What is the default list behavior? → A: Show last 20 sessions by default; use `--all` for full list or `--limit N` for custom
- Q: What should the command/binary be named? → A: `cursor-history`
- Q: Should users be able to specify custom data path? → A: Yes, via `--data-path <path>` flag and `CURSOR_DATA_PATH` environment variable

## Assumptions

- Cursor stores chat history in a predictable location based on OS conventions
  (e.g., `~/.cursor/`, `%APPDATA%\Cursor\`, `~/.config/Cursor/`).

- Chat history is stored in a readable format (JSON, SQLite, or similar) that does
  not require Cursor to be running to access.

- Users have read access to their own Cursor data directory.

- The tool is read-only and does not modify Cursor's chat history.
