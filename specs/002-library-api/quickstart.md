# Quickstart Guide: cursor-history Library

**Feature**: 002-library-api
**Version**: 1.0.0
**Last Updated**: 2025-12-22

**IMPORTANT**: This is a **library interface** for direct import and use in TypeScript/JavaScript projects, NOT a network/REST API. You import functions directly into your code - no HTTP server required.

## Installation

```bash
npm install cursor-history
```

**Requirements**: Node.js >= 20.0.0

---

## Basic Usage

### Import the Library

```typescript
// ESM (recommended)
import { listSessions, getSession, searchSessions } from 'cursor-history';

// CommonJS
const { listSessions, getSession, searchSessions } = require('cursor-history');
```

### List All Sessions

```typescript
import { listSessions } from 'cursor-history';

// Get all sessions (no pagination)
const result = listSessions();

console.log(`Total sessions: ${result.pagination.total}`);
result.data.forEach(session => {
  console.log(`${session.workspace} - ${session.messageCount} messages`);
});
```

### Get a Specific Session

```typescript
import { getSession } from 'cursor-history';

// Get the first session (index 0)
const session = getSession(0);

console.log(`Workspace: ${session.workspace}`);
console.log(`Created: ${session.timestamp}`);

// Iterate through messages
session.messages.forEach(msg => {
  console.log(`${msg.role}: ${msg.content.substring(0, 100)}...`);
});
```

### Search Sessions

```typescript
import { searchSessions } from 'cursor-history';

// Basic search
const results = searchSessions('authentication');

results.forEach(result => {
  console.log(`Found in session ${result.session.id}:`);
  console.log(result.match);
});

// Search with context lines
const detailedResults = searchSessions('error', { context: 2 });

detailedResults.forEach(result => {
  console.log('--- Context Before ---');
  result.contextBefore?.forEach(line => console.log(line));

  console.log('--- Match ---');
  console.log(result.match);

  console.log('--- Context After ---');
  result.contextAfter?.forEach(line => console.log(line));
});
```

---

## Advanced Usage

### Pagination

```typescript
import { listSessions } from 'cursor-history';

// Get first 10 sessions
const page1 = listSessions({ limit: 10, offset: 0 });

console.log(`Showing ${page1.data.length} of ${page1.pagination.total}`);
console.log(`Has more: ${page1.pagination.hasMore}`);

// Get next 10 sessions
if (page1.pagination.hasMore) {
  const page2 = listSessions({ limit: 10, offset: 10 });
  console.log(`Page 2: ${page2.data.length} sessions`);
}

// Iterate through all pages
let offset = 0;
const limit = 50;
let hasMore = true;

while (hasMore) {
  const page = listSessions({ limit, offset });

  // Process this page
  page.data.forEach(session => {
    console.log(session.workspace);
  });

  hasMore = page.pagination.hasMore;
  offset += limit;
}
```

### Filter by Workspace

```typescript
import { listSessions, searchSessions } from 'cursor-history';

const workspace = '/Users/you/projects/my-app';

// List sessions for specific workspace
const sessions = listSessions({ workspace });

// Search within specific workspace
const results = searchSessions('bug', { workspace });
```

### Custom Data Path

```typescript
import { listSessions, getDefaultDataPath } from 'cursor-history';

// Use platform default (automatic)
const defaultSessions = listSessions();

// Check what the default path is
const defaultPath = getDefaultDataPath();
console.log(`Default data path: ${defaultPath}`);

// Use custom Cursor installation path
const customSessions = listSessions({
  dataPath: '/custom/cursor/data'
});
```

### Export Sessions

```typescript
import {
  exportSessionToJson,
  exportSessionToMarkdown,
  exportAllSessionsToJson,
  exportAllSessionsToMarkdown
} from 'cursor-history';
import { writeFileSync } from 'fs';

// Export single session to JSON
const jsonSession = exportSessionToJson(0);
writeFileSync('session-0.json', jsonSession);

// Export single session to Markdown
const mdSession = exportSessionToMarkdown(0);
writeFileSync('session-0.md', mdSession);

// Export all sessions to JSON
const allJson = exportAllSessionsToJson();
writeFileSync('all-sessions.json', allJson);

// Export all sessions to Markdown
const allMd = exportAllSessionsToMarkdown();
writeFileSync('all-sessions.md', allMd);

// Export specific workspace to JSON
const workspaceJson = exportAllSessionsToJson({
  workspace: '/path/to/project'
});
writeFileSync('project-sessions.json', workspaceJson);
```

