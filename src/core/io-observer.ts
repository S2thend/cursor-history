/**
 * Low-level, operation-bound I/O observation primitives.
 *
 * Adapters emit immediately before an actual operation. Resource classes are
 * reviewed safe tokens rather than paths, SQL, keys, or conversation content.
 */

import type { SourceReadLimitsV1, SourceRepresentation, SourceRole } from './types.js';

export type IoAdapter = 'filesystem' | 'sqlite' | 'key-value';
export type IoOperation = 'open' | 'read' | 'prepare' | 'query' | 'get' | 'backup';
export type IoClassification = 'catalog-metadata' | 'conversation-payload';

/**
 * Closed vocabulary safe to expose through test/audit diagnostics. New adapter
 * reads must deliberately classify their resource here.
 */
export const IO_RESOURCE_CLASSIFICATIONS = Object.freeze({
  'workspace-root-directory': 'catalog-metadata',
  'workspace-membership-json': 'catalog-metadata',
  'workspace-database-schema': 'catalog-metadata',
  'workspace-session-index': 'catalog-metadata',
  'global-session-index': 'catalog-metadata',
  'global-bubble-index': 'catalog-metadata',
  'global-composer-membership': 'catalog-metadata',
  'store-root-directory': 'catalog-metadata',
  'store-session-metadata': 'catalog-metadata',
  'backup-manifest': 'catalog-metadata',
  'backup-central-directory': 'catalog-metadata',
  'workspace-conversation': 'conversation-payload',
  'global-composer': 'conversation-payload',
  'global-bubble': 'conversation-payload',
  'store-transcript': 'conversation-payload',
  'store-session-sidecar': 'conversation-payload',
  'store-database': 'conversation-payload',
  'store-leaf': 'conversation-payload',
  'backup-entry': 'conversation-payload',
  'sqlite-snapshot': 'conversation-payload',
} as const satisfies Record<string, IoClassification>);

export type IoResourceClass = keyof typeof IO_RESOURCE_CLASSIFICATIONS;
export type SafeIoResourceClass = IoResourceClass | 'unclassified-resource';

export interface AdapterIoEvent {
  adapter: IoAdapter;
  operation: IoOperation;
  contextId: string;
  dataSourceIdentity: string;
  logicalSessionId?: string;
  sourceRole?: SourceRole;
  representation?: SourceRepresentation;
  resourceClass: SafeIoResourceClass;
  classification: IoClassification;
}

export type AdapterIoObserver = (event: Readonly<AdapterIoEvent>) => void;

/** Typed boundary failure so owning readers never mistake observer poison for absent data. */
export class IoObserverError extends Error {
  override readonly name = 'IoObserverError';
  readonly code = 'ERR_IO_OBSERVER';

  constructor(
    readonly adapter: IoAdapter,
    readonly operation: IoOperation,
    options: ErrorOptions
  ) {
    const detail = options.cause instanceof Error ? ` ${options.cause.message}` : '';
    super(`I/O observer rejected a ${adapter} ${operation} operation.${detail}`, options);
  }
}

export interface OperationIoContext {
  readonly contextId: string;
  readonly dataSourceIdentity: string;
  readonly sourceReadLimits: Readonly<SourceReadLimitsV1>;
  readonly signal?: AbortSignal;
  readonly emit?: AdapterIoObserver;
}

export interface OperationIoContextOptions {
  contextId: string;
  dataSourceIdentity: string;
  sourceReadLimits: Readonly<SourceReadLimitsV1>;
  signal?: AbortSignal;
  emit?: AdapterIoObserver;
}

export type AdapterIoEventInput = Omit<
  AdapterIoEvent,
  'contextId' | 'dataSourceIdentity' | 'resourceClass' | 'classification'
> & {
  /** Runtime string is accepted so unknown classes can fail closed safely. */
  resourceClass: string;
};

function requireSafeIdentity(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty single-line string.`);
  }
}

/** Create one immutable context to thread through every nested adapter. */
export function createOperationIoContext(options: OperationIoContextOptions): OperationIoContext {
  requireSafeIdentity('contextId', options.contextId);
  requireSafeIdentity('dataSourceIdentity', options.dataSourceIdentity);
  return Object.freeze({
    contextId: options.contextId,
    dataSourceIdentity: options.dataSourceIdentity,
    sourceReadLimits: options.sourceReadLimits,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
  });
}

/**
 * Return a context with an observer attached. Callers must pass the returned
 * immutable context to nested adapters; no process-global observer is used.
 */
export function registerIoObserver(
  context: OperationIoContext,
  emit: AdapterIoObserver
): OperationIoContext {
  return createOperationIoContext({
    contextId: context.contextId,
    dataSourceIdentity: context.dataSourceIdentity,
    sourceReadLimits: context.sourceReadLimits,
    ...(context.signal ? { signal: context.signal } : {}),
    emit,
  });
}

/**
 * Resolve a reviewed resource classification. Unknown input is replaced with a
 * safe token and classified as payload, so a raw path/SQL/key cannot leak and
 * cannot accidentally weaken the workspace I/O boundary.
 */
export function classifyIoResource(resourceClass: string): {
  resourceClass: SafeIoResourceClass;
  classification: IoClassification;
} {
  if (Object.hasOwn(IO_RESOURCE_CLASSIFICATIONS, resourceClass)) {
    const known = resourceClass as IoResourceClass;
    return { resourceClass: known, classification: IO_RESOURCE_CLASSIFICATIONS[known] };
  }
  return {
    resourceClass: 'unclassified-resource',
    classification: 'conversation-payload',
  };
}

/** Emit a frozen low-level event immediately before the described adapter I/O. */
export function observeAdapterIo(
  context: OperationIoContext,
  input: AdapterIoEventInput
): Readonly<AdapterIoEvent> {
  const classification = classifyIoResource(input.resourceClass);
  const event = Object.freeze({
    adapter: input.adapter,
    operation: input.operation,
    contextId: context.contextId,
    dataSourceIdentity: context.dataSourceIdentity,
    ...(input.logicalSessionId ? { logicalSessionId: input.logicalSessionId } : {}),
    ...(input.sourceRole ? { sourceRole: input.sourceRole } : {}),
    ...(input.representation ? { representation: input.representation } : {}),
    ...classification,
  });
  try {
    context.emit?.(event);
  } catch (cause) {
    throw new IoObserverError(event.adapter, event.operation, { cause });
  }
  return event;
}
