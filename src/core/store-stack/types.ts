/**
 * Internal types for the Cursor Store stack backend (src/core/store-stack/).
 * See specs/015-cursor-store-stack/data-model.md.
 */
import type { Message, TranscriptState } from '../types.js';
export type { TranscriptState } from '../types.js';

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
 * Explicit transcript parse state. Decoupled from Store DB completeness —
 * message count is no longer used as a proxy for transcript presence.
 *
 * - `parsed`: transcript messages are authoritative.
 * - `partial`: usable messages were found, but one or more non-empty lines
 *   were malformed or unsupported; a Store DB may provide a safer fallback.
 * - `empty`: file readable and well-formed but contains no message/error lines.
 * - `error-only`: only provider-error lines were present (no messages).
 * - `unsupported`: lines were present but none recognized as messages or errors.
 * - `missing`: the transcript file does not exist.
 * - `unreadable`: the file exists but could not be read (permissions, I/O).
 *
 * Any non-`parsed` state may fall back to `store.db` when available, while
 * retaining this state for provenance.
 */
/**
 * A discovered Store-stack session, prior to unification into `ChatSession`.
 */
export interface StoreSession {
  /** Session UUID = transcript filename = chats/<hash>/<uuid>/ dir name. */
  id: string;
  /** Absolute workspace path (from meta.json.cwd) if available. */
  workspacePath?: string;
  /** Session title (store.db meta.name when available, else null). */
  title: string | null;
  createdAt: Date;
  /**
   * Session-level last-update time. From a valid `updatedAtMs` when
   * present, otherwise `createdAt`. Session metadata only — never copied onto
   * messages.
   */
  lastUpdatedAt: Date;
  messages: Message[];
  /**
   * Backing data for `messages`:
   * - `'transcript'`: authoritative transcript JSONL.
   * - `'store-complete'` / `'store-partial'`: store.db fallback (no usable
   *   transcript), full or partial parse.
   * - `'store'`: legacy alias.
   */
  source: 'transcript' | 'store' | 'store-complete' | 'store-partial';
  /** Explicit transcript parse state, retained even when store.db backs messages. */
  transcriptState: TranscriptState;
  /** Path to store.db if present (deep-parse target / fallback). */
  storeDbPath?: string;
  /** Debug: raw on-disk locations. */
  chatDir?: string;
  transcriptPath?: string;
}
