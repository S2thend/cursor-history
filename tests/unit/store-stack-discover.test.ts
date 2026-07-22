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

describe('discoverStoreSessions — transcript authoritative', () => {
  // Hard regression #1 (per review): a session with BOTH a transcript AND a
  // store.db must keep the transcript's messages and is not read as a second
  // conversation source. Construct: transcript=2 msgs, store.db=3 msgs →
  // discover must surface 2 (transcript), source 'transcript'.
  const TUUID = 'cccccccc-0000-0000-0000-000000000003';
  const PUUID = 'cccccccc-0000-0000-0000-000000000004';
  const EUUID = 'cccccccc-0000-0000-0000-000000000005';
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

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ch-transcript-'));
    const hash = createHash('md5').update(CWD).digest('hex');
    const chatDir = join(root, 'chats', hash, TUUID);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(
      join(chatDir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        createdAtMs: 1783737832293,
        hasConversation: true,
        cwd: CWD,
      })
    );
    buildStoreDb(join(chatDir, 'store.db')); // 3 messages
    // transcript (2 messages) — AUTHORITATIVE
    const atDir = join(root, 'projects', 'tmp-proj', 'agent-transcripts', TUUID);
    mkdirSync(atDir, { recursive: true });
    writeFileSync(
      join(atDir, `${TUUID}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'transcript-1' }] },
      }) +
        '\n' +
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'transcript-2' }] },
        }) +
        '\n'
    );

    const partialChatDir = join(root, 'chats', hash, PUUID);
    mkdirSync(partialChatDir, { recursive: true });
    writeFileSync(
      join(partialChatDir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        createdAtMs: 1783000000000,
        hasConversation: true,
        cwd: CWD,
      })
    );
    buildStoreDb(join(partialChatDir, 'store.db'));
    const partialTranscriptDir = join(root, 'projects', 'tmp-proj', 'agent-transcripts', PUUID);
    mkdirSync(partialTranscriptDir, { recursive: true });
    writeFileSync(
      join(partialTranscriptDir, `${PUUID}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'incomplete' }] },
      }) + '\n{"role":"assistant"'
    );

    const emptyChatDir = join(root, 'chats', hash, EUUID);
    mkdirSync(emptyChatDir, { recursive: true });
    writeFileSync(
      join(emptyChatDir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        createdAtMs: 1783000000000,
        hasConversation: true,
        cwd: CWD,
      })
    );
    buildStoreDb(join(emptyChatDir, 'store.db'), false);
    const partialWithEmptyDbDir = join(root, 'projects', 'tmp-proj', 'agent-transcripts', EUUID);
    mkdirSync(partialWithEmptyDbDir, { recursive: true });
    writeFileSync(
      join(partialWithEmptyDbDir, `${EUUID}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'keep-this-message' }] },
      }) + '\n{"role":"assistant"'
    );
  });
  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('store.db does NOT overwrite transcript messages', async () => {
    const sessions = await discoverStoreSessions(root);
    const s = sessions.find((x) => x.id === TUUID);
    expect(s?.messages).toHaveLength(2); // transcript (NOT store.db's 3)
    expect(s?.messages[0]?.content).toBe('transcript-1');
  });

  it('keeps transcript sessions off the store.db parse path', async () => {
    const s = (await discoverStoreSessions(root)).find((x) => x.id === TUUID);
    expect(s?.source).toBe('transcript');
    // The transcript path must not open store.db just to enrich metadata.
    // This keeps Issue #31 list/show free of unnecessary SQLite parsing and warnings.
    expect(s?.title).toBeNull();
  });

  it('keeps usable partial transcript messages authoritative over store.db', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === PUUID);
    expect(s?.transcriptState).toBe('partial');
    expect(s?.source).toBe('transcript');
    expect(s?.messages.map((message) => message.content)).toEqual(['incomplete']);
    expect(s?.createdAt).toEqual(new Date(1783000000000));
    expect(s?.lastUpdatedAt).toEqual(new Date(1783000000000));
  });

  it('does not replace usable partial transcript messages with an empty database result', async () => {
    const s = (await discoverStoreSessions(root)).find((item) => item.id === EUUID);
    expect(s?.transcriptState).toBe('partial');
    expect(s?.source).toBe('transcript');
    expect(s?.messages).toHaveLength(1);
    expect(s?.messages[0]?.content).toBe('keep-this-message');
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
