import {
  observeAdapterIo,
  type AdapterIoEventInput,
  type OperationIoContext,
} from '../io-observer.js';
import type { Database, DatabaseOperationRequest, RunResult, Statement } from './types.js';

type IoIdentity = Pick<
  AdapterIoEventInput,
  'logicalSessionId' | 'sourceRole' | 'representation' | 'resourceClass'
>;

function requestIdentity(request: DatabaseOperationRequest): IoIdentity {
  return request.ioResource ?? { resourceClass: 'unclassified-resource' };
}

function eventIdentity(sql: string, params: readonly unknown[], fallback: IoIdentity): IoIdentity {
  const parameterStrings = params.filter((value): value is string => typeof value === 'string');
  const composerToken = parameterStrings.find((value) => value.startsWith('composerData:'));
  const bubbleToken = parameterStrings.find((value) => value.startsWith('bubbleId:'));
  const logicalSessionId = composerToken
    ? composerToken.slice('composerData:'.length)
    : bubbleToken?.slice('bubbleId:'.length).split(':')[0];
  if (/\bsqlite_master\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'workspace-database-schema' };
  }
  if (/\bjson_extract\b/iu.test(sql) && /\bworkspace(?:Identifier|Uri)\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'global-composer-membership' };
  }
  if (bubbleToken && !/\bvalue\b/iu.test(sql) && !/\bdata\b/iu.test(sql)) {
    return {
      ...fallback,
      resourceClass: 'global-bubble-index',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (/\bbubbleId\b/iu.test(sql) || bubbleToken) {
    return {
      ...fallback,
      resourceClass: 'global-bubble',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (/\bcomposerData\b/iu.test(sql) || composerToken) {
    return {
      ...fallback,
      resourceClass: 'global-composer',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (/\bblobs\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'store-leaf' };
  }
  if (/\bmeta\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'store-database' };
  }
  return fallback;
}

function isKeyValueStatement(sql: string): boolean {
  return /\b(?:ItemTable|cursorDiskKV|blobs|meta)\b/iu.test(sql);
}

function emit(
  context: OperationIoContext,
  operation: AdapterIoEventInput['operation'],
  identity: IoIdentity,
  adapter: AdapterIoEventInput['adapter'] = 'sqlite'
): void {
  observeAdapterIo(context, { adapter, operation, ...identity });
}

class ObservedStatement implements Statement {
  constructor(
    private readonly inner: Statement,
    private readonly sql: string,
    private readonly context: OperationIoContext,
    private readonly fallback: IoIdentity
  ) {}

  private beforeQuery(params: readonly unknown[]): void {
    const identity = eventIdentity(this.sql, params, this.fallback);
    emit(this.context, 'query', identity);
    if (isKeyValueStatement(this.sql)) emit(this.context, 'get', identity, 'key-value');
  }

  get(...params: unknown[]): unknown {
    this.beforeQuery(params);
    return this.inner.get(...params);
  }

  all(...params: unknown[]): unknown[] {
    this.beforeQuery(params);
    return this.inner.all(...params);
  }

  run(...params: unknown[]): RunResult {
    this.beforeQuery(params);
    return this.inner.run(...params);
  }
}

class ObservedDatabase implements Database {
  private readonly fallback: IoIdentity;

  constructor(
    private readonly inner: Database,
    private readonly context: OperationIoContext,
    request: DatabaseOperationRequest
  ) {
    this.fallback = requestIdentity(request);
  }

  prepare(sql: string): Statement {
    const identity = eventIdentity(sql, [], this.fallback);
    emit(this.context, 'prepare', identity);
    return new ObservedStatement(this.inner.prepare(sql), sql, this.context, this.fallback);
  }

  runSQL(sql: string): void {
    const identity = eventIdentity(sql, [], this.fallback);
    emit(this.context, 'prepare', identity);
    emit(this.context, 'query', identity);
    this.inner.runSQL(sql);
  }

  close(): void {
    this.inner.close();
  }
}

/** Emit the driver-open boundary, then wrap every statement boundary. */
export function openObservedDatabase(
  context: OperationIoContext | undefined,
  request: DatabaseOperationRequest,
  open: () => Database
): Database {
  if (!context) return open();
  emit(context, 'open', requestIdentity(request));
  return new ObservedDatabase(open(), context, request);
}

/** Emit immediately before an online SQLite backup call. */
export function observeDatabaseBackup(request: DatabaseOperationRequest): void {
  if (!request.io) return;
  emit(request.io, 'backup', requestIdentity(request));
}
