#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(`Packed-package smoke failed: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    timeout: options.timeout ?? 180_000,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n${result.stdout ?? ''}${result.stderr ?? ''}`
    );
  }
  return result;
}

const requestedTarball = process.argv[2];
if (!requestedTarball) fail('usage: smoke-packed-package.mjs <package.tgz>');

const tarball = resolve(requestedTarball);
if (!existsSync(tarball) || !lstatSync(tarball).isFile()) {
  fail(`candidate is not a regular file: ${tarball}`);
}

const workspace = mkdtempSync(join(tmpdir(), 'cursor-history-package-smoke-'));
try {
  writeFileSync(
    join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'cursor-history-packed-smoke', private: true }, null, 2)}\n`,
    { mode: 0o600 }
  );
  run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--no-audit', '--no-fund', '--save-exact', tarball],
    { cwd: workspace }
  );

  const installedRoot = join(workspace, 'node_modules', 'cursor-history');
  const installedPackage = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  const requiredFiles = [
    'dist/lib/index.js',
    'dist/lib/index.cjs',
    'dist/lib/index.d.ts',
    'dist/cli/index.js',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'docs/compatibility.md',
  ];
  for (const relativePath of requiredFiles) {
    if (!existsSync(join(installedRoot, relativePath))) fail(`missing ${relativePath}`);
  }

  const esm = await import(pathToFileURL(join(installedRoot, 'dist/lib/index.js')).href);
  const requireFromWorkspace = createRequire(join(workspace, 'packed-smoke.cjs'));
  const cjs = requireFromWorkspace('cursor-history');
  const esmExports = Object.keys(esm).sort();
  const cjsExports = Object.keys(cjs).sort();
  if (esmExports.length === 0 || JSON.stringify(esmExports) !== JSON.stringify(cjsExports)) {
    fail('ESM and CommonJS package-root exports differ');
  }

  const declaration = readFileSync(join(installedRoot, 'dist/lib/index.d.ts'), 'utf8');
  if (!declaration.includes('export')) fail('package-root declaration file has no exports');
  const compatibility = readFileSync(join(installedRoot, 'docs/compatibility.md'), 'utf8');
  if (!compatibility.includes('Compatibility Matrix v1')) {
    fail('packaged compatibility contract does not identify Matrix v1');
  }

  const cli = run(process.execPath, [join(installedRoot, 'dist/cli/index.js'), '--version'], {
    cwd: workspace,
    timeout: 30_000,
  });
  if (cli.stdout.trim() !== installedPackage.version) {
    fail(`CLI version ${cli.stdout.trim()} does not match package ${installedPackage.version}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      package: installedPackage.name,
      version: installedPackage.version,
      exportCount: esmExports.length,
      candidate: tarball,
    })}\n`
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
