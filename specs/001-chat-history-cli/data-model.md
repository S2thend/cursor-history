# Data Model: Cursor Chat History CLI

**Date**: 2025-12-18
**Branch**: 001-chat-history-cli
**Source**: [spec.md](./spec.md) Key Entities + [research.md](./research.md)

## Overview

This document defines the data structures used by the cursor-history CLI tool.
The model maps Cursor's SQLite storage format to TypeScript types for internal use.

---

## Entity Relationship Diagram

```
┌─────────────────────┐
│   CursorDataStore   │
│  (storage location) │
└──────────┬──────────┘
           │ 1:N
           ▼
┌─────────────────────┐
│     Workspace       │
│  (state.vscdb file) │
└──────────┬──────────┘
           │ 1:N
           ▼
┌─────────────────────┐
│    ChatSession      │
│  (conversation)     │
└──────────┬──────────┘
           │ 1:N
           ▼
┌─────────────────────┐
│      Message        │
│  (user/assistant)   │
└──────────┬──────────┘
           │ 0:N
           ▼
┌─────────────────────┐
│     CodeBlock       │
│  (embedded code)    │
└─────────────────────┘
```

---

## Entity Definitions

### CursorDataStore

The root storage location containing all workspace data.

| Field | Type | Description |
|-------|------|-------------|
| `basePath` | `string` | Absolute path to workspaceStorage directory |
| `platform` | `'windows' \| 'macos' \| 'linux'` | Detected operating system |

**Default Paths**:
- Windows: `%APPDATA%\Cursor\User\workspaceStorage`
- macOS: `~/Library/Application Support/Cursor/User/workspaceStorage`
- Linux: `~/.config/Cursor/User/workspaceStorage`

**Validation Rules**:
- Path MUST exist and be readable
- Path MUST contain at least one `state.vscdb` file

---

### Workspace

A directory/project that was open in Cursor. Maps to a `state.vscdb` file.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Hash identifier (directory name in workspaceStorage) |
| `path` | `string` | Original workspace filesystem path |
| `dbPath` | `string` | Absolute path to `state.vscdb` file |
| `sessionCount` | `number` | Number of chat sessions in this workspace |

**Source**: The `workspace.json` file in each workspace directory contains:
```json
{
  "folder": "file:///path/to/project"
}
```

**Identity**: Unique by `id` (the hash)

**Validation Rules**:
- `id` is derived from Cursor's internal hashing (read-only)
- `path` may not exist if project was moved/deleted
- `dbPath` MUST exist and be a valid SQLite database

---

### ChatSession

A single conversation with the AI assistant within a workspace.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID from Cursor's storage |
| `index` | `number` | CLI-friendly numeric index (1-based, assigned at runtime) |
| `title` | `string \| null` | Session title (may be derived from first message) |
| `createdAt` | `Date` | When the conversation started |
| `lastUpdatedAt` | `Date` | Most recent activity |
| `messageCount` | `number` | Number of messages in session |
| `messages` | `Message[]` | Ordered list of messages |
| `workspaceId` | `string` | Parent workspace ID |

**Source**: Extracted from `ItemTable` where key is `workbench.panel.aichat.view.aichat.chatdata`

**Identity**: Unique by `id` within a workspace

**State Transitions**: None (read-only access)

**Validation Rules**:
- `index` is assigned at list-time, sorted by `createdAt` descending
- `title` defaults to truncated first user message if not set
- `createdAt` and `lastUpdatedAt` are Unix timestamps (milliseconds) converted to Date

---

### Message

A single exchange within a chat session.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string \| null` | Optional message ID from storage |
| `role` | `'user' \| 'assistant'` | Who sent the message |
| `content` | `string` | Raw message content (may contain markdown/code) |
| `timestamp` | `Date` | When the message was sent |
| `codeBlocks` | `CodeBlock[]` | Extracted code blocks (parsed from content) |

**Identity**: Order within parent ChatSession

**Validation Rules**:
- `role` MUST be either 'user' or 'assistant'
- `content` may be empty string
- `timestamp` falls back to parent session's `createdAt` if not available

---

### CodeBlock

Embedded code within a message, extracted from markdown fenced code blocks.

| Field | Type | Description |
|-------|------|-------------|
| `language` | `string \| null` | Language annotation (e.g., 'typescript', 'python') |
| `content` | `string` | The code content |
| `startLine` | `number` | Line number in original message where block starts |

**Source**: Parsed from message content using regex for fenced code blocks:
```
```language
code content
```
```

**Validation Rules**:
- `language` is null if no annotation provided
- `content` preserves original whitespace/indentation
- `startLine` is 0-indexed relative to message content

---

## Type Definitions (TypeScript)

```typescript
// src/core/types.ts

export type Platform = 'windows' | 'macos' | 'linux';
export type MessageRole = 'user' | 'assistant';

export interface CursorDataStore {
  basePath: string;
  platform: Platform;
}

export interface Workspace {
  id: string;
  path: string;
  dbPath: string;
  sessionCount: number;
}

export interface ChatSession {
  id: string;
  index: number;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  messages: Message[];
  workspaceId: string;
}

export interface Message {
  id: string | null;
  role: MessageRole;
  content: string;
  timestamp: Date;
  codeBlocks: CodeBlock[];
}

export interface CodeBlock {
  language: string | null;
  content: string;
  startLine: number;
}

// List view (without full messages for performance)
export interface ChatSessionSummary {
  id: string;
  index: number;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  workspaceId: string;
  workspacePath: string;
  preview: string; // First ~100 chars of first user message
}
```

---

## Storage Mapping

### SQLite to TypeScript

| SQLite Source | TypeScript Target |
|---------------|-------------------|
| `ItemTable.key = 'workbench.panel.aichat.view.aichat.chatdata'` | `ChatSession[]` |
| JSON `.chatSessions[].id` | `ChatSession.id` |
| JSON `.chatSessions[].title` | `ChatSession.title` |
| JSON `.chatSessions[].createdAt` | `ChatSession.createdAt` (ms → Date) |
| JSON `.chatSessions[].messages[].role` | `Message.role` |
| JSON `.chatSessions[].messages[].content` | `Message.content` |

### Fallback Keys (Version Compatibility)

If primary key not found, check in order:
1. `workbench.panel.aichat.view.aichat.chatdata`
2. `aiService.prompts` + `aiService.generations`
3. Scan `ItemTable` for JSON containing `chatSessions` or `messages` arrays

---

## Data Volume Assumptions

Based on spec requirements (SC-003: 1000 sessions in <5s search):

| Metric | Expected Range |
|--------|----------------|
| Workspaces per user | 1-50 |
| Sessions per workspace | 1-100 |
| Messages per session | 2-500 |
| Characters per message | 10-50,000 |
| Code blocks per message | 0-10 |

**Memory Constraints**:
- List operation: Load summaries only (no full messages)
- Show operation: Load single session fully
- Search operation: Stream through sessions, don't load all into memory
