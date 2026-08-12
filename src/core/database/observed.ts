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

function selectsRawPayload(sql: string): boolean {
  const projection = sql.match(/\bSELECT\b([\s\S]*?)\bFROM\b/iu)?.[1];
  if (!projection) return false;
  // Declared byte lengths are catalog metadata: the engine evaluates value
  // length without returning the raw bytes across the adapter boundary.
  const withoutLengthPreflights = projection.replace(
    /\blength\s*\(\s*cast\s*\(\s*(?:value|data)\s+as\s+blob\s*\)\s*\)/giu,
    ''
  );
  return /\b(?:value|data)\b/iu.test(withoutLengthPreflights);
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
  // A scoped off-workspace database is opened under this reviewed identity
  // solely for UUID projection. The SQL mentions composerData as a key name,
  // but it does not select the Composer JSON payload and must not be relabeled
  // as a global conversation read.
  if (fallback.resourceClass === 'workspace-session-index') {
    return fallback;
  }
  if (/\bjson_extract\b/iu.test(sql) && /\bworkspace(?:Identifier|Uri)\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'global-composer-membership' };
  }
  if (bubbleToken && !selectsRawPayload(sql)) {
    return {
      ...fallback,
      resourceClass: 'global-bubble-index',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (composerToken && !selectsRawPayload(sql)) {
    return {
      ...fallback,
      resourceClass: 'global-composer-membership',
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
