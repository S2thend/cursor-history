/**
 * Local web UI server for cursor-history.
 *
 * This is a thin read-only HTTP surface over `src/core`. It exists so the same
 * Composer and Store data the CLI reads can be browsed in a normal application
 * window instead of the terminal. It deliberately adds no runtime dependencies:
 * `node:http` serves both a small static front-end and a JSON API.
 *
 * Two properties matter for usability on large histories:
 *
 * - Operations are deduplicated and cached. The underlying reads are stateless,
 *   so a long-lived process can answer repeat navigation without re-reading the
 *   database.
 * - Each operation owns a scoped read context and disposes it afterwards, so
 *   refreshing cannot reuse a stale catalog or retain decoded conversations.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  createSessionReadContext,
  getSession as getCoreSession,
  listSessionSummaries,
  listWorkspaces,
  searchSessions,
  UNKNOWN_WORKSPACE_PATH,
  type SessionReadContext,
} from '../core/storage.js';
import { exportToJson, exportToMarkdown } from '../core/parser.js';
import type {
  LogicalSessionSummary,
  SearchResult,
  SessionDiagnostic,
  SourceReadLimitsOverride,
} from '../core/types.js';

/** Options accepted by {@link startUiServer}. */
export interface UiServerOptions {
  /** Custom Cursor data root. Defaults to the platform Cursor path. */
  dataPath?: string;
  /** Read from a backup archive instead of live Cursor data. */
  backupPath?: string;
  /** Interface to bind. Defaults to loopback-only. */
  host?: string;
  /** TCP port. `0` selects a free port. */
  port?: number;
  /** Immutable Source Read Limits v1 overrides applied to every operation. */
  sourceReadLimits?: SourceReadLimitsOverride;
}

/** A running UI server. */
export interface UiServerHandle {
  /** Human-readable root URL. */
  url: string;
  /** Bound port, which differs from the requested port when `port` was `0`. */
  port: number;
  /** Stop accepting connections and release read contexts. */
  close(): Promise<void>;
}

/** Default loopback host: the UI is a private, local-only surface. */
export const DEFAULT_UI_HOST = '127.0.0.1';

/** Default port for the local UI. */
export const DEFAULT_UI_PORT = 4700;

/** Resolved static asset directory, correct from both `src/` and `dist/`. */
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

/** Static assets the server will serve, keyed by request path. */
const STATIC_ASSETS: Readonly<Record<string, { file: string; type: string }>> = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
});

/** Hosts allowed to reach the API, to block DNS-rebinding style requests. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * How long a cached catalog response stays fresh.
 *
 * History is read from a live database that Cursor may be writing to, so
 * answers are memoized briefly rather than kept forever. The UI's Reload
 * action bypasses this window explicitly.
 */
const CACHE_TTL_MS = 60_000;

/** Bound retained responses as well as their lifetime. */
const MAX_CACHED_RESPONSES = 32;

interface CachedValue {
  at: number;
  value: unknown;
}

/**
 * Create and start the local UI server.
 *
 * @param options - Data source, bind address, and read-limit overrides.
 * @returns A handle exposing the bound URL and an idempotent `close()`.
 */
