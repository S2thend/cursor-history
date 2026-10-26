import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWriteStream,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
  linkSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StagedOutputs } from '../../src/core/staged-output.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: vi.fn(actual.createWriteStream),
    renameSync: vi.fn(actual.renameSync),
    linkSync: vi.fn(actual.linkSync),
  };
});
let root: string;
let train: string;
let valid: string;
let outputs: StagedOutputs | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'training-stages-'));
  train = join(root, 'train.jsonl');
  valid = join(root, 'valid.jsonl');
});
afterEach(async () => {
  vi.mocked(createWriteStream).mockClear();
  vi.mocked(renameSync).mockReset();
  vi.mocked(linkSync).mockReset();
  await outputs?.dispose();
  outputs = undefined;
  rmSync(root, { recursive: true, force: true });
});
const names = () => readdirSync(root).sort();

describe('staged output publication on real files', () => {
  it('keeps existing bytes until every stream finishes, including empty splits', async () => {
    writeFileSync(train, 'old train');
    writeFileSync(valid, 'old valid');
    outputs = await StagedOutputs.create([train, valid], true);
    await outputs.write(train, 'new data\n');
    expect(readFileSync(train, 'utf8')).toBe('old train');
    expect(readFileSync(valid, 'utf8')).toBe('old valid');
    await outputs.commit();
    await outputs.dispose();
    expect(readFileSync(train, 'utf8')).toBe('new data\n');
    expect(readFileSync(valid, 'utf8')).toBe('');
    expect(names()).toEqual(['train.jsonl', 'valid.jsonl']);
    if (process.platform !== 'win32') expect(statSync(train).mode & 0o777).toBe(0o600);
  });

  it('discards an unfinished export without changing prior files', async () => {
    writeFileSync(train, 'old');
    outputs = await StagedOutputs.create([train, valid], true);
    await outputs.write(train, 'partial new data');
    await outputs.dispose();
    expect(readFileSync(train, 'utf8')).toBe('old');
    expect(names()).toEqual(['train.jsonl']);
  });

  it('preserves old data when a real output stream fails after staging starts', async () => {
    writeFileSync(train, 'old');
    outputs = await StagedOutputs.create([train], true);
    await outputs.write(train, 'partial staged data');
    const stream = vi.mocked(createWriteStream).mock.results.at(-1)!.value;
    stream.destroy(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(outputs.commit()).rejects.toThrow('disk full');
    await outputs.dispose();
    expect(readFileSync(train, 'utf8')).toBe('old');
    expect(names()).toEqual(['train.jsonl']);
  });

  it('does not clobber files that appeared while streaming without force', async () => {
    outputs = await StagedOutputs.create([train]);
    await outputs.write(train, 'new');
    writeFileSync(train, 'another writer');
    await expect(outputs.commit()).rejects.toThrow('already exists');
    await outputs.dispose();
    expect(readFileSync(train, 'utf8')).toBe('another writer');
    expect(names()).toEqual(['train.jsonl']);
  });

  it('rolls back the first replacement if the second rename fails', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    writeFileSync(train, 'old train');
    writeFileSync(valid, 'old valid');
    outputs = await StagedOutputs.create([train, valid], true);
    await outputs.write(train, 'new');
    await outputs.write(valid, 'new');
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === valid) throw new Error('injected publication failure');
      original.renameSync(from, to);
    });
    await expect(outputs.commit()).rejects.toThrow('injected publication failure');
    await outputs.dispose();
    expect(readFileSync(train, 'utf8')).toBe('old train');
    expect(readFileSync(valid, 'utf8')).toBe('old valid');
    expect(names()).toEqual(['train.jsonl', 'valid.jsonl']);
  });

  it('rolls back new files when a later no-clobber publication fails', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    outputs = await StagedOutputs.create([train, valid]);
    await outputs.write(train, 'new');
    vi.mocked(linkSync).mockImplementation((from, to) => {
      if (to === valid) {
        writeFileSync(valid, 'racing writer');
        throw new Error('injected conflict');
      }
      original.linkSync(from, to);
    });
    await expect(outputs.commit()).rejects.toThrow('injected conflict');
    await outputs.dispose();
    expect(names()).toEqual(['valid.jsonl']);
    expect(readFileSync(valid, 'utf8')).toBe('racing writer');
  });

  it('retains a recovery copy when rollback itself fails', async () => {
    const original = await vi.importActual<typeof import('node:fs')>('node:fs');
    writeFileSync(train, 'old train');
    writeFileSync(valid, 'old valid');
    outputs = await StagedOutputs.create([train, valid], true);
    await outputs.write(train, 'new');
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === valid || String(from).endsWith('previous'))
        throw new Error('injected filesystem failure');
      original.renameSync(from, to);
    });
    await expect(outputs.commit()).rejects.toThrow('Recovery files retained');
    await outputs.dispose();
    const recovery = names().filter((name) => name.startsWith('.cursor-history-export-'));
    expect(recovery).toHaveLength(1);
    expect(readFileSync(join(root, recovery[0]!, 'previous'), 'utf8')).toBe('old train');
  });

  it('detects output aliases and creates no staging files', async () => {
    await expect(StagedOutputs.create([train, join(root, '.', 'train.jsonl')])).rejects.toThrow(
      'distinct'
    );
    expect(names()).toEqual([]);
  });

  it('does not follow an existing symlink output even with force', async () => {
    writeFileSync(train, 'original');
    // Directory junctions also exercise non-regular targets on Windows without symlink privileges.
    if (process.platform === 'win32') mkdirSync(valid);
    else symlinkSync(train, valid);
    await expect(StagedOutputs.create([valid], true)).rejects.toThrow('regular file');
    expect(readFileSync(train, 'utf8')).toBe('original');
  });
});
