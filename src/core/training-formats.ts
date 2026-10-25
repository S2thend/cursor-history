/** Pure, reusable format adapters over the shared training projection. */
import type {
  ShareGptRecord,
  TrainingMessage,
  TrainingRecord,
  TrainingToolCall,
} from './training.js';

export type TrainingSchema = 'messages' | 'sharegpt' | 'trl';

/** Function JSON schema supplied by the caller, not reconstructed from history. */
export interface TrainingToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TrlToolCall extends Omit<TrainingToolCall, 'function'> {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface TrlMessage extends Omit<TrainingMessage, 'tool_calls'> {
  tool_calls?: TrlToolCall[];
  /** Tool name for templates that require it in addition to tool_call_id. */
  name?: string;
}

export interface TrlRecord extends Omit<TrainingRecord, 'schema' | 'messages'> {
  schema: 'cursor-history-training-trl/v1';
  messages: TrlMessage[];
  tools: TrainingToolDefinition[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the function-schema envelope, preserving unknown JSON Schema extensions. */
export function validateToolDefinitions(value: unknown): TrainingToolDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('Tool definitions must be a JSON array of function schemas.');
  }
  const names = new Set<string>();
  for (const [index, tool] of value.entries()) {
    const fn: unknown = isObject(tool) ? tool['function'] : undefined;
    if (
      !isObject(tool) ||
      tool['type'] !== 'function' ||
      !isObject(fn) ||
      typeof fn['name'] !== 'string' ||
      !fn['name'].trim() ||
      (fn['description'] !== undefined && typeof fn['description'] !== 'string') ||
      !isObject(fn['parameters']) ||
      fn['parameters']['type'] !== 'object'
    ) {
      throw new Error(
        `Tool definition ${index + 1} must have type "function", a nonempty function.name and function.parameters with type "object".`
      );
    }
    if (names.has(fn['name'])) throw new Error(`Duplicate tool definition: ${fn['name']}.`);
    names.add(fn['name']);
  }
  return value as TrainingToolDefinition[];
}

/** Convert string arguments to HF objects and validate tool definitions and correlations. */
export function toTrl(record: TrainingRecord): TrlRecord {
  const tools = validateToolDefinitions(record.tools ?? []);
  const available = new Set(tools.map((tool) => tool.function.name));
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  const fail = (message: string): never => {
    throw new Error(`Record ${record.id}: ${message}`);
  };
  const messages: TrlMessage[] = record.messages.map((message) => {
    const { tool_calls: calls, ...rest } = message;
    if (message.role === 'tool') {
      const id = message.tool_call_id;
      const name = id === undefined ? undefined : pending.get(id);
      if (!name) return fail('Tool response has no pending matching tool call.');
      pending.delete(id!);
      return { ...rest, name };
    }
    if (pending.size > 0) return fail('Tool calls are missing responses before the next turn.');
    if (!calls?.length) return { ...rest };
    if (message.role !== 'assistant')
      return fail('Only assistant messages may contain tool calls.');
    const tool_calls = calls.map((call): TrlToolCall => {
      if (!available.has(call.function.name)) {
        return fail(
          `Missing definition for tool "${call.function.name}". Supply it with --tools-file, or export with --no-tools.`
        );
      }
      if (!call.id || seen.has(call.id))
        return fail('Tool call IDs must be nonempty and unique within a record.');
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        return fail(`Tool "${call.function.name}" arguments must be valid JSON.`);
      }
      if (!isObject(args))
        return fail(`Tool "${call.function.name}" arguments must be a JSON object.`);
      seen.add(call.id);
      pending.set(call.id, call.function.name);
      return { ...call, function: { ...call.function, arguments: args } };
    });
    return { ...rest, tool_calls };
  });
  if (pending.size > 0) return fail('Tool calls are missing responses at the end of the record.');
  return { ...record, schema: 'cursor-history-training-trl/v1', messages, tools };
}

/** Flatten training turns into the ShareGPT `conversations` shape. */
export function toShareGpt(messages: readonly TrainingMessage[]): ShareGptRecord['conversations'] {
  const conversations: ShareGptRecord['conversations'] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        conversations.push({ from: 'system', value: message.content });
        break;
      case 'user':
        conversations.push({ from: 'human', value: message.content });
        break;
      case 'assistant': {
        const parts: string[] = [];
        if (message.reasoning_content) {
          parts.push(`[reasoning]\n${message.reasoning_content}`);
        }
        if (message.content.trim().length > 0) parts.push(message.content);
        for (const call of message.tool_calls ?? []) {
          parts.push(`[tool_call] ${call.function.name} ${call.function.arguments}`);
        }
        conversations.push({ from: 'gpt', value: parts.join('\n\n') });
        break;
      }
      case 'tool':
        conversations.push({
          from: 'tool',
          value: `[tool_result${message.status ? ` ${message.status}` : ''}]\n${message.content}`,
        });
        break;
      default: {
        const exhaustive: never = message.role;
        throw new Error(`Unhandled training role: ${String(exhaustive)}`);
      }
    }
  }
  return conversations;
}

/** Build a ShareGPT record using the same adapter used by legacy projections. */
export function toShareGptRecord(record: TrainingRecord): ShareGptRecord {
  return { id: record.id, conversations: toShareGpt(record.messages), metadata: record.metadata };
}

/** Convert one projected record without mutating the source or repeating extraction. */
export function convertTrainingRecord(
  record: TrainingRecord,
  schema: TrainingSchema
): TrainingRecord | ShareGptRecord | TrlRecord {
  switch (schema) {
    case 'messages':
      return record;
    case 'sharegpt':
      return toShareGptRecord(record);
    case 'trl':
      return toTrl(record);
    default:
      throw new Error(`Unknown training schema: ${String(schema)}`);
  }
}

/** Serialize a projection, also accepting legacy preconverted ShareGPT records. */
export function serializeTrainingLine(
  record: TrainingRecord | ShareGptRecord,
  schema: TrainingSchema
): string {
  if ('messages' in record) return JSON.stringify(convertTrainingRecord(record, schema));
  if (schema !== 'sharegpt')
    throw new Error('A ShareGPT record can only be serialized as sharegpt.');
  return JSON.stringify({
    id: record.id,
    conversations: record.conversations,
    metadata: record.metadata,
  });
}
