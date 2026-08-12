/**
 * JSON output formatter for CLI
 */

import type {
  ChatSessionSummary,
  Workspace,
  ChatSession,
  SearchResult,
  MessageType,
  IndexScope,
  SessionDiagnostic,
  LogicalSessionSummary,
} from '../../core/types.js';
import { getMessageType } from './table.js';
import { serializeToolCall } from '../../core/parser.js';
import { getPublicMessageTimestamp } from '../../core/timestamps.js';

type JsonAddressingSource = Pick<
  ChatSession,
  | 'indexScope'
  | 'indexWorkspacePath'
  | 'canonicalWorkspacePath'
  | 'matchedWorkspacePath'
  | 'workspaceMatchKind'
  | 'workspaceMemberships'
  | 'sourceInstances'
  | 'resolution'
  | 'resolvedSource'
  | 'messageIdentityVersion'
> & { resolutionState?: ChatSessionSummary['resolutionState'] };

export interface JsonEnvelopeOptions {
  indexScope?: IndexScope;
  indexWorkspacePath?: string;
  diagnostics?: readonly SessionDiagnostic[];
}

export interface ExportedSessionFile {
  index: number;
  indexScope: IndexScope;
  indexWorkspacePath?: string;
  sessionId: string;
  path: string;
}

function addDiagnostics(
  output: Record<string, unknown>,
  diagnostics: readonly SessionDiagnostic[] | undefined
): void {
  if (diagnostics && diagnostics.length > 0) {
    output['diagnostics'] = diagnostics;
  }
}

function structuredWorkspacePath(...candidates: Array<string | undefined>): string | null {
  const selected = candidates.find(
    (candidate) =>
      candidate !== undefined &&
      candidate.length > 0 &&
      candidate !== 'unknown' &&
      !candidate.startsWith('(')
  );
  return selected ?? null;
}

/** Copy only stable, locator-free addressing and resolution fields. */
function addAddressingFields(output: Record<string, unknown>, source: JsonAddressingSource): void {
  for (const field of [
    'indexScope',
    'indexWorkspacePath',
    'canonicalWorkspacePath',
    'matchedWorkspacePath',
    'workspaceMatchKind',
    'workspaceMemberships',
    'sourceInstances',
    'resolutionState',
    'resolution',
    'resolvedSource',
    'messageIdentityVersion',
  ] as const) {
    const value = source[field];
    if (value !== undefined) output[field] = value;
  }
}

/**
 * Format sessions list as JSON
 */
export function formatSessionsJson(
  sessions: LogicalSessionSummary[],
  options: JsonEnvelopeOptions = {}
): string {
  const first = sessions[0];
  const indexScope = options.indexScope ?? first?.indexScope ?? 'global';
  const indexWorkspacePath =
    indexScope === 'workspace'
      ? (options.indexWorkspacePath ??
        first?.indexWorkspacePath ??
        first?.matchedWorkspacePath ??
        (first && first.resolutionState !== 'ambiguous' ? first.workspacePath : undefined))
      : undefined;
  const output: Record<string, unknown> = {
    count: sessions.length,
    indexScope,
    ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
    sessions: sessions.map((s) => {
      if (s.resolutionState === 'ambiguous') {
        return {
          index: s.index,
          indexScope: s.indexScope,
          ...(s.indexWorkspacePath ? { indexWorkspacePath: s.indexWorkspacePath } : {}),
          id: s.id,
          resolutionState: s.resolutionState,
          sourceRoles: s.sourceRoles,
          occurrenceCount: s.occurrenceCount,
          diagnosticOccurrenceRefs: s.diagnosticOccurrenceRefs,
          ...(s.canonicalWorkspacePath ? { canonicalWorkspacePath: s.canonicalWorkspacePath } : {}),
          ...(s.matchedWorkspacePath ? { matchedWorkspacePath: s.matchedWorkspacePath } : {}),
        };
      }
      const obj: Record<string, unknown> = {
        index: s.index,
        id: s.id,
        title: s.title,
        createdAt: s.createdAt.toISOString(),
        lastUpdatedAt: s.lastUpdatedAt.toISOString(),
        messageCount: s.messageCount,
        workspaceId: s.workspaceId,
        workspacePath: structuredWorkspacePath(s.canonicalWorkspacePath, s.workspacePath),
        preview: s.preview,
      };
      if (s.source !== undefined) {
        obj['source'] = s.source;
      }
      if (s.sources) {
        obj['sources'] = s.sources;
      }
      if (s.preferredSource) {
        obj['preferredSource'] = s.preferredSource;
      }
      if (s.transcriptState) {
        obj['transcriptState'] = s.transcriptState;
      }
      if (s.createdAtSource !== undefined) {
        obj['createdAtSource'] = s.createdAtSource;
      }
      if (s.lastUpdatedAtSource !== undefined) {
        obj['lastUpdatedAtSource'] = s.lastUpdatedAtSource;
      }
      addAddressingFields(obj, s);
      return obj;
    }),
  };
  addDiagnostics(output, options.diagnostics);

  return JSON.stringify(output, null, 2);
}

/**
 * Format workspaces list as JSON
 */
export function formatWorkspacesJson(workspaces: Workspace[]): string {
  const output = {
    count: workspaces.length,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      path: w.path,
      sessionCount: w.sessionCount,
    })),
  };

  return JSON.stringify(output, null, 2);
}

/**
 * Format a single session as JSON
 */
