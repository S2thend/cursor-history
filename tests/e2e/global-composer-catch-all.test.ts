import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionReadContext,
  getSession as getCoreSession,
  listSessions as listCoreSessions,
  searchSessions as searchCoreSessions,
} from '../../src/core/storage.js';
import {
  exportAllSessionsToJson,
  exportAllSessionsToMarkdown,
  exportSessionToJson,
  exportSessionToMarkdown,
  getSession as getLibrarySession,
  listSessions as listLibrarySessions,
  searchSessions as searchLibrarySessions,
  type LibraryConfig,
} from '../../src/lib/index.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { runBuiltCli } from '../helpers/run-cli.js';

const fixtures: SessionIntegrityFixtureRoot[] = [];
const originalStoreRoot = process.env['CURSOR_STORE_ROOT'];

function createCorpus(): {
  fixture: SessionIntegrityFixtureRoot;
  workspaceSession: ComposerFixtureSession;
  globalOnlySession: ComposerFixtureSession;
} {
  const fixture = createSessionIntegrityFixtureRoot('cursor-history-global-catch-all-live-');
  fixtures.push(fixture);
  process.env['CURSOR_STORE_ROOT'] = fixture.storeRoot;

  const workspaceSession: ComposerFixtureSession = {
    id: 'aaaaaaaa-2000-4000-8000-000000000016',
    title: 'Workspace A control session',
    workspacePath: fixture.projectA,
    createdAt: 1_786_300_000_000,
    messages: [
      {
        id: 'workspace-a-message',
        role: 'user',
        content: 'workspace-a-control-needle',
        createdAt: 1_786_300_000_000,
      },
    ],
  };
  const globalOnlySession: ComposerFixtureSession = {
    id: 'bbbbbbbb-2000-4000-8000-000000000016',
    title: 'Unlinked global-only live session',
    workspacePath: fixture.projectB,
    createdAt: 1_786_400_000_000,
    messages: [
      {
        id: 'global-only-message',
        role: 'user',
        content: 'unlinked-global-live-needle',
        createdAt: 1_786_400_000_000,
      },
    ],
  };

  // Only workspace A has a workspace row. The second session has neither a workspace row nor a
  // Composer pointer, so unfiltered discovery can find it only through the global catch-all pass.
  writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [workspaceSession]);
  writeComposerGlobalSessions(fixture, [workspaceSession, globalOnlySession]);
  return { fixture, workspaceSession, globalOnlySession };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  if (originalStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = originalStoreRoot;
});

