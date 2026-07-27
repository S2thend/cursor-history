/**
 * Chat data parsing and content extraction
 */

import type {
  ChatSession,
  Message,
  CodeBlock,
  SearchSnippet,
  MessageRole,
  ToolCall,
} from './types.js';
import type { StoreSession } from './store-stack/types.js';

/**
 * Serialize a `ToolCall` to a plain object preserving EVERY defined field
 * (name, status, params, result, error, files). Shared by CLI JSON and export
 * JSON so tool information is complete and consistent across formats.
 */
export function serializeToolCall(tc: ToolCall): Record<string, unknown> {
  const obj: Record<string, unknown> = { name: tc.name, status: tc.status };
  if (tc.params !== undefined) obj['params'] = tc.params;
  if (tc.result !== undefined) obj['result'] = tc.result;
  if (tc.error !== undefined) obj['error'] = tc.error;
  if (tc.files !== undefined) obj['files'] = tc.files;
  return obj;
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: 'Read File',
  read_file: 'Read File',
  read_file_v2: 'Read File v2',
  list_dir: 'List Directory',
  grep: 'Grep',
  search: 'Search',
  codebase_search: 'Search',
  run_terminal_command: 'Terminal Command',
  run_terminal_cmd: 'Terminal Command',
  execute_command: 'Terminal Command',
  edit_file: 'Edit File',
  search_replace: 'Search & Replace',
  edit_file_v2: 'Edit File v2',
  create_file: 'Create File',
  write: 'Write File',
  write_file: 'Write File',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getToolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name.trim().toLowerCase()] ?? name;
}

const TOOL_IDENTITY_PARAMS = new Set([
  'cmd',
  'command',
  'cwd',
  'dir',
  'directory',
  'effectiveuri',
  'file',
  'filepath',
  'path',
  'pattern',
  'query',
  'regex',
  'relativeworkspacepath',
  'searchquery',
  'target',
  'targetdirectory',
  'targetfile',
  'uri',
  'url',
]);

function normalizeToolIdentityKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Values that can distinguish one same-name call from another. Generic
 * parameters (for example, `encoding`) are deliberately excluded: matching a
 * shared option must not cause a different call to be hidden.
 */
function getToolIdentityValues(tc: ToolCall): string[] {
  const values = new Set(
    (tc.files ?? []).map((value) => value.trim()).filter((value) => value.length > 0)
  );
  for (const [key, value] of Object.entries(tc.params ?? {})) {
    if (
      TOOL_IDENTITY_PARAMS.has(normalizeToolIdentityKey(key)) &&
      typeof value === 'string' &&
      value.trim().length > 0
    ) {
      values.add(value.trim());
    }
  }
  return [...values];
}

/** Strong identity values explicitly rendered on labelled Composer lines. */
function getEmbeddedToolIdentityValues(content: string): string[] {
  const values = new Set<string>();
  for (const line of content.split(/\r?\n/).slice(1)) {
    const labelledValue = line.match(/^([^:\n]+):[ \t]*(.+)$/);
    if (
      labelledValue?.[1] &&
      labelledValue[2] &&
      TOOL_IDENTITY_PARAMS.has(normalizeToolIdentityKey(labelledValue[1]))
    ) {
      values.add(labelledValue[2].trim());
    }
  }
  return [...values];
}

/**
 * Find the one structured call represented by Composer's embedded `[Tool:]`
 * text. A merged message may carry additional structured calls, which must not
 * be hidden just because the content starts with a tool marker.
 */
