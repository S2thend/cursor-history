import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLI_COMMAND_REGISTRY,
  CLI_ROOT_FATAL_CATEGORIES,
  loadCommands,
  program as rootProgram,
} from '../../src/cli/index.js';
import { CLI_FATAL_CATEGORY_REGISTRY } from '../../src/cli/errors.js';
import { runBuiltCli } from '../helpers/run-cli.js';
import {
  createFixtureBackup,
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeStoreDb,
  writeStoreMeta,
  writeStoreTranscript,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

interface V017FatalCase {
  readonly id: string;
  readonly source: string;
  readonly exitCategory: string;
  readonly exitCode: number;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly json: Readonly<Record<string, unknown>>;
}

interface V017FatalFixture {
  readonly schemaVersion: number;
  readonly taggedRelease: { readonly tag: string; readonly commit: string };
  readonly encoding: 'base64';
  readonly streamContract: {
    readonly legacyFatalJsonStream: 'stdout';
    readonly legacyHumanFatalStream: 'stderr';
    readonly correctiveFatalJsonStream: 'stderr';
    readonly preserveExitCategory: boolean;
    readonly preserveExistingJsonFields: boolean;
  };
  readonly cases: readonly V017FatalCase[];
}

const fixturePath = resolve('tests/compatibility/fixtures/v017/cli-fatal-output.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as V017FatalFixture;
const missingDataPath = '/fixture/v017/missing-data';
const missingBackupPath = '/fixture/v017/missing.backup';
const missingStorePath = '/fixture/v017/missing-store';
const temporaryFixtures: SessionIntegrityFixtureRoot[] = [];

afterEach(() => {
  for (const temporary of temporaryFixtures.splice(0)) temporary.cleanup();
});

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function parseSingleJsonStream(stream: string): Record<string, unknown> {
  const trimmed = stream.trim();
  expect(trimmed).not.toBe('');
  const parsed = JSON.parse(trimmed) as unknown;
  expect(parsed).toBeTypeOf('object');
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  return parsed as Record<string, unknown>;
}

function expectLegacyProjection(
  actual: Readonly<Record<string, unknown>>,
  legacy: Readonly<Record<string, unknown>>
): void {
  for (const [field, value] of Object.entries(legacy)) expect(actual[field]).toEqual(value);
  expect(Object.keys(actual).filter((field) => !(field in legacy))).toEqual(
    expect.arrayContaining([])
  );
  for (const additive of Object.keys(actual).filter((field) => !(field in legacy))) {
    expect(['code', 'details']).toContain(additive);
  }
}

describe('v0.17 fatal JSON compatibility fixture', () => {
  it('is byte-locked to the tagged release and preserves every recorded object/category', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      taggedRelease: {
        tag: 'v0.17.0',
        commit: '5e6ac2bebd041607d7e8b57e3f364aeb9440c2db',
      },
      streamContract: {
        legacyFatalJsonStream: 'stdout',
        legacyHumanFatalStream: 'stderr',
        correctiveFatalJsonStream: 'stderr',
        preserveExitCategory: true,
        preserveExistingJsonFields: true,
      },
    });
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const entry of fixture.cases) {
      expect(entry.exitCode).toBe(
        CLI_FATAL_CATEGORY_REGISTRY[
          entry.exitCategory === 'GENERAL_ERROR'
            ? 'general'
            : entry.exitCategory === 'USAGE_ERROR'
              ? 'usage'
              : entry.exitCategory === 'NOT_FOUND'
                ? 'notFound'
                : 'io'
        ].exitCode
      );
      expect(decodeBase64(entry.stderrBase64)).toHaveLength(0);
      expect(JSON.parse(decodeBase64(entry.stdoutBase64).toString('utf8'))).toEqual(entry.json);
      expect(entry.source).toMatch(/^src\/cli\/commands\//u);
    }
  });

  it.each([
    [
      'list-workspaces-data-not-found',
      ['--json', '--data-path', missingDataPath, 'list', '--workspaces'],
    ],
    ['restore-backup-file-not-found', ['--json', 'restore', missingBackupPath]],
  ] as const)('moves %s to stderr with only additive safe fields', async (caseId, args) => {
    const legacy = fixture.cases.find(({ id }) => id === caseId)!;
    const run = await runBuiltCli(args, {
      env: { CURSOR_STORE_ROOT: missingStorePath },
      timeoutMs: 20_000,
    });

    expect(run).toMatchObject({ status: legacy.exitCode, signal: null, timedOut: false });
    expect(run.stdoutBytes).toHaveLength(0);
    expectLegacyProjection(parseSingleJsonStream(run.stderr), legacy.json);
  });

  it('maps a fatal payload limit to I/O exit 4 without stdout content', async () => {
    const temporary = createSessionIntegrityFixtureRoot('cursor-history-cli-source-limit-');
    temporaryFixtures.push(temporary);
    const sessionId = '50000000-0000-4000-8000-000000000005';
    writeStoreTranscript(temporary, 'source-limit-project', sessionId, [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'fictional payload above one byte' }] },
      },
    ]);

    const run = await runBuiltCli(
      [
        '--json',
        '--data-path',
        temporary.workspaceStorage,
        '--source-limit',
        'jsonlRecordBytes=1',
        'show',
        sessionId,
      ],
      { env: { CURSOR_STORE_ROOT: temporary.storeRoot }, timeoutMs: 20_000 }
    );
    expect(run).toMatchObject({ status: 4, signal: null, timedOut: false });
    expect(run.stdoutBytes).toHaveLength(0);
    expect(parseSingleJsonStream(run.stderr)).toMatchObject({
      code: 'SOURCE_LIMIT_EXCEEDED',
      details: {
        sourceKind: 'jsonl',
        bound: 'jsonl-record-bytes',
        unit: 'bytes',
        limit: 1,
        observedAtLeast: 2,
        outcome: 'fatal',
      },
    });
  });

  it('maps deterministic invalid UTF-8 to I/O exit 4 without replacement decoding', async () => {
    const temporary = createSessionIntegrityFixtureRoot('cursor-history-cli-encoding-');
    temporaryFixtures.push(temporary);
    const sessionId = 'cccccccc-0000-0000-0000-000000000017';
    const transcript = writeStoreTranscript(temporary, 'encoding-project', sessionId, []);
    writeFileSync(transcript, Buffer.from([0xc3, 0x28, 0x0a]), { mode: 0o600 });

    const run = await runBuiltCli(
      ['--json', '--data-path', temporary.workspaceStorage, 'show', sessionId],
      { env: { CURSOR_STORE_ROOT: temporary.storeRoot }, timeoutMs: 20_000 }
    );
    expect(run).toMatchObject({ status: 4, signal: null, timedOut: false });
    expect(run.stdoutBytes).toHaveLength(0);
    expect(run.stderr).not.toContain('\uFFFD');
    expect(parseSingleJsonStream(run.stderr)).toMatchObject({
      code: 'SOURCE_ENCODING_INVALID',
      details: { sourceKind: 'jsonl', outcome: 'fatal' },
    });
  });

  it('keeps a safe transcript fallback as an explicit exit-0 partial result on stdout', async () => {
    const temporary = createSessionIntegrityFixtureRoot('cursor-history-cli-partial-');
    temporaryFixtures.push(temporary);
    const sessionId = 'dddddddd-0000-0000-0000-000000000017';
    const storeDb = writeStoreDb(
      temporary,
      sessionId,
      [{ role: 'user', content: 'invalid Store DB leaf' }],
      'Store DB with transcript fallback'
    );
    const transcript = writeStoreTranscript(temporary, 'partial-project', sessionId, [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: 'safe transcript fallback' }] },
      },
    ]);
    writeStoreMeta(dirname(storeDb), {
      cwd: temporary.projectA,
      title: 'Invalid Store contributor',
      hasConversation: true,
    });
    const run = await runBuiltCli(
      [
        '--json',
        '--data-path',
        temporary.workspaceStorage,
        '--source-limit',
        'sqliteValueBytes=1',
        'show',
        sessionId,
      ],
      { env: { CURSOR_STORE_ROOT: temporary.storeRoot }, timeoutMs: 20_000 }
    );
    expect(run).toMatchObject({ status: 0, signal: null, timedOut: false });
    expect(run.stderrBytes).toHaveLength(0);
    const result = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(result).toMatchObject({
      id: sessionId,
      source: 'workspace-fallback',
      resolvedSource: 'store-transcript',
      resolutionState: 'partial',
      resolution: expect.objectContaining({
        state: 'partial',
        reasonCodes: expect.arrayContaining(['source-read-failed']),
      }),
    });
    expect(run.stdout).not.toContain('\uFFFD');
    expect(dirname(transcript)).toContain(sessionId);
  });
});

