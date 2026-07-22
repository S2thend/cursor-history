# Data Model: Cursor Store Stack Support

> Corresponds to `spec.md` FR / `research.md` §5–§9. Defines Store stack internal entities + mapping rules to the existing `ChatSession`/`Message`.

---

## 1. New Intermediate Entities (`src/core/store-stack/types.ts`, backend-internal)

### StoreWorkspaceEntry (discovery artifact)

| Field | Type | Description |
|---|---|---|
| root | string | `~/.cursor/` root |
| hash | string | `chats/<hash>/` directory name = MD5(cwd) |
| cwd | string | Absolute project path (from `meta.json.cwd`) |
| chatDir | string | `~/.cursor/chats/<hash>/<uuid>/` |
| hasStoreDb | boolean | Whether `store.db` exists under that session directory |
| hasConversation | boolean | `meta.json.hasConversation` |

### TranscriptLine (single JSONL line)

```ts
type TranscriptLine =
  | { role: 'user' | 'assistant'; message: { content: TranscriptPart[] } }
  | { type: 'error'; error: string }; // skip
```

### TranscriptPart

```ts
type TranscriptPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input?: Record<string, unknown> }
  | { type: string; [k: string]: unknown }; // unknown type → ignore that part (forward compat)
```

### StoreSession (before unification)

| Field | Type | Source |
|---|---|---|
| id | string | uuid = transcript file name = chats/<hash>/<uuid>/ directory name |
| workspacePath | string | `meta.json.cwd` |
| title | string \| null | Transcript/meta value; Store DB value only on fallback |
| createdAt | Date | `meta.json.createdAtMs`; Store DB value only when metadata is unavailable on fallback |
| messages | Message[] | Usable transcript messages are authoritative; otherwise Store DB fallback messages |
| storeDbPath? | string | `chatDir/store.db` |
| source | Store source variant | `'transcript'` for usable JSONL; `'store-complete'`/`'store-partial'` when Store DB supplies fallback conversation data; `'store'` for metadata-only compatibility |

---

## 2. Mapping: TranscriptLine → Message

| TranscriptLine field | Message field | Rule |
|---|---|---|
| `role` | `role` | Direct (user/assistant) |
| `content[type=text].text` | `content` | Multiple text parts concatenated in order |
| `content[type=tool_use]` | `toolCalls[]` | `{ name, params: input, status: 'completed' }`; no `result`/`id` (absent at transcript layer) |
| — | `timestamp` | Transcript layer has no directly stored per-message time; leave the field absent |
| — | `tokenUsage`/`model`/`thinking` | `undefined` (absent at transcript layer) |

> A single TranscriptLine containing multiple text + tool_use parts: text is concatenated into `content`, each tool_use becomes its own `ToolCall`, all attached to the same Message.

---

## 3. Unified Entities: ChatSession / Message (existing, extend source)

`ChatSession.source` currently (012): `'global' | 'workspace-fallback'`. **Extend**:

```ts
source?:
  | 'global'
  | 'workspace-fallback'
  | 'transcript'
  | 'store'
  | 'store-complete'
  | 'store-partial'
  | 'merged';
```

- `'store-complete'` / `'store-partial'`: Store DB supplied fallback conversation data because no usable transcript messages existed
- `'store'`: metadata-only Store compatibility state
- `'transcript'`: Transcript layer only (degraded fidelity, P1) → triggers degraded warning (reuses 012 mechanism)
- `'merged'`: same stable ID resolved from both Composer and Store stacks

Store DB parsing does not upgrade or enrich a session whose transcript already contains usable messages. This avoids heuristic message correlation, duplicate turns, and incorrect tool-result attachment.

---

## 4. Field Coverage Matrix (determines fidelity, from research §9)

| ChatSession/Message field | Composer stack | Store stack store.db (P2) | Transcript layer (P1) |
|---|:-:|:-:|:-:|
| id | bubbleId | uuid | uuid |
| title | ✅ | ✅ `meta.name` | ❌(null) |
| workspacePath | workspace.json | `meta.json.cwd` | (inherited from session) |
| createdAt | ✅ | ✅ `meta.createdAt` | `meta.json.createdAtMs` |
| Message.content(text) | ✅ | ✅ | ✅ |
| Message.toolCalls | ✅(with result) | ✅(with result) | ✅(no result) |
| Message.timestamp(per-msg) | ⚠️ 73% | ❌ | ❌ |
| tokenUsage / model | ✅ | ❌ | ❌ |
| thinking | ✅ | ⚠️ | ❌ |

---

## 5. Validation and State Transitions

| Input state | Handling | Output |
|---|---|---|
| `meta.json.hasConversation=false` and no store.db | Empty session | list optionally shows (0 messages) / skip; show friendly prompt |
| store.db corrupted/locked (WAL lock) | Degrade | `source='transcript'`, do not throw |
| Transcript single line `JSON.parse` fails | Skip that line | Counted in debugLog, continue |
| Unknown content part type | Ignore that part | forward compat (constitution V) |
| `~/.cursor/` does not exist | Skip Store stack | Does not affect Composer stack |

---

## 6. Compatibility with Existing Types

- `MessageRole = 'user' | 'assistant'`: the transcript layer only produces these two (no system/tool role as a Message). ✓
- `ToolCall.status = 'completed'|'cancelled'|'error'`: transcript layer tool_use carries no status info → defaults to `'completed'`. ✓
- `ToolCall.params = Record<string,unknown>`: `tool_use.input` maps directly. ✓
- The new source values are an **additive extension** and do not break existing `'global'/'workspace-fallback'` consumers. ✓
