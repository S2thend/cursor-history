/**
 * Test-only port of the released cursor-history v0.16 Composer projection.
 *
 * This oracle is intentionally independent from current production parsers. Its
 * source commit/blob inventory is locked in projector-manifest.json and checked
 * by v016-projector-provenance.test.ts.
 */

export const V016_PROJECTOR_PROVENANCE = {
  schemaVersion: 1,
  tag: 'v0.16.0',
  commit: 'e8a7abf8cea3419a9dda911e174a05f82a9b260e',
  sources: [
    {
      path: 'src/core/storage.ts',
      gitBlob: '9b593c764e3ffb2f2c597bacff731a51009e5179',
    },
    {
      path: 'src/core/parser.ts',
      gitBlob: '110a31865caa49a2c8b15707dc7535761ce3dbf6',
    },
    {
      path: 'src/core/types.ts',
      gitBlob: 'ed6352d26831e0744aa9da5ff1be7a58f8e9ced4',
    },
  ],
} as const;

export interface V016CodeBlock {
  language: string | null;
  content: string;
  startLine: number;
}

export interface V016ToolCall {
  name: string;
  status: 'completed' | 'cancelled' | 'error';
  params?: Record<string, unknown>;
  result?: string;
  error?: string;
  files?: string[];
}

export interface V016Message {
  id: string | null;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  codeBlocks: V016CodeBlock[];
  toolCalls?: V016ToolCall[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
  model?: string;
  durationMs?: number;
  metadata?: { corrupted?: boolean; bubbleType?: number };
}

export interface V016ProjectedSession {
  id: string;
  index: number;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  messageCount: number;
  messages: V016Message[];
  workspaceId: string;
  source: 'global' | 'workspace-fallback';
  activeBranchBubbleIds?: string[];
}

export interface V016BubbleRow {
  rowid: number;
  key: string;
  value: string;
}

export interface V016GlobalProjectionInput {
  id: string;
  title: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  bubbleRows: readonly V016BubbleRow[];
  composerDataValue?: string;
  workspaceId?: string;
}

interface ToolFormerData {
  name?: string;
  params?: string;
  rawArgs?: string;
  result?: string;
  status?: string;
  additionalData?: { status?: string; userDecision?: string };
}

interface RawBubbleData {
  type?: number;
  bubbleId?: string;
  createdAt?: string;
  text?: unknown;
  content?: unknown;
  finalText?: unknown;
  message?: unknown;
  markdown?: unknown;
  textDescription?: unknown;
  thinking?: { text?: string };
  codeBlocks?: Array<{ content?: unknown; languageId?: string }>;
  toolFormerData?: ToolFormerData;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  usage?: { input_tokens?: number; output_tokens?: number };
  modelInfo?: { modelName?: string };
  timingInfo?: {
    clientStartTime?: number;
    clientEndTime?: number;
    clientRpcSendTime?: number;
    clientSettleTime?: number;
  };
  [key: string]: unknown;
}

const MIN_VALID_UNIX_MS = 1_000_000_000_000;

function getBubbleRowId(rowKey: string): string | null {
  return rowKey.split(':').pop() ?? null;
}

function getParam(params: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!params) return '';
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return '';
}

function parseToolParams(
  paramsText?: string,
  rawArgsText?: string
): Record<string, unknown> | undefined {
  const rawText = paramsText ?? rawArgsText;
  if (typeof rawText !== 'string' || rawText.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // v0.16 preserved malformed structured input below.
  }
  return { _raw: rawText };
}

function extractToolCalls(data: RawBubbleData): V016ToolCall[] | undefined {
  const toolData = data.toolFormerData;
  const name = typeof toolData?.name === 'string' ? toolData.name.trim() : '';
  if (!name || !toolData) return undefined;
  const params = parseToolParams(toolData.params, toolData.rawArgs);
  const statuses = [toolData.additionalData?.status, toolData.status];
  const status: V016ToolCall['status'] = statuses.includes('error')
    ? 'error'
    : statuses.includes('cancelled')
      ? 'cancelled'
      : 'completed';
  const toolCall: V016ToolCall = { name, status };
  if (params) toolCall.params = params;
  const files = [
    getParam(params, 'targetFile', 'file', 'filePath', 'relativeWorkspacePath'),
    getParam(params, 'path'),
    getParam(params, 'targetDirectory', 'directory'),
  ].filter((value) => value.length > 0);
  if (files.length > 0) toolCall.files = [...new Set(files)];

  const result =
    typeof toolData.result === 'string' && toolData.result.trim().length > 0
      ? toolData.result
      : undefined;
  if (result !== undefined) {
    if (status === 'error') toolCall.error = extractToolError(result);
    else if (status === 'completed') toolCall.result = result;
  }
  return [toolCall];
}

