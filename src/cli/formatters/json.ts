/**
 * JSON output formatter for CLI
 */

import type {
  ChatSessionSummary,
  Workspace,
  ChatSession,
  SearchResult,
  MessageType,
} from '../../core/types.js';
import { getMessageType } from './table.js';

/**
 * Format sessions list as JSON
 */
export function formatSessionsJson(sessions: ChatSessionSummary[]): string {
  const output = {
    count: sessions.length,
    sessions: sessions.map((s) => ({
      index: s.index,
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      lastUpdatedAt: s.lastUpdatedAt.toISOString(),
      messageCount: s.messageCount,
      workspaceId: s.workspaceId,
      workspacePath: s.workspacePath,
      preview: s.preview,
    })),
  };

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
    workspacePath: workspacePath ?? null,
  };

  if (session.source !== undefined) {
    output['source'] = session.source;
  }
  if (session.activeBranchBubbleIds !== undefined) {
    output['activeBranchBubbleIds'] = session.activeBranchBubbleIds;
  }

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
      timestamp: m.timestamp.toISOString(),
      codeBlocks: m.codeBlocks.map((cb) => ({
        language: cb.language,
        content: cb.content,
        startLine: cb.startLine,
      })),
    };

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
export function formatSearchResultsJson(results: SearchResult[], query: string): string {
  const output = {
    query,
    count: results.length,
    totalMatches: results.reduce((sum, r) => sum + r.matchCount, 0),
    results: results.map((r) => ({
      index: r.index,
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

  return JSON.stringify(output, null, 2);
}

/**
 * Format export result as JSON
 */
export function formatExportResultJson(exported: { index: number; path: string }[]): string {
  const output = {
    count: exported.length,
    files: exported,
  };

  return JSON.stringify(output, null, 2);
}
