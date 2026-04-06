# Quickstart: Expose Bubble ID on Message Type

**Date**: 2026-04-06 | **Branch**: `014-expose-bubble-id`

## What Changed

The library API now exposes two new optional fields:
- `Message.id` — stable bubble UUID for each message
- `Session.activeBranchBubbleIds` — ordered list of bubble IDs on the active conversation branch

## Library Usage

### Get stable message IDs

```typescript
import { getSession } from 'cursor-history';

const session = await getSession(0); // zero-based index
for (const msg of session.messages) {
  console.log(msg.id, msg.role, msg.content.slice(0, 50));
  // e66f2d00-47ff-4943-94ac-c0b5ea324d38  user  "How do I..."
}
```

### Identify active-branch messages

```typescript
import { getSession } from 'cursor-history';

const session = await getSession(0);
const activeIds = new Set(session.activeBranchBubbleIds ?? []);

for (const msg of session.messages) {
  const isActive = msg.id ? activeIds.has(msg.id) : true; // assume active if no ID
  console.log(isActive ? '[active]' : '[orphan]', msg.role, msg.content.slice(0, 50));
}
```

### Use message IDs as stable keys

```typescript
import { getSession } from 'cursor-history';

const session = await getSession('composer-uuid-here');

// Use bubble UUID as a stable identifier instead of positional index
const messageMap = new Map(
  session.messages
    .filter((m) => m.id)
    .map((m) => [m.id!, m])
);
```

## CLI Usage

### JSON output includes message IDs

```bash
cursor-history show 1 --json | jq '.messages[0].id'
# "e66f2d00-47ff-4943-94ac-c0b5ea324d38"
```

### Active branch bubble IDs

```bash
cursor-history show 1 --json | jq '.activeBranchBubbleIds'
# ["uuid-1", "uuid-2", "uuid-3"]
```

### Export includes message IDs

```bash
cursor-history export 1 -f json -o session.json
cat session.json | jq '.messages[].id'
```

### Markdown export includes message IDs

```bash
cursor-history export 1 -f markdown -o session.md
rg '^\*\*ID\*\*:' session.md
```

## Notes

- `Message.id` is `undefined` when the bubble UUID is unavailable (workspace-fallback sessions).
- `Session.activeBranchBubbleIds` is `undefined` when the active branch manifest is absent, empty, invalid, or when the session is sourced from `workspace-fallback`.
- No changes to human-readable CLI output (table format).
