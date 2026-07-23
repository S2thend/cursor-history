import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';

const ROOT = () => join(process.cwd(), 'tests', 'fixtures', 'store-root');
const UUID1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const UUID2 = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('discoverStoreSessions', () => {
  it('discovers sessions from chats/meta + projects/transcripts', async () => {
    const ids = (await discoverStoreSessions(ROOT())).map((s) => s.id).sort();
    expect(ids).toEqual([UUID1, UUID2]);
  });

  it('reads workspacePath + createdAt from chats meta.json.cwd/createdAtMs', async () => {
    const s1 = (await discoverStoreSessions(ROOT())).find((s) => s.id === UUID1)!;
    expect(s1.workspacePath).toBe('/mnt/d/1_yuyu_proj/cursor-history');
    expect(s1.createdAt).toEqual(new Date(1783737832293));
    expect(s1.title).toBeNull(); // legacy chats meta has no title
  });

  it('parses transcript messages for the merged session', async () => {
    const s1 = (await discoverStoreSessions(ROOT())).find((s) => s.id === UUID1)!;
    expect(s1.messages.length).toBe(2);
    expect(s1.messages[0].role).toBe('user');
    expect(s1.messages[1].toolCalls?.[0].name).toBe('Read');
  });

  it('handles transcript-only session (no chats/meta) — workspacePath unknown', async () => {
    const s2 = (await discoverStoreSessions(ROOT())).find((s) => s.id === UUID2)!;
    expect(s2.messages).toHaveLength(1);
    expect(s2.workspacePath).toBeUndefined();
  });

  it('returns [] for a missing root (no throw — defensive)', async () => {
    expect(await discoverStoreSessions(join(ROOT(), 'does-not-exist'))).toEqual([]);
  });

  it('keeps subagent transcripts separate from the canonical main transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ch-main-transcript-'));
    const sessionId = 'dddddddd-0000-0000-0000-000000000004';
    const subagentId = 'eeeeeeee-0000-0000-0000-000000000005';
    try {
      const sessionDir = join(root, 'projects', 'project', 'agent-transcripts', sessionId);
      const subagentsDir = join(sessionDir, 'subagents');
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(
        join(sessionDir, `${sessionId}.jsonl`),
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'main conversation' }] },
        })
      );
      writeFileSync(
        join(subagentsDir, `${subagentId}.jsonl`),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'subagent conversation' }] },
        })
      );

      const sessions = await discoverStoreSessions(root);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe(sessionId);
      expect(sessions[0]?.messages.map((message) => message.content)).toEqual([
        'main conversation',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }) +
        '\n'
    );
    utimesSync(transcript, transcriptModifiedAt, transcriptModifiedAt);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses ACP metadata time for session createdAt but not for messages', async () => {
    const session = (await discoverStoreSessions(root)).find((s) => s.id === AUUID);
    expect(session?.createdAt).toEqual(acpCreatedAt);
    // Transcripts carry no per-message timestamp; session createdAt is not
    // copied onto messages.
    expect(session?.messages[0]?.timestamp).toBeUndefined();
  });
});