---

## Error Handling

### Type-Safe Error Handling

```typescript
import {
  listSessions,
  DatabaseLockedError,
  DatabaseNotFoundError,
  InvalidConfigError,
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isInvalidConfigError
} from 'cursor-history';

try {
  const sessions = listSessions();
  console.log(sessions.data);
} catch (error) {
  // Using type guards
  if (isDatabaseLockedError(error)) {
    console.error('Database is locked. Please close Cursor and retry.');
    console.error(`Database path: ${error.path}`);
  } else if (isDatabaseNotFoundError(error)) {
    console.error('Database not found. Is Cursor installed?');
    console.error(`Searched at: ${error.path}`);
  } else if (isInvalidConfigError(error)) {
    console.error(`Invalid configuration: ${error.field} = ${error.value}`);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

### Retry Logic for Locked Database

```typescript
import { listSessions, isDatabaseLockedError } from 'cursor-history';

async function getSessionsWithRetry(maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return listSessions();
    } catch (error) {
      if (isDatabaseLockedError(error) && attempt < maxRetries) {
        console.log(`Database locked, retrying in ${delayMs}ms... (${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw error; // Re-throw if not locked or max retries exceeded
      }
    }
  }
}

// Usage
try {
  const sessions = await getSessionsWithRetry();
  console.log(sessions.data);
} catch (error) {
  console.error('Failed after retries:', error);
}
```

### Handling Corrupted Data

```typescript
import { getSession } from 'cursor-history';

const session = getSession(0);

// Check for corrupted messages
const corruptedMessages = session.messages.filter(
  msg => msg.metadata?.corrupted === true
);

if (corruptedMessages.length > 0) {
  console.warn(`Found ${corruptedMessages.length} corrupted messages`);
  corruptedMessages.forEach(msg => {
    console.warn(`- ${msg.timestamp}: ${msg.content.substring(0, 50)}...`);
  });
}

// Note: Library automatically skips completely unparseable messages
// and logs warnings to console. Check stderr for details.
```

---

## TypeScript Support

The library includes full TypeScript definitions. All types are exported:

```typescript
import type {
  Session,
  Message,
  ToolCall,
  SearchResult,
  LibraryConfig,
  PaginatedResult
} from 'cursor-history';

// Type-safe configuration
const config: LibraryConfig = {
  dataPath: '/custom/path',
  workspace: '/my/project',
  limit: 20,
  offset: 0,
  context: 3
};

// Type-safe results
const result: PaginatedResult<Session> = listSessions(config);

// Type-safe message handling
function processMessage(msg: Message) {
  if (msg.role === 'assistant' && msg.toolCalls) {
    msg.toolCalls.forEach((call: ToolCall) => {
      console.log(`Tool: ${call.name}, Status: ${call.status}`);
    });
  }
}
```

---

## Platform-Specific Paths

The library automatically detects your platform and uses the correct default path:

| Platform | Default Data Path |
|----------|-------------------|
| macOS | `~/Library/Application Support/Cursor/User` |
| Linux | `~/.config/Cursor/User` |
| Windows | `%APPDATA%\Cursor\User` |

```typescript
import { getDefaultDataPath } from 'cursor-history';

const path = getDefaultDataPath();
console.log(`Cursor data: ${path}`);
```

---

## Common Patterns

### Build a Session Analytics Tool

```typescript
import { listSessions } from 'cursor-history';

const result = listSessions();

// Analyze sessions
const stats = {
  totalSessions: result.pagination.total,
  totalMessages: result.data.reduce((sum, s) => sum + s.messageCount, 0),
  byWorkspace: {} as Record<string, number>
};

result.data.forEach(session => {
  stats.byWorkspace[session.workspace] =
    (stats.byWorkspace[session.workspace] || 0) + 1;
});

console.log('Session Statistics:');
console.log(`- Total sessions: ${stats.totalSessions}`);
console.log(`- Total messages: ${stats.totalMessages}`);
console.log(`- Avg messages/session: ${(stats.totalMessages / stats.totalSessions).toFixed(1)}`);
console.log('\nSessions by workspace:');
Object.entries(stats.byWorkspace).forEach(([workspace, count]) => {
  console.log(`  ${workspace}: ${count}`);
});
```

### Find All Tool Calls

```typescript
import { listSessions } from 'cursor-history';

const result = listSessions();

const toolCalls: Array<{ session: string; tool: string; status: string }> = [];

result.data.forEach(session => {
  session.messages.forEach(msg => {
    if (msg.role === 'assistant' && msg.toolCalls) {
      msg.toolCalls.forEach(call => {
        toolCalls.push({
          session: session.id,
          tool: call.name,
          status: call.status
        });
      });
    }
  });
});

// Group by tool name
const toolStats = toolCalls.reduce((acc, call) => {
  acc[call.tool] = (acc[call.tool] || 0) + 1;
  return acc;
}, {} as Record<string, number>);

console.log('Tool usage statistics:');
Object.entries(toolStats)
  .sort(([, a], [, b]) => b - a)
  .forEach(([tool, count]) => {
    console.log(`  ${tool}: ${count} calls`);
  });
```

### Export Recent Sessions

```typescript
import { listSessions, exportSessionToMarkdown } from 'cursor-history';
import { writeFileSync, mkdirSync } from 'fs';

// Get 10 most recent sessions
const recent = listSessions({ limit: 10, offset: 0 });

// Create output directory
mkdirSync('./exports', { recursive: true });

// Export each to markdown
recent.data.forEach((session, index) => {
  const markdown = exportSessionToMarkdown(index);
  const filename = `./exports/session-${session.id}-${session.timestamp}.md`;
  writeFileSync(filename, markdown);
  console.log(`Exported: ${filename}`);
});
```

---

## Performance Considerations

### Memory Usage

The library uses a **stateless design** - database connections are opened/closed per API call:

- ✅ **Pros**: No connection leaks, simple API, no lifecycle management
- ⚠️ **Trade-off**: ~1ms overhead per call (negligible for CLI-style usage)
- ❌ **Not suitable for**: High-frequency polling (>100 req/s)

**Recommendation**: For one-time or periodic access (every few seconds), the overhead is negligible. For real-time monitoring, consider batching requests.

### Large Sessions

Sessions with 1000+ messages are handled efficiently:

```typescript
import { listSessions } from 'cursor-history';

// Use pagination for very large datasets
const BATCH_SIZE = 100;
let offset = 0;
let processed = 0;

while (true) {
  const batch = listSessions({ limit: BATCH_SIZE, offset });

  if (batch.data.length === 0) break;

  // Process batch
  batch.data.forEach(session => {
    // ... your processing logic
    processed++;
  });

  console.log(`Processed ${processed}/${batch.pagination.total}`);
  offset += BATCH_SIZE;
}
```

---

## Troubleshooting

### Database Not Found

```
DatabaseNotFoundError: Database not found: /path/to/cursor/data
```

**Solutions**:
1. Verify Cursor is installed: `ls "$(getDefaultDataPath())"`
2. Check if custom path is correct
3. Ensure you have read permissions

### Database Locked

```
DatabaseLockedError: Database is locked: /path/to/state.vscdb
```

**Solutions**:
1. Close Cursor IDE completely
2. Implement retry logic (see error handling examples above)
3. Check if another process is accessing the database

### Empty Results

If `listSessions()` returns empty array:

1. Verify Cursor has chat history: Open Cursor and check chat panel
2. Check workspace filter: Remove `workspace` parameter to see all sessions
3. Verify data path: Use `getDefaultDataPath()` to check default location

---

## API Reference

For complete API documentation, see [contracts/api.ts](./contracts/api.ts).

**Core Functions**:
- `listSessions(config?)` - List all sessions with pagination
- `getSession(index, config?)` - Get specific session by index
- `searchSessions(query, config?)` - Search across sessions
- `exportSessionToJson(index, config?)` - Export session to JSON
- `exportSessionToMarkdown(index, config?)` - Export session to Markdown
- `exportAllSessionsToJson(config?)` - Export all sessions to JSON
- `exportAllSessionsToMarkdown(config?)` - Export all sessions to Markdown
- `getDefaultDataPath()` - Get platform default data path

**Error Classes**:
- `DatabaseLockedError` - Database locked by Cursor
- `DatabaseNotFoundError` - Database path not found
- `InvalidConfigError` - Invalid configuration parameters

**Type Guards**:
- `isDatabaseLockedError(error)` - Check for locked database
- `isDatabaseNotFoundError(error)` - Check for missing database
- `isInvalidConfigError(error)` - Check for invalid config

---

## Next Steps

- **CLI Tool**: The library powers the `cursor-history` CLI - run `cursor-history --help`
- **Source Code**: [GitHub Repository](https://github.com/S2thend/cursor-history)
- **Issues**: Report bugs at [GitHub Issues](https://github.com/S2thend/cursor-history/issues)

---

**License**: MIT
