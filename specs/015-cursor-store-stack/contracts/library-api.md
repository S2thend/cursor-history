# Library API Contract: Cursor Store Storage Stack Support

> Corresponds to `spec.md` FR-030 / FR-031 / FR-032. The Library (`src/lib`) passes through the Store session contract.

## Affected Functions (Signatures Unchanged, Return Values Extended)

| Function | Change |
|---|---|
| `listSessions(config?)` | Return results include Store stack sessions (merged with the Composer stack, deduplicated by ID) |
| `getSession(identifier, config?)` | When the identifier is a Store stack uuid, returns that session (`store.db` is the primary message source; transcript is the fallback) |
| `searchSessions(query, config?)` | Covers Store stack session text |
| `exportSessionToMarkdown / ToJson / exportAllSessions*` | Covers Store stack sessions |

> Zero changes to function signatures — the Store stack is incorporated at the `src/core/storage.ts` layer; the library only performs type conversion and passthrough.

## Type Extensions (`src/lib/types.ts`)

```ts
interface Session {
  // ...existing fields unchanged
  source?:
    | 'global'
    | 'workspace-fallback'
    | 'transcript'
    | 'store'
    | 'store-complete'
    | 'store-partial'
    | 'merged';
  sources?: Array<'composer' | 'store'>;
  preferredSource?: 'composer' | 'store';
  transcriptState?:
    | 'missing'
    | 'parsed'
    | 'partial'
    | 'empty'
    | 'error-only'
    | 'unsupported'
    | 'unreadable';
}
// Message unchanged: toolCalls.result / tokenUsage / model are already optional.
// The Store stack (P1) simply does not populate these optional fields;
// the semantics remain consistent with the existing behavior.
```

## Configuration (`LibraryConfig`)
- `dataPath?`: Refers to `~/.cursor` → Store stack takes precedence; by default both stack roots are scanned.
- No new required configuration; Store stack discovery is **enabled by default**.

## Error Handling
- Store stack parsing failures **do not throw** (degrade to `transcript` or skip the single file).
- Only when both the Composer stack and the Store stack are empty → return an empty result (do not throw).
- Reuse existing error classes; P1 adds no new public error types.

## Backward Compatibility
- The new `source` values are an **additive extension**; existing consumers can simply ignore unknown sources.
- No existing function signatures or return structures are broken.
- Calls remain stateless across public API invocations. Within one invocation, a private read context keeps scoped summaries and Store discovery consistent while full sessions are loaded.
