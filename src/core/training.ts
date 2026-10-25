/**
 * Training-data projection for chat sessions.
 *
 * This module converts resolved `ChatSession` objects into conversation records
 * shaped for supervised fine-tuning / agent training, rather than for reading.
 *
 * The display-oriented `content` strings produced by the storage layer carry
 * presentation scaffolding (`[Tool: Read File]`, `[Thinking]`, `[Error]`) and
 * duplicate data that is also available in structured form (`Message.toolCalls`).
 * Training on those strings teaches a model to emit the scaffolding instead of
 * real tool-call syntax, so this projection rebuilds assistant turns from the
 * structured fields and keeps only the natural-language remainder of `content`.
 */

import {
  toShareGptRecord,
  validateToolDefinitions,
  type TrainingSchema,
  type TrainingToolDefinition,
} from './training-formats.js';
export {
  toShareGpt,
  toTrl,
  convertTrainingRecord,
  serializeTrainingLine,
} from './training-formats.js';

import type { ChatSession, Message, ToolCall } from './types.js';
import { anonymizeHostPaths, redactSensitiveText, type RedactionCounts } from './sensitive-data.js';
export { anonymizeHostPaths, redactSensitiveText, type RedactionCounts } from './sensitive-data.js';

/** Serialized assistant tool call in the OpenAI function-calling shape. */
export interface TrainingToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** One conversation turn in a training record. */
export interface TrainingMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant-only reasoning trace, when `includeReasoning` is enabled. */
  reasoning_content?: string;
  /** Assistant-only structured tool calls. */
  tool_calls?: TrainingToolCall[];
  /** Tool-only correlation id; matches `TrainingToolCall.id`. */
  tool_call_id?: string;
  /** Tool-only execution outcome for a tool call. */
  status?: 'completed' | 'error' | 'cancelled';
}

/** Why a session (or segment) was excluded from the export. */
export type TrainingDropReason =
  'no-user-turn' | 'empty' | 'no-usable-content' | 'below-min-user-turns';

export interface TrainingRecordMetadata {
  title: string | null;
  workspace: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  messageCount: number;
  sources: readonly string[];
  resolvedSource: string | null;
  resolutionState: string | null;
  /** 1-based segment index when a session was split; omitted when whole. */
  segment?: { index: number; total: number };
}

/** A single JSONL-ready training example. */
export interface TrainingRecord {
  id: string;
  schema: 'cursor-history-training/v1';
  metadata: TrainingRecordMetadata;
  messages: TrainingMessage[];
  /** Explicit caller-supplied tool definitions; never inferred from calls. */
  tools?: TrainingToolDefinition[];
}

/** ShareGPT-style record, offered for trainers that require that shape. */
export interface ShareGptRecord {
  id: string;
  conversations: Array<{ from: 'system' | 'human' | 'gpt' | 'tool'; value: string }>;
  metadata: TrainingRecordMetadata;
}

export interface TrainingExportOptions {
  /** Output profile. Defaults to `messages`; projection is shared by all formats. */
  schema?: TrainingSchema;
  /** Available function JSON schemas, sanitized with the conversation. */
  toolDefinitions?: TrainingToolDefinition[];
  /** Include `Message.thinking` / `[Thinking]` segments. Defaults to true. */
  includeReasoning?: boolean;
  /** Emit structured tool calls as assistant `tool_calls` + `tool` turns. Defaults to true. */
  includeToolCalls?: boolean;
  /** Maximum characters kept per tool result. Defaults to 4000. */
  maxToolResultChars?: number;
  /** Maximum characters kept per user message. Defaults to 8000. */
  maxUserChars?: number;
  /** Redact credentials and secrets. Defaults to true. */
  redact?: boolean;
  /** Replace host home-directory paths (e.g. /Users/<name>) with a placeholder. Defaults to true. */
  anonymizePaths?: boolean;
  /** Split sessions that exceed this many characters at user-turn boundaries. Defaults to 40000. */
  maxCharsPerRecord?: number;
  /** Discard records with fewer than this many user turns. Defaults to 1. */
  minUserTurns?: number;
  /** Optional system prompt placed at the head of every record. */
  systemPrompt?: string;
}

const DEFAULT_OPTIONS: Required<Omit<TrainingExportOptions, 'systemPrompt' | 'toolDefinitions'>> = {
  schema: 'messages',
  includeReasoning: true,
  includeToolCalls: true,
  maxToolResultChars: 4000,
  maxUserChars: 8000,
  redact: true,
  anonymizePaths: true,
  maxCharsPerRecord: 40_000,
  minUserTurns: 1,
};

