import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeComposerWorkspaceSummary,
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
