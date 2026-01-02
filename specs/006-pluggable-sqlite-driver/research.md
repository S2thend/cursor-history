# Research: Pluggable SQLite Driver

**Feature**: 006-pluggable-sqlite-driver
**Date**: 2026-01-02

## Research Tasks

### 1. API Compatibility: better-sqlite3 vs node:sqlite

**Decision**: Both drivers share a compatible synchronous API for the operations used by cursor-history.

**Rationale**:
- Node's built-in SQLite module "adopted much of [better-sqlite3's] API signature" (per maintainer)
- Core methods are identical: `prepare()`, `get()`, `all()`, `run()`
- Statement objects have matching method signatures
- Both use synchronous model

**Alternatives Considered**:
- sql.js (WASM): Compatible API but async-ish, larger bundle, slower. Deferred to future iteration.
- sqlite3 (async): Different paradigm, would require major refactoring. Rejected.

**API Mapping**:

| Operation | better-sqlite3 | node:sqlite | Compatible |
|-----------|---------------|-------------|------------|
| Open DB | `new Database(path, opts)` | `new DatabaseSync(path)` | Wrapper needed |
| Prepare | `db.prepare(sql)` | `db.prepare(sql)` | Yes |
| Get row | `stmt.get(...params)` | `stmt.get(...params)` | Yes |
| Get all | `stmt.all(...params)` | `stmt.all(...params)` | Yes |
| Run | `stmt.run(...params)` | `stmt.run(...params)` | Yes |
| DB exec | `db.exec(sql)` | `db.exec(sql)` | Yes |
| Close | `db.close()` | `db.close()` | Yes |

**Key Differences**:
1. Constructor: better-sqlite3 accepts options object, node:sqlite does not support `readonly` mode natively
2. node:sqlite requires `--experimental-sqlite` flag on Node 22.5-23.x
3. better-sqlite3 has additional features (pragma, transaction, backup) not exposed in abstraction

### 2. node:sqlite Experimental Status

**Decision**: Use dynamic import with try-catch for silent fallback when node:sqlite unavailable.

**Rationale**:
- Node 22.5-23.x requires `--experimental-sqlite` flag
- Node 24+ expected to stabilize the module
- Dynamic import failure is a clean signal for fallback
- No user configuration burden

**Implementation Pattern**:
```typescript
async function checkNodeSqliteAvailable(): Promise<boolean> {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}
```

**Alternatives Considered**:
- Version detection: Brittle, doesn't account for flag presence
- Require explicit opt-in: Poor UX, defeats auto-detection purpose
- Warn user to add flag: Adds friction, not actionable in all contexts

### 3. Driver Selection Priority

**Decision**: node:sqlite first, better-sqlite3 as fallback.

**Rationale**:
- node:sqlite has no native bindings - no ESM/CommonJS compatibility issues
- Solves the Node 24 problem that motivated this feature
- better-sqlite3 still works on Node 20/22 where it's available
- Performance difference negligible for cursor-history workload

**Priority Order**:
1. User-specified driver (env var or config) - if set, use exclusively
2. node:sqlite - try import, use if successful
3. better-sqlite3 - try import, use if successful
4. Error - no driver available

### 4. Readonly Mode Handling

**Decision**: Implement readonly at application level, not driver level.

**Rationale**:
- node:sqlite doesn't support `readonly` option in constructor
- better-sqlite3 does support it
- For cursor-history, readonly is a safety feature for queries, not a hard requirement
- Can enforce readonly behavior by not exposing write operations on readonly connections

**Implementation**:
- Track readonly flag internally in wrapper
- For better-sqlite3: pass to constructor
- For node:sqlite: enforce at wrapper level (throw if write attempted on readonly)

### 5. Debug Logging Pattern

**Decision**: Use stderr with environment variable gate.

**Rationale**:
- Follows Unix convention (diagnostic to stderr)
- Environment variables are standard for debug flags
- No runtime overhead when disabled
- Compatible with existing cursor-history patterns

**Environment Variables**:
- `DEBUG` - general debug flag
- `CURSOR_HISTORY_DEBUG` - specific to this library

### 6. Backward Compatibility Strategy

**Decision**: Keep existing function signatures, change only implementation.

**Rationale**:
- `openDatabase()` and `openDatabaseReadWrite()` are exported from storage.ts
- These functions are used throughout the codebase
- Existing tests depend on return types
- Changing to abstracted types requires careful typing

**Implementation**:
- Create new `src/core/database/` module
- Export from database/index.ts with identical signatures
- Update storage.ts imports
- Return type matches `Database` interface (duck-typed with better-sqlite3)

## Resolved Clarifications

All NEEDS CLARIFICATION items from Technical Context have been resolved:

1. Language/Version: TypeScript 5.9+ (from constitution)
2. Primary Dependencies: better-sqlite3 + node:sqlite
3. Testing: Vitest (from constitution)
4. Target Platform: Node.js 20, 22, 24+ (from spec)
5. Performance Goals: < 100ms startup (from spec SC-005)

## Next Steps

Proceed to Phase 1: Design and Contracts
- data-model.md: Define TypeScript interfaces
- contracts/: Export interface definitions
- quickstart.md: Developer guide for driver usage
