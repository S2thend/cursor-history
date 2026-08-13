#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function typescriptFences(markdown) {
  return [...markdown.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/gu)].map(
    (match) => match[1] ?? ''
  );
}

function typecheckDocumentationFences(markdownPath, markdown, workspace) {
  const examples = typescriptFences(markdown);
  if (examples.length === 0) fail(`${markdownPath} has no TypeScript contract examples`);
  for (const [index, source] of examples.entries()) {
    const examplePath = join(
      workspace,
      `docs-${markdownPath.replace(/[^a-z0-9]/giu, '-')}-${index + 1}.mts`
    );
    writeFileSync(examplePath, source, { mode: 0o600 });
    run(
      process.execPath,
      [
        join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        examplePath,
      ],
      { cwd: workspace }
    );
  }
  return examples;
}

const requestedTarball = process.argv[2];
const smokeArguments = new Map();
for (const argument of process.argv.slice(3)) {
  const separator = argument.indexOf('=');
  const name = separator < 0 ? argument : argument.slice(0, separator);
  const value = separator < 0 ? 'true' : argument.slice(separator + 1);
  if (
    !['--runtime-only', '--expected-backup-driver', '--expected-node-sqlite-backup'].includes(name)
  ) {
    fail(`unknown argument: ${name}`);
  }
  if (smokeArguments.has(name)) fail(`duplicate argument: ${name}`);
  if (name === '--runtime-only' && argument !== '--runtime-only') {
    fail('--runtime-only does not accept a value');
  }
  if (name !== '--runtime-only' && (separator < 0 || value.length === 0)) {
    fail(`${name} requires a nonempty value`);
  }
  smokeArguments.set(name, value);
}
const runtimeOnly = smokeArguments.get('--runtime-only') === 'true';
const expectedBackupDriver = smokeArguments.get('--expected-backup-driver');
const expectedNodeSqliteBackup = smokeArguments.get('--expected-node-sqlite-backup');
if (!requestedTarball) {
  fail(
    'usage: smoke-packed-package.mjs <package.tgz> [--runtime-only ' +
      '--expected-backup-driver=<driver> --expected-node-sqlite-backup=<profile>]'
  );
}
if (!runtimeOnly && (expectedBackupDriver || expectedNodeSqliteBackup)) {
  fail('SQLite runtime expectations require --runtime-only');
}
if (
  runtimeOnly &&
  (!['better-sqlite3', 'node:sqlite'].includes(expectedBackupDriver ?? '') ||
    !['unavailable', 'missing', 'supported'].includes(expectedNodeSqliteBackup ?? ''))
) {
  fail('runtime-only smoke requires recognized SQLite driver and capability expectations');
}

