/**
 * The UI server is a read-only HTTP surface over `src/core`. These tests pin the
 * contract the browser client depends on: route shapes, error codes, and the
 * local-only access rule.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startUiServer, type UiServerHandle } from '../../src/ui/server.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];
const servers: UiServerHandle[] = [];

interface HttpResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

/** Issue a plain HTTP request, with an optional forged Host header. */
function httpGet(
  port: number,
  path: string,
  options: { method?: string; host?: string } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        ...(options.host ? { setHost: false, headers: { host: options.host } } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function json<T>(response: HttpResponse): T {
  return JSON.parse(response.body) as T;
}

async function startServer(root: SessionIntegrityFixtureRoot): Promise<UiServerHandle> {
  process.env['CURSOR_STORE_ROOT'] = root.storeRoot;
  const handle = await startUiServer({
    dataPath: root.workspaceStorage,
    host: '127.0.0.1',
    port: 0,
  });
  servers.push(handle);
  return handle;
}

beforeEach(() => {
  const root = createSessionIntegrityFixtureRoot('cursor-history-ui-server-');
  fixtures.push(root);
  const projectSessions = [
    {
      id: '11111111-2222-4333-8444-555555555555',
      title: 'Alpha session',
      workspacePath: root.projectA,
      createdAt: 1_750_000_000_000,
      messages: [
        { role: 'user' as const, content: 'alpha needle in the first message' },
        { role: 'assistant' as const, content: 'answer alpha' },
      ],
    },
    {
      id: '99999999-8888-4777-8666-555555555555',
      title: 'Beta session',
      workspacePath: root.projectB,
      createdAt: 1_750_000_100_000,
      messages: [{ role: 'user' as const, content: 'beta content' }],
    },
  ];
  writeComposerGlobalSessions(root, projectSessions);
  writeComposerWorkspaceSummary(root, 'workspace-alpha', root.projectA, [projectSessions[0]!]);
  writeComposerWorkspaceSummary(root, 'workspace-beta', root.projectB, [projectSessions[1]!]);
});

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

describe('UI server', () => {
  it('reports status and binds to a loopback port', async () => {
    const server = await startServer(fixtures[0]!);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);

    const response = await httpGet(server.port, '/api/status');
    expect(response.status).toBe(200);
    const body = json<{ ok: boolean; host: string; port: number }>(response);
    expect(body.ok).toBe(true);
    expect(body.host).toBe('127.0.0.1');
    expect(body.port).toBe(server.port);
  });

  it('serves the bundled front-end without any runtime dependency', async () => {
    const server = await startServer(fixtures[0]!);

    const page = await httpGet(server.port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('cursor-history');

    for (const asset of ['/app.css', '/app.js']) {
      const response = await httpGet(server.port, asset);
      expect(response.status, asset).toBe(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('lists addressable workspaces with their session counts', async () => {
    const server = await startServer(fixtures[0]!);
    const response = await httpGet(server.port, '/api/workspaces');
    const body = json<{
      count: number;
      workspaces: Array<{ path: string; sessionCount: number; addressable: boolean }>;
    }>(response);

    expect(body.count).toBe(2);
    const alpha = body.workspaces.find((entry) => entry.path === fixtures[0]!.projectA);
    expect(alpha).toMatchObject({ sessionCount: 1, addressable: true });
    // Internal database locators must never reach the client.
    expect(JSON.stringify(body)).not.toContain('state.vscdb');
  });

  it('lists sessions with a UI-shaped DTO', async () => {
    const server = await startServer(fixtures[0]!);
    const response = await httpGet(server.port, '/api/sessions?limit=10');
    const body = json<{
      count: number;
      indexScope: string;
      sessions: Array<Record<string, unknown>>;
    }>(response);

    expect(body.count).toBe(2);
    expect(body.indexScope).toBe('global');
    const alpha = body.sessions.find(
      (entry) => entry['id'] === '11111111-2222-4333-8444-555555555555'
    );
    expect(alpha).toBeTruthy();
    expect(Object.keys(alpha!).sort()).toEqual(
      [
        'createdAt',
        'id',
        'index',
        'lastUpdatedAt',
        'messageCount',
        'occurrenceCount',
        'preview',
        'resolutionState',
        'resolvedSource',
        'source',
        'title',
        'workspaceId',
        'workspacePath',
      ].sort()
    );
    // Messages are only loaded for the single-session endpoint.
    expect(alpha).not.toHaveProperty('messages');
  });

  it('honours a workspace scope and reports an empty scope count', async () => {
    const server = await startServer(fixtures[0]!);
    const path = encodeURIComponent(fixtures[0]!.projectB);
    const response = await httpGet(server.port, `/api/sessions?limit=10&workspace=${path}`);
    const body = json<{ count: number; indexScope: string; sessions: Array<{ title: string }> }>(
      response
    );

    expect(body.indexScope).toBe('workspace');
    expect(body.count).toBe(1);
    expect(body.sessions[0]?.title).toBe('Beta session');
  });

  it('returns one session with messages, and 404 for an unknown id', async () => {
    const server = await startServer(fixtures[0]!);

    const found = await httpGet(
      server.port,
      '/api/session?id=11111111-2222-4333-8444-555555555555'
    );
    expect(found.status).toBe(200);
    const session = json<{ messages: Array<{ role: string; content: string }> }>(found);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]?.content).toContain('alpha needle');

    const missing = await httpGet(server.port, '/api/session?id=does-not-exist');
    expect(missing.status).toBe(404);
    expect(json<{ error: string }>(missing).error).toContain('does-not-exist');

    const noId = await httpGet(server.port, '/api/session');
    expect(noId.status).toBe(400);
  });

  it('reports the active scope when a session exists outside it', async () => {
    const server = await startServer(fixtures[0]!);
    const scope = encodeURIComponent(fixtures[0]!.projectB);

    // Beta lives in projectB, so projectA must not admit it.
    const outOfScope = await httpGet(
      server.port,
      `/api/session?id=99999999-8888-4777-8666-555555555555&workspace=${encodeURIComponent(
        fixtures[0]!.projectA
      )}`
    );
    expect(outOfScope.status).toBe(404);
    expect(json<{ scope: string | null }>(outOfScope).scope).toBe(fixtures[0]!.projectA);

    const inScope = await httpGet(
      server.port,
      `/api/session?id=99999999-8888-4777-8666-555555555555&workspace=${scope}`
    );
    expect(inScope.status).toBe(200);
  });

  it('searches message text and returns highlightable snippets', async () => {
    const server = await startServer(fixtures[0]!);
    const response = await httpGet(server.port, '/api/search?q=needle&limit=10');
    const body = json<{
      count: number;
      results: Array<{
        sessionId: string;
        matchCount: number;
        snippets: Array<{ role: string; text: string; matches: Array<[number, number]> }>;
      }>;
    }>(response);

    expect(body.count).toBe(1);
    const result = body.results[0]!;
    expect(result.sessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.snippets[0]?.role).toBe('user');
    const [start, end] = result.snippets[0]!.matches[0]!;
    expect(result.snippets[0]!.text.slice(start, end)).toBe('needle');

    const empty = await httpGet(server.port, '/api/search?q=');
    expect(empty.status).toBe(400);
  });

  it('exports a session as Markdown or JSON with a download filename', async () => {
    const server = await startServer(fixtures[0]!);
    const id = '11111111-2222-4333-8444-555555555555';

    const markdown = await httpGet(server.port, `/api/export?id=${id}&format=md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers['content-type']).toContain('text/markdown');
    expect(String(markdown.headers['content-disposition'])).toContain('attachment; filename=');
    expect(markdown.body).toContain('alpha needle');

    const exported = await httpGet(server.port, `/api/export?id=${id}&format=json`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('application/json');
    expect(json<{ id: string }>(exported).id).toBe(id);
  });

  it('rejects unknown routes, unsupported methods, and foreign hosts', async () => {
    const server = await startServer(fixtures[0]!);

    const unknown = await httpGet(server.port, '/api/nope');
    expect(unknown.status).toBe(404);

    const posted = await httpGet(server.port, '/api/status', { method: 'POST' });
    expect(posted.status).toBe(405);

    const foreign = await httpGet(server.port, '/api/status', { host: 'evil.example.com' });
    expect(foreign.status).toBe(403);
  });

  it('accepts an explicit refresh that bypasses the memo cache', async () => {
    const server = await startServer(fixtures[0]!);

    const first = await httpGet(server.port, '/api/workspaces');
    const cached = await httpGet(server.port, '/api/workspaces');
    expect(cached.status).toBe(200);
    expect(cached.body).toBe(first.body);

    // `refresh=1` re-reads the source and must still agree with the cached read.
    const refreshed = await httpGet(server.port, '/api/workspaces?refresh=1');
    expect(refreshed.status).toBe(200);
    expect(json<{ count: number }>(refreshed).count).toBe(json<{ count: number }>(first).count);
  });
  it('refreshes a changed catalog and does not retain stale detail snapshots', async () => {
    const root = fixtures[0]!;
    const server = await startServer(root);
    const scoped = `/api/sessions?workspace=${encodeURIComponent(root.projectA)}`;
    const before = await httpGet(server.port, scoped);
    expect(before.status).toBe(200);
    const extra = {
      id: 'aaaaaaaa-2222-4333-8444-555555555555',
      title: 'Added while UI is open',
      workspacePath: root.projectA,
      createdAt: 1_750_000_200_000,
      messages: [{ role: 'user' as const, content: 'fresh source content' }],
    };
    writeComposerGlobalSessions(root, [extra]);
    writeComposerWorkspaceSummary(root, 'workspace-alpha', root.projectA, [extra]);
    expect((await httpGet(server.port, scoped)).body).toBe(before.body);
    const after = await httpGet(server.port, `${scoped}&refresh=1`);
    expect(after.status).toBe(200);
    expect(json<{ sessions: Array<{ id: string }> }>(after).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: extra.id })])
    );
    const detailPath = `/api/session?id=${extra.id}`;
    expect((await httpGet(server.port, detailPath)).body).toContain('fresh source content');
    extra.messages[0]!.content = 'updated source content';
    writeComposerGlobalSessions(root, [extra]);
    expect((await httpGet(server.port, detailPath)).body).toContain('updated source content');
    expect((await httpGet(server.port, `/api/export?id=${extra.id}&format=json`)).body).toContain(
      'updated source content'
    );
  });

  it('shares session and export validation and supports HEAD without a body', async () => {
    const server = await startServer(fixtures[0]!);
    for (const route of ['session', 'export']) {
      expect((await httpGet(server.port, `/api/${route}`)).status).toBe(400);
      expect((await httpGet(server.port, `/api/${route}?id=absent`)).status).toBe(404);
    }
    const head = await httpGet(server.port, '/api/status', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await httpGet(server.port, '/toString')).status).toBe(404);
  });

  it('closes idempotently even while catalog warmup is pending', async () => {
    const server = await startServer(fixtures[0]!);
    await Promise.all([server.close(), server.close()]);
    await server.close();
  });

  it('evicts old responses after browsing more than the cache capacity', async () => {
    const root = fixtures[0]!;
    const server = await startServer(root);
    const path = '/api/sessions?limit=1';
    const before = await httpGet(server.port, path);
    const extra = {
      id: 'cccccccc-2222-4333-8444-555555555555',
      title: 'Newest',
      workspacePath: root.projectA,
      createdAt: 1_850_000_200_000,
      messages: [{ role: 'user' as const, content: 'newest content' }],
    };
    writeComposerGlobalSessions(root, [extra]);
    writeComposerWorkspaceSummary(root, 'workspace-alpha', root.projectA, [extra]);
    expect((await httpGet(server.port, path)).body).toBe(before.body);
    for (let limit = 2; limit <= 34; limit++) {
      expect((await httpGet(server.port, `/api/sessions?limit=${limit}`)).status).toBe(200);
    }
    const reread = await httpGet(server.port, path);
    expect(json<{ sessions: Array<{ id: string }> }>(reread).sessions[0]!.id).toBe(extra.id);
  }, 15_000);
});
