#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(repositoryRoot, 'dist');
if (dirname(outputPath) !== repositoryRoot || basename(outputPath) !== 'dist') {
  throw new Error('Refusing to clean an unexpected build output path.');
}
rmSync(outputPath, { recursive: true, force: true });
