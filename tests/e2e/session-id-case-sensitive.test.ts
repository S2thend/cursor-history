import { afterEach, describe, expect, it } from 'vitest';

import { getSession as getLibrarySession, type LibraryConfig } from '../../src/lib/index.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { runBuiltCli } from '../helpers/run-cli.js';

const EXACT_SESSION_ID = 'A1B2C3D4-E5F6-4A7B-8C9D-ABCDEF012345';
const OPPOSITE_CASE_SESSION_ID = EXACT_SESSION_ID.toLowerCase();
const fixtures: SessionIntegrityFixtureRoot[] = [];
const originalStoreRoot = process.env['CURSOR_STORE_ROOT'];

function createCaseSensitiveCorpus(): {
  fixture: SessionIntegrityFixtureRoot;
  session: ComposerFixtureSession;
} {
  const fixture = createSessionIntegrityFixtureRoot('cursor-history-session-id-case-');
  fixtures.push(fixture);
  process.env['CURSOR_STORE_ROOT'] = fixture.storeRoot;

  const session: ComposerFixtureSession = {
    id: EXACT_SESSION_ID,
    title: 'Byte-exact Composer session ID',
    workspacePath: fixture.projectA,
    createdAt: 1_786_500_000_000,
    messages: [
      {
        id: 'native-case-sensitive-message',
        role: 'user',
        content: 'byte-exact-session-id-needle',
        createdAt: 1_786_500_000_000,
      },
    ],
  };

  writeComposerWorkspaceSummary(fixture, 'case-sensitive-workspace', fixture.projectA, [session]);
  writeComposerGlobalSessions(fixture, [session]);
  return { fixture, session };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  if (originalStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = originalStoreRoot;
});

describe.sequential('v0.16 byte-exact public session ID lookup', () => {
  it('returns the exact Composer ID through the public library and rejects opposite-case UUID lookup', async () => {
    const { fixture, session } = createCaseSensitiveCorpus();
    const config: LibraryConfig = { dataPath: fixture.workspaceStorage };

    await expect(getLibrarySession(session.id, config)).resolves.toMatchObject({
      id: session.id,
      messages: [expect.objectContaining({ content: 'byte-exact-session-id-needle' })],
    });
    await expect(getLibrarySession(OPPOSITE_CASE_SESSION_ID, config)).rejects.toMatchObject({
      name: 'SessionNotFoundError',
      identifier: OPPOSITE_CASE_SESSION_ID,
    });
  });

  it('returns the exact Composer ID through the built CLI and reports opposite-case UUID as not found', async () => {
    const { fixture, session } = createCaseSensitiveCorpus();
    const common = ['--json', '--data-path', fixture.workspaceStorage] as const;
    const env = { CURSOR_STORE_ROOT: fixture.storeRoot };

    const exact = await runBuiltCli([...common, 'show', session.id], {
      env,
      timeoutMs: 20_000,
    });
    expect(exact).toMatchObject({ status: 0, stderr: '', signal: null, timedOut: false });
    expect(JSON.parse(exact.stdout)).toMatchObject({
      id: session.id,
      messages: [expect.objectContaining({ content: 'byte-exact-session-id-needle' })],
    });

    const oppositeCase = await runBuiltCli([...common, 'show', OPPOSITE_CASE_SESSION_ID], {
      env,
      timeoutMs: 20_000,
    });
    expect(oppositeCase).toMatchObject({
      status: 3,
      stdout: '',
      signal: null,
      timedOut: false,
    });
    expect(JSON.parse(oppositeCase.stderr)).toMatchObject({
      error: `Session not found: ${OPPOSITE_CASE_SESSION_ID}`,
      code: 'CLI_NOT_FOUND',
    });
  });
});
