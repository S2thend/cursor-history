# Quickstart: Fix Session Data Integrity

**Branch**: `012-fix-session-data-integrity` | **Date**: 2026-03-18

## What This Fix Changes

### Before (broken)

```typescript
import { getSession } from 'cursor-history';

const session = await getSession(0);
// session.messages → all role: 'user', no assistant messages
// session.messages[n].toolCalls → always undefined
// empty assistant bubbles → silently dropped
// global load failure → silent fallback, no indication
```

### After (fixed)

```typescript
import { getSession } from 'cursor-history';

const session = await getSession(0);

// Full conversation with both roles
session.messages.forEach(msg => {
  console.log(msg.role);      // 'user' or 'assistant'
  console.log(msg.content);   // text or '[empty message]' placeholder
  console.log(msg.toolCalls); // structured ToolCall[] when present
  console.log(msg.metadata);  // { corrupted: true } for malformed bubbles
});

// Data source indicator
console.log(session.source);   // 'global' or 'workspace-fallback'
```

## Key Behavioral Changes

1. **`source` field** — Check `session.source` to know if you have full data (`'global'`) or degraded prompt snapshots (`'workspace-fallback'`).

2. **`toolCalls` populated** — `message.toolCalls` now contains structured data when the assistant used tools. Check `toolCall.status` for completion state.

3. **Empty bubbles preserved** — Messages with `content === '[empty message]'` represent bubbles that had no extractable text. They are no longer silently dropped.

4. **Corrupted bubbles marked** — Messages with `metadata?.corrupted === true` represent bubble rows with malformed JSON. The session still loads; only the individual message is degraded.

5. **Debug logging** — Set `DEBUG=cursor-history:*` to see why global storage loading failed or which bubbles couldn't be parsed.

## Detecting Degraded Sessions

```typescript
const session = await getSession(0);

if (session.source === 'workspace-fallback') {
  console.warn('This session has limited data (workspace fallback)');
}

const corruptedCount = session.messages.filter(m => m.metadata?.corrupted).length;
if (corruptedCount > 0) {
  console.warn(`${corruptedCount} message(s) had corrupted data`);
}
```

## Build & Test

```bash
npm run build
npm test
```
