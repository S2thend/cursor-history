import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { runBuiltCli } from '../helpers/run-cli.js';

interface CliMigrationResult {
  success: boolean;
  sessionId: string;
  sourceWorkspace: string;
  destinationWorkspace: string;
  mode: 'move' | 'copy';
  dryRun: boolean;
}

const fixtures: SessionIntegrityFixtureRoot[] = [];

function createCorpus() {
  const fixture = createSessionIntegrityFixtureRoot('cursor-history-cli-migration-');
  fixtures.push(fixture);
  const { sessionA, sessionB } = seedConflictingWorkspaceCorpus(fixture);
  const destination = `${fixture.root}/workspaces/destination`;
  mkdirSync(destination, { recursive: true });
  writeComposerWorkspaceSummary(fixture, 'workspace-destination', destination, []);
  return { fixture, sessionA, sessionB, destination };
}

function createAmbiguousCorpus() {
  const fixture = createSessionIntegrityFixtureRoot('cursor-history-cli-ambiguity-');
  fixtures.push(fixture);
  const shared: Omit<ComposerFixtureSession, 'title' | 'messages'> = {
    id: 'dddddddd-0000-0000-0000-000000000032',
    workspacePath: fixture.projectA,
    createdAt: 1_783_000_000_000,
  };
  writeComposerWorkspaceSummary(fixture, 'workspace-left', fixture.projectA, [
    {
      ...shared,
      title: 'divergent-left-needle',
      messages: [
        {
          id: 'left-message',
          role: 'user',
          content: 'divergent-left-needle',
          createdAt: shared.createdAt,
        },
      ],
    },
  ]);
  writeComposerWorkspaceSummary(fixture, 'workspace-right', fixture.projectA, [
    {
      ...shared,
      title: 'divergent-right-needle',
      messages: [
        {
          id: 'right-message',
          role: 'user',
          content: 'divergent-right-needle',
          createdAt: shared.createdAt,
        },
      ],
    },
  ]);
  return { fixture, sessionId: shared.id };
}

