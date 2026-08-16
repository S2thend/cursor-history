import { afterEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceEncodingError, SourceLimitExceededError } from '../../src/core/errors.js';
import { mapStoreSession } from '../../src/core/parser.js';
import {
  JsonlSourceReadBudget,
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  SqliteSourceReadBudget,
  resolveSourceReadLimits,
} from '../../src/core/source-read-limits.js';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';
import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';
import type { StoreSession } from '../../src/core/store-stack/types.js';
import type { SourceReadLimitsOverride } from '../../src/core/types.js';

const temporary: string[] = [];
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const frame = (leafHash: string) =>
  Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(leafHash, 'hex')]);

function tempDir(prefix = 'ch-defensive-source-'): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}

function writeTranscript(bytes: Buffer): string {
  const path = join(tempDir(), 'session.jsonl');
  writeFileSync(path, bytes);
  return path;
}

function line(text = 'hello', extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text }], ignoredNested: true },
      ignoredTopLevel: { future: true },
      ...extra,
    })
  );
}

interface StoreFixture {
  path: string;
  leafHash: string;
  leafHashes: string[];
  rawLengths: number[];
  metadataPages: number[][];
}

function storeFixture(
  options: {
    bom?: boolean;
    invalidLeaf?: boolean;
    unknownColumns?: boolean;
    leafCount?: number;
    largeLeaves?: boolean;
  } = {}
): StoreFixture {
  const path = join(tempDir(), 'store.db');
  const db = new BetterSqlite3(path);
  db.exec(
    options.unknownColumns
      ? 'CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB, future_blob TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, future_meta TEXT)'
      : 'CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)'
  );
  const bom = options.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  const leaves = Array.from({ length: options.leafCount ?? 1 }, (_, index) => {
    const leafJson = options.invalidLeaf
      ? Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])
      : Buffer.from(
          JSON.stringify({
            role: 'user',
            content:
              index === 0 && !options.largeLeaves
                ? 'bounded'
                : `bounded-${index}:${'x'.repeat(options.largeLeaves ? 512 : 0)}`,
            ignoredFutureField: true,
          })
        );
    return Buffer.concat([bom, leafJson]);
  });
  const leafHashes = leaves.map(sha);
  const root = Buffer.concat(leafHashes.map(frame));
  const rootHash = sha(root);
  for (let index = 0; index < leaves.length; index++) {
    const leafHash = leafHashes[index]!;
    const leaf = leaves[index]!;
    if (options.unknownColumns) {
      db.prepare('INSERT INTO blobs (id, data, future_blob) VALUES (?, ?, ?)').run(
        leafHash,
        leaf,
        'ignored'
      );
    } else {
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(leafHash, leaf);
    }
  }
  if (options.unknownColumns) {
    db.prepare('INSERT INTO blobs (id, data, future_blob) VALUES (?, ?, ?)').run(
      rootHash,
      root,
      'ignored'
    );
  } else {
    db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(rootHash, root);
  }
  const metaJson = Buffer.from(JSON.stringify({ latestRootBlobId: rootHash, ignored: 'future' }));
  const metaBytes = Buffer.concat([bom, metaJson]);
  const metaHex = metaBytes.toString('hex');
  if (options.unknownColumns) {
    db.prepare('INSERT INTO meta (key, value, future_meta) VALUES (?, ?, ?)').run(
      '0',
      metaHex,
      'ignored'
    );
  } else {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', metaHex);
  }
  db.close();
  const metadataPages = [
    [Buffer.byteLength(metaHex)],
    [root.length],
    leaves.map((leaf) => leaf.length),
  ];
  return {
    path,
    leafHash: leafHashes[0]!,
    leafHashes,
    rawLengths: metadataPages.flat(),
    metadataPages,
  };
}

function limits(override: SourceReadLimitsOverride) {
  return resolveSourceReadLimits(override);
}

