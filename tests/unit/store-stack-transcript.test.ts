import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseTranscriptFile } from '../../src/core/store-stack/transcript.js';

const FIX = (...p: string[]) => join(process.cwd(), 'tests', 'fixtures', 'transcripts', ...p);

describe('parseTranscriptFile (role-nested Cursor 3.x transcripts)', () => {
  it('parses a user-only transcript', () => {
    const { messages, state } = parseTranscriptFile(FIX('user-only.jsonl'));
    expect(state).toBe('parsed');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('What is 2+2?');
    expect(messages[0].toolCalls).toBeUndefined();
  });

  it('parses assistant text + tool_use into content + toolCalls', () => {
    const { messages, state } = parseTranscriptFile(FIX('with-tools.jsonl'));
    expect(state).toBe('parsed');
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('Reading the file.');
    expect(messages[1].toolCalls).toHaveLength(1);
    expect(messages[1].toolCalls?.[0]).toMatchObject({ name: 'Read', status: 'completed' });
    expect(messages[1].toolCalls?.[0].params).toEqual({ path: '/tmp/foo.txt' });
  });

  it('keeps valid messages but marks mixed provider errors partial', () => {
    const { messages, state } = parseTranscriptFile(FIX('error-line.jsonl'));
    expect(state).toBe('partial');
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('handles multiple parts in one line (text + 2 tool_use)', () => {
    const { messages, state } = parseTranscriptFile(FIX('multi-parts.jsonl'));
    expect(state).toBe('parsed');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Step 1: search');
    expect(messages[0].toolCalls).toHaveLength(2);
    expect(messages[0].toolCalls?.map((t) => t.name)).toEqual(['Grep', 'Glob']);
  });

  it('reports "empty" state (not parsed) for an empty file', () => {
    const { messages, state } = parseTranscriptFile(FIX('empty.jsonl'));
    expect(state).toBe('empty');
    expect(messages).toEqual([]);
  });

  it('reports "missing" state for a missing file (no throw — defensive)', () => {
    const { messages, state } = parseTranscriptFile(FIX('does-not-exist.jsonl'));
    expect(state).toBe('missing');
    expect(messages).toEqual([]);
  });

  it('reports "error-only" state when only provider-error lines are present', () => {
    const path = FIX('error-only.jsonl');
    // Build an error-only fixture inline if not present on disk.
    const { writeFileSync, existsSync } = require('node:fs');
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify({ type: 'error', error: 'boom' }) + '\n');
    }
    const { messages, state } = parseTranscriptFile(path);
    expect(state).toBe('error-only');
    expect(messages).toEqual([]);
  });

  it('reports partial when valid messages coexist with a malformed non-empty line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch-transcript-partial-'));
    const path = join(dir, 'partial.jsonl');
    try {
      writeFileSync(
        path,
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'kept' }] } }) +
          '\n{"role":"assistant"'
      );
      const { messages, state } = parseTranscriptFile(path);
      expect(state).toBe('partial');
      expect(messages.map((message) => message.content)).toEqual(['kept']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
