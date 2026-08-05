import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve('.github/workflows/npm-publish.yml');

function workflow(): string {
  return readFileSync(workflowPath, 'utf8');
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
  if (!/needs:\s*verify-candidate/.test(source)) failures.push('publish bypasses verification');
  if (!/npm publish[^\n]*needs\.package-candidate\.outputs\.tarball/.test(source)) {
    failures.push('publish does not consume the tarball');
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
    expect(source).toContain('needs: package-candidate');
    expect(source).toContain('needs: verify-candidate');
    expect(source).toMatch(/npm publish[^\n]*needs\.package-candidate\.outputs\.tarball/);
    expect(source).not.toMatch(/npm publish\s+--/);
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
});
