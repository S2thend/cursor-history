import { describe, expect, it, vi } from 'vitest';
import {
  isPublicWorkspacePath,
  normalizePublicWorkspacePath,
  normalizeWorkspacePath,
  resolveWorkspaceScope,
  WorkspaceAmbiguityError,
} from '../../src/core/workspace-scope.js';

describe('workspace scope lexical matching', () => {
  it('normalizes separators, dot segments, trailing separators, and file URIs', () => {
    expect(normalizeWorkspacePath('/history/team/./old/../project///')).toBe(
      '/history/team/project'
    );
    expect(normalizeWorkspacePath('file:///history/team/a%20project/')).toBe(
      '/history/team/a project'
    );
  });

  it('keeps display-only workspace labels out of public canonical paths', () => {
    for (const label of ['unknown', '(global)', '(unknown workspace)', '(workspace: legacy-id)']) {
      expect(normalizePublicWorkspacePath(label)).toBeUndefined();
      expect(isPublicWorkspacePath(label)).toBe(false);
    }

    expect(normalizePublicWorkspacePath('file:///history/team/../project/')).toBe(
      '/history/project'
    );
    expect(isPublicWorkspacePath('/history/project')).toBe(true);
  });

  it('matches historical paths without requiring them to exist', () => {
    expect(
      resolveWorkspaceScope('/volumes/retired/../archive/project/', ['/volumes/archive/project'])
    ).toEqual({ kind: 'matched', path: '/volumes/archive/project', matchKind: 'exact' });
  });

  it('coalesces Windows drive, file URI, and WSL spellings using case-insensitive rules', () => {
    expect(
      resolveWorkspaceScope('file:///D:/Team/PROJECT/', [
        'd:\\team\\project',
        '/mnt/d/team/project',
      ])
    ).toEqual({ kind: 'matched', path: 'd:/team/project', matchKind: 'exact' });
  });

  it('keeps POSIX path case significant on non-Windows hosts', () => {
    if (process.platform === 'win32') return;
    expect(resolveWorkspaceScope('/srv/Project', ['/srv/project'])).toEqual({
      kind: 'not-found',
      normalizedRequest: '/srv/Project',
    });
  });

  it('prefers an exact match over another candidate with the same component suffix', () => {
    expect(
      resolveWorkspaceScope('/team/project', ['/archive/team/project', '/team/project'])
    ).toEqual({ kind: 'matched', path: '/team/project', matchKind: 'exact' });
  });

  it('accepts one unique complete-component suffix', () => {
    expect(resolveWorkspaceScope('team/project', ['/archive/team/project', '/other/work'])).toEqual(
      { kind: 'matched', path: '/archive/team/project', matchKind: 'unique-suffix' }
    );
  });

  it('does not match an arbitrary string ending', () => {
    expect(resolveWorkspaceScope('project', ['/archive/my-project'])).toEqual({
      kind: 'not-found',
      normalizedRequest: 'project',
    });
  });

  it('throws a typed deterministic ambiguity before caller payload hydration', () => {
    const hydratePayload = vi.fn();
    let error: unknown;
    try {
      const match = resolveWorkspaceScope('team/project', ['/z/team/project', '/a/team/project']);
      hydratePayload(match);
    } catch (caught) {
      error = caught;
    }

    expect(hydratePayload).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(WorkspaceAmbiguityError);
    expect(error).toMatchObject({
      code: 'WORKSPACE_AMBIGUOUS',
      details: {
        requestedWorkspace: 'team/project',
        candidates: ['/a/team/project', '/z/team/project'],
      },
    });
  });

  it('preserves drive anchors during suffix matching', () => {
    expect(resolveWorkspaceScope('d:/team/project', ['e:/team/project'])).toEqual({
      kind: 'not-found',
      normalizedRequest: 'd:/team/project',
    });
  });
});
