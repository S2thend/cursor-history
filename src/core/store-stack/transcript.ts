/**
 * Parse Cursor agent transcript JSONL (role-nested form, Cursor 3.x).
 * See specs/015-cursor-store-stack/research.md §6 / data-model.md §2.
 *
 * Each line: {"role":"user"|"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
 * Error lines {"type":"error",...} are recognized but do not yield messages.
 * Unknown user-visible roles or part types are omitted defensively and mark the
 * transcript partial/unsupported rather than overstating fidelity.
 *
 * Per-message timestamps are NOT present in transcripts; messages carry NO
 * timestamp rather than a session-level fallback.
 *
 * Returns an explicit TranscriptState alongside the messages so callers
 * no longer infer transcript presence from message count.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Message, MessageRole, ToolCall } from '../types.js';
import type { TranscriptState } from './types.js';

export interface TranscriptParseResult {
  messages: Message[];
  state: TranscriptState;
}

/**
 * Parse a transcript JSONL file into messages plus an explicit state.
 * Never throws — unreadable/missing files return their degraded state.
 */
export function parseTranscriptFile(filePath: string): TranscriptParseResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const state: TranscriptState =
      code === 'ENOENT' || !existsSync(filePath) ? 'missing' : 'unreadable';
    return { messages: [], state };
  }

  const messages: Message[] = [];
  let errorLines = 0;
  let unsupportedLines = 0;
  let malformedLines = 0;
  let nonEmptyLines = 0;
  let ignoredLines = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    nonEmptyLines++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLines++;
      continue;
    }

    const result = mapLine(parsed);
    if (result.kind === 'message') {
      messages.push(result.message);
      if (!result.complete) unsupportedLines++;
    } else if (result.kind === 'error') {
      errorLines++;
    } else if (result.kind === 'skip') {
      unsupportedLines++;
    } else {
      ignoredLines++;
    }
  }

  let state: TranscriptState;
  if (messages.length > 0) {
    state = malformedLines > 0 || unsupportedLines > 0 || errorLines > 0 ? 'partial' : 'parsed';
  } else if (errorLines > 0 && malformedLines === 0 && unsupportedLines === 0) {
    state = 'error-only';
  } else if (nonEmptyLines > ignoredLines) {
    state = 'unsupported';
  } else {
    state = 'empty';
  }
  return { messages, state };
}

type LineResult =
  | { kind: 'message'; message: Message; complete: boolean }
  | { kind: 'error' }
  | { kind: 'ignore' }
  | { kind: 'skip' };

function mapLine(parsed: unknown): LineResult {
  if (!parsed || typeof parsed !== 'object') return { kind: 'skip' };
  const obj = parsed as Record<string, unknown>;

  if (obj.type === 'error') return { kind: 'error' }; // provider-error line
  if (obj.role === 'system') return { kind: 'ignore' }; // intentionally non-user-visible
  if (obj.role !== 'user' && obj.role !== 'assistant') return { kind: 'skip' };

  const content = (obj as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return { kind: 'skip' };

  const { text, toolCalls, complete } = extractContent(content);
  if (text.length === 0 && toolCalls.length === 0) return { kind: 'skip' };

  // No per-message timestamp is stored in transcripts; leave timestamp undefined.
  const message: Message = {
    id: null,
    role: obj.role as MessageRole,
    content: text,
    codeBlocks: [],
  };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return { kind: 'message', message, complete };
}

function extractContent(parts: unknown[]): {
  text: string;
  toolCalls: ToolCall[];
  complete: boolean;
} {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let complete = true;

  for (const part of parts) {
    if (!part || typeof part !== 'object') {
      complete = false;
      continue;
    }
    const p = part as { type?: string; text?: unknown; name?: unknown; input?: unknown };

    if (p.type === 'text' && typeof p.text === 'string') {
      texts.push(p.text);
    } else if (p.type === 'tool_use' && typeof p.name === 'string') {
      const toolCall: ToolCall = { name: p.name, status: 'completed' };
      if (p.input && typeof p.input === 'object') {
        toolCall.params = p.input as Record<string, unknown>;
      }
      toolCalls.push(toolCall);
    } else {
      complete = false;
    }
  }

  return { text: texts.join(''), toolCalls, complete };
}
