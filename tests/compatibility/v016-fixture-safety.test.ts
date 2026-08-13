import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  generateV016Fixtures,
  inspectV016FixtureSet,
  scanLogicalPayloadInventory,
  scanSyntheticFixtureBytes,
  V016_ALLOWED_PAYLOAD_STRINGS,
  V016_FIXTURE_SCHEMA,
  V016_SYNTHETIC_SESSION_ID,
  type V016FixtureLogicalInventory,
  type V016FixtureManifest,
} from './support/generate-v016-fixtures.js';
import {
  projectV016GlobalSession,
  projectV016WorkspaceSessions,
} from './support/v016-projector.js';
import { projectV016DownstreamContract } from '../helpers/v016-downstream-contract.js';
import type { Session } from '../../src/lib/types.js';
import {
  exportSessionToJson as exportLibrarySessionToJson,
  listSessions as listLibrarySessions,
  searchSessions as searchLibrarySessions,
} from '../../src/lib/index.js';

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'compatibility', 'fixtures', 'v016');
const GENERATOR_PATH = join(
  process.cwd(),
  'tests',
  'compatibility',
  'support',
  'generate-v016-fixtures.ts'
);
const GENERATED_ARTIFACTS = [
  'composer-global-state.vscdb',
  'workspace-fallback.json',
  'tagged-output.json',
  'merged-store-source.json',
  'fixture-manifest.json',
] as const;

function readManifest(root = FIXTURE_ROOT): V016FixtureManifest {
  return JSON.parse(
    readFileSync(join(root, 'fixture-manifest.json'), 'utf8')
  ) as V016FixtureManifest;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function taggedCursorSession(): Session {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'tagged-output.json'), 'utf8')) as {
    globalSession: {
      id: string;
      createdAt: string;
      lastUpdatedAt: string;
      source: 'global';
      messages: Array<{
        id: string | null;
        role: 'user' | 'assistant';
        content: string;
        timestamp: string;
        toolCalls?: Array<{
          name: string;
          status: 'completed' | 'cancelled' | 'error';
          params?: Record<string, unknown>;
          result?: string;
          error?: string;
        }>;
      }>;
      activeBranchBubbleIds: string[];
    };
  };
  const session = fixture.globalSession;
  return {
    id: session.id,
    workspace: '/fixture/v016/project',
    timestamp: session.createdAt,
    source: session.source,
    messageCount: session.messages.length,
    messages: session.messages.map((message) => ({
      ...(message.id === null ? {} : { id: message.id }),
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    })),
    activeBranchBubbleIds: session.activeBranchBubbleIds,
    metadata: { lastModified: session.lastUpdatedAt },
  };
}

function taggedWorkspaceFallbackSession(): Session {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'tagged-output.json'), 'utf8')) as {
    workspaceFallbackSessions: Array<{
      id: string;
      createdAt: string;
      lastUpdatedAt: string;
      source: 'workspace-fallback';
      messages: Array<{
        id: string | null;
        role: 'user' | 'assistant';
        content: string;
        timestamp: string;
      }>;
    }>;
  };
  const session = fixture.workspaceFallbackSessions[0]!;
  return {
    id: session.id,
    workspace: '/fixture/v016/project',
    timestamp: session.createdAt,
    source: session.source,
    messageCount: session.messages.length,
    messages: session.messages.map(({ id, ...message }) => ({
      ...message,
      ...(id === null || id.length === 0 ? {} : { id }),
    })),
    metadata: { lastModified: session.lastUpdatedAt },
  };
}

