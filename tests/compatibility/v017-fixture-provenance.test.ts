import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanSyntheticFixtureBytes } from './support/generate-v016-fixtures.js';

const ROOT = join(process.cwd(), 'tests', 'compatibility', 'fixtures', 'v017');
const SESSION_ID = '00000000-0017-4017-8017-000000000017';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8')) as T;
}

describe('locked v0.17 transition provenance and baselines', () => {
  it('pins the exact tag, commit, tree, source blobs, and transition boundary', () => {
    const provenance = fixture<{
      release: {
        tag: string;
        commit: string;
        tree: string;
        committedAt: string;
        packageVersion: string;
      };
      sources: Array<{ path: string; gitBlob: string; lockedBehavior: string[] }>;
      transitionContract: Record<string, unknown>;
    }>('provenance.json');
    expect(provenance.release).toEqual({
      tag: 'v0.17.0',
      commit: '5e6ac2bebd041607d7e8b57e3f364aeb9440c2db',
      tree: '5f5f7c6c336f64db27934301e1a47e4acf51529f',
      committedAt: '2026-08-03T08:16:19Z',
      packageVersion: '0.17.0',
    });
    expect(provenance.sources).toHaveLength(13);
    expect(
      provenance.sources.every(
        ({ path, gitBlob, lockedBehavior }) =>
          path.startsWith('src/') && /^[0-9a-f]{40}$/.test(gitBlob) && lockedBehavior.length > 0
      )
    ).toBe(true);
    expect(provenance.transitionContract).toMatchObject({
      preserveNativeComposerIds: true,
      preserveUnstableStorePositionalIds: false,
      preserveCrossFormatStoreIds: false,
      publicSearchCoordinates:
        'correct existing fields to use the matched message and complete-message coordinate space',
      publicJsonExportIndex:
        'tagged releases omitted index; v0.18 adds zero-based metadata and corrects only the unreleased one-based leak',
    });
  });

  it('locks complete and degraded merged transition outcomes', () => {
    const complete = fixture<{
      session: {
        id: string;
        source: string;
        sources: string[];
        messages: Array<{ id?: string; content: string }>;
      };
      expectedCorrectiveTransition: Record<string, unknown>;
    }>('complete-merged.json');
    const degraded = fixture<{
      session: { id: string; source: string; transcriptState: string };
      expectedCorrectiveTransition: Record<string, unknown>;
    }>('degraded-store.json');

    expect(complete.session).toMatchObject({
      id: SESSION_ID,
      source: 'merged',
      sources: ['composer', 'store'],
    });
    expect(complete.session.messages.filter(({ id }) => id).map(({ id }) => id)).toEqual([
      'native-composer-user-017',
      'native-composer-assistant-017',
    ]);
    expect(complete.expectedCorrectiveTransition).toMatchObject({
      incomingLegacySource: 'global',
      replacementCount: 1,
      nextUnchangedWriteCount: 0,
      duplicateLogicalContentCount: 0,
    });
    expect(degraded.session).toMatchObject({
      id: SESSION_ID,
      source: 'store-partial',
      transcriptState: 'partial',
    });
    expect(degraded.expectedCorrectiveTransition).toMatchObject({
      replacementAllowed: false,
      completeStoredViewRemainsPinned: true,
      requiredAction: 'retry-or-manual-review',
    });
  });

  it('locks the complete transcript-to-Store-DB replacement inputs without asserting shared IDs', () => {
    const transcript = fixture<{
      representation: string;
      session: { id: string; source: string; messages: Array<{ id?: string; content: string }> };
      identityBoundary: Record<string, unknown>;
    }>('transcript-complete.json');
    const storeDb = fixture<{
      representation: string;
      session: { id: string; source: string; messages: Array<{ id?: string; content: string }> };
      identityBoundary: Record<string, unknown>;
    }>('store-db-complete.json');

    expect(transcript.representation).toBe('store-transcript');
    expect(storeDb.representation).toBe('store-db');
    expect(transcript.session.id).toBe(SESSION_ID);
    expect(storeDb.session.id).toBe(SESSION_ID);
    expect(transcript.session.source).toBe('transcript');
    expect(storeDb.session.source).toBe('store-complete');
    expect(transcript.session.messages[0]!.content).toBe(storeDb.session.messages[0]!.content);
    expect(transcript.session.messages.every(({ id }) => id === undefined)).toBe(true);
    expect(storeDb.session.messages.every(({ id }) => typeof id === 'string')).toBe(true);
    expect(transcript.identityBoundary).toMatchObject({
      preservedAcrossStoreDb: false,
      transition: 'whole-session-replacement',
    });
    expect(storeDb.identityBoundary).toMatchObject({
      preserveTranscriptIds: false,
      expectedReplacementCount: 1,
      nextUnchangedWriteCount: 0,
    });
  });

  it('preserves tagged fatal JSON bytes, fields, and exit categories', () => {
    const fatal = fixture<{
      taggedRelease: { tag: string; commit: string };
      streamContract: Record<string, unknown>;
      cases: Array<{
        id: string;
        exitCategory: string;
        exitCode: number;
        stdoutBase64: string;
        stderrBase64: string;
        json: Record<string, unknown>;
      }>;
    }>('cli-fatal-output.json');
    expect(fatal.taggedRelease).toEqual({
      tag: 'v0.17.0',
      commit: '5e6ac2bebd041607d7e8b57e3f364aeb9440c2db',
    });
    expect(fatal.streamContract).toMatchObject({
      legacyFatalJsonStream: 'stdout',
      correctiveFatalJsonStream: 'stderr',
      preserveExitCategory: true,
      preserveExistingJsonFields: true,
    });
    expect(fatal.cases.map(({ exitCategory, exitCode }) => [exitCategory, exitCode])).toEqual([
      ['NOT_FOUND', 3],
      ['USAGE_ERROR', 2],
      ['GENERAL_ERROR', 1],
    ]);
    for (const baseline of fatal.cases) {
      const stdout = Buffer.from(baseline.stdoutBase64, 'base64');
      const stderr = Buffer.from(baseline.stderrBase64, 'base64');
      expect(stdout.at(-1)).toBe(0x0a);
      expect(stderr).toHaveLength(0);
      expect(JSON.parse(stdout.toString('utf8'))).toEqual(baseline.json);
    }
  });

  it('locks the v0.16/v0.17 public-search defect as an explicit corrective exception', () => {
    const search = fixture<{
      taggedReleases: Array<{
        tag: string;
        commit: string;
        libraryIndexGitBlob: string;
        coreParserGitBlob: string;
      }>;
      query: string;
      contextLines: number;
      sourceMessage: { messageIndex: number; content: string };
      legacyResult: Record<string, unknown>;
      correctiveResult: Record<string, unknown>;
      jsonExportIndex: Record<string, unknown>;
    }>('search-coordinate-correction.json');

    expect(search.taggedReleases).toEqual([
      {
        tag: 'v0.16.0',
        commit: 'e8a7abf8cea3419a9dda911e174a05f82a9b260e',
        libraryIndexGitBlob: 'bd50cc6c166cb835cc6fb9c280288e39dde099f8',
        coreParserGitBlob: '110a31865caa49a2c8b15707dc7535761ce3dbf6',
      },
      {
        tag: 'v0.17.0',
        commit: '5e6ac2bebd041607d7e8b57e3f364aeb9440c2db',
        libraryIndexGitBlob: 'f0cc8b69d27ef47071e90256c469d4e24e716b01',
        coreParserGitBlob: 'b694368c1088ef413d035020df30c39281326700',
      },
    ]);
    expect(search).toMatchObject({
      query: 'missing-ID',
      contextLines: 0,
      sourceMessage: {
        messageIndex: 1,
        content: 'Synthetic workspace missing-ID answer.',
      },
      legacyResult: {
        match: '...missing-ID...',
        messageIndex: 0,
        offset: 3,
        coordinateSpace: 'snippet-relative',
      },
      correctiveResult: {
        match: 'Synthetic workspace missing-ID answer.',
        messageIndex: 1,
        offset: 20,
        coordinateSpace: 'complete-message-content-utf16',
      },
      jsonExportIndex: {
        taggedReleaseBaseline: {
          indexPresence: 'absent',
          evidence: 'The v0.16.0 and v0.17.0 core exportToJson objects omit index.',
        },
        unreleasedFeatureBranchRegression: {
          commit: '9365a890bf387a13a0e5ab7e9eb5f294f83d28e8',
          tree: '163c44bfa66ea6f80899a4e496fcbc0924f3f363',
          coreParserGitBlob: 'fb0320233edeb91aff5e16579f2261ec3381e797',
          libraryIndexGitBlob: 'bb69bff9d62912ede498be78cb507d494a70fd39',
          publicSelectorIndex: 0,
          resolvedCoreIndex: 1,
          exportedIndex: 1,
        },
        correctiveRelease: {
          version: '0.18.0',
          publicSelectorIndex: 0,
          exportedIndex: 0,
          indexScope: 'workspace',
          classification: 'additive-zero-based-metadata',
        },
        sharedFieldContract: [
          'id',
          'title',
          'createdAt',
          'lastUpdatedAt',
          'messageCount',
          'workspacePath',
          'source',
          'messages[].id',
          'messages[].role',
          'messages[].content',
          'messages[].timestamp',
        ],
      },
    });
  });

  it('keeps every v0.17 fixture wholly synthetic and declares its only UUID', () => {
    for (const name of [
      'provenance.json',
      'complete-merged.json',
      'degraded-store.json',
      'transcript-complete.json',
      'store-db-complete.json',
      'cli-fatal-output.json',
      'search-coordinate-correction.json',
    ]) {
      expect(scanSyntheticFixtureBytes(name, readFileSync(join(ROOT, name)), [SESSION_ID])).toEqual(
        []
      );
    }
  });
});
