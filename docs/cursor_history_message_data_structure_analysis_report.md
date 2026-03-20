# Cursor History Message Data Structure Analysis Report

**Date:** 2026-02-12
**Analyst:** Claude Opus 4.5
**Purpose:** Investigate how Cursor stores chat history, specifically whether it supports conversation forking/branching like Claude Code

---

## Executive Summary

Cursor does **NOT** support conversation forking or branching with a linked tree structure. When users rewind or edit messages, the old messages become "orphaned" - they remain in storage but are unreferenced and have no link to their replacement. This is fundamentally different from Claude Code's append-only JSONL format with `parentUuid` tree structure.

**Key Findings:**
- 788 orphan bubbles (17.2% of total) exist in storage but are unreferenced
- No `parentUuid`, `isSidechain`, or similar linking fields exist
- Conversations are stored as linear arrays, not trees
- Message IDs are UUIDs (not sequential), with no ordering information on orphans

---

## Table of Contents

1. [Storage Architecture](#storage-architecture)
2. [Data Structures](#data-structures)
3. [Orphan Bubble Analysis](#orphan-bubble-analysis)
4. [Comparison with Claude Code](#comparison-with-claude-code)
5. [Investigations](#investigations)
6. [Conclusions](#conclusions)

---

## Storage Architecture

### Storage Locations

Cursor stores chat data in SQLite databases at:

```
~/Library/Application Support/Cursor/User/
├── globalStorage/
│   └── state.vscdb          # Full AI responses, bubble data (98 MB)
└── workspaceStorage/
    └── <workspace-hash>/
        └── state.vscdb      # Session metadata, workspace-specific data
```

### Database Tables

Both `state.vscdb` files contain two tables:
- `ItemTable` - General VS Code state storage
- `cursorDiskKV` - Cursor-specific key-value storage for chat data

### Key Prefixes in `cursorDiskKV`

| Prefix | Purpose |
|--------|---------|
| `composerData:<composerId>` | Session metadata, conversation order |
| `bubbleId:<composerId>:<bubbleId>` | Individual message content |
| `checkpointId:<composerId>:<checkpointId>` | File state snapshots (for code undo/redo) |
| `agentKv:blob:<hash>` | Agent context data |
| `codeBlockDiff:*` | Code diff tracking |
| `inlineDiffs-*` | Inline diff state |

---

## Data Structures

### Session Metadata (`composerData`)

```json
{
  "_v": 10,
  "composerId": "00fc6445-00eb-42fc-8401-baf43ada3561",
  "name": "Session title...",
  "createdAt": 1765760077237,
  "lastUpdatedAt": 1765760433648,
  "fullConversationHeadersOnly": [
    { "bubbleId": "a05c2488-...", "type": 1 },
    { "bubbleId": "d7fc21c9-...", "type": 2, "serverBubbleId": "c6dae67e-..." },
    ...
  ],
  "contextTokensUsed": 115464,
  "contextTokenLimit": 200000,
  "unifiedMode": "agent",
  "isAgentic": true,
  ...
}
```

**Key Fields:**
- `fullConversationHeadersOnly` - **Linear array** defining conversation order (not a tree!)
- `createdAt` / `lastUpdatedAt` - Session-level timestamps (Unix ms)
- No `parentUuid`, `leafUuid`, or branching fields

### Conversation Header Items

Each item in `fullConversationHeadersOnly` contains only:

| Field | Description |
|-------|-------------|
| `bubbleId` | UUID of the message |
| `type` | 1 = user, 2 = assistant |
| `serverBubbleId` | (optional) Server-side ID |

**No parent/child linking fields.**

### Bubble Data Structure

```json
{
  "_v": 3,
  "bubbleId": "a05c2488-422b-4c01-9801-1471d6741f5b",
  "type": 1,
  "text": "User message content...",
  "richText": "{\"root\":{...}}",
  "isAgentic": true,
  "tokenCount": { "inputTokens": 0, "outputTokens": 0 },
  "checkpointId": "aee4b045-7026-47fe-9568-b1126cedcad8",
  "toolFormerData": { ... },
  "supportedTools": [1, 41, 7, ...],
  ...
}
```

**Notable Absent Fields:**
- No `parentUuid` or `parentBubbleId`
- No `isSidechain` or `branch`
- No `createdAt` timestamp on bubbles (only on sessions)
- No `previousVersion` or `editedFrom`

### Bubble Key Format

```
bubbleId:<composerId>:<bubbleId>
         ↑            ↑
         Session ID   Message ID (UUID)
```

This means we know **which session** a bubble belongs to, but not its **position** or **parent**.

---

## Orphan Bubble Analysis

### Statistics

| Metric | Value |
|--------|-------|
| Total sessions | 266 |
| Total bubbles stored | 4,592 |
| Bubbles referenced in conversations | 3,804 |
| **Orphan bubbles** | **788 (17.2%)** |

### Orphan Breakdown

| Type | Count | Likely Cause |
|------|-------|--------------|
| User messages | 14 | Message edits before sending |
| Assistant messages | 722 | Streaming artifacts, regeneration |

### Sample Sessions with Orphans

| Session Name | Stored | Referenced | Orphans |
|--------------|--------|------------|---------|
| Agent Role (System Intent) | 232 | 77 | 155 |
| I'll help you write a comprehensive GitHub issue... | 175 | 102 | 73 |
| Resolve type definition file error | 210 | 146 | 64 |
| Implement backend as per documentation | 212 | 158 | 54 |
| 工具初始化和处理错误 | 191 | 150 | 41 |

### Orphan Content Examples

Found orphan user messages showing evidence of **message editing**:

```
Session: 工具初始化和处理错误
Orphan 1: "i want to open an issue on github to the owner of pocketflow
           tracing, can you write it for me describe the problem and
           offer a fix? i also want to open a pull request."

Orphan 2: "i want to open an issue on github to the owner of pocketflow
           tracing, can you write it for me describe the problem and
           propose a fix? i also want to open a pull request."
           ↑ Note: "offer" changed to "propose"
```

These two similar messages suggest the user edited their message before sending, but **no link exists between them**.

---

## Comparison with Claude Code

| Feature | Claude Code | Cursor |
|---------|-------------|--------|
| **Storage format** | JSONL (append-only) | SQLite database |
| **Message linking** | `parentUuid` tree | Linear array index |
| **Branching support** | `isSidechain: true` | Not supported |
| **Rewind behavior** | Creates new branch | Overwrites array |
| **History recovery** | All branches preserved | Orphans unreachable |
| **Message ordering** | `parentUuid` chain | Array position only |
| **Timestamps** | Per-message `createdAt` | Session-level only |

### Claude Code's Tree Structure

```
msg-001 (parentUuid: null)     → "Read my file"
  └─ msg-002 (parentUuid: msg-001) → "I'll read file.ts"
       └─ msg-003 (parentUuid: msg-002) → "Here's the content"
            ├─ msg-004 (parentUuid: msg-003, isSidechain: false) → "Fix bug"
            └─ msg-005 (parentUuid: msg-003, isSidechain: true)  → "Show line count"
                 └─ msg-006 (parentUuid: msg-005, isSidechain: true) → "150 lines"
```

### Cursor's Linear Structure

```
fullConversationHeadersOnly: [
  { bubbleId: "msg-001", type: 1 },  // Array index 0
  { bubbleId: "msg-002", type: 2 },  // Array index 1
  { bubbleId: "msg-003", type: 2 },  // Array index 2
  { bubbleId: "msg-005", type: 1 },  // Array index 3 (msg-004 is now orphaned!)
  { bubbleId: "msg-006", type: 2 },  // Array index 4
]
// msg-004 still exists in bubbleId:* but is unreferenced
```

---

## Investigations

### Investigation 1: Find Cursor Data Storage Location

**Hypothesis:** Cursor stores data in Application Support directory like other macOS apps.

**Method:** List directories in `~/Library/Application Support/Cursor/`

**Result:** ✅ Found
```
/Users/borui/Library/Application Support/Cursor/User/
├── globalStorage/state.vscdb    (98 MB)
├── workspaceStorage/            (29 workspaces)
└── History/                     (file edit history, not chat)
```

**Conclusion:** Main chat data is in `globalStorage/state.vscdb` and workspace-specific `state.vscdb` files.

---

### Investigation 2: Identify Database Tables and Key Structure

**Hypothesis:** Chat data is stored in SQLite tables with specific key patterns.

**Method:**
```sql
sqlite3 state.vscdb ".tables"
sqlite3 state.vscdb "SELECT DISTINCT substr(key, 1, instr(key, ':')) FROM cursorDiskKV"
```

**Result:** ✅ Found key prefixes
- `composerData:` - Session metadata
- `bubbleId:` - Message content
- `checkpointId:` - File state snapshots
- `agentKv:` - Agent context

**Conclusion:** Chat is stored in `cursorDiskKV` table with structured key prefixes.

---

### Investigation 3: Check for Parent/Branch Fields in Bubble Data

**Hypothesis:** Bubbles might have `parentUuid` or `isSidechain` fields like Claude Code.

**Method:**
```python
# Extract one bubble and list all keys
data = json.loads(row[0])
for k in data.keys():
    if 'parent' in k.lower() or 'fork' in k.lower() or 'sidechain' in k.lower():
        print(k, data[k])
```

**Result:** ❌ Not found

All 4,592 bubbles checked - no parent/fork/sidechain fields exist.

**Fields found:** `_v`, `bubbleId`, `type`, `text`, `richText`, `tokenCount`, `checkpointId`, `toolFormerData`, etc.

**Conclusion:** Cursor does not store message parent/child relationships.

---

### Investigation 4: Check for Parent Fields in Conversation Headers

**Hypothesis:** Maybe the linking is in `fullConversationHeadersOnly`, not in bubbles.

**Method:**
```python
for msg in composerData['fullConversationHeadersOnly']:
    print(msg.keys())
```

**Result:** ❌ Only 3 fields
- `bubbleId`
- `type`
- `serverBubbleId` (optional)

**Conclusion:** Conversation headers contain no linking information.

---

### Investigation 5: Count Orphan Bubbles

**Hypothesis:** If rewind/edit removes messages from conversation, old bubbles should still exist as "orphans".

**Method:**
```python
# Get all stored bubbles
all_bubbles = set(bubbleId for key in cursorDiskKV if key.startswith('bubbleId:'))

# Get all referenced bubbles
referenced = set()
for composerData in all_composers:
    for msg in composerData['fullConversationHeadersOnly']:
        referenced.add(msg['bubbleId'])

# Find orphans
orphans = all_bubbles - referenced
```

**Result:** ✅ Found 788 orphans (17.2%)
- 14 orphan user messages
- 722 orphan assistant messages

**Conclusion:** Orphans exist, confirming that Cursor removes messages from conversation but doesn't delete the data.

---

### Investigation 6: Check for Timestamps on Bubbles

**Hypothesis:** If bubbles have `createdAt` timestamps, we could order orphans.

**Method:**
```python
for bubble in all_bubbles:
    ts = bubble.get('createdAt')
    if ts:
        print(ts)
```

**Result:** ❌ No timestamps found
- 0 out of 500 sampled bubbles had `createdAt`
- `createdAt` exists only on `composerData` (session level)

**Conclusion:** Cannot determine orphan message ordering - they are truly "lost" in time.

---

### Investigation 7: Check `serverBubbleId` for Linking

**Hypothesis:** `serverBubbleId` might link multiple local versions to one server message.

**Method:**
```python
server_ids = {}
for bubble in all_bubbles:
    sid = bubble.get('serverBubbleId')
    if sid:
        server_ids[sid].append(bubble['bubbleId'])

# Check for 1:many mappings
multi = {k: v for k, v in server_ids.items() if len(v) > 1}
```

**Result:** ❌ 1:1 mapping only
- 1,692 bubbles have `serverBubbleId`
- 1,692 unique `serverBubbleId` values
- 0 cases of multiple bubbles sharing a `serverBubbleId`

**Conclusion:** `serverBubbleId` is not for versioning - it's just a server-side ID.

---

### Investigation 8: Search for History/Edit Related Keys

**Hypothesis:** Maybe there's a separate key pattern for edit history.

**Method:**
```sql
SELECT key FROM cursorDiskKV
WHERE key LIKE '%edit%'
   OR key LIKE '%version%'
   OR key LIKE '%history%'
   OR key LIKE '%previous%'
   OR key LIKE '%parent%'
   OR key LIKE '%fork%'
   OR key LIKE '%rewind%'
```

**Result:** ❌ No relevant keys found

The only "history" related keys are for file edit history (`History/` folder), not chat.

**Conclusion:** No separate edit history storage exists.

---

### Investigation 9: Check Checkpoint Data

**Hypothesis:** `checkpointId` in bubbles might store conversation state.

**Method:**
```sql
SELECT value FROM cursorDiskKV WHERE key LIKE 'checkpointId:%'
```

**Result:** Checkpoints are for **file state**, not conversation:
```json
{
  "files": [],
  "nonExistentFiles": [],
  "newlyCreatedFolders": [],
  "activeInlineDiffs": [],
  "inlineDiffNewlyCreatedResources": { "files": [], "folders": [] }
}
```

**Conclusion:** Checkpoints are for code undo/redo, not conversation branching.

---

### Investigation 10: Search Other Storage Locations

**Hypothesis:** Maybe edit history is stored elsewhere (leveldb, JSON files, etc.)

**Method:**
```bash
# Check Local Storage leveldb
ls ~/Library/Application Support/Cursor/Local\ Storage/leveldb/
strings *.log | grep -i "parent\|fork\|rewind"

# Check History folder
ls ~/Library/Application Support/Cursor/User/History/
cat entries.json
```

**Result:** ❌ No chat history found
- `Local Storage/leveldb/` - VS Code state, no chat data
- `History/` - File edit history (undo/redo for code files)
- `.jsonl` files found were copies of test fixtures I edited, not chat data

**Conclusion:** No additional storage location for chat edit history.

---

### Investigation 11: Examine Orphan Content for Edit Patterns

**Hypothesis:** If we find similar orphan messages, it might indicate message editing.

**Method:**
```python
# Find orphan user messages with text content
for orphan in orphans:
    if orphan['type'] == 1 and orphan['text']:
        print(orphan['text'][:100])
```

**Result:** ✅ Found evidence of message editing
```
Session: 工具初始化和处理错误
Two similar orphan messages:
1. "...describe the problem and offer a fix..."
2. "...describe the problem and propose a fix..."
```

**Conclusion:** Message editing happens, but the link between versions is not stored.

---

### Investigation 12: Check All Bubble Fields for Any Linking Candidates

**Hypothesis:** Maybe there's a field I missed that could link messages.

**Method:**
```python
# List ALL fields across all bubbles
all_fields = set()
for bubble in all_bubbles:
    all_fields.update(bubble.keys())

# Check for any UUID-like values that could be links
for k, v in bubble.items():
    if isinstance(v, str) and looks_like_uuid(v):
        print(k, v)
```

**Result:** Found UUID fields but none for parent linking:
- `bubbleId` - Self ID
- `checkpointId` - File state reference
- `requestId` - API request ID
- `serverBubbleId` - Server-side ID (1:1 mapping)
- `usageUuid` - Usage tracking

**Conclusion:** No hidden linking fields exist.

---

## Conclusions

### What Cursor Stores

1. **Session metadata** (`composerData`) with:
   - Session ID, name, timestamps
   - Linear array of message references (`fullConversationHeadersOnly`)
   - Context usage, model config

2. **Message content** (`bubbleId`) with:
   - Message text and rich text
   - Tool calls and results
   - Token counts
   - File checkpoints (for code state)

3. **File state snapshots** (`checkpointId`) for undo/redo

### What Cursor Does NOT Store

1. ❌ Parent/child message relationships
2. ❌ Branch/fork information
3. ❌ Message edit history
4. ❌ Per-message timestamps
5. ❌ Rewind points or alternative paths

### How Rewind/Edit Works (Inferred)

1. User clicks rewind or edits a message
2. Cursor removes subsequent messages from `fullConversationHeadersOnly` array
3. Old bubble data **remains in storage** but becomes orphaned
4. New messages get **new UUIDs** with no link to old versions
5. The UI likely handles this ephemerally in memory
6. Once Cursor closes, the edit history relationship is **permanently lost**

### Implications for cursor-history Tool

1. **Can recover orphan content** - The data exists, just unreferenced
2. **Cannot reconstruct conversation tree** - No parent linking
3. **Cannot determine orphan ordering** - No timestamps
4. **Can associate orphans with sessions** - Session ID is in the key

### Potential Feature: Orphan Recovery

A future feature could:
1. List all orphans for a session
2. Display their content alongside the main conversation
3. Note: Cannot determine original position or what replaced them

---

## Appendix: Raw Statistics

```
Database: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
Size: 98,611,200 bytes

cursorDiskKV key counts:
  composerData:*     266 sessions
  bubbleId:*         4,592 messages
  checkpointId:*     709 checkpoints
  agentKv:*          varies

Orphan analysis:
  Total bubbles:     4,592
  Referenced:        3,804 (82.8%)
  Orphaned:          788 (17.2%)
    - User:          14
    - Assistant:     722
```

---

## Appendix: Investigation Commands Reference

```bash
# List tables
sqlite3 state.vscdb ".tables"

# Get key prefixes
sqlite3 state.vscdb "SELECT DISTINCT substr(key, 1, instr(key || ':', ':')-1) FROM cursorDiskKV"

# Count bubbles
sqlite3 state.vscdb "SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"

# Extract composer data
sqlite3 state.vscdb "SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 1"

# Search for specific fields
sqlite3 state.vscdb "SELECT key FROM cursorDiskKV WHERE key LIKE '%parent%'"
```

---

*Report generated by analyzing real Cursor data on macOS. Findings may vary with different Cursor versions.*
