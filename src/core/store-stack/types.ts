/**
 * Internal types for the Cursor Store stack backend (src/core/store-stack/).
 * See specs/015-cursor-store-stack/data-model.md.
 */
import type { Message } from '../types.js';

/**
 * A content part within a transcript line's `message.content` array.
 * Only `text` and `tool_use` are observed in Cursor 3.x agent transcripts;
 * unknown part types are ignored by the parser (forward compatibility,
 * constitution principle V).
 */
export type TranscriptPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input?: Record<string, unknown> };

/** A single line of a Cursor agent transcript JSONL (role-nested form). */
export interface TranscriptMessageLine {
  role: 'user' | 'assistant';
  message: { content: TranscriptPart[] };
}

/** Error line (provider error), skipped by the parser. */
export interface TranscriptErrorLine {
  type: 'error';
  error: string;
}

export type TranscriptLine = TranscriptMessageLine | TranscriptErrorLine;

/**
 * `meta.json` sidecar beside store.db.
 * Legacy `chats/` variant (WSL-verified): {schemaVersion, createdAtMs,
 * hasConversation, updatedAtMs, cwd}. ACP variant: {schemaVersion, cwd, title}.
 */
export interface StoreMetaJson {
  schemaVersion?: number;
  createdAtMs?: number;
  hasConversation?: boolean;
  updatedAtMs?: number;
  cwd?: string;
  title?: string;
}

/**
 * A discovered Store-stack session, prior to unification into `ChatSession`.
 * P1: `source` is always `'transcript'` (store.db deep parse is P2).
 */
export interface StoreSession {
  /** Session UUID = transcript filename = chats/<hash>/<uuid>/ dir name. */
  id: string;
  /** Absolute workspace path (from meta.json.cwd) if available. */
  workspacePath?: string;
  /** Session title (null in P1; store.db meta.name in P2). */
  title: string | null;
  createdAt: Date;
  messages: Message[];
  /**
   * `'transcript'` (P1; authoritative messages from transcript JSONL),
   * `'store-complete'` / `'store-partial'` (P2 store.db, no transcript),
   * `'store'` legacy alias.
   */
  source: 'transcript' | 'store' | 'store-complete' | 'store-partial';
  /** Path to store.db if present (P2 parsing target). */
  storeDbPath?: string;
  /** Debug: raw on-disk locations. */
  chatDir?: string;
  transcriptPath?: string;
}
