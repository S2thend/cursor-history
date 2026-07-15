/**
 * Parse Cursor agent transcript JSONL (role-nested form, Cursor 3.x).
 * See specs/015-cursor-store-stack/research.md §6 / data-model.md §2.
 *
 * Each line: {"role":"user"|"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
 * Error lines {"type":"error",...} are skipped. Unknown part types are ignored
 * (forward compatibility). Per-message timestamps are NOT present in transcripts;
 * messages therefore carry NO timestamp rather than a session-level fallback.
 */
import { readFileSync } from 'node:fs';
import type { Message, MessageRole, ToolCall } from '../types.js';

/**
 * Parse a transcript JSONL file into Messages.
 * Returns [] for missing/unreadable files (defensive — never throws).
 */
export function parseTranscriptFile(filePath: string): Message[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const messages: Message[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // unparseable line → skip (defensive parsing)
    }

    const msg = mapLine(parsed);
    if (msg) messages.push(msg);
  }

  return messages;
}

function mapLine(parsed: unknown): Message | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.type === 'error') return null; // skip provider-error lines
  if (obj.role !== 'user' && obj.role !== 'assistant') return null;

  const content = (obj as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;

  const { text, toolCalls } = extractContent(content);

  // No per-message timestamp is stored in transcripts; leave timestamp undefined.
  const message: Message = {
    id: null,
    role: obj.role as MessageRole,
    content: text,
    codeBlocks: [],
  };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return message;
}

function extractContent(parts: unknown[]): { text: string; toolCalls: ToolCall[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: unknown; name?: unknown; input?: unknown };

    if (p.type === 'text' && typeof p.text === 'string') {
      texts.push(p.text);
    } else if (p.type === 'tool_use' && typeof p.name === 'string') {
      const toolCall: ToolCall = { name: p.name, status: 'completed' };
      if (p.input && typeof p.input === 'object') {
        toolCall.params = p.input as Record<string, unknown>;
      }
      toolCalls.push(toolCall);
    }
    // unknown part types ignored (forward compatibility, constitution V)
  }

  return { text: texts.join(''), toolCalls };
}
