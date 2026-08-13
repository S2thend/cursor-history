#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

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

const localizedReadmePaths = ['docs/readme_es.md', 'docs/readme_fr.md', 'docs/readme_zh.md'];

// Every localized TypeScript fence is typechecked. Runtime execution is limited
// to deterministic, read-only examples: the library read flow and the
// declaration-only configuration example. Driver selection depends on host
// capabilities; migration and backup/restore mutate data; error examples
// intentionally target environment-dependent failure paths. Each fence must
// match exactly one policy so adding, removing, or reordering examples cannot
// silently reduce this contract to a packaged-file existence check.
const localizedExamplePolicies = [
  {
    name: 'driver-selection',
    marker: "setDriver('better-sqlite3')",
    execute: false,
  },
  {
    name: 'library-read-flow',
    marker: 'exportSessionToMarkdown',
    execute: true,
  },
  {
    name: 'session-migration',
    marker: 'migrateWorkspace',
    execute: false,
  },
  {
    name: 'backup-and-restore',
    marker: 'listBackups',
    execute: false,
  },
  {
    name: 'configuration-types',
    marker: 'interface LibraryConfig',
    execute: true,
  },
  {
    name: 'error-handling',
    marker: 'isDatabaseLockedError',
    execute: false,
  },
];

function classifyLocalizedExamples(markdownPath, examples) {
  const classified = [];
  const observedPolicies = new Set();
  for (const [index, source] of examples.entries()) {
    const matchingPolicies = localizedExamplePolicies.filter(({ marker }) =>
      source.includes(marker)
    );
    if (matchingPolicies.length !== 1) {
      fail(
        `${markdownPath} TypeScript example ${index + 1} matched ` +
          `${matchingPolicies.length} localized runtime policies; expected exactly one`
      );
    }
    const policy = matchingPolicies[0];
    if (observedPolicies.has(policy.name)) {
      fail(`${markdownPath} repeats localized example policy ${policy.name}`);
    }
    observedPolicies.add(policy.name);
    classified.push({ index, source, policy });
  }
  for (const { name } of localizedExamplePolicies) {
    if (!observedPolicies.has(name)) {
      fail(`${markdownPath} is missing localized example policy ${name}`);
    }
  }
  return classified;
}

function assertPackagedMarkdownLinkClosure(installedRoot, markdownPaths) {
  let checkedTargets = 0;
  for (const markdownPath of markdownPaths) {
    const markdown = readFileSync(join(installedRoot, markdownPath), 'utf8');
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu)) {
      const rawTarget = (match[1] ?? '').replace(/^<|>$/gu, '');
      if (
        rawTarget.length === 0 ||
        rawTarget.startsWith('#') ||
        rawTarget.startsWith('//') ||
        /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)
      ) {
        continue;
      }
      const encodedPath = rawTarget.split(/[?#]/u, 1)[0] ?? '';
      let targetPath;
      try {
        targetPath = resolve(installedRoot, dirname(markdownPath), decodeURIComponent(encodedPath));
      } catch {
        fail(`${markdownPath} contains an invalid encoded local link ${rawTarget}`);
      }
      const packageRelative = relative(installedRoot, targetPath);
      if (
        packageRelative === '..' ||
        packageRelative.startsWith(`..${sep}`) ||
        isAbsolute(packageRelative)
      ) {
        fail(`${markdownPath} links outside the installed package: ${rawTarget}`);
      }
      if (!existsSync(targetPath)) {
        fail(`${markdownPath} links to missing packaged target ${rawTarget}`);
      }
      checkedTargets += 1;
    }
  }
  if (checkedTargets === 0) fail('packaged Markdown link-closure check executed no local targets');
  return checkedTargets;
}

function runTypecheckedDocumentationFence(markdownPath, index, workspace, env) {
  const sourcePath = join(
    workspace,
    `docs-${markdownPath.replace(/[^a-z0-9]/giu, '-')}-${index + 1}.mts`
  );
  const outputDirectory = join(workspace, 'compiled-documentation-examples');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  run(
    process.execPath,
    [
      join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--outDir',
      outputDirectory,
      sourcePath,
    ],
    { cwd: workspace }
  );
  const emittedPath = join(outputDirectory, basename(sourcePath).replace(/\.mts$/u, '.mjs'));
  if (!existsSync(emittedPath)) {
    fail(`${markdownPath} TypeScript example ${index + 1} emitted no runnable module`);
  }
  run(process.execPath, [emittedPath], { cwd: workspace, env });
}

function assertOwnerPrivateFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile()) fail(`${label} is not a regular file`);
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    fail(`${label} mode is ${(stat.mode & 0o777).toString(8)}; expected 600`);
  }
}

function assertUniquePersistenceIdentities(sessions, label) {
  const sessionIds = new Set();
  for (const session of sessions) {
    if (typeof session.id !== 'string' || session.id.length === 0) {
      fail(`${label} contains a session without a stable ID`);
    }
    if (sessionIds.has(session.id)) fail(`${label} contains duplicate session ID ${session.id}`);
    sessionIds.add(session.id);

    const messageIds = new Set();
    for (const [messageIndex, message] of session.messages.entries()) {
      if (typeof message.id !== 'string' || message.id.length === 0) {
        fail(`${label} session ${session.id} message ${messageIndex} has no stable ID`);
      }
      if (messageIds.has(message.id)) {
        fail(`${label} session ${session.id} contains duplicate message ID ${message.id}`);
      }
      messageIds.add(message.id);

      const toolIds = new Set();
      for (const [toolIndex, toolCall] of (message.toolCalls ?? []).entries()) {
        if (typeof toolCall.id !== 'string' || toolCall.id.length === 0) {
          fail(
            `${label} session ${session.id} message ${message.id} tool ${toolIndex} has no stable ID`
          );
        }
        if (toolIds.has(toolCall.id)) {
          fail(
            `${label} session ${session.id} message ${message.id} contains duplicate tool ID ${toolCall.id}`
          );
        }
        toolIds.add(toolCall.id);
      }
    }
  }
}

