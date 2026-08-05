/**
 * Bounded Cursor agent transcript JSONL parser.
 *
 * Records are streamed as raw bytes, bounded before materialization, and
 * decoded with fatal deterministic UTF-8. One optional BOM is accepted only at
 * byte zero. Unknown object fields are ignored; unknown user-visible roles or
 * content parts retain any known content but degrade completeness.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { SourceEncodingError, SourceLimitExceededError } from '../errors.js';
import {
  decodeDeterministicUtf8,
  JsonlSourceReadBudget,
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  assertSourceReadLimit,
  type SourceFailureOutcome,
} from '../source-read-limits.js';
import type { Message, MessageRole, SourceReadLimitsV1, ToolCall } from '../types.js';
import type { StoreMessageIdentityEvidence, TranscriptState } from './types.js';

const READ_CHUNK_BYTES = 64 * 1024;

export type TranscriptSourceFailure = SourceEncodingError | SourceLimitExceededError;

export interface TranscriptParseResult {
  messages: Message[];
  state: TranscriptState;
  /** Source-native canonical inputs, aligned with `messages`. */
  messageIdentityEvidence: StoreMessageIdentityEvidence[];
  /** A present transcript is positive conversation evidence even if corrupt/empty. */
  positiveEvidence: boolean;
  /** Typed safe failure retained when the caller has a documented safe fallback. */
  diagnostic?: TranscriptSourceFailure;
}

/**
 * Parse one transcript. A fatal outcome throws on invalid encoding/limits; a
 * partial outcome returns already decoded records plus the typed diagnostic.
 */
