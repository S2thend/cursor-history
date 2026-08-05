/**
 * Deterministic timestamp resolution shared by all session carriers.
 *
 * This module intentionally has no filesystem or clock dependency. Callers
 * pass only source-native metadata and messages in a fixed source order.
 */

import type { MessageTimestampSource, SessionTimestampSource } from './types.js';

/** Fixed public fallback when Cursor supplied no usable source timestamp. */
export const UNKNOWN_TIMESTAMP_EPOCH_MS = 0;

const DIRECT_MESSAGE_TIMESTAMP_SOURCES = new Set<MessageTimestampSource>([
  'composer-created-at',
  'composer-timing',
  'store-turn-timing',
]);

/** Minimal message shape accepted by deterministic timestamp projection. */
export interface TimestampedMessageLike {
  timestamp?: Date | null;
  timestampSource?: MessageTimestampSource;
}

/** One selected source-metadata pair. Selection happens before projection. */
export interface SessionMetadataTimestamps {
  createdAt?: Date | null;
  lastUpdatedAt?: Date | null;
}

/** Deterministic source inputs for the two public session timestamps. */
export interface SessionTimestampInputs {
  view: 'composer-backed' | 'store-only' | 'source-unknown';
  composerMetadata?: SessionMetadataTimestamps;
  storeDbMetadata?: SessionMetadataTimestamps;
  storeMetadata?: SessionMetadataTimestamps;
  /**
   * Messages in fixed Composer-then-Store, source-native order. Extrema are
   * order-independent, but this shape prevents rendered-backbone order from
   * becoming an accidental input.
   */
  directMessages: readonly TimestampedMessageLike[];
}

/** Fully resolved deterministic session timestamp/provenance pairs. */
export interface ResolvedSessionTimestamps {
  createdAt: Date;
  createdAtSource: SessionTimestampSource;
  lastUpdatedAt: Date;
  lastUpdatedAtSource: SessionTimestampSource;
}

