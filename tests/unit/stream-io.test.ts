import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  computeFileChecksum,
  computeZipEntryChecksum,
  createByteCounter,
  createGzipFileStream,
  extractZipEntryToFile,
  readFileBuffer,
  writeZipToFile,
} from '../../src/core/stream-io.js';
import { computeChecksum } from '../../src/core/backup.js';

describe('stream-io', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cursor-history-stream-io-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(name: string, content: Buffer | string): string {
    const filePath = join(dir, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  it('computes the same checksum as the buffer based helper', async () => {
    const content = Buffer.from('a'.repeat(100_000));
    const filePath = writeFixture('data.bin', content);

    await expect(computeFileChecksum(filePath)).resolves.toBe(computeChecksum(content));
  });

  it('reads a file into a buffer', async () => {
    const filePath = writeFixture('data.txt', 'hello');

    await expect(readFileBuffer(filePath)).resolves.toEqual(Buffer.from('hello'));
  });

  it('round trips a file through a gzipped, streamed zip archive', async () => {
    const content = Buffer.from(JSON.stringify({ rows: 'x'.repeat(200_000) }));
    const filePath = writeFixture('state.vscdb', content);
    const checksum = await computeFileChecksum(filePath);

    const zip = new JSZip();
    const counter = createByteCounter();
    zip.file('globalStorage/state.vscdb.gz', createGzipFileStream(filePath).pipe(counter), {
      compression: 'STORE',
    });

    const zipPath = join(dir, 'backup.zip');
    await writeZipToFile(zip, zipPath);

    // gzip must actually shrink the stored member
    expect(counter.bytes).toBeGreaterThan(0);
    expect(counter.bytes).toBeLessThan(content.length);
    expect(statSync(zipPath).size).toBeGreaterThan(0);

    const loaded = await JSZip.loadAsync(await readFileBuffer(zipPath));
    const entry = loaded.file('globalStorage/state.vscdb.gz');
    expect(entry).not.toBeNull();

    // Checksum of the *original* content, verified through zip + gunzip
    await expect(computeZipEntryChecksum(entry!, { gunzip: true })).resolves.toBe(checksum);

    const restored = join(dir, 'restored.vscdb');
    await extractZipEntryToFile(entry!, restored, { gunzip: true });
    expect(readFileSync(restored)).toEqual(content);
  });

  it('round trips uncompressed entries (backups created by older versions)', async () => {
    const content = Buffer.from('legacy entry');
    const zip = new JSZip();
    zip.file('globalStorage/state.vscdb', content);

    const zipPath = join(dir, 'legacy.zip');
    await writeZipToFile(zip, zipPath);

    const loaded = await JSZip.loadAsync(await readFileBuffer(zipPath));
    const entry = loaded.file('globalStorage/state.vscdb');
    expect(entry).not.toBeNull();

    await expect(computeZipEntryChecksum(entry!)).resolves.toBe(computeChecksum(content));

    const restored = join(dir, 'legacy.vscdb');
    await extractZipEntryToFile(entry!, restored);
    expect(readFileSync(restored)).toEqual(content);
  });

  it('propagates read errors instead of writing a truncated archive', async () => {
    const zip = new JSZip();
    zip.file('missing.gz', createGzipFileStream(join(dir, 'does-not-exist')), {
      compression: 'STORE',
    });

    await expect(writeZipToFile(zip, join(dir, 'broken.zip'))).rejects.toThrow();
  });
});