function mappedTranscriptIdentity(
  path: string,
  readLimits = SOURCE_READ_LIMITS_V1_DEFAULTS
): string {
  const parsed = parseTranscriptFile(path, readLimits);
  const session: StoreSession = {
    id: 'identity-session',
    title: null,
    createdAt: new Date(0),
    lastUpdatedAt: new Date(0),
    messages: parsed.messages,
    messageIdentityEvidence: parsed.messageIdentityEvidence,
    source: 'global',
    resolvedSource: 'store-transcript',
    resolution: {
      state: 'complete',
      expectedSourceRoles: ['store'],
      loadedSourceRoles: ['store'],
      omittedSourceRoles: [],
      failedSourceRoles: [],
      reasonCodes: [],
    },
    transcriptState: parsed.state,
  };
  return mapStoreSession(session, 1).messages[0]!.id!;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Source Read Limits v1 exact inclusive counters', () => {
  it('accepts equality and reports the first unit above every JSONL bound', () => {
    const record = new JsonlSourceReadBudget(
      limits({ jsonlRecordBytes: 5, jsonlSourceBytes: 10, jsonlRecordCount: 2 }),
      'fatal'
    );
    record.admitSourceBytes(10);
    record.admitRecord(5, true);
    record.admitRecord(5, true);
    expect(record.sourceBytes).toBe(10);
    expect(record.recordCount).toBe(2);

    const cases = [
      () => {
        const budget = new JsonlSourceReadBudget(
          limits({ jsonlRecordBytes: 5, jsonlSourceBytes: 10 }),
          'fatal'
        );
        budget.admitRecord(6, true);
      },
      () => {
        const budget = new JsonlSourceReadBudget(
          limits({ jsonlRecordBytes: 5, jsonlSourceBytes: 10 }),
          'fatal'
        );
        budget.admitSourceBytes(11);
      },
      () => {
        const budget = new JsonlSourceReadBudget(limits({ jsonlRecordCount: 2 }), 'fatal');
        budget.admitRecord(1, true);
        budget.admitRecord(1, true);
        budget.admitRecord(1, true);
      },
    ];
    const expected = [
      ['jsonl-record-bytes', 5, 6, 'bytes'],
      ['jsonl-source-bytes', 10, 11, 'bytes'],
      ['jsonl-record-count', 2, 3, 'records'],
    ];
    cases.forEach((run, index) => {
      let error: unknown;
      try {
        run();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SourceLimitExceededError);
      expect((error as SourceLimitExceededError).details).toMatchObject({
        sourceKind: 'jsonl',
        bound: expected[index]![0],
        limit: expected[index]![1],
        observedAtLeast: expected[index]![2],
        unit: expected[index]![3],
        outcome: 'fatal',
      });
    });
  });

  it('accepts equality and reports the first unit above every SQLite bound', () => {
    const exact = new SqliteSourceReadBudget(
      limits({
        sqlitePageRows: 2,
        sqlitePageBytes: 5,
        sqliteValueBytes: 3,
        sqliteRowCount: 3,
        sqliteDecodedBytes: 5,
      }),
      'fatal'
    );
    exact.admitMetadataPage([2, 3]);
    exact.admitDecodedValue(3);
    exact.admitMetadataPage([2]);
    exact.admitDecodedValue(2);
    expect(exact.rowCount).toBe(3);
    expect(exact.decodedBytes).toBe(5);

    const matrix: Array<{
      bound: string;
      limit: number;
      observed: number;
      unit: string;
      run(): void;
    }> = [
      {
        bound: 'sqlite-page-rows',
        limit: 1,
        observed: 2,
        unit: 'rows',
        run: () =>
          new SqliteSourceReadBudget(
            limits({ sqlitePageRows: 1, sqliteRowCount: 2 }),
            'fatal'
          ).admitMetadataPage([0, 0]),
      },
      {
        bound: 'sqlite-page-bytes',
        limit: 4,
        observed: 5,
        unit: 'bytes',
        run: () =>
          new SqliteSourceReadBudget(
            limits({ sqliteValueBytes: 4, sqlitePageBytes: 4 }),
            'fatal'
          ).admitMetadataPage([2, 3]),
      },
      {
        bound: 'sqlite-value-bytes',
        limit: 4,
        observed: 5,
        unit: 'bytes',
        run: () =>
          new SqliteSourceReadBudget(limits({ sqliteValueBytes: 4 }), 'fatal').admitMetadataPage([
            5,
          ]),
      },
      {
        bound: 'sqlite-row-count',
        limit: 1,
        observed: 2,
        unit: 'rows',
        run: () => {
          const budget = new SqliteSourceReadBudget(
            limits({ sqlitePageRows: 1, sqliteRowCount: 1 }),
            'fatal'
          );
          budget.admitMetadataPage([0]);
          budget.admitMetadataPage([0]);
        },
      },
      {
        bound: 'sqlite-decoded-bytes',
        limit: 4,
        observed: 5,
        unit: 'bytes',
        run: () => {
          const budget = new SqliteSourceReadBudget(
            limits({ sqliteValueBytes: 4, sqlitePageBytes: 4, sqliteDecodedBytes: 4 }),
            'fatal'
          );
          budget.admitDecodedValue(3);
          budget.admitDecodedValue(2);
        },
      },
    ];
    for (const entry of matrix) {
      let error: unknown;
      try {
        entry.run();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SourceLimitExceededError);
      expect((error as SourceLimitExceededError).details).toMatchObject({
        sourceKind: 'sqlite',
        bound: entry.bound,
        limit: entry.limit,
        observedAtLeast: entry.observed,
        unit: entry.unit,
        outcome: 'fatal',
      });
    }
  });

  it('resets JSONL per transcript and SQLite per logical hydration/catalog scan', () => {
    const jsonLimits = limits({ jsonlRecordCount: 1 });
    const first = writeTranscript(Buffer.concat([line('one'), Buffer.from('\n')]));
    const second = writeTranscript(Buffer.concat([line('two'), Buffer.from('\n')]));
    expect(parseTranscriptFile(first, jsonLimits).state).toBe('parsed');
    expect(parseTranscriptFile(second, jsonLimits).state).toBe('parsed');

    const sessionBudget = new SqliteSourceReadBudget(
      limits({ sqlitePageRows: 1, sqliteRowCount: 1 }),
      'fatal'
    );
    const catalogBudget = new SqliteSourceReadBudget(
      limits({ sqlitePageRows: 1, sqliteRowCount: 1 }),
      'fatal'
    );
    sessionBudget.admitMetadataPage([0]);
    catalogBudget.admitMetadataPage([0]);
    expect(sessionBudget.rowCount).toBe(1);
    expect(catalogBudget.rowCount).toBe(1);
  });
});

