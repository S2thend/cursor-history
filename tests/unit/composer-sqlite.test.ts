import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createComposerSqliteBudget,
  forEachBoundedComposerBubbleValue,
  forEachBoundedComposerValue,
  readBoundedComposerValueByKey,
  readFirstBoundedComposerBubbleValue,
  readFirstBoundedComposerValue,
  sqliteLikeLiteralPrefix,
} from '../../src/core/composer-sqlite.js';
import type { Database } from '../../src/core/database/types.js';
import { resolveSourceReadLimits } from '../../src/core/source-read-limits.js';

const databases: BetterSqlite3.Database[] = [];

function database(options: { nullableValue?: boolean } = {}): {
  raw: BetterSqlite3.Database;
  adapter: Database;
} {
  const raw = new BetterSqlite3(':memory:');
  raw.exec(
    `CREATE TABLE cursorDiskKV (key TEXT NOT NULL, value BLOB${options.nullableValue ? '' : ' NOT NULL'})`
  );
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

  it('ignores pre-existing NULL payloads when reading an exact key', () => {
    const { raw, adapter } = database({ nullableValue: true });
    const insert = raw.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run('composerData:nullable', null);

    expect(
      readBoundedComposerValueByKey(
        adapter,
        'cursorDiskKV',
        'composerData:nullable',
        createComposerSqliteBudget()
      )
    ).toBeUndefined();

    insert.run('composerData:nullable', 'admitted');

    expect(
      readBoundedComposerValueByKey(
        adapter,
        'cursorDiskKV',
        'composerData:nullable',
        createComposerSqliteBudget()
      )
    ).toBe('admitted');
  });

  it('ignores pre-existing NULL payloads while iterating a key pattern', () => {
    const { raw, adapter } = database({ nullableValue: true });
    const insert = raw.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run('composerData:null-a', null);
    insert.run('composerData:value-a', 'first');
    insert.run('composerData:null-b', null);
    insert.run('composerData:value-b', 'second');
    const seen: Array<{ key: string; value: string }> = [];

    forEachBoundedComposerValue(
      adapter,
      'cursorDiskKV',
      'composerData:%',
      createComposerSqliteBudget(),
      ({ key, value }) => seen.push({ key, value })
    );

    expect(seen).toEqual([
      { key: 'composerData:value-a', value: 'first' },
      { key: 'composerData:value-b', value: 'second' },
    ]);
  });

  it('selects the first non-NULL payload for a key pattern', () => {
    const { raw, adapter } = database({ nullableValue: true });
    const insert = raw.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run('composerData:null-first', null);
    insert.run('composerData:first-value', 'first');
    insert.run('composerData:second-value', 'second');

    expect(
      readFirstBoundedComposerValue(
        adapter,
        'cursorDiskKV',
        'composerData:%',
        createComposerSqliteBudget()
      )
    ).toEqual(
      expect.objectContaining({ key: 'composerData:first-value', rowId: 2, value: 'first' })
    );
  });

  it('rejects an admitted payload that mutates to NULL before its value fetch', () => {
    const { raw, adapter } = database({ nullableValue: true });
    raw
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('composerData:mutable', 'admitted');
    let mutated = false;
    const observed: Database = {
      ...adapter,
      prepare(sql) {
        const statement = adapter.prepare(sql);
        if (sql.startsWith('SELECT key, CAST(value AS BLOB) AS value')) {
          return {
            ...statement,
            get(...params: unknown[]) {
              if (!mutated) {
                raw
                  .prepare('UPDATE cursorDiskKV SET value = NULL WHERE key = ?')
                  .run('composerData:mutable');
                mutated = true;
              }
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
        'composerData:mutable',
        createComposerSqliteBudget()
      )
    ).toThrowError('Composer SQLite payload changed after metadata admission.');
    expect(mutated).toBe(true);
  });

  it('rejects an iterated payload that mutates to NULL after metadata admission', () => {
    const { raw, adapter } = database({ nullableValue: true });
    raw
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('composerData:mutable-pattern', 'admitted');
    let mutated = false;
    const observed: Database = {
      ...adapter,
      prepare(sql) {
        const statement = adapter.prepare(sql);
        if (sql.includes('length(CAST(value AS BLOB))') && sql.includes('WHERE key LIKE ?')) {
          return {
            ...statement,
            all(...params: unknown[]) {
              const rows = statement.all(...params);
              raw
                .prepare('UPDATE cursorDiskKV SET value = NULL WHERE key = ?')
                .run('composerData:mutable-pattern');
              mutated = true;
              return rows;
            },
          };
        }
        return statement;
      },
    };

    expect(() =>
      forEachBoundedComposerValue(
        observed,
        'cursorDiskKV',
        'composerData:%',
        createComposerSqliteBudget(),
        () => undefined
      )
    ).toThrowError('Composer SQLite payload changed after metadata admission.');
    expect(mutated).toBe(true);
  });

  it('rejects a first-row payload that mutates to NULL after metadata admission', () => {
    const { raw, adapter } = database({ nullableValue: true });
    raw
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      .run('composerData:mutable-first', 'admitted');
    let mutated = false;
    const observed: Database = {
      ...adapter,
      prepare(sql) {
        const statement = adapter.prepare(sql);
        if (sql.includes('length(CAST(value AS BLOB))') && sql.includes('LIMIT 1')) {
          return {
            ...statement,
            get(...params: unknown[]) {
              const row = statement.get(...params);
              raw
                .prepare('UPDATE cursorDiskKV SET value = NULL WHERE key = ?')
                .run('composerData:mutable-first');
              mutated = true;
              return row;
            },
          };
        }
        return statement;
      },
    };

    expect(() =>
      readFirstBoundedComposerValue(
        observed,
        'cursorDiskKV',
        'composerData:%',
        createComposerSqliteBudget()
      )
    ).toThrowError('Composer SQLite payload changed after metadata admission.');
    expect(mutated).toBe(true);
  });

  it('preserves interleaved NULL bubbles in signed row-ID order and charges their rows', () => {
    const { raw, adapter } = database({ nullableValue: true });
    const insert = raw.prepare('INSERT INTO cursorDiskKV (rowid, key, value) VALUES (?, ?, ?)');
    insert.run(-4, 'bubbleId:nullable:null-first', null);
    insert.run(-1, 'bubbleId:nullable:text-a', 'a');
    insert.run(2, 'bubbleId:nullable:null-middle', null);
    insert.run(9_007_199_254_740_993n, 'bubbleId:nullable:text-b', 'é');
    const budget = createComposerSqliteBudget();
    const seen: Array<{ rowId: number | bigint; value: string | null }> = [];

    forEachBoundedComposerBubbleValue(adapter, 'bubbleId:nullable:%', budget, ({ rowId, value }) =>
      seen.push({ rowId, value })
    );

    expect(seen).toEqual([
      { rowId: -4, value: null },
      { rowId: -1, value: 'a' },
      { rowId: 2, value: null },
      { rowId: 9_007_199_254_740_993n, value: 'é' },
    ]);
    expect(budget.rowCount).toBe(4);
    expect(budget.decodedBytes).toBe(3);
  });

  it('counts NULL bubbles against SQLite page and aggregate row limits before visiting', () => {
    const { raw, adapter } = database({ nullableValue: true });
    const insert = raw.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, NULL)');
    insert.run('bubbleId:nullable:a');
    insert.run('bubbleId:nullable:b');
    insert.run('bubbleId:nullable:c');
    const visited: Array<string | null> = [];

    expect(() =>
      forEachBoundedComposerBubbleValue(
        adapter,
        'bubbleId:nullable:%',
        createComposerSqliteBudget(
          resolveSourceReadLimits({ sqlitePageRows: 2, sqliteRowCount: 2 })
        ),
        ({ value }) => visited.push(value)
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'SOURCE_LIMIT_EXCEEDED',
        details: expect.objectContaining({
          bound: 'sqlite-page-rows',
          limit: 2,
          observedAtLeast: 3,
        }),
      })
    );
    expect(visited).toEqual([]);
  });

  it('returns a NULL first bubble instead of skipping to a later value', () => {
    const { raw, adapter } = database({ nullableValue: true });
    const insert = raw.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    insert.run('bubbleId:nullable:first', null);
    insert.run('bubbleId:nullable:second', 'second');

    expect(
      readFirstBoundedComposerBubbleValue(
        adapter,
        'bubbleId:nullable:%',
        createComposerSqliteBudget()
      )
    ).toEqual(expect.objectContaining({ rowId: 1, value: null, valueIsNull: true }));
  });

  it('rejects a NULL bubble that mutates to text after metadata admission', () => {
    const { raw, adapter } = database({ nullableValue: true });
    raw
      .prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, NULL)')
      .run('bubbleId:nullable:mutable');
    let mutated = false;
    const observed: Database = {
      ...adapter,
      prepare(sql) {
        const statement = adapter.prepare(sql);
        if (sql.includes('value IS NULL AS valueIsNull') && sql.includes('WHERE key LIKE ?')) {
          return {
            ...statement,
            all(...params: unknown[]) {
              const rows = statement.all(...params);
              raw
                .prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?')
                .run('now-text', 'bubbleId:nullable:mutable');
              mutated = true;
              return rows;
            },
          };
        }
        return statement;
      },
    };

    expect(() =>
      forEachBoundedComposerBubbleValue(
        observed,
        'bubbleId:nullable:%',
        createComposerSqliteBudget(),
        () => undefined
      )
    ).toThrowError('Composer SQLite payload changed after metadata admission.');
    expect(mutated).toBe(true);
  });
});
