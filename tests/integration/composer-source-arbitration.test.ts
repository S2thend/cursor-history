import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import * as database from '../../src/core/database/index.js';
import { DatabaseCapabilityError } from '../../src/core/database/errors.js';
import {
  arbitrateComposerContribution,
  buildSessionCatalog,
  type PhysicalSessionInstance,
  type ReplicaConsumedPayload,
} from '../../src/core/session-catalog.js';
import * as storage from '../../src/core/storage.js';
import * as library from '../../src/lib/index.js';
import type { LibraryConfig } from '../../src/lib/types.js';
import {
  SESSION_INTEGRITY_IDS,
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const roots: SessionIntegrityFixtureRoot[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('ch-composer-arbitration-');
  roots.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function composer(
  root: SessionIntegrityFixtureRoot,
  title: string,
  workspacePath = root.projectA,
  id = SESSION_INTEGRITY_IDS.duplicate
): ComposerFixtureSession {
  return {
    id,
    title,
    workspacePath,
    createdAt: 1_783_000_000_000,
    messages: [
      {
        id: 'native-composer-message',
        role: 'user',
        content: title,
        createdAt: 1_783_000_000_000,
      },
    ],
  };
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const root of roots.splice(0)) root.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe.sequential('Composer tier arbitration through physical fixtures', () => {
  it('uses one global payload as primary and treats workspace rows as membership-only', async () => {
    const root = fixture();
    const global = composer(root, 'global-primary-needle');
    const workspaceCopyA = composer(root, 'workspace-copy-must-not-replace-global');
    const workspaceCopyB = composer(root, 'another-workspace-copy-must-not-replace-global');
    writeComposerGlobalSessions(root, [global]);
    writeComposerWorkspaceSummary(root, 'workspace-copy-z', root.projectA, [workspaceCopyA]);
    writeComposerWorkspaceSummary(root, 'workspace-copy-a', root.projectA, [workspaceCopyB]);

    const config: LibraryConfig = { dataPath: root.workspaceStorage, workspace: root.projectA };
    const page = await library.listSessions(config);
    expect(page.pagination).toMatchObject({ total: 1, hasMore: false });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: global.id,
      source: 'global',
      resolvedSource: 'composer',
      resolution: {
        state: 'complete',
        expectedSourceRoles: ['composer'],
        loadedSourceRoles: ['composer'],
      },
      sourceInstances: [
        expect.objectContaining({
          representation: 'composer-global',
          state: 'contributed',
        }),
        expect.objectContaining({
          representation: 'composer-workspace',
          state: 'superseded',
        }),
        expect.objectContaining({
          representation: 'composer-workspace',
          state: 'superseded',
        }),
      ],
    });
    const session = await library.getSession(global.id, config);
    expect(session.messages.map(({ content }) => content)).toEqual(['global-primary-needle']);
    expect(session.messages.map(({ content }) => content)).not.toContain(
      'workspace-copy-must-not-replace-global'
    );
  });

  it('uses workspace content only as an explicit partial fallback when global is absent', async () => {
    const root = fixture();
    const fallback = composer(root, 'workspace-fallback-needle');
    writeComposerWorkspaceSummary(root, 'workspace-fallback', root.projectA, [fallback]);

    const config: LibraryConfig = { dataPath: root.workspaceStorage, workspace: root.projectA };
    const page = await library.listSessions(config);
    expect(page.pagination.total).toBe(1);
    expect(page.data[0]).toMatchObject({
      id: fallback.id,
      source: 'workspace-fallback',
      resolvedSource: 'composer',
      resolution: {
        state: 'partial',
        expectedSourceRoles: ['composer'],
        loadedSourceRoles: ['composer'],
        reasonCodes: ['source-unavailable'],
      },
      sourceInstances: [
        expect.objectContaining({
          representation: 'composer-workspace',
          state: 'contributed',
        }),
      ],
    });
    const session = await library.getSession(fallback.id, config);
    expect(session.messages.map(({ content }) => content)).toContain('workspace-fallback-needle');
  });

  it('omits an off-scope same-tier candidate by default and compares it only after opt-in', async () => {
    const root = fixture();
    const scoped = composer(root, 'scope-a-content', root.projectA);
    const offScope = composer(root, 'scope-b-divergent-content', root.projectB);
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [scoped]);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [offScope]);

    const defaultPage = await library.listSessions({
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    });
    expect(defaultPage.pagination.total).toBe(1);
    expect(defaultPage.data).toHaveLength(1);
    expect(defaultPage.data[0]).toMatchObject({
      id: scoped.id,
      resolution: {
        state: 'partial',
        omittedSourceRoles: ['composer'],
        reasonCodes: ['workspace-scope-omitted', 'source-unavailable'],
      },
      sourceInstances: expect.arrayContaining([
        expect.objectContaining({
          representation: 'composer-workspace',
          workspacePaths: [root.projectA],
          state: 'contributed',
        }),
        expect.objectContaining({
          representation: 'composer-workspace',
          workspacePaths: [root.projectB],
          state: 'omitted-by-scope',
        }),
      ]),
    });
    const defaultSession = await library.getSession(scoped.id, {
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
    });
    expect(defaultSession.messages.map(({ content }) => content)).toContain('scope-a-content');
    expect(defaultSession.messages.map(({ content }) => content)).not.toContain(
      'scope-b-divergent-content'
    );

    const diagnostics: unknown[] = [];
    const optedIn = await library.listSessions({
      dataPath: root.workspaceStorage,
      workspace: root.projectA,
      includeCrossWorkspaceSources: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(optedIn.pagination.total).toBe(1);
    expect(optedIn.data).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SESSION_AMBIGUOUS',
        sessionId: scoped.id,
        occurrenceCount: 2,
      }),
    ]);
  });

  it('never lets a divergent global tier fall through to workspace fallback', async () => {
    const root = fixture();
    const workspaceLoader = vi.fn(async (): Promise<ReplicaConsumedPayload> => ({
      messages: [{ id: 'workspace', role: 'user', content: 'workspace fallback' }],
    }));
    const instance = (
      key: string,
      representation: 'composer-global' | 'composer-workspace',
      content: string,
      sourceOrder: number
    ): PhysicalSessionInstance<string> => ({
      instanceKey: key,
      logicalSessionId: SESSION_INTEGRITY_IDS.duplicate,
      sourceRole: 'composer',
      representation,
      fidelityTier: representation === 'composer-global' ? 'complete' : 'partial',
      locator: join(root.root, `${key}.vscdb`),
      workspacePaths: [root.projectA],
      sourceOrder,
      loadConsumedPayload:
        representation === 'composer-workspace'
          ? workspaceLoader
          : async () => ({ messages: [{ id: 'global', role: 'user', content }] }),
    });
    const record = buildSessionCatalog([
      instance('global-a', 'composer-global', 'global-a', 1),
      instance('global-b', 'composer-global', 'global-b', 2),
      instance('workspace', 'composer-workspace', 'workspace fallback', 1),
    ])[0]!;

    const result = await arbitrateComposerContribution(record, {
      diagnosticContextId: 'composer-global-divergence',
    });
    expect(result).toMatchObject({ state: 'ambiguous', selectedTier: 'global-primary' });
    expect(workspaceLoader).not.toHaveBeenCalled();
  });

  it('propagates global database capability failure instead of publishing workspace fallback', async () => {
    const root = fixture();
    const session = composer(root, 'fatal-global-capability');
    writeComposerGlobalSessions(root, [session]);
    writeComposerWorkspaceSummary(root, 'workspace-fallback', root.projectA, [session]);
    const context = storage.createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
    });
    const summaries = await storage.listSessions(
      { all: true, limit: 0, workspacePath: root.projectA },
      root.workspaceStorage,
      undefined,
      context
    );
    expect(summaries).toHaveLength(1);

    const actualOpen = database.openDatabase;
    const globalPath = join(root.globalStorage, 'state.vscdb');
    const spy = vi.spyOn(database, 'openDatabase').mockImplementation(async (path, options) => {
      if (path === globalPath) {
        throw new DatabaseCapabilityError('node:sqlite', 'read-session', ['read']);
      }
      return actualOpen(path, options);
    });
    spies.push(spy);

    await expect(
      storage.getSession(session.id, root.workspaceStorage, undefined, context)
    ).rejects.toMatchObject({ code: 'DATABASE_CAPABILITY_MISSING' });
  });
});
