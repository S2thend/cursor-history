import { createSessionReadContext, getSession, listSessions } from '../../core/storage.js';
import type { ChatSession } from '../../core/types.js';
import { SessionNotFoundError } from '../errors.js';

/**
 * Resolve one CLI session identifier using the same scope that produced its index.
 * Stable IDs remain global; only numeric identifiers are scoped by --workspace.
 */
export async function resolveCommandSession(
  identifier: number | string,
  workspacePath?: string,
  customDataPath?: string,
  backupPath?: string
): Promise<ChatSession> {
  const scopedNumericLookup = Boolean(workspacePath) && typeof identifier === 'number';
  const context = scopedNumericLookup
    ? createSessionReadContext(customDataPath, backupPath)
    : undefined;
  const scopedSessions = scopedNumericLookup
    ? await listSessions(
        { limit: 0, all: true, workspacePath: workspacePath! },
        customDataPath,
        backupPath,
        context
      )
    : undefined;
  const session = context
    ? await getSession(identifier, customDataPath, backupPath, context)
    : await getSession(identifier, customDataPath, backupPath);

  if (session) return session;

  if (typeof identifier === 'number') {
    const sessions =
      scopedSessions ?? (await listSessions({ limit: 0, all: true }, customDataPath, backupPath));
    throw new SessionNotFoundError({ index: identifier, maxIndex: sessions.length });
  }
  throw new SessionNotFoundError({ composerId: identifier });
}
