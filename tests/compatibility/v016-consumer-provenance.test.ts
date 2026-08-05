import { describe, expect, it } from 'vitest';
import manifest from './fixtures/v016/vibe-history-consumer-manifest.json';
import {
  computeV016MessageDigest,
  V016_CONSUMER_SCHEMA_VERSION,
  V016_VIBE_HISTORY_REVISION,
  normalizeCursorSessionV016,
} from '../helpers/v016-consumer.js';
import type { Session } from '../../src/lib/types.js';

describe('pinned unchanged v0.16 vibe-history consumer provenance', () => {
  it('locks the copied source inventory and persistence ownership boundary', () => {
    expect(manifest.revision).toBe(V016_VIBE_HISTORY_REVISION);
    expect(manifest.schemaVersion).toBe(V016_CONSUMER_SCHEMA_VERSION);
    expect(Object.keys(manifest.sourceBlobs)).toHaveLength(10);
    expect(Object.values(manifest.sourceBlobs).every((hash) => /^[0-9a-f]{40}$/.test(hash))).toBe(
      true
    );
    expect(manifest.archiveAssumptions).toEqual({
      hostnamePartitioned: true,
      replacementTransactionOwner: 'vibe-history',
      cursorHistoryProvidesCompleteView: true,
      cursorHistoryDoesNotOwnPersistence: true,
    });
  });

  it('locks every copied adapter, identity, policy, engine, schema, and SQLite source blob', () => {
    expect(manifest.repository).toBe('S2thend/vibe-history');
    expect(manifest.revision).toBe('698701775144f7d8875330e1f8caec9ddfc27744');
    expect(manifest.localHarness).toBe('tests/helpers/v016-consumer.ts');
    expect(manifest.sourceBlobs).toEqual({
      'packages/core/src/providers/cursor/index.ts':
        'cb986058e481bebe6a902d80519f17813b53bc8f',
      'packages/core/src/sync/engine.ts': '48b82557d32225f6489f329e2a349aa93d0d149f',
      'packages/core/src/sync/policy.ts': 'd5a16bca2b3169c00ba08076422a7f44b6627b4f',
      'packages/core/src/sync/state.ts': 'ce51f1429f7169f5586dcc5e66eed9df22c46d22',
      'packages/core/src/sync/targets/sql/base.ts':
        '893f60fcd0abf85d4eebfc728c0d70836006f316',
      'packages/core/src/sync/targets/sql/migrations.ts':
        '7c5e88ce0d0d496abea6fb45b7c2b0fc8bceef07',
      'packages/core/src/sync/targets/sql/schema.sqlite.ts':
        '6e20c92853765086c9bb8b3d0395882817f6b556',
      'packages/core/src/sync/targets/sql/sqlite.ts':
        'cb9e7e6ba4126fba14192af88bbd3b33f3f42348',
      'packages/core/src/types/message.ts': 'cab7fa684c7685b4b0c7a6813391c53eee8c1d31',
      'packages/core/src/types/session.ts': 'c8c337fc34da8c28cb9adc9f063135339a92ac9b',
    });
  });

  it('preserves native message keys and derives null-message/tool keys by v0.16 ordinal', () => {
    const session: Session = {
      id: 'aaaaaaaa-0000-0000-0000-000000000016',
      workspace: '/synthetic/project',
      timestamp: '2024-01-01T00:00:00.000Z',
      source: 'global',
      messageCount: 2,
      messages: [
        {
          id: 'native-bubble',
          role: 'user',
          content: 'native',
          timestamp: '2024-01-01T00:00:00.000Z',
        },
        {
          role: 'assistant',
          content: 'fallback',
          timestamp: '2024-01-01T00:00:01.000Z',
          toolCalls: [{ name: 'Read', status: 'completed', params: { path: '/synthetic' } }],
        },
      ],
    };
    const normalized = normalizeCursorSessionV016(session);
    expect(normalized.messages.map((message) => message.id)).toEqual([
      `cursor:${session.id}:native-bubble`,
      `cursor:${session.id}:msg:1`,
    ]);
    expect(normalized.messages[1]?.toolCalls?.[0]?.id).toBe(
      `cursor:${session.id}:msg:1:tc:0`
    );
  });

  it('conforms to the pinned complete-view digest over consumed fields', () => {
    const session: Session = {
      id: 'aaaaaaaa-0000-0000-0000-000000000016',
      workspace: '/synthetic/project',
      timestamp: '2024-01-01T00:00:00.000Z',
      source: 'global',
      messageCount: 1,
      messages: [
        {
          id: 'native-bubble',
          role: 'assistant',
          content: 'synthetic complete view',
          timestamp: '2024-01-01T00:00:01.000Z',
          toolCalls: [
            {
              name: 'Read',
              status: 'completed',
              params: { path: '/synthetic' },
              result: 'synthetic result',
            },
          ],
        },
      ],
    };
    const projected = normalizeCursorSessionV016(session);
    const digest = computeV016MessageDigest(projected.messages);
    const reorderedParams = structuredClone(session);
    reorderedParams.messages[0]!.toolCalls![0]!.params = {
      z: 1,
      path: '/synthetic',
      a: 2,
    };
    const reorderedParamsAgain = structuredClone(reorderedParams);
    reorderedParamsAgain.messages[0]!.toolCalls![0]!.params = {
      a: 2,
      path: '/synthetic',
      z: 1,
    };
    expect(
      computeV016MessageDigest(normalizeCursorSessionV016(reorderedParams).messages)
    ).toBe(
      computeV016MessageDigest(normalizeCursorSessionV016(reorderedParamsAgain).messages)
    );

    const enriched = structuredClone(session);
    enriched.messages[0]!.toolCalls![0]!.result = 'changed consumed result';
    expect(computeV016MessageDigest(normalizeCursorSessionV016(enriched).messages)).not.toBe(
      digest
    );
  });
});
