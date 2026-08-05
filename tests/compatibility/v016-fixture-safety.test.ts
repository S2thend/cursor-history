import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
import {
  computeV016MessageDigest,
  normalizeCursorSessionV016,
  readV016ArchiveState,
  syncV016Session,
} from '../helpers/v016-consumer.js';
import type { Session } from '../../src/lib/types.js';

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
  'legacy-consumer-archive.sqlite',
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

function archiveInventory(path: string): {
  messageIds: string[];
  toolCallIds: string[];
  codeBlockCount: number;
} {
  const database = new BetterSqlite3(path, { readonly: true });
  try {
    return {
      messageIds: (
        database.prepare('SELECT id FROM messages ORDER BY id ASC').all() as Array<{ id: string }>
      ).map(({ id }) => id),
      toolCallIds: (
        database.prepare('SELECT id FROM tool_calls ORDER BY id ASC').all() as Array<{ id: string }>
      ).map(({ id }) => id),
      codeBlockCount: (
        database.prepare('SELECT COUNT(*) AS count FROM code_blocks').get() as { count: number }
      ).count,
    };
  } finally {
    database.close();
  }
}

describe('locked wholly synthetic v0.16 fixture generation', () => {
  it('records fixed source-format and separately pinned consumer provenance', () => {
    const manifest = readManifest();
    expect(manifest.fixtureSchema).toBe(V016_FIXTURE_SCHEMA);
    expect(manifest.generator.deterministic).toBe(true);
    expect(manifest.generator.logicalInputs).toMatchObject({
      sessionId: V016_SYNTHETIC_SESSION_ID,
      workspacePath: '/fixture/v016/project',
      hostname: 'fixture-host',
      bubbleRowids: [10, 15, 20, 30, 40, 50],
    });
    expect(manifest.provenance.cursorHistory).toMatchObject({
      tag: 'v0.16.0',
      commit: 'e8a7abf8cea3419a9dda911e174a05f82a9b260e',
      projectorManifest: 'tests/compatibility/fixtures/v016/projector-manifest.json',
      sourceFormat: {
        composerGlobalTable: 'cursorDiskKV',
        bubbleOrder: 'rowid ASC',
      },
    });
    expect(manifest.provenance.vibeHistoryConsumer).toEqual({
      revision: '698701775144f7d8875330e1f8caec9ddfc27744',
      manifest: 'tests/compatibility/fixtures/v016/vibe-history-consumer-manifest.json',
      archiveSchema: 2,
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
    let bubbleRows: Array<{ rowid: number; key: string; value: string }>;
    let composerDataValue: string;
    try {
      bubbleRows = database
        .prepare(
          "SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid ASC"
        )
        .all() as Array<{ rowid: number; key: string; value: string }>;
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

    expect(JSON.parse(JSON.stringify(projectedGlobal))).toEqual(tagged.globalSession);
    expect(JSON.parse(JSON.stringify(projectedWorkspace))).toEqual(
      tagged.workspaceFallbackSessions
    );
  });

  it('conforms to the pinned unchanged consumer schema, identity, digest, and real sync output', () => {
    const cursorSession = taggedCursorSession();
    const normalized = normalizeCursorSessionV016(cursorSession);
    const committedPath = join(FIXTURE_ROOT, 'legacy-consumer-archive.sqlite');
    const committedState = readV016ArchiveState(committedPath, normalized.id);
    const manifest = readManifest();

    expect(committedState.exists).toBe(true);
    expect(committedState.messageDigest).toBe(computeV016MessageDigest(normalized.messages));
    expect(committedState.messageIds).toEqual(normalized.messages.map(({ id }) => id));
    expect(archiveInventory(committedPath)).toEqual({
      messageIds: manifest.logicalInventory.consumerArchive.messageIds,
      toolCallIds: manifest.logicalInventory.consumerArchive.toolCallIds,
      codeBlockCount: 1,
    });

    const root = mkdtempSync(join(tmpdir(), 'cursor-history-v016-consumer-'));
    const generatedArchive = join(root, 'archive.sqlite');
    try {
      expect(syncV016Session(generatedArchive, cursorSession)).toEqual({
        action: 'added',
        messagesAppended: cursorSession.messages.length,
      });
      const generatedState = readV016ArchiveState(generatedArchive, normalized.id);
      expect(generatedState).toEqual(committedState);
      expect(archiveInventory(generatedArchive)).toEqual(archiveInventory(committedPath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
