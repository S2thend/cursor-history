import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageDocument {
  files?: string[];
}

function packagePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//u, '');
}

function isPackaged(path: string, files: readonly string[]): boolean {
  const normalizedPath = packagePath(path);
  if (normalizedPath === 'package.json') return true;
  return files.some((entry) => {
    const normalizedEntry = packagePath(entry).replace(/\/$/u, '');
    return normalizedPath === normalizedEntry || normalizedPath.startsWith(`${normalizedEntry}/`);
  });
}

function localMarkdownTargets(markdownPath: string, markdown: string): string[] {
  const targets: string[] = [];
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
    targets.push(
      packagePath(posix.join(posix.dirname(markdownPath), decodeURIComponent(encodedPath)))
    );
  }
  return targets;
}

function documentationClosureErrors(
  packageDocument: PackageDocument,
  repositoryRoot: string
): string[] {
  const files = packageDocument.files ?? [];
  const errors: string[] = [];
  const markdownFiles = files.map(packagePath).filter((path) => path.toLowerCase().endsWith('.md'));
  if (markdownFiles.length === 0) errors.push('package files contains no Markdown documentation');

  for (const markdownPath of markdownFiles) {
    const sourcePath = resolve(repositoryRoot, markdownPath);
    if (!existsSync(sourcePath)) {
      errors.push(`packaged Markdown source is missing ${markdownPath}`);
      continue;
    }
    const markdown = readFileSync(sourcePath, 'utf8');
    for (const target of localMarkdownTargets(markdownPath, markdown)) {
      if (target === '..' || target.startsWith('../')) {
        errors.push(`${markdownPath} links outside the package: ${target}`);
      } else if (!existsSync(resolve(repositoryRoot, target))) {
        errors.push(`${markdownPath} links to missing source target ${target}`);
      } else if (!isPackaged(target, files)) {
        errors.push(`${markdownPath} links to unpackaged target ${target}`);
      }
    }
  }
  return errors;
}

describe('published Markdown link closure', () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const packageDocument = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')
  ) as PackageDocument;

  it('ships every local target linked by packaged Markdown', () => {
    expect(documentationClosureErrors(packageDocument, repositoryRoot)).toEqual([]);
  });

  it('rejects a manifest that drops the linked release-verification procedure', () => {
    const mutated = {
      ...packageDocument,
      files: packageDocument.files?.filter((entry) => entry !== 'docs/release-verification.md'),
    };
    expect(documentationClosureErrors(mutated, repositoryRoot)).toContain(
      'README.md links to unpackaged target docs/release-verification.md'
    );
  });
});