describe('discoverStoreSessions — store.db authoritative (P15)', () => {
  // P15 regression: store.db is the PRIMARY message source. A present store.db
  // is always parsed first; when it yields any messages (complete OR partial)
  // those win and the transcript does NOT participate. The transcript supplies
  // messages only when the DB is unreadable or yields zero messages, while DB
  // metadata (title/createdAt) is still adopted whenever the DB parses.
  const TUUID = 'cccccccc-0000-0000-0000-000000000003'; // complete DB (3) + transcript (2)
  const PUUID = 'cccccccc-0000-0000-0000-000000000004'; // complete DB (3) + partial transcript
  const EUUID = 'cccccccc-0000-0000-0000-000000000005'; // empty DB (0) + partial transcript
  const FUUID = 'cccccccc-0000-0000-0000-000000000006'; // partial DB (1) + longer transcript
  const XUUID = 'cccccccc-0000-0000-0000-000000000007'; // unreadable DB + transcript
  const NUUID = 'cccccccc-0000-0000-0000-000000000008'; // empty DB + no transcript
  const RUUID = 'cccccccc-0000-0000-0000-000000000009'; // unreadable DB + no transcript
  const CWD = '/tmp/proj';
  let root = '';

  function buildStoreDb(path: string, includeMessages = true): void {
    const db = new BetterSqlite3(path);
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const s = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const ins = (id: string, d: Buffer) =>
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(id, d);
    const frame = (h: string) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(h, 'hex')]);
    const l1 = Buffer.from(JSON.stringify({ role: 'user', content: 'store-msg-1' }));
    const l2 = Buffer.from(JSON.stringify({ role: 'assistant', content: 'store-msg-2' }));
    const l3 = Buffer.from(JSON.stringify({ role: 'user', content: 'store-msg-3' }));
    const h1 = s(l1),
      h2 = s(l2),
      h3 = s(l3);
    ins(h1, l1);
    ins(h2, l2);
    ins(h3, l3);
    const r = Buffer.concat([frame(h1), frame(h2), frame(h3)]);
    const rh = includeMessages ? s(r) : undefined;
    if (rh) ins(rh, r);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      Buffer.from(
        JSON.stringify({ name: 'Store Title', latestRootBlobId: rh, createdAt: 1783737832293 })
      ).toString('hex')
    );
    db.close();
  }

  /** Partial DB: root references a missing leaf → 'partial', 1 recoverable msg. */
  function buildPartialMessageStoreDb(path: string): void {
    const db = new BetterSqlite3(path);
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const s = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const ins = (id: string, d: Buffer) =>
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(id, d);
    const frame = (h: string) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(h, 'hex')]);
    const l1 = Buffer.from(JSON.stringify({ role: 'user', content: 'partial-db-msg' }));
    const h1 = s(l1);
    ins(h1, l1);
    const missingHash = s(Buffer.from('not-present'));
    const r = Buffer.concat([frame(h1), frame(missingHash)]);
    const rh = s(r);
    ins(rh, r);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      Buffer.from(
        JSON.stringify({ name: 'Partial DB Title', latestRootBlobId: rh, createdAt: 1783737832293 })
      ).toString('hex')
    );
    db.close();
  }

  /** Unreadable DB: valid SQLite with no meta table → parseStoreDb returns null. */
  function buildUnreadableStoreDb(path: string): void {
    const db = new BetterSqlite3(path);
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.close();
  }

  /** Write a transcript JSONL with N messages (alternating user/assistant). */
  function writeTranscript(dir: string, uuid: string, texts: string[]): void {
    mkdirSync(dir, { recursive: true });
    const lines = texts.map((text, i) =>
      JSON.stringify({
        role: i % 2 === 0 ? 'user' : 'assistant',
        message: { content: [{ type: 'text', text }] },
      })
    );
    writeFileSync(join(dir, `${uuid}.jsonl`), lines.join('\n') + '\n');
  }

  function chatMeta(createdAtMs: number): string {
    return JSON.stringify({ schemaVersion: 1, createdAtMs, hasConversation: true, cwd: CWD });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ch-store-authoritative-'));
    const hash = createHash('md5').update(CWD).digest('hex');
    const atBase = join(root, 'projects', 'tmp-proj', 'agent-transcripts');

    // TUUID: complete DB (3 msgs) + transcript (2 msgs). DB must win.
    const chatDir = join(root, 'chats', hash, TUUID);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, 'meta.json'), chatMeta(1783737832293));
    buildStoreDb(join(chatDir, 'store.db')); // 3 messages
    writeTranscript(join(atBase, TUUID), TUUID, ['transcript-1', 'transcript-2']);

    // PUUID: complete DB (3 msgs) + partial transcript (1 usable msg). DB wins.
    const partialChatDir = join(root, 'chats', hash, PUUID);
    mkdirSync(partialChatDir, { recursive: true });
    writeFileSync(join(partialChatDir, 'meta.json'), chatMeta(1783000000000));
    buildStoreDb(join(partialChatDir, 'store.db'));
    const partialTranscriptDir = join(atBase, PUUID);
    mkdirSync(partialTranscriptDir, { recursive: true });
    writeFileSync(
      join(partialTranscriptDir, `${PUUID}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'incomplete' }] },
      }) + '\n{"role":"assistant"'
    );

    // EUUID: empty DB (0 msgs) + partial transcript (1 usable msg). Transcript fills.
    const emptyChatDir = join(root, 'chats', hash, EUUID);
    mkdirSync(emptyChatDir, { recursive: true });
    writeFileSync(join(emptyChatDir, 'meta.json'), chatMeta(1783000000000));
    buildStoreDb(join(emptyChatDir, 'store.db'), false);
    const partialWithEmptyDbDir = join(atBase, EUUID);
    mkdirSync(partialWithEmptyDbDir, { recursive: true });
    writeFileSync(
      join(partialWithEmptyDbDir, `${EUUID}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'keep-this-message' }] },
      }) + '\n{"role":"assistant"'
    );

    // FUUID: partial DB (1 recoverable msg) + LONGER transcript (3 msgs). DB wins, partial.
    const fChatDir = join(root, 'chats', hash, FUUID);
    mkdirSync(fChatDir, { recursive: true });
    writeFileSync(join(fChatDir, 'meta.json'), chatMeta(1783000000000));
    buildPartialMessageStoreDb(join(fChatDir, 'store.db'));
    writeTranscript(join(atBase, FUUID), FUUID, ['transcript-a', 'transcript-b', 'transcript-c']);

    // XUUID: unreadable DB + transcript (1 msg). DB fails → transcript fallback.
    const xChatDir = join(root, 'chats', hash, XUUID);
    mkdirSync(xChatDir, { recursive: true });
    writeFileSync(join(xChatDir, 'meta.json'), chatMeta(1783000000000));
    buildUnreadableStoreDb(join(xChatDir, 'store.db'));
    writeTranscript(join(atBase, XUUID), XUUID, ['transcript-only-msg']);

    // NUUID: empty DB and no transcript. Preserve the accurate empty DB state.
    const nChatDir = join(root, 'chats', hash, NUUID);
    mkdirSync(nChatDir, { recursive: true });
    writeFileSync(join(nChatDir, 'meta.json'), chatMeta(1783000000000));
    buildStoreDb(join(nChatDir, 'store.db'), false);

    // RUUID: unreadable DB and no transcript. Report a degraded DB-backed session.
    const rChatDir = join(root, 'chats', hash, RUUID);
    mkdirSync(rChatDir, { recursive: true });
    writeFileSync(join(rChatDir, 'meta.json'), chatMeta(1783000000000));
    buildUnreadableStoreDb(join(rChatDir, 'store.db'));
  });
  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('store.db messages win over transcript messages when both are present', async () => {
    const sessions = await discoverStoreSessions(root);
    const s = sessions.find((x) => x.id === TUUID);
    // store.db (3 msgs) is primary; the transcript (2 msgs) does NOT participate.
    expect(s?.messages).toHaveLength(3);
    expect(s?.messages.map((m) => m.content)).toEqual([
      'store-msg-1',
      'store-msg-2',
      'store-msg-3',
    ]);
    expect(s?.source).toBe('store-complete');
    // DB metadata is adopted even though a transcript also exists.
    expect(s?.title).toBe('Store Title');
    expect(s?.messages.some((m) => m.content === 'transcript-1')).toBe(false);
  });

  it('a complete store.db overrides a usable partial transcript', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === PUUID);
    expect(s?.transcriptState).toBe('partial'); // retained for provenance
    expect(s?.source).toBe('store-complete');
    expect(s?.messages.map((message) => message.content)).toEqual([
      'store-msg-1',
      'store-msg-2',
      'store-msg-3',
    ]);
    // DB metadata/time are adopted; transcript-only content is NOT mixed in.
    expect(s?.title).toBe('Store Title');
    expect(s?.createdAt).toEqual(new Date(1783737832293));
    expect(s?.lastUpdatedAt).toEqual(new Date(1783737832293));
    expect(s?.messages.some((m) => m.content === 'incomplete')).toBe(false);
  });

  it('a partial store.db with messages still wins and reports store-partial', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === FUUID);
    expect(s?.source).toBe('store-partial');
    // Only the 1 recoverable DB message; the longer transcript does not override.
    expect(s?.messages).toHaveLength(1);
    expect(s?.messages[0]?.content).toBe('partial-db-msg');
    expect(s?.messages.some((m) => m.content === 'transcript-a')).toBe(false);
    expect(s?.title).toBe('Partial DB Title');
  });

  it('falls back to transcript messages when store.db yields none, keeping DB metadata', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === EUUID);
    expect(s?.transcriptState).toBe('partial');
    expect(s?.source).toBe('transcript');
    expect(s?.messages).toHaveLength(1);
    expect(s?.messages[0]?.content).toBe('keep-this-message');
    // DB parsed (metadata-only) → its title is still adopted.
    expect(s?.title).toBe('Store Title');
  });

  it('falls back to transcript when store.db is unreadable, without adopting DB metadata', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === XUUID);
    expect(s?.source).toBe('transcript');
    expect(s?.messages).toHaveLength(1);
    expect(s?.messages[0]?.content).toBe('transcript-only-msg');
    // DB failed to parse → its metadata is NOT adopted; chat meta time stands.
    expect(s?.title).toBeNull();
    expect(s?.createdAt).toEqual(new Date(1783000000000));
  });

  it('preserves store-complete when an empty store.db has no transcript fallback', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === NUUID);
    expect(s?.source).toBe('store-complete');
    expect(s?.transcriptState).toBe('missing');
    expect(s?.messages).toHaveLength(0);
    expect(s?.title).toBe('Store Title');
  });

  it('reports store-partial when store.db fails and no transcript fallback exists', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === RUUID);
    expect(s?.source).toBe('store-partial');
    expect(s?.transcriptState).toBe('missing');
    expect(s?.messages).toHaveLength(0);
    expect(s?.title).toBeNull();
  });
});

