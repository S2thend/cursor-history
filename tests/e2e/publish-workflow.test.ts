import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve('.github/workflows/npm-publish.yml');

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
  const approvalNeeds = jobNeeds(source, 'approve-candidate');
  const publishNeeds = jobNeeds(source, 'publish');
  const approvalJob = jobBlock(source, 'approve-candidate');
  const publishJob = jobBlock(source, 'publish');
  if (!verificationNeeds.includes('package-candidate')) {
    failures.push('verification bypasses the preserved candidate');
  }
  if (!approvalNeeds.includes('verify-candidate')) {
    failures.push('protected approval bypasses verification');
  }
  if (!publishNeeds.includes('approve-candidate')) {
    failures.push('publish bypasses protected approval');
  }
  if (!publishNeeds.includes('package-candidate')) {
    failures.push('publish cannot address the preserved candidate');
  }
  if (!/^    environment:\s*npm-release-verification\s*$/mu.test(approvalJob)) {
    failures.push('approval is not protected by the release environment');
  }
  if (/^    if:\s*.*\balways\s*\(\s*\)/mu.test(approvalJob)) {
    failures.push('protected approval runs after failed verification');
  }
  if (/^    if:\s*.*\balways\s*\(\s*\)/mu.test(publishJob)) {
    failures.push('publish runs after a failed dependency');
  }

  if (!/npm publish[^\n]*needs\.package-candidate\.outputs\.tarball/.test(publishJob)) {
    failures.push('publish does not consume the tarball');
  }
  if (/\bnpm (?:pack|run build)\b/u.test(publishJob)) {
    failures.push('publish rebuilds or repacks after approval');
  }
  return failures;
}

describe('npm publication workflow', () => {
  it('runs every required runtime boundary without swallowing validation failures', () => {
    const source = workflow();

    for (const version of ['20.0.0', '22.15.1', '22.16.0', '23.7.0', '23.8.0', '24.x', '26.x']) {
      expect(source).toContain(`'${version}'`);
    }
    for (const command of [
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'npm run build',
    ]) {
      expect(source).toContain(command);
    }
    expect(source).not.toMatch(/npm test\s*\|\|/);
    expect(source).not.toContain('continue-on-error: true');
  });

  it('packs once, records identity, verifies behind approval, and publishes the same bytes', () => {
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
    expect(jobNeeds(source, 'approve-candidate')).toEqual(['verify-candidate']);
    expect(jobNeeds(source, 'publish')).toEqual(['package-candidate', 'approve-candidate']);
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

  it('detects publish and approval dependency-graph bypass mutations', () => {
    const source = workflow();

    const publishSkipsApproval = source.replace(
      'needs: [package-candidate, approve-candidate]',
      'needs: [package-candidate, verify-candidate]'
    );
    expect(publishSkipsApproval).not.toBe(source);
    expect(unsafeReleaseBypasses(publishSkipsApproval)).toContain(
      'publish bypasses protected approval'
    );

    const approvalSkipsVerification = source.replace(
      'approve-candidate:\n    name: Approve maintainer verification\n    needs: verify-candidate',
      'approve-candidate:\n    name: Approve maintainer verification\n    needs: package-candidate'
    );
    expect(approvalSkipsVerification).not.toBe(source);
    expect(unsafeReleaseBypasses(approvalSkipsVerification)).toContain(
      'protected approval bypasses verification'
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
});