function targetProjection(result: CliMigrationResult) {
  return {
    sessionId: result.sessionId,
    sourceWorkspace: result.sourceWorkspace,
    destinationWorkspace: result.destinationWorkspace,
    mode: result.mode,
  };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('built migrate-session workspace integrity', () => {
  it('round-trips workspace index 1 through list, show, search, and export JSON', async () => {
    const { fixture, sessionA, sessionB } = createCorpus();
    const common = [
      '--json',
      '--data-path',
      fixture.workspaceStorage,
      '--workspace',
      fixture.projectA,
    ] as const;
    const env = { CURSOR_STORE_ROOT: fixture.storeRoot };

    const listRun = await runBuiltCli([...common, 'list', '--all'], { env, timeoutMs: 20_000 });
    expect(listRun).toMatchObject({ status: 0, stderr: '', timedOut: false });
    const listed = JSON.parse(listRun.stdout) as {
      indexScope: string;
      indexWorkspacePath: string;
      sessions: Array<{ index: number; id: string }>;
    };
    expect(listed).toMatchObject({
      indexScope: 'workspace',
      indexWorkspacePath: fixture.projectA,
    });
    expect(listed.sessions[0]).toMatchObject({ index: 1, id: sessionA.id });
    expect(listed.sessions.some(({ id }) => id === sessionB.id)).toBe(false);

    const showRun = await runBuiltCli([...common, 'show', '1'], { env, timeoutMs: 20_000 });
    expect(showRun).toMatchObject({ status: 0, stderr: '', timedOut: false });
    expect(JSON.parse(showRun.stdout)).toMatchObject({
      index: 1,
      indexScope: 'workspace',
      indexWorkspacePath: fixture.projectA,
      id: sessionA.id,
    });

    const searchRun = await runBuiltCli([...common, 'search', 'needle-a'], {
      env,
      timeoutMs: 20_000,
    });
    expect(searchRun).toMatchObject({ status: 0, stderr: '', timedOut: false });
    const searched = JSON.parse(searchRun.stdout) as {
      indexScope: string;
      indexWorkspacePath: string;
      results: Array<{ index: number; indexScope: string; sessionId: string }>;
    };
    expect(searched).toMatchObject({
      indexScope: 'workspace',
      indexWorkspacePath: fixture.projectA,
    });
    expect(searched.results[0]).toMatchObject({
      index: 1,
      indexScope: 'workspace',
      sessionId: sessionA.id,
    });

    const outputPath = `${fixture.root}/workspace-a.json`;
    const exportRun = await runBuiltCli(
      [...common, 'export', '1', '--format', 'json', '--output', outputPath, '--force'],
      { env, timeoutMs: 20_000 }
    );
    expect(exportRun).toMatchObject({ status: 0, stderr: '', timedOut: false });
    const exported = JSON.parse(exportRun.stdout) as {
      files: Array<{
        index: number;
        indexScope: string;
        indexWorkspacePath: string;
        sessionId: string;
        path: string;
      }>;
    };
    expect(exported.files[0]).toMatchObject({
      index: 1,
      indexScope: 'workspace',
      indexWorkspacePath: fixture.projectA,
      sessionId: sessionA.id,
      path: outputPath,
    });
  });

  it('lists one ambiguous row and skips it once in search and bulk export', async () => {
    const { fixture, sessionId } = createAmbiguousCorpus();
    const common = [
      '--data-path',
      fixture.workspaceStorage,
      '--workspace',
      fixture.projectA,
    ] as const;
    const env = { CURSOR_STORE_ROOT: fixture.storeRoot };
    const ambiguityDiagnostics = (value: {
      diagnostics?: Array<Record<string, unknown>>;
    }): Array<Record<string, unknown>> =>
      (value.diagnostics ?? []).filter(({ code }) => code === 'SESSION_AMBIGUOUS');

    const listRun = await runBuiltCli(['--json', ...common, 'list', '--all'], {
      env,
      timeoutMs: 20_000,
    });
    expect(listRun).toMatchObject({ status: 0, stderr: '', timedOut: false });
    const listed = JSON.parse(listRun.stdout) as {
      count: number;
      indexScope: string;
      indexWorkspacePath: string;
      sessions: Array<Record<string, unknown>>;
      diagnostics: Array<Record<string, unknown>>;
    };
    expect(listed).toMatchObject({
      count: 1,
      indexScope: 'workspace',
      indexWorkspacePath: fixture.projectA,
      sessions: [
        {
          index: 1,
          indexScope: 'workspace',
          indexWorkspacePath: fixture.projectA,
          id: sessionId,
          resolutionState: 'ambiguous',
          sourceRoles: ['composer'],
          occurrenceCount: 2,
        },
      ],
    });
    expect(ambiguityDiagnostics(listed)).toHaveLength(1);
    expect(ambiguityDiagnostics(listed)[0]).toMatchObject({
      sessionId,
      occurrenceCount: 2,
      remedy: expect.stringContaining('retry'),
    });
    expect(JSON.stringify(ambiguityDiagnostics(listed))).not.toContain('state.vscdb');
    expect(listed.sessions[0]).not.toHaveProperty('title');
    expect(listed.sessions[0]).not.toHaveProperty('preview');

    const humanList = await runBuiltCli([...common, 'list', '--all'], {
      env,
      timeoutMs: 20_000,
    });
    expect(humanList).toMatchObject({ status: 0, stderr: '', timedOut: false });
    expect(humanList.stdout).toContain('ambiguous');
    expect(humanList.stdout).toContain('Divergent replicas (2)');
    expect(humanList.stdout).toContain('Next step:');
    expect(humanList.stdout.match(/Next step:/gu)).toHaveLength(1);

    const searchRun = await runBuiltCli(['--json', ...common, 'search', 'divergent-left-needle'], {
      env,
      timeoutMs: 20_000,
    });
    expect(searchRun).toMatchObject({ status: 0, stderr: '', timedOut: false });
    const searched = JSON.parse(searchRun.stdout) as {
      count: number;
      totalMatches: number;
      indexScope: string;
      indexWorkspacePath: string;
      results: unknown[];
      diagnostics: Array<Record<string, unknown>>;
    };
    expect(searched).toMatchObject({
      count: 0,
      totalMatches: 0,
      indexScope: 'workspace',
      indexWorkspacePath: fixture.projectA,
      results: [],
    });
    expect(ambiguityDiagnostics(searched)).toHaveLength(1);

    const exportDir = `${fixture.root}/ambiguous-export`;
    const exportRun = await runBuiltCli(
      ['--json', ...common, 'export', '--all', '--force', '--output', exportDir],
      { env, timeoutMs: 20_000 }
    );
    expect(exportRun).toMatchObject({ status: 0, stderr: '', timedOut: false });
    const exported = JSON.parse(exportRun.stdout) as {
      count: number;
      files: unknown[];
      diagnostics: Array<Record<string, unknown>>;
    };
    expect(exported).toMatchObject({ count: 0, files: [] });
    expect(ambiguityDiagnostics(exported)).toHaveLength(1);
    expect(readdirSync(exportDir)).toEqual([]);

    const destination = join(fixture.root, 'workspaces', 'ambiguity-destination');
    mkdirSync(destination, { recursive: true });
    const destinationDb = writeComposerWorkspaceSummary(
      fixture,
      'workspace-ambiguity-destination',
      destination,
      []
    );
    const sourceDatabases = ['workspace-left', 'workspace-right'].map((workspaceId) =>
      join(fixture.workspaceStorage, workspaceId, 'state.vscdb')
    );
    const mutationSnapshot = (): Buffer[] =>
      [...sourceDatabases, destinationDb].map((path) => readFileSync(path));
    const beforeMigration = mutationSnapshot();

    for (const selector of ['1', sessionId]) {
      const migrateRun = await runBuiltCli(
        ['--json', ...common, 'migrate-session', selector, destination],
        { env, timeoutMs: 20_000 }
      );
      expect(migrateRun).toMatchObject({ status: 1, stdout: '', timedOut: false });
      const fatal = JSON.parse(migrateRun.stderr) as {
        code: string;
        details: {
          sessionId: string;
          occurrenceCount: number;
          occurrenceRefs: string[];
        };
      };
      expect(fatal).toMatchObject({
        code: 'SESSION_AMBIGUOUS',
        details: {
          sessionId,
          occurrenceCount: 2,
          occurrenceRefs: [
            expect.stringMatching(/^occurrence:v1:/u),
            expect.stringMatching(/^occurrence:v1:/u),
          ],
        },
      });
    }
    expect(mutationSnapshot()).toEqual(beforeMigration);
  });

  it('binds the parent --workspace and applies the exact target reported by dry-run', async () => {
    const { fixture, sessionA, sessionB, destination } = createCorpus();
    const commonArgs = [
      '--json',
      '--data-path',
      fixture.workspaceStorage,
      '--workspace',
      fixture.projectA,
      'migrate-session',
      '1',
      destination,
    ] as const;
    const env = { CURSOR_STORE_ROOT: fixture.storeRoot };

    const previewRun = await runBuiltCli([...commonArgs, '--dry-run'], {
      env,
      timeoutMs: 20_000,
    });
    expect(previewRun).toMatchObject({ status: 0, signal: null, timedOut: false });
    expect(previewRun.stderr).toBe('');
    const preview = JSON.parse(previewRun.stdout) as CliMigrationResult[];
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({
      success: true,
      sessionId: sessionA.id,
      sourceWorkspace: fixture.projectA,
      destinationWorkspace: destination,
      mode: 'move',
      dryRun: true,
    });
    expect(preview[0]?.sessionId).not.toBe(sessionB.id);

    const applyRun = await runBuiltCli(commonArgs, { env, timeoutMs: 20_000 });
    expect(applyRun).toMatchObject({ status: 0, signal: null, timedOut: false });
    expect(applyRun.stderr).toBe('');
    const applied = JSON.parse(applyRun.stdout) as CliMigrationResult[];
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ success: true, dryRun: false });
    expect(targetProjection(applied[0]!)).toEqual(targetProjection(preview[0]!));
  });
});