export function findEmbeddedToolCallIndex(content: string, toolCalls: ToolCall[]): number {
  const header = content.match(/^\[Tool:\s*([^\]]+)\]/);
  if (!header?.[1]) return -1;

  const embeddedName = normalizeToolName(header[1]);
  const candidates = toolCalls
    .map((tc, index) => ({ tc, index }))
    .filter(({ tc }) =>
      [tc.name, getToolDisplayName(tc.name)].some(
        (candidate) => normalizeToolName(candidate) === embeddedName
      )
    );
  if (candidates.length === 0) return -1;

  const embeddedIdentity = getEmbeddedToolIdentityValues(content);
  if (embeddedIdentity.length > 0) {
    const identified = candidates.filter(({ tc }) => {
      const structuredIdentity = new Set(getToolIdentityValues(tc));
      return embeddedIdentity.every((value) => structuredIdentity.has(value));
    });
    return identified.length === 1 ? identified[0]!.index : -1;
  }

  // A unique name is sufficient when there is only one possible structured
  // counterpart and the embedded text carries no conflicting identity
  // evidence. With repeated names, an absent identity match must suppress
  // nothing rather than silently dropping the wrong call.
  return candidates.length === 1 ? candidates[0]!.index : -1;
}

/**
 * Map a Store-stack session (transcript / store.db) to the unified ChatSession.
 * Store sessions lack per-message timestamps / tokens / tool-results at the
 * transcript layer; `source` reflects the available Store representation.
 * See specs/015-cursor-store-stack/data-model.md §2.
 */
export function mapStoreSession(ss: StoreSession, index: number): ChatSession {
  // Tag each message with its Store origin. Store messages do not carry a
  // directly-stored per-message timestamp at the transcript/store.db layer
  // (turn_timings are not populated in current samples), so timestamp is left
  // undefined rather than copied from session-level times.
  const messages = ss.messages.map((m) => ({ ...m, source: 'store' as const }));
  return {
    id: ss.id,
    index,
    title: ss.title,
    createdAt: ss.createdAt,
    lastUpdatedAt: ss.lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: 'store',
    workspacePath: ss.workspacePath,
    source: ss.source,
    transcriptState: ss.transcriptState,
  };
}

/**
 * Raw JSON structure from Cursor's SQLite storage (Legacy format)
 */
interface RawChatData {
  version?: number;
  chatSessions?: RawChatSession[];
  tabs?: RawChatSession[]; // Alternative key used in some versions
}

interface RawChatSession {
  id?: string;
  title?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  lastSendTime?: number; // Alternative to lastUpdatedAt
  messages?: RawMessage[];
  bubbles?: RawMessage[]; // Alternative key used in some versions
}

interface RawMessage {
  id?: string;
  role?: string;
  type?: string; // Alternative to role (e.g., 'user', 'ai')
  content?: string;
  text?: string; // Alternative to content
  timestamp?: number;
  createdAt?: number; // Alternative to timestamp
}

/**
 * New Cursor format (composer.composerData)
 */
interface ComposerData {
  allComposers?: ComposerHead[];
  selectedComposerIds?: string[];
}

interface ComposerHead {
  type?: string;
  composerId?: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
}

/**
 * Generations format (aiService.generations)
 */
interface GenerationEntry {
  unixMs?: number;
  generationUUID?: string;
  type?: string;
  textDescription?: string;
}

/**
 * Combined data from multiple keys
 */
export interface CursorChatBundle {
  composerData?: string;
  prompts?: string;
  generations?: string;
}

/**
 * Parse chat data JSON string into ChatSession array
 * Handles both legacy and new Cursor formats
 */
export function parseChatData(jsonString: string, bundle?: CursorChatBundle): ChatSession[] {
  let data: RawChatData | ComposerData | ComposerHead[];

  try {
    data = JSON.parse(jsonString) as RawChatData | ComposerData;
  } catch {
    return [];
  }

  // New composer format with allComposers wrapper
  if (isComposerData(data)) {
    return parseComposerFormat(data as ComposerData, bundle);
  }

  // Legacy composer format stored as a direct array
  if (isComposerArray(data)) {
    return parseComposerFormat({ allComposers: data }, bundle);
  }

  // Legacy format
  const rawData = data as RawChatData;
  const rawSessions = rawData.chatSessions ?? rawData.tabs ?? [];
  const sessions: ChatSession[] = [];

  for (const raw of rawSessions) {
    const session = parseSession(raw);
    if (session && session.messages.length > 0) {
      sessions.push(session);
    }
  }

  return sessions;
}

