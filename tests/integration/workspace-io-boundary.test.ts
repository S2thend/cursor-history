import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import type { DatabaseOperationRequest } from '../../src/core/database/types.js';
import { openObservedDatabase } from '../../src/core/database/observed.js';
import {
  createOperationIoContext,
  IoObserverError,
  type AdapterIoEvent,
} from '../../src/core/io-observer.js';
import { SOURCE_READ_LIMITS_V1_DEFAULTS } from '../../src/core/source-read-limits.js';
import {
  createSessionReadContext,
  getSession,
  listSessions,
  searchSessions,
} from '../../src/core/storage.js';
import { readBackupManifest } from '../../src/core/backup.js';
import { discoverStoreSessions } from '../../src/core/store-stack/discover.js';
import { parseStoreDb } from '../../src/core/store-stack/store-db.js';
import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';
import {
  createFixtureBackup,
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  SESSION_INTEGRITY_IDS,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  writeStoreMeta,
  writeStoreTranscript,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import {
  assertNoSessionPayloadIo,
  combineIoObservers,
  createIoEventRecorder,
  createPoisonCanary,
  createPoisonIoObserver,
} from '../helpers/io-probe.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-io-boundary-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

function ioContext(
  emit: (event: Readonly<AdapterIoEvent>) => void,
  suffix: string
): ReturnType<typeof createOperationIoContext> {
  return createOperationIoContext({
    contextId: `io-boundary:${suffix}`,
    dataSourceIdentity: `fixture:${suffix}`,
    sourceReadLimits: SOURCE_READ_LIMITS_V1_DEFAULTS,
    emit,
  });
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe('operation-bound low-level I/O observation', () => {
  it.each(['prepare', 'query', 'get'] as const)(
    'fails closed when the global Composer metadata %s boundary rejects during hydration',
    async (operation) => {
      const root = fixture();
      seedConflictingWorkspaceCorpus(root);
      const recorder = createIoEventRecorder();
      let armed = false;
      const context = createSessionReadContext({
        dataPath: root.workspaceStorage,
        workspacePath: root.projectA,
        ioObserver: combineIoObservers(recorder.observer, (event) => {
          if (
            armed &&
            event.operation === operation &&
            event.resourceClass === 'global-composer' &&
            event.logicalSessionId === SESSION_INTEGRITY_IDS.workspaceA
          ) {
            throw new Error(`reject ${operation}`);
          }
        }),
      });
      try {
        const rows = await listSessions(
          { all: true, limit: 0, workspacePath: root.projectA },
          root.workspaceStorage,
          undefined,
          context
        );
        expect(rows).toHaveLength(1);
        armed = true;
        await expect(
          getSession(SESSION_INTEGRITY_IDS.workspaceA, root.workspaceStorage, undefined, context)
        ).rejects.toBeInstanceOf(IoObserverError);
        expect(
          recorder.count({
            operation,
            resourceClass: 'global-composer',
            logicalSessionId: SESSION_INTEGRITY_IDS.workspaceA,
          })
        ).toBeGreaterThan(0);
      } finally {
        await context.dispose();
      }
    }
  );

  it('classifies off-scope Composer UUID projection as catalog metadata', async () => {
    const root = fixture();
    const duplicateId = SESSION_INTEGRITY_IDS.duplicate;
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [
      {
        id: duplicateId,
        title: 'Selected replica',
        workspacePath: root.projectA,
        createdAt: 1_700_000_000_000,
        messages: [{ role: 'user', content: 'selected replica' }],
      },
    ]);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [
      {
        id: duplicateId,
        title: 'Off-scope replica',
        workspacePath: root.projectB,
        createdAt: 1_700_000_000_000,
        messages: [{ role: 'user', content: 'off-scope replica' }],
      },
    ]);

    const recorder = createIoEventRecorder();
    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      ioObserver: recorder.observer,
    });
    try {
      await listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      );

      expect(
        recorder.count({
          adapter: 'sqlite',
          operation: 'query',
          resourceClass: 'workspace-session-index',
          classification: 'catalog-metadata',
        })
      ).toBeGreaterThan(0);
      expect(
        recorder.count({
          adapter: 'sqlite',
          operation: 'query',
          resourceClass: 'global-composer',
          classification: 'conversation-payload',
        })
      ).toBe(0);
    } finally {
      await context.dispose();
    }
  });

  it('propagates observer rejection from an off-scope Composer UUID metadata query', async () => {
    const root = fixture();
    const duplicateId = SESSION_INTEGRITY_IDS.duplicate;
    writeComposerWorkspaceSummary(root, 'workspace-a', root.projectA, [
      {
        id: duplicateId,
        title: 'Selected replica',
        workspacePath: root.projectA,
        createdAt: 1_700_000_000_000,
        messages: [{ role: 'user', content: 'selected replica' }],
      },
    ]);
    writeComposerWorkspaceSummary(root, 'workspace-b', root.projectB, [
      {
        id: duplicateId,
        title: 'Off-scope replica',
        workspacePath: root.projectB,
        createdAt: 1_700_000_000_000,
        messages: [{ role: 'user', content: 'off-scope replica' }],
      },
    ]);

    const recorder = createIoEventRecorder();
    const poison = createPoisonIoObserver(
      {
        adapter: 'sqlite',
        operation: 'query',
        resourceClass: 'workspace-session-index',
        classification: 'catalog-metadata',
      },
      'off-scope workspace UUID projection'
    );
    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      ioObserver: combineIoObservers(recorder.observer, poison),
    });
    try {
      await expect(
        listSessions(
          { all: true, limit: 0, workspacePath: root.projectA },
          root.workspaceStorage,
          undefined,
          context
        )
      ).rejects.toBeInstanceOf(IoObserverError);
      expect(
        recorder.count({
          adapter: 'sqlite',
          operation: 'query',
          resourceClass: 'workspace-session-index',
          classification: 'catalog-metadata',
        })
      ).toBe(1);
    } finally {
      await context.dispose();
    }
  });

  it('records safe metadata and payload events across live, Store, SQLite, key-value, and backup reads', async () => {
    const root = fixture();
    seedConflictingWorkspaceCorpus(root);
    const transcriptSecret = 'store-transcript-secret';
    writeStoreTranscript(root, 'project-a', SESSION_INTEGRITY_IDS.storeOnly, [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: transcriptSecret }] },
      },
    ]);
    const storeDbPath = writeStoreDb(root, SESSION_INTEGRITY_IDS.storeOnly, [
      { role: 'assistant', content: 'store-db-secret' },
    ]);

    const recorder = createIoEventRecorder();
    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      ioObserver: recorder.observer,
    });
    await listSessions(
      { all: true, limit: 0, workspacePath: root.projectA },
      root.workspaceStorage,
      undefined,
      context
    );

    const storeIo = ioContext(recorder.observer, 'store');
    await discoverStoreSessions(root.storeRoot, { io: storeIo });
    await parseStoreDb(storeDbPath, {
      io: storeIo,
      logicalSessionId: SESSION_INTEGRITY_IDS.storeOnly,
    });

    const backupPath = await createFixtureBackup(root, 'observed.zip');
    const backupOptions = { io: ioContext(recorder.observer, 'backup') };
    expect(await readBackupManifest(backupPath, backupOptions)).not.toBeNull();

    expect(recorder.count({ resourceClass: 'workspace-root-directory' })).toBeGreaterThan(0);
    expect(recorder.count({ resourceClass: 'workspace-membership-json' })).toBeGreaterThan(0);
    expect(
      recorder.count({ adapter: 'sqlite', resourceClass: 'workspace-conversation' })
    ).toBeGreaterThan(0);
    expect(recorder.count({ adapter: 'sqlite', operation: 'prepare' })).toBeGreaterThan(0);
    expect(recorder.count({ adapter: 'sqlite', operation: 'query' })).toBeGreaterThan(0);
    expect(recorder.count({ adapter: 'key-value', operation: 'get' })).toBeGreaterThan(0);
    expect(
      recorder.count({ adapter: 'filesystem', resourceClass: 'store-transcript' })
    ).toBeGreaterThan(0);
    expect(recorder.count({ adapter: 'sqlite', operation: 'backup' })).toBeGreaterThan(0);
    expect(recorder.count({ resourceClass: 'store-leaf' })).toBeGreaterThan(0);
    expect(recorder.count({ resourceClass: 'backup-central-directory' })).toBeGreaterThan(0);
    expect(recorder.count({ resourceClass: 'backup-manifest' })).toBeGreaterThan(0);

    const serialized = JSON.stringify(recorder.snapshot());
    for (const forbidden of [
      root.root,
      'needle-a',
      'needle-b',
      transcriptSecret,
      'store-db-secret',
      'SELECT ',
      'composer.composerData',
      'bubbleId:',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.isFrozen(context.io)).toBe(true);
    expect(recorder.snapshot().every((event) => Object.isFrozen(event))).toBe(true);
  });

  it('fails closed before the underlying open and makes an observer bypass fault visible', async () => {
    const root = fixture();
    seedConflictingWorkspaceCorpus(root);
    const transcriptPath = writeStoreTranscript(
      root,
      'project-a',
      SESSION_INTEGRITY_IDS.storeOnly,
      [{ role: 'user', message: { content: [{ type: 'text', text: 'poison transcript' }] } }]
    );
    const storeDbPath = writeStoreDb(root, SESSION_INTEGRITY_IDS.storeOnly, [
      { role: 'assistant', content: 'poison leaf' },
    ]);
    const recorder = createIoEventRecorder();
    const poison = createPoisonIoObserver(
      { adapter: 'sqlite', operation: 'open', resourceClass: 'workspace-conversation' },
      'workspace-payload-open'
    );
    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      ioObserver: combineIoObservers(recorder.observer, poison),
    });

    await expect(
      listSessions(
        { all: true, limit: 0, workspacePath: root.projectA },
        root.workspaceStorage,
        undefined,
        context
      )
    ).rejects.toBeInstanceOf(IoObserverError);
    expect(
      recorder.count({
        adapter: 'sqlite',
        operation: 'open',
        resourceClass: 'workspace-conversation',
      })
    ).toBe(1);

    const request: DatabaseOperationRequest = {
      operation: 'read-session',
      required: new Set(['read']),
      ioResource: { resourceClass: 'workspace-conversation' },
    };
    const protectedOpen = createPoisonCanary('protected database open');
    expect(() =>
      openObservedDatabase(
        ioContext(createPoisonIoObserver({ operation: 'open' }), 'poison'),
        request,
        () => protectedOpen.touch()
      )
    ).toThrow(IoObserverError);
    protectedOpen.assertUntouched();

    const bypassedOpen = createPoisonCanary('observer bypass');
    expect(() => openObservedDatabase(undefined, request, () => bypassedOpen.touch())).toThrow(
      'Poison canary touched: observer bypass'
    );
    expect(bypassedOpen.touched).toBe(true);

    expect(() =>
      parseTranscriptFile(
        transcriptPath,
        SOURCE_READ_LIMITS_V1_DEFAULTS,
        'fatal',
        undefined,
        ioContext(
          createPoisonIoObserver({
            adapter: 'filesystem',
            operation: 'read',
            resourceClass: 'store-transcript',
          }),
          'transcript-poison'
        ),
        SESSION_INTEGRITY_IDS.storeOnly
      )
    ).toThrow(IoObserverError);

    await expect(
      parseStoreDb(storeDbPath, {
        io: ioContext(
          createPoisonIoObserver({
            adapter: 'key-value',
            operation: 'get',
            resourceClass: 'store-database',
          }),
          'key-value-poison'
        ),
        logicalSessionId: SESSION_INTEGRITY_IDS.storeOnly,
      })
    ).rejects.toBeInstanceOf(IoObserverError);

    await expect(
      parseStoreDb(storeDbPath, {
        io: ioContext(
          createPoisonIoObserver({
            adapter: 'key-value',
            operation: 'get',
            resourceClass: 'store-leaf',
          }),
          'blob-poison'
        ),
        logicalSessionId: SESSION_INTEGRITY_IDS.storeOnly,
      })
    ).rejects.toBeInstanceOf(IoObserverError);
  });

  it('keeps default payload I/O inside the selected workspace and opt-in broadening ID-bound', async () => {
    const root = fixture();
    seedConflictingWorkspaceCorpus(root);

    const defaultRecorder = createIoEventRecorder();
    const defaultContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: false,
      ioObserver: defaultRecorder.observer,
    });
    const defaultRows = await listSessions(
      {
        all: true,
        limit: 0,
        workspacePath: root.projectA,
        includeCrossWorkspaceSources: false,
      },
      root.workspaceStorage,
      undefined,
      defaultContext
    );

    const optInRecorder = createIoEventRecorder();
    const optInContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
      ioObserver: optInRecorder.observer,
    });
    const optInRows = await listSessions(
      {
        all: true,
        limit: 0,
        workspacePath: root.projectA,
        includeCrossWorkspaceSources: true,
      },
      root.workspaceStorage,
      undefined,
      optInContext
    );

    expect(defaultRows.map((row) => row.id)).toEqual([SESSION_INTEGRITY_IDS.workspaceA]);
    expect(optInRows.map((row) => row.id)).toEqual([SESSION_INTEGRITY_IDS.workspaceA]);
    expect(defaultRecorder.count({ classification: 'conversation-payload' })).toBeGreaterThan(0);
    expect(optInRecorder.count({ classification: 'conversation-payload' })).toBeGreaterThanOrEqual(
      defaultRecorder.count({ classification: 'conversation-payload' })
    );
    assertNoSessionPayloadIo(defaultRecorder.snapshot(), SESSION_INTEGRITY_IDS.workspaceB);
    assertNoSessionPayloadIo(optInRecorder.snapshot(), SESSION_INTEGRITY_IDS.workspaceB);

    // The selected workspace is opened once for catalog attribution and once
    // for the actual listing. Opening workspace B during either read would make
    // this count exceed two even though its results were later filtered out.
    expect(
      defaultRecorder.count({
        adapter: 'sqlite',
        operation: 'open',
        resourceClass: 'workspace-conversation',
      })
    ).toBe(2);
  });

  it('marks a pathless Store counterpart omitted by default and hydrates it only after opt-in', async () => {
    const root = fixture();
    seedConflictingWorkspaceCorpus(root);
    writeStoreDb(
      root,
      SESSION_INTEGRITY_IDS.workspaceA,
      [{ role: 'assistant', content: 'selected Store enrichment' }],
      'Store counterpart'
    );

    const defaultRecorder = createIoEventRecorder();
    const defaultContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: false,
      ioObserver: defaultRecorder.observer,
    });
    const defaultRows = await listSessions(
      {
        all: true,
        limit: 0,
        workspacePath: root.projectA,
        includeCrossWorkspaceSources: false,
      },
      root.workspaceStorage,
      undefined,
      defaultContext
    );

    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0]).toMatchObject({
      id: SESSION_INTEGRITY_IDS.workspaceA,
      resolvedSource: 'composer',
      resolutionState: 'partial',
      resolution: {
        omittedSourceRoles: ['store'],
        reasonCodes: ['workspace-scope-omitted'],
      },
      sourceInstances: expect.arrayContaining([
        expect.objectContaining({ sourceRole: 'store', state: 'omitted-by-scope' }),
      ]),
    });
    const composerOnly = await getSession(
      SESSION_INTEGRITY_IDS.workspaceA,
      root.workspaceStorage,
      undefined,
      defaultContext
    );
    expect(composerOnly?.messages.map(({ content }) => content)).toEqual(['needle-a']);
    await expect(
      searchSessions(
        'selected Store enrichment',
        {
          limit: 0,
          contextChars: 50,
          workspacePath: root.projectA,
          includeCrossWorkspaceSources: false,
        },
        root.workspaceStorage,
        undefined,
        defaultContext
      )
    ).resolves.toEqual([]);
    defaultRecorder.assertNone(
      { classification: 'conversation-payload', sourceRole: 'store' },
      'default workspace read must not decode a pathless Store counterpart'
    );

    const optInRecorder = createIoEventRecorder();
    const optInContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
      ioObserver: optInRecorder.observer,
    });
    const optInRows = await listSessions(
      {
        all: true,
        limit: 0,
        workspacePath: root.projectA,
        includeCrossWorkspaceSources: true,
      },
      root.workspaceStorage,
      undefined,
      optInContext
    );
    expect(optInRows).toHaveLength(1);
    expect(optInRows[0]?.resolvedSource).toBe('merged');

    const merged = await getSession(
      SESSION_INTEGRITY_IDS.workspaceA,
      root.workspaceStorage,
      undefined,
      optInContext
    );
    expect(merged?.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining(['needle-a', 'selected Store enrichment'])
    );
    expect(
      optInRecorder.count({ classification: 'conversation-payload', sourceRole: 'store' })
    ).toBeGreaterThan(0);
  });

  it('probes a selected Store UUID in global Composer metadata without decoding it before opt-in', async () => {
    const root = fixture();
    const id = SESSION_INTEGRITY_IDS.duplicate;
    writeComposerGlobalSessions(root, [
      {
        id,
        title: 'Global counterpart',
        workspacePath: root.projectA,
        createdAt: 1_783_000_000_000,
        messages: [
          {
            id: 'global-message',
            role: 'user',
            content: 'global counterpart payload',
            createdAt: 1_783_000_000_000,
          },
        ],
      },
    ]);
    const storePath = writeStoreDb(root, id, [
      { role: 'assistant', content: 'selected Store payload' },
    ]);
    writeStoreMeta(dirname(storePath), {
      cwd: root.projectA,
      title: 'Selected Store',
      hasConversation: true,
      createdAtMs: 1_783_000_000_000,
    });

    const defaultRecorder = createIoEventRecorder();
    const defaultContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      ioObserver: defaultRecorder.observer,
    });
    const defaultRows = await listSessions(
      { all: true, limit: 0, workspacePath: root.projectA },
      root.workspaceStorage,
      undefined,
      defaultContext
    );
    expect(defaultRows[0]).toMatchObject({
      id,
      resolution: { omittedSourceRoles: ['composer'] },
    });
    expect(
      defaultRecorder.count({
        classification: 'catalog-metadata',
        resourceClass: 'global-bubble-index',
        logicalSessionId: id,
      })
    ).toBeGreaterThan(0);
    defaultRecorder.assertNone(
      { classification: 'conversation-payload', sourceRole: 'composer' },
      'default Store-selected read must not decode its global Composer counterpart'
    );
    await defaultContext.dispose();

    const optInRecorder = createIoEventRecorder();
    const optInContext = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: root.projectA,
      includeCrossWorkspaceSources: true,
      ioObserver: optInRecorder.observer,
    });
    const optedIn = await listSessions(
      {
        all: true,
        limit: 0,
        workspacePath: root.projectA,
        includeCrossWorkspaceSources: true,
      },
      root.workspaceStorage,
      undefined,
      optInContext
    );
    expect(optedIn[0]).toMatchObject({ id, resolvedSource: 'merged' });
    expect(
      optInRecorder.count({ classification: 'conversation-payload', sourceRole: 'composer' })
    ).toBeGreaterThan(0);
    await optInContext.dispose();
  });
});
