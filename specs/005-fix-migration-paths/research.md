# Research: Fix Migration File Path References

**Date**: 2025-12-25
**Feature**: 005-fix-migration-paths

## Research Tasks

### 1. File Path Storage Locations in Bubble Data

**Task**: Identify all locations where absolute file paths are stored in bubble data.

**Findings** (from debug.js analysis of actual backup data):

| Location | Example Value | Update Required |
|----------|---------------|-----------------|
| `toolFormerData.params.relativeWorkspacePath` | `/Users/dev/project-a/src/file.ts` | Yes |
| `toolFormerData.params.targetFile` | `/Users/dev/project-a/config.json` | Yes |
| `toolFormerData.params.filePath` | `/Users/dev/project-a/src/app.ts` | Yes |
| `toolFormerData.params.path` | `/Users/dev/project-a/README.md` | Yes |
| `codeBlocks[].uri.path` | `/Users/dev/project-a/src/file.ts` | Yes |
| `codeBlocks[].uri._formatted` | `file:///Users/dev/project-a/src/file.ts` | Yes |
| `codeBlocks[].uri._fsPath` | `/Users/dev/project-a/src/file.ts` | Yes |

**Decision**: Update all 7 locations using prefix replacement.
**Rationale**: These are the only locations found storing absolute file paths in bubble data.
**Alternatives**: Considered regex pattern matching, but prefix replacement is simpler and more reliable.

### 2. Path Transformation Strategy

**Task**: Determine the safest approach to transform paths.

**Findings**:

1. **Prefix replacement** is sufficient because:
   - All paths start with the workspace root
   - Paths are absolute (despite `relativeWorkspacePath` name)
   - No path components contain the workspace path as a substring

2. **Normalization requirements**:
   - Remove trailing slashes before comparison
   - Handle both forward and back slashes (Windows compatibility)
   - Case-insensitive comparison on Windows

**Decision**: Use simple string prefix replacement with normalized paths.
**Rationale**: Existing `normalizePath()` in platform.ts handles normalization.
**Alternatives**: Considered path.relative() + path.join(), but this adds complexity without benefit.

### 3. Nested Path Detection

**Task**: How to detect if destination is a subdirectory of source (to prevent infinite replacement loops).

**Findings**:

```typescript
// Example: source=/project, dest=/project/subdir
// Path: /project/src/file.ts
// After replacement: /project/subdir/src/file.ts
// But /project/subdir ALSO starts with /project!
// Second replacement would create: /project/subdir/subdir/src/file.ts
```

**Decision**: Check if normalized destination starts with normalized source (with trailing separator).
**Rationale**: This catches all nested path scenarios without complex path parsing.
**Implementation**:
```typescript
const normalizedSource = normalizePath(source);
const normalizedDest = normalizePath(dest);
if (normalizedDest.startsWith(normalizedSource + '/')) {
  throw new NestedPathError(source, dest);
}
```

### 4. Debug Logging Pattern

**Task**: Best practice for debug output in CLI tools.

**Findings**:

1. **stderr is standard** for debug/diagnostic output (keeps stdout clean for piping)
2. **Prefix with context** for scannability: `[DEBUG] bubbleId:xxx processing...`
3. **Show before/after** for transformations: `/old/path -> /new/path`
4. **Skip reason** for non-transformed paths: `[SKIP] /external/path (outside workspace)`

**Decision**: Use `console.error()` with `[DEBUG]` prefix, controlled by options.debug flag.
**Rationale**: Follows Unix conventions; no additional dependencies needed.
**Alternatives**: Considered debug npm package, but adds unnecessary dependency.

### 5. Testing Strategy

**Task**: How to test path transformation without modifying real Cursor data.

**Findings**:

1. **Unit tests**: Test `transformBubblePaths()` function directly with mock bubble data
2. **Integration tests**: Create temporary SQLite databases with test data
3. **Existing pattern**: Project uses Vitest with in-memory test fixtures

**Decision**: Unit test the path transformation function; integration test via CLI with temp databases.
**Rationale**: Follows existing test patterns in the project.

## Summary

All research questions resolved. Implementation approach:

1. Add `transformBubblePaths(bubbleData, sourcePrefix, destPrefix, debug?)` function
2. Call it in `copyBubbleDataInGlobalStorage()` for each bubble
3. Add nested path check before migration starts
4. Add `--debug` flag to CLI commands, pass through options
5. Debug output to stderr with `[DEBUG]` prefix