function isComposerData(data: RawChatData | ComposerData | ComposerHead[]): data is ComposerData {
  return !!data && typeof data === 'object' && !Array.isArray(data) && 'allComposers' in data;
}

function isComposerArray(
  data: RawChatData | ComposerData | ComposerHead[]
): data is ComposerHead[] {
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }

  return data.every(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      ('composerId' in item || 'name' in item || 'unifiedMode' in item)
  );
}

/**
 * Parse new composer format into ChatSession array
 */
function parseComposerFormat(data: ComposerData, bundle?: CursorChatBundle): ChatSession[] {
  const sessions: ChatSession[] = [];
  const composers = data.allComposers ?? [];

  // Parse generations if available (prompts lack timestamps so we skip them)
  let generations: GenerationEntry[] = [];

  if (bundle?.generations) {
    try {
      generations = JSON.parse(bundle.generations) as GenerationEntry[];
    } catch {
      // Ignore parse errors
    }
  }

  // Sort generations by timestamp for pairing
  const sortedGenerations = [...generations].sort((a, b) => (a.unixMs ?? 0) - (b.unixMs ?? 0));

  for (const composer of composers) {
    if (!composer.composerId) continue;

    const createdAt = composer.createdAt ? new Date(composer.createdAt) : new Date();
    const lastUpdatedAt = composer.lastUpdatedAt ? new Date(composer.lastUpdatedAt) : createdAt;

    // Try to find messages that fall within this session's time range
    const sessionMessages: Message[] = [];

    // For now, we'll create placeholder sessions with metadata
    // The actual messages are in a flat list and hard to associate
    // We'll include the name as preview if available. Placeholder messages
    // carry NO timestamp because it is not a directly-stored message time.
    if (composer.name) {
      sessionMessages.push({
        id: null,
        role: 'user',
        content: composer.name,
        codeBlocks: [],
        source: 'composer',
      });
    }

    // Find generations that might belong to this session (by time proximity)
    const sessionStart = composer.createdAt ?? 0;
    const sessionEnd = composer.lastUpdatedAt ?? Date.now();

    for (const gen of sortedGenerations) {
      if (gen.unixMs && gen.unixMs >= sessionStart && gen.unixMs <= sessionEnd + 60000) {
        if (gen.textDescription) {
          // gen.unixMs IS a directly-stored time → keep it with its provenance.
          sessionMessages.push({
            id: gen.generationUUID ?? null,
            role: 'user', // textDescription is actually the prompt
            content: gen.textDescription,
            timestamp: new Date(gen.unixMs),
            timestampSource: 'composer-timing',
            codeBlocks: extractCodeBlocks(gen.textDescription),
            source: 'composer',
          });
        }
      }
    }

    sessions.push({
      id: composer.composerId,
      index: 0,
      title: composer.name ?? null,
      createdAt,
      lastUpdatedAt,
      messageCount: sessionMessages.length || 1,
      messages:
        sessionMessages.length > 0
          ? sessionMessages
          : [
              {
                id: null,
                role: 'user',
                content: composer.name ?? '(Empty session)',
                codeBlocks: [],
                source: 'composer',
              },
            ],
      workspaceId: '',
    });
  }

  return sessions;
}

/**
 * Parse a single raw session into ChatSession
 */
