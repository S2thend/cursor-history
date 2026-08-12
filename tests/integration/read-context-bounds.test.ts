import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterIoEvent } from '../../src/core/io-observer.js';
import * as storage from '../../src/core/storage.js';
import * as library from '../../src/lib/index.js';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

interface OwnershipSnapshot {
  readonly resolvedSessionCapacity: number;
  readonly activeResolutions: number;
  readonly completedSessions: number;
  readonly discoveryDecodedSessions: number;
  readonly ownedDecodedSessions: number;
  readonly resolutionStarts: number;
}

interface InstrumentedReadContext extends storage.SessionReadContext {
  readonly resolvedSessionCapacity: number;
  readonly disposed: boolean;
  releaseSession(sessionId: string): void;
  dispose(): Promise<void>;
}

interface InstrumentedContextOptions {
  dataPath?: string;
  backupPath?: string;
  workspacePath?: string;
  resolvedSessionCapacity?: number;
  ioObserver?: (event: Readonly<AdapterIoEvent>) => void;
  testOnlyOnOwnershipChange?: (snapshot: Readonly<OwnershipSnapshot>) => void;
}

const fixtures: SessionIntegrityFixtureRoot[] = [];
const originalStoreRoot = process.env['CURSOR_STORE_ROOT'];

function newFixture(prefix = 'cursor-history-context-bounds-'): SessionIntegrityFixtureRoot {
  const fixture = createSessionIntegrityFixtureRoot(prefix);
  fixtures.push(fixture);
  process.env['CURSOR_STORE_ROOT'] = fixture.storeRoot;
  return fixture;
}

function createInstrumentedContext(
  options: InstrumentedContextOptions,
  snapshots: OwnershipSnapshot[] = []
): InstrumentedReadContext {
  const create = storage.createSessionReadContext as unknown as (
    options: InstrumentedContextOptions
  ) => InstrumentedReadContext;
  return create({
    ...options,
    testOnlyOnOwnershipChange: (snapshot) => {
      snapshots.push({ ...snapshot });
      options.testOnlyOnOwnershipChange?.(snapshot);
    },
  });
}

function assertOwnershipBound(snapshot: Readonly<OwnershipSnapshot>): void {
  const values = [
    snapshot.resolvedSessionCapacity,
    snapshot.activeResolutions,
    snapshot.completedSessions,
    snapshot.discoveryDecodedSessions,
    snapshot.ownedDecodedSessions,
    snapshot.resolutionStarts,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Ownership counters must be nonnegative safe integers.');
  }
  if (snapshot.completedSessions > snapshot.resolvedSessionCapacity) {
    throw new Error('Completed-session retention exceeded C.');
  }
  const inactiveOwned = snapshot.completedSessions + snapshot.discoveryDecodedSessions;
  if (
    snapshot.ownedDecodedSessions < inactiveOwned ||
    snapshot.ownedDecodedSessions > inactiveOwned + snapshot.activeResolutions
  ) {
    throw new Error('Decoded-session ownership counters are internally inconsistent.');
  }
  if (
    snapshot.ownedDecodedSessions >
    snapshot.resolvedSessionCapacity + snapshot.activeResolutions
  ) {
    throw new Error('Decoded-session ownership exceeded C+A.');
  }
}

function assertTraceWithinBound(snapshots: readonly OwnershipSnapshot[]): void {
  expect(snapshots.length).toBeGreaterThan(0);
  for (const snapshot of snapshots) assertOwnershipBound(snapshot);
}

function composerSessions(
  fixture: SessionIntegrityFixtureRoot,
  count: number
): ComposerFixtureSession[] {
  const sessions = Array.from({ length: count }, (_, index) => {
    const ordinal = String(index + 1).padStart(12, '0');
    const createdAt = 1_700_000_000_000 + index;
    return {
      id: `cccccccc-1111-4111-8111-${ordinal}`,
      title: `Bounded session ${index + 1}`,
      workspacePath: fixture.projectA,
      createdAt,
      messages: [
        {
          id: `native-${index + 1}`,
          role: 'user' as const,
          content: `needle-bounded-${index + 1}`,
          createdAt,
        },
      ],
    };
  });
  writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, sessions);
  writeComposerGlobalSessions(fixture, sessions);
  return sessions;
}

function comparableSession(session: Awaited<ReturnType<typeof storage.getSession>>) {
  if (!session) return null;
  return {
    id: session.id,
    workspacePath: session.workspacePath,
    messages: session.messages.map(({ id, role, content }) => ({ id, role, content })),
  };
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (originalStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = originalStoreRoot;
});

