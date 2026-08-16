import { describe, expect, it, vi } from 'vitest';

const { openSyncMock, readSyncMock, closeSyncMock } = vi.hoisted(() => ({
  openSyncMock: vi.fn(() => 42),
  readSyncMock: vi.fn(),
  closeSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: openSyncMock,
    readSync: readSyncMock,
    closeSync: closeSyncMock,
  };
});

import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';

describe('parseTranscriptFile cleanup precedence', () => {
  it('attempts close and retains the read failure as the close failure cause', () => {
    const primary = new Error('synthetic transcript read failure');
    const cleanup = new Error('synthetic transcript close failure');
    readSyncMock.mockImplementationOnce(() => {
      throw primary;
    });
    closeSyncMock.mockImplementationOnce(() => {
      throw cleanup;
    });

    expect(() => parseTranscriptFile('/private/transcript.jsonl')).toThrow(cleanup);
    expect(openSyncMock).toHaveBeenCalledWith('/private/transcript.jsonl', 'r');
    expect(closeSyncMock).toHaveBeenCalledWith(42);
    expect(cleanup.cause).toBe(primary);
  });
});
