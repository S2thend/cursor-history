/**
 * Internal types for the Cursor Store stack backend (src/core/store-stack/).
 * See specs/015-cursor-store-stack/data-model.md.
 */
import type {
  Message,
  ResolvedSource,
  SessionDiagnostic,
  SessionResolution,
  TranscriptState,
} from '../types.js';
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
 * Explicit transcript parse state. Decoupled from Store DB completeness and
 * from whether the transcript ends up supplying the session's messages: under
 * P15 `store.db` is the primary message source and the transcript is a fallback.
 *
 * - `parsed`: the transcript yielded usable messages (used only when store.db
 *   is absent, unreadable, or yields no messages).
 * - `partial`: usable messages were found alongside malformed/unsupported lines;
 *   those usable messages are a fallback source as above.
 * - `empty`: file readable and well-formed but contains no message/error lines.
 * - `error-only`: only provider-error lines were present (no messages).
 * - `unsupported`: lines were present but none recognized as messages or errors.
 * - `missing`: the transcript file does not exist.
 * - `unreadable`: the file exists but could not be read (permissions, I/O).
 *
 * `transcriptState` is retained for provenance in every case, including when
 * `store.db` supplies the final messages.
 */
/**
 * Internal Store DB parse outcome (P15). Diagnostics-only — never serialized.
 * `store.db` is the primary message source; this records how its parse fared.
 *
 * - `missing`:  no store.db path is present for the session.
 * - `failed`:   the database could not be opened or parsed (any exception is
 *               collapsed to `failed` in this increment).
 * - `empty`:    parsed successfully but yielded zero recoverable messages.
 * - `partial`:  parsed with recoverable messages, but at least one reachable
 *               leaf/blob was missing or malformed, or an orphan tool result
 *               was present.
 * - `complete`: parsed and every reachable message shape was handled.
 */
export type StoreDbState = 'missing' | 'failed' | 'empty' | 'partial' | 'complete';

/** Metadata-only expectation fixed before any Store conversation payload read. */
export type StoreDbExpectation = 'expected' | 'not-expected' | 'unknown';

/** Source-native evidence retained before merge/output order can change. */
export type StoreMessageIdentityEvidence =
  | {
      representation: 'db';
      leafHash: string;
      /** Zero-based order of the reachable message leaf in the active Merkle traversal. */
      traversalOrdinal: number;
    }
  | {
      representation: 'transcript';
      /** One-based physical nonempty JSONL record number. */
      sourceLine: number;
      role: string;
      content: string;
      toolActivity: readonly unknown[];
      sourceRelationships: Readonly<Record<string, unknown>>;
    };

/**
 * Internal role the transcript played in resolving a session's messages (P15).
 * Diagnostics-only — never serialized.
 *
 * - `unused`:      the transcript did not supply messages; store.db supplied
 *                  them, or the session has only metadata/empty DB state.
 * - `fallback`:    store.db was present but unreadable or empty, so the
 *                  transcript's messages filled the gap (DB metadata may still
 *                  contribute title/createdAt).
 * - `only-source`: no store.db exists and a transcript file is the only
 *                  available Store conversation source.
 */
export type TranscriptUse = 'unused' | 'fallback' | 'only-source';

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
  /** Identity inputs aligned one-to-one with `messages` in source-native order. */
  messageIdentityEvidence: StoreMessageIdentityEvidence[];
  /**
   * Backing data for `messages` (P15 — `store.db` is the primary source):
   * - `'store-complete'` / `'store-partial'`: `store.db` supplied the messages
   *   (primary source), fully or partially parsed.
   * - `'transcript'`: the transcript supplied the messages — the sole source
   *   when no `store.db` exists, or the fallback when `store.db` is unreadable
   *   or yields no messages (`store.db` metadata may still contribute
   *   title/createdAt).
   * - `'store'`: metadata-only legacy alias (no `store.db` and no transcript).
   */
  source:
    'global' | 'workspace-fallback' | 'transcript' | 'store' | 'store-complete' | 'store-partial';
  /** Actual selected Store representation; `source` remains fidelity-only. */
  resolvedSource?: Exclude<ResolvedSource, 'composer' | 'merged'>;
  /** Complete/partial selection state and stable reason codes. */
  resolution?: SessionResolution;
  /** Metadata-only DB expectation fixed before payload hydration. */
  storeDbExpectation?: StoreDbExpectation;
  /** Safe typed parser diagnostics retained for an operation-level observer. */
  diagnostics?: SessionDiagnostic[];
  /** Explicit transcript parse state, retained even when store.db backs messages. */
  transcriptState: TranscriptState;
  /** Path to store.db if present (deep-parse target / fallback). */
  storeDbPath?: string;
  /** Debug: raw on-disk locations. */
  chatDir?: string;
  transcriptPath?: string;
}