describe('bounded streaming JSONL', () => {
  it('counts raw multibyte bytes, BOM and newlines while excluding CR/LF from record bytes', () => {
    const record = line('€');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const source = Buffer.concat([bom, record, Buffer.from('\r\n')]);
    const path = writeTranscript(source);
    const exact = limits({
      jsonlRecordBytes: record.byteLength,
      jsonlSourceBytes: source.byteLength,
      jsonlRecordCount: 1,
    });
    expect(parseTranscriptFile(path, exact).messages[0]?.content).toBe('€');

    const tooSmall = limits({
      jsonlRecordBytes: record.byteLength - 1,
      jsonlSourceBytes: source.byteLength,
    });
    expect(() => parseTranscriptFile(path, tooSmall)).toThrowError(
      expect.objectContaining({
        code: 'SOURCE_LIMIT_EXCEEDED',
        details: expect.objectContaining({
          bound: 'jsonl-record-bytes',
          observedAtLeast: record.byteLength,
        }),
      })
    );
  });

  it('streams source/count bounds and never reports successful truncation', () => {
    const first = line('one');
    const second = line('two');
    const source = Buffer.concat([first, Buffer.from('\n'), second, Buffer.from('\n')]);
    const path = writeTranscript(source);
    const exact = limits({
      jsonlRecordBytes: Math.max(first.length, second.length),
      jsonlSourceBytes: source.length,
      jsonlRecordCount: 2,
    });
    expect(parseTranscriptFile(path, exact).messages).toHaveLength(2);

    const sourceAbove = limits({
      jsonlRecordBytes: first.length,
      jsonlSourceBytes: source.length - 1,
      jsonlRecordCount: 2,
    });
    expect(() => parseTranscriptFile(path, sourceAbove)).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({
          bound: 'jsonl-source-bytes',
          observedAtLeast: source.length,
        }),
      })
    );
    const countAbove = limits({ jsonlRecordCount: 1 });
    expect(() => parseTranscriptFile(path, countAbove)).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({
          bound: 'jsonl-record-count',
          observedAtLeast: 2,
        }),
      })
    );
  });

  it('charges a completed record before contiguous allocation or UTF-8 decoding', () => {
    const path = writeTranscript(Buffer.from('abcdefgh'));
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      expect(() =>
        parseTranscriptFile(
          path,
          limits({ jsonlRecordBytes: 4, jsonlSourceBytes: 8, jsonlRecordCount: 1 })
        )
      ).toThrowError(
        expect.objectContaining({
          code: 'SOURCE_LIMIT_EXCEEDED',
          details: expect.objectContaining({
            bound: 'jsonl-record-bytes',
            limit: 4,
            observedAtLeast: 5,
          }),
        })
      );
      expect(concat).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
    }
  });

  it('accepts one leading BOM, rejects invalid/mixed UTF-8, and ignores unknown fields', () => {
    const plain = Buffer.concat([line('same'), Buffer.from('\n')]);
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
    const plainPath = writeTranscript(plain);
    const bomPath = writeTranscript(withBom);
    expect(mappedTranscriptIdentity(bomPath)).toBe(mappedTranscriptIdentity(plainPath));
    expect(parseTranscriptFile(bomPath).messages[0]?.content).toBe('same');

    const invalidPath = writeTranscript(
      Buffer.concat([Buffer.from('{"role":"user","message":{"content":"'), Buffer.from([0xff])])
    );
    expect(() => parseTranscriptFile(invalidPath)).toThrow(SourceEncodingError);
    const degraded = parseTranscriptFile(invalidPath, SOURCE_READ_LIMITS_V1_DEFAULTS, 'partial');
    expect(degraded.state).toBe('unreadable');
    expect(degraded.diagnostic).toMatchObject({
      code: 'SOURCE_ENCODING_INVALID',
      details: { sourceKind: 'jsonl', outcome: 'partial' },
    });

    const secondBom = writeTranscript(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), line('bad-bom')])
    );
    expect(() => parseTranscriptFile(secondBom)).toThrow(SourceEncodingError);
  });

  it('retains transcript line order and canonical identity inputs before mapping', () => {
    const source = Buffer.concat([
      Buffer.from('\n'),
      line('first', { parentMessageId: 'source-parent', isSidechain: true }),
      Buffer.from('\n'),
      line('second'),
      Buffer.from('\n'),
    ]);
    const parsed = parseTranscriptFile(writeTranscript(source));
    expect(parsed.messageIdentityEvidence).toEqual([
      expect.objectContaining({
        representation: 'transcript',
        sourceLine: 2,
        role: 'user',
        content: 'first',
        sourceRelationships: { parentMessageId: 'source-parent', isSidechain: true },
      }),
      expect.objectContaining({ representation: 'transcript', sourceLine: 3, content: 'second' }),
    ]);

    const session: StoreSession = {
      id: 'transcript-identities',
      title: null,
      createdAt: new Date(0),
      lastUpdatedAt: new Date(0),
      messages: parsed.messages,
      messageIdentityEvidence: parsed.messageIdentityEvidence,
      source: 'global',
      resolvedSource: 'store-transcript',
      transcriptState: parsed.state,
    };
    const mapped = mapStoreSession(session, 1);
    expect(mapped.messageIdentityVersion).toBe(1);
    expect(mapped.messages.every((message) => Boolean(message.id))).toBe(true);
    expect(mapped.messages.map((message) => message.identityOrigin)).toEqual([
      'store-transcript-v1',
      'store-transcript-v1',
    ]);
    expect(mapped.messages[1]?.parentMessageId).toBe(mapped.messages[0]?.id);
  });
});

