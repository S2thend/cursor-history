import { describe, expect, it } from 'vitest';
import { betterSqlite3Driver } from '../../src/core/database/drivers/better-sqlite3.js';
import { nodeSqliteDriver } from '../../src/core/database/drivers/node-sqlite.js';
import {
  createComposerSqliteBudget,
  forEachBoundedComposerBubbleValueByExactPrefix,
  readFirstBoundedComposerBubbleValueByExactPrefix,
  readLastBoundedComposerBubbleValueByExactPrefix,
  type ComposerSqliteBubbleValue,
} from '../../src/core/composer-sqlite.js';
import { resolveSourceReadLimits } from '../../src/core/source-read-limits.js';

// Frozen released SQL, independent of the production predicate and escaping.
const RELEASED_PREFIX =
  'key IS NOT NULL AND substr(CAST(key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB)';
const edgeIds = [
  'ABC',
  'abc',
  'a*b',
  'a?b',
  '[abc]',
  'a[b',
  'a]b',
  '[*?]',
  'a%_b',
  'a\\b',
  '中文😀',
  'é',
  'e\u0301',
  'a\0b',
  'a\0other',
  ' future-id ',
  'x:part',
  '',
];

// Deterministic property corpus: valid future IDs need not look like UUIDs.
let seed = 41;
const alphabet = ['a', 'A', '*', '?', '[', ']', '%', '_', '\\', 'é', '中', '😀', '\0'];
const generated = Array.from({ length: 64 }, (_, index) => {
  let id = `future-${index}-`;
  for (let n = 0; n < 6; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    id += alphabet[seed % alphabet.length];
  }
  return id;
});
const drivers = [];
for (const driver of [betterSqlite3Driver, nodeSqliteDriver]) {
  // Node 20 has no node:sqlite; it still runs the same contract with better-sqlite3.
  if (await driver.isAvailable()) drivers.push(driver);
}

for (const driver of drivers) {
  describe(`released exact-prefix contract / ${driver.name}`, () => {
    for (const collation of ['BINARY', 'NOCASE']) {
      it(`matches released rows, payloads and physical order with ${collation} collation`, () => {
        const db = driver.open(':memory:', { readonly: false });
        try {
          db.runSQL(`CREATE TABLE cursorDiskKV (key TEXT COLLATE ${collation}, value BLOB)`);
          db.runSQL('CREATE INDEX key_index ON cursorDiskKV(key)');
          const insert = db.prepare('INSERT INTO cursorDiskKV(rowid, key, value) VALUES (?, ?, ?)');
          let rowId = -40n;
          const ids = [...edgeIds, ...generated];
          for (const [index, id] of ids.entries()) {
            // Reverse lexical suffix order and interleave SQL NULL with unknown future fields.
            for (const suffix of ['z', 'a', 'm']) {
              insert.run(
                rowId++,
                `bubbleId:${id}:${suffix}`,
                suffix === 'a'
                  ? null
                  : JSON.stringify({
                      text: `${index}:${suffix}`,
                      futureField: { nested: [true, null, 'unchanged'] },
                    })
              );
            }
          }
          insert.run(9007199254740993n, 'bubbleId:ABC:big-rowid', 'large');
          insert.run(rowId++, null, 'null key');
          insert.run(rowId++, 'bubbleId:ABC-extra:decoy', 'unrelated session');
          const oracle =
            db.prepare(`SELECT CAST(rowid AS TEXT) AS rowId, key, CAST(value AS BLOB) AS value
            FROM cursorDiskKV WHERE ${RELEASED_PREFIX} ORDER BY cursorDiskKV.rowid ASC`);
          const project = (row: ComposerSqliteBubbleValue | undefined) =>
            row && {
              rowId: String(row.rowId),
              key: row.key,
              value: row.value,
            };
          for (const prefix of [...ids.map((id) => `bubbleId:${id}:`), 'bubbleId:missing:', '']) {
            const expected = (
              oracle.all(prefix, prefix) as Array<{
                rowId: string;
                key: string;
                value: Uint8Array | null;
              }>
            ).map((row) => ({
              ...row,
              value: row.value === null ? null : Buffer.from(row.value).toString('utf8'),
            }));
            for (const pageRows of [1, 2, 7]) {
              const budget = createComposerSqliteBudget(
                resolveSourceReadLimits({ sqlitePageRows: pageRows })
              );
              const seen: unknown[] = [];
              forEachBoundedComposerBubbleValueByExactPrefix(db, prefix, budget, (row) =>
                seen.push(project(row))
              );
              expect(seen, JSON.stringify({ prefix, pageRows })).toEqual(expected);
              expect(budget.rowCount).toBe(expected.length);
            }
            expect(
              project(
                readFirstBoundedComposerBubbleValueByExactPrefix(
                  db,
                  prefix,
                  createComposerSqliteBudget()
                )
              )
            ).toEqual(expected[0]);
            expect(
              project(
                readLastBoundedComposerBubbleValueByExactPrefix(
                  db,
                  prefix,
                  createComposerSqliteBudget()
                )
              )
            ).toEqual(expected.at(-1));
          }
        } finally {
          db.close();
        }
      });
    }

    it('retains row limits and cancellation for the NUL fallback', () => {
      const db = driver.open(':memory:', { readonly: false });
      try {
        db.runSQL('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
        const insert = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
        for (let i = 0; i < 3; i++) insert.run(`bubbleId:a\0b:${i}`, null);
        const seen: unknown[] = [];
        expect(() =>
          forEachBoundedComposerBubbleValueByExactPrefix(
            db,
            'bubbleId:a\0b:',
            createComposerSqliteBudget(
              resolveSourceReadLimits({ sqlitePageRows: 1, sqliteRowCount: 2 })
            ),
            (row) => seen.push(row)
          )
        ).toThrowError(expect.objectContaining({ code: 'SOURCE_LIMIT_EXCEEDED' }));
        expect(seen).toHaveLength(2);
        const controller = new AbortController();
        controller.abort();
        expect(() =>
          readFirstBoundedComposerBubbleValueByExactPrefix(
            db,
            'bubbleId:a\0b:',
            createComposerSqliteBudget(),
            controller.signal
          )
        ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
      } finally {
        db.close();
      }
    });
  });
}
