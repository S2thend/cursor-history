# Quickstart: Fix Migration File Path References

**Date**: 2025-12-25
**Feature**: 005-fix-migration-paths

## Overview

This feature fixes a bug where file path references in migrated sessions point to the wrong workspace. After this fix:

- Migrated sessions have all file paths updated to the destination workspace
- Debug mode (`--debug`) shows detailed path transformation logs
- Nested path migrations (dest inside source) are blocked to prevent corruption

## Usage

### Basic Migration (paths now auto-updated)

```bash
# Move a session - file paths will be updated automatically
cursor-history migrate-session 1 ~/projects/new-project

# Copy a session - original keeps old paths, copy gets new paths
cursor-history migrate-session 1 ~/projects/new-project --copy
```

### Debug Mode

```bash
# See detailed path transformation logs
cursor-history migrate-session 1 ~/projects/new-project --debug

# Example debug output:
# [DEBUG] Processing bubble: abc123-def456
# [DEBUG] toolFormerData.params.relativeWorkspacePath: /old/project/src/file.ts -> /new/project/src/file.ts
# [DEBUG] codeBlocks[0].uri.path: /old/project/config.json -> /new/project/config.json
# [SKIP] codeBlocks[1].uri.path: /usr/local/lib/node.ts (outside workspace)
```

### Dry Run with Path Preview

```bash
# Preview what will change (no actual modification)
cursor-history migrate-session 1 ~/projects/new-project --dry-run

# Output now includes path transformation info
```

## Implementation Notes

### Key Function: `transformBubblePaths()`

Located in `src/core/migrate.ts`:

```typescript
function transformBubblePaths(
  bubbleData: Record<string, unknown>,
  sourcePrefix: string,
  destPrefix: string,
  debug: boolean
): { transformed: number; skipped: number }
```

This function is called for each bubble during `copyBubbleDataInGlobalStorage()`.

### Path Fields Updated

1. `toolFormerData.params.relativeWorkspacePath`
2. `toolFormerData.params.targetFile`
3. `toolFormerData.params.filePath`
4. `toolFormerData.params.path`
5. `codeBlocks[].uri.path`
6. `codeBlocks[].uri._formatted`
7. `codeBlocks[].uri._fsPath`

### Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `NestedPathError` | Destination is subdirectory of source | Choose non-nested destination |
| `SessionNotFoundError` | Session ID not found | Verify session exists with `list` |
| `WorkspaceNotFoundError` | Workspace path not found | Verify workspace has Cursor history |

## Testing

```bash
# Run unit tests for path transformation
npm test -- --grep "transformBubblePaths"

# Run integration tests
npm test -- --grep "migrate-debug"
```

## Files Changed

| File | Change |
|------|--------|
| `src/core/migrate.ts` | Add `transformBubblePaths()`, update `copyBubbleDataInGlobalStorage()` |
| `src/core/types.ts` | Add `debug` option to migration types |
| `src/cli/commands/migrate.ts` | Add `--debug` flag |
| `src/cli/commands/migrate-session.ts` | Add `--debug` flag |