function extractToolError(result: string): string {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    for (const key of ['error', 'message', 'stderr', 'output', 'resultForModel']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
  } catch {
    // v0.16 fell back to the raw result.
  }
  return result;
}

function extractBubbleText(data: RawBubbleData): string {
  const blocks = Array.isArray(data.codeBlocks) ? data.codeBlocks : [];
  const codeBlockParts = blocks.flatMap((block) => {
    if (typeof block.content !== 'string' || block.content.trim().length === 0) return [];
    return block.languageId
      ? [`\`\`\`${block.languageId}\n${block.content}\n\`\`\``]
      : [block.content];
  });

  const tool = data.toolFormerData;
  if (tool?.name) {
    const params = parseToolParams(tool.params, tool.rawArgs);
    const detail = params === undefined ? '' : `\nParams: ${JSON.stringify(params)}`;
    const result =
      typeof tool.result === 'string' && tool.result.length > 0 ? `\n${tool.result}` : '';
    return `[Tool: ${tool.name}]${detail}${result}`;
  }

  if (data.type === 2 && typeof data.text === 'string' && data.text.trim().length > 0) {
    return codeBlockParts.length > 0 ? `${data.text}\n\n${codeBlockParts.join('\n\n')}` : data.text;
  }
  if (data.type === 2 && typeof data.thinking?.text === 'string' && data.thinking.text.trim()) {
    return `[Thinking]\n${data.thinking.text}`;
  }
  if (codeBlockParts.length > 0) return codeBlockParts.join('\n\n');
  for (const key of ['text', 'content', 'finalText', 'message', 'markdown', 'textDescription']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  if (typeof data.thinking?.text === 'string' && data.thinking.text.trim()) {
    return `[Thinking]\n${data.thinking.text}`;
  }
  return '';
}

function extractTimestamp(data: RawBubbleData): Date | null {
  if (data.createdAt) return new Date(data.createdAt);
  const timing = data.timingInfo;
  for (const value of [
    timing?.clientRpcSendTime,
    timing?.clientSettleTime,
    timing?.clientEndTime,
  ]) {
    if (typeof value === 'number' && value > MIN_VALID_UNIX_MS) return new Date(value);
  }
  return null;
}

function extractTokenUsage(
  data: RawBubbleData
): { inputTokens: number; outputTokens: number } | undefined {
  if (data.tokenCount) {
    const inputTokens = data.tokenCount.inputTokens ?? 0;
    const outputTokens = data.tokenCount.outputTokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };
  }
  if (data.usage) {
    const inputTokens = data.usage.input_tokens ?? 0;
    const outputTokens = data.usage.output_tokens ?? 0;
    if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };
  }
  return undefined;
}

function mapBubbleToMessage(row: V016BubbleRow): Omit<V016Message, 'timestamp'> & {
  timestamp: Date | null;
} {
  let data: RawBubbleData;
  try {
    data = JSON.parse(row.value) as RawBubbleData;
  } catch {
    return {
      id: getBubbleRowId(row.key),
      role: 'assistant',
      content: '[corrupted message]',
      timestamp: null,
      codeBlocks: [],
      metadata: { corrupted: true },
    };
  }

  try {
    const content = extractBubbleText(data);
    const message: Omit<V016Message, 'timestamp'> & { timestamp: Date | null } = {
      id: data.bubbleId ?? getBubbleRowId(row.key),
      role: data.type === 2 ? 'assistant' : 'user',
      content: content.length > 0 ? content : '[empty message]',
      timestamp: extractTimestamp(data),
      codeBlocks: [],
    };
    if (typeof data.type === 'number') message.metadata = { bubbleType: data.type };
    const toolCalls = extractToolCalls(data);
    if (toolCalls) message.toolCalls = toolCalls;
    const tokenUsage = extractTokenUsage(data);
    if (tokenUsage) message.tokenUsage = tokenUsage;
    const model = data.modelInfo?.modelName;
    if (typeof model === 'string' && model.trim()) message.model = model;
    const start = data.timingInfo?.clientStartTime;
    const end = data.timingInfo?.clientEndTime;
    if (typeof start === 'number' && typeof end === 'number' && end - start > 0) {
      message.durationMs = end - start;
    }
    return message;
  } catch {
    return {
      id: getBubbleRowId(row.key),
      role: 'assistant',
      content: '[corrupted message]',
      timestamp: null,
      codeBlocks: [],
      metadata: { corrupted: true },
    };
  }
}