/** Whether a value is a finite, serializable Date. */
export function isValidTimestamp(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Whether provenance proves that Cursor directly stored the message time. */
export function isDirectMessageTimestampSource(
  source: MessageTimestampSource | undefined
): source is Extract<
  MessageTimestampSource,
  'composer-created-at' | 'composer-timing' | 'store-turn-timing'
> {
  return source !== undefined && DIRECT_MESSAGE_TIMESTAMP_SOURCES.has(source);
}

function copyTimestamp(value: Date): Date {
  return new Date(value.getTime());
}

function validMetadataTimestamp(value: Date | null | undefined): Date | undefined {
  return isValidTimestamp(value) ? value : undefined;
}

function selectMetadataTimestamp(
  input: SessionTimestampInputs,
  field: keyof SessionMetadataTimestamps
): { value: Date; source: SessionTimestampSource } | undefined {
  if (input.view === 'composer-backed') {
    const value = validMetadataTimestamp(input.composerMetadata?.[field]);
    return value ? { value, source: 'composer-metadata' } : undefined;
  }

  if (input.view === 'store-only') {
    const dbValue = validMetadataTimestamp(input.storeDbMetadata?.[field]);
    if (dbValue) return { value: dbValue, source: 'store-db-metadata' };

    const metaValue = validMetadataTimestamp(input.storeMetadata?.[field]);
    if (metaValue) return { value: metaValue, source: 'store-meta' };
  }

  return undefined;
}

function directMessageTimes(messages: readonly TimestampedMessageLike[]): Date[] {
  return messages.flatMap((message) =>
    isValidTimestamp(message.timestamp) && isDirectMessageTimestampSource(message.timestampSource)
      ? [message.timestamp]
      : []
  );
}

function resolveSessionField(
  input: SessionTimestampInputs,
  field: keyof SessionMetadataTimestamps,
  extrema: 'earliest' | 'latest'
): { value: Date; source: SessionTimestampSource } {
  const metadata = selectMetadataTimestamp(input, field);
  if (metadata) return { value: copyTimestamp(metadata.value), source: metadata.source };

  const directTimes = directMessageTimes(input.directMessages);
  if (directTimes.length > 0) {
    const selectedMs = directTimes.reduce((selected, timestamp) => {
      const time = timestamp.getTime();
      return extrema === 'earliest' ? Math.min(selected, time) : Math.max(selected, time);
    }, directTimes[0]!.getTime());
    return { value: new Date(selectedMs), source: 'direct-message' };
  }

  return { value: new Date(UNKNOWN_TIMESTAMP_EPOCH_MS), source: 'epoch-unknown' };
}

/**
 * Resolve session creation/update values without using presentation order,
 * filesystem metadata, or the wall clock.
 */
export function resolveSessionTimestamps(input: SessionTimestampInputs): ResolvedSessionTimestamps {
  const created = resolveSessionField(input, 'createdAt', 'earliest');
  const updated = resolveSessionField(input, 'lastUpdatedAt', 'latest');
  return {
    createdAt: created.value,
    createdAtSource: created.source,
    lastUpdatedAt: updated.value,
    lastUpdatedAtSource: updated.source,
  };
}

/** Session creation may anchor messages only when derived from real input. */
export interface MessageSessionTimestampAnchor {
  timestamp: Date;
  source: SessionTimestampSource;
}

/** A serialization-safe timestamp pair for a public resolved message. */
export interface PublicMessageTimestampPair {
  timestamp: Date;
  timestampSource: MessageTimestampSource;
}

/**
 * Obtain a total public timestamp pair without mutating caller-owned input.
 * Projection normally resolves messages earlier; this defensive boundary
 * prevents hand-constructed library/formatter values from emitting half a
 * pair or an invalid date.
 */
export function getPublicMessageTimestamp(
  message: TimestampedMessageLike
): PublicMessageTimestampPair {
  if (!isValidTimestamp(message.timestamp)) {
    return {
      timestamp: new Date(UNKNOWN_TIMESTAMP_EPOCH_MS),
      timestampSource: 'unknown',
    };
  }

  return {
    timestamp: message.timestamp,
    timestampSource: message.timestampSource ?? 'unknown',
  };
}

/**
 * Resolve every message timestamp in place.
 *
 * Only original direct timestamps participate in neighbor inference. Existing
 * inferred values are recomputed, while a legacy non-null value with unknown
 * provenance is preserved byte-for-byte and explicitly marked `unknown`.
 */
export function resolveMessageTimestamps(
  messages: TimestampedMessageLike[],
  sessionAnchor?: MessageSessionTimestampAnchor
): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (
      isValidTimestamp(message.timestamp) &&
      isDirectMessageTimestampSource(message.timestampSource)
    ) {
      continue;
    }

    // Unknown legacy values are real public values, but their origin cannot be
    // promoted to a direct source and they cannot influence neighbors.
    if (
      isValidTimestamp(message.timestamp) &&
      (message.timestampSource === undefined || message.timestampSource === 'unknown')
    ) {
      message.timestampSource = 'unknown';
      continue;
    }

    // Previously inferred values are deliberately recalculated from the
    // original direct anchors so repeated projection cannot form a chain.
    message.timestamp = undefined;
    message.timestampSource = undefined;
  }

  const validSessionAnchor =
    sessionAnchor &&
    sessionAnchor.source !== 'epoch-unknown' &&
    isValidTimestamp(sessionAnchor.timestamp)
      ? sessionAnchor.timestamp
      : undefined;

  // Resolve the higher-priority next-direct fallback in one reverse pass.
  // Inferred and legacy-unknown values never become anchors.
  let nextDirect: Date | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      isValidTimestamp(message.timestamp) &&
      isDirectMessageTimestampSource(message.timestampSource)
    ) {
      nextDirect = message.timestamp!;
      continue;
    }
    if (isValidTimestamp(message.timestamp)) continue;
    if (nextDirect) {
      message.timestamp = copyTimestamp(nextDirect);
      message.timestampSource = 'inferred-next';
    }
  }

  // Only messages with no later direct value reach the previous/session/epoch
  // fallbacks. This pass is linear even for a source at the configured record limit.
  let previousDirect: Date | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (
      isValidTimestamp(message.timestamp) &&
      isDirectMessageTimestampSource(message.timestampSource)
    ) {
      previousDirect = message.timestamp!;
      continue;
    }
    if (isValidTimestamp(message.timestamp)) continue;
    if (previousDirect) {
      message.timestamp = copyTimestamp(previousDirect);
      message.timestampSource = 'inferred-previous';
      continue;
    }

    if (validSessionAnchor) {
      message.timestamp = copyTimestamp(validSessionAnchor);
      message.timestampSource = 'session-fallback';
      continue;
    }

    message.timestamp = new Date(UNKNOWN_TIMESTAMP_EPOCH_MS);
    message.timestampSource = 'unknown';
  }
}
