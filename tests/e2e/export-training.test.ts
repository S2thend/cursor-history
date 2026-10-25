import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createSessionIntegrityFixtureRoot,
  writeStoreTranscript,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { runBuiltCli } from '../helpers/run-cli.js';
import { convertTrainingRecord, type TrainingSchema } from '../../src/core/training-formats.js';
import type { TrainingRecord } from '../../src/core/training.js';

let fixture: SessionIntegrityFixtureRoot;
let toolsPath: string;
beforeEach(() => {
  fixture = createSessionIntegrityFixtureRoot('training-export-');
  toolsPath = join(fixture.root, 'tools.json');
  writeFileSync(toolsPath, '\uFEFF' + readFileSync('examples/training/tools.json', 'utf8'));
  for (let i = 0; i < 6; i++) {
    writeStoreTranscript(
      fixture,
      'test-project',
      createHash('sha256').update(`training-session-${i}`).digest('hex'),
      [
        { role: 'user', message: { content: [{ type: 'text', text: 'Read a.ts' }] } },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Reading the file.' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'read_file',
                input: { targetFile: '/Users/alice/a.ts' },
              },
            ],
          },
        },
        { role: 'user', message: { content: [{ type: 'text', text: 'Explain it' }] } },
        {
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'It defines a function.' }] },
        },
      ]
    );
  }
});
afterEach(() => fixture.cleanup());

function run(args: string[]) {
  return runBuiltCli(
    ['--data-path', fixture.workspaceStorage, '--json', 'export-training', ...args],
    {
      env: { CURSOR_STORE_ROOT: fixture.storeRoot },
      timeoutMs: 20_000,
    }
  );
}
function records(path: string): TrainingRecord[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

describe('training format CLI', () => {
  it('exports all formats from the same projection with identical grouped holdouts', async () => {
    const outputs = new Map<TrainingSchema, TrainingRecord[][]>();
    for (const schema of ['messages', 'sharegpt', 'trl'] as const) {
      const output = join(fixture.root, `${schema}.jsonl`);
      const validation = join(fixture.root, `${schema}.validation.jsonl`);
      const args = [
        '--schema',
        schema,
        '-o',
        output,
        '--valid-ratio',
        '0.5',
        '--max-record-chars',
        '1',
      ];
      if (schema !== 'sharegpt') args.push('--tools-file', toolsPath);
      const result = await run(args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.recordsWritten).toBe(12);
      outputs.set(schema, [records(output), records(validation)]);
    }
    for (let split = 0; split < 2; split++) {
      const source = outputs.get('messages')![split]!;
      expect(outputs.get('sharegpt')![split]).toEqual(
        source.map((record) => convertTrainingRecord(record, 'sharegpt'))
      );
      expect(outputs.get('trl')![split]).toEqual(
        source.map((record) => convertTrainingRecord(record, 'trl'))
      );
    }
    const [train, valid] = outputs.get('messages')!;
    expect(new Set(train!.map((row) => row.id.split('#')[0])).size).toBeGreaterThan(0);
    const trainIds = new Set(train!.map((row) => row.id.split('#')[0]));
    expect(valid!.length).toBeGreaterThan(0);
    expect(valid!.some((row) => trainIds.has(row.id.split('#')[0]))).toBe(false);
  });

  it('exports text-only TRL without a tools file and defaults to messages otherwise', async () => {
    const output = join(fixture.root, 'plain.jsonl');
    expect(
      (await run(['--schema', 'trl', '--no-tools', '--no-reasoning', '-o', output])).status
    ).toBe(0);
    for (const row of records(output)) {
      expect(row.tools).toEqual([]);
      expect(row.messages.every((message) => !message.tool_calls && message.role !== 'tool')).toBe(
        true
      );
    }
    expect((await run(['--force', '-o', output])).status).toBe(0);
    expect(records(output)[0]!.schema).toBe('cursor-history-training/v1');
    expect(typeof records(output)[0]!.messages[1]!.tool_calls![0]!.function.arguments).toBe(
      'string'
    );
  });

  it.each([
    ['--schema', 'trl'],
    ['--schema', 'unknown'],
    ['--schema', 'sharegpt', '--tools-file', 'TOOLS'],
    ['--schema', 'trl', '--no-tools', '--tools-file', 'TOOLS'],
  ])('rejects invalid options before touching the output: %j', async (...args) => {
    const output = join(fixture.root, 'invalid.jsonl');
    const result = await run([
      ...args.map((arg) => (arg === 'TOOLS' ? toolsPath : arg)),
      '-o',
      output,
    ]);
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it('reports output stream errors instead of success or a hung process', async () => {
    const result = await run(['--force', '-o', fixture.root]);
    expect(result.timedOut).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/directory|EISDIR/i);
  });

  it.each(['not json', '{}', '[]'])(
    'reports malformed or missing tool definitions: %s',
    async (text) => {
      writeFileSync(toolsPath, text);
      const output = join(fixture.root, 'invalid.jsonl');
      const result = await run(['--schema', 'trl', '--tools-file', toolsPath, '-o', output]);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/tools-file/);
      expect(existsSync(output)).toBe(false);
    }
  );
});
