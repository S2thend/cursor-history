import type {
  AdapterIoEvent,
  AdapterIoObserver,
  IoAdapter,
  IoClassification,
  IoOperation,
} from '../../src/core/io-observer.js';
import type { SourceRepresentation, SourceRole } from '../../src/core/types.js';

export interface IoEventFilter {
  adapter?: IoAdapter;
  operation?: IoOperation;
  classification?: IoClassification;
  logicalSessionId?: string;
  sourceRole?: SourceRole;
  representation?: SourceRepresentation;
  resourceClass?: string;
}

function eventMatches(event: Readonly<AdapterIoEvent>, filter: IoEventFilter): boolean {
  return Object.entries(filter).every(
    ([field, expected]) =>
      expected === undefined || event[field as keyof AdapterIoEvent] === expected
  );
}

export interface IoEventRecorder {
  readonly observer: AdapterIoObserver;
  snapshot(filter?: IoEventFilter): readonly Readonly<AdapterIoEvent>[];
  count(filter?: IoEventFilter): number;
  clear(): void;
  assertNone(filter: IoEventFilter, description?: string): void;
}

/** Record immutable copies of low-level adapter events in source order. */
export function createIoEventRecorder(): IoEventRecorder {
  const events: Readonly<AdapterIoEvent>[] = [];
  return Object.freeze({
    observer: (event: Readonly<AdapterIoEvent>): void => {
      events.push(Object.freeze({ ...event }));
    },
    snapshot: (filter?: IoEventFilter): readonly Readonly<AdapterIoEvent>[] =>
      Object.freeze(filter ? events.filter((event) => eventMatches(event, filter)) : [...events]),
    count: (filter?: IoEventFilter): number =>
      filter ? events.filter((event) => eventMatches(event, filter)).length : events.length,
    clear: (): void => {
      events.length = 0;
    },
    assertNone: (filter: IoEventFilter, description = 'forbidden I/O'): void => {
      const matches = events.filter((event) => eventMatches(event, filter));
      if (matches.length > 0) {
        throw new Error(`${description}: observed ${matches.length} matching adapter event(s).`);
      }
    },
  });
}

export interface PoisonCanary {
  readonly label: string;
  readonly touched: boolean;
  readonly touchCount: number;
  touch(): never;
  assertUntouched(): void;
}

/** A generic fixture canary whose first attempted access fails loudly. */
export function createPoisonCanary(label: string): PoisonCanary {
  let touchCount = 0;
  return {
    label,
    get touched(): boolean {
      return touchCount > 0;
    },
    get touchCount(): number {
      return touchCount;
    },
    touch(): never {
      touchCount++;
      throw new Error(`Poison canary touched: ${label}`);
    },
    assertUntouched(): void {
      if (touchCount > 0) {
        throw new Error(`Poison canary was touched ${touchCount} time(s): ${label}`);
      }
    },
  };
}

/**
 * Create an observer that throws before any matching adapter operation. This
 * exercises the same pre-I/O point used by filesystem, SQLite, and key/value
 * adapters rather than trusting a high-level resolver callback.
 */
export function createPoisonIoObserver(
  filter: IoEventFilter,
  label = 'off-scope-payload'
): AdapterIoObserver {
  const canary = createPoisonCanary(label);
  return (event): void => {
    if (eventMatches(event, filter)) canary.touch();
  };
}

/** Preserve observer order and do not swallow poison/audit failures. */
export function combineIoObservers(...observers: readonly AdapterIoObserver[]): AdapterIoObserver {
  return (event): void => {
    for (const observer of observers) observer(event);
  };
}

/** Assert that no conversation payload was read for a logical session. */
export function assertNoSessionPayloadIo(
  events: readonly Readonly<AdapterIoEvent>[],
  logicalSessionId: string
): void {
  const matches = events.filter(
    (event) =>
      event.logicalSessionId === logicalSessionId && event.classification === 'conversation-payload'
  );
  if (matches.length > 0) {
    throw new Error(
      `Expected zero payload events for session ${logicalSessionId}; observed ${matches.length}.`
    );
  }
}