export function parseTranscriptFile(
  filePath: string,
  limits: Readonly<SourceReadLimitsV1> = SOURCE_READ_LIMITS_V1_DEFAULTS,
  failureOutcome: SourceFailureOutcome = 'fatal'
): TranscriptParseResult {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return emptyResult('missing', false);
    throw error;
  }

  const messages: Message[] = [];
  const messageIdentityEvidence: StoreMessageIdentityEvidence[] = [];
  const budget = new JsonlSourceReadBudget(limits, failureOutcome);
  const recordChunks: Buffer[] = [];
  let recordRawBytes = 0;
  let physicalLine = 1;
  let errorLines = 0;
  let unsupportedLines = 0;
  let malformedLines = 0;
  let nonEmptyLines = 0;
  let ignoredLines = 0;
  let diagnostic: TranscriptSourceFailure | undefined;

  const processRecord = (): void => {
    const hasLeadingBom =
      physicalLine === 1 &&
      chunkByteAt(recordChunks, 0) === 0xef &&
      chunkByteAt(recordChunks, 1) === 0xbb &&
      chunkByteAt(recordChunks, 2) === 0xbf;
    const hasTrailingCr = chunkByteAt(recordChunks, recordRawBytes - 1) === 0x0d;
    const effectiveBytes = recordRawBytes - (hasLeadingBom ? 3 : 0) - (hasTrailingCr ? 1 : 0);

    // Enforce the raw record bound before materializing a contiguous Buffer or
    // decoding attacker-controlled input.
    budget.admitRecordBytes(effectiveBytes);
    let raw = Buffer.concat(recordChunks, recordRawBytes);
    recordChunks.length = 0;
    recordRawBytes = 0;
    if (hasTrailingCr) raw = raw.subarray(0, -1);

    const decoded = decodeDeterministicUtf8(raw, 'jsonl', failureOutcome, physicalLine === 1);
    const trimmed = decoded.text.trim();
    if (trimmed.length > 0) budget.admitNonemptyRecord();
    if (!trimmed) return;
    nonEmptyLines++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLines++;
      return;
    }

    const result = mapLine(parsed, physicalLine);
    if (result.kind === 'message') {
      messages.push(result.message);
      messageIdentityEvidence.push(result.identityEvidence);
      if (!result.complete) unsupportedLines++;
    } else if (result.kind === 'error') {
      errorLines++;
    } else if (result.kind === 'skip') {
      unsupportedLines++;
    } else {
      ignoredLines++;
    }
  };

  const appendBoundedSegment = (segmentView: Uint8Array): void => {
    if (segmentView.byteLength === 0) return;
    const projected = recordRawBytes + segmentView.byteLength;
    // Before the line closes, only a byte-zero BOM and one possible trailing
    // CR may later be excluded from the record bound.
    const maximumRaw = limits.jsonlRecordBytes + (physicalLine === 1 ? 3 : 0) + 1;
    if (projected > maximumRaw) {
      assertSourceReadLimit(
        'jsonl-record-bytes',
        limits.jsonlRecordBytes + 1,
        limits.jsonlRecordBytes,
        failureOutcome
      );
    }
    recordChunks.push(Buffer.from(segmentView));
    recordRawBytes = projected;
  };

  try {
    let eof = false;
    while (!eof) {
      // Read at most the first unit above the source bound so diagnostics never
      // depend on an arbitrary adapter chunk size.
      const remaining = Math.max(0, limits.jsonlSourceBytes - budget.sourceBytes);
      const requested = Math.min(READ_CHUNK_BYTES, remaining + 1);
      const chunk = Buffer.allocUnsafe(Math.max(1, requested));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        eof = true;
        if (recordRawBytes > 0) processRecord();
        break;
      }
      budget.admitSourceBytes(bytesRead);

      let segmentStart = 0;
      for (let offset = 0; offset < bytesRead; offset++) {
        if (chunk[offset] !== 0x0a) continue;
        if (offset > segmentStart) {
          appendBoundedSegment(chunk.subarray(segmentStart, offset));
        }
        processRecord();
        physicalLine++;
        segmentStart = offset + 1;
      }
      if (segmentStart < bytesRead) {
        appendBoundedSegment(chunk.subarray(segmentStart, bytesRead));
      }
    }
  } catch (error) {
    if (error instanceof SourceEncodingError || error instanceof SourceLimitExceededError) {
      if (failureOutcome === 'fatal') throw error;
      diagnostic = error;
    } else throw error;
  } finally {
    closeSync(fd);
  }

  const state = determineState({
    messages: messages.length,
    errorLines,
    unsupportedLines,
    malformedLines,
    nonEmptyLines,
    ignoredLines,
    forcedPartial: diagnostic !== undefined,
  });
  return {
    messages,
    state,
    messageIdentityEvidence,
    positiveEvidence: true,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function chunkByteAt(chunks: readonly Buffer[], index: number): number | undefined {
  if (index < 0) return undefined;
  let remaining = index;
  for (const chunk of chunks) {
    if (remaining < chunk.byteLength) return chunk[remaining];
    remaining -= chunk.byteLength;
  }
  return undefined;
}

function emptyResult(state: TranscriptState, positiveEvidence: boolean): TranscriptParseResult {
  return { messages: [], state, messageIdentityEvidence: [], positiveEvidence };
}

function determineState(values: {
  messages: number;
  errorLines: number;
  unsupportedLines: number;
  malformedLines: number;
  nonEmptyLines: number;
  ignoredLines: number;
  forcedPartial: boolean;
}): TranscriptState {
  if (values.messages > 0) {
    return values.forcedPartial ||
      values.malformedLines > 0 ||
      values.unsupportedLines > 0 ||
      values.errorLines > 0
      ? 'partial'
      : 'parsed';
  }
  if (values.forcedPartial) return 'unreadable';
  if (values.errorLines > 0 && values.malformedLines === 0 && values.unsupportedLines === 0) {
    return 'error-only';
  }
  if (values.nonEmptyLines > values.ignoredLines) return 'unsupported';
  return 'empty';
}

type LineResult =
  | {
      kind: 'message';
      message: Message;
      identityEvidence: StoreMessageIdentityEvidence;
      complete: boolean;
    }
  | { kind: 'error' }
  | { kind: 'ignore' }
  | { kind: 'skip' };

function mapLine(parsed: unknown, sourceLine: number): LineResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'skip' };
  const obj = parsed as Record<string, unknown>;

  if (obj['type'] === 'error') return { kind: 'error' };
  if (obj['role'] === 'system') return { kind: 'ignore' };
  if (obj['role'] !== 'user' && obj['role'] !== 'assistant') return { kind: 'skip' };

  const nested = obj['message'];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return { kind: 'skip' };
  const nestedRecord = nested as Record<string, unknown>;
  const content = nestedRecord['content'];
  if (!Array.isArray(content)) return { kind: 'skip' };

  const { text, toolCalls, toolActivity, complete } = extractContent(content);
  if (text.length === 0 && toolCalls.length === 0) return { kind: 'skip' };

  const sourceRelationships: Record<string, unknown> = {};
  const parent = firstString(
    obj['parentMessageId'],
    obj['parentId'],
    nestedRecord['parentMessageId'],
    nestedRecord['parentId']
  );
  const sidechain = firstBoolean(obj['isSidechain'], nestedRecord['isSidechain']);
  if (parent !== undefined) sourceRelationships['parentMessageId'] = parent;
  if (sidechain !== undefined) sourceRelationships['isSidechain'] = sidechain;

  const message: Message = {
    id: null,
    role: obj['role'] as MessageRole,
    content: text,
    codeBlocks: [],
  };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  if (parent !== undefined) message.parentMessageId = parent;
  if (sidechain !== undefined) message.isSidechain = sidechain;

  return {
    kind: 'message',
    message,
    complete,
    identityEvidence: {
      representation: 'transcript',
      sourceLine,
      role: message.role,
      content: message.content,
      toolActivity,
      sourceRelationships,
    },
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean');
}

function extractContent(parts: unknown[]): {
  text: string;
  toolCalls: ToolCall[];
  toolActivity: Readonly<Record<string, unknown>>[];
  complete: boolean;
} {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolActivity: Record<string, unknown>[] = [];
  let complete = true;

  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      complete = false;
      continue;
    }
    const value = part as Record<string, unknown>;
    if (value['type'] === 'text' && typeof value['text'] === 'string') {
      texts.push(value['text']);
      continue;
    }
    if (value['type'] === 'tool_use' && typeof value['name'] === 'string') {
      const call: ToolCall = { name: value['name'], status: 'completed' };
      const activity: Record<string, unknown> = { name: value['name'] };
      if (value['input'] && typeof value['input'] === 'object' && !Array.isArray(value['input'])) {
        call.params = value['input'] as Record<string, unknown>;
        activity['params'] = value['input'];
      }
      toolCalls.push(call);
      toolActivity.push(activity);
      continue;
    }
    complete = false;
  }

  return { text: texts.join(''), toolCalls, toolActivity, complete };
}
