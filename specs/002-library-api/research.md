# Research: Library API for Cursor History Access

**Feature**: 002-library-api
**Date**: 2025-12-22
**Status**: Complete

**IMPORTANT**: This is a **library interface** for direct import and use in TypeScript/JavaScript projects, NOT a network/REST API. Research focuses on TypeScript function exports, not HTTP endpoints.

## Purpose

This document captures research findings and design decisions for transforming cursor-history into a reusable library. All "NEEDS CLARIFICATION" items from Technical Context have been resolved through analysis of existing codebase and industry best practices.

## Research Areas

### 1. Dual ESM/CommonJS Export Strategy

**Decision**: Use `package.json` exports field with conditional exports

**Rationale**:
- TypeScript `moduleResolution: "NodeNext"` already configured, natively supports exports field
- Avoids need for separate build processes or bundlers
- Node.js 20 LTS has full support for conditional exports
- Enables tree-shaking for ESM consumers while maintaining CJS backward compatibility

**Implementation Approach**:
```json
{
  "main": "./dist/lib/index.js",
  "types": "./dist/lib/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/lib/index.js",
      "require": "./dist/lib/index.cjs",
      "types": "./dist/lib/index.d.ts"
    }
  }
}
```

**Alternatives Considered**:
- **Bundler (tsup/esbuild)**: Rejected - adds build complexity when TypeScript compiler can emit both formats
- **Dual package hazard workaround**: Not needed - stateless API has no shared mutable state

**References**:
- Node.js Conditional Exports: https://nodejs.org/api/packages.html#conditional-exports
- TypeScript moduleResolution NodeNext: https://www.typescriptlang.org/tsconfig#moduleResolution

---

### 2. Stateless Database Connection Pattern

**Decision**: Open/close better-sqlite3 connection within each exported function

**Rationale**:
- Simplest implementation - no connection pooling, no lifecycle management
- better-sqlite3 is synchronous, so open/close overhead is negligible (< 1ms)
- Aligns with functional API design (no classes/instances)
- Prevents resource leaks - each call is self-contained
- Node.js file descriptor limits are high (typically 1024+), unlikely to exhaust with CLI-style usage

**Implementation Approach**:
```typescript
export function listSessions(config?: LibraryConfig): Session[] {
  const dbPath = resolveDatabasePath(config?.dataPath);
  const db = openDatabase(dbPath); // opens connection
  try {
    const sessions = querySessionsFromDatabase(db, config);
    return sessions;
  } finally {
    db.close(); // always closes, even on error
  }
}
```

**Alternatives Considered**:
- **Connection pooling**: Rejected - adds complexity, overkill for read-only CLI-style operations
- **Singleton connection**: Rejected - requires global state, complicates testing, not stateless
- **User-managed connection**: Rejected - violates FR-013 (stateless design)

**Trade-offs**:
- ✅ Simplicity: No lifecycle, no cleanup, no shared state
- ✅ Reliability: No connection leak bugs
- ⚠️ Performance: Extra ~1ms per call (acceptable for CLI-style usage)
- ❌ Not suitable for: High-frequency polling (100+ req/s) - not a stated requirement

---

### 3. Error Hierarchy Design

**Decision**: Create custom error classes extending base `Error` with distinguishable names

**Rationale**:
- Enables consumers to catch specific error types (e.g., `catch (e) { if (e instanceof DatabaseLockedError) ... }`)
- TypeScript discriminated unions work naturally with `instanceof` checks
- Preserves stack traces (extends `Error`)
- No additional dependencies (built-in JavaScript)

**Implementation Approach**:
```typescript
export class DatabaseLockedError extends Error {
  constructor(path: string) {
    super(`Database is locked: ${path}. Close Cursor or retry later.`);
    this.name = 'DatabaseLockedError';
  }
}

export class DatabaseNotFoundError extends Error {
  constructor(path: string) {
    super(`Database not found: ${path}. Check dataPath configuration.`);
    this.name = 'DatabaseNotFoundError';
  }
}

export class CorruptedDataWarning extends Error {
  constructor(details: string) {
    super(`Corrupted data encountered: ${details}`);
    this.name = 'CorruptedDataWarning';
  }
}
```

**Alternatives Considered**:
- **Error codes (errno-style)**: Rejected - less idiomatic in TypeScript, harder to handle
- **Result type (Rust-style)**: Rejected - not idiomatic in JavaScript/TypeScript ecosystem
- **Third-party error library**: Rejected - violates "minimize dependencies" principle

---

### 4. Configuration Merging Strategy

**Decision**: Explicit config parameter per function, no global defaults

**Rationale**:
- Stateless design forbids global configuration state
- Makes dependencies explicit (easier to test, no hidden state)
- TypeScript optional parameters provide good DX: `listSessions()` vs `listSessions({dataPath: '...'})`

**Implementation Approach**:
```typescript
export interface LibraryConfig {
  dataPath?: string;      // Optional custom path, defaults to platform path
  workspace?: string;     // Optional workspace filter
  limit?: number;         // Optional pagination limit
  offset?: number;        // Optional pagination offset
}

export function listSessions(config?: LibraryConfig): Session[] {
  const resolvedConfig = {
    dataPath: config?.dataPath ?? getPlatformDefaultPath(),
    workspace: config?.workspace,
    limit: config?.limit,
    offset: config?.offset ?? 0
  };
  // ... use resolvedConfig
}
```