describe('bounded SQLite Store hydration', () => {
  it('uses row-ID preflight budgets and preserves leaf hash/traversal identity', async () => {
    const fixture = storeFixture({ bom: true, unknownColumns: true });
    const total = fixture.rawLengths.reduce((sum, value) => sum + value, 0);
    const largest = Math.max(...fixture.rawLengths);
    const exact = limits({
      sqlitePageRows: 1,
      sqlitePageBytes: largest,
      sqliteValueBytes: largest,
      sqliteRowCount: fixture.rawLengths.length,
      sqliteDecodedBytes: total,
    });
    const data = await parseStoreDb(fixture.path, { limits: exact });
    expect(data?.messages[0]?.content).toBe('bounded');
    expect(data?.messageIdentityEvidence).toEqual([
      { representation: 'db', leafHash: fixture.leafHash, traversalOrdinal: 0 },
    ]);

    const mapped = mapStoreSession(
      {
        id: 'db-identity',
        title: null,
        createdAt: new Date(0),
        lastUpdatedAt: new Date(0),
        messages: data!.messages,
        messageIdentityEvidence: data!.messageIdentityEvidence,
        source: 'global',
        resolvedSource: 'store-db',
        transcriptState: 'missing',
      },
      1
    );
    expect(mapped.messages[0]?.id).toBe(`store:v1:db:${fixture.leafHash}:1`);
  });

  it('exercises below/equal/above bounds through actual finite SQLite metadata pages', async () => {
    const fixture = storeFixture({ leafCount: 2, largeLeaves: true });
    const total = fixture.rawLengths.reduce((sum, value) => sum + value, 0);
    const largestValue = Math.max(...fixture.rawLengths);
    const largestPage = Math.max(
      ...fixture.metadataPages.map((page) => page.reduce((sum, value) => sum + value, 0))
    );
    const largestPageRows = Math.max(...fixture.metadataPages.map((page) => page.length));
    const base = {
      sqlitePageRows: largestPageRows,
      sqlitePageBytes: largestPage,
      sqliteValueBytes: largestValue,
      sqliteRowCount: fixture.rawLengths.length,
      sqliteDecodedBytes: total,
    } satisfies SourceReadLimitsOverride;
    const below = {
      sqlitePageRows: largestPageRows + 1,
      sqlitePageBytes: largestPage + 1,
      sqliteValueBytes: largestValue + 1,
      sqliteRowCount: fixture.rawLengths.length + 1,
      sqliteDecodedBytes: total + 1,
    } satisfies SourceReadLimitsOverride;
    await expect(parseStoreDb(fixture.path, { limits: limits(below) })).resolves.not.toBeNull();
    await expect(parseStoreDb(fixture.path, { limits: limits(base) })).resolves.not.toBeNull();
    const oneRowPages = await parseStoreDb(fixture.path, {
      limits: limits({ ...base, sqlitePageRows: 1 }),
    });
    expect(oneRowPages?.messages).toHaveLength(2);

    const failures: Array<{
      override: SourceReadLimitsOverride;
      bound: string;
      limit: number;
      observedAtLeast: number;
    }> = [
      {
        override: { ...base, sqlitePageBytes: largestPage - 1 },
        bound: 'sqlite-page-bytes',
        limit: largestPage - 1,
        observedAtLeast: largestPage,
      },
      {
        override: { ...base, sqliteValueBytes: largestValue - 1 },
        bound: 'sqlite-value-bytes',
        limit: largestValue - 1,
        observedAtLeast: largestValue,
      },
      {
        override: { ...base, sqliteRowCount: fixture.rawLengths.length - 1 },
        bound: 'sqlite-row-count',
        limit: fixture.rawLengths.length - 1,
        observedAtLeast: fixture.rawLengths.length,
      },
      {
        override: {
          ...base,
          sqliteDecodedBytes: total - 1,
        },
        bound: 'sqlite-decoded-bytes',
        limit: total - 1,
        observedAtLeast: total,
      },
    ];
    for (const failure of failures) {
      await expect(
        parseStoreDb(fixture.path, { limits: limits(failure.override) })
      ).rejects.toMatchObject({
        code: 'SOURCE_LIMIT_EXCEEDED',
        details: {
          sourceKind: 'sqlite',
          bound: failure.bound,
          limit: failure.limit,
          observedAtLeast: failure.observedAtLeast,
          outcome: 'fatal',
        },
      });
    }
  });

  it('does not replacement-decode invalid SQLite text and supports typed safe fallback', async () => {
    const fixture = storeFixture({ invalidLeaf: true });
    await expect(parseStoreDb(fixture.path)).rejects.toBeInstanceOf(SourceEncodingError);

    const diagnostics: unknown[] = [];
    const partial = await parseStoreDb(fixture.path, {
      failureOutcome: 'partial',
      onDiagnostic: (value) => diagnostics.push(value),
    });
    expect(partial).toMatchObject({ messages: [], completeness: 'partial' });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_ENCODING_INVALID',
        details: expect.objectContaining({ sourceKind: 'sqlite', outcome: 'partial' }),
      }),
    ]);
  });
});

