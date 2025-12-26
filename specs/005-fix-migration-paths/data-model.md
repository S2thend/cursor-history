# Data Model: Fix Migration File Path References

**Date**: 2025-12-25
**Feature**: 005-fix-migration-paths

## Entities

### BubbleData (existing, modified during migration)

Individual message entries in globalStorage's cursorDiskKV table.

```typescript
interface BubbleData {
  bubbleId: string;
  type: 1 | 2;  // 1=user, 2=assistant
  createdAt?: number;

  // Contains file paths that need transformation
  toolFormerData?: ToolFormerData;
  codeBlocks?: CodeBlock[];

  // Other fields preserved as-is
  text?: string;
  thinking?: { text: string };
  [key: string]: unknown;
}
```

### ToolFormerData (existing, contains file paths)

Metadata about tool executions stored within bubble data.

```typescript
interface ToolFormerData {
  name: string;  // read_file, write, edit_file, etc.
  params?: string;  // JSON string containing file path fields
  result?: string;  // JSON string (may contain paths in diff blocks)
  status?: string;
  [key: string]: unknown;
}

// Parsed params structure (varies by tool)
interface ToolParams {
  relativeWorkspacePath?: string;  // Actually absolute path
  targetFile?: string;
  filePath?: string;
  path?: string;
  [key: string]: unknown;
}
```

### CodeBlock (existing, contains file URIs)

Code snippets with associated file references.

```typescript
interface CodeBlock {
  content?: string;
  languageId?: string;
  uri?: CodeBlockUri;
}

interface CodeBlockUri {
  path?: string;       // /Users/dev/project/src/file.ts
  _formatted?: string; // file:///Users/dev/project/src/file.ts
  _fsPath?: string;    // /Users/dev/project/src/file.ts
  [key: string]: unknown;
}
```

### PathTransformContext (new)

Context passed to path transformation functions.

```typescript
interface PathTransformContext {
  sourcePrefix: string;  // Normalized source workspace path
  destPrefix: string;    // Normalized destination workspace path
  debug: boolean;        // Whether to log transformations
}
```

### PathTransformResult (new)

Result of transforming paths in a single bubble.

```typescript
interface PathTransformResult {
  transformed: number;  // Count of paths updated
  skipped: number;      // Count of external paths preserved
  bubbleId: string;
}
```

## Validation Rules

1. **Source and destination paths must be absolute**
   - Validation: Check path starts with `/` (Unix) or drive letter (Windows)
   - Error: `InvalidPathError`

2. **Destination cannot be nested within source**
   - Validation: `!normalizedDest.startsWith(normalizedSource + '/')`
   - Error: `NestedPathError`

3. **Only paths starting with source prefix are transformed**
   - Validation: `path.startsWith(sourcePrefix)`
   - Action: Skip without error; log in debug mode

## State Transitions

```
┌─────────────────────────────────────────────────────────────┐
│                    Migration Flow                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Start] ──► Validate Paths ──► Check Nested ──► [Error]   │
│                   │                   │                     │
│                   ▼                   ▼                     │
│              [Valid]            [Not Nested]                │
│                   │                   │                     │
│                   └───────┬───────────┘                     │
│                           ▼                                 │
│                   Copy Bubble Data                          │
│                           │                                 │
│                           ▼                                 │
│              ┌─────────────────────────┐                   │
│              │  For each bubble:       │                   │
│              │  1. Update bubbleId     │                   │
│              │  2. Transform paths ◄───┼── NEW             │
│              │  3. Insert to DB        │                   │
│              └─────────────────────────┘                   │
│                           │                                 │
│                           ▼                                 │
│                      [Complete]                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Database Operations

### Read (existing)
```sql
SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:{composerId}:%'
```

### Write (modified)
```sql
-- Bubble value now includes transformed paths
INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)
```

No schema changes required. All modifications are to the JSON stored in the `value` column.
