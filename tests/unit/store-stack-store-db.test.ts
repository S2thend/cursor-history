import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';

const DB_PATH = join(tmpdir(), `ch-store-test-${process.pid}.db`);
const DB_PARTIAL = join(tmpdir(), `ch-store-partial-${process.pid}.db`);

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const frame = (hash: string, tag: number): Buffer =>
  Buffer.concat([Buffer.from([tag, 0x20]), Buffer.from(hash, 'hex')]);

function makeDb(path: string, build: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  build(db);
  db.close();
}

const insert = (db: DatabaseSync) => (id: string, data: Buffer): void =>
  db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(id, data);

/**
 * Contract fixture: 0x12 subtree recursion + OpenAI form (string content +
 * tool_calls coexisting) + an orphan role:'tool' leaf (no tool_call_id → must
 * NOT be attached; must mark completeness 'partial').
 */
function buildContractStoreDb(db: DatabaseSync): void {
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

  // role:'tool' result leaf — has NO tool_call_id, so P2 must NOT attach it.
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
function buildPartialStoreDb(db: DatabaseSync): void {
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
      JSON.stringify({ agentId: 'a', latestRootBlobId: rootHash, name: 'Partial', createdAt: 1783737832293 })
    ).toString('hex')
  );
}

describe('parseStoreDb (transcript-authoritative rework)', () => {
  beforeAll(() => {
    makeDb(DB_PATH, buildContractStoreDb);
    makeDb(DB_PARTIAL, buildPartialStoreDb);
  });
  afterAll(() => {
    try {
      rmSync(DB_PATH, { force: true });
      rmSync(DB_PARTIAL, { force: true });
    } catch {
      // ignore
    }
  });

  it('extracts title from meta.name', () => {
    expect(parseStoreDb(DB_PATH)?.title).toBe('Contract Deep Session');
  });

  it('recurses 0x12 subtrees (root mixes leaf + subtree)', () => {
    const data = parseStoreDb(DB_PATH);
    // user + assistant; role:'tool' leaf is orphan, NOT counted as a message
    expect(data?.messages).toHaveLength(2);
    expect(data?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it("keeps OpenAI string content AND tool_calls together (content='Let me check.', toolCalls=[Calc])", () => {
    const asst = parseStoreDb(DB_PATH)?.messages[1];
    expect(asst?.content).toBe('Let me check.');
    expect(asst?.toolCalls?.[0]?.name).toBe('Calc');
    expect(asst?.toolCalls?.[0]?.params).toEqual({ expr: '2+2' });
  });

  // === HARD REGRESSION (user requirement #2): parallel tool results must NOT be misattached ===
  it("does NOT attach the orphan role:'tool' result (no tool_call_id → no guessing)", () => {
    const data = parseStoreDb(DB_PATH);
    expect(data?.messages[1]?.toolCalls?.[0]?.result).toBeUndefined(); // not attached, not misattached
  });

  it("marks completeness 'partial' when an orphan tool result is present (no silent full label)", () => {
    expect(parseStoreDb(DB_PATH)?.completeness).toBe('partial');
  });

  // === HARD REGRESSION (user requirement #1): missing/corrupt leaf → partial, not silent gap ===
  it("marks completeness 'partial' when a leaf blob is missing", () => {
    const data = parseStoreDb(DB_PARTIAL);
    expect(data?.completeness).toBe('partial');
    // the present leaf still surfaces; only the missing one is a gap
    expect(data?.messages).toHaveLength(1);
    expect(data?.messages[0]?.content).toBe('hi');
  });

  it('uses session createdAt as the message timestamp (not epoch)', () => {
    expect(parseStoreDb(DB_PATH)?.messages[0]?.timestamp).toEqual(new Date(1783737832293));
  });

  it('returns null on missing file (defensive — no throw)', () => {
    expect(parseStoreDb(join(tmpdir(), 'definitely-not-here.db'))).toBeNull();
  });
});
