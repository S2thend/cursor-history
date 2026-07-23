import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as storage from '../../src/core/storage.js';

// Real Store-stack fixture (no Composer vscdb): two Store sessions.
const STORE_ROOT = () => join(process.cwd(), 'tests', 'fixtures', 'store-root');
const UUID1 = 'aaaaaaaa-0000-0000-0000-000000000001'; // has meta.json.cwd
const UUID2 = 'bbbbbbbb-0000-0000-0000-000000000002'; // transcript-only, no path

describe('listWorkspaces — aggregates from the resolved session set', () => {
  it('groups Store sessions by workspacePath; transcript-only → unknown bucket', async () => {
    const workspaces = await storage.listWorkspaces(STORE_ROOT());
    // UUID1 has a cwd; UUID2 is transcript-only with no path → unknown bucket.
    expect(workspaces).toHaveLength(2);
    const paths = workspaces.map((w) => w.path).sort();
    expect(paths).toContain('(unknown workspace)');
    // Every workspace has a stable id and a sessionCount of at least 1.
    expect(workspaces.every((w) => w.id && w.sessionCount >= 1)).toBe(true);
  });

  it('counts each session once (Store-only, no Composer duplication)', async () => {
    const workspaces = await storage.listWorkspaces(STORE_ROOT());
    const total = workspaces.reduce((sum, w) => sum + w.sessionCount, 0);
    expect(total).toBe(2); // UUID1 + UUID2
  });
});