describe('discoverStoreSessions — per-directory failure isolation', () => {
  // One project's `agent-transcripts` is a regular file (readdirSync throws
  // ENOTDIR reliably on every platform). Discovery must skip only that project
  // and still surface a valid sibling session, without throwing.
  const UUID_OK = 'dddddddd-0000-0000-0000-000000000006';
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ch-dir-isolation-'));
    // Valid sibling project with a real transcript.
    const okDir = join(root, 'projects', 'proj-ok', 'agent-transcripts');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(
      join(okDir, `${UUID_OK}.jsonl`),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }) +
        '\n'
    );
    // Broken project: agent-transcripts is a FILE, not a directory.
    const brokenProj = join(root, 'projects', 'proj-broken');
    mkdirSync(brokenProj, { recursive: true });
    writeFileSync(join(brokenProj, 'agent-transcripts'), 'not a directory');
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('skips the unreadable directory without hiding the valid sibling', async () => {
    const sessions = await discoverStoreSessions(root);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(UUID_OK);
    // No throw, and the broken project contributed no session.
    expect(sessions.every((s) => s.id === UUID_OK)).toBe(true);
  });
});

describe('discoverStoreSessions — transcript provenance and duplicate UUIDs', () => {
  const UUID = 'ffffffff-0000-0000-0000-000000000007';
  const NEWER_UUID = 'ffffffff-0000-0000-0000-000000000010';
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ch-transcript-selection-'));
    const goodDir = join(root, 'projects', 'a-good', 'agent-transcripts');
    const emptyDir = join(root, 'projects', 'z-empty', 'agent-transcripts');
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(
      join(goodDir, `${UUID}.jsonl`),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'good' }] } }) +
        '\n'
    );
    writeFileSync(join(emptyDir, `${UUID}.jsonl`), '');

    const oldDir = join(root, 'projects', 'a-old', 'agent-transcripts');
    const newerDir = join(root, 'projects', 'z-new', 'agent-transcripts');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newerDir, { recursive: true });
    const oldTranscript = join(oldDir, `${NEWER_UUID}.jsonl`);
    const newerTranscript = join(newerDir, `${NEWER_UUID}.jsonl`);
    writeFileSync(
      oldTranscript,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'old' }] } }) + '\n'
    );
    writeFileSync(
      newerTranscript,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'new' }] } }) + '\n'
    );
    utimesSync(oldTranscript, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    utimesSync(newerTranscript, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps state, path, and messages from the same best transcript', async () => {
    const session = (await discoverStoreSessions(root)).find((item) => item.id === UUID);
    expect(session?.transcriptState).toBe('parsed');
    expect(session?.transcriptPath).toContain('a-good');
    expect(session?.messages.map((message) => message.content)).toEqual(['good']);
    expect(session?.source).toBe('transcript');
  });

  it('prefers the newer equal-quality duplicate and keeps its transcript-only timestamp', async () => {
    const session = (await discoverStoreSessions(root)).find((item) => item.id === NEWER_UUID);
    expect(session?.transcriptPath).toContain('z-new');
    expect(session?.messages.map((message) => message.content)).toEqual(['new']);
    expect(session?.createdAt).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(session?.lastUpdatedAt).toEqual(new Date('2026-01-02T00:00:00Z'));
  });

  it('retains partial transcript messages and provenance when no store.db exists', async () => {
    const partialUuid = 'ffffffff-0000-0000-0000-000000000008';
    const dir = join(root, 'projects', 'partial', 'agent-transcripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${partialUuid}.jsonl`),
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'survives' }] } }) +
        '\n{"role":"assistant"'
    );
    const session = (await discoverStoreSessions(root)).find((item) => item.id === partialUuid);
    expect(session?.transcriptState).toBe('partial');
    expect(session?.source).toBe('transcript');
    expect(session?.messages.map((message) => message.content)).toEqual(['survives']);
  });

  it('uses generic Store provenance for metadata without transcript or store.db', async () => {
    const metadataUuid = 'ffffffff-0000-0000-0000-000000000009';
    const dir = join(root, 'acp-sessions', metadataUuid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ cwd: '/tmp/metadata-only' }));
    const session = (await discoverStoreSessions(root)).find((item) => item.id === metadataUuid);
    expect(session?.transcriptState).toBe('missing');
    expect(session?.source).toBe('store');
  });
});

