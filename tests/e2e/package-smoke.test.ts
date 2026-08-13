import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const auditScript = join(repositoryRoot, 'scripts/audit-public-api-docs.mjs');
const smokeScript = join(repositoryRoot, 'scripts/smoke-packed-package.mjs');
const workflowPath = join(repositoryRoot, '.github/workflows/npm-publish.yml');

let temporaryRoot = '';
let declarationPackage = '';

function run(
  command: string,
  args: string[],
  cwd = repositoryRoot,
  timeout = 120_000,
  env: NodeJS.ProcessEnv = {}
) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });
}

function runNode(args: string[], cwd = repositoryRoot, timeout?: number, env?: NodeJS.ProcessEnv) {
  return run(process.execPath, args, cwd, timeout, env);
}

function copyDeclarationPackage(name: string): string {
  const destination = join(temporaryRoot, name);
  cpSync(declarationPackage, destination, { recursive: true });
  return destination;
}

function prepareIsolatedPackageSource(): string {
  const sourceRoot = join(temporaryRoot, 'isolated-package-source');
  mkdirSync(sourceRoot, { recursive: true });
  for (const directory of ['src', 'scripts', 'docs']) {
    cpSync(join(repositoryRoot, directory), join(sourceRoot, directory), { recursive: true });
  }
  for (const filename of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.cjs.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    '.npmignore',
  ]) {
    const source = join(repositoryRoot, filename);
    if (existsSync(source)) cpSync(source, join(sourceRoot, filename));
  }
  symlinkSync(
    join(repositoryRoot, 'node_modules'),
    join(sourceRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return sourceRoot;
}

beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'cursor-history-declaration-smoke-'));
  declarationPackage = join(temporaryRoot, 'package');
  const emitted = join(declarationPackage, 'dist');
  const compiler = join(repositoryRoot, 'node_modules/typescript/bin/tsc');
  const compiled = runNode([
    compiler,
    '--project',
    join(repositoryRoot, 'tsconfig.json'),
    '--emitDeclarationOnly',
    '--declaration',
    '--declarationMap',
    'false',
    '--noUnusedLocals',
    'false',
    '--noUnusedParameters',
    'false',
    '--outDir',
    emitted,
  ]);
  if (compiled.status !== 0) {
    throw new Error(`declaration emit failed\n${compiled.stdout}${compiled.stderr}`);
  }
  writeFileSync(
    join(declarationPackage, 'package.json'),
    `${JSON.stringify({ name: 'cursor-history', type: 'module', types: 'dist/lib/index.d.ts' })}\n`,
    { mode: 0o600 }
  );
});