function fillTimestampGaps(
  messages: Array<{ timestamp: Date | null }>,
  sessionCreatedAt?: Date
): void {
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.timestamp !== null) continue;
    let found = false;
    for (let next = index + 1; next < messages.length; next++) {
      if (messages[next]!.timestamp !== null) {
        messages[index]!.timestamp = messages[next]!.timestamp;
        found = true;
        break;
      }
    }
    if (found) continue;
    for (let previous = index - 1; previous >= 0; previous--) {
      if (messages[previous]!.timestamp !== null) {
        messages[index]!.timestamp = messages[previous]!.timestamp;
        break;
      }
    }
  }
  const fallback = sessionCreatedAt ?? new Date();
  for (const message of messages) {
    if (message.timestamp === null) message.timestamp = fallback;
  }
}

function extractActiveBranchBubbleIds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const data = JSON.parse(value) as { fullConversationHeadersOnly?: unknown };
    if (!Array.isArray(data.fullConversationHeadersOnly)) return undefined;
    const ids = data.fullConversationHeadersOnly.flatMap((header) => {
      if (!header || typeof header !== 'object') return [];
      const id = (header as { bubbleId?: unknown }).bubbleId;
      return typeof id === 'string' && id.trim().length > 0 ? [id] : [];
    });
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

export function projectV016GlobalSession(input: V016GlobalProjectionInput): V016ProjectedSession {
  const rows = [...input.bubbleRows].sort((left, right) => left.rowid - right.rowid);
  const messages = rows.map(mapBubbleToMessage);
  fillTimestampGaps(messages, input.createdAt);
  const session: V016ProjectedSession = {
    id: input.id,
    index: 0,
    title: input.title,
    createdAt: input.createdAt,
    lastUpdatedAt: input.lastUpdatedAt,
    messageCount: messages.length,
    messages: messages as V016Message[],
    workspaceId: input.workspaceId ?? '',
    source: 'global',
  };
  const branch = extractActiveBranchBubbleIds(input.composerDataValue);
  if (branch) session.activeBranchBubbleIds = branch;
  return session;
}

interface RawMessage {
  id?: string;
  role?: string;
  type?: string;
  content?: string;
  text?: string;
  timestamp?: number;
  createdAt?: number;
}

interface RawSession {
  id?: string;
  title?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  lastSendTime?: number;
  messages?: RawMessage[];
  bubbles?: RawMessage[];
}

interface ComposerHead {
  composerId?: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
}

interface ComposerData {
  allComposers?: ComposerHead[];
  selectedComposerIds?: string[];
}

interface GenerationEntry {
  unixMs?: number;
  generationUUID?: string;
  textDescription?: string;
}

export interface V016WorkspaceBundle {
  composerData?: string;
  prompts?: string;
  generations?: string;
}

