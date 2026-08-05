# CLI and Structured Output Contract

**Command**: `cursor-history`<br>
**Feature**: `016-harden-session-integrity`

## Global addressing and scope options

```text
--json
--data-path <path>
-w, --workspace <path>
--include-cross-workspace-sources
```

- `--workspace` accepts a normalized full historical path or one unambiguous component suffix.
- Normalized exact match wins. A unique suffix is used only when exact matching finds none.
- Ambiguous suffixes fail before conversation payload is opened.
- By default the workspace is both the logical membership scope and conversation-payload I/O
  boundary.
- `--include-cross-workspace-sources` may broaden reads only to contributors of UUIDs already
  selected in scope. It never scans unrelated conversation payload and discloses every broadened
  contributor.
- Global options apply uniformly to `list`, `show`, `search`, `export`, and `migrate-session`.

Numeric CLI and migration indices are one-based. An index is ephemeral and valid only with the same
data path/backup, workspace scope, and catalog snapshot that produced it. Once selected, the command
uses the bound UUID and occurrence set rather than resolving the number again.

## Common structured fields

Every JSON item containing a reusable `index` contains exactly one of:

```json
{
  "index": 1,
  "indexScope": "global"
}
```

or:

```json
{
  "index": 1,
  "indexScope": "workspace",
  "indexWorkspacePath": "/full/normalized/workspace-a"
}
```

`indexWorkspacePath` is required for `workspace` scope and absent for `global` scope. Physical
locators are never included.

Resolved session/summary objects may add:

```json
{
  "source": "global",
  "resolvedSource": "merged",
  "sources": ["composer", "store"],
  "preferredSource": "store",
  "resolution": {
    "state": "complete",
    "expectedSourceRoles": ["composer", "store"],
    "loadedSourceRoles": ["composer", "store"],
    "omittedSourceRoles": [],
    "failedSourceRoles": [],
    "reasonCodes": []
  },
  "canonicalWorkspacePath": "/work/a",
  "matchedWorkspacePath": "/work/a",
  "workspaceMatchKind": "exact",
  "workspaceMemberships": [
    {
      "workspacePath": "/work/a",
      "sourceRoles": ["composer", "store"],
      "contributingInstanceCount": 2
    }
  ],
  "sourceInstances": [
    {
      "sourceRole": "composer",
      "representation": "composer-global",
      "workspacePaths": ["/work/a"],
      "state": "contributed"
    },
    {
      "sourceRole": "store",
      "representation": "store-db",
      "workspacePaths": ["/work/a"],
      "state": "contributed"
    }
  ],
  "messageIdentityVersion": 1
}
```

The compatibility `workspacePath` remains the canonical path. `source` is fidelity:
`global` means complete/replacement-safe; `workspace-fallback` means partial/unsafe to overwrite
complete data. Actual representation is `resolvedSource`, including `store-metadata` when Store
metadata indicates a possible conversation but no conversation representation is usable. Every
resolved session also emits `createdAt`, `createdAtSource`, `lastUpdatedAt`, and
`lastUpdatedAtSource`; source values are `composer-metadata`, `store-db-metadata`, `store-meta`,
`direct-message`, or `epoch-unknown`.

When no canonical path is known, core/CLI JSON emits `"workspacePath": null` and omits
`canonicalWorkspacePath`. This is intentionally distinct from the public-library compatibility
alias `workspace: "unknown"`.

All set-like arrays are canonical before formatting: source roles are `composer`, then `store`;
reason codes follow declaration order; workspace memberships and every required source-instance
`workspacePaths` use normalized-path code-point order; source instances sort by role,
representation declaration order, lexicographic `workspacePaths`, then state declaration order;
and diagnostic refs sort by stable payload fingerprint with opaque-ref tie-breaker. Pathless source
instances emit `workspacePaths: []`. Formatters never apply discovery order.

## `list --json`

The existing top-level object remains and gains additive scope and diagnostics fields:

```json
{
  "count": 2,
  "indexScope": "workspace",
  "indexWorkspacePath": "/work/a",
  "sessions": [
    {
      "index": 1,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "id": "native-session-uuid",
      "title": "Example",
      "preview": "First user message…",
      "messageCount": 4,
      "source": "global",
      "resolvedSource": "merged",
      "sources": ["composer", "store"],
      "preferredSource": "store",
      "resolution": {
        "state": "complete",
        "expectedSourceRoles": ["composer", "store"],
        "loadedSourceRoles": ["composer", "store"],
        "omittedSourceRoles": [],
        "failedSourceRoles": [],
        "reasonCodes": []
      },
      "createdAt": "2026-08-05T12:00:00.000Z",
      "createdAtSource": "composer-metadata",
      "lastUpdatedAt": "2026-08-05T12:10:00.000Z",
      "lastUpdatedAtSource": "direct-message",
      "workspacePath": "/canonical/path",
      "canonicalWorkspacePath": "/canonical/path",
      "matchedWorkspacePath": "/work/a",
      "workspaceMatchKind": "exact",
      "workspaceMemberships": [
        {
          "workspacePath": "/work/a",
          "sourceRoles": ["composer", "store"],
          "contributingInstanceCount": 2
        }
      ],
      "sourceInstances": [
        {
          "sourceRole": "composer",
          "representation": "composer-global",
          "workspacePaths": ["/work/a"],
          "state": "contributed"
        },
        {
          "sourceRole": "store",
          "representation": "store-db",
          "workspacePaths": ["/work/a"],
          "state": "contributed"
        }
      ],
      "messageIdentityVersion": 1,
      "resolutionState": "complete"
    },
    {
      "index": 2,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "id": "ambiguous-native-uuid",
      "resolutionState": "ambiguous",
      "sourceRoles": ["composer"],
      "occurrenceCount": 2,
      "diagnosticOccurrenceRefs": ["occurrence:opaque-a", "occurrence:opaque-b"]
    }
  ],
  "diagnostics": [
    {
      "code": "SESSION_AMBIGUOUS",
      "message": "The logical session has divergent Composer replicas.",
      "sessionId": "ambiguous-native-uuid",
      "occurrenceCount": 2,
      "occurrenceRefs": ["occurrence:opaque-a", "occurrence:opaque-b"],
      "remedy": "Resolve the duplicate data outside this command and retry."
    }
  ]
}
```

An ambiguous row has no contested preview/title/message payload. Empty output retains
`{"count":0,"sessions":[]}` and adds the active scope fields plus an actionable diagnostic when the
workspace did not match.

Each non-ambiguous list item is exactly a `ResolvedSessionSummary`: the full resolved metadata plus
required `title`, `preview`, `messageCount`, and `resolutionState`, with no `messages` key.
`resolutionState` equals `resolution.state`.

`count` is the number of scoped logical rows represented by `sessions`, including one row per
ambiguous UUID; it is not the count of successfully hydrated conversation payloads.

`list --workspaces --json` counts one logical UUID once per membership. A multi-membership session
may count once in both A and B, so the sum can exceed the deduplicated global total.

## `show --json`

`show` returns the existing single-session object with additive index, path, fidelity, provenance,
resolution, and identity fields. Every emitted message has:

```json
{
  "id": "stable-message-id",
  "messageIdentityVersion": 1,
  "identityOrigin": "composer-native",
  "role": "assistant",
  "content": "...",
  "timestamp": "2026-08-05T12:00:00.000Z",
  "timestampSource": "composer-timing",
  "parentMessageId": "stable-parent-id",
  "toolCalls": [
    {
      "id": "native-or-tool-v1-id",
      "identityOrigin": "source-native",
      "name": "read_file",
      "status": "completed"
    }
  ]
}
```

The three released direct timestamp-source literals are unchanged. New values are
`inferred-previous`, `inferred-next`, `session-fallback`, and `unknown`. JSON always contains a
timestamp/provenance pair for resolved messages.

Every emitted runtime/JSON tool call contains a nonempty `id` and `identityOrigin`. Source
attachment evidence has no new JSON member: supported evidence is projected losslessly into message
`content` (including fenced code) or consumed tool-call `name`, `status`, `params`, `result`, and
`error` fields. Standalone cursor-history `codeBlocks` and tool-call `files` do not satisfy the
unchanged-consumer compatibility contract. An unrepresentable raw block makes the session partial,
and parsing/hashing never dereferences its external target.

A partial session still returns successfully but includes `source: "workspace-fallback"`,
`resolution.state: "partial"`, and reasons. Human output prints a visible warning before the
conversation. An ambiguous UUID/index is a fatal typed error and yields no fake empty session.

## `search --json`

The existing envelope remains:

```json
{
  "query": "needle-a",
  "count": 1,
  "totalMatches": 1,
  "indexScope": "workspace",
  "indexWorkspacePath": "/work/a",
  "results": [
    {
      "index": 1,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "sessionId": "native-session-uuid",
      "workspacePath": "/canonical/path",
      "matchedWorkspacePath": "/work/a",
      "matchCount": 1,
      "snippets": []
    }
  ],
  "diagnostics": []
}
```

Search opens only permitted payload. Each ambiguous group is skipped once and produces exactly one
diagnostic. `count` and `totalMatches` count resolved search results only. An empty result preserves
the existing envelope and includes scope/diagnostics.

