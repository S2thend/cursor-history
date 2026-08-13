import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageDocument {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

interface PnpmImporterEntry {
  specifier?: string;
  version?: string;
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function rootImporter(source: string): Map<string, PnpmImporterEntry> {
  const entries = new Map<string, PnpmImporterEntry>();
  const lines = source.split(/\r?\n/u);
  const importerStart = lines.findIndex((line) => line === '  .:');
  if (importerStart < 0) return entries;
  let section: 'dependencies' | 'devDependencies' | undefined;
  let packageName: string | undefined;
  for (const line of lines.slice(importerStart + 1)) {
    if (/^\S/u.test(line)) break;
    const sectionMatch = /^ {4}(dependencies|devDependencies):\s*$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] as 'dependencies' | 'devDependencies';
      packageName = undefined;
      continue;
    }
    const packageMatch = /^ {6}([^:]+):\s*$/u.exec(line);
    if (section && packageMatch) {
      packageName = yamlScalar(packageMatch[1]!);
      entries.set(packageName, {});
      continue;
    }
    const valueMatch = /^ {8}(specifier|version):\s*(.+)\s*$/u.exec(line);
    if (section && packageName && valueMatch) {
      entries.set(packageName, {
        ...entries.get(packageName),
        [valueMatch[1]!]: yamlScalar(valueMatch[2]!),
      });
    }
  }
  return entries;
}

function packageBlock(source: string, identity: string): string {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${identity}:`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S[^:]*:\s*$/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function lockErrors(packageDocument: PackageDocument, lockSource: string): string[] {
  const errors: string[] = [];
  const expected = {
    ...packageDocument.dependencies,
    ...packageDocument.devDependencies,
  };
  const importer = rootImporter(lockSource);
  expect(Object.keys(expected).length).toBeGreaterThan(0);
  for (const [name, specifier] of Object.entries(expected)) {
    const locked = importer.get(name);
    if (!locked) errors.push(`pnpm importer omits ${name}`);
    else if (locked.specifier !== specifier) {
      errors.push(`pnpm importer specifier for ${name} is ${String(locked.specifier)}`);
    }
  }
  for (const name of importer.keys()) {
    if (!Object.hasOwn(expected, name)) errors.push(`pnpm importer retains undeclared ${name}`);
  }

  const sqliteVersion = importer.get('better-sqlite3')?.version;
  if (!/^12\.(?:1[0-9]|[2-9][0-9])\.[0-9]+$/u.test(sqliteVersion ?? '')) {
    errors.push(`pnpm resolves incompatible better-sqlite3 ${String(sqliteVersion)}`);
  } else {
    const sqliteBlock = packageBlock(lockSource, `better-sqlite3@${sqliteVersion}`);
    if (!sqliteBlock.includes(`engines: {node: ${String(packageDocument.engines?.node)}}`)) {
      errors.push('pnpm better-sqlite3 engine range differs from the product runtime range');
    }
  }
  if (importer.get('prettier')?.version !== expected.prettier) {
    errors.push('pnpm does not resolve the exact declared Prettier version');
  }
  return errors;
}

describe('package-manager lock consistency', () => {
  const packageDocument = JSON.parse(
    readFileSync(resolve('package.json'), 'utf8')
  ) as PackageDocument;
  const pnpmLock = readFileSync(resolve('pnpm-lock.yaml'), 'utf8');

  it('keeps every pnpm root specifier and compatibility-critical resolution synchronized', () => {
    expect(lockErrors(packageDocument, pnpmLock)).toEqual([]);
  });

  it('detects stale dependency ranges and Node-26-incompatible SQLite resolutions', () => {
    const staleSpecifier = pnpmLock.replace("specifier: '>=12.10.0 <13'", 'specifier: ^12.5.0');
    expect(staleSpecifier).not.toBe(pnpmLock);
    expect(lockErrors(packageDocument, staleSpecifier)).toContain(
      'pnpm importer specifier for better-sqlite3 is ^12.5.0'
    );

    const staleResolution = pnpmLock
      .replace('version: 12.11.1', 'version: 12.8.0')
      .replace('better-sqlite3@12.11.1:', 'better-sqlite3@12.8.0:')
      .replace(
        'engines: {node: 20.x || 22.x || 23.x || 24.x || 25.x || 26.x}',
        'engines: {node: 20.x || 22.x || 23.x || 24.x || 25.x}'
      );
    expect(staleResolution).not.toBe(pnpmLock);
    expect(lockErrors(packageDocument, staleResolution)).toContain(
      'pnpm resolves incompatible better-sqlite3 12.8.0'
    );

    const staleEngine = pnpmLock.replace(
      'engines: {node: 20.x || 22.x || 23.x || 24.x || 25.x || 26.x}',
      'engines: {node: 20.x || 22.x || 23.x || 24.x || 25.x}'
    );
    expect(staleEngine).not.toBe(pnpmLock);
    expect(lockErrors(packageDocument, staleEngine)).toContain(
      'pnpm better-sqlite3 engine range differs from the product runtime range'
    );
  });
});
