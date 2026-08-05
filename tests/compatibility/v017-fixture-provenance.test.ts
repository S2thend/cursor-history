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
    expect(provenance.sources).toHaveLength(12);
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

  it('keeps every v0.17 fixture wholly synthetic and declares its only UUID', () => {
    for (const name of [
      'provenance.json',
      'complete-merged.json',
      'degraded-store.json',
      'transcript-complete.json',
      'store-db-complete.json',
      'cli-fatal-output.json',
    ]) {
      expect(scanSyntheticFixtureBytes(name, readFileSync(join(ROOT, name)), [SESSION_ID])).toEqual(
        []
      );
    }
  });
});