async function withCurrentWorkspaceFallback<T>(
  run: (fixture: { root: string; workspaceStorage: string }) => Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'cursor-history-v016-workspace-current-'));
  const workspaceStorage = join(root, 'User', 'workspaceStorage');
  const workspaceDirectory = join(workspaceStorage, 'synthetic-workspace-fallback-016');
  const emptyStoreRoot = join(root, 'empty-store');
  const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
  try {
    mkdirSync(workspaceDirectory, { recursive: true });
    mkdirSync(emptyStoreRoot, { recursive: true });
    writeFileSync(
      join(workspaceDirectory, 'workspace.json'),
      JSON.stringify({ folder: pathToFileURL('/fixture/v016/project').href })
    );
    const database = new BetterSqlite3(join(workspaceDirectory, 'state.vscdb'));
    try {
      database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      database
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run(
          'composer.composerData',
          readFileSync(join(FIXTURE_ROOT, 'workspace-fallback.json'), 'utf8')
        );
    } finally {
      database.close();
    }
    process.env['CURSOR_STORE_ROOT'] = emptyStoreRoot;
    return await run({ root, workspaceStorage });
  } finally {
    if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
    else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

function keyBytes(keys: readonly string[]): Buffer {
  return Buffer.from(keys.join('\0'), 'utf8');
}

describe('locked wholly synthetic v0.16 fixture generation', () => {
  it('records fixed source-format and external-consumer certification provenance', () => {
    const manifest = readManifest();
    expect(manifest.fixtureSchema).toBe(V016_FIXTURE_SCHEMA);
    expect(manifest.generator.deterministic).toBe(true);
    expect(manifest.generator.logicalInputs).toMatchObject({
      sessionId: V016_SYNTHETIC_SESSION_ID,
      workspacePath: '/fixture/v016/project',
      hostname: 'fixture-host',
      sqliteHeaderVersion: 3_051_001,
      bubbleRowids: [10, 15, 20, 25, 30, 40, 50],
    });
    expect(manifest.provenance.cursorHistory).toMatchObject({
      tag: 'v0.16.0',
      commit: 'e8a7abf8cea3419a9dda911e174a05f82a9b260e',
      projectorManifest: 'tests/compatibility/fixtures/v016/projector-manifest.json',
      sourceFormat: {
        composerGlobalTable: 'cursorDiskKV',
        bubbleOrder: 'rowid ASC',
        nullBubblePayload: 'preserved as a row-key-ID [corrupted message] entry',
      },
    });
    expect(manifest.provenance.externalConsumerCertification).toEqual({
      manifest: 'tests/compatibility/fixtures/v016/vibe-history-consumer-manifest.json',
      recurringCiIncludesThirdPartyImplementation: false,
    });
    expect(manifest.generator.forbiddenInputs).toEqual(
      expect.arrayContaining([
        'live Cursor roots',
        'user backup archives',
        'environment-derived identity or content',
        'adjacent vibe-history checkout',
      ])
    );
  });

  it('uses no live/user/environment discovery or nondeterministic generator inputs', () => {
    const source = readFileSync(GENERATOR_PATH, 'utf8');
    for (const forbidden of [
      /process\.env/,
      /\bhomedir\s*\(/,
      /\bhostname\s*\(/,
      /\bDate\.now\s*\(/,
      /\bMath\.random\s*\(/,
      /\bfetch\s*\(/,
      /\bexec(?:File)?Sync\s*\(/,
      /\bspawn(?:Sync)?\s*\(/,
      /getCursorDataPath/,
      /CURSOR_DATA_PATH/,
      /\.cursor[\\/]/,
      /\.\.\/[A-Za-z0-9._-]*vibe-history/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
    expect(source.startsWith('#!/usr/bin/env')).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(GENERATOR_PATH).mode & 0o111).not.toBe(0);
    }
  });

  it('regenerates privately with byte-identical hashes and an identical logical inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-history-v016-regenerate-'));
    try {
      chmodSync(root, 0o700);
      const generated = generateV016Fixtures(root);
      const committed = readManifest();

      expect(generated).toEqual(committed);
      expect(inspectV016FixtureSet(root)).toEqual(committed.logicalInventory);
      expect(inspectV016FixtureSet(FIXTURE_ROOT)).toEqual(committed.logicalInventory);
      for (const [name, metadata] of Object.entries(committed.artifacts)) {
        const generatedBytes = readFileSync(join(root, name));
        const committedBytes = readFileSync(join(FIXTURE_ROOT, name));
        expect({ sha256: sha256(generatedBytes), bytes: generatedBytes.length }).toEqual(metadata);
        expect(generatedBytes).toEqual(committedBytes);
      }

      if (process.platform !== 'win32') {
        expect(statSync(root).mode & 0o777).toBe(0o700);
        for (const name of GENERATED_ARTIFACTS) {
          expect(statSync(join(root, name)).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs through its checked-in CLI entry point when native type stripping is available', () => {
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0]!, 10);
    if (nodeMajor < 22) return;
    const parent = mkdtempSync(join(tmpdir(), 'cursor-history-v016-executable-'));
    const output = join(parent, 'generated');
    const stdoutPath = join(parent, 'stdout.bin');
    const stderrPath = join(parent, 'stderr.bin');
    let stdoutFd: number | undefined = openSync(stdoutPath, 'w', 0o600);
    let stderrFd: number | undefined = openSync(stderrPath, 'w', 0o600);
    try {
      const execution = spawnSync(
        process.execPath,
        ['--no-warnings', '--experimental-strip-types', GENERATOR_PATH, output],
        { stdio: ['ignore', stdoutFd, stderrFd], timeout: 30_000 }
      );
      closeSync(stdoutFd);
      stdoutFd = undefined;
      closeSync(stderrFd);
      stderrFd = undefined;
      expect(execution.status).toBe(0);
      expect(execution.signal).toBeNull();
      expect(readFileSync(stderrPath)).toHaveLength(0);
      expect(JSON.parse(readFileSync(stdoutPath, 'utf8'))).toMatchObject({
        fixtureSchema: V016_FIXTURE_SCHEMA,
        outputDirectory: output,
      });
      expect(readManifest(output)).toEqual(readManifest());
    } finally {
      if (stdoutFd !== undefined) closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('locked v0.16 raw-layout and downstream archive fidelity', () => {
  it('matches the independent tagged projector for global SQLite and workspace fallback JSON', () => {
    const database = new BetterSqlite3(join(FIXTURE_ROOT, 'composer-global-state.vscdb'), {
      readonly: true,
    });
    let bubbleRows: Array<{ rowid: number; key: string; value: string | null }>;
    let composerDataValue: string;
    try {
      bubbleRows = database
        .prepare(
          "SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid ASC"
        )
        .all() as Array<{ rowid: number; key: string; value: string | null }>;
      composerDataValue = (
        database
          .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
          .get(`composerData:${V016_SYNTHETIC_SESSION_ID}`) as { value: string }
      ).value;
    } finally {
      database.close();
    }
    const tagged = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'tagged-output.json'), 'utf8')) as {
      globalSession: unknown;
      workspaceFallbackSessions: unknown;
    };
    const projectedGlobal = projectV016GlobalSession({
      id: V016_SYNTHETIC_SESSION_ID,
      title: 'Synthetic v0.16 Composer session',
      createdAt: new Date('2024-01-16T00:00:00.000Z'),
      lastUpdatedAt: new Date('2024-01-16T00:01:00.000Z'),
      bubbleRows,
      composerDataValue,
      workspaceId: 'synthetic-workspace-global-016',
    });
    const workspaceRaw = readFileSync(join(FIXTURE_ROOT, 'workspace-fallback.json'), 'utf8');
    const projectedWorkspace = projectV016WorkspaceSessions(workspaceRaw);

    expect(bubbleRows.find(({ rowid }) => rowid === 25)).toEqual({
      rowid: 25,
      key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:synthetic-null-payload-016`,
      value: null,
    });
    expect(JSON.parse(JSON.stringify(projectedGlobal))).toEqual(tagged.globalSession);
    expect(JSON.parse(JSON.stringify(projectedWorkspace))).toEqual(
      tagged.workspaceFallbackSessions
    );
  });

  it('round-trips the raw Composer database without changing generic v0.16 key bindings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-history-v016-current-library-'));
    const userRoot = join(root, 'User');
    const workspaceStorage = join(userRoot, 'workspaceStorage');
    const globalStorage = join(userRoot, 'globalStorage');
    const emptyStoreRoot = join(root, 'empty-store');
    const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
    try {
      mkdirSync(workspaceStorage, { recursive: true });
      mkdirSync(globalStorage, { recursive: true });
      mkdirSync(emptyStoreRoot, { recursive: true });
      copyFileSync(
        join(FIXTURE_ROOT, 'composer-global-state.vscdb'),
        join(globalStorage, 'state.vscdb')
      );
      process.env['CURSOR_STORE_ROOT'] = emptyStoreRoot;

      const result = await listLibrarySessions({ dataPath: workspaceStorage, limit: 100 });
      const current = result.data.find(({ id }) => id === V016_SYNTHETIC_SESSION_ID);
      expect(current).toBeDefined();

      const tagged = taggedCursorSession();
      const expectedProjection = projectV016DownstreamContract(tagged);
      const currentProjection = projectV016DownstreamContract(current!);
      expect(currentProjection).toEqual({ ...expectedProjection, resolvedSource: 'composer' });
      expect(current!.messages.map(({ id }) => id)).toEqual(
        tagged.messages.map((message, index) => message.id || `msg:${index}`)
      );
      expect(current!.messages[3]).toMatchObject({
        id: 'synthetic-null-payload-016',
        content: '[corrupted message]',
      });
    } finally {
      if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
      else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips raw workspace-fallback data without changing generic v0.16 keys', async () => {
    await withCurrentWorkspaceFallback(async ({ workspaceStorage }) => {
      const result = await listLibrarySessions({
        dataPath: workspaceStorage,
        workspace: '/fixture/v016/project',
        limit: 100,
      });
      expect(result.pagination.total).toBe(1);
      const current = result.data[0]!;
      const tagged = taggedWorkspaceFallbackSession();
      const expectedProjection = projectV016DownstreamContract(tagged);
      const currentProjection = projectV016DownstreamContract(current);

      expect(current).toMatchObject({
        id: V016_SYNTHETIC_SESSION_ID,
        workspace: '/fixture/v016/project',
        source: 'workspace-fallback',
      });
      expect(current.messages.map(({ id }) => id)).toEqual([
        'workspace-native-016',
        'msg:1',
        'msg:2',
      ]);
      expect(currentProjection).toEqual({ ...expectedProjection, resolvedSource: 'composer' });
      expect(
        keyBytes([
          currentProjection.sessionKey,
          ...currentProjection.messages.map(({ key }) => key),
          ...currentProjection.messages.flatMap(({ tools }) => tools.map(({ key }) => key)),
        ])
      ).toEqual(
        keyBytes([
          expectedProjection.sessionKey,
          ...expectedProjection.messages.map(({ key }) => key),
          ...expectedProjection.messages.flatMap(({ tools }) => tools.map(({ key }) => key)),
        ])
      );
    });
  });

  it('applies the versioned public-search coordinate correction to the raw v0.16 workspace fixture', async () => {
    const baseline = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'tests',
          'compatibility',
          'fixtures',
          'v017',
          'search-coordinate-correction.json'
        ),
        'utf8'
      )
    ) as {
      query: string;
      contextLines: number;
      legacyResult: { match: string; messageIndex: number; offset: number };
      correctiveResult: { match: string; messageIndex: number; offset: number };
    };

    expect(baseline.legacyResult).toMatchObject({
      match: '...missing-ID...',
      messageIndex: 0,
      offset: 3,
    });
    await withCurrentWorkspaceFallback(async ({ workspaceStorage }) => {
      const results = await searchLibrarySessions(baseline.query, {
        dataPath: workspaceStorage,
        workspace: '/fixture/v016/project',
        context: baseline.contextLines,
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        session: { id: V016_SYNTHETIC_SESSION_ID },
        match: baseline.correctiveResult.match,
        messageIndex: baseline.correctiveResult.messageIndex,
        offset: baseline.correctiveResult.offset,
      });
    });
  });

  it('adds a zero-based public JSON export index without drifting v0.16 identity or content', async () => {
    const baseline = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'tests',
          'compatibility',
          'fixtures',
          'v017',
          'search-coordinate-correction.json'
        ),
        'utf8'
      )
    ) as {
      jsonExportIndex: {
        taggedReleaseBaseline: { indexPresence: 'absent' };
        unreleasedFeatureBranchRegression: { exportedIndex: number };
        correctiveRelease: {
          version: string;
          exportedIndex: number;
          indexScope: string;
          classification: string;
        };
      };
    };
    expect(baseline.jsonExportIndex).toMatchObject({
      taggedReleaseBaseline: { indexPresence: 'absent' },
      unreleasedFeatureBranchRegression: { exportedIndex: 1 },
      correctiveRelease: {
        version: '0.18.0',
        exportedIndex: 0,
        indexScope: 'workspace',
        classification: 'additive-zero-based-metadata',
      },
    });

    await withCurrentWorkspaceFallback(async ({ workspaceStorage }) => {
      const config = {
        dataPath: workspaceStorage,
        workspace: '/fixture/v016/project',
      } as const;
      const current = (await listLibrarySessions({ ...config, limit: 100 })).data[0]!;
      const exported = JSON.parse(await exportLibrarySessionToJson(0, config)) as {
        index: number;
        indexScope: string;
        id: string;
        title: string;
        createdAt: string;
        lastUpdatedAt: string;
        messageCount: number;
        workspacePath: string;
        source: 'global' | 'workspace-fallback';
        messages: Array<{
          id?: string;
          role: 'user' | 'assistant';
          content: string;
          timestamp: string;
          toolCalls?: Session['messages'][number]['toolCalls'];
        }>;
      };
      const exportedById = JSON.parse(
        await exportLibrarySessionToJson(V016_SYNTHETIC_SESSION_ID, config)
      ) as typeof exported;

      expect(exported.index).toBe(baseline.jsonExportIndex.correctiveRelease.exportedIndex);
      expect(exported.indexScope).toBe(baseline.jsonExportIndex.correctiveRelease.indexScope);
      expect(exportedById).toEqual(exported);
      expect(exported).toMatchObject({
        id: V016_SYNTHETIC_SESSION_ID,
        title: 'Synthetic workspace fallback',
        createdAt: '2024-01-16T00:00:00.000Z',
        lastUpdatedAt: '2024-01-16T00:01:00.000Z',
        messageCount: 3,
        workspacePath: '/fixture/v016/project',
        source: 'workspace-fallback',
      });
      expect(
        exported.messages.map(({ id, role, content, timestamp }) => ({
          id,
          role,
          content,
          timestamp,
        }))
      ).toEqual(
        current.messages.map(({ id, role, content, timestamp }) => ({
          id,
          role,
          content,
          timestamp,
        }))
      );

      const exportedContractProjection = projectV016DownstreamContract({
        id: exported.id,
        workspace: exported.workspacePath,
        timestamp: exported.createdAt,
        source: exported.source,
        messageCount: exported.messageCount,
        messages: exported.messages,
        metadata: { lastModified: exported.lastUpdatedAt },
      });
      expect(exportedContractProjection).toEqual(
        projectV016DownstreamContract(taggedWorkspaceFallbackSession())
      );
    });
  });
});

describe('recurring synthetic fixture safety scanner', () => {
  it('scans committed and regenerated bytes plus declared logical payloads', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-history-v016-scan-'));
    try {
      const generated = generateV016Fixtures(root);
      for (const fixtureRoot of [FIXTURE_ROOT, root]) {
        for (const name of GENERATED_ARTIFACTS) {
          expect(
            scanSyntheticFixtureBytes(
              name,
              readFileSync(join(fixtureRoot, name)),
              generated.syntheticIdentities.allowedCursorShapedIds
            )
          ).toEqual([]);
        }
        expect(
          scanLogicalPayloadInventory(
            inspectV016FixtureSet(fixtureRoot),
            generated.generator.logicalInputs.allowedPayloadStrings
          )
        ).toEqual([]);
      }
      expect(generated.generator.logicalInputs.allowedPayloadStrings).toEqual(
        V016_ALLOWED_PAYLOAD_STRINGS
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects poisoned bytes and an undeclared conversation payload', () => {
    const poisonedBytes = Buffer.concat([
      readFileSync(join(FIXTURE_ROOT, 'tagged-output.json')),
      Buffer.from('\nleaked.person@example.com\n'),
    ]);
    expect(scanSyntheticFixtureBytes('poisoned.json', poisonedBytes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact: 'poisoned.json', rule: 'email-address' }),
      ])
    );

    const poisonedInventory = structuredClone(
      inspectV016FixtureSet(FIXTURE_ROOT)
    ) as V016FixtureLogicalInventory;
    poisonedInventory.payloadStrings.push('Undeclared copied private conversation.');
    expect(scanLogicalPayloadInventory(poisonedInventory)).toContainEqual({
      artifact: 'logical-inventory',
      rule: 'undeclared-payload-content',
      evidence: 'Undeclared copied private conversation.',
    });
  });
});
