import { describe, expect, it } from 'vitest';
import manifest from './fixtures/v016/vibe-history-consumer-manifest.json';
import type { Session } from '../../src/lib/types.js';
import {
  applyGenericCompleteView,
  fingerprintV016DownstreamContract,
  projectV016DownstreamContract,
  type GenericDownstreamState,
} from '../helpers/v016-downstream-contract.js';

function fictionalSession(): Session {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000016',
    workspace: '/synthetic/project',
    timestamp: '2024-01-01T00:00:00.000Z',
    source: 'global',
    messageCount: 2,
    messages: [
      {
        id: 'native-bubble',
        role: 'user',
        content: 'Fictional native message.',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
      {
        role: 'assistant',
        content: 'Fictional fallback message.',
        timestamp: '2024-01-01T00:00:01.000Z',
        toolCalls: [
          {
            name: 'Read',
            status: 'completed',
            params: { path: '/synthetic/read.ts' },
          },
        ],
      },
    ],
  };
}

describe('authorized external v0.16 consumer provenance', () => {
  it('pins revision, source blobs, license, and the external-only boundary', () => {
    expect(manifest).toMatchObject({
      repository: 'S2thend/vibe-history',
      revision: '698701775144f7d8875330e1f8caec9ddfc27744',
      license: {
        path: 'LICENSE',
        gitBlob: 'f7928ea16bb40f2089dc0ba87a750d37c171fce8',
        classification: 'All Rights Reserved',
      },
      recurringCiModel: {
        exactThirdPartyAdapterIncluded: false,
        exactThirdPartyDatabaseIncluded: false,
        model: 'generic cursor-history public-key and complete-view contract',
      },
      externalCertification: {
        ownerAuthorizedCheckoutRequired: true,
        task: 'T113',
      },
    });
    expect(Object.keys(manifest.sourceBlobs)).toHaveLength(11);
    expect(Object.values(manifest.sourceBlobs).every((hash) => /^[0-9a-f]{40}$/.test(hash))).toBe(
      true
    );
  });
});

describe('generic v0.16 downstream compatibility contract', () => {
  it('preserves native and ordinal message/tool keys without claiming consumer internals', () => {
    const session = fictionalSession();
    const view = projectV016DownstreamContract(session);
    expect(view.sessionKey).toBe(`cursor:${session.id}`);
    expect(view.messages.map(({ key }) => key)).toEqual([
      `cursor:${session.id}:native-bubble`,
      `cursor:${session.id}:msg:1`,
    ]);
    expect(view.messages[1]?.tools[0]?.key).toBe(`cursor:${session.id}:msg:1:tc:0`);
  });

  it('fingerprints key bindings canonically and changes on consumed enrichment', () => {
    const base = fictionalSession();
    const reordered = structuredClone(base);
    reordered.messages[1]!.toolCalls![0]!.params = {
      z: 1,
      path: '/synthetic/read.ts',
      a: 2,
    };
    const reorderedAgain = structuredClone(reordered);
    reorderedAgain.messages[1]!.toolCalls![0]!.params = {
      a: 2,
      path: '/synthetic/read.ts',
      z: 1,
    };
    expect(fingerprintV016DownstreamContract(projectV016DownstreamContract(reordered))).toBe(
      fingerprintV016DownstreamContract(projectV016DownstreamContract(reorderedAgain))
    );

    const enriched = structuredClone(base);
    enriched.messages[1]!.toolCalls![0]!.result = 'Fictional enrichment.';
    expect(fingerprintV016DownstreamContract(projectV016DownstreamContract(enriched))).not.toBe(
      fingerprintV016DownstreamContract(projectV016DownstreamContract(base))
    );
  });

  it('models complete replacement, degraded rejection, and idempotence generically', () => {
    const state: GenericDownstreamState = {};
    const base = fictionalSession();
    expect(applyGenericCompleteView(state, base, 'complete')).toEqual({
      action: 'added',
      recordsWritten: 2,
    });
    const pinned = structuredClone(state);
    expect(applyGenericCompleteView(state, { ...base, messages: [] }, 'degraded')).toEqual({
      action: 'skipped',
      recordsWritten: 0,
    });
    expect(state).toEqual(pinned);

    const enriched = structuredClone(base);
    enriched.messages.push({
      role: 'assistant',
      content: 'Fictional appended content.',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    enriched.messageCount = enriched.messages.length;
    expect(applyGenericCompleteView(state, enriched, 'complete')).toEqual({
      action: 'replaced',
      recordsWritten: 3,
    });
    const converged = structuredClone(state);
    expect(applyGenericCompleteView(state, enriched, 'complete')).toEqual({
      action: 'skipped',
      recordsWritten: 0,
    });
    expect(state).toEqual(converged);
  });
});