describe('SessionReadContext — one Store discovery per operation', () => {
  it('round-trips a filtered numeric index when global and filtered order conflict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ch-workspace-index-'));
    const sessionA = 'aaaaaaaa-0000-0000-0000-000000000013';
    const sessionB = 'bbbbbbbb-0000-0000-0000-000000000014';
    const writeSession = (
      hash: string,
      id: string,
      cwd: string,
      createdAtMs: number,
      content: string
    ): void => {
      const chatDir = join(root, 'chats', hash, id);
      const transcriptDir = join(root, 'projects', hash, 'agent-transcripts');
      mkdirSync(chatDir, { recursive: true });
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(chatDir, 'meta.json'), JSON.stringify({ cwd, createdAtMs }));
      writeFileSync(
        join(transcriptDir, `${id}.jsonl`),
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: content }] } }) +
          '\n'
      );
    };

    try {
      writeSession('hash-a', sessionA, '/workspace/a', 1783000000000, 'needle-a');
      writeSession('hash-b', sessionB, '/workspace/b', 1784000000000, 'needle-b');

      const global = await storage.listSessions({ limit: 0, all: true }, root);
      expect(global.map((summary) => summary.id)).toEqual([sessionB, sessionA]);

      const context = storage.createSessionReadContext(root);
      const filtered = await storage.listSessions(
        { limit: 0, all: true, workspacePath: '/workspace/a' },
        root,
        undefined,
        context
      );
      expect(filtered.map((summary) => [summary.index, summary.id])).toEqual([[1, sessionA]]);

      const resolved = await storage.getSession(1, root, undefined, context);
      expect(resolved?.id).toBe(sessionA);
      expect(resolved?.messages[0]?.content).toBe('needle-a');

      const foundA = await storage.searchSessions(
        'needle-a',
        { limit: 0, contextChars: 50, workspacePath: '/workspace/a' },
        root
      );
      const foundB = await storage.searchSessions(
        'needle-b',
        { limit: 0, contextChars: 50, workspacePath: '/workspace/a' },
        root
      );
      expect(foundA.map((result) => result.sessionId)).toEqual([sessionA]);
      expect(foundB).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caches Store sessions; a second listing reuses the cached discovery', async () => {
    const ctx = storage.createSessionReadContext(STORE_ROOT());
    const first = await storage.listSessions({ limit: 0, all: true }, STORE_ROOT(), undefined, ctx);
    expect(ctx.storeSessions).not.toBeNull();
    expect(ctx.summaries).not.toBeNull();
    const firstStore = ctx.storeSessions;
    const firstSummaries = ctx.summaries;

    // Re-list with the same scope: both discovery and the complete directory
    // summary are reused; only the requested limit is applied to the result.
    const limited = await storage.listSessions(
      { limit: 1, all: false },
      STORE_ROOT(),
      undefined,
      ctx
    );
    expect(ctx.storeSessions).toBe(firstStore);
    expect(ctx.summaries).toBe(firstSummaries);
    expect(limited).toEqual(first.slice(0, 1));
  });

  it('caches the final Store session and returns isolated copies', async () => {
    const ctx = storage.createSessionReadContext(STORE_ROOT());
    const summaries = await storage.listSessions(
      { limit: 0, all: true },
      STORE_ROOT(),
      undefined,
      ctx
    );
    expect(summaries.length).toBeGreaterThan(0);
    const before = ctx.storeSessions;

    const [first, concurrent] = await Promise.all([
      storage.getSession(UUID1, STORE_ROOT(), undefined, ctx),
      storage.getSession(UUID1, STORE_ROOT(), undefined, ctx),
    ]);
    expect(first).not.toBeNull();
    expect(concurrent).not.toBeNull();
    expect(first!.id).toBe(UUID1);
    expect(ctx.resolvedSessions.size).toBe(1);
    expect(concurrent).not.toBe(first);

    const originalContent = concurrent!.messages[0]!.content;
    first!.messages[0]!.content = 'caller mutation';
    const cached = await storage.getSession(UUID1, STORE_ROOT(), undefined, ctx);
    expect(cached!.messages[0]!.content).toBe(originalContent);
    expect(cached).not.toBe(first);
    // The cached Store corpus is unchanged (no re-discovery during getSession).
    expect(ctx.storeSessions).toBe(before);
  });

  it('keeps a Composer resolution stable within one context and refreshes in a new context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ch-composer-context-'));
    const workspaceStorage = join(root, 'User', 'workspaceStorage');
    const workspaceDir = join(workspaceStorage, 'workspace-a');
    const projectPath = join(root, 'project-a');
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000099';
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      join(workspaceDir, 'workspace.json'),
      JSON.stringify({ folder: pathToFileURL(projectPath).href })
    );

    const db = new BetterSqlite3(join(workspaceDir, 'state.vscdb'));
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const writeComposer = (name: string): void => {
      db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
        'composer.composerData',
        JSON.stringify({
          allComposers: [
            {
              composerId: sessionId,
              name,
              createdAt: 1783000000000,
              lastUpdatedAt: 1783000000000,
            },
          ],
        })
      );
    };

    try {
      writeComposer('initial content');
      const context = storage.createSessionReadContext(workspaceStorage);
      await storage.listSessions(
        { limit: 0, all: true, workspacePath: projectPath },
        workspaceStorage,
        undefined,
        context
      );
      const initial = await storage.getSession(1, workspaceStorage, undefined, context);
      expect(initial?.messages[0]?.content).toBe('initial content');

      writeComposer('updated content');
      const cached = await storage.getSession(1, workspaceStorage, undefined, context);
      expect(cached?.messages[0]?.content).toBe('initial content');

      const freshContext = storage.createSessionReadContext(workspaceStorage);
      await storage.listSessions(
        { limit: 0, all: true, workspacePath: projectPath },
        workspaceStorage,
        undefined,
        freshContext
      );
      const refreshed = await storage.getSession(1, workspaceStorage, undefined, freshContext);
      expect(refreshed?.messages[0]?.content).toBe('updated content');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a workspace-filtered numeric index against the cached filtered summaries', async () => {
    const ctx = storage.createSessionReadContext(STORE_ROOT());
    const summaries = await storage.listSessions(
      { limit: 0, all: true, workspacePath: '/mnt/d/1_yuyu_proj/cursor-history' },
      STORE_ROOT(),
      undefined,
      ctx
    );

    expect(summaries).toHaveLength(1);
    expect(ctx.summaries).toBe(summaries);
    const session = await storage.getSession(1, STORE_ROOT(), undefined, ctx);
    expect(session?.id).toBe(summaries[0]!.id);
    expect(session?.workspacePath).toBe(summaries[0]!.workspacePath);
  });

  it('normalizes equivalent WSL and Windows workspace filters without suffix matches', async () => {
    const context = storage.createSessionReadContext(STORE_ROOT());
    const equivalent = await storage.listSessions(
      { limit: 0, all: true, workspacePath: 'D:\\1_yuyu_proj\\cursor-history' },
      STORE_ROOT(),
      undefined,
      context
    );
    const sameScope = await storage.listSessions(
      { limit: 0, all: true, workspacePath: '/mnt/d/1_yuyu_proj/cursor-history' },
      STORE_ROOT(),
      undefined,
      context
    );
    const suffixOnly = await storage.listSessions(
      { limit: 0, all: true, workspacePath: '/1_yuyu_proj/cursor-history' },
      STORE_ROOT()
    );

    expect(equivalent.map((session) => session.id)).toEqual([UUID1]);
    expect(sameScope).toBe(context.summaries);
    expect(suffixOnly).toEqual([]);
  });

  it('rejects reusing a context for a different workspace scope', async () => {
    const ctx = storage.createSessionReadContext(STORE_ROOT());
    await storage.listSessions(
      { limit: 0, all: true, workspacePath: '/workspace/a' },
      STORE_ROOT(),
      undefined,
      ctx
    );

    await expect(
      storage.listSessions(
        { limit: 0, all: true, workspacePath: '/workspace/b' },
        STORE_ROOT(),
        undefined,
        ctx
      )
    ).rejects.toThrow('SessionReadContext workspace scope mismatch');
  });

  it('rejects reusing a context for a different data source', async () => {
    const ctx = storage.createSessionReadContext(STORE_ROOT());

    await expect(
      storage.listSessions({ limit: 0, all: true }, join(STORE_ROOT(), 'other'), undefined, ctx)
    ).rejects.toThrow('SessionReadContext source mismatch');
  });
});
