import { afterEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseCapabilityError } from '../../src/core/database/errors.js';
import * as database from '../../src/core/database/index.js';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';

type DbShape =
  'complete' | 'partial' | 'empty' | 'source-corrupt' | 'invalid-encoding' | 'invalid-after-prefix';

const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const frame = (leafHash: string) =>
  Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(leafHash, 'hex')]);

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'ch-store-expectation-'));
  roots.push(value);
  return value;
}

function chatDir(base: string, id: string, hasConversation?: boolean): string {
  const dir = join(base, 'chats', 'hash', id);
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = { cwd: `/work/${id}`, createdAtMs: 1783000000000 };
  if (hasConversation !== undefined) meta['hasConversation'] = hasConversation;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

function transcript(
  base: string,
  id: string,
  state: 'complete' | 'partial' | 'empty' | 'invalid-encoding' | 'invalid-after-prefix'
): void {
  const dir = join(base, 'projects', 'fixture', 'agent-transcripts');
  mkdirSync(dir, { recursive: true });
  const valid = JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: `transcript:${id}` }] },
  });
  const content =
    state === 'complete'
      ? `${valid}\n`
      : state === 'partial'
        ? `${valid}\n{"role":`
        : state === 'invalid-encoding'
          ? Buffer.concat([Buffer.from('{"role":"user","message":"'), Buffer.from([0xff])])
          : state === 'invalid-after-prefix'
            ? Buffer.concat([
                Buffer.from(`${valid}\n{"role":"user","message":"`),
                Buffer.from([0xff]),
              ])
            : '';
  writeFileSync(join(dir, `${id}.jsonl`), content);
}

function storeDb(dir: string, shape: DbShape): void {
  const db = new BetterSqlite3(join(dir, 'store.db'));
  if (shape === 'source-corrupt') {
    db.exec('CREATE TABLE unrelated (value TEXT)');
    db.close();
    return;
  }
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  let rootHash: string | undefined;
  if (shape !== 'empty') {
    const firstLeaf =
      shape === 'invalid-encoding'
        ? Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])
        : Buffer.from(JSON.stringify({ role: 'user', content: `db:${shape}` }));
    const firstHash = hash(firstLeaf);
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(firstHash, firstLeaf);
    const leafFrames = [frame(firstHash)];
    if (shape === 'invalid-after-prefix') {
      const invalidLeaf = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
      const invalidHash = hash(invalidLeaf);
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(invalidHash, invalidLeaf);
      leafFrames.push(frame(invalidHash));
    }
    const rootData =
      shape === 'partial'
        ? Buffer.concat([frame(firstHash), frame(hash(Buffer.from('missing')))])
        : Buffer.concat(leafFrames);
    rootHash = hash(rootData);
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(rootHash, rootData);
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
    '0',
    Buffer.from(JSON.stringify({ name: shape, latestRootBlobId: rootHash })).toString('hex')
  );
  db.close();
}