/** Segment kinds recognized in display-oriented `content` strings. */
type ContentSegmentKind = 'text' | 'tool' | 'thinking' | 'error';

interface ContentSegment {
  kind: ContentSegmentKind;
  text: string;
}

/** Matches the storage layer's display markers, which always start a line. */
const MARKER_LINE = /^\[(?:Tool:[^\]]*|Thinking|Error)\]\s*$/;
/** Internal placeholders emitted for degraded bubbles. */
const PLACEHOLDER_LINE = /^\[(?:empty message|corrupted message)\]$/;

/**
 * Split a display-oriented `content` string into typed segments.
 *
 * Markers (`[Tool: ...]`, `[Thinking]`, `[Error]`) occupy their own line and
 * open a segment that runs until the next marker. Text outside any marker is
 * natural language and is the only part worth training on.
 */
export function segmentDisplayContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let current: ContentSegmentKind = 'text';
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      segments.push({ kind: current, text });
    }
    buffer = [];
  };

  for (const line of content.split('\n')) {
    if (PLACEHOLDER_LINE.test(line.trim())) {
      flush();
      continue;
    }
    if (MARKER_LINE.test(line)) {
      flush();
      const inner = line.slice(1, -1);
      if (inner.startsWith('Tool:')) current = 'tool';
      else if (inner === 'Thinking') current = 'thinking';
      else current = 'error';
      continue;
    }
    buffer.push(line);
  }
  flush();
  return segments;
}

/** Extract only the natural-language portion of a display-oriented content string. */
export function naturalLanguageOf(content: string): string {
  return segmentDisplayContent(content)
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('\n\n')
    .trim();
}

