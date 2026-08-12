import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createComposerSqliteBudget,
  forEachBoundedComposerValue,
  readBoundedComposerValueByKey,
  sqliteLikeLiteralPrefix,
} from '../../src/core/composer-sqlite.js';
import type { Database } from '../../src/core/database/types.js';
import { resolveSourceReadLimits } from '../../src/core/source-read-limits.js';

const databases: BetterSqlite3.Database[] = [];

function database(): { raw: BetterSqlite3.Database; adapter: Database } {
  const raw = new BetterSqlite3(':memory:');
  raw.exec('CREATE TABLE cursorDiskKV (key TEXT NOT NULL, value BLOB NOT NULL)');
  databases.push(raw);
  return { raw, adapter: raw as unknown as Database };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('bounded Composer SQLite reads', () => {
  it('preflights declared bytes before materializing an exact-key payload', () => {
    const { raw, adapter } = database();
    raw
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('composerData:bounded', '12345');
    let payloadFetches = 0;
    const observed: Database = {
      ...adapter,
      prepare(sql) {
        const statement = adapter.prepare(sql);
        if (sql.startsWith('SELECT key, CAST(value AS BLOB) AS value')) {
          return {
            ...statement,
            get(...params: unknown[]) {
              payloadFetches++;
              return statement.get(...params);
            },
          };
        }
        return statement;
      },
    };

    expect(() =>
      readBoundedComposerValueByKey(
        observed,
        'cursorDiskKV',
        'composerData:bounded',
        createComposerSqliteBudget(resolveSourceReadLimits({ sqliteValueBytes: 4 }))
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'SOURCE_LIMIT_EXCEEDED',
        details: expect.objectContaining({
          bound: 'sqlite-value-bytes',
          limit: 4,
          observedAtLeast: 5,
        }),
      })
    );
    expect(payloadFetches).toBe(0);
  });

  it('uses escaped LIKE prefixes and lossless signed 64-bit row-ID keyset order', () => {
    const { raw, adapter } = database();
    const prefix = 'bubbleId:session%_:';
    const rows: Array<[number | bigint, string, string]> = [
      [-9, `${prefix}negative`, 'negative'],
      [-1, `${prefix}minus-one`, 'minus-one'],
      [1, `${prefix}positive`, 'positive'],
      [9_007_199_254_740_993n, `${prefix}bigint`, 'bigint'],
      [2, 'bubbleId:sessionXX:decoy', 'decoy'],
    ];
    const insert = raw.prepare('INSERT INTO cursorDiskKV (rowid, key, value) VALUES (?, ?, ?)');
    for (const row of rows) insert.run(...row);

    const seen: Array<{ rowId: number | bigint; value: string }> = [];
    forEachBoundedComposerValue(
      adapter,
      'cursorDiskKV',
      `${sqliteLikeLiteralPrefix(prefix)}%`,
      createComposerSqliteBudget(),
      ({ rowId, value }) => seen.push({ rowId, value })
    );

    expect(seen).toEqual([
      { rowId: -9, value: 'negative' },
      { rowId: -1, value: 'minus-one' },
      { rowId: 1, value: 'positive' },
      { rowId: 9_007_199_254_740_993n, value: 'bigint' },
    ]);
  });

  it('enforces the fixed metadata-page bound before visiting any row', () => {
    const { raw, adapter } = database();
    const insert = raw.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run('composerData:a', 'a');
    insert.run('composerData:b', 'b');
    const visited: string[] = [];

    expect(() =>
      forEachBoundedComposerValue(
        adapter,
        'cursorDiskKV',
        'composerData:%',
        createComposerSqliteBudget(
          resolveSourceReadLimits({ sqlitePageRows: 1, sqliteRowCount: 2 })
        ),
        ({ key }) => visited.push(key)
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'SOURCE_LIMIT_EXCEEDED',
        details: expect.objectContaining({
          bound: 'sqlite-page-rows',
          limit: 1,
          observedAtLeast: 2,
        }),
      })
    );
    expect(visited).toEqual([]);
  });

  it('rejects invalid UTF-8 instead of replacement-decoding Composer values', () => {
    const { raw, adapter } = database();
    raw
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('composerData:invalid-utf8', Buffer.from([0xff]));

    expect(() =>
      readBoundedComposerValueByKey(
        adapter,
        'cursorDiskKV',
        'composerData:invalid-utf8',
        createComposerSqliteBudget()
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'SOURCE_ENCODING_INVALID',
        details: expect.objectContaining({ sourceKind: 'sqlite', outcome: 'fatal' }),
      })
    );
  });
});
