/**
 * Chat data parsing and content extraction
 */

import type { ChatSession, Message, CodeBlock, SearchSnippet, MessageRole } from './types.js';

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
  let data: RawChatData | ComposerData;

  try {
    data = JSON.parse(jsonString) as RawChatData | ComposerData;
  } catch {
    return [];
  }

  // Check if this is the new composer format
  if ('allComposers' in data && data.allComposers) {
    return parseComposerFormat(data as ComposerData, bundle);
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
    const lastUpdatedAt = composer.lastUpdatedAt
      ? new Date(composer.lastUpdatedAt)
      : createdAt;

    // Try to find messages that fall within this session's time range
    const sessionMessages: Message[] = [];

    // For now, we'll create placeholder sessions with metadata
    // The actual messages are in a flat list and hard to associate
    // We'll include the name as preview if available
    if (composer.name) {
      sessionMessages.push({
        id: null,
        role: 'user',
        content: composer.name,
        timestamp: createdAt,
        codeBlocks: [],
      });
    }

    // Find generations that might belong to this session (by time proximity)
    const sessionStart = composer.createdAt ?? 0;
    const sessionEnd = composer.lastUpdatedAt ?? Date.now();

    for (const gen of sortedGenerations) {
      if (gen.unixMs && gen.unixMs >= sessionStart && gen.unixMs <= sessionEnd + 60000) {
        if (gen.textDescription) {
          sessionMessages.push({
            id: gen.generationUUID ?? null,
            role: 'user', // textDescription is actually the prompt
            content: gen.textDescription,
            timestamp: new Date(gen.unixMs),
            codeBlocks: extractCodeBlocks(gen.textDescription),
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
      messages: sessionMessages.length > 0 ? sessionMessages : [{
        id: null,
        role: 'user',
        content: composer.name ?? '(Empty session)',
        timestamp: createdAt,
        codeBlocks: [],
      }],
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

  // Parse timestamp
  const timestamp = raw.timestamp
    ? new Date(raw.timestamp)
    : raw.createdAt
      ? new Date(raw.createdAt)
      : new Date();

  return {
    id: raw.id ?? null,
    role,
    content,
    timestamp,
    codeBlocks: extractCodeBlocks(content),
  };
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
 * Export a chat session to Markdown format
 */
export function exportToMarkdown(session: ChatSession, workspacePath?: string): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${session.title ?? 'Untitled Chat'}`);
  lines.push('');
  lines.push(`**Date**: ${session.createdAt.toISOString().split('T')[0]}`);
  if (workspacePath) {
    lines.push(`**Workspace**: ${workspacePath}`);
  }
  lines.push(`**Messages**: ${session.messageCount}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Messages
  for (const message of session.messages) {
    const roleLabel = message.role === 'user' ? '**User**' : '**Assistant**';
    lines.push(`### ${roleLabel}`);
    lines.push('');
    lines.push(message.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export a chat session to JSON format
 */
export function exportToJson(session: ChatSession, workspacePath?: string): string {
  const exportData = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt.toISOString(),
    lastUpdatedAt: session.lastUpdatedAt.toISOString(),
    messageCount: session.messageCount,
    workspacePath: workspacePath ?? null,
    messages: session.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp.toISOString(),
      codeBlocks: m.codeBlocks,
    })),
  };

  return JSON.stringify(exportData, null, 2);
}
