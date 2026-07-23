import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';
import * as database from '../../src/core/database/index.js';

const DB_PATH = join(tmpdir(), `ch-store-test-${process.pid}.db`);
const DB_PARTIAL = join(tmpdir(), `ch-store-partial-${process.pid}.db`);
const DB_MODERN_TOOLS = join(tmpdir(), `ch-store-modern-tools-${process.pid}.db`);
type TestDatabase = import('better-sqlite3').Database;

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const frame = (hash: string, tag: number): Buffer =>
  Buffer.concat([Buffer.from([tag, 0x20]), Buffer.from(hash, 'hex')]);

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function protobufMessageNode(message: object): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from([0x22]), varint(payload.length), payload]);
}

function makeDb(path: string, build: (db: TestDatabase) => void): void {
  const db = new BetterSqlite3(path);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  build(db);
  db.close();
}

const insert =
  (db: TestDatabase) =>
  (id: string, data: Buffer): void =>
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(id, data);

/**
 * Contract fixture: 0x12 subtree recursion + OpenAI form (string content +
 * tool_calls coexisting) + an orphan role:'tool' leaf (no tool_call_id → must
 * NOT be attached; must mark completeness 'partial').
 */
function buildContractStoreDb(db: TestDatabase): void {
  const ins = insert(db);
  const leaf1 = Buffer.from(JSON.stringify({ role: 'user', content: 'What is 2+2?' }));
  const leaf1Hash = sha(leaf1);
  ins(leaf1Hash, leaf1);

  const leaf2 = Buffer.from(
    JSON.stringify({
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [{ function: { name: 'Calc', arguments: '{"expr":"2+2"}' } }],
    })
  );
  const leaf2Hash = sha(leaf2);
  ins(leaf2Hash, leaf2);

  // role:'tool' result leaf has no tool_call_id, so it must not be attached.
  const leaf3 = Buffer.from(JSON.stringify({ role: 'tool', content: '4' }));
  const leaf3Hash = sha(leaf3);
  ins(leaf3Hash, leaf3);

  // subtree1 holds leaf2 + leaf3 (nested under root via 0x12 → tests recursion)
  const subtree1 = Buffer.concat([frame(leaf2Hash, 0x0a), frame(leaf3Hash, 0x0a)]);
  const subtree1Hash = sha(subtree1);
  ins(subtree1Hash, subtree1);

  // root: 0x0a leaf1 + 0x12 subtree1 (mixed leaf + subtree)
  const root = Buffer.concat([frame(leaf1Hash, 0x0a), frame(subtree1Hash, 0x12)]);
  const rootHash = sha(root);
  ins(rootHash, root);

  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
    '0',
    Buffer.from(
      JSON.stringify({
        agentId: 'test-agent',
        latestRootBlobId: rootHash,
        name: 'Contract Deep Session',
        mode: 'ask',
        createdAt: 1783737832293,
      })
    ).toString('hex')
  );
}

/** Partial fixture: root references a leaf hash that has NO blobs row → partial. */
function buildPartialStoreDb(db: TestDatabase): void {
  const ins = insert(db);
  const leaf1 = Buffer.from(JSON.stringify({ role: 'user', content: 'hi' }));
  const leaf1Hash = sha(leaf1);
  ins(leaf1Hash, leaf1);
  // leaf "missing" — referenced but never inserted
  const missingHash = sha(Buffer.from('not-present'));
  const root = Buffer.concat([frame(leaf1Hash, 0x0a), frame(missingHash, 0x0a)]);
  const rootHash = sha(root);
  ins(rootHash, root);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
    '0',
    Buffer.from(
      JSON.stringify({
        agentId: 'a',
        latestRootBlobId: rootHash,
        name: 'Partial',
        createdAt: 1783737832293,
      })
    ).toString('hex')
  );
}

function buildModernToolStoreDb(db: TestDatabase): void {
  const ins = insert(db);
  const assistantNode = protobufMessageNode({
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will search.' },
      {
        type: 'tool-call',
        toolName: 'Grep',
        toolCallId: 'grep-call-1',
        args: { pattern: 'toolCalls', path: '/repo/src' },
      },
    ],
  });
  const assistantHash = sha(assistantNode);
  ins(assistantHash, assistantNode);

  const toolResult = protobufMessageNode({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName: 'Grep',
        toolCallId: 'grep-call-1',
        result: 'src/core/parser.ts:10',
      },
    ],
  });
  const toolResultHash = sha(toolResult);
  ins(toolResultHash, toolResult);

  const root = Buffer.concat([frame(assistantHash, 0x0a), frame(toolResultHash, 0x0a)]);
  const rootHash = sha(root);
  ins(rootHash, root);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
    '0',
    Buffer.from(
      JSON.stringify({
        latestRootBlobId: rootHash,
        name: 'Modern Tool Session',
        createdAt: 1783737832293,
      })
    ).toString('hex')
  );
}