/** Truncate to `limit` characters, appending an explicit marker. */
export function truncateWithMarker(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... truncated ${text.length - limit} chars]`;
}

interface SanitizeContext {
  options: Required<Omit<TrainingExportOptions, 'systemPrompt' | 'toolDefinitions'>>;
  counts: RedactionCounts;
}

function sanitize(text: string, context: SanitizeContext): string {
  let output = text;
  if (context.options.redact) {
    const result = redactSensitiveText(output);
    output = result.text;
    context.counts.privateKey += result.counts.privateKey;
    context.counts.jwt += result.counts.jwt;
    context.counts.apiKey += result.counts.apiKey;
    context.counts.secretAssignment += result.counts.secretAssignment;
  }
  if (context.options.anonymizePaths) {
    output = anonymizeHostPaths(output);
  }
  return output;
}

/**
 * Sanitize a JSON-shaped value without corrupting its structure.
 *
 * Redacting the serialized form of tool parameters is unsafe: a replacement can
 * delete a closing quote and leave invalid JSON, which breaks trainers that
 * parse `arguments`. Sanitizing each leaf string instead and serializing
 * afterwards makes valid output structural rather than incidental.
 */
function sanitizeJsonValue(value: unknown, context: SanitizeContext, depth = 0): unknown {
  if (typeof value === 'string') return sanitize(value, context);
  if (depth > 32) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry, context, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[sanitize(key, context)] = sanitizeJsonValue(entry, context, depth + 1);
    }
    return output;
  }
  return value;
}

/** Derive a readable workspace label without leaking the full host path. */
function workspaceLabel(session: ChatSession): string | null {
  const path = session.canonicalWorkspacePath ?? session.workspacePath ?? null;
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : path;
}

/** Collect reasoning text directly stored on a message. */
function reasoningCandidates(message: Message): string[] {
  const found: string[] = [];
  if (typeof message.thinking === 'string' && message.thinking.trim().length > 0) {
    found.push(message.thinking.trim());
  }
  for (const segment of segmentDisplayContent(message.content)) {
    if (segment.kind === 'thinking') found.push(segment.text);
  }
  return found;
}

interface BuildResult {
  messages: TrainingMessage[];
  dropReason?: TrainingDropReason;
}

/**
 * Project resolved messages into training turns.
 *
 * Assistant turns are rebuilt from structured data: tool calls become
 * `tool_calls` plus correlated `tool` turns, and only the non-marker remainder
 * of `content` is kept as natural language.
 */
function buildTrainingMessages(
  messages: readonly Message[],
  context: SanitizeContext
): BuildResult {
  const output: TrainingMessage[] = [];
  let callCounter = 0;

  const nextCallId = (): string => {
    callCounter += 1;
    return `call_${callCounter}`;
  };

  for (const message of messages) {
    if (message.role === 'user') {
      const text = truncateWithMarker(
        sanitize(message.content.trim(), context),
        context.options.maxUserChars
      );
      if (text.length > 0) {
        output.push({ role: 'user', content: text });
      }
      continue;
    }

    const natural = sanitize(naturalLanguageOf(message.content), context);
    const reasoning = context.options.includeReasoning
      ? reasoningCandidates(message)
          .map((candidate) => sanitize(candidate, context))
          .join('\n\n')
          .trim()
      : '';

    const calls = context.options.includeToolCalls ? (message.toolCalls ?? []) : [];
    const toolCalls: TrainingToolCall[] = [];
    const results: Array<{ id: string; content: string; status: ToolCall['status'] }> = [];

    for (const call of calls) {
      const id = nextCallId();
      // Parameters carry absolute file paths and occasionally inline secrets,
      // so their leaf values pass through the same sanitizer as content, then
      // are serialized. Sanitizing values (not the serialized text) keeps
      // `arguments` parseable JSON.
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(sanitizeJsonValue(call.params ?? {}, context)),
        },
      });
      const rawResult = call.error ?? call.result ?? '';
      const content = truncateWithMarker(
        sanitize(typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult), context),
        context.options.maxToolResultChars
      );
      results.push({ id, content, status: call.status });
    }

    const assistant: TrainingMessage = { role: 'assistant', content: natural };
    if (reasoning.length > 0) assistant.reasoning_content = reasoning;
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    output.push(assistant);

    for (const result of results) {
      output.push({
        role: 'tool',
        tool_call_id: result.id,
        content: result.content,
        status: result.status,
      });
    }
  }

  const hasUser = output.some((message) => message.role === 'user');
  const hasAssistantText = output.some(
    (message) =>
      message.role === 'assistant' &&
      (message.content.trim().length > 0 || (message.tool_calls?.length ?? 0) > 0)
  );
  if (output.length === 0) return { messages: output, dropReason: 'empty' };
  if (!hasUser) return { messages: output, dropReason: 'no-user-turn' };
  if (!hasAssistantText) return { messages: output, dropReason: 'no-usable-content' };
  return { messages: output };
}

/** Split messages into coherent slices that each begin at a user turn. */
function groupByUserTurns(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const message of messages) {
    if (message.role === 'user' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Approximate serialized size of a message group, used for slicing decisions. */
function approximateSize(group: readonly Message[]): number {
  let total = 0;
  for (const message of group) {
    total += message.content.length;
    for (const call of message.toolCalls ?? []) {
      total += (call.result?.length ?? 0) + (call.error?.length ?? 0);
    }
  }
  return total;
}

/**
 * Pack user-turn groups into records bounded by `maxCharsPerRecord`.
 *
 * Splitting on user-turn boundaries keeps each agent loop (ask, tool calls,
 * answer) intact, which avoids teaching a model to answer without context.
 */
function packGroups(
  groups: readonly Message[][],
  maxChars: number
): { groups: Message[][]; total: number }[] {
  const slices: { groups: Message[][]; total: number }[] = [];
  let currentGroups: Message[][] = [];
  let currentChars = 0;

  for (const group of groups) {
    const size = approximateSize(group);
    if (currentGroups.length > 0 && currentChars + size > maxChars) {
      slices.push({ groups: currentGroups, total: currentChars });
      currentGroups = [];
      currentChars = 0;
    }
    currentGroups.push(group);
    currentChars += size;
  }
  if (currentGroups.length > 0) slices.push({ groups: currentGroups, total: currentChars });
  return slices;
}

export interface SessionProjectionResult {
  records: TrainingRecord[];
  shareGpt: ShareGptRecord[];
  redaction: RedactionCounts;
  dropReason?: TrainingDropReason;
}

/**
 * Project one session into training records.
 *
 * A session is emitted as a single record when it fits under
 * `maxCharsPerRecord`; larger sessions are split at user-turn boundaries so
 * each record stays inside typical training context windows.
 */
export function projectSession(
  session: ChatSession,
  options: TrainingExportOptions = {}
): SessionProjectionResult {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const counts: RedactionCounts = {
    privateKey: 0,
    jwt: 0,
    apiKey: 0,
    secretAssignment: 0,
  };
  const context: SanitizeContext = { options: resolved, counts };
  const tools =
    resolved.includeToolCalls && resolved.toolDefinitions !== undefined
      ? validateToolDefinitions(
          sanitizeJsonValue(validateToolDefinitions(resolved.toolDefinitions), context)
        )
      : undefined;

  const groups = groupByUserTurns(session.messages);
  const slices = packGroups(groups, resolved.maxCharsPerRecord);
  const workspace = workspaceLabel(session);
  const sources = session.sources ?? (session.workspaceId === 'store' ? ['store'] : ['composer']);

  const records: TrainingRecord[] = [];
  const shareGpt: ShareGptRecord[] = [];
  let firstDrop: TrainingDropReason | undefined;

  slices.forEach((slice, sliceIndex) => {
    const flat = slice.groups.flat();
    const built = buildTrainingMessages(flat, context);
    if (built.dropReason) {
      firstDrop ??= built.dropReason;
      return;
    }

    const userTurns = built.messages.filter((message) => message.role === 'user').length;
    if (userTurns < resolved.minUserTurns) {
      firstDrop ??= 'below-min-user-turns';
      return;
    }

    const messages: TrainingMessage[] = [];
    if (resolved.systemPrompt && resolved.systemPrompt.trim().length > 0) {
      messages.push({
        role: 'system',
        content: truncateWithMarker(sanitize(resolved.systemPrompt.trim(), context), 8000),
      });
    }
    messages.push(...built.messages);

    const metadata: TrainingRecordMetadata = {
      title: session.title === null ? null : sanitize(session.title, context),
      workspace: workspace === null ? null : sanitize(workspace, context),
      createdAt: session.createdAt.toISOString(),
      lastUpdatedAt: session.lastUpdatedAt.toISOString(),
      messageCount: flat.length,
      sources,
      resolvedSource: session.resolvedSource ?? session.source ?? null,
      resolutionState: session.resolution?.state ?? session.resolutionState ?? null,
      ...(slices.length > 1 ? { segment: { index: sliceIndex + 1, total: slices.length } } : {}),
    };

    const id = slices.length > 1 ? `${session.id}#${sliceIndex + 1}` : session.id;
    const record: TrainingRecord = {
      id,
      schema: 'cursor-history-training/v1',
      metadata,
      messages,
      ...(tools !== undefined ? { tools } : {}),
    };
    records.push(record);
    shareGpt.push(toShareGptRecord(record));
  });

  if (records.length === 0) {
    return { records, shareGpt, redaction: counts, dropReason: firstDrop ?? 'empty' };
  }
  return { records, shareGpt, redaction: counts };
}

