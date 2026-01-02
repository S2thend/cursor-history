# Cursor History

<p align="center">
  <img src="docs/logo.png" alt="cursor-history logo" width="200">
</p>

[![npm version](https://img.shields.io/npm/v/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![npm downloads](https://img.shields.io/npm/dm/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)

**The ultimate open-source tool for browsing, searching, exporting, and backing up your Cursor AI chat history.**

A POSIX-style CLI tool that does one thing well: access your Cursor AI chat history. Built on Unix philosophy—simple, composable, and focused.

```bash
# Pipe-friendly: combine with other tools
cursor-history list --json | jq '.[] | select(.messageCount > 10)'
cursor-history export 1 | grep -i "api" | head -20
cursor-history search "bug" --json | jq -r '.[].sessionId' | xargs -I {} cursor-history export {}
```

Never lose a conversation again. Whether you need to find that perfect code snippet from last week, migrate your history to a new machine, or create reliable backups of all your AI-assisted development sessions—cursor-history has you covered. Free, open-source, and built by the community for the community.

## Example Output

### List Sessions

<pre>
<span style="color: #888">cursor-history list</span>

<span style="color: #5fd7ff">cursor-history</span> - Chat History Browser

<span style="color: #5fd7ff">Sessions (showing 3 of 42):</span>

  <span style="color: #af87ff">#1</span>  <span style="color: #87d787">12/26 09:15 AM</span>  <span style="color: #d7d787">cursor_chat_history</span>
      <span style="color: #888">15 messages · Updated 2 min ago</span>
      <span style="color: #fff">"Help me fix the migration path issue..."</span>

  <span style="color: #af87ff">#2</span>  <span style="color: #87d787">12/25 03:22 PM</span>  <span style="color: #d7d787">my-react-app</span>
      <span style="color: #888">8 messages · Updated 18 hours ago</span>
      <span style="color: #fff">"Add authentication to the app..."</span>

  <span style="color: #af87ff">#3</span>  <span style="color: #87d787">12/24 11:30 AM</span>  <span style="color: #d7d787">api-server</span>
      <span style="color: #888">23 messages · Updated 2 days ago</span>
      <span style="color: #fff">"Create REST endpoints for users..."</span>
</pre>

### Show Session Details

<pre>
<span style="color: #888">cursor-history show 1</span>

<span style="color: #5fd7ff">Session #1</span> · <span style="color: #d7d787">cursor_chat_history</span>
<span style="color: #888">15 messages · Created 12/26 09:15 AM</span>

────────────────────────────────────────

<span style="color: #87d787">You:</span> <span style="color: #888">09:15:23 AM</span>

Help me fix the migration path issue in the codebase

────────────────────────────────────────

<span style="color: #af87ff">Assistant:</span> <span style="color: #888">09:15:45 AM</span>

I'll help you fix the migration path issue. Let me first examine
the relevant files.

────────────────────────────────────────

<span style="color: #d7af5f">Tool:</span> <span style="color: #888">09:15:46 AM</span>
<span style="color: #d7af5f">🔧 Read File</span>
   <span style="color: #888">File:</span> <span style="color: #5fd7ff">src/core/migrate.ts</span>
   <span style="color: #888">Content:</span> <span style="color: #fff">export function migrateSession(sessionId: string...</span>
   <span style="color: #87d787">Status: ✓ completed</span>

────────────────────────────────────────

<span style="color: #d7af5f">Tool:</span> <span style="color: #888">09:16:02 AM</span>
<span style="color: #d7af5f">🔧 Edit File</span>
   <span style="color: #888">File:</span> <span style="color: #5fd7ff">src/core/migrate.ts</span>

   <span style="color: #87d787">```diff</span>
<span style="color: #87d787">   + function transformPath(path: string): string {</span>
<span style="color: #87d787">   +   return path.replace(sourcePrefix, destPrefix);</span>
<span style="color: #87d787">   + }</span>
   <span style="color: #87d787">```</span>

   <span style="color: #87d787">Status: ✓ completed</span>

────────────────────────────────────────

<span style="color: #5f87d7">Thinking:</span> <span style="color: #888">09:16:02 AM</span>
<span style="color: #5f87d7">💭</span> <span style="color: #888">Now I need to update the function to call transformPath
   for each file reference in the bubble data...</span>

────────────────────────────────────────

<span style="color: #af87ff">Assistant:</span> <span style="color: #888">09:16:30 AM</span>

I've added the path transformation logic. The migration will now
update all file paths when moving sessions between workspaces.

────────────────────────────────────────

<span style="color: #ff5f5f">Error:</span> <span style="color: #888">09:17:01 AM</span>
<span style="color: #ff5f5f">❌</span> <span style="color: #ff5f5f">Build failed: Cannot find module './utils'</span>

────────────────────────────────────────
</pre>

## Features

- **Dual interface** - Use as CLI tool or import as a library in your Node.js projects
- **List sessions** - View all chat sessions across workspaces
- **View full conversations** - See complete chat history with:
  - AI responses with natural language explanations
  - **Full diff display** for file edits and writes with syntax highlighting
  - **Detailed tool calls** showing all parameters (file paths, search patterns, commands, etc.)
  - AI reasoning and thinking blocks
  - Message timestamps
- **Search** - Find conversations by keyword with highlighted matches
- **Export** - Save sessions as Markdown or JSON files
- **Migrate** - Move or copy sessions between workspaces (e.g., when renaming projects)
- **Backup & Restore** - Create full backups of all chat history and restore when needed
- **Cross-platform** - Works on macOS, Windows, and Linux

## Installation

### From NPM (Recommended)

```bash
# Install globally
npm install -g cursor-history

# Use the CLI
cursor-history list
```

### From Source

```bash
# Clone and build
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build

# Run directly
node dist/cli/index.js list

# Or link globally
npm link
cursor-history list
```

## Requirements

- Node.js 20+ (Node.js 22.5+ recommended for built-in SQLite support)
- Cursor IDE (with existing chat history)

## SQLite Driver Configuration

cursor-history supports two SQLite drivers for maximum compatibility:

| Driver | Description | Node.js Version |
|--------|-------------|-----------------|
| `node:sqlite` | Built-in Node.js SQLite module (no native bindings) | 22.5+ |
| `better-sqlite3` | Native bindings via better-sqlite3 | 20+ |

### Automatic Driver Selection

By default, cursor-history automatically selects the best available driver:

1. **node:sqlite** (preferred) - Works on Node.js 22.5+ without native compilation
2. **better-sqlite3** (fallback) - Works on older Node.js versions

### Manual Driver Selection

You can force a specific driver using the environment variable:

```bash
# Force better-sqlite3
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list

# Force node:sqlite (requires Node.js 22.5+)
CURSOR_HISTORY_SQLITE_DRIVER=node:sqlite cursor-history list
```

### Debug Driver Selection

To see which driver is being used:

```bash
DEBUG=cursor-history:* cursor-history list
```

### Library API Driver Control

When using cursor-history as a library, you can control the driver programmatically:

```typescript
import { setDriver, getActiveDriver, listSessions } from 'cursor-history';

// Force a specific driver before any operations
setDriver('better-sqlite3');

// Check which driver is active
const driver = getActiveDriver();
console.log(`Using driver: ${driver}`);

// Or configure via LibraryConfig
const result = await listSessions({
  sqliteDriver: 'node:sqlite'  // Force node:sqlite for this call
});
```

## Usage

### List Sessions

```bash
# List recent sessions (default: 20)
cursor-history list

# List all sessions
cursor-history list --all

# List with composer IDs (for external tools)
cursor-history list --ids

# Limit results
cursor-history list -n 10

# List workspaces only
cursor-history list --workspaces
```

### View a Session

```bash
# Show session by index number
cursor-history show 1

# Show with truncated messages (for quick overview)
cursor-history show 1 --short

# Show full AI thinking/reasoning text
cursor-history show 1 --think

# Show full file read content (not truncated)
cursor-history show 1 --fullread

# Show full error messages (not truncated to 300 chars)
cursor-history show 1 --error

# Combine options
cursor-history show 1 --short --think --fullread --error

# Output as JSON
cursor-history show 1 --json
```

### Search

```bash
# Search for keyword
cursor-history search "react hooks"

# Limit results
cursor-history search "api" -n 5

# Adjust context around matches
cursor-history search "error" --context 100
```

### Export

```bash
# Export single session to Markdown
cursor-history export 1

# Export to specific file
cursor-history export 1 -o ./my-chat.md

# Export as JSON
cursor-history export 1 --format json

# Export all sessions to directory
cursor-history export --all -o ./exports/

# Overwrite existing files
cursor-history export 1 --force
```

### Migrate Sessions

```bash
# Move a single session to another workspace
cursor-history migrate-session 1 /path/to/new/project

# Move multiple sessions (comma-separated indices or IDs)
cursor-history migrate-session 1,3,5 /path/to/project

# Copy instead of move (keeps original)
cursor-history migrate-session --copy 1 /path/to/project

# Preview what would happen without making changes
cursor-history migrate-session --dry-run 1 /path/to/project

# Move all sessions from one workspace to another
cursor-history migrate /old/project /new/project

# Copy all sessions (backup)
cursor-history migrate --copy /project /backup/project

# Force merge with existing sessions at destination
cursor-history migrate --force /old/project /existing/project
```

### Backup & Restore

```bash
# Create a backup of all chat history
cursor-history backup

# Create backup to specific file
cursor-history backup -o ~/my-backup.zip

# Overwrite existing backup
cursor-history backup --force

# List available backups
cursor-history list-backups

# List backups in a specific directory
cursor-history list-backups -d /path/to/backups

# Restore from a backup
cursor-history restore ~/cursor-history-backups/backup.zip

# Restore to a custom location
cursor-history restore backup.zip --target /custom/cursor/data

# Force overwrite existing data
cursor-history restore backup.zip --force

# View sessions from a backup without restoring
cursor-history list --backup ~/backup.zip
cursor-history show 1 --backup ~/backup.zip
cursor-history search "query" --backup ~/backup.zip
cursor-history export 1 --backup ~/backup.zip
```

### Global Options

```bash
# Output as JSON (works with all commands)
cursor-history --json list

# Use custom Cursor data path
cursor-history --data-path ~/.cursor-alt list

# Filter by workspace
cursor-history --workspace /path/to/project list
```

## What You Can View

When browsing your chat history, you'll see:

- **Complete conversations** - All messages exchanged with Cursor AI
- **Duplicate message folding** - Consecutive identical messages are folded into one display with multiple timestamps and repeat count (e.g., "02:48:01 PM, 02:48:04 PM, 02:48:54 PM (×3)")
- **Timestamps** - Exact time each message was sent (HH:MM:SS format)
- **AI tool actions** - Detailed view of what Cursor AI did:
  - **File edits/writes** - Full diff display with syntax highlighting showing exactly what changed
  - **File reads** - File paths and content previews (use `--fullread` for complete content)
  - **Search operations** - Patterns, paths, and search queries used
  - **Terminal commands** - Complete command text
  - **Directory listings** - Paths explored
  - **Tool errors** - Failed/cancelled operations shown with ❌ status indicator and parameters
  - **User decisions** - Shows if you accepted (✓), rejected (✗), or pending (⏳) on tool operations
  - **Errors** - Error messages with ❌ emoji highlighting (extracted from `toolFormerData.additionalData.status`)
- **AI reasoning** - See the AI's thinking process behind decisions (use `--think` for full text)
- **Code artifacts** - Mermaid diagrams, code blocks, with syntax highlighting
- **Natural language explanations** - AI explanations combined with code for full context

### Display Options

- **Default view** - Full messages with truncated thinking (200 chars), file reads (100 chars), and errors (300 chars)
- **`--short` mode** - Truncates user and assistant messages to 300 chars for quick scanning
- **`--think` flag** - Shows complete AI reasoning/thinking text (not truncated)
- **`--fullread` flag** - Shows full file read content instead of previews
- **`--error` flag** - Shows full error messages instead of 300-char preview

## Where Cursor Stores Data

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |
| Linux | `~/.config/Cursor/User/` |

The tool automatically finds and reads your Cursor chat history from these locations.

## Library API

In addition to the CLI, you can use cursor-history as a library in your Node.js projects:

```typescript
import {
  listSessions,
  getSession,
  searchSessions,
  exportSessionToMarkdown
} from 'cursor-history';

// List all sessions with pagination
const result = listSessions({ limit: 10 });
console.log(`Found ${result.pagination.total} sessions`);

for (const session of result.data) {
  console.log(`${session.id}: ${session.messageCount} messages`);
}

// Get a specific session (zero-based index)
const session = getSession(0);
console.log(session.messages);

// Search across all sessions
const results = searchSessions('authentication', { context: 2 });
for (const match of results) {
  console.log(match.match);
}

// Export to Markdown
const markdown = exportSessionToMarkdown(0);
```

### Migration API

```typescript
import { migrateSession, migrateWorkspace } from 'cursor-history';

// Move a session to another workspace
const results = migrateSession({
  sessions: 3,  // index or ID
  destination: '/path/to/new/project'
});

// Copy multiple sessions (keeps originals)
const results = migrateSession({
  sessions: [1, 3, 5],
  destination: '/path/to/project',
  mode: 'copy'
});

// Migrate all sessions between workspaces
const result = migrateWorkspace({
  source: '/old/project',
  destination: '/new/project'
});
console.log(`Migrated ${result.successCount} sessions`);
```

### Backup API

```typescript
import {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir
} from 'cursor-history';

// Create a backup
const result = await createBackup({
  outputPath: '~/my-backup.zip',
  force: true,
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.filesCompleted}/${progress.totalFiles}`);
  }
});
console.log(`Backup created: ${result.backupPath}`);
console.log(`Sessions: ${result.manifest.stats.sessionCount}`);