export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const host = options.host ?? DEFAULT_UI_HOST;
  const requestedPort = options.port ?? DEFAULT_UI_PORT;

  const catalogCache = new Map<string, CachedValue>();
  const inFlight = new Map<string, Promise<unknown>>();
  const diagnostics: SessionDiagnostic[] = [];

  /** Reuse discovery within an operation, then release its snapshots and payloads. */
  async function withContext<T>(
    workspacePath: string | undefined,
    run: (context: SessionReadContext) => Promise<T>,
    includeCrossWorkspaceSources = false
  ): Promise<T> {
    const context = createSessionReadContext({
      dataPath: options.dataPath,
      backupPath: options.backupPath,
      workspacePath,
      includeCrossWorkspaceSources,
      resolvedSessionCapacity: 0,
      sourceReadLimits: options.sourceReadLimits,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        if (diagnostics.length > 200) diagnostics.shift();
      },
    });
    try {
      return await run(context);
    } finally {
      await context.dispose();
    }
  }

  /** Memoize an operation by cache key, deduplicating concurrent callers. */
  async function cached<T>(key: string, run: () => Promise<T>, bypass = false): Promise<T> {
    for (const [cachedKey, entry] of catalogCache) {
      if (Date.now() - entry.at >= CACHE_TTL_MS) catalogCache.delete(cachedKey);
    }
    const hit = catalogCache.get(key);
    if (!bypass && hit) {
      catalogCache.delete(key);
      catalogCache.set(key, hit);
      return hit.value as T;
    }

    const pending = inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = run()
      .then((value) => {
        catalogCache.delete(key);
        catalogCache.set(key, { at: Date.now(), value });
        while (catalogCache.size > MAX_CACHED_RESPONSES) {
          catalogCache.delete(catalogCache.keys().next().value!);
        }
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  }

  async function loadWorkspaces(workspacePath?: string) {
    return listWorkspaces(options.dataPath, options.backupPath, {
      sourceReadLimits: options.sourceReadLimits,
      ...(workspacePath ? { workspacePath } : {}),
    });
  }

  async function loadSessions(
    workspacePath: string | undefined,
    all: boolean,
    limit: number,
    includeCrossWorkspaceSources: boolean
  ) {
    return withContext(
      workspacePath,
      (context) =>
        listSessionSummaries(
          {
            limit,
            all,
            ...(workspacePath ? { workspacePath } : {}),
            ...(includeCrossWorkspaceSources ? { includeCrossWorkspaceSources: true } : {}),
            sourceReadLimits: options.sourceReadLimits,
          },
          options.dataPath,
          options.backupPath,
          context
        ),
      includeCrossWorkspaceSources
    );
  }

  const server: Server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!hostAllowed(request)) {
      sendJson(response, 403, { error: 'Requests are only accepted from the local host.' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: `Method ${request.method ?? '?'} is not supported.` });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    const asset = Object.hasOwn(STATIC_ASSETS, url.pathname)
      ? STATIC_ASSETS[url.pathname]
      : undefined;
    if (asset) {
      await serveAsset(response, asset);
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }

    await handleApi(url, response);
  }

  function hostAllowed(request: IncomingMessage): boolean {
    const header = request.headers.host;
    if (!header) return true;
    const hostname = header.replace(/:\d+$/u, '');
    return LOOPBACK_HOSTS.has(hostname) || hostname === host;
  }

  async function serveAsset(
    response: ServerResponse,
    asset: { file: string; type: string }
  ): Promise<void> {
    try {
      const body = await readFile(join(PUBLIC_DIR, asset.file));
      response.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      response.end(body);
    } catch (error) {
      sendJson(response, 500, {
        error: `Missing UI asset "${asset.file}". Run the build to copy src/ui/public into dist.`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleApi(url: URL, response: ServerResponse): Promise<void> {
    const workspace = url.searchParams.get('workspace')?.trim() || undefined;
    const route = url.pathname.slice('/api/'.length);
    const refresh = url.searchParams.get('refresh') === '1';

    switch (route) {
      case 'status': {
        sendJson(response, 200, {
          ok: true,
          version: serverVersion(),
          host,
          port: boundPort(),
          dataPath: options.dataPath ?? null,
          backupPath: options.backupPath ?? null,
          staticDir: PUBLIC_DIR,
          diagnostics: diagnostics.slice(-20),
        });
        return;
      }
      case 'workspaces': {
        const workspaces = await cached(
          JSON.stringify(['workspaces', workspace]),
          () => loadWorkspaces(workspace),
          refresh
        );
        sendJson(response, 200, {
          count: workspaces.length,
          workspaces: workspaces.map((entry) => ({
            id: entry.id,
            path: entry.path,
            sessionCount: entry.sessionCount,
            addressable: entry.path !== UNKNOWN_WORKSPACE_PATH,
          })),
        });
        return;
      }
      case 'sessions': {
        const all = url.searchParams.get('all') === '1';
        const cross = url.searchParams.get('cross') === '1' && Boolean(workspace);
        const limit = clampInt(url.searchParams.get('limit'), 20, 1, 5000);
        const sessions = await cached(
          JSON.stringify(['sessions', workspace, all, limit, cross]),
          () => loadSessions(workspace, all, limit, cross),
          refresh
        );
        sendJson(response, 200, {
          count: sessions.length,
          indexScope: workspace ? 'workspace' : 'global',
          sessions: sessions.map((session) => toSessionDto(session)),
        });
        return;
      }
      case 'session':
      case 'export': {
        const id = url.searchParams.get('id');
        if (!id) {
          sendJson(response, 400, { error: 'A session "id" query parameter is required.' });
          return;
        }
        const session = await withContext(workspace, (context) =>
          getCoreSession(id, options.dataPath, options.backupPath, context)
        );
        if (!session) {
          sendJson(response, 404, {
            error: workspace
              ? `Session ${id} was not found in workspace ${workspace}.`
              : `Session ${id} was not found in this data source.`,
            scope: workspace ?? null,
          });
          return;
        }
        if (route === 'export') {
          const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
          const body = format === 'json' ? exportToJson(session) : exportToMarkdown(session);
          const filename = `${sanitizeFilename(session.title ?? session.id)}.${format}`;
          response.writeHead(200, {
            'content-type':
              format === 'json'
                ? 'application/json; charset=utf-8'
                : 'text/markdown; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          response.end(body);
        } else {
          sendJson(response, 200, session);
        }
        return;
      }
      case 'search': {
        const query = url.searchParams.get('q')?.trim();
        if (!query) {
          sendJson(response, 400, { error: 'A non-empty "q" query parameter is required.' });
          return;
        }
        const limit = clampInt(url.searchParams.get('limit'), 200, 1, 5000);
        const contextChars = clampInt(url.searchParams.get('context'), 120, 0, 4000);
        const results = await cached(
          JSON.stringify(['search', workspace, limit, contextChars, query]),
          () =>
            withContext(workspace, (context) =>
              searchSessions(
                query,
                {
                  limit,
                  contextChars,
                  ...(workspace ? { workspacePath: workspace } : {}),
                  sourceReadLimits: options.sourceReadLimits,
                },
                options.dataPath,
                options.backupPath,
                context
              )
            ),
          refresh
        );
        sendJson(response, 200, {
          query,
          count: results.length,
          results: results.map(toSearchDto),
        });
        return;
      }
      default:
        sendJson(response, 404, { error: `Unknown API route "/api/${route}".` });
    }
  }

  function boundPort(): number {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : requestedPort;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  /**
   * Populate the default scope's caches in the background so the first page
   * load is not the one paying for discovery. Failures are expected on machines
   * without Cursor history and are surfaced by the API on demand instead.
   */
  async function warmCatalog(): Promise<void> {
    await Promise.allSettled([
      cached(JSON.stringify(['workspaces', undefined]), () => loadWorkspaces(undefined)),
      cached(JSON.stringify(['sessions', undefined, false, 200, false]), () =>
        loadSessions(undefined, false, 200, false)
      ),
    ]);
  }

  const port = boundPort();
  const displayHost = host.includes(':') ? `[${host}]` : host;

  const warming = warmCatalog();
  let closing: Promise<void> | undefined;

  return {
    url: `http://${displayHost}:${port}/`,
    port,
    close() {
      closing ??= (async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await warming;
        catalogCache.clear();
      })();
      return closing;
    },
  };
}

/** Machine-readable package version, read from the installed package root. */
function serverVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return (JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string }).version ?? 'dev';
  } catch {
    return 'dev';
  }
}

/** Parse a bounded integer query parameter, falling back to a default. */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Keep generated export filenames portable and shell-safe. */
function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return cleaned || 'session';
}

/** Project one catalog row down to what the UI list actually renders. */
function toSessionDto(session: LogicalSessionSummary) {
  if (session.resolutionState === 'ambiguous') {
    return {
      id: session.id,
      index: session.index,
      title: null,
      preview: null,
      messageCount: null,
      createdAt: null,
      lastUpdatedAt: null,
      workspaceId: null,
      workspacePath: session.matchedWorkspacePath ?? session.canonicalWorkspacePath ?? null,
      source: 'ambiguous',
      resolvedSource: null,
      resolutionState: 'ambiguous' as const,
      occurrenceCount: session.occurrenceCount,
    };
  }
  return {
    id: session.id,
    index: session.index,
    title: session.title,
    preview: session.preview,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    lastUpdatedAt: session.lastUpdatedAt,
    workspaceId: session.workspaceId,
    workspacePath: session.workspacePath ?? null,
    source: session.source ?? null,
    resolvedSource: session.resolvedSource ?? null,
    resolutionState: session.resolutionState ?? null,
    occurrenceCount: 1,
  };
}

/** Project a search match down to its snippets, without the whole session. */
function toSearchDto(result: SearchResult) {
  return {
    sessionId: result.sessionId,
    index: result.index,
    workspacePath: result.matchedWorkspacePath ?? result.workspacePath ?? null,
    canonicalWorkspacePath: result.canonicalWorkspacePath ?? null,
    createdAt: result.createdAt,
    matchCount: result.matchCount,
    snippets: result.snippets.slice(0, 5).map((snippet) => ({
      role: snippet.messageRole,
      messageIndex: snippet.messageIndex ?? null,
      text: snippet.text,
      matches: snippet.matchPositions,
    })),
    snippetCount: result.snippets.length,
  };
}

/** Send one JSON body with no-store caching. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}