function synchronizePublicProjection(state, sessions, label) {
  assertUniquePersistenceIdentities(sessions, label);
  const nextIds = new Set();
  let writes = 0;
  for (const session of sessions) {
    nextIds.add(session.id);
    // This generic consumer projection deliberately covers every public value,
    // including message/tool order and their identity-to-content/relationship
    // bindings. It contains no downstream-specific adapter or policy.
    if (!isDeepStrictEqual(state.get(session.id), session)) {
      state.set(session.id, structuredClone(session));
      writes += 1;
    }
  }
  for (const sessionId of [...state.keys()]) {
    if (!nextIds.has(sessionId)) {
      state.delete(sessionId);
      writes += 1;
    }
  }
  return writes;
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
    'docs/release-verification.md',
    'docs/logo.png',
    'docs/readme_es.md',
    'docs/readme_fr.md',
    'docs/readme_zh.md',
  ];
  for (const relativePath of requiredFiles) {
    if (!existsSync(join(installedRoot, relativePath))) fail(`missing ${relativePath}`);
  }
  const linkedDocumentationTargets = assertPackagedMarkdownLinkClosure(
    installedRoot,
    requiredFiles.filter((relativePath) => relativePath.endsWith('.md'))
  );

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
  const localizedReadmes = new Map(
    localizedReadmePaths.map((markdownPath) => [
      markdownPath,
      readFileSync(join(installedRoot, markdownPath), 'utf8'),
    ])
  );
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
  const scopedWorkspace = '/work/a';
  const fixtureChatHash = '46d408964d3ec2a21d9a23d01b13d82c';
  const fixtureProjectDirectory = 'd-1-yuyu-proj-cursor-history';
  const scopedChatHash = createHash('md5').update(scopedWorkspace).digest('hex');
  const scopedProjectDirectory = scopedWorkspace.replace(/^\/+|\/+$/gu, '').replace(/[/:]+/gu, '-');
  renameSync(join(storeRoot, 'chats', fixtureChatHash), join(storeRoot, 'chats', scopedChatHash));
  renameSync(
    join(storeRoot, 'projects', fixtureProjectDirectory),
    join(storeRoot, 'projects', scopedProjectDirectory)
  );
  const scopedMetaPath = join(
    storeRoot,
    'chats',
    scopedChatHash,
    'aaaaaaaa-0000-0000-0000-000000000001',
    'meta.json'
  );
  const scopedMeta = JSON.parse(readFileSync(scopedMetaPath, 'utf8'));
  scopedMeta.cwd = scopedWorkspace;
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
    backup.manifest.version !== '1.0.0' ||
    backup.manifest.producer !== installedPackage.version ||
    backup.manifest.cursorHistoryVersion !== installedPackage.version ||
    typeof backup.manifest.composerWorkspaceInventory?.schemaVersion !== 'number' ||
    backup.manifest.composerWorkspaceInventory.schemaVersion !== 1
  ) {
    fail('backup result violated the packed-package manifest version contract');
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
    archivedManifest.version !== '1.0.0' ||
    archivedManifest.producer !== installedPackage.version ||
    archivedManifest.cursorHistoryVersion !== installedPackage.version ||
    typeof archivedManifest.composerWorkspaceInventory?.schemaVersion !== 'number' ||
    archivedManifest.composerWorkspaceInventory.schemaVersion !== 1
  ) {
    fail('archived manifest violated the packed-package manifest version contract');
  }
  const validation = await esm.validateBackup(backupPath);
  if (validation.status !== 'valid') fail('packed library could not validate its synthetic backup');

  const backupBytes = readFileSync(backupPath);
  const writeManifestVariant = async (targetPath, mutate) => {
    const variantZip = await JSZip.loadAsync(backupBytes);
    const manifestEntry = variantZip.file('manifest.json');
    if (!manifestEntry) fail('manifest variant source omitted manifest.json');
    const manifest = JSON.parse(await manifestEntry.async('string'));
    mutate(manifest);
    variantZip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const bytes = await variantZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    writeFileSync(targetPath, bytes, { flag: 'wx', mode: 0o600 });
    assertOwnerPrivateFile(targetPath, 'generated manifest variant');
    return manifest;
  };

  // v0.16 wrote the historical cursorHistoryVersion marker but had neither
  // producer nor the independently versioned workspace inventory.
  const legacyBackupPath = join(workspace, 'legacy-v1-manifest.zip');
  const legacyManifest = await writeManifestVariant(legacyBackupPath, (manifest) => {
    delete manifest.producer;
    delete manifest.composerWorkspaceInventory;
    manifest.cursorHistoryVersion = '0.9.2';
  });
  if (
    legacyManifest.version !== '1.0.0' ||
    Object.hasOwn(legacyManifest, 'producer') ||
    Object.hasOwn(legacyManifest, 'composerWorkspaceInventory') ||
    legacyManifest.cursorHistoryVersion !== '0.9.2'
  ) {
    fail('generated legacy manifest does not reproduce the v0.16 envelope');
  }

  const producerOnlyBackupPath = join(workspace, 'producer-only-manifest.zip');
  const producerOnlyManifest = await writeManifestVariant(producerOnlyBackupPath, (manifest) => {
    delete manifest.composerWorkspaceInventory;
    manifest.cursorHistoryVersion = '0.9.2';
    manifest.producer = installedPackage.version;
  });
  const producerNeutralManifest = { ...producerOnlyManifest };
  delete producerNeutralManifest.producer;
  if (
    producerOnlyManifest.producer !== installedPackage.version ||
    JSON.stringify(producerNeutralManifest) !== JSON.stringify(legacyManifest)
  ) {
    fail('producer-only manifest variant changed another manifest field');
  }

  for (const [label, path] of [
    ['legacy v1', legacyBackupPath],
    ['producer-only', producerOnlyBackupPath],
  ]) {
    const variantValidation = await esm.validateBackup(path);
    if (variantValidation.status !== 'valid') {
      fail(`${label} manifest variant is not readable by the packed library`);
    }
  }

  const currentSummaries = (await esm.listSessionSummaries({ backupPath })).data;
  const legacySummaries = (await esm.listSessionSummaries({ backupPath: legacyBackupPath })).data;
  const producerOnlySummaries = (
    await esm.listSessionSummaries({ backupPath: producerOnlyBackupPath })
  ).data;
  if (
    !isDeepStrictEqual(legacySummaries, currentSummaries) ||
    !isDeepStrictEqual(producerOnlySummaries, currentSummaries)
  ) {
    fail('manifest-only metadata changed the packed library summary projection');
  }

  const currentSessions = (await esm.listSessions({ backupPath })).data;
  const legacySessions = (await esm.listSessions({ backupPath: legacyBackupPath })).data;
  const producerOnlySessions = (
    await esm.listSessions({
      backupPath: producerOnlyBackupPath,
    })
  ).data;
  if (
    !isDeepStrictEqual(legacySessions, currentSessions) ||
    !isDeepStrictEqual(producerOnlySessions, currentSessions)
  ) {
    fail('manifest-only metadata changed the packed library session projection');
  }

  const searchNeedle = currentSessions
    .flatMap((session) => session.messages)
    .flatMap((message) => message.content.match(/[A-Za-z][A-Za-z0-9_-]{5,}/gu) ?? [])
    .at(0);
  if (!searchNeedle) fail('fictional backup has no deterministic nonempty search needle');
  const currentSearch = await esm.searchSessions(searchNeedle, { backupPath });
  if (currentSearch.length === 0) fail('fictional backup search baseline is empty');
  const legacySearch = await esm.searchSessions(searchNeedle, { backupPath: legacyBackupPath });
  const producerOnlySearch = await esm.searchSessions(searchNeedle, {
    backupPath: producerOnlyBackupPath,
  });
  if (
    !isDeepStrictEqual(legacySearch, currentSearch) ||
    !isDeepStrictEqual(producerOnlySearch, currentSearch)
  ) {
    fail('manifest-only metadata changed the packed library search projection');
  }

  const incrementalState = new Map();
  const initialWrites = synchronizePublicProjection(
    incrementalState,
    legacySessions,
    'legacy v1 projection'
  );
  if (initialWrites <= 0) fail('generic first synchronization produced no writes');
  const producerOnlyWrites = synchronizePublicProjection(
    incrementalState,
    producerOnlySessions,
    'producer-only projection'
  );
  if (producerOnlyWrites !== 0) {
    fail('changing only backup producer metadata caused incremental writes');
  }

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

  let localizedDocumentationExamples = {};
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

    localizedDocumentationExamples = Object.fromEntries(
      [...localizedReadmes.entries()].map(([markdownPath, markdown]) => {
        const examples = typecheckDocumentationFences(markdownPath, markdown, workspace);
        const classified = classifyLocalizedExamples(markdownPath, examples);
        const executed = [];
        for (const { index, policy } of classified) {
          if (!policy.execute) continue;
          runTypecheckedDocumentationFence(markdownPath, index, workspace, {
            CURSOR_DATA_PATH: storeRoot,
          });
          executed.push(policy.name);
        }
        return [
          markdownPath,
          {
            typechecked: classified.length,
            executed,
          },
        ];
      })
    );
  }

  const cliPath = join(installedRoot, 'dist/cli/index.js');
  let packedSchemaTestCount = 0;
  if (!runtimeOnly) {
    const schemaReportPath = join(workspace, 'packed-cli-schema-results.json');
    writeFileSync(schemaReportPath, '', { flag: 'wx', mode: 0o600 });
    run(
      process.execPath,
      [
        join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        join(repositoryRoot, 'tests/e2e/cli-json-schema.test.ts'),
        '--config',
        join(repositoryRoot, 'vitest.config.ts'),
        '--reporter=json',
        `--outputFile=${schemaReportPath}`,
      ],
      {
        cwd: repositoryRoot,
        timeout: 300_000,
        env: { CURSOR_HISTORY_SCHEMA_CLI_PATH: cliPath },
      }
    );
    const schemaVerification = run(
      process.execPath,
      [join(repositoryRoot, 'scripts/verify-test-results.mjs'), schemaReportPath],
      { cwd: repositoryRoot, timeout: 30_000 }
    );
    const schemaSummary = JSON.parse(schemaVerification.stdout);
    if (
      !Number.isSafeInteger(schemaSummary.executed) ||
      schemaSummary.executed <= 0 ||
      schemaSummary.passed !== schemaSummary.executed ||
      schemaSummary.allowedSkipped !== 0
    ) {
      fail('frozen packed-CLI schema suite was empty, incomplete, or skipped');
    }
    packedSchemaTestCount = schemaSummary.executed;
  }
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
      packedSchemaTestCount,
      linkedDocumentationTargets,
      localizedDocumentationExamples,
      manifestCompatibility: true,
      initialProjectionWrites: initialWrites,
      producerOnlyProjectionWrites: producerOnlyWrites,
    })}\n`
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
