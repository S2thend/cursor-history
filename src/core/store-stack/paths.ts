/**
 * Path utilities for the Cursor Store stack.
 * See specs/015-cursor-store-stack/research.md §4.4 / data-model.md.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Compute the Store stack `<workspace-hash>` = MD5(absolute cwd).
 * WSL-verified: MD5("/mnt/d/1_yuyu_proj/cursor-history") = 46d408964d3ec2a21d9a23d01b13d82c.
 * This is distinct from the Composer stack workspaceStorage hash (not MD5).
 */
export function hashWorkspaceCwd(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex');
}

/** `~/.cursor/chats/` — contains `<hash>/<uuid>/{meta.json,store.db}`. */
export function chatsDir(storeRoot: string): string {
  return join(storeRoot, 'chats');
}

/** `~/.cursor/projects/` — contains `<sanitized>/agent-transcripts/<uuid>/*.jsonl`. */
export function projectsDir(storeRoot: string): string {
  return join(storeRoot, 'projects');
}

/** `~/.cursor/acp-sessions/` — ACP variant: `<uuid>/{meta.json, store.db}`. */
export function acpSessionsDir(storeRoot: string): string {
  return join(storeRoot, 'acp-sessions');
}
