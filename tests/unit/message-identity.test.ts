import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_IDENTITY_VERSION,
  allocateStoreMessageIdentities,
  allocateToolCallIdentities,
  canonicalJsonV1,
  matchAlignedToolCalls,
  prepareStoreIdentityCandidates,
  projectV016ComposerMessages,
  rewriteRelationshipReferences,
  sha256CanonicalJsonV1,
} from '../../src/core/session-identity.js';
import { mapStoreSession } from '../../src/core/parser.js';
import { mergeCrossStackSessions } from '../../src/core/store-stack/merge.js';
import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';
import type { ChatSession } from '../../src/core/types.js';
import type { StoreSession } from '../../src/core/store-stack/types.js';
import type { Session } from '../../src/lib/types.js';
import {
  fingerprintV016DownstreamContract,
  projectV016DownstreamContract,
} from '../helpers/v016-downstream-contract.js';

describe('canonical JSON and SHA-256 v1', () => {
  it('sorts keys by Unicode code point, preserves arrays, and applies JSON undefined rules', () => {
    const value = {
      z: 1,
      nested: { b: true, a: 'é', omitted: undefined },
      array: [1, undefined, 3],
      a: 2,
    };

    expect(canonicalJsonV1(value)).toBe(
      '{"a":2,"array":[1,null,3],"nested":{"a":"é","b":true},"z":1}'
    );
    expect(sha256CanonicalJsonV1(value)).toBe(
      '275c76c3cb77d8c33b369b35a6d3685656effe2b6629235ccbfcfbcdfd4e88d5'
    );
    expect(canonicalJsonV1({ '😀': 2, '\uE000': 1 })).toBe('{"":1,"😀":2}');
  });

  it('rejects non-finite numbers, unsupported values, and cycles instead of changing identity', () => {
    expect(() => canonicalJsonV1({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalJsonV1({ value: Number.POSITIVE_INFINITY })).toThrow(/finite/i);
    expect(() => canonicalJsonV1(1n)).toThrow(/unsupported/i);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJsonV1(cyclic)).toThrow(/circular/i);
  });
});

describe('v0.16 Composer message projection', () => {
  it('preserves every nonempty native ID byte-for-byte and freezes fallback positions', () => {
    const projected = projectV016ComposerMessages([
      { id: ' native-id ', content: 'A' },
      { id: null, content: 'B' },
      { content: 'C' },
      { id: '', content: 'D' },
      { id: 'msg:1', content: 'native collision' },
    ]);

    expect(projected.map((message) => message.id)).toEqual([
      ' native-id ',
      'msg:1',
      'msg:2',
      'msg:3',
      'msg:1',
    ]);
    expect(projected.map((message) => message.identityOrigin)).toEqual([
      'composer-native',
      'composer-v0.16-index',
      'composer-v0.16-index',
      'composer-v0.16-index',
      'composer-native',
    ]);
    expect(projected.every((message) => message.messageIdentityVersion === 1)).toBe(true);
    expect(MESSAGE_IDENTITY_VERSION).toBe(1);
  });

  it('does not change old Composer identities when Store-only content is inserted', () => {
    const original = projectV016ComposerMessages([
      { id: null, content: 'old A' },
      { id: null, content: 'old B' },
    ]);
    const store = prepareStoreIdentityCandidates([
      {
        representation: 'transcript',
        role: 'assistant',
        content: 'new middle Store message',
        toolActivity: [],
        sourceRelationships: [],
      },
    ]);
    const allocated = allocateStoreMessageIdentities(original, store);

    expect(original.map((message) => message.id)).toEqual(['msg:0', 'msg:1']);
    expect(allocated[0]?.identity.value).toMatch(/^store:v1:transcript:/);
  });
});

describe('Store message candidates and collisions', () => {
  const LEAF = 'A'.repeat(64);

  it('uses lowercase DB leaf hashes and one-based equal-hash occurrences in native order', () => {
    const candidates = prepareStoreIdentityCandidates([
      { representation: 'db', leafHash: LEAF },
      { representation: 'db', leafHash: LEAF },
      { representation: 'db', leafHash: 'b'.repeat(64) },
    ]);

    expect(candidates.map((candidate) => candidate.candidateId)).toEqual([
      `store:v1:db:${LEAF.toLowerCase()}:1`,
      `store:v1:db:${LEAF.toLowerCase()}:2`,
      `store:v1:db:${'b'.repeat(64)}:1`,
    ]);
    expect(candidates.map((candidate) => candidate.sourceOrdinal)).toEqual([0, 1, 2]);
  });

  it('hashes transcript source-native inputs canonically and counts duplicate occurrences', () => {
    const first = {
      representation: 'transcript' as const,
      role: 'user',
      content: 'hello',
      toolActivity: [],
      sourceRelationships: [],
    };
    const candidates = prepareStoreIdentityCandidates([
      first,
      { ...first, ignoredPath: '/different/discovery/path' },
    ]);

    expect(candidates[0]?.baseFingerprint).toBe(
      '75c3adca566f82abbd8525b79ae2516e8d70e1244c704057e922efc8f49c16b5'
    );
    expect(candidates.map((candidate) => candidate.occurrence)).toEqual([1, 2]);
    expect(candidates[1]?.candidateId).toBe(
      `store:v1:transcript:${candidates[0]?.baseFingerprint}:2`
    );
  });

  it('inherits matched Composer IDs and suffixes only unmatched Store collisions', () => {
    const composer = projectV016ComposerMessages([
      { id: 'composer-native' },
      { id: `store:v1:db:${'c'.repeat(64)}:1` },
      { id: `store:v1:db:${'c'.repeat(64)}:1:collision:1` },
    ]);
    const candidates = prepareStoreIdentityCandidates([
      { representation: 'db', leafHash: 'd'.repeat(64) },
      { representation: 'db', leafHash: 'c'.repeat(64) },
    ]);
    const allocated = allocateStoreMessageIdentities(composer, candidates, new Map([[0, 0]]));

    expect(allocated[0]?.identity).toMatchObject({
      value: 'composer-native',
      origin: 'composer-native',
    });
    expect(allocated[1]?.identity.value).toBe(`store:v1:db:${'c'.repeat(64)}:1:collision:2`);
    expect(composer.map((message) => message.id)).toEqual([
      'composer-native',
      `store:v1:db:${'c'.repeat(64)}:1`,
      `store:v1:db:${'c'.repeat(64)}:1:collision:1`,
    ]);
  });

  it('distinguishes retained duplicate Composer values by projection ordinal', () => {
    const composer = projectV016ComposerMessages([{ id: null }, { id: 'msg:0' }]);
    const candidates = prepareStoreIdentityCandidates([
      { representation: 'db', leafHash: 'e'.repeat(64) },
      { representation: 'db', leafHash: 'f'.repeat(64) },
    ]);

    const allocated = allocateStoreMessageIdentities(
      composer,
      candidates,
      new Map([
        [0, 0],
        [1, 1],
      ])
    );

    expect(allocated.map(({ identity }) => [identity.value, identity.origin])).toEqual([
      ['msg:0', 'composer-v0.16-index'],
      ['msg:0', 'composer-native'],
    ]);
  });
});

describe('tool identities and fixed Composer-to-Store matching', () => {
  it('matches native IDs, then canonical params, then missing-param fills without reordering', () => {
    const composer = [
      { id: 'native-call', name: 'Read', params: { path: '/native' } },
      { name: 'Read', params: { b: 2, a: 1 } },
      { name: 'Grep' },
      { name: 'Write', params: { path: '/composer' } },
    ];
    const store = [
      { name: 'Grep', params: { pattern: 'x' }, status: 'error' },
      { name: 'Read', params: { a: 1, b: 2 }, result: 'enrichment' },
      { id: 'native-call', name: 'Read', params: { path: '/store-difference' } },
      { name: 'Write', params: { path: '/store' } },
    ];

    expect(matchAlignedToolCalls(composer, store)).toEqual({
      pairs: [
        { composerIndex: 0, storeIndex: 2, pass: 'native-id' },
        { composerIndex: 1, storeIndex: 1, pass: 'canonical-params' },
        { composerIndex: 2, storeIndex: 0, pass: 'missing-params' },
      ],
      unmatchedComposerIndices: [3],
      unmatchedStoreIndices: [3],
    });
  });

  it('preserves native IDs and keeps synthetic IDs stable across outcome enrichment', () => {
    const base = allocateToolCallIdentities('msg:4', [
      { id: ' native-tool ', name: 'Read', params: { path: '/a' } },
      { name: 'Read', params: { b: 2, a: 1 }, status: 'completed', result: 'old' },
      { name: 'Read', params: { a: 1, b: 2 }, status: 'error', error: 'new' },
      { id: 'tool:v1:existing', identityOrigin: 'tool-v1', name: 'Grep' },
    ]);

    expect(base[0]?.id).toBe(' native-tool ');
    expect(base[0]?.identityOrigin).toBe('source-native');
    expect(base[1]?.id).toBe(
      'tool:v1:msg:4:bdb3d2003e2bdaa55e1345c97787e8411f174109346a8d5c92be0dbb42a204ac:1'
    );
    expect(base[2]?.id).toBe(
      'tool:v1:msg:4:bdb3d2003e2bdaa55e1345c97787e8411f174109346a8d5c92be0dbb42a204ac:2'
    );
    expect(base[3]).toMatchObject({
      id: 'tool:v1:existing',
      identityOrigin: 'tool-v1',
    });
  });

  it('excludes outcome enrichment and standalone files from compatibility pairing', () => {
    expect(
      matchAlignedToolCalls(
        [
          {
            name: 'Read',
            params: { path: '/a' },
            status: 'completed',
            result: 'old',
            files: ['/composer'],
          },
        ],
        [
          {
            name: 'Read',
            params: { path: '/a' },
            status: 'error',
            error: 'new',
            files: ['/store'],
          },
        ]
      ).pairs
    ).toEqual([{ composerIndex: 0, storeIndex: 0, pass: 'canonical-params' }]);
  });

  it('treats standalone files and poison URI strings as inert identity data, never resources', () => {
    const poison = 'file:///definitely-must-not-be-opened/identity-poison';
    const calls = allocateToolCallIdentities('msg:5', [
      { name: 'Read', params: { uri: poison }, files: [poison] },
    ]);
    expect(calls[0]?.id).toMatch(/^tool:v1:msg:5:[a-f0-9]{64}:1$/);
  });
});

describe('relationship rewriting', () => {
  it('rewrites parent, branch, leaf, and sidechain references without guessing unknown IDs', () => {
    const rewritten = rewriteRelationshipReferences(
      {
        parentId: 'composer-parent',
        branchIds: ['composer-parent', 'store-gap'],
        leafId: 'store-gap',
        sidechainIds: ['unknown', 'composer-parent'],
      },
      new Map([
        ['composer-parent', 'msg:0'],
        ['store-gap', 'store:v1:transcript:abc:1'],
      ])
    );

    expect(rewritten).toEqual({
      parentMessageId: 'msg:0',
      branchMessageIds: ['msg:0', 'store:v1:transcript:abc:1'],
      leafMessageId: 'store:v1:transcript:abc:1',
      sidechainMessageIds: ['msg:0'],
      unresolvedSourceIds: ['unknown'],
    });
  });
});

describe('unchanged-consumer attachment projection and fidelity', () => {
  function compatibilityDigest(session: Session): string {
    return fingerprintV016DownstreamContract(projectV016DownstreamContract(session));
  }

  function sourceSession(
    source: ChatSession['source'],
    messages: ChatSession['messages'],
    transcriptState?: ChatSession['transcriptState']
  ): ChatSession {
    return {
      id: '00000000-0017-4017-8017-000000000017',
      index: 1,
      title: 'Synthetic attachment contract',
      createdAt: new Date('2024-01-17T00:00:00.000Z'),
      lastUpdatedAt: new Date('2024-01-17T00:00:01.000Z'),
      messageCount: messages.length,
      messages,
      workspaceId: 'synthetic-attachment-workspace',
      workspacePath: '/fixture/attachments',
      source,
      ...(transcriptState ? { transcriptState } : {}),
    };
  }

  function mapParsedTranscript(
    parsed: ReturnType<typeof parseTranscriptFile>,
    resolutionState: 'complete' | 'partial' = 'complete'
  ): ChatSession {
    const storeSession: StoreSession = {
      id: '00000000-0017-4017-8017-000000000017',
      workspacePath: '/fixture/attachments',
      title: 'Synthetic attachment contract',
      createdAt: new Date('2024-01-17T00:00:00.000Z'),
      lastUpdatedAt: new Date('2024-01-17T00:00:01.000Z'),
      messages: parsed.messages,
      messageIdentityEvidence: parsed.messageIdentityEvidence,
      rawContentBlockEvidence: parsed.rawContentBlockEvidence,
      source: 'transcript',
      resolvedSource: 'store-transcript',
      resolution: {
        state: resolutionState,
        expectedSourceRoles: ['store'],
        loadedSourceRoles: ['store'],
        omittedSourceRoles: [],
        failedSourceRoles: [],
        reasonCodes: [],
      },
      transcriptState: parsed.state,
    };
    return mapStoreSession(storeSession, 1);
  }

  it('changes replacement digest only when attachment evidence reaches consumed fields', () => {
    const baseline: Session = {
      id: '00000000-0016-4016-8016-000000000016',
      workspace: '/fixture/attachments',
      timestamp: '2024-01-16T00:00:00.000Z',
      source: 'global',
      messageCount: 1,
      messages: [
        {
          id: 'native-attachment-message',
          role: 'assistant',
          content: 'Synthetic visible attachment summary.',
          timestamp: '2024-01-16T00:00:01.000Z',
          toolCalls: [
            {
              name: 'Read',
              status: 'completed',
              params: { path: '/fixture/attachments/synthetic.txt' },
              result: 'Synthetic visible result.',
            },
          ],
        },
      ],
    };
    const baselineDigest = compatibilityDigest(baseline);

    const ignoredStandalone = structuredClone(baseline) as Session & {
      messages: Array<Session['messages'][number] & { codeBlocks?: unknown[] }>;
    };
    ignoredStandalone.messages[0]!.codeBlocks = [
      { language: 'text', content: 'standalone-only evidence', startLine: 1 },
    ];
    ignoredStandalone.messages[0]!.toolCalls![0]!.files = [
      '/fixture/attachments/standalone-only.txt',
    ];
    expect(compatibilityDigest(ignoredStandalone)).toBe(baselineDigest);

    const contentProjected = structuredClone(baseline);
    contentProjected.messages[0]!.content +=
      '\n```text\nSynthetic lossless attachment content.\n```';
    const projected = projectV016DownstreamContract(contentProjected);
    expect(projected.messages[0]!.content).toContain(
      '```text\nSynthetic lossless attachment content.\n```'
    );
    expect(fingerprintV016DownstreamContract(projected)).not.toBe(baselineDigest);

    const toolProjected = structuredClone(baseline);
    toolProjected.messages[0]!.toolCalls![0]!.result = 'Changed consumed attachment result.';
    expect(compatibilityDigest(toolProjected)).not.toBe(baselineDigest);
  });

  it('losslessly projects an inline transcript attachment into content used by identity, digest, and equivalence', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-history-inline-attachment-'));
    const transcriptPath = join(root, 'session.jsonl');
    const rawAttachment = {
      type: 'attachment',
      name: 'synthetic.txt',
      mediaType: 'text/plain',
      content: 'line one\n```\nline two',
    };
    try {
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          role: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Synthetic known transcript content.' }, rawAttachment],
          },
        })}\n`,
        { mode: 0o600 }
      );

      const parsed = parseTranscriptFile(transcriptPath);
      expect(parsed.state).toBe('parsed');
      expect(parsed.rawContentBlockEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            representation: 'transcript',
            disposition: 'projected-attachment',
            raw: rawAttachment,
          }),
        ])
      );

      const projectedContent = parsed.messages[0]!.content;
      const payload = projectedContent.match(
        /```cursor_attachment_v1\n([A-Za-z0-9+/=]+)\n```/
      )?.[1];
      expect(payload).toBeDefined();
      expect(Buffer.from(payload!, 'base64').toString('utf8')).toBe(canonicalJsonV1(rawAttachment));

      const store = mapParsedTranscript(parsed);
      const composer = sourceSession('global', [
        {
          id: 'composer-inline-attachment',
          role: 'assistant',
          content: 'Synthetic known transcript content.',
          codeBlocks: [],
        },
      ]);
      const composerBackbone = mergeCrossStackSessions(composer, store, 'composer', 1);
      const storeBackbone = mergeCrossStackSessions(composer, store, 'store', 1);
      for (const merged of [composerBackbone, storeBackbone]) {
        expect(merged).toMatchObject({ source: 'global', resolution: { state: 'complete' } });
        expect(merged.messages).toHaveLength(1);
        expect(merged.messages[0]).toMatchObject({
          id: 'composer-inline-attachment',
          source: 'both',
          content: projectedContent,
        });
      }
      expect(storeBackbone.messages.map(({ id }) => id)).toEqual(
        composerBackbone.messages.map(({ id }) => id)
      );

      const withoutAttachment: Session = {
        id: composerBackbone.id,
        workspace: '/fixture/attachments',
        timestamp: composerBackbone.createdAt.toISOString(),
        source: 'global',
        messageCount: 1,
        messages: [
          {
            id: 'composer-inline-attachment',
            role: 'assistant',
            content: 'Synthetic known transcript content.',
            timestamp: composerBackbone.createdAt.toISOString(),
          },
        ],
      };
      const withAttachment = structuredClone(withoutAttachment);
      withAttachment.messages[0]!.content = projectedContent;
      expect(compatibilityDigest(withAttachment)).not.toBe(compatibilityDigest(withoutAttachment));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps known content, marks unsupported raw attachment evidence partial, and never dereferences its URI', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-history-attachment-poison-'));
    const poisonPath = join(root, 'must-not-be-read.txt');
    const transcriptPath = join(root, 'session.jsonl');
    const poisonPayload = 'POISON_ATTACHMENT_PAYLOAD_MUST_NOT_APPEAR';
    try {
      writeFileSync(poisonPath, poisonPayload, { mode: 0o600 });
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Synthetic known transcript content.' },
              {
                type: 'future_attachment',
                uri: pathToFileURL(poisonPath).href,
                mediaType: 'application/x-synthetic',
              },
            ],
          },
        })}\n`,
        { mode: 0o600 }
      );
      if (process.platform !== 'win32') chmodSync(poisonPath, 0o000);

      const parsed = parseTranscriptFile(transcriptPath);
      expect(parsed).toMatchObject({ state: 'partial' });
      expect(parsed.messages.map(({ content }) => content)).toEqual([
        'Synthetic known transcript content.',
      ]);
      expect(JSON.stringify(parsed)).not.toContain(poisonPayload);
      expect(JSON.stringify(parsed)).toContain(pathToFileURL(poisonPath).href);
      expect(parsed.rawContentBlockEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            representation: 'transcript',
            disposition: 'unsupported',
            raw: expect.objectContaining({ uri: pathToFileURL(poisonPath).href }),
          }),
        ])
      );
      expect(Object.isFrozen(parsed.rawContentBlockEvidence.at(-1)?.raw)).toBe(true);

      const composer = sourceSession('global', [
        {
          id: 'composer-attachment-message',
          role: 'assistant',
          content: 'Synthetic known transcript content.',
          codeBlocks: [],
        },
      ]);
      // Deliberately claim complete input resolution: mapStoreSession must
      // independently prevent unsupported selected evidence from crossing the
      // legacy replacement-safe boundary.
      const store = mapParsedTranscript(parsed, 'complete');
      expect(store).toMatchObject({
        source: 'workspace-fallback',
        resolution: { state: 'partial', reasonCodes: ['source-partial'] },
      });
      const merged = mergeCrossStackSessions(composer, store, 'composer', 1);
      expect(merged.source).toBe('workspace-fallback');
      expect(merged.resolution).toMatchObject({
        state: 'partial',
        reasonCodes: ['source-partial'],
      });
      expect(JSON.stringify(merged)).not.toContain(pathToFileURL(poisonPath).href);
      expect(JSON.stringify(merged)).not.toContain(poisonPayload);
    } finally {
      if (process.platform !== 'win32') chmodSync(poisonPath, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
