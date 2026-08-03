/**
 * Integration: Store-stack list (US1, SC-001).
 * Verifies Store-stack sessions are listed when the Composer stack is absent
 * (Issue #31 scenario). Uses real fs against fixtures/store-root by pointing
 * getStoreStackRoot at the fixture tree; Composer stack is emptied via a
 * non-existent customDataPath.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('../../src/lib/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/platform.js')>(
    '../../src/lib/platform.js'
  );
  return {
    ...actual,
    getStoreStackRoot: () => join(process.cwd(), 'tests', 'fixtures', 'store-root'),
  };
});

vi.mock('../../src/core/database/index.js', () => ({
  openDatabase: vi.fn(),
  openDatabaseReadWrite: vi.fn(),
  ensureDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/backup.js', () => ({
  openBackupDatabase: vi.fn(),
  readBackupManifest: vi.fn().mockResolvedValue(null),
}));

import { listSessions, getSession, searchSessions } from '../../src/core/storage.js';
import { exportToMarkdown } from '../../src/core/parser.js';
import { getMessageType } from '../../src/cli/formatters/table.js';

const UUID1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const UUID2 = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('Store-stack list (integration)', () => {
  it('lists Store sessions when Composer stack is absent — Issue #31 scenario', async () => {
    const result = await listSessions({ limit: 0, all: true }, '/nonexistent-composer-path');
    expect(result.length).toBeGreaterThanOrEqual(2);
    const ids = result.map((s) => s.id);
    expect(ids).toContain(UUID1);
    expect(ids).toContain(UUID2);
  });

  it('tags Store sessions with source=transcript (for --json output)', async () => {
    const result = await listSessions({ limit: 0, all: true }, '/nonexistent-composer-path');
    expect(result.every((s) => s.source === 'transcript')).toBe(true);
  });

  it('reads workspacePath from chats meta.json.cwd', async () => {
    const result = await listSessions({ limit: 0, all: true }, '/nonexistent-composer-path');
    const s1 = result.find((s) => s.id === UUID1)!;
    expect(s1.workspacePath).toContain('cursor-history');
  });
});

describe('Store-stack show / search / export (integration)', () => {
  it('show: getSession returns Store session with parsed messages + tool calls', async () => {
    const s = await getSession(UUID1, '/nonexistent-composer-path');
    expect(s).not.toBeNull();
    expect(s!.source).toBe('transcript');
    expect(s!.messages).toHaveLength(2);
    expect(s!.messages[1]!.toolCalls?.[0]?.name).toBe('Read');
  });

  it('search: matches text in Store sessions', async () => {
    const results = await searchSessions(
      'foo',
      { limit: 0, contextChars: 20 },
      '/nonexistent-composer-path'
    );
    expect(results.some((r) => r.sessionId === UUID1)).toBe(true);
  });

  it('export: exportToMarkdown renders Store session content + tool calls', async () => {
    const s = await getSession(UUID1, '/nonexistent-composer-path');
    const md = exportToMarkdown(s!, s!.workspacePath);
    expect(md).toContain('Read foo.txt'); // user text
    expect(md).toContain('Reading the file'); // assistant text (avoid 'Read' substring in user text)
  });
});

describe('getMessageType — Store structured toolCalls regression guard', () => {
  it('classifies a Store assistant message with toolCalls as "tool"', () => {
    expect(
      getMessageType({ role: 'assistant', content: 'Reading file.', toolCalls: [{ name: 'Read' }] })
    ).toBe('tool');
  });

  it('classifies a plain assistant message (no toolCalls, no markers) as "assistant"', () => {
    expect(getMessageType({ role: 'assistant', content: 'Hello' })).toBe('assistant');
  });
});
