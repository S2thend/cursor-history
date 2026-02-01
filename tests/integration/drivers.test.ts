/**
 * Integration tests for SQLite database drivers.
 * These tests use real SQLite databases (temp files) to verify driver adapters.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { betterSqlite3Driver } from '../../src/core/database/drivers/better-sqlite3.js';
import { nodeSqliteDriver } from '../../src/core/database/drivers/node-sqlite.js';
import type { DatabaseDriver, Database } from '../../src/core/database/types.js';

const tempFiles: string[] = [];

function tempDbPath(): string {
  const path = join(tmpdir(), `test_driver_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  tempFiles.push(path);
  return path;
}

afterEach(() => {
  for (const f of tempFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
  tempFiles.length = 0;
});

function runDriverTests(driverName: string, getDriver: () => Promise<DatabaseDriver>) {
  describe(driverName, () => {
    let driver: DatabaseDriver;

    it('isAvailable returns true', async () => {
      driver = await getDriver();
      expect(await driver.isAvailable()).toBe(true);
    });

    it('opens a read-write database and creates table', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const dbPath = tempDbPath();
      const db = driver.open(dbPath, { readonly: false });

      db.runSQL('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      db.prepare('INSERT INTO test (name) VALUES (?)').run('hello');

      const row = db.prepare('SELECT name FROM test WHERE id = 1').get() as { name: string };
      expect(row.name).toBe('hello');
      db.close();
    });

    it('prepare.all returns array of rows', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const dbPath = tempDbPath();
      const db = driver.open(dbPath, { readonly: false });

      db.runSQL('CREATE TABLE items (val TEXT)');
      db.prepare('INSERT INTO items (val) VALUES (?)').run('a');
      db.prepare('INSERT INTO items (val) VALUES (?)').run('b');
      db.prepare('INSERT INTO items (val) VALUES (?)').run('c');

      const rows = db.prepare('SELECT val FROM items ORDER BY rowid').all() as { val: string }[];
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.val)).toEqual(['a', 'b', 'c']);
      db.close();
    });

    it('prepare.run returns changes count', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const dbPath = tempDbPath();
      const db = driver.open(dbPath, { readonly: false });

      db.runSQL('CREATE TABLE counter (n INTEGER)');
      db.prepare('INSERT INTO counter (n) VALUES (?)').run(1);
      db.prepare('INSERT INTO counter (n) VALUES (?)').run(2);

      const result = db.prepare('UPDATE counter SET n = n + 10').run();
      expect(Number(result.changes)).toBe(2);
      db.close();
    });

    it('prepare.get returns undefined for no match', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const dbPath = tempDbPath();
      const db = driver.open(dbPath, { readonly: false });

      db.runSQL('CREATE TABLE empty (id INTEGER)');
      const row = db.prepare('SELECT * FROM empty WHERE id = 1').get();
      expect(row).toBeUndefined();
      db.close();
    });

    it('opens readonly database', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const dbPath = tempDbPath();

      // Create DB with data first
      const rwDb = driver.open(dbPath, { readonly: false });
      rwDb.runSQL('CREATE TABLE data (val TEXT)');
      rwDb.prepare('INSERT INTO data (val) VALUES (?)').run('test');
      rwDb.close();

      // Open readonly and verify read works
      const roDb = driver.open(dbPath, { readonly: true });
      const row = roDb.prepare('SELECT val FROM data').get() as { val: string };
      expect(row.val).toBe('test');
      roDb.close();
    });

    it('readonly database blocks write operations', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const dbPath = tempDbPath();

      // Create DB first
      const rwDb = driver.open(dbPath, { readonly: false });
      rwDb.runSQL('CREATE TABLE data (val TEXT)');
      rwDb.close();

      // Open readonly
      const roDb = driver.open(dbPath, { readonly: true });
      expect(() => {
        roDb.prepare('INSERT INTO data (val) VALUES (?)').run('fail');
      }).toThrow();
      roDb.close();
    });

    it('backup creates a copy of the database', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const srcPath = tempDbPath();
      const destPath = tempDbPath();

      // Create source DB with data
      const srcDb = driver.open(srcPath, { readonly: false });
      srcDb.runSQL('CREATE TABLE items (name TEXT)');
      srcDb.prepare('INSERT INTO items (name) VALUES (?)').run('backed up');
      srcDb.close();

      // Backup
      await driver.backup(srcPath, destPath);

      // Verify backup has the data
      const destDb = driver.open(destPath, { readonly: true });
      const row = destDb.prepare('SELECT name FROM items').get() as { name: string };
      expect(row.name).toBe('backed up');
      destDb.close();
    });
  });
}

runDriverTests('better-sqlite3', async () => betterSqlite3Driver);

// Only run node:sqlite tests if available (Node.js 22.5+)
const nodeSqliteAvailable = await nodeSqliteDriver.isAvailable();
if (nodeSqliteAvailable) {
  runDriverTests('node:sqlite', async () => nodeSqliteDriver);
} else {
  describe.skip('node:sqlite (not available on this Node version)', () => {
    it('skipped', () => {});
  });
}
