import BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listGlobalSessions } from '../../src/core/storage.js';
import { createSessionIntegrityFixtureRoot } from '../helpers/session-integrity-fixtures.js';

describe('Composer catalog timestamp compatibility', () => {
  it.each([
    [undefined, '2025-10-15T10:00:00Z', undefined],
    [
      '2025-10-15T10:00:00Z',
      '2025-10-14T10:00:00Z',
      '2025-10-16T10:00:00Z',
      '2025-10-15T11:00:00Z',
    ],
  ])('uses every valid direct time, independent of physical endpoints (%j)', async (...times) => {
    const fixture = createSessionIntegrityFixtureRoot('cursor-history-time-regression-');
    try {
      const db = new BetterSqlite3(join(fixture.globalStorage, 'state.vscdb'));
      try {
        db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
        const insert = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
        insert.run(
          'composerData:future-id',
          JSON.stringify({ name: 'Timestamp regression', future: true })
        );
        times.forEach((createdAt, index) =>
          insert.run(
            `bubbleId:future-id:${index}`,
            JSON.stringify({
              type: index % 2 ? 2 : 1,
              text: 'synthetic',
              ...(createdAt ? { createdAt } : {}),
              future: { x: 1 },
            })
          )
        );
      } finally {
        db.close();
      }
      const [summary] = await listGlobalSessions(fixture.workspaceStorage);
      const valid = times
        .filter((time): time is string => time !== undefined)
        .map((time) => Date.parse(time));
      expect(summary).toMatchObject({
        id: 'future-id',
        createdAt: new Date(Math.min(...valid)),
        lastUpdatedAt: new Date(Math.max(...valid)),
        createdAtSource: 'direct-message',
        lastUpdatedAtSource: 'direct-message',
      });
    } finally {
      fixture.cleanup();
    }
  });
});