describe('per-operation override boundary', () => {
  it('rejects invalid policy before discovery payload reads and never uses env/input limits', async () => {
    const missingRoot = join(tempDir(), 'missing');
    for (const override of [
      { policyVersion: undefined },
      { unknown: undefined },
      { jsonlRecordBytes: null },
      { jsonlRecordBytes: 5, jsonlSourceBytes: 4 },
      { sqliteValueBytes: 5, sqlitePageBytes: 4 },
      { jsonlRecordBytes: '5' },
    ]) {
      await expect(
        discoverStoreSessions(missingRoot, { sourceReadLimits: override as never })
      ).rejects.toMatchObject({ code: 'SOURCE_LIMIT_CONFIGURATION_INVALID' });
    }

    const previous = process.env['CURSOR_HISTORY_SOURCE_LIMIT_JSONL_RECORD_BYTES'];
    process.env['CURSOR_HISTORY_SOURCE_LIMIT_JSONL_RECORD_BYTES'] = '1';
    try {
      expect(resolveSourceReadLimits().jsonlRecordBytes).toBe(
        SOURCE_READ_LIMITS_V1_DEFAULTS.jsonlRecordBytes
      );
      const inherited = resolveSourceReadLimits({ jsonlRecordBytes: undefined });
      expect(inherited.jsonlRecordBytes).toBe(SOURCE_READ_LIMITS_V1_DEFAULTS.jsonlRecordBytes);
      expect(Object.isFrozen(inherited)).toBe(true);
    } finally {
      if (previous === undefined)
        delete process.env['CURSOR_HISTORY_SOURCE_LIMIT_JSONL_RECORD_BYTES'];
      else process.env['CURSOR_HISTORY_SOURCE_LIMIT_JSONL_RECORD_BYTES'] = previous;
    }
  });

  it('allows immutable per-operation raising/lowering without changing identity', () => {
    const source = Buffer.concat([line('identity-stable'), Buffer.from('\n')]);
    const path = writeTranscript(source);
    const lower = limits({
      jsonlRecordBytes: source.length - 1,
      jsonlSourceBytes: source.length,
    });
    const raised = limits({
      jsonlRecordBytes: source.length + 100,
      jsonlSourceBytes: source.length + 100,
    });
    const baseline = mappedTranscriptIdentity(path);
    expect(mappedTranscriptIdentity(path, lower)).toBe(baseline);
    expect(mappedTranscriptIdentity(path, raised)).toBe(baseline);
    expect(Object.isFrozen(lower)).toBe(true);
    expect(Object.isFrozen(raised)).toBe(true);
  });
});