function parseSession(raw: RawChatSession): ChatSession | null {
  if (!raw.id) {
    return null;
  }

  const rawMessages = raw.messages ?? raw.bubbles ?? [];
  const messages = rawMessages.map(parseMessage).filter((m): m is Message => m !== null);

  if (messages.length === 0) {
    return null;
  }

  // Derive timestamps
  const createdAt = raw.createdAt
    ? new Date(raw.createdAt)
    : (messages[0]?.timestamp ?? new Date());

  const lastUpdatedAt = raw.lastUpdatedAt
    ? new Date(raw.lastUpdatedAt)
    : raw.lastSendTime
      ? new Date(raw.lastSendTime)
      : (messages[messages.length - 1]?.timestamp ?? createdAt);

  // Derive title from first user message if not set
  const title = raw.title ?? deriveTitle(messages);

  return {
    id: raw.id,
    index: 0, // Assigned later during listing
    title,
    createdAt,
    lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: '', // Assigned by caller
  };
}

/**
 * Parse a single raw message into Message
 */
function parseMessage(raw: RawMessage): Message | null {
  const content = raw.content ?? raw.text ?? '';
  if (!content && !raw.role && !raw.type) {
    return null;
  }

  // Normalize role
  const rawRole = raw.role ?? raw.type ?? 'user';
  const role: MessageRole = normalizeRole(rawRole);

  // Per-message timestamp only when directly stored; never fabricated.
  const timestamp =
    raw.timestamp != null
      ? new Date(raw.timestamp)
      : raw.createdAt != null
        ? new Date(raw.createdAt)
        : undefined;

  const message: Message = {
    id: raw.id ?? null,
    role,
    content,
    codeBlocks: extractCodeBlocks(content),
    source: 'composer',
  };
  if (timestamp !== undefined) {
    message.timestamp = timestamp;
    // Legacy workspace-storage format: raw.timestamp / raw.createdAt are the
    // directly-stored message times (createdAt-style).
    message.timestampSource = 'composer-created-at';
  }
  return message;
}

/**
 * Normalize role string to MessageRole type
 */
function normalizeRole(role: string): MessageRole {
  const lower = role.toLowerCase();
  if (lower === 'assistant' || lower === 'ai' || lower === 'bot' || lower === 'system') {
    return 'assistant';
  }
  return 'user';
}

/**
 * Derive title from first user message
 */
function deriveTitle(messages: Message[]): string | null {
  const firstUserMessage = messages.find((m) => m.role === 'user');
  if (!firstUserMessage) {
    return null;
  }

  // Take first line, truncate to 50 chars
  const firstLine = firstUserMessage.content.split('\n')[0] ?? '';
  if (firstLine.length <= 50) {
    return firstLine || null;
  }
  return firstLine.slice(0, 47) + '...';
}

/**
 * Extract code blocks from message content
 */
export function extractCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  // Match fenced code blocks: ```language\ncode\n```
  const regex = /^```(\w*)\n([\s\S]*?)^```/gm;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const language = match[1] || null;
    const code = match[2] ?? '';

    // Calculate start line
    const beforeMatch = content.slice(0, match.index);
    const startLine = beforeMatch.split('\n').length - 1;

    blocks.push({
      language,
      content: code.trimEnd(),
      startLine,
    });
  }

  return blocks;
}

/**
 * Extract preview text from messages (first user message, ~100 chars)
 */
export function extractPreview(messages: Message[]): string {
  const firstUserMessage = messages.find((m) => m.role === 'user');
  if (!firstUserMessage) {
    return '';
  }

  // Remove code blocks for cleaner preview
  const cleanContent = firstUserMessage.content
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\n+/g, ' ')
    .trim();

  if (cleanContent.length <= 100) {
    return cleanContent;
  }

  return cleanContent.slice(0, 97) + '...';
}

/**
 * Search messages for query and return snippets with context
 */
