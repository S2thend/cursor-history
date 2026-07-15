import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';

const ROOT = () => join(process.cwd(), 'tests', 'fixtures', 'store-root');
const UUID1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const UUID2 = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('discoverStoreSessions', () => {
  it('discovers sessions from chats/meta + projects/transcripts', () => {
    const ids = discoverStoreSessions(ROOT())
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual([UUID1, UUID2]);
  });

  it('reads workspacePath + createdAt from chats meta.json.cwd/createdAtMs', () => {
    const s1 = discoverStoreSessions(ROOT()).find((s) => s.id === UUID1)!;
    expect(s1.workspacePath).toBe('/mnt/d/1_yuyu_proj/cursor-history');
    expect(s1.createdAt).toEqual(new Date(1783737832293));
    expect(s1.title).toBeNull(); // legacy chats meta has no title
  });

  it('parses transcript messages for the merged session', () => {
    const s1 = discoverStoreSessions(ROOT()).find((s) => s.id === UUID1)!;
    expect(s1.messages.length).toBe(2);
    expect(s1.messages[0].role).toBe('user');
    expect(s1.messages[1].toolCalls?.[0].name).toBe('Read');
  });

  it('handles transcript-only session (no chats/meta) — workspacePath unknown', () => {
    const s2 = discoverStoreSessions(ROOT()).find((s) => s.id === UUID2)!;
    expect(s2.messages).toHaveLength(1);
    expect(s2.workspacePath).toBeUndefined();
  });

  it('returns [] for a missing root (no throw — defensive)', () => {
    expect(discoverStoreSessions(join(ROOT(), 'does-not-exist'))).toEqual([]);
  });
});

describe('discoverStoreSessions — metadata before transcript attachment', () => {
  const AUUID = 'eeeeeeee-0000-0000-0000-000000000005';
  const acpCreatedAt = new Date('2026-01-01T00:00:00.000Z');
  const transcriptModifiedAt = new Date('2026-01-02T00:00:00.000Z');
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ch-acp-order-'));
    const acpDir = join(root, 'acp-sessions', AUUID);
    mkdirSync(acpDir, { recursive: true });
    writeFileSync(join(acpDir, 'meta.json'), JSON.stringify({ cwd: '/tmp/acp-project' }));
    utimesSync(acpDir, acpCreatedAt, acpCreatedAt);

    const transcriptDir = join(root, 'projects', 'tmp-acp-project', 'agent-transcripts', AUUID);
    mkdirSync(transcriptDir, { recursive: true });
    const transcript = join(transcriptDir, `${AUUID}.jsonl`);
    writeFileSync(
      transcript,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n'
    );
    utimesSync(transcript, transcriptModifiedAt, transcriptModifiedAt);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses ACP metadata time for session createdAt but not for messages', () => {
    const session = discoverStoreSessions(root).find((s) => s.id === AUUID);
    expect(session?.createdAt).toEqual(acpCreatedAt);
    // Transcripts carry no per-message timestamp; session createdAt is not
    // copied onto messages.
    expect(session?.messages[0]?.timestamp).toBeUndefined();
  });
});

describe('discoverStoreSessions — transcript authoritative (P2 rework)', () => {
  // Hard regression #1 (per review): a session with BOTH a transcript AND a
  // store.db must keep the transcript's messages; store.db may only enhance
  // title/createdAt. Construct: transcript=2 msgs, store.db=3 msgs → discover
  // must surface 2 (transcript), source 'transcript', title from store.db.
  const TUUID = 'cccccccc-0000-0000-0000-000000000003';
  const CWD = '/tmp/proj';
  let root = '';

  function buildStoreDb(path: string): void {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const s = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const ins = (id: string, d: Buffer) => db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(id, d);
    const frame = (h: string) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(h, 'hex')]);
    const l1 = Buffer.from(JSON.stringify({ role: 'user', content: 'store-msg-1' }));
    const l2 = Buffer.from(JSON.stringify({ role: 'assistant', content: 'store-msg-2' }));
    const l3 = Buffer.from(JSON.stringify({ role: 'user', content: 'store-msg-3' }));
    const h1 = s(l1), h2 = s(l2), h3 = s(l3);
    ins(h1, l1); ins(h2, l2); ins(h3, l3);
    const r = Buffer.concat([frame(h1), frame(h2), frame(h3)]);
    const rh = s(r); ins(rh, r);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      Buffer.from(JSON.stringify({ name: 'Store Title', latestRootBlobId: rh, createdAt: 1783737832293 })).toString('hex')
    );
    db.close();
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ch-transcript-'));
    const hash = createHash('md5').update(CWD).digest('hex');
    const chatDir = join(root, 'chats', hash, TUUID);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(
      join(chatDir, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, createdAtMs: 1783737832293, hasConversation: true, cwd: CWD })
    );
    buildStoreDb(join(chatDir, 'store.db')); // 3 messages
    // transcript (2 messages) — AUTHORITATIVE
    const atDir = join(root, 'projects', 'tmp-proj', 'agent-transcripts', TUUID);
    mkdirSync(atDir, { recursive: true });
    writeFileSync(
      join(atDir, `${TUUID}.jsonl`),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'transcript-1' }] } }) +
        '\n' +
        JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'transcript-2' }] } }) +
        '\n'
    );
  });
  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('store.db does NOT overwrite transcript messages', () => {
    const sessions = discoverStoreSessions(root);
    const s = sessions.find((x) => x.id === TUUID);
    expect(s?.messages).toHaveLength(2); // transcript (NOT store.db's 3)
    expect(s?.messages[0]?.content).toBe('transcript-1');
  });

  it("keeps transcript sessions off the store.db parse path", () => {
    const s = discoverStoreSessions(root).find((x) => x.id === TUUID);
    expect(s?.source).toBe('transcript');
    // The transcript path must not open store.db just to enrich metadata.
    // This keeps Issue #31 list/show free of P2 parsing and SQLite warnings.
    expect(s?.title).toBeNull();
  });
});