## `export --json`

Each export-result file item gains its bound address:

```json
{
  "count": 1,
  "files": [
    {
      "index": 1,
      "indexScope": "workspace",
      "indexWorkspacePath": "/work/a",
      "sessionId": "native-session-uuid",
      "path": "/exports/session.json"
    }
  ],
  "diagnostics": []
}
```

Single export fails for ambiguity. `--all` skips each ambiguity exactly once, reports it once, and
never writes a file for contested payload. Partial JSON/Markdown export is permitted only with an
explicit fidelity warning embedded in the output; it never presents itself as complete.

The session JSON written to disk contains the same identity, index-scope, path, resolution,
timestamp, relationship, and tool metadata as `show --json`. Markdown includes human-readable
fidelity and approximate-timestamp labels.

## `migrate-session`

The command consumes the parent `--workspace` option:

```bash
cursor-history --workspace /work/a migrate-session 1 /work/destination --dry-run
cursor-history --workspace /work/a migrate-session 1 /work/destination
```

Dry-run and execution share one target preparation contract. A scoped number selects the row shown
by scoped list, then binds an exact eligible Composer occurrence. Execution revalidates the same
occurrence/fingerprint and refuses any change before the first write.

Equivalent duplicate physical locators, a global record shared with another workspace membership,
Store-only, merged, and divergent sessions fail in preview and execution. A read representative or
diagnostic occurrence reference cannot bypass this refusal. Unfiltered numeric and direct native-ID
behavior for an eligible single-occurrence Composer session remains compatible.

JSON migration results add `sessionId`, normalized source/matched paths, eligibility, and dry-run
precondition summary, but never a locator. A changed target returns `MIGRATION_TARGET_CHANGED`.

## `backup`

Add:

```text
--shared    Create the final archive with explicitly broader platform-default access
```

Without `--shared`, a newly created final archive is owner-only (`0600` on POSIX). Force-overwrite
preserves an existing mode exactly. On POSIX, `--shared` explicitly selects the ordinary
non-executable mode `0666 & ~currentUmask`. Temporary plaintext snapshots/staging remain owner-only
even when the final archive is shared, and no command changes the process umask.

## Diagnostics and fatal errors

Successful/best-effort commands put nonfatal diagnostics in their existing stdout JSON envelope.
For a fatal branch that already emits a JSON error object, only `code` and safe `details` are
additive to its released object shape:

```json
{
  "error": "The logical session has divergent Composer replicas.",
  "code": "SESSION_AMBIGUOUS",
  "details": {
    "sessionId": "native-session-uuid",
    "sourceRole": "composer",
    "occurrenceCount": 2,
    "occurrenceRefs": ["occurrence:opaque-a", "occurrence:opaque-b"]
  }
}
```

No error details contain content or a raw physical locator.

This corrective release preserves the released output stream and exit code for every command/error
branch. Existing command-owned JSON failures that write to stdout continue to write to stdout;
existing failures routed through stderr continue to use stderr. Built-CLI regression fixtures lock
the v0.17 stream, object baseline, and exit code per branch. No existing stdout error moves to
stderr, no new stdout error path is introduced, and plain-text fatal branches are not silently
redefined as a universal JSON protocol. Normalizing all fatal JSON to stderr is out of scope and
requires a separately reviewed compatibility transition.

| Category | Exit code |
|----------|-----------|
| Existing success category | 0 |
| Existing general-error category | 1 |
| Existing usage-error category | 2 |
| Existing not-found category | 3 |
| Existing I/O-error category | 4 |

The table names the existing exit categories for new typed failures; it does not authorize
remapping a released command branch. Human-readable errors and warnings continue on their released
streams; successful content goes to stdout.

## Message-type rendering

- An error or thinking message retains its true category even when it has structured tool calls.
- `--message-type error` and `--message-type thinking` select those messages by category.
- Structured tool calls remain visible in table, JSON, and export renderers for those categories.
- The presence of a tool call does not reclassify the whole message as `tool`.

## Required help examples

The shipped `--help` and README include at least:

```bash
# Round-trip a workspace-scoped one-based index
cursor-history --json --workspace /work/a list --all
cursor-history --json --workspace /work/a show 1

# Search without reading unrelated workspace payload
cursor-history --json --workspace /work/a search needle-a

# Explicitly include complementary contributors of already selected UUIDs
cursor-history --workspace /work/a --include-cross-workspace-sources show 1

# Preview a safely bound Composer-only migration
cursor-history --workspace /work/a migrate-session 1 /work/destination --dry-run

# Request a shared final archive; private is the default
cursor-history backup --shared
```
