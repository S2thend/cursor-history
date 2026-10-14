#!/usr/bin/env node

/**
 * Copy the UI's static assets into the build output.
 *
 * `tsc` only emits JavaScript, so the front-end files must be copied for the
 * published package (which ships `dist`) to serve them.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(repositoryRoot, 'src/ui/public');
const outputPath = resolve(repositoryRoot, 'dist/ui/public');

if (basename(sourcePath) !== 'public' || basename(dirname(outputPath)) !== 'ui') {
  throw new Error('Refusing to copy UI assets from or to an unexpected path.');
}
if (!existsSync(sourcePath)) {
  throw new Error(`UI asset source directory is missing: ${sourcePath}`);
}

mkdirSync(outputPath, { recursive: true });
cpSync(sourcePath, outputPath, { recursive: true });
process.stdout.write(`Copied UI assets to ${outputPath}\n`);