export function formatSessionJson(
  session: ChatSession,
  workspacePath?: string,
  messageFilter?: MessageType[],
  originalMessageCount?: number
): string {
  // Build base output
  const output: Record<string, unknown> = {
    index: session.index,
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    lastUpdatedAt: session.lastUpdatedAt.toISOString(),
    messageCount: originalMessageCount ?? session.messageCount,
    workspaceId: session.workspaceId,
    workspacePath: structuredWorkspacePath(
      session.canonicalWorkspacePath,
      workspacePath,
      session.workspacePath
    ),
  };

  if (session.source !== undefined) {
    output['source'] = session.source;
  }
  if (session.sources) {
    output['sources'] = session.sources;
  }
  if (session.preferredSource) {
    output['preferredSource'] = session.preferredSource;
  }
  if (session.transcriptState) {
    output['transcriptState'] = session.transcriptState;
  }
  if (session.activeBranchBubbleIds !== undefined) {
    output['activeBranchBubbleIds'] = session.activeBranchBubbleIds;
  }
  if (session.createdAtSource !== undefined) {
    output['createdAtSource'] = session.createdAtSource;
  }
  if (session.lastUpdatedAtSource !== undefined) {
    output['lastUpdatedAtSource'] = session.lastUpdatedAtSource;
  }
  addAddressingFields(output, session);

  // Add filter metadata if filtering is active
  if (messageFilter && messageFilter.length > 0) {
    output['filter'] = messageFilter;
    output['filteredMessageCount'] = session.messages.length;
  }

  // Add session-level usage data if available
  if (session.usage) {
    const usage: Record<string, unknown> = {};
    if (session.usage.contextTokensUsed !== undefined) {
      usage['contextTokensUsed'] = session.usage.contextTokensUsed;
    }
    if (session.usage.contextTokenLimit !== undefined) {
      usage['contextTokenLimit'] = session.usage.contextTokenLimit;
    }
    if (session.usage.contextUsagePercent !== undefined) {
      usage['contextUsagePercent'] = session.usage.contextUsagePercent;
    }
    if (session.usage.totalInputTokens !== undefined) {
      usage['totalInputTokens'] = session.usage.totalInputTokens;
    }
    if (session.usage.totalOutputTokens !== undefined) {
      usage['totalOutputTokens'] = session.usage.totalOutputTokens;
    }
    if (Object.keys(usage).length > 0) {
      output['usage'] = usage;
    }
  }

  // Map messages with optional type and token usage fields
  output['messages'] = session.messages.map((m) => {
    const msg: Record<string, unknown> = {
      id: m.id,
      role: m.role,
      content: m.content,
      codeBlocks: m.codeBlocks.map((cb) => ({
        language: cb.language,
        content: cb.content,
        startLine: cb.startLine,
      })),
    };

    if (m.messageIdentityVersion !== undefined) {
      msg['messageIdentityVersion'] = m.messageIdentityVersion;
    }
    if (m.identityOrigin !== undefined) {
      msg['identityOrigin'] = m.identityOrigin;
    }
    if (m.parentMessageId !== undefined) {
      msg['parentMessageId'] = m.parentMessageId;
    }
    if (m.isSidechain !== undefined) {
      msg['isSidechain'] = m.isSidechain;
    }

    const messageTime = getPublicMessageTimestamp(m);
    msg['timestamp'] = messageTime.timestamp.toISOString();
    msg['timestampSource'] = messageTime.timestampSource;
    if (m.source) {
      msg['source'] = m.source;
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      // The shared serializer preserves every defined ToolCall field.
      msg['toolCalls'] = m.toolCalls.map((tc) => serializeToolCall(tc));
    }

    // Add type field when filtering is active
    if (messageFilter && messageFilter.length > 0) {
      msg['type'] = getMessageType(m);
    }

    // Add token usage fields if present (omit if not available)
    if (m.tokenUsage && (m.tokenUsage.inputTokens > 0 || m.tokenUsage.outputTokens > 0)) {
      msg['tokenUsage'] = {
        inputTokens: m.tokenUsage.inputTokens,
        outputTokens: m.tokenUsage.outputTokens,
      };
    }
    if (m.model) {
      msg['model'] = m.model;
    }
    if (m.durationMs && m.durationMs > 0) {
      msg['durationMs'] = m.durationMs;
    }

    return msg;
  });

  return JSON.stringify(output, null, 2);
}

/**
 * Format search results as JSON
 */
export function formatSearchResultsJson(
  results: SearchResult[],
  query: string,
  options: JsonEnvelopeOptions = {}
): string {
  const indexScope = options.indexScope ?? 'global';
  const indexWorkspacePath =
    indexScope === 'workspace'
      ? (options.indexWorkspacePath ?? results[0]?.workspacePath)
      : undefined;
  const output: Record<string, unknown> = {
    query,
    count: results.length,
    totalMatches: results.reduce((sum, r) => sum + r.matchCount, 0),
    indexScope,
    ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
    results: results.map((r) => ({
      index: r.index,
      indexScope,
      ...(indexWorkspacePath ? { indexWorkspacePath } : {}),
      sessionId: r.sessionId,
      workspacePath: r.workspacePath,
      createdAt: r.createdAt.toISOString(),
      matchCount: r.matchCount,
      snippets: r.snippets.map((s) => ({
        role: s.messageRole,
        text: s.text,
        matchPositions: s.matchPositions,
      })),
    })),
  };
  addDiagnostics(output, options.diagnostics);

  return JSON.stringify(output, null, 2);
}

/**
 * Format export result as JSON
 */
export function formatExportResultJson(
  exported: readonly ExportedSessionFile[],
  options: Pick<JsonEnvelopeOptions, 'diagnostics'> = {}
): string {
  const output: Record<string, unknown> = {
    count: exported.length,
    files: exported,
  };
  addDiagnostics(output, options.diagnostics);

  return JSON.stringify(output, null, 2);
}
