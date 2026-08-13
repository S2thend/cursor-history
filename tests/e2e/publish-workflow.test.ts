import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve('.github/workflows/npm-publish.yml');
const runtimeSmokePath = resolve('scripts/smoke-packed-package.mjs');
const runtimeProfiles = [
  ['20.0.0', 'better-sqlite3', 'unavailable'],
  ['22.15.1', 'better-sqlite3', 'missing'],
  ['22.16.0', 'node:sqlite', 'supported'],
  ['23.7.0', 'better-sqlite3', 'missing'],
  ['23.8.0', 'node:sqlite', 'supported'],
  ['24.x', 'node:sqlite', 'supported'],
  ['25.x', 'node:sqlite', 'supported'],
  ['26.x', 'node:sqlite', 'supported'],
] as const;

function workflow(): string {
  return readFileSync(workflowPath, 'utf8');
}

function jobBlock(source: string, jobName: string): string {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) return '';
  const end = lines.findIndex(
    (line, index) => index > start && /^  [a-zA-Z0-9_-]+:\s*$/u.test(line)
  );
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function jobNeeds(source: string, jobName: string): string[] {
  const block = jobBlock(source, jobName);
  const lines = block.split(/\r?\n/u);
  const needsIndex = lines.findIndex((line) => /^    needs:/u.test(line));
  if (needsIndex < 0) return [];
  const value = lines[needsIndex].replace(/^    needs:\s*/u, '').trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (value.length > 0) return [value];
  return lines
    .slice(needsIndex + 1)
    .map((line) => /^      -\s+([a-zA-Z0-9_-]+)\s*$/u.exec(line)?.[1])
    .filter((item): item is string => item !== undefined);
}

function mutateJob(source: string, jobName: string, target: string, replacement: string): string {
  const block = jobBlock(source, jobName);
  if (!block.includes(target)) return source;
  return source.replace(block, block.replace(target, replacement));
}

