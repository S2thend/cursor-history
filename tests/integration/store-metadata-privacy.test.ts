import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SourceEncodingError } from '../../src/core/errors.js';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';
import { listSessions } from '../../src/core/storage.js';
import {
  createSessionIntegrityFixtureRoot,
  writeStoreDbAtPath,
  writeStoreMeta,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-store-metadata-privacy-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe('Store metadata privacy and canonical stability', () => {
  it('does not decode an unbound title while retaining safe metadata and unknown fields', async () => {
    const root = fixture();
    const id = '12345678-3333-4333-8333-123456789abc';
    const sessionDir = join(root.storeRoot, 'chats', 'poison-title', id);
    mkdirSync(sessionDir, { recursive: true });
    const prefix = Buffer.from(`{"cwd":${JSON.stringify(root.projectB)},"ti\\u0074le":"`, 'utf8');
    const suffix = Buffer.from(
      '","hasConversation":true,"createdAtMs":1700000000000,"updatedAtMs":1700000005000,"future":{"supportedLater":true}}',
      'utf8'
    );
    writeFileSync(
      join(sessionDir, 'meta.json'),
      Buffer.concat([prefix, Buffer.from([0xff]), suffix])
    );

    const catalog = await discoverStoreSessions(root.storeRoot, {
      metadataOnly: true,
      includeDisplayMetadata: false,
    });

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      id,
      workspacePath: root.projectB,
      title: null,
      storeDbExpectation: 'expected',
      createdAt: new Date(1_700_000_000_000),
      lastUpdatedAt: new Date(1_700_000_005_000),
    });
    expect(catalog[0]).not.toHaveProperty('diagnostics');

    await expect(discoverStoreSessions(root.storeRoot)).rejects.toBeInstanceOf(SourceEncodingError);
  });

  it('keeps canonical Store path and timestamps stable when scope selects another replica', async () => {
    const root = fixture();
    const id = 'abcdefab-3333-4333-8333-abcdefabcdef';
    const occurrenceA = join(root.storeRoot, 'chats', 'canonical-a', id);
    const occurrenceB = join(root.storeRoot, 'chats', 'scoped-b', id);

    writeStoreDbAtPath(
      join(occurrenceA, 'store.db'),
      id,
      [{ role: 'user', content: 'equivalent payload' }],
      'Equivalent DB metadata'
    );
    writeStoreDbAtPath(
      join(occurrenceB, 'store.db'),
      id,
      [{ role: 'user', content: 'equivalent payload' }],
      'Equivalent DB metadata'
    );
    writeStoreMeta(occurrenceA, {
      cwd: root.projectA,
      title: 'Canonical title A',
      hasConversation: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_005_000,
    });
    writeStoreMeta(occurrenceB, {
      cwd: root.projectB,
      title: 'Scoped title B',
      hasConversation: true,
      createdAtMs: 1_600_000_000_000,
      updatedAtMs: 1_600_000_005_000,
    });

    const unfiltered = await listSessions({ all: true, limit: 0 }, root.workspaceStorage);
    const scoped = await listSessions(
      { all: true, limit: 0, workspacePath: root.projectB },
      root.workspaceStorage
    );

    expect(unfiltered).toHaveLength(1);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      id,
      title: 'Scoped title B',
      matchedWorkspacePath: root.projectB,
    });
    expect({
      workspacePath: scoped[0]?.workspacePath,
      canonicalWorkspacePath: scoped[0]?.canonicalWorkspacePath,
      createdAt: scoped[0]?.createdAt,
      createdAtSource: scoped[0]?.createdAtSource,
      lastUpdatedAt: scoped[0]?.lastUpdatedAt,
      lastUpdatedAtSource: scoped[0]?.lastUpdatedAtSource,
    }).toEqual({
      workspacePath: unfiltered[0]?.workspacePath,
      canonicalWorkspacePath: unfiltered[0]?.canonicalWorkspacePath,
      createdAt: unfiltered[0]?.createdAt,
      createdAtSource: unfiltered[0]?.createdAtSource,
      lastUpdatedAt: unfiltered[0]?.lastUpdatedAt,
      lastUpdatedAtSource: unfiltered[0]?.lastUpdatedAtSource,
    });
    expect(unfiltered[0]?.workspacePath).toBe(root.projectA);
    expect(unfiltered[0]?.createdAt).toEqual(new Date(1_700_000_000_000));
    expect(unfiltered[0]?.lastUpdatedAt).toEqual(new Date(1_700_000_005_000));
  });
});