// Validate a backup
const validation = validateBackup('~/backup.zip');
if (validation.status === 'valid') {
  console.log('Backup is valid');
} else if (validation.status === 'warnings') {
  console.log('Backup has warnings:', validation.corruptedFiles);
}

// Restore from backup
const restoreResult = restoreBackup({
  backupPath: '~/backup.zip',
  force: true
});
console.log(`Restored ${restoreResult.filesRestored} files`);

// List available backups
const backups = listBackups();  // Scans ~/cursor-history-backups/
for (const backup of backups) {
  console.log(`${backup.filename}: ${backup.manifest?.stats.sessionCount} sessions`);
}

// Read sessions from backup without restoring
const sessions = listSessions({ backupPath: '~/backup.zip' });
```

### Available Functions

| Function | Description |
|----------|-------------|
| `listSessions(config?)` | List sessions with pagination |
| `getSession(index, config?)` | Get full session by index |
| `searchSessions(query, config?)` | Search across sessions |
| `exportSessionToJson(index, config?)` | Export session to JSON |
| `exportSessionToMarkdown(index, config?)` | Export session to Markdown |
| `exportAllSessionsToJson(config?)` | Export all sessions to JSON |
| `exportAllSessionsToMarkdown(config?)` | Export all sessions to Markdown |
| `migrateSession(config)` | Move/copy sessions to another workspace |
| `migrateWorkspace(config)` | Move/copy all sessions between workspaces |
| `createBackup(config?)` | Create full backup of all chat history |
| `restoreBackup(config)` | Restore chat history from backup |
| `validateBackup(path)` | Validate backup integrity |
| `listBackups(directory?)` | List available backup files |
| `getDefaultBackupDir()` | Get default backup directory path |
| `getDefaultDataPath()` | Get platform-specific Cursor data path |
| `setDriver(name)` | Set SQLite driver ('better-sqlite3' or 'node:sqlite') |
| `getActiveDriver()` | Get currently active SQLite driver name |

### Configuration Options

```typescript
interface LibraryConfig {
  dataPath?: string;       // Custom Cursor data path
  workspace?: string;      // Filter by workspace path
  limit?: number;          // Pagination limit
  offset?: number;         // Pagination offset
  context?: number;        // Search context lines
  backupPath?: string;     // Read from backup file instead of live data
  sqliteDriver?: 'better-sqlite3' | 'node:sqlite';  // Force specific SQLite driver
}
```

### Error Handling

```typescript
import {
  listSessions,
  createBackup,
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isBackupError,
  isRestoreError,
  isInvalidBackupError
} from 'cursor-history';