function unsafeReleaseBypasses(source: string): string[] {
  const failures: string[] = [];
  if (
    /\bnpm\s+(?:test|run\s+(?:typecheck|lint|build))\b[^\n]*(?:\|\||continue-on-error)/.test(source)
  ) {
    failures.push('validation failure is swallowed');
  }
  if (/continue-on-error:\s*true/.test(source)) failures.push('workflow permits a failed step');
  if ((source.match(/\bnpm pack\b/g) ?? []).length !== 1)
    failures.push('candidate is not packed once');

  const verificationNeeds = jobNeeds(source, 'verify-candidate');
  const publishNeeds = jobNeeds(source, 'publish');
  const sourceQualityJob = jobBlock(source, 'source-quality');
  const packageJob = jobBlock(source, 'package-candidate');
  const runtimeJob = jobBlock(source, 'runtime-candidate');
  const verificationJob = jobBlock(source, 'verify-candidate');
  const approvalJob = jobBlock(source, 'approve-candidate');
  const publishJob = jobBlock(source, 'publish');
  if (!verificationNeeds.includes('package-candidate')) {
    failures.push('verification bypasses the preserved candidate');
  }
  if (!jobNeeds(source, 'package-candidate').includes('source-quality')) {
    failures.push('packaging bypasses source quality');
  }
  if (!jobNeeds(source, 'runtime-candidate').includes('package-candidate')) {
    failures.push('runtime matrix bypasses the preserved candidate');
  }
  for (const dependency of ['package-candidate', 'verify-candidate', 'runtime-candidate']) {
    if (!publishNeeds.includes(dependency)) {
      failures.push(`publish bypasses ${dependency}`);
    }
  }
  if (
    publishNeeds.length !== 3 ||
    publishNeeds.some(
      (dependency) =>
        !['package-candidate', 'verify-candidate', 'runtime-candidate'].includes(dependency)
    )
  ) {
    failures.push('publish has an indirect or unexpected approval dependency');
  }
  if (approvalJob.length > 0) {
    failures.push('separate no-op approval job remains');
  }
  const releaseEnvironmentPattern = /^    environment:\s*npm-release-verification\s*$/gmu;
  const releaseEnvironmentCount = source.match(releaseEnvironmentPattern)?.length ?? 0;
  const publishEnvironmentCount =
    publishJob.match(/^    environment:\s*npm-release-verification\s*$/gmu)?.length ?? 0;
  if (publishEnvironmentCount !== 1) {
    failures.push('publish is not protected by the release environment');
  }
  if (releaseEnvironmentCount !== publishEnvironmentCount) {
    failures.push('release environment is attached outside the publish job');
  }
  if (/^    if:\s*.*\balways\s*\(\s*\)/mu.test(publishJob)) {
    failures.push('publish runs after a failed dependency');
  }
  if (!/^        run:\s*npm ci\s*$/mu.test(verificationJob)) {
    failures.push('verification does not install its locked dependency lifecycle');
  }
  if (/^        run:\s*npm ci\b[^\n]*--ignore-scripts\b/mu.test(verificationJob)) {
    failures.push('verification disables dependency lifecycle scripts');
  }
  const oidcPermissionCount = source.match(/^      id-token:\s*write\s*$/gmu)?.length ?? 0;
  const publishOidcPermissionCount =
    publishJob.match(/^      id-token:\s*write\s*$/gmu)?.length ?? 0;
  if (publishOidcPermissionCount !== 1) {
    failures.push('publish lacks OIDC permission');
  }
  if (oidcPermissionCount !== publishOidcPermissionCount) {
    failures.push('OIDC permission is exposed outside the publish job');
  }
  if (!sourceQualityJob.includes("node-version: '24.x'")) {
    failures.push('source quality uses an unsupported development toolchain');
  }
  for (const command of [
    'npm ci',
    'npm run typecheck',
    'npm run lint',
    'npm test',
    'npm run build',
  ]) {
    if (!sourceQualityJob.includes(command)) failures.push(`source quality skips ${command}`);
  }
  if (/\bnpm\s+(?:ci|test|run\s+(?:typecheck|lint|build))\b/u.test(runtimeJob)) {
    failures.push('minimum runtime executes unsupported source tooling');
  }
  for (const flag of [
    '--runtime-only',
    '--expected-backup-driver=${{ matrix.backup-driver }}',
    '--expected-node-sqlite-backup=${{ matrix.node-sqlite-backup }}',
  ]) {
    if (!runtimeJob.includes(flag)) failures.push(`runtime matrix skips ${flag}`);
  }
  for (const [version, driver, capability] of runtimeProfiles) {
    const profile =
      `          - node-version: '${version}'\n` +
      `            backup-driver: ${driver}\n` +
      `            node-sqlite-backup: ${capability}`;
    if (!runtimeJob.includes(profile)) failures.push(`runtime matrix changes ${version} profile`);
  }

  for (const [label, block] of [
    ['runtime', runtimeJob],
    ['verification', verificationJob],
    ['publish', publishJob],
  ] as const) {
    if (!/^\s*sha256sum -c candidate\.sha256\s*$/mu.test(block)) {
      failures.push(`${label} skips candidate checksum`);
    }
  }
  for (const [label, block] of [
    ['runtime', runtimeJob],
    ['verification', verificationJob],
    ['publish', publishJob],
  ] as const) {
    if (
      !block.includes(
        'ACTUAL_SHA256=$(sha256sum "${{ needs.package-candidate.outputs.tarball }}"'
      ) ||
      !block.includes('test "$ACTUAL_SHA256" = "${{ needs.package-candidate.outputs.sha256 }}"')
    ) {
      failures.push(`${label} does not bind candidate bytes to the trusted sha256 output`);
    }
    if (!block.includes('candidate-metadata.json").revision\')" = "$GITHUB_SHA"')) {
      failures.push(`${label} skips candidate revision identity`);
    }
    if (
      !block.includes(
        'candidate-metadata.json").version\')" = "${{ needs.package-candidate.outputs.version }}"'
      )
    ) {
      failures.push(`${label} skips candidate version identity`);
    }
    if (
      !block.includes(
        'candidate-metadata.json").tag\')" = "v${{ needs.package-candidate.outputs.version }}"'
      )
    ) {
      failures.push(`${label} skips candidate tag identity`);
    }
    if (
      !block.includes(
        'candidate-metadata.json").sha256\')" = "${{ needs.package-candidate.outputs.sha256 }}"'
      )
    ) {
      failures.push(`${label} skips candidate sha256 identity`);
    }
    if (
      !block.includes(
        'candidate-metadata.json").tarball\')" = "${{ needs.package-candidate.outputs.tarball }}"'
      )
    ) {
      failures.push(`${label} skips candidate tarball identity`);
    }
    if (!block.includes('name: npm-candidate-${{ needs.package-candidate.outputs.sha256 }}')) {
      failures.push(`${label} downloads an unaddressed candidate`);
    }
  }
  if (!packageJob.includes('name: npm-candidate-${{ steps.identity.outputs.sha256 }}')) {
    failures.push('package upload is not checksum-addressed');
  }

  if (!/npm publish[^\n]*needs\.package-candidate\.outputs\.tarball/.test(publishJob)) {
    failures.push('publish does not consume the tarball');
  }
  if (/\bnpm (?:pack|run build)\b/u.test(publishJob)) {
    failures.push('publish rebuilds or repacks after approval');
  }
  return failures;
}

