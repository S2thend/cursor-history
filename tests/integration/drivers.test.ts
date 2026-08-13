/**
 * Integration tests for SQLite database drivers.
 * These tests use real SQLite databases (temp files) to verify driver adapters.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { betterSqlite3Driver } from '../../src/core/database/drivers/better-sqlite3.js';
import { nodeSqliteDriver } from '../../src/core/database/drivers/node-sqlite.js';
import type { DatabaseDriver } from '../../src/core/database/types.js';
import type { DriverName } from '../../src/core/database/types.js';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';

const tempFiles: string[] = [];

function tempDbPath(): string {
  const path = join(
    tmpdir(),
    `test_driver_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
  );
  tempFiles.push(path);
  return path;
}

afterEach(() => {
  for (const f of tempFiles) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
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

    it('reports the read and read-write APIs exercised by cursor-history', async () => {
      driver = await getDriver();
      const profile = await driver.getCapabilityProfile();

      expect(profile.driver).toBe(driverName);
      expect(profile.available).toBe(true);
      expect(profile.capabilities.has('read')).toBe(true);
      expect(profile.capabilities.has('readWrite')).toBe(true);
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

    it('readonly open never creates a missing database', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const dbPath = tempDbPath();

      expect(existsSync(dbPath)).toBe(false);
      expect(() => driver.open(dbPath, { readonly: true })).toThrow();
      expect(existsSync(dbPath)).toBe(false);
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

    it('backup behavior matches the advertised onlineBackup capability', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const profile = await driver.getCapabilityProfile();
      const srcPath = tempDbPath();
      const destPath = tempDbPath();

      if (!profile.capabilities.has('onlineBackup')) {
        await expect(driver.backup(srcPath, destPath)).rejects.toMatchObject({
          code: 'DATABASE_CAPABILITY_MISSING',
          details: { driver: driverName, missingCapabilities: ['onlineBackup'] },
        });
        return;
      }

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

    it('either resolves a real Store snapshot or fails explicitly at the capability boundary', async () => {
      driver = await getDriver();
      await driver.isAvailable();
      const profile = await driver.getCapabilityProfile();
      const storePath = tempDbPath();

      const leaf = Buffer.from(JSON.stringify({ role: 'user', content: 'real driver store turn' }));
      const leafHash = createHash('sha256').update(leaf).digest('hex');
      const root = Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(leafHash, 'hex')]);
      const rootHash = createHash('sha256').update(root).digest('hex');
      const db = driver.open(storePath, { readonly: false });
      db.runSQL('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
      db.runSQL('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(leafHash, leaf);
      db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(rootHash, root);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        '0',
        Buffer.from(
          JSON.stringify({ latestRootBlobId: rootHash, name: 'Real driver Store fixture' })
        ).toString('hex')
      );
      db.close();

      const read = parseStoreDb(storePath, { sqliteDriver: driverName as DriverName });
      if (!profile.capabilities.has('onlineBackup')) {
        await expect(read).rejects.toMatchObject({
          code: 'DATABASE_CAPABILITY_MISSING',
          details: {
            driver: driverName,
            operation: 'store-snapshot',
            missingCapabilities: ['onlineBackup'],
          },
        });
        return;
      }

      await expect(read).resolves.toMatchObject({
        title: 'Real driver Store fixture',
        completeness: 'complete',
        messages: [{ content: 'real driver store turn' }],
      });
    });
  });
}

// Only run better-sqlite3 tests if available (native bindings may not work)
const betterSqlite3Available = await betterSqlite3Driver.isAvailable();
if (betterSqlite3Available) {
  runDriverTests('better-sqlite3', async () => betterSqlite3Driver);
} else {
  describe('better-sqlite3 unavailable runtime profile', () => {
    it('executes the capability assertion instead of hiding it behind a skip', async () => {
      const profile = await betterSqlite3Driver.getCapabilityProfile();
      expect(profile).toMatchObject({
        driver: 'better-sqlite3',
        available: false,
        capabilities: new Set(),
      });
      expect(profile.unavailableReason).toEqual(expect.any(String));
    });
  });
}

// Only run node:sqlite tests if available (Node.js 22.5+)
const nodeSqliteAvailable = await nodeSqliteDriver.isAvailable();
if (nodeSqliteAvailable) {
  runDriverTests('node:sqlite', async () => nodeSqliteDriver);
} else {
  describe('node:sqlite unavailable runtime profile', () => {
    it('executes the capability assertion instead of hiding it behind a skip', async () => {
      const profile = await nodeSqliteDriver.getCapabilityProfile();
      expect(profile).toMatchObject({
        driver: 'node:sqlite',
        available: false,
        capabilities: new Set(),
      });
      expect(profile.unavailableReason).toEqual(expect.any(String));
    });
  });
}
