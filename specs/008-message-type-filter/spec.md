# Feature Specification: Message Type Filter

**Feature Branch**: `008-message-type-filter`
**Created**: 2026-01-11
**Status**: Draft
**Input**: User description: "Add message type filter to show command - filter by tool calls, user messages, or assistant responses"

## Clarifications

### Session 2026-01-11

- Q: Should thinking blocks and error messages be separate filter types or grouped with assistant/tool? → A: Add `thinking` and `error` as additional filter types (5 types total: user, assistant, tool, thinking, error)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Filter to User Messages Only (Priority: P1)

As a user reviewing a long chat session, I want to see only my own messages so I can quickly review what questions I asked without scrolling through lengthy AI responses and tool outputs.

**Why this priority**: This is the most common use case - users often want to see just their prompts to understand the conversation flow or copy their questions for reuse.

**Independent Test**: Can be tested by running `cursor-history show 1 --only user` and verifying only user messages appear in output.

**Acceptance Scenarios**:

1. **Given** a session with mixed user, assistant, and tool messages, **When** I run `show <index> --only user`, **Then** I see only messages from role "user" with their timestamps
2. **Given** a session with no user messages (edge case), **When** I run `show <index> --only user`, **Then** I see an informative message indicating no matching messages

---

### User Story 2 - Filter to Tool Calls Only (Priority: P1)

As a developer debugging a session, I want to see only the tool calls (file reads, writes, terminal commands) so I can understand what actions the AI took without reading through explanations.

**Why this priority**: Equally important as user filter - developers frequently need to audit what operations were performed.

**Independent Test**: Can be tested by running `cursor-history show 1 --only tool` and verifying only tool call messages appear.

**Acceptance Scenarios**:

1. **Given** a session with tool calls, **When** I run `show <index> --only tool`, **Then** I see only messages containing tool operations with file paths and parameters
2. **Given** a session with no tool calls, **When** I run `show <index> --only tool`, **Then** I see an informative message indicating no matching messages

---

### User Story 3 - Filter to Assistant Responses Only (Priority: P2)

As a user, I want to see only the AI assistant's explanatory responses (excluding tool calls and thinking) so I can review the actual answers and guidance provided.

**Why this priority**: Useful for reviewing AI explanations without the noise of tool outputs, but slightly less common than filtering to user prompts or tool calls.

**Independent Test**: Can be tested by running `cursor-history show 1 --only assistant` and verifying only assistant text responses appear.

**Acceptance Scenarios**:

1. **Given** a session with assistant responses, **When** I run `show <index> --only assistant`, **Then** I see only assistant explanatory text (not tool calls, not thinking blocks)
2. **Given** a session where all assistant messages are tool calls, **When** I run `show <index> --only assistant`, **Then** I see an informative message indicating no matching messages

---

### User Story 4 - Filter with Multiple Types (Priority: P2)

As a user, I want to combine multiple filters so I can see exactly the message types relevant to my review (e.g., user messages and tool calls together, excluding verbose assistant explanations).

**Why this priority**: Provides flexibility for advanced users who need specific combinations.

**Independent Test**: Can be tested by running `cursor-history show 1 --only user,tool` and verifying both user and tool messages appear but assistant responses are excluded.

**Acceptance Scenarios**:

1. **Given** a session with all message types, **When** I run `show <index> --only user,tool`, **Then** I see user messages and tool calls but not assistant text responses
2. **Given** I specify all three types `--only user,assistant,tool`, **When** the command runs, **Then** behavior is equivalent to no filter (all messages shown)

---

### Edge Cases

- What happens when filter value is invalid (e.g., `--only invalid`)? Display error message listing valid options.
- What happens when filter results in zero messages? Display informative message rather than empty output.
- How does filter interact with existing display options (`--short`, `--think`, `--tool`)? Filters apply first, then display options format the filtered results.
- How does filter work with `--json` output? JSON output includes only filtered messages.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support `--only <type>` option on the `show` command to filter displayed messages
- **FR-002**: System MUST accept the following filter values: `user`, `assistant`, `tool`, `thinking`, `error`
- **FR-003**: System MUST support comma-separated multiple values (e.g., `--only user,tool`)
- **FR-004**: System MUST display an error with valid options when an invalid filter value is provided
- **FR-005**: System MUST display an informative message when filter results in zero messages
- **FR-006**: System MUST apply filters before existing display formatting options (`--short`, `--think`, `--tool`, `--error`)
- **FR-007**: System MUST support the `--only` filter in JSON output mode
- **FR-008**: System MUST preserve message ordering and timestamps in filtered output
- **FR-009**: The library API MUST expose filter functionality through the `getSession` configuration options

### Message Type Classification

- **User messages** (`user`): Messages with `type: 1` (bubble type) in the data
- **Tool calls** (`tool`): Assistant messages (`type: 2`) where content starts with `[Tool:` marker (set by storage layer)
- **Assistant responses** (`assistant`): Assistant messages (`type: 2`) that are not tool calls, not thinking blocks, and not errors
- **Thinking blocks** (`thinking`): Assistant messages (`type: 2`) where content starts with `[Thinking]` marker
- **Error messages** (`error`): Assistant messages (`type: 2`) where content starts with `[Error]` marker

### Key Entities

- **MessageFilter**: The filter criteria specifying which message types to include (user, assistant, tool, thinking, error)
- **FilteredSession**: A session where messages have been filtered according to the specified criteria

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can filter a 100+ message session to show only their messages in under 1 second
- **SC-002**: Filter output correctly excludes 100% of non-matching message types
- **SC-003**: All existing tests continue to pass after adding filter functionality
- **SC-004**: Library API users can filter messages programmatically with the same options as CLI

## Assumptions

- The existing message type detection logic in `extractBubbleText()` and display formatters (`isToolCall()`, `isThinking()`, `isError()`) is sufficient for classification
- Thinking blocks, error messages, tool calls, and assistant responses are mutually exclusive filter categories
- The filter is applied at display time, not at the database query level (simpler implementation, adequate performance)