afterAll(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('packed-package contract smoke', () => {
  it('resolves every package-root alias to documented declarations with callable contracts', () => {
    const audited = runNode([auditScript, declarationPackage]);
    expect(audited.status, `${audited.stdout}${audited.stderr}`).toBe(0);
    expect(readFileSync(join(declarationPackage, 'dist/lib/index.d.ts'), 'utf8')).toContain(
      'export'
    );
  });

  it('fails when documentation is removed from a re-exported declaration target', () => {
    const mutatedRoot = copyDeclarationPackage('mutated-package');
    const target = join(mutatedRoot, 'dist/core/types.d.ts');
    const source = readFileSync(target, 'utf8');
    const declarationStart = source.indexOf('export declare const MESSAGE_TYPES:');
    const documentationStart = source.lastIndexOf('/**', declarationStart);
    expect(declarationStart).toBeGreaterThan(0);
    expect(documentationStart).toBeGreaterThan(0);
    expect(source.slice(documentationStart, declarationStart)).toContain('*/');
    const mutated = `${source.slice(0, documentationStart)}${source.slice(declarationStart)}`;
    writeFileSync(target, mutated, { mode: 0o600 });

    const audited = runNode([auditScript, mutatedRoot]);
    expect(audited.status).not.toBe(0);
    expect(audited.stderr).toContain('MESSAGE_TYPES: missing contract JSDoc');
  });

  it('audits the public read-context lifecycle members, not only the interface symbol', () => {
    const mutatedRoot = copyDeclarationPackage('mutated-context-package');
    const target = join(mutatedRoot, 'dist/lib/types.d.ts');
    const source = readFileSync(target, 'utf8');
    const declarationStart = source.indexOf('releaseSession(sessionId: string): void;');
    const documentationStart = source.lastIndexOf('/**', declarationStart);
    expect(declarationStart).toBeGreaterThan(0);
    expect(documentationStart).toBeGreaterThan(0);
    const mutated = `${source.slice(0, documentationStart)}${source.slice(declarationStart)}`;
    writeFileSync(target, mutated, { mode: 0o600 });

    const audited = runNode([auditScript, mutatedRoot]);
    expect(audited.status).not.toBe(0);
    expect(audited.stderr).toContain('SessionReadContext.releaseSession: missing contract JSDoc');
  });

  it('audits every overload independently instead of aggregating sibling tags', () => {
    const mutatedRoot = copyDeclarationPackage('mutated-overload-package');
    const target = join(mutatedRoot, 'dist/lib/index.d.ts');
    const source = readFileSync(target, 'utf8');
    const declaration =
      'export declare function getSession(index: number | string, config?: LibraryConfig): Promise<Session>;';
    expect(source).toContain(declaration);
    writeFileSync(
      target,
      source.replace(
        declaration,
        `${declaration}\nexport declare function getSession(index: URL): Promise<Session>;`
      ),
      { mode: 0o600 }
    );

    const audited = runNode([auditScript, mutatedRoot]);
    expect(audited.status).not.toBe(0);
    expect(audited.stderr).toContain('getSession call overload 2: missing contract JSDoc');
    expect(audited.stderr).toContain(
      'getSession call overload 2: @param names must exactly match (index); documented (none)'
    );
  });

  it('requires exact parameter names rather than an equal number of @param tags', () => {
    const mutatedRoot = copyDeclarationPackage('mutated-parameter-package');
    const target = join(mutatedRoot, 'dist/lib/index.d.ts');
    const source = readFileSync(target, 'utf8');
    expect(source).toContain('@param index - Zero-based session index');
    writeFileSync(
      target,
      source.replace(
        '@param index - Zero-based session index',
        '@param selector - Zero-based session index'
      ),
      { mode: 0o600 }
    );

    const audited = runNode([auditScript, mutatedRoot]);
    expect(audited.status).not.toBe(0);
    expect(audited.stderr).toContain(
      'getSession: @param names must exactly match (index, config); documented (selector, config)'
    );
  });

  it('requires concrete typed @throws contracts with a documented failure condition', () => {
    const mutatedRoot = copyDeclarationPackage('mutated-throws-package');
    const target = join(mutatedRoot, 'dist/lib/index.d.ts');
    const source = readFileSync(target, 'utf8');
    expect(source).toContain('@throws {DatabaseLockedError} If database is locked by Cursor');
    writeFileSync(
      target,
      source.replace(
        '@throws {DatabaseLockedError} If database is locked by Cursor',
        '@throws DatabaseLockedError'
      ),
      { mode: 0o600 }
    );

    const audited = runNode([auditScript, mutatedRoot]);
    expect(audited.status).not.toBe(0);
    expect(audited.stderr).toContain('listSessions: @throws must start with a concrete {Type}');

    const unknownTypeRoot = copyDeclarationPackage('mutated-throws-type-package');
    const unknownTypeTarget = join(unknownTypeRoot, 'dist/lib/index.d.ts');
    const unknownTypeSource = readFileSync(unknownTypeTarget, 'utf8');
    writeFileSync(
      unknownTypeTarget,
      unknownTypeSource.replace(
        '@throws {DatabaseLockedError} If database is locked by Cursor',
        '@throws {DefinitelyNotAnExportedError} If database is locked by Cursor'
      ),
      { mode: 0o600 }
    );
    const unknownTypeAudit = runNode([auditScript, unknownTypeRoot]);
    expect(unknownTypeAudit.status).not.toBe(0);
    expect(unknownTypeAudit.stderr).toContain(
      'listSessions: @throws type DefinitelyNotAnExportedError is not exported by the package root'
    );
  });

  it('discovers callable members on every exported public interface', () => {
    const mutatedRoot = copyDeclarationPackage('mutated-interface-package');
    const target = join(mutatedRoot, 'dist/lib/index.d.ts');
    const source = readFileSync(target, 'utf8');
    writeFileSync(
      target,
      `${source}\n/** Synthetic public callback contract. */\nexport interface SyntheticCallbacks {\n  /** Receive a value. */\n  onValue(value: string): void;\n}\n`,
      { mode: 0o600 }
    );

    const audited = runNode([auditScript, mutatedRoot]);
    expect(audited.status).not.toBe(0);
    expect(audited.stderr).toContain(
      'SyntheticCallbacks.onValue: @param names must exactly match (value); documented (none)'
    );
    expect(audited.stderr).toContain(
      'SyntheticCallbacks.onValue: requires exactly one nonempty @returns contract'
    );
  });

  it('builds and packs once, then executes the smoke suite against the preserved tarball bytes', () => {
    const candidateDirectory = join(temporaryRoot, 'release-candidate');
    const npmCache = join(temporaryRoot, 'npm-cache');
    mkdirSync(candidateDirectory, { recursive: true });
    mkdirSync(npmCache, { recursive: true });
    const packageSource = prepareIsolatedPackageSource();
    const npmEnvironment = { npm_config_cache: npmCache };

    const built = run(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'build'],
      packageSource,
      240_000,
      npmEnvironment
    );
    expect(built.status, `${built.stdout}${built.stderr}`).toBe(0);

    const packed = run(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--pack-destination', candidateDirectory],
      packageSource,
      120_000,
      npmEnvironment
    );
    if (packed.status !== 0) {
      throw new Error(
        `npm pack failed with status ${String(packed.status)}\n${packed.stdout}${packed.stderr}`
      );
    }
    const tarballs = readdirSync(candidateDirectory).filter((name) => name.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);
    expect(tarballs[0]).toMatch(/^cursor-history-.*\.tgz$/u);
    const tarball = join(candidateDirectory, tarballs[0]!);
    expect(statSync(tarball).isFile()).toBe(true);

    const beforeHash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    const smoked = runNode([smokeScript, tarball], repositoryRoot, 360_000, npmEnvironment);
    expect(smoked.status, `${smoked.stdout}${smoked.stderr}`).toBe(0);
    expect(JSON.parse(smoked.stdout)).toMatchObject({ candidate: tarball });

    const runtimeSmoked = runNode(
      [
        smokeScript,
        tarball,
        '--runtime-only',
        '--expected-backup-driver=node:sqlite',
        '--expected-node-sqlite-backup=supported',
      ],
      repositoryRoot,
      360_000,
      npmEnvironment
    );
    expect(runtimeSmoked.status, `${runtimeSmoked.stdout}${runtimeSmoked.stderr}`).toBe(0);
    expect(JSON.parse(runtimeSmoked.stdout)).toMatchObject({
      candidate: tarball,
      runtimeOnly: true,
      backupDriver: 'node:sqlite',
      nodeSqliteBackup: 'supported',
    });

    const missingExpectations = runNode(
      [smokeScript, tarball, '--runtime-only'],
      repositoryRoot,
      30_000,
      npmEnvironment
    );
    expect(missingExpectations.status).not.toBe(0);
    expect(missingExpectations.stderr).toContain(
      'runtime-only smoke requires recognized SQLite driver and capability expectations'
    );

    const unknownFlag = runNode(
      [smokeScript, tarball, '--runtime-only', '--capability-check-skipped'],
      repositoryRoot,
      30_000,
      npmEnvironment
    );
    expect(unknownFlag.status).not.toBe(0);
    expect(unknownFlag.stderr).toContain('unknown argument: --capability-check-skipped');

    const afterHash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    expect(afterHash).toBe(beforeHash);

    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow.match(/\bnpm pack\b/gu)).toHaveLength(1);
    expect(workflow).toContain('scripts/smoke-packed-package.mjs');
    expect(workflow).not.toMatch(/Clean-install and smoke exact package[\s\S]*npm run build/u);
  }, 360_000);
});
