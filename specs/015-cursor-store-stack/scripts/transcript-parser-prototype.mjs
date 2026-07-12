// Research prototype (015): validate transcript-JSONL parsing as MVP data source.
// Reads real local transcripts (C:\Users\YUYU\.cursor\projects\**\agent-transcripts\*\*.jsonl),
// parses role-nested lines, maps to Message-like structures, reports coverage + edge cases.
// Disposable research script — not production code.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/YUYU/.cursor/projects';
const SAMPLE_FILE =
  'C:/Users/YUYU/.cursor/projects/d-1-Backend-Fish-Agent/agent-transcripts/3d634094-f8e6-45d0-be90-151f25c16c74/3d634094-f8e6-45d0-be90-151f25c16c74.jsonl';

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
};
walk(ROOT);

const stats = {
  files: files.length,
  totalLines: 0,
  parseFail: 0,
  emptyFiles: 0,
  errorLines: 0,
  msgLines: 0,
};
const roleCounts = {};
const partTypes = {};
const toolNames = {};
const perFileMsgs = [];

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    stats.emptyFiles++;
    perFileMsgs.push(0);
    continue;
  }
  let msgs = 0;
  for (const l of lines) {
    stats.totalLines++;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      stats.parseFail++;
      continue;
    }
    if (o && o.type === 'error') {
      stats.errorLines++;
      continue;
    }
    if (!o || !o.role) continue;
    stats.msgLines++;
    msgs++;
    roleCounts[o.role] = (roleCounts[o.role] || 0) + 1;
    const parts = o.message?.content;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!p || !p.type) continue;
        partTypes[p.type] = (partTypes[p.type] || 0) + 1;
        if (p.type === 'tool_use' && p.name) toolNames[p.name] = (toolNames[p.name] || 0) + 1;
      }
    }
  }
  perFileMsgs.push(msgs);
}

const top = (obj, n) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
const sum = (a) => a.reduce((x, y) => x + y, 0);

console.log('=== Coverage ===');
console.log(JSON.stringify(stats, null, 2));
console.log('files with 0 msgs:', perFileMsgs.filter((m) => m === 0).length);
if (perFileMsgs.length) {
  console.log(
    'msgs/file: min',
    Math.min(...perFileMsgs),
    'max',
    Math.max(...perFileMsgs),
    'mean',
    (sum(perFileMsgs) / perFileMsgs.length).toFixed(1)
  );
}
console.log('\n=== roles ===');
console.log(top(roleCounts, 10));
console.log('\n=== part types ===');
console.log(top(partTypes, 10));
console.log('\n=== tool names (top 20) ===');
console.log(top(toolNames, 20));

console.log('\n=== Sample Message mapping (first 6 lines of one session) ===');
const slines = fs
  .readFileSync(SAMPLE_FILE, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .slice(0, 6);
for (const l of slines) {
  const o = JSON.parse(l);
  const role = o.role;
  const parts = o.message?.content || [];
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .slice(0, 80);
  const tools = parts
    .filter((p) => p.type === 'tool_use')
    .map((p) => `${p.name}(${Object.keys(p.input || {}).join(',')})`);
  console.log(`[${role}] text="${text}${text.length >= 80 ? '…' : ''}" tools=[${tools.join(', ')}]`);
}
