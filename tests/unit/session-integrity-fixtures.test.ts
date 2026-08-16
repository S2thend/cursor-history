import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeStoreDb,
  writeStoreTranscript,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

describe('session-integrity fixture builders', () => {
  let fixture: SessionIntegrityFixtureRoot | undefined;
  afterEach(() => fixture?.cleanup());

  it('creates deterministic conflicting Composer and Store carriers', () => {
    fixture = createSessionIntegrityFixtureRoot();
    const corpus = seedConflictingWorkspaceCorpus(fixture);
    expect(corpus.sessionB.createdAt).toBeGreaterThan(corpus.sessionA.createdAt);
    expect(existsSync(writeStoreDb(fixture, corpus.sessionA.id, [{ role: 'user', content: 'gap' }]))).toBe(true);
    expect(
      existsSync(
        writeStoreTranscript(fixture, 'workspace-a', corpus.sessionA.id, [
          { role: 'user', content: 'gap' },
        ])
      )
    ).toBe(true);
  });
});
