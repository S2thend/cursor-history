#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const cjsPackagePath = resolve('dist/cjs/package.json');
const wrapperPath = resolve('dist/lib/index.cjs');

mkdirSync(dirname(cjsPackagePath), { recursive: true });
mkdirSync(dirname(wrapperPath), { recursive: true });

writeFileSync(cjsPackagePath, '{"type":"commonjs"}\n', { encoding: 'utf8', mode: 0o644 });
writeFileSync(wrapperPath, "'use strict';\n\nmodule.exports = require('../cjs/lib/index.js');\n", {
  encoding: 'utf8',
  mode: 0o644,
});
chmodSync(cjsPackagePath, 0o644);
chmodSync(wrapperPath, 0o644);
