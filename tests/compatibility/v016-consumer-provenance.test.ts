import { describe, expect, it } from 'vitest';
import manifest from './fixtures/v016/vibe-history-consumer-manifest.json';
import {
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
});
