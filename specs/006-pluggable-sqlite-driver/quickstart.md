# Quickstart: Pluggable SQLite Driver

**Feature**: 006-pluggable-sqlite-driver
**Date**: 2026-01-02

## Overview

The pluggable SQLite driver enables cursor-history to work across different Node.js versions by automatically selecting the best available SQLite driver.

## For End Users (CLI)

### It Just Works

No configuration needed. cursor-history automatically detects and uses the best available driver:

```bash
# Works on Node.js 20, 22, and 24+
cursor-history list
```

### Debugging Driver Selection

If you want to see which driver is being used:

```bash
# Enable debug output
CURSOR_HISTORY_DEBUG=1 cursor-history list
```

Output will show:
```
[cursor-history:sqlite] Auto-detected driver: node:sqlite
```

### Manual Driver Override

Force a specific driver if needed:

```bash
# Force better-sqlite3
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list

# Force node:sqlite (requires Node 22.5+ with flag or Node 24+)
CURSOR_HISTORY_SQLITE_DRIVER=node:sqlite cursor-history list
```

## For Library Users

### Basic Usage (Auto-Detection)

```typescript
import { listSessions } from 'cursor-history';

// Driver is auto-selected - no configuration needed
const sessions = listSessions();
```

### Manual Driver Selection via Config

```typescript
import { listSessions } from 'cursor-history';

// Specify driver in config
const sessions = listSessions({
  sqliteDriver: 'better-sqlite3'  // or 'node:sqlite'
});
```

### Checking Active Driver

```typescript
import { getActiveDriver } from 'cursor-history';

console.log(`Using driver: ${getActiveDriver()}`);
// Output: "Using driver: node:sqlite"
```

### Runtime Driver Switching

```typescript
import { setDriver, getActiveDriver } from 'cursor-history';

console.log(getActiveDriver());  // "node:sqlite"

setDriver('better-sqlite3');

console.log(getActiveDriver());  // "better-sqlite3"
```

### Error Handling

```typescript
import {
  listSessions,
  NoDriverAvailableError,
  DriverNotAvailableError
} from 'cursor-history';

try {
  const sessions = listSessions({ sqliteDriver: 'better-sqlite3' });
} catch (err) {
  if (err instanceof DriverNotAvailableError) {
    console.error('better-sqlite3 not installed');
    console.error('Run: npm install better-sqlite3');
  } else if (err instanceof NoDriverAvailableError) {
    console.error('No SQLite driver available');
    console.error('Install better-sqlite3 or use Node.js 22.5+');
  }
}
```

## Driver Priority

When auto-detecting, drivers are tried in this order:

1. **node:sqlite** (Node.js built-in)
   - No native bindings needed
   - ESM compatible
   - Requires Node 22.5+ (with `--experimental-sqlite` flag on 22.5-23.x)

2. **better-sqlite3** (npm package)
   - Native bindings (faster)
   - Works on Node 20+
   - May have ESM issues on Node 24+

## Requirements by Node Version

| Node Version | node:sqlite | better-sqlite3 | Recommended |
|--------------|-------------|----------------|-------------|
| 20.x LTS     | ❌ No       | ✅ Yes         | better-sqlite3 |
| 22.5-23.x    | ⚠️ Flag*    | ✅ Yes         | better-sqlite3 |
| 24.x+        | ✅ Yes      | ⚠️ ESM issues  | node:sqlite |

*Requires `--experimental-sqlite` flag

## Troubleshooting

### "No SQLite driver available"

**On Node 20-22:**
```bash
npm install better-sqlite3
```

**On Node 24+:**
The built-in node:sqlite should work automatically. If not:
```bash
npm install better-sqlite3
```

### "Cannot find module 'better-sqlite3'"

This native module needs to be compiled. Ensure you have build tools:

**macOS:**
```bash
xcode-select --install
```

**Linux:**
```bash
sudo apt-get install build-essential python3
```

**Windows:**
```bash
npm install --global windows-build-tools
```

### Driver works locally but fails in CI

Ensure your CI has the appropriate Node version or better-sqlite3 build dependencies.

For Node 24+ CI environments, no extra dependencies are needed (uses node:sqlite).
