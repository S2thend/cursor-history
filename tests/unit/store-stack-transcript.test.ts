import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';

const FIX = (...p: string[]) => join(process.cwd(), 'tests', 'fixtures', 'transcripts', ...p);

describe('parseTranscriptFile (role-nested Cursor 3.x transcripts)', () => {
  it('parses a user-only transcript', () => {
    const msgs = parseTranscriptFile(FIX('user-only.jsonl'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('What is 2+2?');
    expect(msgs[0].toolCalls).toBeUndefined();
  });

  it('parses assistant text + tool_use into content + toolCalls', () => {
    const msgs = parseTranscriptFile(FIX('with-tools.jsonl'));
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('Reading the file.');
    expect(msgs[1].toolCalls).toHaveLength(1);
    expect(msgs[1].toolCalls?.[0]).toMatchObject({ name: 'Read', status: 'completed' });
    expect(msgs[1].toolCalls?.[0].params).toEqual({ path: '/tmp/foo.txt' });
  });

  it('skips {type:"error"} lines and keeps valid messages', () => {
    const msgs = parseTranscriptFile(FIX('error-line.jsonl'));
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('handles multiple parts in one line (text + 2 tool_use)', () => {
    const msgs = parseTranscriptFile(FIX('multi-parts.jsonl'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe('Step 1: search');
    expect(msgs[0].toolCalls).toHaveLength(2);
    expect(msgs[0].toolCalls?.map((t) => t.name)).toEqual(['Grep', 'Glob']);
  });

  it('returns [] for an empty file', () => {
    expect(parseTranscriptFile(FIX('empty.jsonl'))).toEqual([]);
  });

  it('returns [] for a missing file (no throw — defensive)', () => {
    expect(parseTranscriptFile(FIX('does-not-exist.jsonl'))).toEqual([]);
  });
});