export function getSearchSnippets(
  messages: Message[],
  query: string,
  contextChars: number = 50
): SearchSnippet[] {
  const snippets: SearchSnippet[] = [];
  const lowerQuery = query.toLowerCase();

  for (const message of messages) {
    const lowerContent = message.content.toLowerCase();
    const positions: [number, number][] = [];

    // Find all match positions
    let searchStart = 0;
    while (true) {
      const pos = lowerContent.indexOf(lowerQuery, searchStart);
      if (pos === -1) break;
      positions.push([pos, pos + query.length]);
      searchStart = pos + 1;
    }

    if (positions.length === 0) {
      continue;
    }

    // Extract snippet with context around first match
    const firstMatch = positions[0]!;
    const snippetStart = Math.max(0, firstMatch[0] - contextChars);
    const snippetEnd = Math.min(message.content.length, firstMatch[1] + contextChars);

    let text = message.content.slice(snippetStart, snippetEnd);

    // Add ellipsis if truncated
    if (snippetStart > 0) {
      text = '...' + text;
    }
    if (snippetEnd < message.content.length) {
      text = text + '...';
    }

    // Adjust positions for the snippet offset
    const adjustedPositions: [number, number][] = positions
      .filter(([start, end]) => start >= snippetStart && end <= snippetEnd)
      .map(([start, end]) => [
        start - snippetStart + (snippetStart > 0 ? 3 : 0),
        end - snippetStart + (snippetStart > 0 ? 3 : 0),
      ]);

    snippets.push({
      messageRole: message.role,
      text,
      matchPositions: adjustedPositions,
    });
  }

  return snippets;
}

/**
 * One readable source line for export/Markdown. Covers merged sessions and
 * single-source Store sessions; returns '' for plain Composer (global) sessions
 * where the source is implied.
 */
function describeSessionSource(session: ChatSession): string {
  if (session.source === 'merged') {
    const stacks = session.sources?.join(' + ') ?? 'composer + store';
    return `merged from ${stacks} (backbone: ${session.preferredSource ?? 'composer'})`;
  }
  switch (session.source) {
    case 'transcript':
      return 'Store stack (transcript)';
    case 'store-complete':
      return 'Store stack (store.db — complete)';
    case 'store-partial':
      return 'Store stack (store.db — partial)';
    case 'store':
      return 'Store stack';
    default:
      return ''; // 'global' / 'workspace-fallback' — implied, no line
  }
}

/**
 * Export a chat session to Markdown format
 */
