#!/usr/bin/env node

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = resolve(repositoryRoot, 'package.json');
const generatedPath = resolve(repositoryRoot, 'src/core/package-version.generated.ts');
const checkOnly = process.argv.slice(2).includes('--check');

const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
if (
  typeof packageJson.version !== 'string' ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)
) {
  throw new Error('package.json must contain a valid release version before generating metadata.');
}

const expected = `/**
 * Generated from package.json by scripts/generate-package-version.mjs.
 * Do not edit this value by hand.
 */
export const PACKAGE_VERSION = '${packageJson.version}' as const;
`;

let current;
try {
  current = readFileSync(generatedPath, 'utf8');
} catch {
  current = undefined;
}

if (current === expected) process.exit(0);
if (checkOnly) {
  throw new Error(
    'Generated package version is stale. Run node scripts/generate-package-version.mjs and commit the result.'
  );
}

writeFileSync(generatedPath, expected, { encoding: 'utf8', mode: 0o644 });
chmodSync(generatedPath, 0o644);
