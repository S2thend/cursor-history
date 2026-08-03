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
// Message remains backward-compatible: timestamp stays required, while
// toolCalls.result / tokenUsage / model remain optional. When a Store message
// has no directly mapped turn time, the Library uses the session creation time
// and leaves timestampSource absent. Core CLI rendering still omits an unknown
// Store turn time rather than presenting that fallback as precise provenance.
```

## Configuration (`LibraryConfig`)
- `dataPath?`: Refers to `~/.cursor` → Store stack takes precedence; by default both stack roots are scanned.
- When `dataPath` is omitted, the Library keeps that absence explicit while the core resolves the platform default. This preserves runtime conflict priority: WSL and an explicit non-default `CURSOR_STORE_ROOT` can prefer Store instead of being masked by a synthesized Composer path.
- No new required configuration; Store stack discovery is **enabled by default**.

## Error Handling
- Store stack parsing failures **do not throw** (degrade to `transcript` or skip the single file).
- Only when both the Composer stack and the Store stack are empty → return an empty result (do not throw).
- Reuse existing error classes; P1 adds no new public error types.

## Backward Compatibility
- The new `source` values are an **additive extension**; existing consumers can simply ignore unknown sources.
- No existing function signatures or return structures are broken.
- The required `Message.timestamp` field remains present for every Library message; Store-only fallback timestamps do not claim direct timestamp provenance.
- Calls remain stateless across public API invocations. Each invocation creates one private read context bound to one data source and one normalized workspace scope; there is no process-global cache, TTL, or cross-call reuse.
- Within that invocation, the context reuses the complete scoped summary list and Store discovery result. Full Composer-only, Store-only, and merged sessions are resolved lazily by stable ID and cached only after the final `ChatSession` has been produced.
- Concurrent reads of the same session share one in-flight resolution. Repeated reads receive deep copies of the cached result, and a rejected resolution is removed so the same operation can retry.