function byId<T extends { id: string }>(values: T[], id: string): T {
  const value = values.find((candidate) => candidate.id === id);
  expect(value, `missing ${id}`).toBeDefined();
  return value!;
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('StoreDbExpectation and representation selection', () => {
  it('covers the complete expected/not-expected/unknown selection matrix with real sources', async () => {
    const base = root();

    const completeDb = 'expected-complete-db';
    storeDb(chatDir(base, completeDb, true), 'complete');
    transcript(base, completeDb, 'complete');

    const partialDb = 'expected-partial-db';
    storeDb(chatDir(base, partialDb, true), 'partial');
    transcript(base, partialDb, 'complete');

    const expectedCompleteTranscript = 'expected-missing-db-complete-transcript';
    chatDir(base, expectedCompleteTranscript, true);
    transcript(base, expectedCompleteTranscript, 'complete');

    const expectedPartialTranscript = 'expected-empty-db-partial-transcript';
    storeDb(chatDir(base, expectedPartialTranscript, true), 'empty');
    transcript(base, expectedPartialTranscript, 'partial');

    const notExpectedComplete = 'not-expected-complete-transcript';
    chatDir(base, notExpectedComplete, false);
    transcript(base, notExpectedComplete, 'complete');

    const notExpectedPartial = 'not-expected-partial-transcript';
    chatDir(base, notExpectedPartial, false);
    transcript(base, notExpectedPartial, 'partial');

    const transcriptOnly = 'canonical-transcript-only';
    transcript(base, transcriptOnly, 'complete');

    const unknownTranscript = 'unknown-complete-transcript';
    chatDir(base, unknownTranscript);
    transcript(base, unknownTranscript, 'complete');

    const expectedMetadata = 'expected-no-conversation';
    chatDir(base, expectedMetadata, true);

    const unknownMetadata = 'unknown-no-conversation';
    chatDir(base, unknownMetadata);

    const notExpectedEvidence = 'not-expected-empty-transcript';
    chatDir(base, notExpectedEvidence, false);
    transcript(base, notExpectedEvidence, 'empty');

    const explicitNoConversation = 'explicit-no-conversation';
    chatDir(base, explicitNoConversation, false);

    const corruptDbFallback = 'expected-corrupt-db-transcript';
    storeDb(chatDir(base, corruptDbFallback, true), 'source-corrupt');
    transcript(base, corruptDbFallback, 'complete');

    const sessions = await discoverStoreSessions(base);

    expect(byId(sessions, completeDb)).toMatchObject({
      storeDbExpectation: 'expected',
      source: 'global',
      resolvedSource: 'store-db',
      resolution: { state: 'complete', reasonCodes: [] },
    });
    expect(byId(sessions, completeDb).messages[0]?.content).toBe('db:complete');

    expect(byId(sessions, partialDb)).toMatchObject({
      storeDbExpectation: 'expected',
      source: 'workspace-fallback',
      resolvedSource: 'store-db',
      resolution: { state: 'partial', reasonCodes: ['source-partial'] },
    });
    expect(byId(sessions, partialDb).messages[0]?.content).toBe('db:partial');

    for (const id of [expectedCompleteTranscript, corruptDbFallback]) {
      expect(byId(sessions, id)).toMatchObject({
        storeDbExpectation: 'expected',
        source: 'workspace-fallback',
        resolvedSource: 'store-transcript',
        resolution: { state: 'partial', reasonCodes: ['expected-store-db-unavailable'] },
      });
    }
    expect(byId(sessions, expectedPartialTranscript).resolution?.reasonCodes).toEqual([
      'expected-store-db-unavailable',
      'source-partial',
    ]);

    expect(byId(sessions, notExpectedComplete)).toMatchObject({
      storeDbExpectation: 'not-expected',
      source: 'global',
      resolvedSource: 'store-transcript',
      resolution: { state: 'complete', reasonCodes: [] },
    });
    expect(byId(sessions, transcriptOnly).storeDbExpectation).toBe('not-expected');
    expect(byId(sessions, transcriptOnly).source).toBe('global');
    expect(byId(sessions, notExpectedPartial).resolution?.reasonCodes).toEqual(['source-partial']);

    expect(byId(sessions, unknownTranscript)).toMatchObject({
      storeDbExpectation: 'unknown',
      source: 'workspace-fallback',
      resolvedSource: 'store-transcript',
      resolution: { state: 'partial', reasonCodes: ['store-db-expectation-unknown'] },
    });

    for (const id of [expectedMetadata, unknownMetadata, notExpectedEvidence]) {
      expect(byId(sessions, id)).toMatchObject({
        source: 'workspace-fallback',
        resolvedSource: 'store-metadata',
        resolution: { state: 'partial', reasonCodes: ['store-conversation-unavailable'] },
      });
    }
    expect(sessions.some((session) => session.id === explicitNoConversation)).toBe(false);
  });

  it('lets positive expected evidence win conflicting false/unsupported metadata', async () => {
    const base = root();
    const id = 'positive-wins';
    const first = chatDir(base, id, false);
    writeFileSync(
      join(first, 'meta.json'),
      JSON.stringify({ hasConversation: false, createdAtMs: 1783000000000 })
    );
    const second = join(base, 'acp-sessions', id);
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'meta.json'), JSON.stringify({ hasConversation: true }));
    const session = byId(await discoverStoreSessions(base), id);
    expect(session.storeDbExpectation).toBe('expected');
    expect(session.resolvedSource).toBe('store-metadata');
  });

  it('propagates capability/snapshot infrastructure failures without transcript fallback', async () => {
    const base = root();
    const id = 'fatal-infrastructure';
    storeDb(chatDir(base, id, true), 'complete');
    transcript(base, id, 'complete');
    const spy = vi
      .spyOn(database, 'backupDatabase')
      .mockRejectedValueOnce(
        new DatabaseCapabilityError('node:sqlite', 'store-snapshot', ['onlineBackup'])
      );
    spies.push(spy);

    await expect(discoverStoreSessions(base)).rejects.toMatchObject({
      code: 'DATABASE_CAPABILITY_MISSING',
    });
  });

  it('promotes typed source failures when no safe alternate contributor exists', async () => {
    const transcriptRoot = root();
    transcript(transcriptRoot, 'bad-transcript', 'invalid-encoding');
    await expect(discoverStoreSessions(transcriptRoot)).rejects.toMatchObject({
      code: 'SOURCE_ENCODING_INVALID',
      details: { sourceKind: 'jsonl', outcome: 'fatal' },
    });

    const dbRoot = root();
    storeDb(chatDir(dbRoot, 'bad-db', true), 'invalid-encoding');
    await expect(discoverStoreSessions(dbRoot)).rejects.toMatchObject({
      code: 'SOURCE_ENCODING_INVALID',
      details: { sourceKind: 'sqlite', outcome: 'fatal' },
    });

    const limitedRoot = root();
    transcript(limitedRoot, 'bounded-transcript', 'complete');
    await expect(
      discoverStoreSessions(limitedRoot, {
        sourceReadLimits: { jsonlRecordBytes: 8, jsonlSourceBytes: 128 * 1024 },
      })
    ).rejects.toMatchObject({
      code: 'SOURCE_LIMIT_EXCEEDED',
      details: { sourceKind: 'jsonl', bound: 'jsonl-record-bytes', outcome: 'fatal' },
    });
  });

  it('retains partial diagnostics only when a real alternate contributor remains', async () => {
    const dbFailureRoot = root();
    const dbFailureId = 'db-failure-with-transcript';
    storeDb(chatDir(dbFailureRoot, dbFailureId, true), 'invalid-encoding');
    transcript(dbFailureRoot, dbFailureId, 'complete');
    const dbDiagnostics: unknown[] = [];
    const transcriptFallback = byId(
      await discoverStoreSessions(dbFailureRoot, {
        onDiagnostic: (diagnostic) => dbDiagnostics.push(diagnostic),
      }),
      dbFailureId
    );
    expect(transcriptFallback).toMatchObject({
      resolvedSource: 'store-transcript',
      resolution: {
        state: 'partial',
        reasonCodes: ['expected-store-db-unavailable', 'source-read-failed'],
      },
      diagnostics: [
        expect.objectContaining({
          code: 'SOURCE_ENCODING_INVALID',
          sourceKind: 'sqlite',
          outcome: 'partial',
        }),
      ],
    });
    expect(dbDiagnostics).toEqual(transcriptFallback.diagnostics);

    const transcriptFailureRoot = root();
    const transcriptFailureId = 'transcript-failure-with-db';
    storeDb(chatDir(transcriptFailureRoot, transcriptFailureId, true), 'complete');
    transcript(transcriptFailureRoot, transcriptFailureId, 'invalid-encoding');
    const dbFallback = byId(
      await discoverStoreSessions(transcriptFailureRoot),
      transcriptFailureId
    );
    expect(dbFallback).toMatchObject({
      resolvedSource: 'store-db',
      resolution: { state: 'partial', reasonCodes: ['source-read-failed'] },
      diagnostics: [
        expect.objectContaining({
          code: 'SOURCE_ENCODING_INVALID',
          sourceKind: 'jsonl',
          outcome: 'partial',
        }),
      ],
    });
  });

  it('does not let two truncated representations validate each other as safe', async () => {
    const base = root();
    const id = 'both-sources-fail-after-prefix';
    storeDb(chatDir(base, id, true), 'invalid-after-prefix');
    transcript(base, id, 'invalid-after-prefix');

    await expect(discoverStoreSessions(base)).rejects.toMatchObject({
      code: 'SOURCE_ENCODING_INVALID',
      details: { outcome: 'fatal' },
    });
  });

  it('propagates non-ENOENT transcript read failures instead of publishing metadata', async () => {
    const base = root();
    const id = 'transcript-read-failure';
    chatDir(base, id, true);
    const nested = join(base, 'projects', 'fixture', 'agent-transcripts', id, `${id}.jsonl`);
    mkdirSync(nested, { recursive: true });

    await expect(discoverStoreSessions(base)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