describe('SessionReadContext operation order and ownership bounds', () => {
  it('returns the same scoped result for get-before-list and list-before-get', async () => {
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);

    const getFirstContext = createInstrumentedContext({
      dataPath: fixture.workspaceStorage,
      workspacePath: fixture.projectA,
    });
    const getFirst = await storage.getSession(
      sessionA.id,
      fixture.workspaceStorage,
      undefined,
      getFirstContext
    );
    const getFirstRows = await storage.listSessions(
      { all: true, limit: 0, workspacePath: fixture.projectA },
      fixture.workspaceStorage,
      undefined,
      getFirstContext
    );

    const listFirstContext = createInstrumentedContext({
      dataPath: fixture.workspaceStorage,
      workspacePath: fixture.projectA,
    });
    const listFirstRows = await storage.listSessions(
      { all: true, limit: 0, workspacePath: fixture.projectA },
      fixture.workspaceStorage,
      undefined,
      listFirstContext
    );
    const listFirst = await storage.getSession(
      sessionA.id,
      fixture.workspaceStorage,
      undefined,
      listFirstContext
    );

    expect(getFirstRows.map(({ id, index }) => ({ id, index }))).toEqual(
      listFirstRows.map(({ id, index }) => ({ id, index }))
    );
    expect(comparableSession(getFirst)).toEqual(comparableSession(listFirst));
    expect(getFirst?.id).toBe(sessionA.id);

    await Promise.all([getFirstContext.dispose(), listFirstContext.dispose()]);
  });

  it('rejects conflicting immutable source and scope bindings before adapter I/O', async () => {
    const fixture = newFixture();
    seedConflictingWorkspaceCorpus(fixture);
    const events: AdapterIoEvent[] = [];
    const context = createInstrumentedContext({
      dataPath: fixture.workspaceStorage,
      workspacePath: fixture.projectA,
      ioObserver: (event) => events.push({ ...event }),
    });

    await expect(
      storage.listSessions(
        { all: true, limit: 0, workspacePath: fixture.projectB },
        fixture.workspaceStorage,
        undefined,
        context
      )
    ).rejects.toMatchObject({ code: 'READ_CONTEXT_SCOPE_MISMATCH' });
    expect(events).toEqual([]);

    await expect(
      storage.listSessions(
        { all: true, limit: 0, workspacePath: fixture.projectA },
        `${fixture.workspaceStorage}-other`,
        undefined,
        context
      )
    ).rejects.toMatchObject({ code: 'READ_CONTEXT_SOURCE_MISMATCH' });
    expect(events).toEqual([]);
    await context.dispose();
  });

  it('coalesces concurrent same-key work into one active resolution', async () => {
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const snapshots: OwnershipSnapshot[] = [];
    const context = createInstrumentedContext(
      {
        dataPath: fixture.workspaceStorage,
        workspacePath: fixture.projectA,
        resolvedSessionCapacity: 1,
      },
      snapshots
    );
    await storage.listSessions(
      { all: true, limit: 0, workspacePath: fixture.projectA },
      fixture.workspaceStorage,
      undefined,
      context
    );

    const [first, second] = await Promise.all([
      storage.getSession(sessionA.id, fixture.workspaceStorage, undefined, context),
      storage.getSession(sessionA.id, fixture.workspaceStorage, undefined, context),
    ]);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(snapshots.at(-1)?.resolutionStarts).toBe(1);
    expect(Math.max(...snapshots.map((snapshot) => snapshot.activeResolutions))).toBe(1);
    assertTraceWithinBound(snapshots);
    await context.dispose();
  });

  it('removes a rejected resolution so the same key can be retried', async () => {
    const fixture = newFixture();
    const { sessionA } = seedConflictingWorkspaceCorpus(fixture);
    const snapshots: OwnershipSnapshot[] = [];
    let rejectNextPayloadOpen = false;
    const context = createInstrumentedContext(
      {
        dataPath: fixture.workspaceStorage,
        workspacePath: fixture.projectA,
        resolvedSessionCapacity: 1,
        ioObserver: (event) => {
          if (
            rejectNextPayloadOpen &&
            event.operation === 'open' &&
            event.resourceClass === 'global-composer' &&
            event.logicalSessionId === sessionA.id
          ) {
            rejectNextPayloadOpen = false;
            throw new Error('synthetic one-shot payload rejection');
          }
        },
      },
      snapshots
    );
    await storage.listSessions(
      { all: true, limit: 0, workspacePath: fixture.projectA },
      fixture.workspaceStorage,
      undefined,
      context
    );

    rejectNextPayloadOpen = true;
    await expect(
      storage.getSession(sessionA.id, fixture.workspaceStorage, undefined, context)
    ).rejects.toThrow('synthetic one-shot payload rejection');
    expect(snapshots.at(-1)).toMatchObject({ activeResolutions: 0, completedSessions: 0 });

    const retried = await storage.getSession(
      sessionA.id,
      fixture.workspaceStorage,
      undefined,
      context
    );
    expect(retried?.id).toBe(sessionA.id);
    expect(snapshots.at(-1)?.resolutionStarts).toBe(2);
    assertTraceWithinBound(snapshots);
    await context.dispose();
  });

  it('keeps N and 2N sequential corpora within the same C+A peak', async () => {
    const peakOwnership: number[] = [];
    for (const count of [4, 8]) {
      const fixture = newFixture(`cursor-history-context-${count}-`);
      const sessions = composerSessions(fixture, count);
      const snapshots: OwnershipSnapshot[] = [];
      const context = createInstrumentedContext(
        {
          dataPath: fixture.workspaceStorage,
          workspacePath: fixture.projectA,
          resolvedSessionCapacity: 1,
        },
        snapshots
      );
      const rows = await storage.listSessions(
        { all: true, limit: 0, workspacePath: fixture.projectA },
        fixture.workspaceStorage,
        undefined,
        context
      );
      expect(rows).toHaveLength(count);

      for (const session of sessions) {
        await expect(
          storage.getSession(session.id, fixture.workspaceStorage, undefined, context)
        ).resolves.toMatchObject({ id: session.id });
      }

      expect(snapshots.at(-1)?.resolutionStarts).toBe(count);
      expect(Math.max(...snapshots.map((snapshot) => snapshot.completedSessions))).toBe(1);
      expect(
        Math.max(...snapshots.map((snapshot) => snapshot.ownedDecodedSessions))
      ).toBeLessThanOrEqual(2);
      peakOwnership.push(Math.max(...snapshots.map((snapshot) => snapshot.ownedDecodedSessions)));
      assertTraceWithinBound(snapshots);

      await context.dispose();
      expect(snapshots.at(-1)).toMatchObject({
        activeResolutions: 0,
        completedSessions: 0,
        discoveryDecodedSessions: 0,
        ownedDecodedSessions: 0,
      });
    }
    expect(peakOwnership).toHaveLength(2);
    expect(peakOwnership[1]).toBe(peakOwnership[0]);
  });

  it('uses C=0 for caller-bound core and public bulk operations', async () => {
    const fixture = newFixture();
    const sessions = composerSessions(fixture, 3);

    const coreSnapshots: OwnershipSnapshot[] = [];
    const coreContext = createInstrumentedContext(
      {
        dataPath: fixture.workspaceStorage,
        workspacePath: fixture.projectA,
        resolvedSessionCapacity: 0,
      },
      coreSnapshots
    );
    const coreResults = await storage.searchSessions(
      'needle-bounded',
      { limit: 0, contextChars: 20, workspacePath: fixture.projectA },
      fixture.workspaceStorage,
      undefined,
      coreContext
    );
    expect(coreResults.map((result) => result.sessionId).sort()).toEqual(
      sessions.map((session) => session.id).sort()
    );
    expect(coreSnapshots.every((snapshot) => snapshot.completedSessions === 0)).toBe(true);
    assertTraceWithinBound(coreSnapshots);
    await coreContext.dispose();

    const publicSnapshots: OwnershipSnapshot[] = [];
    const publicContext = createInstrumentedContext(
      {
        dataPath: fixture.workspaceStorage,
        workspacePath: fixture.projectA,
        resolvedSessionCapacity: 0,
      },
      publicSnapshots
    );
    const publicApi = library as unknown as {
      searchSessions(
        query: string,
        config: Record<string, unknown>
      ): Promise<Array<{ session: { id: string } }>>;
      exportAllSessionsToJson(config: Record<string, unknown>): Promise<string>;
    };
    const publicResults = await publicApi.searchSessions('needle-bounded', {
      dataPath: fixture.workspaceStorage,
      workspace: fixture.projectA,
      readContext: publicContext,
    });
    const exported = await publicApi.exportAllSessionsToJson({
      dataPath: fixture.workspaceStorage,
      workspace: fixture.projectA,
      readContext: publicContext,
    });

    expect(publicResults.map((result) => result.session.id).sort()).toEqual(
      sessions.map((session) => session.id).sort()
    );
    expect(JSON.parse(exported)).toHaveLength(3);
    expect(publicSnapshots.every((snapshot) => snapshot.completedSessions === 0)).toBe(true);
    expect(publicContext.disposed).toBe(false);
    assertTraceWithinBound(publicSnapshots);
    await publicContext.dispose();
  });

  it('retains no decoded Store conversation corpus during discovery', async () => {
    const fixture = newFixture();
    for (let index = 0; index < 4; index++) {
      writeStoreDb(fixture, `eeeeeeee-2222-4222-8222-${String(index + 1).padStart(12, '0')}`, [
        { role: 'user', content: `store discovery payload ${index + 1}` },
      ]);
    }
    const snapshots: OwnershipSnapshot[] = [];
    const context = createInstrumentedContext(
      { dataPath: fixture.workspaceStorage, resolvedSessionCapacity: 1 },
      snapshots
    );

    const rows = await storage.listSessions(
      { all: true, limit: 0 },
      fixture.workspaceStorage,
      undefined,
      context
    );

    expect(rows).toHaveLength(4);
    expect(snapshots.every((snapshot) => snapshot.discoveryDecodedSessions === 0)).toBe(true);
    expect(snapshots.at(-1)?.ownedDecodedSessions).toBe(0);
    assertTraceWithinBound(snapshots);
    await context.dispose();
  });

  it('makes the ownership assertion fail on a deliberate over-retention fault', () => {
    const faulty: OwnershipSnapshot = {
      resolvedSessionCapacity: 1,
      activeResolutions: 1,
      completedSessions: 2,
      discoveryDecodedSessions: 1,
      ownedDecodedSessions: 3,
      resolutionStarts: 3,
    };

    expect(() => assertOwnershipBound(faulty)).toThrow('Completed-session retention exceeded C');
  });
});
