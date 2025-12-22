/**
 * JSON output formatter for CLI
 */

import type { ChatSessionSummary, Workspace, ChatSession, SearchResult } from '../../core/types.js';

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
export function formatSessionJson(session: ChatSession, workspacePath?: string): string {
  const output = {
    index: session.index,
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    lastUpdatedAt: session.lastUpdatedAt.toISOString(),
    messageCount: session.messageCount,
    workspaceId: session.workspaceId,
    workspacePath: workspacePath ?? null,
    messages: session.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp.toISOString(),
      codeBlocks: m.codeBlocks.map((cb) => ({
        language: cb.language,
        content: cb.content,
        startLine: cb.startLine,
      })),
    })),
  };

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