function extractCodeBlocks(content: string): V016CodeBlock[] {
  const blocks: V016CodeBlock[] = [];
  const regex = /^```(\w*)\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const before = content.slice(0, match.index);
    blocks.push({
      language: match[1] || null,
      content: (match[2] ?? '').trimEnd(),
      startLine: before.split('\n').length - 1,
    });
  }
  return blocks;
}

function normalizeRole(role: string): 'user' | 'assistant' {
  const lower = role.toLowerCase();
  return lower === 'assistant' || lower === 'ai' || lower === 'bot' || lower === 'system'
    ? 'assistant'
    : 'user';
}

function parseMessage(raw: RawMessage): V016Message | null {
  const content = raw.content ?? raw.text ?? '';
  if (!content && !raw.role && !raw.type) return null;
  const timestamp = raw.timestamp
    ? new Date(raw.timestamp)
    : raw.createdAt
      ? new Date(raw.createdAt)
      : new Date();
  return {
    id: raw.id ?? null,
    role: normalizeRole(raw.role ?? raw.type ?? 'user'),
    content,
    timestamp,
    codeBlocks: extractCodeBlocks(content),
  };
}

function deriveTitle(messages: readonly V016Message[]): string | null {
  const first = messages.find((message) => message.role === 'user');
  if (!first) return null;
  const firstLine = first.content.split('\n')[0] ?? '';
  if (firstLine.length <= 50) return firstLine || null;
  return `${firstLine.slice(0, 47)}...`;
}

function parseLegacySession(raw: RawSession): V016ProjectedSession | null {
  if (!raw.id) return null;
  const messages = (raw.messages ?? raw.bubbles ?? [])
    .map(parseMessage)
    .filter((message): message is V016Message => message !== null);
  if (messages.length === 0) return null;
  const createdAt = raw.createdAt
    ? new Date(raw.createdAt)
    : (messages[0]?.timestamp ?? new Date());
  const lastUpdatedAt = raw.lastUpdatedAt
    ? new Date(raw.lastUpdatedAt)
    : raw.lastSendTime
      ? new Date(raw.lastSendTime)
      : (messages[messages.length - 1]?.timestamp ?? createdAt);
  return {
    id: raw.id,
    index: 0,
    title: raw.title ?? deriveTitle(messages),
    createdAt,
    lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: '',
    source: 'workspace-fallback',
  };
}

function isComposerData(value: unknown): value is ComposerData {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'allComposers' in value;
}

function isComposerArray(value: unknown): value is ComposerHead[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        ('composerId' in item || 'name' in item || 'unifiedMode' in item)
    )
  );
}

function parseComposerFormat(
  data: ComposerData,
  bundle: V016WorkspaceBundle | undefined
): V016ProjectedSession[] {
  let generations: GenerationEntry[] = [];
  if (bundle?.generations) {
    try {
      generations = JSON.parse(bundle.generations) as GenerationEntry[];
    } catch {
      // v0.16 ignored malformed generations.
    }
  }
  const sorted = [...generations].sort((left, right) => (left.unixMs ?? 0) - (right.unixMs ?? 0));
  const sessions: V016ProjectedSession[] = [];
  for (const composer of data.allComposers ?? []) {
    if (!composer.composerId) continue;
    const createdAt = composer.createdAt ? new Date(composer.createdAt) : new Date();
    const lastUpdatedAt = composer.lastUpdatedAt ? new Date(composer.lastUpdatedAt) : createdAt;
    const messages: V016Message[] = [];
    if (composer.name) {
      messages.push({
        id: null,
        role: 'user',
        content: composer.name,
        timestamp: createdAt,
        codeBlocks: [],
      });
    }
    const sessionStart = composer.createdAt ?? 0;
    const sessionEnd = composer.lastUpdatedAt ?? Date.now();
    for (const generation of sorted) {
      if (
        generation.unixMs &&
        generation.unixMs >= sessionStart &&
        generation.unixMs <= sessionEnd + 60_000 &&
        generation.textDescription
      ) {
        messages.push({
          id: generation.generationUUID ?? null,
          role: 'user',
          content: generation.textDescription,
          timestamp: new Date(generation.unixMs),
          codeBlocks: extractCodeBlocks(generation.textDescription),
        });
      }
    }
    const resolvedMessages =
      messages.length > 0
        ? messages
        : [
            {
              id: null,
              role: 'user' as const,
              content: composer.name ?? '(Empty session)',
              timestamp: createdAt,
              codeBlocks: [],
            },
          ];
    sessions.push({
      id: composer.composerId,
      index: 0,
      title: composer.name ?? null,
      createdAt,
      lastUpdatedAt,
      messageCount: messages.length || 1,
      messages: resolvedMessages,
      workspaceId: '',
      source: 'workspace-fallback',
    });
  }
  return sessions;
}

export function projectV016WorkspaceSessions(
  jsonString: string,
  bundle?: V016WorkspaceBundle
): V016ProjectedSession[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonString) as unknown;
  } catch {
    return [];
  }
  if (isComposerData(data)) return parseComposerFormat(data, bundle);
  if (isComposerArray(data)) return parseComposerFormat({ allComposers: data }, bundle);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const raw = data as { chatSessions?: RawSession[]; tabs?: RawSession[] };
  return (raw.chatSessions ?? raw.tabs ?? [])
    .map(parseLegacySession)
    .filter((session): session is V016ProjectedSession => session !== null);
}