**Alternatives Considered**:
- **Global config setter**: Rejected - violates stateless requirement
- **Environment variables**: Rejected - implicit dependencies, hard to test
- **Config file**: Rejected - overkill for library (appropriate for CLI only)

---

### 5. Pagination Implementation

**Decision**: Simple limit/offset with total count metadata

**Rationale**:
- SQLite supports LIMIT/OFFSET natively
- Predictable behavior (offset-based pagination well-understood)
- No cursor state to manage (stateless requirement)
- Total count enables UI pagination controls

**Implementation Approach**:
```typescript
export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export function listSessions(config?: LibraryConfig): PaginatedResult<Session> {
  const limit = config?.limit ?? Number.MAX_SAFE_INTEGER; // No limit by default
  const offset = config?.offset ?? 0;

  const db = openDatabase(config?.dataPath);
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
    const data = db.prepare('SELECT * FROM sessions LIMIT ? OFFSET ?').all(limit, offset);

    return {
      data,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      }
    };
  } finally {
    db.close();
  }
}
```

**Alternatives Considered**:
- **Cursor-based pagination**: Rejected - requires stateful cursors (violates FR-013)
- **Async iterators**: Rejected - requires keeping connection open (violates stateless design)
- **Page-based pagination**: Rejected - less flexible than limit/offset

**Trade-offs**:
- ✅ Simple to implement and understand
- ✅ Works with stateless design
- ⚠️ Offset performance degrades with large offsets (acceptable for < 10k sessions)
- ❌ Not suitable for: Real-time data (not a requirement)

---

### 6. TypeScript Declaration Emit

**Decision**: Use TypeScript compiler's built-in `.d.ts` generation

**Rationale**:
- Already configured: `"declaration": true` in tsconfig.json
- Zero additional tooling needed
- Generates accurate types directly from implementation
- Declaration maps enabled for IDE navigation

**Implementation Approach**:
- No changes needed to existing tsconfig.json
- Verify `src/lib/index.ts` re-exports all public types
- Package.json `types` field points to `dist/lib/index.d.ts`

**Alternatives Considered**:
- **Handwritten .d.ts files**: Rejected - error-prone, duplicates maintenance
- **API Extractor**: Rejected - overkill for simple library

---

### 7. Handling Symlinks and Special Characters in Paths

**Decision**: Resolve symlinks with `fs.realpathSync`, URL-encode special characters

**Rationale**:
- SQLite requires absolute paths
- Symlinks common in Unix systems (e.g., `/tmp` → `/private/tmp` on macOS)
- Special characters (spaces, unicode) handled by Node.js path module
- URL encoding prevents path injection attacks

**Implementation Approach**:
```typescript
import { realpathSync } from 'fs';
import { resolve, normalize } from 'path';

function resolveDatabasePath(configPath?: string): string {
  const basePath = configPath ?? getPlatformDefaultPath();
  const normalized = normalize(basePath);
  const resolved = resolve(normalized);

  try {
    return realpathSync(resolved); // Resolves symlinks
  } catch (err) {
    throw new DatabaseNotFoundError(resolved);
  }
}
```

**Alternatives Considered**:
- **Leave symlinks unresolved**: Rejected - SQLite may fail on some symlink types
- **Percent-encode paths**: Rejected - unnecessary, Node.js handles special chars

---

### 8. Logging Strategy for Corrupted Entries

**Decision**: Use `console.warn` for skipped entries, no external logging library

**Rationale**:
- Simplest implementation (no dependencies)
- Console output is standard for Node.js libraries
- Users can redirect stderr if needed
- Structured format allows parsing if needed

**Implementation Approach**:
```typescript
function parseSessionEntry(row: unknown): Session | null {
  try {
    return parseValidSession(row);
  } catch (err) {
    console.warn(`[cursor-history] Skipping corrupted session: ${err.message}`);
    return null; // Caller filters nulls
  }
}
```

**Alternatives Considered**:
- **Silent skip**: Rejected - users need visibility into data quality
- **External logger (winston/pino)**: Rejected - adds dependency, overkill
- **Callback-based logging**: Rejected - violates stateless/simple design

---

## Summary of Design Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| Module Format | Dual ESM/CJS via exports field | Node.js 20 native support, no bundler needed |
| Connection Lifecycle | Open/close per function call | Simplest, prevents leaks, stateless |
| Error Handling | Custom Error subclasses | Typed catches, idiomatic JavaScript |
| Configuration | Explicit per-function parameter | Stateless, testable, clear dependencies |
| Pagination | Limit/offset with metadata | Native SQLite support, simple to understand |
| Type Definitions | Built-in TypeScript emit | Zero tooling overhead, always in sync |
| Path Resolution | `realpathSync` for symlinks | Handles edge cases, secure |
| Logging | `console.warn` for corruption | Simple, standard, no dependencies |

All decisions align with Constitution Principle I (Simplicity First) and require zero new dependencies.

---

## Open Questions

None. All technical unknowns resolved through research.
