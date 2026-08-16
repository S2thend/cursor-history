import { canonicalJsonV1 } from '../session-identity.js';
import type { StoreRawContentBlockEvidence } from './types.js';

const INLINE_ATTACHMENT_TYPES = new Set([
  'attachment',
  'code',
  'code_block',
  'document',
  'file',
  'image',
  'inline_attachment',
]);

const INLINE_PAYLOAD_FIELDS = ['base64', 'bytes', 'code', 'content', 'data', 'text'] as const;
const PROJECTED_ATTACHMENT_FENCE = /\n```cursor_attachment_v1\n([A-Za-z0-9+/]+={0,2})\n```\n/g;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

/** Retain a detached, immutable copy of source-native content-block evidence. */
export function retainRawContentBlock(
  raw: unknown,
  disposition: StoreRawContentBlockEvidence['disposition'],
  representation: StoreRawContentBlockEvidence['representation']
): StoreRawContentBlockEvidence {
  return {
    disposition,
    representation,
    raw: deepFreeze(structuredClone(raw)),
  };
}

/**
 * Project a wholly inline attachment block into a consumed message-content
 * field. The canonical JSON is base64 encoded so arbitrary backticks/newlines
 * cannot terminate the fixed fence. A locator-only block is deliberately not
 * projected: resolving its target would require external I/O and the source
 * must remain partial instead.
 */
export function projectInlineAttachment(raw: Readonly<Record<string, unknown>>): string | null {
  const type = raw['type'];
  if (typeof type !== 'string' || !INLINE_ATTACHMENT_TYPES.has(type)) return null;
  if (!INLINE_PAYLOAD_FIELDS.some((field) => typeof raw[field] === 'string')) return null;

  const canonical = canonicalJsonV1(raw);
  const encoded = Buffer.from(canonical, 'utf8').toString('base64');
  return `\n\`\`\`cursor_attachment_v1\n${encoded}\n\`\`\`\n`;
}

/** A verified projection split used only for deterministic cross-stack merge. */
export interface InlineAttachmentProjectionSplit {
  baseContent: string;
  encodedAttachments: string[];
}

/**
 * Remove only fences that exactly round-trip through the v1 projector. A user
 * authored lookalike or malformed base64/JSON fence remains ordinary content.
 */
export function splitInlineAttachmentProjections(content: string): InlineAttachmentProjectionSplit {
  const encodedAttachments: string[] = [];
  const baseChunks: string[] = [];
  let cursor = 0;
  PROJECTED_ATTACHMENT_FENCE.lastIndex = 0;
  for (const match of content.matchAll(PROJECTED_ATTACHMENT_FENCE)) {
    const full = match[0];
    const encoded = match[1];
    const index = match.index;
    if (encoded === undefined || index === undefined) continue;
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const raw = JSON.parse(decoded) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      if (canonicalJsonV1(raw) !== decoded) continue;
      if (projectInlineAttachment(raw as Record<string, unknown>) !== full) continue;
    } catch {
      continue;
    }
    baseChunks.push(content.slice(cursor, index));
    cursor = index + full.length;
    encodedAttachments.push(encoded);
  }
  baseChunks.push(content.slice(cursor));
  return { baseContent: baseChunks.join(''), encodedAttachments };
}

/** Rebuild consumed message content from a base and verified v1 payloads. */
export function renderInlineAttachmentProjections(
  baseContent: string,
  encodedAttachments: readonly string[]
): string {
  return `${baseContent}${encodedAttachments
    .map((encoded) => `\n\`\`\`cursor_attachment_v1\n${encoded}\n\`\`\`\n`)
    .join('')}`;
}