function unsafeRuntimeSmoke(source: string): string[] {
  const failures: string[] = [];
  for (const contract of [
    'process.argv.slice(3)',
    'fail(`unknown argument: ${name}`)',
    'esm.getActiveDriver() !== expectedBackupDriver',
    "esm.setDriver('node:sqlite')",
    "expectedNodeSqliteBackup === 'supported'",
    'forcedBackupError instanceof esm.DriverNotAvailableError',
    'esm.isDatabaseCapabilityError(forcedBackupError)',
    "forcedBackupError.details?.operation !== 'backup'",
    "JSON.stringify(['onlineBackup'])",
    "forcedBackupError.details?.alternatives?.includes('better-sqlite3')",
  ]) {
    if (!source.includes(contract)) failures.push(`runtime smoke skips ${contract}`);
  }
  return failures;
}

function unsafeFullPackageSmoke(source: string): string[] {
  const failures: string[] = [];
  const requiredContracts = [
    [
      'if (!runtimeOnly) {\n    const schemaReportPath',
      'full smoke bypasses the frozen schema suite',
    ],
    ['CURSOR_HISTORY_SCHEMA_CLI_PATH: cliPath', 'schema suite does not use the installed CLI'],
    ['tests/e2e/cli-json-schema.test.ts', 'full smoke omits the frozen schema suite'],
    ['scripts/verify-test-results.mjs', 'schema suite is not verified fail-closed'],
    [
      'schemaSummary.passed !== schemaSummary.executed',
      'schema suite does not require every executed test to pass',
    ],
    ['schemaSummary.allowedSkipped !== 0', 'schema suite permits skipped coverage'],
    ["backup.manifest.version !== '1.0.0'", 'backup result outer manifest version is unchecked'],
    [
      "typeof backup.manifest.composerWorkspaceInventory?.schemaVersion !== 'number'",
      'backup result inventory schema type is unchecked',
    ],
    [
      'backup.manifest.composerWorkspaceInventory.schemaVersion !== 1',
      'backup result inventory schema value is unchecked',
    ],
    [
      "writeFileSync(targetPath, bytes, { flag: 'wx', mode: 0o600 })",
      'legacy variants are not private',
    ],
    ["legacyManifest.cursorHistoryVersion !== '0.9.2'", 'legacy v0.16 marker is unchecked'],
    [
      "Object.hasOwn(legacyManifest, 'composerWorkspaceInventory')",
      'legacy inventory omission is unchecked',
    ],
    ["Object.hasOwn(legacyManifest, 'producer')", 'legacy producer omission is unchecked'],
    [
      "if (variantValidation.status !== 'valid')",
      'manifest variants are not validated for readability',
    ],
    [
      "fail('manifest-only metadata changed the packed library session projection')",
      'manifest metadata can alter public read projections',
    ],
    ['isDeepStrictEqual(state.get(session.id), session)', 'incremental comparison loses shape'],
    ['state.set(session.id, structuredClone(session))', 'incremental state loses shape'],
    ['esm.listSessionSummaries({ backupPath })', 'summary projection is not checked'],
    [
      "fail('manifest-only metadata changed the packed library summary projection')",
      'manifest metadata can alter summary projections',
    ],
    ['const currentSearch = await esm.searchSessions', 'search projection is not checked'],
    ['if (currentSearch.length === 0)', 'search projection accepts an empty baseline'],
    [
      "fail('manifest-only metadata changed the packed library search projection')",
      'manifest metadata can alter search projections',
    ],
    [
      "if (initialWrites <= 0) fail('generic first synchronization produced no writes')",
      'generic first synchronization is not exercised',
    ],
    ['if (producerOnlyWrites !== 0)', 'producer-only mutation can cause incremental writes'],
  ] as const;
  for (const [contract, failure] of requiredContracts) {
    if (!source.includes(contract)) failures.push(failure);
  }
  return failures;
}

