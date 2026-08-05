import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMocks.readdirSync.mockImplementation((...args: unknown[]) =>
    Reflect.apply(actual.readdirSync, actual, args)
  );
  fsMocks.readFileSync.mockImplementation((...args: unknown[]) =>
    Reflect.apply(actual.readFileSync, actual, args)
  );
  return {
    ...actual,
    readdirSync: fsMocks.readdirSync,
    readFileSync: fsMocks.readFileSync,
  };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'ch-store-infrastructure-'));
  roots.push(value);
  return value;
}

function infrastructureError(code: 'EACCES' | 'EIO'): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated Store ${code}`), { code });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  fsMocks.readdirSync.mockClear();
  fsMocks.readFileSync.mockClear();
});

describe('Store discovery infrastructure failures', () => {
  it.each(['EACCES', 'EIO'] as const)('propagates %s from directory inventory', async (code) => {
    const base = root();
    mkdirSync(join(base, 'chats'), { recursive: true });
    fsMocks.readdirSync.mockImplementationOnce(() => {
      throw infrastructureError(code);
    });

    await expect(discoverStoreSessions(base)).rejects.toMatchObject({ code });
  });

  it.each(['EACCES', 'EIO'] as const)(
    'propagates %s while reading Store metadata',
    async (code) => {
      const base = root();
      const sessionDir = join(base, 'chats', 'hash', 'session-id');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'meta.json'), '{}');
      fsMocks.readFileSync.mockImplementationOnce(() => {
        throw infrastructureError(code);
      });

      await expect(discoverStoreSessions(base)).rejects.toMatchObject({ code });
    }
  );
});