describe('parseStoreDb (store.db primary source)', () => {
  beforeAll(() => {
    makeDb(DB_PATH, buildContractStoreDb);
    makeDb(DB_PARTIAL, buildPartialStoreDb);
    makeDb(DB_MODERN_TOOLS, buildModernToolStoreDb);
  });
  afterAll(() => {
    try {
      rmSync(DB_PATH, { force: true });
      rmSync(DB_PARTIAL, { force: true });
      rmSync(DB_MODERN_TOOLS, { force: true });
    } catch {
      // ignore
    }
  });

  it('extracts title from meta.name', async () => {
    expect((await parseStoreDb(DB_PATH))?.title).toBe('Contract Deep Session');
  });

  it('recurses 0x12 subtrees (root mixes leaf + subtree)', async () => {
    const data = await parseStoreDb(DB_PATH);
    // user + assistant; role:'tool' leaf is orphan, NOT counted as a message
    expect(data?.messages).toHaveLength(2);
    expect(data?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it("keeps OpenAI string content AND tool_calls together (content='Let me check.', toolCalls=[Calc])", async () => {
    const asst = (await parseStoreDb(DB_PATH))?.messages[1];
    expect(asst?.content).toBe('Let me check.');
    expect(asst?.toolCalls?.[0]?.name).toBe('Calc');
    expect(asst?.toolCalls?.[0]?.params).toEqual({ expr: '2+2' });
  });

  // === HARD REGRESSION (user requirement #2): parallel tool results must NOT be misattached ===
  it("does NOT attach the orphan role:'tool' result (no tool_call_id → no guessing)", async () => {
    const data = await parseStoreDb(DB_PATH);
    expect(data?.messages[1]?.toolCalls?.[0]?.result).toBeUndefined(); // not attached, not misattached
  });

  it("marks completeness 'partial' when an orphan tool result is present (no silent full label)", async () => {
    expect((await parseStoreDb(DB_PATH))?.completeness).toBe('partial');
  });

  // === HARD REGRESSION (user requirement #1): missing/corrupt leaf → partial, not silent gap ===
  it("marks completeness 'partial' when a leaf blob is missing", async () => {
    const data = await parseStoreDb(DB_PARTIAL);
    expect(data?.completeness).toBe('partial');
    // the present leaf still surfaces; only the missing one is a gap
    expect(data?.messages).toHaveLength(1);
    expect(data?.messages[0]?.content).toBe('hi');
  });

  it('does not copy session createdAt onto messages', async () => {
    // store.db does not store a per-message timestamp; session createdAt must
    // not be fabricated as a message time.
    expect((await parseStoreDb(DB_PATH))?.messages[0]?.timestamp).toBeUndefined();
  });

  it('returns null on missing file (defensive — no throw)', async () => {
    const missing = join(tmpdir(), `definitely-not-here-${process.pid}-${Date.now()}.db`);
    expect(existsSync(missing)).toBe(false);
    expect(await parseStoreDb(missing)).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  it('reads the latest committed content from a WAL-backed source snapshot', async () => {
    const path = join(tmpdir(), `ch-store-wal-${process.pid}.db`);
    const db = new BetterSqlite3(path);
    try {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA wal_autocheckpoint=0');
      db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
      db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      buildContractStoreDb(db);

      const updatedMeta = Buffer.from(
        JSON.stringify({ name: 'Latest WAL Title', createdAt: 1783737832293 })
      ).toString('hex');
      db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(updatedMeta);
      expect(existsSync(`${path}-wal`)).toBe(true);

      const data = await parseStoreDb(path);
      expect(data?.title).toBe('Latest WAL Title');
    } finally {
      db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it('reads the source directly when the native snapshot API rejects the path', async () => {
    const backupSpy = vi
      .spyOn(database, 'backupDatabase')
      .mockRejectedValueOnce(new Error('UNC snapshot failed'));
    try {
      const data = await parseStoreDb(DB_MODERN_TOOLS);
      expect(data?.title).toBe('Modern Tool Session');
      expect(data?.completeness).toBe('complete');
    } finally {
      backupSpy.mockRestore();
    }
  });

  it('decodes protobuf assistant nodes and joins modern tool-call results by id', async () => {
    const data = await parseStoreDb(DB_MODERN_TOOLS);
    const assistant = data?.messages[0];
    expect(data?.completeness).toBe('complete');
    expect(assistant?.content).toBe('I will search.');
    expect(assistant?.toolCalls).toEqual([
      {
        name: 'Grep',
        status: 'completed',
        params: { pattern: 'toolCalls', path: '/repo/src' },
        result: 'src/core/parser.ts:10',
      },
    ]);
  });

  it('does not attach a matching tool result from an unreachable historical blob', async () => {
    const path = join(tmpdir(), `ch-store-unreachable-result-${process.pid}.db`);
    makeDb(path, (db) => {
      const ins = insert(db);
      const assistant = protobufMessageNode({
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'Read', toolCallId: 'reused-id', args: { file: '/a' } },
        ],
      });
      const staleResult = protobufMessageNode({
        role: 'tool',
        tool_call_id: 'reused-id',
        content: 'stale historical result',
      });
      const assistantHash = sha(assistant);
      ins(assistantHash, assistant);
      ins(sha(staleResult), staleResult); // Intentionally not referenced by root.
      const root = frame(assistantHash, 0x0a);
      const rootHash = sha(root);
      ins(rootHash, root);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        '0',
        Buffer.from(JSON.stringify({ latestRootBlobId: rootHash })).toString('hex')
      );
    });
    try {
      const data = await parseStoreDb(path);
      expect(data?.messages[0]?.toolCalls?.[0]?.result).toBeUndefined();
      expect(data?.completeness).toBe('complete');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('rejects finite timestamps outside the JavaScript Date range', async () => {
    const path = join(tmpdir(), `ch-store-invalid-time-${process.pid}.db`);
    makeDb(path, (db) => {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        '0',
        Buffer.from(JSON.stringify({ createdAt: 1e20 })).toString('hex')
      );
    });
    try {
      expect((await parseStoreDb(path))?.createdAt).toBeNull();
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('joins standard OpenAI top-level tool results by tool_call_id', async () => {
    const path = join(tmpdir(), `ch-store-openai-tools-${process.pid}.db`);
    makeDb(path, (db) => {
      const ins = insert(db);
      const assistant = Buffer.from(
        JSON.stringify({
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'read-call-1', function: { name: 'Read', arguments: '{"file":"/a"}' } },
          ],
        })
      );
      const result = protobufMessageNode({
        role: 'tool',
        tool_call_id: 'read-call-1',
        name: 'Read',
        content: 'file contents',
      });
      const assistantHash = sha(assistant);
      const resultHash = sha(result);
      ins(assistantHash, assistant);
      ins(resultHash, result);
      const root = Buffer.concat([frame(assistantHash, 0x0a), frame(resultHash, 0x0a)]);
      const rootHash = sha(root);
      ins(rootHash, root);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        '0',
        Buffer.from(JSON.stringify({ latestRootBlobId: rootHash })).toString('hex')
      );
    });
    try {
      const data = await parseStoreDb(path);
      expect(data?.completeness).toBe('complete');
      expect(data?.messages[0]?.toolCalls?.[0]).toMatchObject({
        name: 'Read',
        status: 'completed',
        result: 'file contents',
      });
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('does not mark the database partial for an intentionally ignored system leaf', async () => {
    const path = join(tmpdir(), `ch-store-system-${process.pid}.db`);
    makeDb(path, (db) => {
      const ins = insert(db);
      const userLeaf = Buffer.from(JSON.stringify({ role: 'user', content: 'hi' }));
      const userHash = sha(userLeaf);
      ins(userHash, userLeaf);
      const sysLeaf = Buffer.from(JSON.stringify({ role: 'system', content: 'instructions' }));
      const sysHash = sha(sysLeaf);
      ins(sysHash, sysLeaf);
      const root = Buffer.concat([frame(userHash, 0x0a), frame(sysHash, 0x0a)]);
      const rootHash = sha(root);
      ins(rootHash, root);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        '0',
        Buffer.from(
          JSON.stringify({ latestRootBlobId: rootHash, name: 'Sys', createdAt: 1783737832293 })
        ).toString('hex')
      );
    });
    try {
      const data = await parseStoreDb(path);
      expect(data?.completeness).toBe('complete'); // system leaf ignored, not partial
      expect(data?.messages).toHaveLength(1);
      expect(data?.messages[0]?.content).toBe('hi');
    } finally {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it('marks invalid message content and unknown roles partial instead of silently dropping them', async () => {
    const path = join(tmpdir(), `ch-store-invalid-leaves-${process.pid}.db`);
    makeDb(path, (db) => {
      const ins = insert(db);
      const invalidMessage = Buffer.from(
        JSON.stringify({ role: 'user', content: { unexpected: true } })
      );
      const invalidHash = sha(invalidMessage);
      ins(invalidHash, invalidMessage);
      const unknownRole = Buffer.from(
        JSON.stringify({ role: 'developer', content: 'new schema data' })
      );
      const unknownHash = sha(unknownRole);
      ins(unknownHash, unknownRole);
      const root = Buffer.concat([frame(invalidHash, 0x0a), frame(unknownHash, 0x0a)]);
      const rootHash = sha(root);
      ins(rootHash, root);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        '0',
        Buffer.from(JSON.stringify({ latestRootBlobId: rootHash, name: 'Invalid' })).toString('hex')
      );
    });
    try {
      const data = await parseStoreDb(path);
      expect(data?.completeness).toBe('partial');
      expect(data?.messages).toEqual([]);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