/** Add two redaction tallies. */
export function mergeRedactionCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  return {
    privateKey: a.privateKey + b.privateKey,
    jwt: a.jwt + b.jwt,
    apiKey: a.apiKey + b.apiKey,
    secretAssignment: a.secretAssignment + b.secretAssignment,
  };
}

export const TRAINING_DEFAULT_OPTIONS = DEFAULT_OPTIONS;

/**
 * Base session identity for a training record id.
 *
 * Split segments are suffixed `#<n>`, so the suffix is stripped to obtain the
 * stable session key used for group-aware splitting.
 */
export function baseSessionKey(id: string): string {
  const separator = id.indexOf('#');
  return separator >= 0 ? id.slice(0, separator) : id;
}

/**
 * Deterministically assign a record to `train` or `validation`.
 *
 * Assignment is keyed on the *session*, so every segment of a split session
 * lands in the same split — otherwise a conversation's later turns could be
 * trained on and its earlier turns held out. Hashing makes the result stable
 * across runs and independent of record ordering; `seed` allows alternate folds
 * without changing the data.
 */
export function assignSplit(id: string, validRatio: number, seed = 42): 'train' | 'validation' {
  if (!(validRatio > 0)) return 'train';
  if (validRatio >= 1) return 'validation';
  const key = `${seed}:${baseSessionKey(id)}`;
  // FNV-1a (32-bit), mapped onto [0, 1).
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000 < validRatio ? 'validation' : 'train';
}

/** Derive the validation output path from the training output path. */
export function deriveValidationPath(trainPath: string): string {
  return trainPath.endsWith('.jsonl')
    ? `${trainPath.slice(0, -'.jsonl'.length)}.validation.jsonl`
    : `${trainPath}.validation.jsonl`;
}