const tarball = resolve(requestedTarball);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    ['install', '--no-audit', '--no-fund', '--prefer-offline', '--save-exact', tarball],
    { cwd: workspace, timeout: 300_000 }
  );

  const installedRoot = join(workspace, 'node_modules', 'cursor-history');
  const installedPackage = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  const supportedNodeMajors = '20.x || 22.x || 23.x || 24.x || 25.x || 26.x';
  if (installedPackage.engines?.node !== supportedNodeMajors) {
    fail(
      `package declares Node ${String(installedPackage.engines?.node)}; ` +
        `expected ${supportedNodeMajors}`
    );
  }
  const requiredFiles = [
    'dist/lib/index.js',
    'dist/lib/index.cjs',
    'dist/lib/index.d.ts',
    'dist/cli/index.js',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'docs/compatibility.md',
    'docs/logo.png',
    'docs/readme_es.md',
    'docs/readme_fr.md',
    'docs/readme_zh.md',
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
  for (const requiredExport of [
    'createSessionReadContext',
    'getSession',
    'listSessionSummaries',
    'listSessions',
    'searchSessions',
    'isWorkspaceAmbiguityError',
    'isSessionAmbiguityError',
    'isSessionScopeMismatchError',
    'isUnsupportedSessionMigrationError',
    'isMigrationTargetChangedError',
    'isDatabaseCapabilityError',
    'isNoCapableDriverError',
    'isBackupPublishedPermissionError',
    'isTemporaryArtifactCleanupError',
    'isReadContextError',
    'isReadContextSourceMismatchError',
    'isReadContextScopeMismatchError',
    'isReadContextOptionsMismatchError',
    'isReadContextDisposedError',
    'isSourceEncodingError',
    'isSourceLimitExceededError',
    'isSourceLimitConfigurationError',
  ]) {
    if (!esmExports.includes(requiredExport)) {
      fail(`package root is missing required value export ${requiredExport}`);
    }
  }
  if (esm.getActiveDriver() !== undefined || cjs.getActiveDriver() !== undefined) {
    fail('fresh ESM/CJS imports changed the documented inactive-driver value');
  }

  const declaration = readFileSync(join(installedRoot, 'dist/lib/index.d.ts'), 'utf8');
  if (!declaration.includes('export')) fail('package-root declaration file has no exports');
  const publicTypesDeclaration = readFileSync(join(installedRoot, 'dist/lib/types.d.ts'), 'utf8');
  for (const declarationContract of [
    'export type SessionSummary = ResolvedSessionSummary | AmbiguousSessionSummary;',
    'Zero-based presentation index within this catalog invocation and scope.',
    'Single index (1-based): "3" or 3',
  ]) {
    if (!publicTypesDeclaration.includes(declarationContract)) {
      fail(`public declarations are missing contract: ${declarationContract}`);
    }
  }
  if (!runtimeOnly) {
    const audit = run(
      process.execPath,
      [join(repositoryRoot, 'scripts/audit-public-api-docs.mjs'), installedRoot],
      { cwd: repositoryRoot }
    );
    const declarationAudit = JSON.parse(audit.stdout);
    if (JSON.stringify(declarationAudit.valueExports) !== JSON.stringify(esmExports)) {
      fail('runtime and declaration package-root value exports differ');
    }
  }
  const readme = readFileSync(join(installedRoot, 'README.md'), 'utf8');
  const compatibility = readFileSync(join(installedRoot, 'docs/compatibility.md'), 'utf8');
  if (!compatibility.includes('Compatibility Matrix v1')) {
    fail('packaged compatibility contract does not identify Matrix v1');
  }
  for (const documentedCommand of [
    'cursor-history --json --workspace /work/a list --all',
    'cursor-history --json --workspace /work/a show 1',
    'cursor-history --json --workspace /work/a search needle-a',
  ]) {
    if (!compatibility.includes(documentedCommand)) {
      fail(`packaged compatibility contract is missing example: ${documentedCommand}`);
    }
  }

  const cli = run(process.execPath, [join(installedRoot, 'dist/cli/index.js'), '--version'], {
    cwd: workspace,
    timeout: 30_000,
  });
  if (cli.stdout.trim() !== installedPackage.version) {
    fail(`CLI version ${cli.stdout.trim()} does not match package ${installedPackage.version}`);
  }

  // Exercise the package-manager-created executable, not only the resolved JS
  // target. POSIX installs it as a symlink and Windows as a command shim; both
  // must trigger the CLI's direct-entry guard.
  const installedBin = join(
    workspace,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'cursor-history.cmd' : 'cursor-history'
  );
  const binCli = run(installedBin, ['--version'], { cwd: workspace, timeout: 30_000 });
  if (binCli.stdout.trim() !== installedPackage.version) {
    fail(
      `installed CLI version ${binCli.stdout.trim()} does not match package ${installedPackage.version}`
    );
  }

  const storeRoot = join(workspace, 'synthetic-store');
  cpSync(join(repositoryRoot, 'tests/fixtures/store-root'), storeRoot, { recursive: true });
  const scopedMetaPath = join(
    storeRoot,
    'chats/46d408964d3ec2a21d9a23d01b13d82c/aaaaaaaa-0000-0000-0000-000000000001/meta.json'
  );
  const scopedMeta = JSON.parse(readFileSync(scopedMetaPath, 'utf8'));
  scopedMeta.cwd = '/work/a';
  writeFileSync(scopedMetaPath, `${JSON.stringify(scopedMeta)}\n`, { mode: 0o600 });

  const pathlessId = 'bbbbbbbb-0000-0000-0000-000000000002';
  const summaryListing = await esm.listSessionSummaries({ dataPath: storeRoot });
  const pathlessCatalogRow = summaryListing.data.find((session) => session.id === pathlessId);
  if (!pathlessCatalogRow) fail('packed summary API omitted the synthetic pathless session');
  if (
    pathlessCatalogRow.resolutionState === 'ambiguous' ||
    pathlessCatalogRow.workspace !== 'unknown' ||
    Object.hasOwn(pathlessCatalogRow, 'canonicalWorkspacePath') ||
    Object.hasOwn(pathlessCatalogRow, 'messages')
  ) {
    fail('pathless summary changed its resolved/message-free unknown-workspace contract');
  }
  const pathlessByIndex = await esm.getSession(pathlessCatalogRow.index, {
    dataPath: storeRoot,
  });
  if (pathlessByIndex.id !== pathlessId) {
    fail('zero-based summary index did not round-trip through the public read API');
  }

  const libraryListing = await esm.listSessions({ dataPath: storeRoot });
  const pathlessSummary = libraryListing.data.find((session) => session.id === pathlessId);
  if (!pathlessSummary) fail('packed library omitted the synthetic pathless session');
  if (pathlessSummary.id !== pathlessId || pathlessSummary.workspace !== 'unknown') {
    fail('pathless public alias changed the native UUID or unknown-workspace contract');
  }
  const pathlessSession = await esm.getSession(pathlessId, { dataPath: storeRoot });
  if (pathlessSession.id !== pathlessId || pathlessSession.workspace !== 'unknown') {
    fail('direct pathless lookup did not preserve the package-root public contract');
  }

  const guardCases = [
    [
      'isWorkspaceAmbiguityError',
      new esm.WorkspaceAmbiguityError('work', ['/one/work', '/two/work']),
    ],
    ['isSessionAmbiguityError', new esm.SessionAmbiguityError(pathlessId, ['one', 'two'])],
    ['isSessionScopeMismatchError', new esm.SessionScopeMismatchError(pathlessId, '/work/a')],
    [
      'isUnsupportedSessionMigrationError',
      new esm.UnsupportedSessionMigrationError(pathlessId, 'store-only'),
    ],
    ['isMigrationTargetChangedError', new esm.MigrationTargetChangedError(pathlessId)],
    [
      'isDatabaseCapabilityError',
      new esm.DatabaseCapabilityError('node:sqlite', 'backup', ['onlineBackup']),
    ],
    ['isNoCapableDriverError', new esm.NoCapableDriverError('read-session', ['read'])],
    [
      'isBackupPublishedPermissionError',
      new esm.BackupPublishedPermissionError('/published/backup.zip', 0o640, 0o600),
    ],
    ['isTemporaryArtifactCleanupError', new esm.TemporaryArtifactCleanupError(['/private/tmp'])],
    ['isReadContextError', new esm.ReadContextDisposedError()],
    ['isReadContextSourceMismatchError', new esm.ReadContextSourceMismatchError()],
    ['isReadContextScopeMismatchError', new esm.ReadContextScopeMismatchError()],
    ['isReadContextOptionsMismatchError', new esm.ReadContextOptionsMismatchError('sqliteDriver')],
    ['isReadContextDisposedError', new esm.ReadContextDisposedError()],
    ['isSourceEncodingError', new esm.SourceEncodingError('jsonl', 'fatal')],
    [
      'isSourceLimitExceededError',
      new esm.SourceLimitExceededError({
        sourceKind: 'jsonl',
        bound: 'jsonl-record-count',
        unit: 'records',
        limit: 1,
        observedAtLeast: 2,
        outcome: 'fatal',
      }),
    ],
    [
      'isSourceLimitConfigurationError',
      new esm.SourceLimitConfigurationError('jsonlRecordCount', 0, 'must be positive'),
    ],
  ];
  for (const [guardName, error] of guardCases) {
    if (!esm[guardName](error) || esm[guardName](new Error('wrong type'))) {
      fail(`packed type guard ${guardName} does not narrow its documented error class`);
    }
  }

  const composerUserRoot = join(workspace, 'synthetic-composer', 'User');
  const composerWorkspaceRoot = join(composerUserRoot, 'workspaceStorage');
  const composerGlobalRoot = join(composerUserRoot, 'globalStorage');
  mkdirSync(composerWorkspaceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(composerGlobalRoot, { recursive: true, mode: 0o700 });
  copyFileSync(
    join(repositoryRoot, 'tests/compatibility/fixtures/v016/composer-global-state.vscdb'),
    join(composerGlobalRoot, 'state.vscdb')
  );
  const backupPath = join(workspace, 'producer-version.zip');
  const backup = await esm.createBackup({
    sourcePath: composerWorkspaceRoot,
    outputPath: backupPath,
    force: true,
  });
  if (
    backup.manifest.producer !== installedPackage.version ||
    backup.manifest.cursorHistoryVersion !== installedPackage.version
  ) {
    fail('backup result did not report the running packed-package version');
  }
  if (expectedBackupDriver && esm.getActiveDriver() !== expectedBackupDriver) {
    fail(
      `automatic backup selected ${String(esm.getActiveDriver())}; expected ${expectedBackupDriver}`
    );
  }
  const JSZip = requireFromWorkspace('jszip');
  const backupZip = await JSZip.loadAsync(readFileSync(backupPath));
  const archivedManifestEntry = backupZip.file('manifest.json');
  if (!archivedManifestEntry) fail('packed library backup omitted manifest.json');
  const archivedManifest = JSON.parse(await archivedManifestEntry.async('string'));
  if (
    archivedManifest.producer !== installedPackage.version ||
    archivedManifest.cursorHistoryVersion !== installedPackage.version
  ) {
    fail('archived manifest producer does not match the running packed-package version');
  }
  const validation = await esm.validateBackup(backupPath);
  if (validation.status !== 'valid') fail('packed library could not validate its synthetic backup');

  if (expectedNodeSqliteBackup) {
    esm.setDriver('node:sqlite');
    const forcedBackupPath = join(workspace, 'forced-node-sqlite.zip');
    let forcedBackupError;
    try {
      await esm.createBackup({
        sourcePath: composerWorkspaceRoot,
        outputPath: forcedBackupPath,
        force: true,
      });
    } catch (error) {
      forcedBackupError = error;
    }

    if (expectedNodeSqliteBackup === 'supported') {
      if (forcedBackupError) {
        fail(`capable forced node:sqlite backup failed: ${String(forcedBackupError)}`);
      }
      if (!existsSync(forcedBackupPath)) fail('capable forced node:sqlite backup wrote no archive');
    } else {
      if (!forcedBackupError) {
        fail(`forced node:sqlite backup unexpectedly succeeded for ${expectedNodeSqliteBackup}`);
      }
      const expectedErrorName =
        expectedNodeSqliteBackup === 'unavailable'
          ? 'DriverNotAvailableError'
          : 'DatabaseCapabilityError';
      if (forcedBackupError?.name !== expectedErrorName) {
        fail(
          `forced node:sqlite backup returned ${String(forcedBackupError?.name)}; ` +
            `expected ${expectedErrorName}`
        );
      }
      if (
        expectedNodeSqliteBackup === 'unavailable' &&
        !(forcedBackupError instanceof esm.DriverNotAvailableError)
      ) {
        fail('unavailable node:sqlite did not return the exported driver error class');
      }
      if (
        expectedNodeSqliteBackup === 'missing' &&
        (!esm.isDatabaseCapabilityError(forcedBackupError) ||
          forcedBackupError.details?.operation !== 'backup' ||
          JSON.stringify(forcedBackupError.details?.missingCapabilities) !==
            JSON.stringify(['onlineBackup']) ||
          !forcedBackupError.details?.alternatives?.includes('better-sqlite3'))
      ) {
        fail('incapable node:sqlite did not report the exact online-backup capability boundary');
      }
      if (existsSync(forcedBackupPath)) {
        fail('incapable forced node:sqlite backup published an archive');
      }
    }
  }

  if (!runtimeOnly) {
    typecheckDocumentationFences('README.md', readme, workspace);
    const compatibilityExamples = typecheckDocumentationFences(
      'docs/compatibility.md',
      compatibility,
      workspace
    );
    const publicExample = compatibilityExamples.find((source) =>
      source.includes("const workspace = '/work/a';")
    );
    if (!publicExample) {
      fail('packaged compatibility contract is missing its public-library example');
    }
    const typecheckedExamplePath = join(workspace, 'public-example.mts');
    writeFileSync(typecheckedExamplePath, publicExample, { mode: 0o600 });
    run(process.execPath, [typecheckedExamplePath], {
      cwd: workspace,
      env: { CURSOR_DATA_PATH: storeRoot },
    });
  }

  const cliPath = join(installedRoot, 'dist/cli/index.js');
  const documentedList = run(
    process.execPath,
    [cliPath, '--json', '--data-path', storeRoot, '--workspace', '/work/a', 'list', '--all'],
    { cwd: workspace, timeout: 30_000 }
  );
  const listedJson = JSON.parse(documentedList.stdout);
  if (listedJson.sessions?.[0]?.id !== 'aaaaaaaa-0000-0000-0000-000000000001') {
    fail('documented workspace-scoped list example did not resolve the synthetic session');
  }
  const documentedShow = run(
    process.execPath,
    [cliPath, '--json', '--data-path', storeRoot, '--workspace', '/work/a', 'show', '1'],
    { cwd: workspace, timeout: 30_000 }
  );
  if (JSON.parse(documentedShow.stdout).id !== listedJson.sessions[0].id) {
    fail('documented scoped list/show index did not round-trip in the packed CLI');
  }
  const documentedSearch = run(
    process.execPath,
    [
      cliPath,
      '--json',
      '--data-path',
      storeRoot,
      '--workspace',
      '/work/a',
      'search',
      'Read foo.txt',
    ],
    { cwd: workspace, timeout: 30_000 }
  );
  const searchedJson = JSON.parse(documentedSearch.stdout);
  if (searchedJson.results?.[0]?.sessionId !== listedJson.sessions[0].id) {
    fail('documented scoped search example returned the wrong logical session');
  }

  process.stdout.write(
    `${JSON.stringify({
      package: installedPackage.name,
      version: installedPackage.version,
      exportCount: esmExports.length,
      candidate: tarball,
      runtimeOnly,
      backupDriver: expectedBackupDriver ?? esm.getActiveDriver(),
      nodeSqliteBackup: expectedNodeSqliteBackup,
    })}\n`
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
