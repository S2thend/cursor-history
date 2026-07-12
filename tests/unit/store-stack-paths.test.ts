import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { hashWorkspaceCwd, chatsDir, projectsDir } from '../../src/core/store-stack/paths.js';

describe('store-stack paths', () => {
  it('hashWorkspaceCwd returns MD5(cwd) — WSL-verified samples', () => {
    // From research.md §4.4: <workspace-hash> = MD5(absolute cwd)
    expect(hashWorkspaceCwd('/mnt/d/1_yuyu_proj/cursor-history')).toBe(
      '46d408964d3ec2a21d9a23d01b13d82c'
    );
    expect(hashWorkspaceCwd('/mnt/c/Users/YUYU')).toBe('a89cc59fcba69f653802eca7c3790533');
  });

  it('hashWorkspaceCwd is deterministic 32-hex', () => {
    const h = hashWorkspaceCwd('/foo/bar');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(hashWorkspaceCwd('/foo/bar')).toBe(h);
  });

  it('chatsDir / projectsDir join under root', () => {
    const root = '/home/u/.cursor';
    expect(chatsDir(root)).toBe(join(root, 'chats'));
    expect(projectsDir(root)).toBe(join(root, 'projects'));
  });
});