describe('unlinked global Composer catch-all on live custom data', () => {
  it('serves the complete global-only session through core and public read/export surfaces', async () => {
    const { fixture, globalOnlySession } = createCorpus();

    const summaries = await listCoreSessions({ all: true, limit: 0 }, fixture.workspaceStorage);
    expect(summaries.filter(({ id }) => id === globalOnlySession.id)).toMatchObject([
      {
        id: globalOnlySession.id,
        title: globalOnlySession.title,
        workspaceId: 'global',
        source: 'global',
        resolutionState: 'complete',
      },
    ]);
    await expect(
      getCoreSession(globalOnlySession.id, fixture.workspaceStorage)
    ).resolves.toMatchObject({
      id: globalOnlySession.id,
      source: 'global',
      messages: [expect.objectContaining({ content: 'unlinked-global-live-needle' })],
    });
    await expect(
      searchCoreSessions(
        'unlinked-global-live-needle',
        { all: true, limit: 0 },
        fixture.workspaceStorage
      )
    ).resolves.toMatchObject([expect.objectContaining({ sessionId: globalOnlySession.id })]);

    const config: LibraryConfig = { dataPath: fixture.workspaceStorage };
    const listed = await listLibrarySessions(config);
    expect(listed.data.filter(({ id }) => id === globalOnlySession.id)).toHaveLength(1);
    await expect(getLibrarySession(globalOnlySession.id, config)).resolves.toMatchObject({
      id: globalOnlySession.id,
      messages: [expect.objectContaining({ content: 'unlinked-global-live-needle' })],
    });
    const found = await searchLibrarySessions('unlinked-global-live-needle', config);
    expect(found.map(({ session }) => session.id)).toEqual([globalOnlySession.id]);

    const json = JSON.parse(await exportAllSessionsToJson(config)) as Array<{
      id: string;
      messages: Array<{ content: string }>;
    }>;
    expect(json.filter(({ id }) => id === globalOnlySession.id)).toMatchObject([
      {
        id: globalOnlySession.id,
        messages: [expect.objectContaining({ content: 'unlinked-global-live-needle' })],
      },
    ]);
    const markdown = await exportAllSessionsToMarkdown(config);
    expect(markdown).toContain(`# ${globalOnlySession.title}`);
    expect(markdown).toContain('unlinked-global-live-needle');
  });

  it('does not admit the global-only ID through scoped core, library, or built CLI reads', async () => {
    const { fixture, workspaceSession, globalOnlySession } = createCorpus();
    const scopedContext = createSessionReadContext({
      dataPath: fixture.workspaceStorage,
      workspacePath: fixture.projectA,
    });
    try {
      // Exercise a direct ID first so a prior scoped listing cannot hide a lookup bypass.
      await expect(
        getCoreSession(globalOnlySession.id, fixture.workspaceStorage, undefined, scopedContext)
      ).resolves.toBeNull();
      const scoped = await listCoreSessions(
        { all: true, limit: 0, workspacePath: fixture.projectA },
        fixture.workspaceStorage,
        undefined,
        scopedContext
      );
      expect(scoped.map(({ id }) => id)).toEqual([workspaceSession.id]);
      await expect(
        searchCoreSessions(
          'unlinked-global-live-needle',
          { all: true, limit: 0, workspacePath: fixture.projectA },
          fixture.workspaceStorage,
          undefined,
          scopedContext
        )
      ).resolves.toEqual([]);
    } finally {
      await scopedContext.dispose();
    }

    const scopedConfig: LibraryConfig = {
      dataPath: fixture.workspaceStorage,
      workspace: fixture.projectA,
    };
    const listed = await listLibrarySessions(scopedConfig);
    expect(listed.data.map(({ id }) => id)).toEqual([workspaceSession.id]);
    await expect(getLibrarySession(globalOnlySession.id, scopedConfig)).rejects.toMatchObject({
      code: 'SESSION_SCOPE_MISMATCH',
      details: { sessionId: globalOnlySession.id, workspacePath: fixture.projectA },
    });
    await expect(exportSessionToJson(globalOnlySession.id, scopedConfig)).rejects.toMatchObject({
      code: 'SESSION_SCOPE_MISMATCH',
    });
    await expect(exportSessionToMarkdown(globalOnlySession.id, scopedConfig)).rejects.toMatchObject(
      { code: 'SESSION_SCOPE_MISMATCH' }
    );
    await expect(
      searchLibrarySessions('unlinked-global-live-needle', scopedConfig)
    ).resolves.toEqual([]);
    await expect(exportAllSessionsToJson(scopedConfig)).resolves.not.toContain(
      globalOnlySession.id
    );
    await expect(exportAllSessionsToMarkdown(scopedConfig)).resolves.not.toContain(
      'unlinked-global-live-needle'
    );

    const common = [
      '--json',
      '--data-path',
      fixture.workspaceStorage,
      '--workspace',
      fixture.projectA,
    ] as const;
    const env = { CURSOR_STORE_ROOT: fixture.storeRoot };
    const shown = await runBuiltCli([...common, 'show', globalOnlySession.id], {
      env,
      timeoutMs: 20_000,
    });
    expect(shown).toMatchObject({ status: 3, stdout: '', timedOut: false });
    expect(JSON.parse(shown.stderr)).toMatchObject({
      code: 'SESSION_SCOPE_MISMATCH',
      details: { sessionId: globalOnlySession.id, workspacePath: fixture.projectA },
    });

    for (const format of ['json', 'md'] as const) {
      const outputPath = join(fixture.root, `must-not-export-global-only.${format}`);
      const exported = await runBuiltCli(
        [
          ...common,
          'export',
          globalOnlySession.id,
          '--format',
          format,
          '--output',
          outputPath,
          '--force',
        ],
        { env, timeoutMs: 20_000 }
      );
      expect(exported).toMatchObject({ status: 3, stdout: '', timedOut: false });
      expect(JSON.parse(exported.stderr)).toMatchObject({
        code: 'SESSION_SCOPE_MISMATCH',
        details: { sessionId: globalOnlySession.id, workspacePath: fixture.projectA },
      });
      expect(existsSync(outputPath)).toBe(false);
    }
  }, 60_000);
});