describe('npm publication workflow', () => {
  it('declares exactly the runtime majors supported by the packaged native dependency', () => {
    const packageDocument = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    const lockDocument = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as {
      packages?: Record<string, { engines?: { node?: string } }>;
    };
    const supported = '20.x || 22.x || 23.x || 24.x || 25.x || 26.x';

    expect(packageDocument.engines?.node).toBe(supported);
    expect(lockDocument.packages?.['']?.engines?.node).toBe(supported);
    expect(supported).not.toContain('21.x');
    expect(supported).not.toMatch(/>=\s*20/u);
  });

  it('builds current sources before plain npm test can execute built-CLI coverage', () => {
    const packageDocument = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageDocument.scripts?.pretest).toBe('npm run build');

    const missingPreparation = JSON.stringify({
      ...packageDocument,
      scripts: { ...packageDocument.scripts, pretest: 'echo skipped' },
    });
    expect(JSON.parse(missingPreparation).scripts.pretest).not.toBe('npm run build');
  });

  it('does not encode supported-runtime SQLite capability boundaries as skipped tests', () => {
    const driverIntegration = readFileSync(resolve('tests/integration/drivers.test.ts'), 'utf8');

    expect(driverIntegration).not.toMatch(/(?:describe|it|test)\.skip/u);
    expect(driverIntegration).toContain('node:sqlite unavailable runtime profile');
    expect(driverIntegration).toContain('better-sqlite3 unavailable runtime profile');
  });

  it('runs every required runtime boundary without swallowing validation failures', () => {
    const source = workflow();
    const sourceQuality = jobBlock(source, 'source-quality');
    const runtimeCandidate = jobBlock(source, 'runtime-candidate');

    for (const [version] of runtimeProfiles) {
      expect(runtimeCandidate).toContain(`'${version}'`);
    }
    expect(runtimeCandidate).not.toContain("node-version: '21.x'");
    for (const command of [
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'npm run build',
    ]) {
      expect(sourceQuality).toContain(command);
    }
    expect(sourceQuality).toContain("node-version: '24.x'");
    expect(sourceQuality).not.toContain("node-version: '20.0.0'");
    expect(runtimeCandidate).not.toMatch(/\bnpm\s+(?:ci|test|run\s+(?:typecheck|lint|build))\b/u);
    expect(runtimeCandidate).toContain('--runtime-only');
    expect(runtimeCandidate).toContain('--expected-backup-driver=${{ matrix.backup-driver }}');
    expect(runtimeCandidate).toContain(
      '--expected-node-sqlite-backup=${{ matrix.node-sqlite-backup }}'
    );
    expect(runtimeCandidate.match(/backup-driver: better-sqlite3/gu)).toHaveLength(3);
    expect(runtimeCandidate.match(/backup-driver: node:sqlite/gu)).toHaveLength(5);
    expect(runtimeCandidate.match(/node-sqlite-backup: unavailable/gu)).toHaveLength(1);
    expect(runtimeCandidate.match(/node-sqlite-backup: missing/gu)).toHaveLength(2);
    expect(runtimeCandidate.match(/node-sqlite-backup: supported/gu)).toHaveLength(5);
    expect(source).not.toMatch(/npm test\s*\|\|/);
    expect(source).not.toContain('continue-on-error: true');
  });

  it('packs once, records identity, verifies behind protected publish, and publishes the same bytes', () => {
    const source = workflow();

    expect(source.match(/\bnpm pack\b/g)).toHaveLength(1);
    expect(source).toContain('sha256sum');
    expect(source).toContain('candidate-metadata.json');
    expect(source).toContain('actions/upload-artifact@v4');
    expect(source).toContain('actions/download-artifact@v4');
    expect(source).toContain('Clean-install and smoke exact package');
    expect(source).toContain('scripts/smoke-packed-package.mjs');
    expect(source).toContain('environment: npm-release-verification');
    expect(jobNeeds(source, 'verify-candidate')).toEqual(['package-candidate']);
    expect(jobNeeds(source, 'package-candidate')).toEqual(['source-quality']);
    expect(jobNeeds(source, 'runtime-candidate')).toEqual(['package-candidate']);
    expect(jobBlock(source, 'approve-candidate')).toBe('');
    expect(jobNeeds(source, 'publish')).toEqual([
      'package-candidate',
      'verify-candidate',
      'runtime-candidate',
    ]);
    expect(jobBlock(source, 'publish')).toContain('environment: npm-release-verification');
    expect(jobBlock(source, 'publish')).toContain('id-token: write');
    expect(jobBlock(source, 'verify-candidate')).toMatch(/^        run: npm ci$/mu);
    expect(jobBlock(source, 'verify-candidate')).not.toContain('--ignore-scripts');
    expect(source).toMatch(/npm publish[^\n]*needs\.package-candidate\.outputs\.tarball/);
    expect(source).not.toMatch(/npm publish\s+--/);
    expect(unsafeReleaseBypasses(source)).toEqual([]);
  });

  it('checks tag/package version equality before creating the candidate', () => {
    const source = workflow();

    expect(source).toContain('GITHUB_REF_NAME');
    expect(source).toContain('npm pkg get version');
    expect(source).toContain('TAG_VERSION');
  });

  it('detects the historical publish-after-failure bypass mutation', () => {
    const source = workflow();
    expect(unsafeReleaseBypasses(source)).toEqual([]);

    const mutated = source.replace('run: npm test', 'run: npm test || echo "skipping failures"');
    expect(unsafeReleaseBypasses(mutated)).toContain('validation failure is swallowed');
  });

  it('detects publish dependency, environment, and lifecycle bypass mutations', () => {
    const source = workflow();

    const publishSkipsVerification = source.replace(
      'needs: [package-candidate, verify-candidate, runtime-candidate]',
      'needs: [package-candidate, runtime-candidate]'
    );
    expect(publishSkipsVerification).not.toBe(source);
    expect(unsafeReleaseBypasses(publishSkipsVerification)).toContain(
      'publish bypasses verify-candidate'
    );

    const publishSkipsRuntime = source.replace(
      'needs: [package-candidate, verify-candidate, runtime-candidate]',
      'needs: [package-candidate, verify-candidate]'
    );
    expect(publishSkipsRuntime).not.toBe(source);
    expect(unsafeReleaseBypasses(publishSkipsRuntime)).toContain(
      'publish bypasses runtime-candidate'
    );

    const publishSkipsPackage = source.replace(
      'needs: [package-candidate, verify-candidate, runtime-candidate]',
      'needs: [verify-candidate, runtime-candidate]'
    );
    expect(publishSkipsPackage).not.toBe(source);
    expect(unsafeReleaseBypasses(publishSkipsPackage)).toContain(
      'publish bypasses package-candidate'
    );

    const publishUsesNoOpApproval = source.replace(
      'needs: [package-candidate, verify-candidate, runtime-candidate]',
      'needs: [package-candidate, approve-candidate]'
    );
    expect(publishUsesNoOpApproval).not.toBe(source);
    expect(unsafeReleaseBypasses(publishUsesNoOpApproval)).toContain(
      'publish has an indirect or unexpected approval dependency'
    );

    const publishWithoutEnvironment = mutateJob(
      source,
      'publish',
      '    environment: npm-release-verification\n',
      ''
    );
    expect(publishWithoutEnvironment).not.toBe(source);
    expect(unsafeReleaseBypasses(publishWithoutEnvironment)).toContain(
      'publish is not protected by the release environment'
    );

    const environmentOnNoOpApproval = source
      .replace('    environment: npm-release-verification\n', '')
      .replace(
        '  publish:\n',
        '  approve-candidate:\n    runs-on: ubuntu-latest\n    environment: npm-release-verification\n    steps:\n      - run: echo approved\n\n  publish:\n'
      );
    expect(environmentOnNoOpApproval).not.toBe(source);
    expect(unsafeReleaseBypasses(environmentOnNoOpApproval)).toContain(
      'publish is not protected by the release environment'
    );
    expect(unsafeReleaseBypasses(environmentOnNoOpApproval)).toContain(
      'release environment is attached outside the publish job'
    );
    expect(unsafeReleaseBypasses(environmentOnNoOpApproval)).toContain(
      'separate no-op approval job remains'
    );

    const verificationIgnoresLifecycle = mutateJob(
      source,
      'verify-candidate',
      'run: npm ci',
      'run: npm ci --ignore-scripts'
    );
    expect(verificationIgnoresLifecycle).not.toBe(source);
    expect(unsafeReleaseBypasses(verificationIgnoresLifecycle)).toContain(
      'verification disables dependency lifecycle scripts'
    );

    const publishAfterFailure = source.replace(
      'publish:\n    name: Publish preserved candidate',
      'publish:\n    name: Publish preserved candidate\n    if: always()'
    );
    expect(publishAfterFailure).not.toBe(source);
    expect(unsafeReleaseBypasses(publishAfterFailure)).toContain(
      'publish runs after a failed dependency'
    );
  });

  it('detects unsupported-tooling and unasserted-runtime mutations', () => {
    const source = workflow();

    const sourceOnMinimum = source.replace(
      "node-version: '24.x'\n          cache: npm",
      "node-version: '20.0.0'\n          cache: npm"
    );
    expect(sourceOnMinimum).not.toBe(source);
    expect(unsafeReleaseBypasses(sourceOnMinimum)).toContain(
      'source quality uses an unsupported development toolchain'
    );

    const runtimeRunsVitest = source.replace(
      '      - name: Smoke exact candidate and SQLite boundary',
      '      - name: Unsupported source test\n        run: npm test\n\n      - name: Smoke exact candidate and SQLite boundary'
    );
    expect(runtimeRunsVitest).not.toBe(source);
    expect(unsafeReleaseBypasses(runtimeRunsVitest)).toContain(
      'minimum runtime executes unsupported source tooling'
    );

    const runtimeSkipsCapability = source.replace(
      '          --expected-node-sqlite-backup=${{ matrix.node-sqlite-backup }}',
      '          --capability-check-skipped'
    );
    expect(runtimeSkipsCapability).not.toBe(source);
    expect(unsafeReleaseBypasses(runtimeSkipsCapability)).toContain(
      'runtime matrix skips --expected-node-sqlite-backup=${{ matrix.node-sqlite-backup }}'
    );

    const wrongMinimumProfile = source.replace(
      "          - node-version: '20.0.0'\n            backup-driver: better-sqlite3\n            node-sqlite-backup: unavailable",
      "          - node-version: '20.0.0'\n            backup-driver: node:sqlite\n            node-sqlite-backup: supported"
    );
    expect(wrongMinimumProfile).not.toBe(source);
    expect(unsafeReleaseBypasses(wrongMinimumProfile)).toContain(
      'runtime matrix changes 20.0.0 profile'
    );
  });

  it('locks strict runtime-smoke parsing and observable SQLite capability assertions', () => {
    const source = readFileSync(runtimeSmokePath, 'utf8');
    expect(unsafeRuntimeSmoke(source)).toEqual([]);

    const ignoredArguments = source.replace('process.argv.slice(3)', '[]');
    expect(ignoredArguments).not.toBe(source);
    expect(unsafeRuntimeSmoke(ignoredArguments)).toContain(
      'runtime smoke skips process.argv.slice(3)'
    );

    const missingForcedProbe = source.replace("esm.setDriver('node:sqlite')", 'void 0');
    expect(missingForcedProbe).not.toBe(source);
    expect(unsafeRuntimeSmoke(missingForcedProbe)).toContain(
      "runtime smoke skips esm.setDriver('node:sqlite')"
    );
  });

  it('locks exact-tarball schema, manifest-version, legacy-read, and producer-neutral gates', () => {
    const source = readFileSync(runtimeSmokePath, 'utf8');
    expect(unsafeFullPackageSmoke(source)).toEqual([]);

    for (const [target, expectedFailure] of [
      [
        'if (!runtimeOnly) {\n    const schemaReportPath',
        'full smoke bypasses the frozen schema suite',
      ],
      ['scripts/verify-test-results.mjs', 'schema suite is not verified fail-closed'],
      ["backup.manifest.version !== '1.0.0'", 'backup result outer manifest version is unchecked'],
      [
        "typeof backup.manifest.composerWorkspaceInventory?.schemaVersion !== 'number'",
        'backup result inventory schema type is unchecked',
      ],
      [
        "writeFileSync(targetPath, bytes, { flag: 'wx', mode: 0o600 })",
        'legacy variants are not private',
      ],
      [
        "if (variantValidation.status !== 'valid')",
        'manifest variants are not validated for readability',
      ],
      ['state.set(session.id, structuredClone(session))', 'incremental state loses shape'],
      ['esm.listSessionSummaries({ backupPath })', 'summary projection is not checked'],
      ['const currentSearch = await esm.searchSessions', 'search projection is not checked'],
      ['if (producerOnlyWrites !== 0)', 'producer-only mutation can cause incremental writes'],
    ] as const) {
      const mutated = source.replace(target, 'release-gate-bypassed');
      expect(mutated, target).not.toBe(source);
      expect(unsafeFullPackageSmoke(mutated), target).toContain(expectedFailure);
    }
  });

  it('detects removal of either checksum verification', () => {
    const source = workflow();
    for (const [jobName, label] of [
      ['runtime-candidate', 'runtime'],
      ['verify-candidate', 'verification'],
      ['publish', 'publish'],
    ] as const) {
      const mutated = mutateJob(
        source,
        jobName,
        'sha256sum -c candidate.sha256',
        'echo checksum-skipped'
      );
      expect(mutated).not.toBe(source);
      expect(unsafeReleaseBypasses(mutated)).toContain(`${label} skips candidate checksum`);
    }
  });

  it('detects coordinated tarball and sidecar replacement that is not bound to trusted output', () => {
    const source = workflow();
    const directBinding = 'test "$ACTUAL_SHA256" = "${{ needs.package-candidate.outputs.sha256 }}"';

    const verificationBypass = mutateJob(
      source,
      'verify-candidate',
      directBinding,
      'test "$ACTUAL_SHA256" = "$ACTUAL_SHA256"'
    );
    expect(verificationBypass).not.toBe(source);
    expect(unsafeReleaseBypasses(verificationBypass)).toContain(
      'verification does not bind candidate bytes to the trusted sha256 output'
    );

    const publishBypass = mutateJob(
      source,
      'publish',
      directBinding,
      'test "$ACTUAL_SHA256" = "$ACTUAL_SHA256"'
    );
    expect(publishBypass).not.toBe(source);
    expect(unsafeReleaseBypasses(publishBypass)).toContain(
      'publish does not bind candidate bytes to the trusted sha256 output'
    );
  });

  it('detects candidate metadata and checksum-address mutations', () => {
    const source = workflow();
    for (const [field, identity] of [
      ['revision', 'candidate-metadata.json").revision\')" = "$GITHUB_SHA"'],
      [
        'version',
        'candidate-metadata.json").version\')" = "${{ needs.package-candidate.outputs.version }}"',
      ],
      [
        'tag',
        'candidate-metadata.json").tag\')" = "v${{ needs.package-candidate.outputs.version }}"',
      ],
      [
        'sha256',
        'candidate-metadata.json").sha256\')" = "${{ needs.package-candidate.outputs.sha256 }}"',
      ],
      [
        'tarball',
        'candidate-metadata.json").tarball\')" = "${{ needs.package-candidate.outputs.tarball }}"',
      ],
    ] as const) {
      const verificationBypass = mutateJob(
        source,
        'verify-candidate',
        identity,
        `candidate-${field}-identity-bypassed`
      );
      expect(verificationBypass).not.toBe(source);
      expect(unsafeReleaseBypasses(verificationBypass)).toContain(
        `verification skips candidate ${field} identity`
      );

      const publishBypass = mutateJob(
        source,
        'publish',
        identity,
        `candidate-${field}-identity-bypassed`
      );
      expect(publishBypass).not.toBe(source);
      expect(unsafeReleaseBypasses(publishBypass)).toContain(
        `publish skips candidate ${field} identity`
      );
    }

    const unaddressedVerification = mutateJob(
      source,
      'verify-candidate',
      'name: npm-candidate-${{ needs.package-candidate.outputs.sha256 }}',
      'name: npm-candidate-latest'
    );
    expect(unaddressedVerification).not.toBe(source);
    expect(unsafeReleaseBypasses(unaddressedVerification)).toContain(
      'verification downloads an unaddressed candidate'
    );

    const unaddressedPublish = mutateJob(
      source,
      'publish',
      'name: npm-candidate-${{ needs.package-candidate.outputs.sha256 }}',
      'name: npm-candidate-latest'
    );
    expect(unaddressedPublish).not.toBe(source);
    expect(unsafeReleaseBypasses(unaddressedPublish)).toContain(
      'publish downloads an unaddressed candidate'
    );

    const unaddressedUpload = source.replace(
      'name: npm-candidate-${{ steps.identity.outputs.sha256 }}',
      'name: npm-candidate-latest'
    );
    expect(unaddressedUpload).not.toBe(source);
    expect(unsafeReleaseBypasses(unaddressedUpload)).toContain(
      'package upload is not checksum-addressed'
    );
  });
});