try {
  const result = listSessions();
} catch (err) {
  if (isDatabaseLockedError(err)) {
    console.error('Database locked - close Cursor and retry');
  } else if (isDatabaseNotFoundError(err)) {
    console.error('Cursor data not found');
  } else if (isSessionNotFoundError(err)) {
    console.error('Session not found');
  } else if (isWorkspaceNotFoundError(err)) {
    console.error('Workspace not found - open project in Cursor first');
  }
}

// Backup-specific errors
try {
  const result = await createBackup();
} catch (err) {
  if (isBackupError(err)) {
    console.error('Backup failed:', err.message);
  } else if (isInvalidBackupError(err)) {
    console.error('Invalid backup file');
  } else if (isRestoreError(err)) {
    console.error('Restore failed:', err.message);
  }
}
```

## Development

### Building from Source

```bash
npm install
npm run build
```

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

### Releasing to NPM

This project uses GitHub Actions for automatic NPM publishing. To release a new version:

1. Update version in `package.json`:
   ```bash
   npm version patch  # For bug fixes (0.1.0 -> 0.1.1)
   npm version minor  # For new features (0.1.0 -> 0.2.0)
   npm version major  # For breaking changes (0.1.0 -> 1.0.0)
   ```

2. Push the version tag to trigger automatic publishing:
   ```bash
   git push origin main --tags
   ```

3. The GitHub workflow will automatically:
   - Run type checks, linting, and tests
   - Build the project
   - Publish to NPM with provenance

**First-time setup**: Add your NPM access token as a GitHub secret named `NPM_TOKEN`:
1. Create an NPM access token at https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Go to your GitHub repository settings → Secrets and variables → Actions
3. Add a new repository secret named `NPM_TOKEN` with your NPM token

## Contributing

We welcome contributions from the community! Here's how you can help:

### Reporting Issues

- **Bug reports**: [Open an issue](https://github.com/S2thend/cursor_chat_history/issues/new) with steps to reproduce, expected vs actual behavior, and your environment (OS, Node.js version)
- **Feature requests**: [Open an issue](https://github.com/S2thend/cursor_chat_history/issues/new) describing the feature and its use case

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests and linting (`npm test && npm run lint`)
5. Commit your changes (`git commit -m 'Add my feature'`)
6. Push to your fork (`git push origin feature/my-feature`)
7. [Open a Pull Request](https://github.com/S2thend/cursor_chat_history/pulls)

### Development Setup

```bash
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build
npm test
```

## License

MIT