export function exportToMarkdown(session: ChatSession, workspacePath?: string): string {
  const lines: string[] = [];
  // Fall back to the resolved session's own workspacePath when no explicit
  // path is supplied (Store-only sessions have no Composer workspace metadata).
  const ws = workspacePath ?? session.workspacePath;

  // Header
  lines.push(`# ${session.title ?? 'Untitled Chat'}`);
  lines.push('');
  lines.push(`**Date**: ${session.createdAt.toISOString().split('T')[0]}`);
  lines.push(`**Last Updated**: ${session.lastUpdatedAt.toISOString()}`);
  if (ws) {
    lines.push(`**Workspace**: ${ws}`);
  }
  lines.push(`**Messages**: ${session.messageCount}`);
  // Readable source line for merged and single-source Store sessions.
  const sourceLine = describeSessionSource(session);
  if (sourceLine) {
    lines.push(`**Source**: ${sourceLine}`);
  }
  if (session.transcriptState) {
    lines.push(`**Transcript State**: ${session.transcriptState}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Messages
  for (const message of session.messages) {
    const roleLabel = message.role === 'user' ? '**User**' : '**Assistant**';
    lines.push(`### ${roleLabel}`);
    lines.push('');
    if (message.id) {
      lines.push(`**ID**: \`${message.id}\``);
      lines.push('');
    }
    // Per-message time only when directly stored.
    if (message.timestamp) {
      lines.push(`**Time**: ${message.timestamp.toISOString()}`);
      lines.push('');
    }
    lines.push(message.content);
    lines.push('');
    if (message.toolCalls && message.toolCalls.length > 0) {
      const embeddedIndex = findEmbeddedToolCallIndex(message.content, message.toolCalls);
      const embeddedCall = embeddedIndex >= 0 ? message.toolCalls[embeddedIndex] : undefined;
      if (embeddedCall) {
        // Keep Composer's embedded representation, but append structured fields
        // that the text form cannot reliably preserve. This remains one tool
        // section and avoids silently dropping result/error/files on export.
        if (embeddedCall.params !== undefined) {
          lines.push(`- parameters: ${JSON.stringify(embeddedCall.params)}`);
        }
        if (embeddedCall.status && embeddedCall.status !== 'completed') {
          lines.push(`- status: ${embeddedCall.status}`);
        }
        if (embeddedCall.error !== undefined) {
          lines.push(`- error: ${embeddedCall.error}`);
        }
        if (embeddedCall.result !== undefined) {
          lines.push(`- result: ${truncateForMd(embeddedCall.result)}`);
        }
        if (embeddedCall.files !== undefined) {
          lines.push(`- files: ${embeddedCall.files.join(', ')}`);
        }
      }
      const callsToRender = message.toolCalls.filter((_, index) => index !== embeddedIndex);
      for (const tc of callsToRender) {
        const params = tc.params
          ? Object.entries(tc.params)
              .map(([k, v]) => `\`${k}\`=${JSON.stringify(v)}`)
              .join(', ')
          : '';
        let line = `- 🔧 **${tc.name}**${params ? ` — ${params}` : ''}`;
        if (tc.status && tc.status !== 'completed') line += ` _(${tc.status})_`;
        if (tc.error !== undefined) line += ` — error: ${tc.error}`;
        if (tc.result !== undefined) line += ` — result: ${truncateForMd(tc.result)}`;
        lines.push(line);
      }
      if (tc0HasFiles(callsToRender)) {
        const files = callsToRender.flatMap((tc) => tc.files ?? []);
        if (files.length > 0) lines.push(`- files: ${files.join(', ')}`);
      }
      if (callsToRender.length > 0) lines.push('');
    }
  }

  return lines.join('\n');
}

/** Bounded result snippet for Markdown tool lines. */
function truncateForMd(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

/** Whether any tool call in the list carries file paths. */
function tc0HasFiles(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((tc) => tc.files && tc.files.length > 0);
}

/**
 * Export a chat session to JSON format
 */
export function exportToJson(session: ChatSession, workspacePath?: string): string {
  // Fall back to the resolved session's own workspacePath when no explicit
  // path is supplied (Store-only sessions have no Composer workspace metadata).
  const ws = workspacePath ?? session.workspacePath ?? null;
  const exportData: Record<string, unknown> = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    lastUpdatedAt: session.lastUpdatedAt.toISOString(),
    messageCount: session.messageCount,
    workspacePath: ws,
  };
  if (session.source !== undefined) {
    exportData['source'] = session.source;
  }
  if (session.sources) {
    exportData['sources'] = session.sources;
  }
  if (session.preferredSource) {
    exportData['preferredSource'] = session.preferredSource;
  }
  if (session.transcriptState) {
    exportData['transcriptState'] = session.transcriptState;
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
      exportData['usage'] = usage;
    }
  }
  if (session.activeBranchBubbleIds !== undefined) {
    exportData['activeBranchBubbleIds'] = session.activeBranchBubbleIds;
  }

  // Map messages with token usage fields
  exportData['messages'] = session.messages.map((m) => {
    const msg: Record<string, unknown> = {
      id: m.id ?? undefined,
      role: m.role,
      content: m.content,
      codeBlocks: m.codeBlocks,
    };

    // Per-message timestamp + provenance only when directly stored.
    if (m.timestamp) {
      msg['timestamp'] = m.timestamp.toISOString();
    }
    if (m.timestampSource) {
      msg['timestampSource'] = m.timestampSource;
    }
    if (m.source) {
      msg['source'] = m.source;
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      msg['toolCalls'] = m.toolCalls.map(serializeToolCall);
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

  return JSON.stringify(exportData, null, 2);
}
