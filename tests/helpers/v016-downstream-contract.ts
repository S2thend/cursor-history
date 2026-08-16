/**
 * Generic v0.16 downstream compatibility model.
 *
 * This is deliberately not an implementation of vibe-history or any other
 * consumer. It models only the public key/binding and complete-view properties
 * that cursor-history promises to legacy consumers. Exact third-party behavior
 * is certified separately against an owner-authorized external checkout.
 */
import { createHash } from 'node:crypto';
import type { Session } from '../../src/lib/types.js';

export interface LegacyToolBinding {
  key: string;
  name: string;
  params: Record<string, unknown>;
  result?: string;
  error?: string;
  status: 'completed' | 'cancelled' | 'error';
}

export interface LegacyMessageBinding {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  parentKey?: string;
  model?: string;
  thinking?: string;
  tokenUsage?: Record<string, number>;
  tools: LegacyToolBinding[];
}

export interface LegacyDownstreamView {
  sessionKey: string;
  workspace: string;
  timestamp: string;
  source?: string;
  resolvedSource?: string;
  messages: LegacyMessageBinding[];
}

export interface GenericDownstreamState {
  view?: LegacyDownstreamView;
  fingerprint?: string;
}

export interface GenericApplyResult {
  action: 'added' | 'replaced' | 'skipped';
  recordsWritten: number;
}

function messageKey(sessionKey: string, sourceId: string | undefined, ordinal: number): string {
  return sourceId ? `${sessionKey}:${sourceId}` : `${sessionKey}:msg:${ordinal}`;
}

/** Project only legacy public keys and their cursor-history-owned bindings. */
export function projectV016DownstreamContract(session: Session): LegacyDownstreamView {
  const sessionKey = `cursor:${session.id}`;
  const idMap = new Map(
    session.messages.flatMap((message, ordinal) =>
      message.id ? [[message.id, messageKey(sessionKey, message.id, ordinal)] as const] : []
    )
  );
  return {
    sessionKey,
    workspace: session.workspace,
    timestamp: session.timestamp,
    ...(session.source ? { source: session.source } : {}),
    ...(session.resolvedSource ? { resolvedSource: session.resolvedSource } : {}),
    messages: session.messages.map((message, ordinal) => {
      const key = messageKey(sessionKey, message.id, ordinal);
      return {
        key,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        ...(message.parentMessageId
          ? { parentKey: idMap.get(message.parentMessageId) ?? message.parentMessageId }
          : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.thinking ? { thinking: message.thinking } : {}),
        ...(message.tokenUsage ? { tokenUsage: { ...message.tokenUsage } } : {}),
        tools: (message.toolCalls ?? []).map((tool, toolOrdinal) => ({
          key: `${key}:tc:${toolOrdinal}`,
          name: tool.name,
          params: structuredClone(tool.params ?? {}),
          ...(tool.result !== undefined ? { result: tool.result } : {}),
          ...(tool.error !== undefined ? { error: tool.error } : {}),
          status: tool.status,
        })),
      };
    }),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

/** Internal test fingerprint; not a third-party digest contract. */
export function fingerprintV016DownstreamContract(view: LegacyDownstreamView): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(view)))
    .digest('hex');
}

/**
 * Apply a generic atomic complete-view contract. Callers state completeness
 * explicitly; this function does not emulate any consumer's source policy.
 */
export function applyGenericCompleteView(
  state: GenericDownstreamState,
  session: Session,
  completeness: 'complete' | 'degraded'
): GenericApplyResult {
  if (completeness === 'degraded') return { action: 'skipped', recordsWritten: 0 };
  const view = projectV016DownstreamContract(session);
  const fingerprint = fingerprintV016DownstreamContract(view);
  if (state.fingerprint === fingerprint) return { action: 'skipped', recordsWritten: 0 };
  const action = state.view ? 'replaced' : 'added';
  state.view = structuredClone(view);
  state.fingerprint = fingerprint;
  return { action, recordsWritten: view.messages.length };
}
