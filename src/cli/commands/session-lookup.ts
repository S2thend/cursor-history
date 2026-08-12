import {
  createSessionReadContext,
  getSession,
  listSessions,
  listSessionSummaries,
} from '../../core/storage.js';
import { SessionScopeMismatchError } from '../../core/errors.js';
import type {
  ChatSession,
  SourceReadLimitsOverride,
  SourceReadLimitsV1,
} from '../../core/types.js';
import { SessionNotFoundError } from '../errors.js';

/**
 * Resolve one CLI session identifier using the same scope that produced its index.
 * Numeric indices and stable IDs are both required to belong to --workspace.
 * Unscoped stable-ID lookup retains its existing global behavior.
 */
export async function resolveCommandSession(
  identifier: number | string,
  workspacePath?: string,
  customDataPath?: string,
  backupPath?: string,
  readOptions: {
    readonly includeCrossWorkspaceSources?: boolean;
    readonly sourceReadLimits?: SourceReadLimitsOverride | Readonly<SourceReadLimitsV1>;
  } = {}
): Promise<ChatSession> {
  const scopedLookup = Boolean(workspacePath);
  const context =
    scopedLookup ||
    readOptions.includeCrossWorkspaceSources === true ||
    readOptions.sourceReadLimits !== undefined
      ? createSessionReadContext({
          ...(customDataPath ? { dataPath: customDataPath } : {}),
          ...(backupPath ? { backupPath } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          ...(readOptions.includeCrossWorkspaceSources
            ? { includeCrossWorkspaceSources: true }
            : {}),
          ...(readOptions.sourceReadLimits
            ? { sourceReadLimits: readOptions.sourceReadLimits }
            : {}),
        })
      : undefined;
  try {
    const scopedSessions = scopedLookup
      ? await listSessions(
          {
            limit: 0,
            all: true,
            workspacePath: workspacePath!,
            ...(readOptions.includeCrossWorkspaceSources
              ? { includeCrossWorkspaceSources: true }
              : {}),
            ...(readOptions.sourceReadLimits
              ? { sourceReadLimits: readOptions.sourceReadLimits }
              : {}),
          },
          customDataPath,
          backupPath,
          context
        )
      : undefined;
    const boundScopedSummary = scopedSessions?.find((summary) =>
      typeof identifier === 'number' ? summary.index === identifier : summary.id === identifier
    );
    const session = context
      ? scopedLookup
        ? boundScopedSummary
          ? await getSession(
              boundScopedSummary.id,
              customDataPath,
              backupPath,
              context,
              boundScopedSummary.index
            )
          : await getSession(identifier, customDataPath, backupPath, context)
        : await getSession(identifier, customDataPath, backupPath, context)
      : await getSession(identifier, customDataPath, backupPath);

    if (session) return session;

    if (workspacePath && typeof identifier === 'string') {
      throw new SessionScopeMismatchError(identifier, workspacePath);
    }

    if (typeof identifier === 'number') {
      const sessions =
        scopedSessions ??
        (await listSessionSummaries(
          {
            limit: 0,
            all: true,
            ...(readOptions.includeCrossWorkspaceSources
              ? { includeCrossWorkspaceSources: true }
              : {}),
            ...(readOptions.sourceReadLimits
              ? { sourceReadLimits: readOptions.sourceReadLimits }
              : {}),
          },
          customDataPath,
          backupPath,
          context
        ));
      const logicalCount = context?.logicalSummaries?.length ?? sessions.length;
      throw new SessionNotFoundError({ index: identifier, maxIndex: logicalCount });
    }
    throw new SessionNotFoundError({ composerId: identifier });
  } finally {
    await context?.dispose();
  }
}