describe('closed CLI fatal and Source Read Limits coverage', () => {
  it('keeps the registration inventory identical to the actual command graph', async () => {
    const target = new Command();
    await loadCommands(target);
    expect(target.commands.map((command) => command.name()).sort()).toEqual(
      Object.keys(CLI_COMMAND_REGISTRY).sort()
    );
    expect(
      Object.values(CLI_COMMAND_REGISTRY).every(({ sourceReadLimits }) => sourceReadLimits)
    ).toBe(true);
  });

  it('fails closed when a fatal category is absent from root or command coverage', () => {
    const covered = new Set<string>(CLI_ROOT_FATAL_CATEGORIES);
    for (const command of Object.values(CLI_COMMAND_REGISTRY)) {
      for (const category of command.fatalCategories) covered.add(category);
    }
    expect([...covered].sort()).toEqual(Object.keys(CLI_FATAL_CATEGORY_REGISTRY).sort());
  });

  it('routes missing scoped-backup inventory through its typed I/O fatal category', async () => {
    const temporary = createSessionIntegrityFixtureRoot('cursor-history-cli-legacy-scope-');
    temporaryFixtures.push(temporary);
    seedConflictingWorkspaceCorpus(temporary);

    const currentBackup = await createFixtureBackup(temporary, 'current.zip');
    const legacyBackup = join(temporary.root, 'legacy-multi-workspace.zip');
    const zip = await JSZip.loadAsync(readFileSync(currentBackup));
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) throw new Error('Synthetic backup has no manifest.');
    const manifest = JSON.parse(await manifestEntry.async('string')) as Record<string, unknown>;
    delete manifest['composerWorkspaceInventory'];
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    writeFileSync(
      legacyBackup,
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
      { mode: 0o600 }
    );

    const run = await runBuiltCli(
      ['--json', '--workspace', temporary.projectA, 'list', '--all', '--backup', legacyBackup],
      { env: { CURSOR_STORE_ROOT: temporary.storeRoot }, timeoutMs: 20_000 }
    );

    expect(run).toMatchObject({ status: 4, signal: null, timedOut: false });
    expect(run.stdoutBytes).toHaveLength(0);
    expect(parseSingleJsonStream(run.stderr)).toMatchObject({
      code: 'BACKUP_WORKSPACE_SCOPE_METADATA_REQUIRED',
      details: {
        workspaceCount: 2,
        remedy: expect.stringContaining('Recreate the backup'),
      },
    });
  });

  it.each(['missing', 'manifestless', 'empty-manifest'] as const)(
    'preserves the released invalid-backup envelope for every scoped %s backup read',
    async (kind) => {
      const temporary = createSessionIntegrityFixtureRoot(
        `cursor-history-cli-scoped-${kind}-backup-`
      );
      temporaryFixtures.push(temporary);
      const backupPath = join(temporary.root, `${kind}.zip`);
      if (kind === 'manifestless' || kind === 'empty-manifest') {
        const zip = new JSZip();
        if (kind === 'manifestless') {
          zip.file('unrelated.txt', 'not a cursor-history backup');
        } else {
          zip.file(
            'manifest.json',
            JSON.stringify({
              version: '1.0.0',
              files: [],
              composerWorkspaceInventory: { schemaVersion: 1, workspaces: [] },
            })
          );
        }
        writeFileSync(backupPath, await zip.generateAsync({ type: 'nodebuffer' }), {
          mode: 0o600,
        });
      }

      const outputPath = join(temporary.root, `${kind}-must-not-export.json`);
      const commandArgs = [
        ['list', '--all', '--backup', backupPath],
        ['show', '1', '--backup', backupPath],
        ['search', 'needle', '--backup', backupPath],
        [
          'export',
          '1',
          '--backup',
          backupPath,
          '--format',
          'json',
          '--output',
          outputPath,
          '--force',
        ],
      ] as const;
      for (const args of commandArgs) {
        const run = await runBuiltCli(['--json', '--workspace', temporary.projectA, ...args], {
          env: { CURSOR_STORE_ROOT: temporary.storeRoot },
          timeoutMs: 20_000,
        });
        expect(run).toMatchObject({ status: 3, stdout: '', timedOut: false });
        expect(parseSingleJsonStream(run.stderr)).toMatchObject({
          error: 'Invalid backup',
          code: 'CLI_NOT_FOUND',
          errors: [expect.any(String)],
        });
      }
      expect(existsSync(outputPath)).toBe(false);
    },
    60_000
  );

  it.each([
    ['list', ['--json', '--data-path', missingDataPath, 'list', '--workspaces'], 3],
    ['show', ['--json', 'show', '1', '--backup', missingBackupPath], 3],
    ['search', ['--json', 'search', 'needle', '--backup', missingBackupPath], 3],
    ['export', ['--json', 'export', '1', '--backup', missingBackupPath], 3],
    [
      'migrate',
      ['--json', '--data-path', missingDataPath, 'migrate', '/source', '/destination'],
      1,
    ],
    [
      'migrate-session',
      ['--json', '--data-path', missingDataPath, 'migrate-session', '1', '/destination'],
      1,
    ],
    ['backup', ['--json', '--data-path', missingDataPath, 'backup'], 2],
    ['restore', ['--json', 'restore', missingBackupPath], 2],
    ['list-backups', ['--json', 'list-backups', '--directory', missingDataPath], 2],
  ] as const)(
    'routes the %s fatal path to exactly one stderr JSON object',
    async (commandName, args, exitCode) => {
      expect(CLI_COMMAND_REGISTRY[commandName]).toBeDefined();
      const run = await runBuiltCli(args, {
        env: { CURSOR_STORE_ROOT: missingStorePath },
        timeoutMs: 20_000,
      });
      expect(run).toMatchObject({ status: exitCode, signal: null, timedOut: false });
      expect(run.stdoutBytes).toHaveLength(0);
      expect(parseSingleJsonStream(run.stderr)).toMatchObject({
        error: expect.any(String),
        code: expect.any(String),
      });
    }
  );

  it('ships complete global safety help and one help surface for every command', async () => {
    if (rootProgram.commands.length === 0) await loadCommands(rootProgram);
    const helpRun = await runBuiltCli(['--help'], { timeoutMs: 20_000 });
    expect(helpRun).toMatchObject({ status: 0, signal: null, timedOut: false });
    expect(helpRun.stderr).toBe('');
    const help = helpRun.stdout;
    for (const text of [
      '--source-limit <field=value>',
      '--include-cross-workspace-sources',
      'one-based, ephemeral',
      'exact-first, unambiguous component-suffix',
      'migrate-session binds each selected Composer-only target',
      'backup --shared',
    ]) {
      expect(help).toContain(text);
    }
    for (const commandName of Object.keys(CLI_COMMAND_REGISTRY)) {
      const command = rootProgram.commands.find((candidate) => candidate.name() === commandName);
      expect(command, commandName).toBeDefined();
      expect(command!.description(), commandName).not.toBe('');
      expect(command!.helpInformation(), commandName).toContain('Options:');
      if (commandName === 'migrate-session') {
        expect(command!.helpInformation()).toContain('comma-separated for multiple');
      }
    }
  });

  it.each([
    ['unknown field', ['--source-limit', 'unknown=1']],
    ['policyVersion', ['--source-limit=policyVersion=1']],
    ['duplicate field', ['--source-limit=zipEntryCount=10', '--source-limit=zipEntryCount=11']],
    ['syntax', ['--source-limit=jsonlRecordBytes=1MB']],
    ['range', ['--source-limit=zipEntryCount=9007199254740992']],
    [
      'cross-field relationship',
      ['--source-limit=zipEntryBytes=2GiB', '--source-limit=zipAggregateBytes=1GiB'],
    ],
  ] as const)('rejects %s before command payload I/O as usage exit 2', async (_label, options) => {
    const run = await runBuiltCli(
      ['--json', '--data-path', missingDataPath, ...options, 'list', '--all'],
      { env: { CURSOR_STORE_ROOT: missingStorePath }, timeoutMs: 20_000 }
    );
    expect(run).toMatchObject({ status: 2, signal: null, timedOut: false });
    expect(run.stdoutBytes).toHaveLength(0);
    expect(parseSingleJsonStream(run.stderr)).toMatchObject({
      code: 'SOURCE_LIMIT_CONFIGURATION_INVALID',
      details: expect.objectContaining({ remedy: expect.any(String) }),
    });
  });

  it('routes root usage failures through the same stderr-only serializer', async () => {
    const run = await runBuiltCli(['--json', 'definitely-not-a-command'], { timeoutMs: 20_000 });
    expect(run).toMatchObject({ status: 1, signal: null, timedOut: false });
    expect(run.stdoutBytes).toHaveLength(0);
    expect(parseSingleJsonStream(run.stderr)).toMatchObject({ code: 'CLI_GENERAL_ERROR' });
  });

  it('retains successful empty JSON results on stdout with exit 0', async () => {
    const run = await runBuiltCli(['--json', '--data-path', missingDataPath, 'list', '--all'], {
      env: { CURSOR_STORE_ROOT: missingStorePath },
      timeoutMs: 20_000,
    });
    expect(run).toMatchObject({ status: 0, signal: null, timedOut: false });
    expect(run.stderrBytes).toHaveLength(0);
    expect(JSON.parse(run.stdout)).toEqual({ count: 0, indexScope: 'global', sessions: [] });
  });
});
