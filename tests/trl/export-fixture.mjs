/** Generate synthetic JSONL through the production projection and format adapters. */
import { writeFileSync, readFileSync } from 'node:fs';
import { projectSession } from '../../dist/core/training.js';
import { serializeTrainingLine } from '../../dist/core/training-formats.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: node tests/trl/export-fixture.mjs <output.jsonl>');
const readFile = JSON.parse(readFileSync(new URL('../../examples/training/tools.json', import.meta.url)))[0];
const tools = [readFile, {
  type: 'function',
  function: {
    name: 'inspect', description: 'Inspect a value.',
    parameters: { type: 'object', properties: { payload: {} }, required: ['payload'] },
  },
}];
const session = (id, messages) => ({
  id, index: 1, title: 'Synthetic training fixture', workspaceId: 'fixture',
  createdAt: new Date(0), lastUpdatedAt: new Date(0), messageCount: messages.length,
  messages: messages.map(message => ({ id: null, codeBlocks: [], ...message })),
});
const inputs = [
  session('nested-tools', [
    { role: 'user', content: 'Read a.ts and inspect this object.' },
    { role: 'assistant', content: 'Checking both.', toolCalls: [
      { name: 'read_file', params: { targetFile: '/Users/alice/a.ts' }, status: 'completed', result: 'export const x = 1;' },
      { name: 'inspect', params: { payload: { items: [1, 2], enabled: true, optional: null } }, status: 'completed', result: 'Valid.' },
    ] },
    { role: 'assistant', content: 'The file defines x and the object is valid.' },
  ]),
  session('string-argument', [
    { role: 'user', content: 'Inspect a string.' },
    { role: 'assistant', content: '', toolCalls: [
      { name: 'inspect', params: { payload: 'hello' }, status: 'completed', result: 'A string.' },
    ] },
    { role: 'assistant', content: 'This is a string.' },
  ]),
  session('plain', [
    { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' },
  ]),
];
const records = inputs.flatMap(input => projectSession(input, {
  toolDefinitions: input.id === 'plain' ? [] : tools, includeReasoning: false,
}).records);
writeFileSync(output, records.map(record => serializeTrainingLine(record, 'trl')).join('\n') + '\n');
console.log(`Exported ${records.length} synthetic TRL records to ${output}`);