describe('discoverStoreSessions — metadata candidate integrity', () => {
  it('selects one duplicate UUID metadata candidate atomically', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ch-metadata-selection-'));
    const uuid = 'ffffffff-0000-0000-0000-000000000011';
    try {
      const oldDir = join(root, 'chats', 'a-old', uuid);
      const newDir = join(root, 'chats', 'z-new', uuid);
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(newDir, { recursive: true });
      writeFileSync(
        join(oldDir, 'meta.json'),
        JSON.stringify({
          cwd: '/workspace/old',
          title: 'Old copy',
          createdAtMs: 1783000000000,
          updatedAtMs: 1783000001000,
        })
      );
      writeFileSync(
        join(newDir, 'meta.json'),
        JSON.stringify({
          cwd: '/workspace/new',
          title: 'New copy',
          createdAtMs: 1784000000000,
          updatedAtMs: 1784000001000,
        })
      );

      const session = (await discoverStoreSessions(root)).find((item) => item.id === uuid);
      expect(session).toMatchObject({
        workspacePath: '/workspace/new',
        title: 'New copy',
        chatDir: newDir,
      });
      expect(session?.createdAt).toEqual(new Date(1784000000000));
      expect(session?.lastUpdatedAt).toEqual(new Date(1784000001000));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back safely when a finite timestamp is outside the Date range', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ch-invalid-metadata-time-'));
    const uuid = 'ffffffff-0000-0000-0000-000000000012';
    try {
      const sessionDir = join(root, 'chats', 'hash', uuid);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({ cwd: '/workspace/safe', createdAtMs: 1e20, updatedAtMs: 1e20 })
      );

      const session = (await discoverStoreSessions(root)).find((item) => item.id === uuid);
      expect(Number.isFinite(session?.createdAt.getTime())).toBe(true);
      expect(Number.isFinite(session?.lastUpdatedAt.getTime())).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
