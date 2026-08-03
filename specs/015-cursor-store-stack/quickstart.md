# Quickstart: Cursor Store Stack Support

> For Store stack users (WSL/CLI/agent) and contributors.

## Scenario A — Store Stack User (Fixing Issue #31)

Your Cursor sessions live in `~/.cursor/` (Store stack) rather than `workspaceStorage/` (Composer stack):

```bash
cursor-history list                 # Auto-discovers ~/.cursor/chats + transcripts
cursor-history show <id>            # View session (text + tool calls)
cursor-history search "keyword"
cursor-history export <id> -f md
```

- The tool scans both Composer stack and Store stack roots by default.
- Store stack-only sessions (no vscdb) can also be listed — the fix point for Issue #31.
- Transcript-only sessions (degraded fidelity) are clearly annotated.

## Scenario B — Specify a Data Path

```bash
cursor-history --data-path ~/.cursor list
# WSL accessing the Windows side:
cursor-history --data-path /mnt/c/Users/YOU/.cursor list
```

## Scenario C — Developer: Test Fixture Preparation

### Transcript Fixtures (P1)
1. Sample from a real `~/.cursor/projects/<sanitized>/agent-transcripts/<uuid>/<uuid>.jsonl`.
2. **Redact**: Replace real paths/credentials with placeholders; keep `[REDACTED]` markers.
3. Place under `tests/fixtures/transcripts/`; cover these cases: user-only, with tool_use, with error rows, empty file, nested vs flat layout.

### store.db Contract Fixture (P2)
Build a minimal `store.db` per the `research.md §5.1` DDL:
```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
-- meta key='0' = hex(JSON of {agentId, latestRootBlobId, name, mode, createdAt})
-- blobs: 1 root tree blob (protobuf frame 0x0a 0x20 + 32B hash) + 1 leaf (JSON message)
```
Used to verify the parser reconstruction.

### Real store.db Dump (Confirm Blob Leaf Encoding, research §10.1.2)
```bash
# Generate locally after fixing the WSL proxy, or ask the issue author to run it (no sqlite3 CLI install needed):
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1], { readOnly: true });
console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table'\").all());
console.log(db.prepare('SELECT * FROM meta').all());
console.log('blobs:', db.prepare('SELECT COUNT(*) c FROM blobs').get());
" ~/.cursor/chats/<hash>/<uuid>/store.db
```

## Cross-Platform Store Stack Root Paths

| Platform | Store stack root |
|---|---|
| Linux / WSL | `~/.cursor/` |
| macOS | `~/.cursor/` |
| Windows | `%USERPROFILE%\.cursor\` |

## Debugging
- `DEBUG=cursor-history:* cursor-history list` — Prints Store stack discovery/parsing details (reuses the 006 debug mechanism).
