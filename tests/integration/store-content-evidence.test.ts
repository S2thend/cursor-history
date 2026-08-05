import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { canonicalJsonV1 } from '../../src/core/session-identity.js';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';

function sha(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function frame(hash: string): Buffer {
  return Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(hash, 'hex')]);
}

function createStoreDb(
  path: string,
  leaves: ReadonlyArray<Readonly<Record<string, unknown>>>
): void {
  const db = new BetterSqlite3(path);
  try {
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
    const leafHashes = leaves.map((leaf) => {
      const bytes = Buffer.from(JSON.stringify(leaf));
      const hash = sha(bytes);
      insert.run(hash, bytes);
      return hash;
    });
    const root = Buffer.concat(leafHashes.map(frame));
    const rootHash = sha(root);
    insert.run(rootHash, root);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      '0',
      Buffer.from(
        JSON.stringify({
          latestRootBlobId: rootHash,
          name: 'Synthetic content evidence',
          createdAt: 1_705_276_800_000,
        })
      ).toString('hex')
    );
  } finally {
    db.close();
  }
}

describe('real Store DB content-block evidence', () => {
  it('retains and losslessly projects a wholly inline attachment without a public side channel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-history-store-inline-'));
    const dbPath = join(root, 'store.db');
    const attachment = {
      type: 'file',
      name: 'synthetic.txt',
      mediaType: 'text/plain',
      content: 'first line\n```\nlast line',
    };
    try {
      createStoreDb(dbPath, [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Visible prefix.' }, attachment],
        },
      ]);

      const parsed = await parseStoreDb(dbPath);
      expect(parsed).toMatchObject({ completeness: 'complete' });
      expect(parsed?.rawContentBlockEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            representation: 'db',
            disposition: 'projected-attachment',
            raw: attachment,
          }),
        ])
      );
      const payload = parsed?.messages[0]?.content.match(
        /```cursor_attachment_v1\n([A-Za-z0-9+/=]+)\n```/
      )?.[1];
      expect(payload).toBeDefined();
      expect(Buffer.from(payload!, 'base64').toString('utf8')).toBe(canonicalJsonV1(attachment));
      expect(parsed?.messages[0]).not.toHaveProperty('rawContentBlocks');
      expect(parsed?.messages[0]).not.toHaveProperty('attachments');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains locator-only evidence as partial and never reads the external target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-history-store-poison-'));
    const dbPath = join(root, 'store.db');
    const poisonPath = join(root, 'must-not-be-read.txt');
    const poisonPayload = 'STORE_DB_POISON_PAYLOAD_MUST_NOT_APPEAR';
    const poisonUri = pathToFileURL(poisonPath).href;
    try {
      writeFileSync(poisonPath, poisonPayload, { mode: 0o600 });
      createStoreDb(dbPath, [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Visible prefix.' },
            { type: 'file', uri: poisonUri, mediaType: 'application/x-synthetic' },
          ],
        },
      ]);
      if (process.platform !== 'win32') chmodSync(poisonPath, 0o000);

      const parsed = await parseStoreDb(dbPath);
      expect(parsed).toMatchObject({ completeness: 'partial' });
      expect(parsed?.messages.map(({ content }) => content)).toEqual(['Visible prefix.']);
      expect(parsed?.rawContentBlockEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            representation: 'db',
            disposition: 'unsupported',
            raw: expect.objectContaining({ uri: poisonUri }),
          }),
        ])
      );
      expect(JSON.stringify(parsed?.messages)).not.toContain(poisonUri);
      expect(JSON.stringify(parsed)).not.toContain(poisonPayload);
    } finally {
      if (process.platform !== 'win32') chmodSync(poisonPath, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
