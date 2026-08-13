#!/usr/bin/env -S node --no-warnings --experimental-strip-types

/**
 * Deterministic generator for the wholly synthetic v0.16 compatibility set.
 *
 * The generator has no discovery inputs: all identity/content values are
 * constants below and the only readable files are artifacts it just wrote
 * inside the caller-supplied output directory.
 */

import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const V016_FIXTURE_SCHEMA = 'cursor-history-v016-synthetic/v1' as const;
export const V016_SYNTHETIC_SESSION_ID = '00000000-0016-4016-8016-000000000016' as const;
export const V016_SYNTHETIC_WORKSPACE = '/fixture/v016/project' as const;
export const V016_SYNTHETIC_HOSTNAME = 'fixture-host' as const;

const CREATED_AT = '2024-01-16T00:00:00.000Z';
const UPDATED_AT = '2024-01-16T00:01:00.000Z';
const PROJECTOR_TAG = 'v0.16.0';
const PROJECTOR_COMMIT = 'e8a7abf8cea3419a9dda911e174a05f82a9b260e';
// SQLite writes its library version into header bytes 96..99. That value is
// not logical database content and otherwise makes byte hashes drift whenever
// the lockfile upgrades better-sqlite3's bundled SQLite patch release.
const PINNED_SQLITE_HEADER_VERSION = 3_051_001;

const ARTIFACT_NAMES = [
  'composer-global-state.vscdb',
  'workspace-fallback.json',
  'tagged-output.json',
  'merged-store-source.json',
] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalJson(value: unknown, arrayElement = false): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Synthetic canonical numbers must be finite.');
    return JSON.stringify(value);
  }
  if (value === undefined) {
    if (arrayElement) return 'null';
    throw new TypeError('Undefined is not a top-level canonical value.');
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, true)).join(',')}]`;
  }
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical value.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCodePoints)
    .flatMap((key) =>
      record[key] === undefined
        ? []
        : [`${JSON.stringify(key)}:${canonicalJson(record[key], false)}`]
    )
    .join(',')}}`;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const COLLISION_STORE_RECORD = Object.freeze({
  role: 'assistant',
  content: 'Synthetic Store collision payload.',
  toolActivity: Object.freeze([]),
  sourceRelationships: Object.freeze([]),
});
const COLLISION_FINGERPRINT = sha256(canonicalJson(COLLISION_STORE_RECORD));
export const V016_SYNTHETIC_COLLISION_ID =
  `store:v1:transcript:${COLLISION_FINGERPRINT}:1` as const;

const RAW_BUBBLES = Object.freeze([
  {
    rowid: 10,
    key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:native-user-016`,
    value: {
      type: 1,
      bubbleId: 'native-user-016',
      createdAt: '2024-01-16T00:00:01.000Z',
      text: 'Synthetic question alpha.',
    },
  },
  {
    rowid: 15,
    key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:synthetic-collision-row`,
    value: {
      type: 2,
      bubbleId: V016_SYNTHETIC_COLLISION_ID,
      createdAt: '2024-01-16T00:00:02.000Z',
      text: 'Composer owns the synthetic collision identity.',
    },
  },
  {
    rowid: 20,
    key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:fallback-assistant-016`,
    value: {
      type: 2,
      createdAt: '2024-01-16T00:00:03.000Z',
      text: 'Synthetic answer beta.\n```ts\nconst fixtureValue = 16;\n```',
    },
  },
  {
    rowid: 25,
    key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:synthetic-null-payload-016`,
    value: null,
  },
  {
    rowid: 30,
    key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:native-tool-read-016`,
    value: {
      type: 2,
      bubbleId: 'native-tool-read-016',
      createdAt: '2024-01-16T00:00:04.000Z',
      toolFormerData: {
        name: 'read_file',
        params: '{"path":"/fixture/v016/project/synthetic.ts"}',
        result: 'synthetic read result',
        status: 'completed',
      },
    },
  },
  {
    rowid: 40,
    key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:native-tool-search-016`,
    value: {
      type: 2,
      bubbleId: 'native-tool-search-016',
      createdAt: '2024-01-16T00:00:05.000Z',
      toolFormerData: {
        name: 'search',
        params: '{"query":"synthetic-token","path":"/fixture/v016/project"}',
        result: 'synthetic search result',
        status: 'completed',
      },
    },
  },
  {
    rowid: 50,
    key: `bubbleId:${V016_SYNTHETIC_SESSION_ID}:empty-id-row-016`,
    value: {
      type: 1,
      bubbleId: '',
      createdAt: '2024-01-16T00:00:06.000Z',
      text: 'Synthetic empty-ID compatibility turn.',
    },
  },
]);

const COMPOSER_DATA = Object.freeze({
  name: 'Synthetic v0.16 Composer session',
  createdAt: Date.parse(CREATED_AT),
  lastUpdatedAt: Date.parse(UPDATED_AT),
  workspaceIdentifier: { uri: { fsPath: V016_SYNTHETIC_WORKSPACE } },
  fullConversationHeadersOnly: [
    { bubbleId: 'native-user-016' },
    { bubbleId: V016_SYNTHETIC_COLLISION_ID },
    { bubbleId: 'fallback-assistant-016' },
    { bubbleId: 'synthetic-null-payload-016' },
    { bubbleId: 'native-tool-read-016' },
    { bubbleId: 'native-tool-search-016' },
    { bubbleId: '' },
  ],
});

const WORKSPACE_FALLBACK = Object.freeze({
  schemaVersion: 1,
  fixtureKind: 'v0.16-workspace-fallback-raw-json',
  tabs: [
    {
      id: V016_SYNTHETIC_SESSION_ID,
      title: 'Synthetic workspace fallback',
      createdAt: Date.parse(CREATED_AT),
      lastUpdatedAt: Date.parse(UPDATED_AT),
      messages: [
        {
          id: 'workspace-native-016',
          role: 'user',
          content: 'Synthetic workspace-native message.',
          timestamp: Date.parse('2024-01-16T00:00:01.000Z'),
        },
        {
          role: 'assistant',
          content: 'Synthetic workspace missing-ID answer.',
          timestamp: Date.parse('2024-01-16T00:00:02.000Z'),
        },
        {
          id: '',
          type: 'ai',
          content: 'Synthetic workspace empty-ID answer.',
          timestamp: Date.parse('2024-01-16T00:00:03.000Z'),
        },
      ],
    },
  ],
});

interface TaggedMessage {
  id: string | null;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  codeBlocks: unknown[];
  metadata?: { bubbleType?: number; corrupted?: boolean };
  toolCalls?: Array<{
    name: string;
    status: 'completed' | 'cancelled' | 'error';
    params?: Record<string, unknown>;
    result?: string;
    files?: string[];
  }>;
}

const TAGGED_GLOBAL_MESSAGES: TaggedMessage[] = [
  {
    id: 'native-user-016',
    role: 'user',
    content: 'Synthetic question alpha.',
    timestamp: '2024-01-16T00:00:01.000Z',
    codeBlocks: [],
    metadata: { bubbleType: 1 },
  },
  {
    id: V016_SYNTHETIC_COLLISION_ID,
    role: 'assistant',
    content: 'Composer owns the synthetic collision identity.',
    timestamp: '2024-01-16T00:00:02.000Z',
    codeBlocks: [],
    metadata: { bubbleType: 2 },
  },
  {
    id: 'fallback-assistant-016',
    role: 'assistant',
    content: 'Synthetic answer beta.\n```ts\nconst fixtureValue = 16;\n```',
    timestamp: '2024-01-16T00:00:03.000Z',
    codeBlocks: [],
    metadata: { bubbleType: 2 },
  },
  {
    id: 'synthetic-null-payload-016',
    role: 'assistant',
    content: '[corrupted message]',
    timestamp: '2024-01-16T00:00:04.000Z',
    codeBlocks: [],
    metadata: { corrupted: true },
  },
  {
    id: 'native-tool-read-016',
    role: 'assistant',
    content: '[Tool: Read File]\nFile: /fixture/v016/project/synthetic.ts\nStatus: ✓ completed',
    timestamp: '2024-01-16T00:00:04.000Z',
    codeBlocks: [],
    metadata: { bubbleType: 2 },
    toolCalls: [
      {
        name: 'read_file',
        status: 'completed',
        params: { path: '/fixture/v016/project/synthetic.ts' },
        result: 'synthetic read result',
        files: ['/fixture/v016/project/synthetic.ts'],
      },
    ],
  },
  {
    id: 'native-tool-search-016',
    role: 'assistant',
    content:
      '[Tool: Search]\nPattern: synthetic-token\nPath: /fixture/v016/project\nStatus: ✓ completed',
    timestamp: '2024-01-16T00:00:05.000Z',
    codeBlocks: [],
    metadata: { bubbleType: 2 },
    toolCalls: [
      {
        name: 'search',
        status: 'completed',
        params: { query: 'synthetic-token', path: '/fixture/v016/project' },
        result: 'synthetic search result',
        files: ['/fixture/v016/project'],
      },
    ],
  },
  {
    id: '',
    role: 'user',
    content: 'Synthetic empty-ID compatibility turn.',
    timestamp: '2024-01-16T00:00:06.000Z',
    codeBlocks: [],
    metadata: { bubbleType: 1 },
  },
];

const TAGGED_WORKSPACE_MESSAGES: TaggedMessage[] = [
  {
    id: 'workspace-native-016',
    role: 'user',
    content: 'Synthetic workspace-native message.',
    timestamp: '2024-01-16T00:00:01.000Z',
    codeBlocks: [],
  },
  {
    id: null,
    role: 'assistant',
    content: 'Synthetic workspace missing-ID answer.',
    timestamp: '2024-01-16T00:00:02.000Z',
    codeBlocks: [],
  },
  {
    id: '',
    role: 'assistant',
    content: 'Synthetic workspace empty-ID answer.',
    timestamp: '2024-01-16T00:00:03.000Z',
    codeBlocks: [],
  },
];

const TAGGED_OUTPUT = Object.freeze({
  schemaVersion: 1,
  oracle: {
    tag: PROJECTOR_TAG,
    commit: PROJECTOR_COMMIT,
    manifest: 'projector-manifest.json',
  },
  globalSession: {
    id: V016_SYNTHETIC_SESSION_ID,
    index: 0,
    title: 'Synthetic v0.16 Composer session',
    createdAt: CREATED_AT,
    lastUpdatedAt: UPDATED_AT,
    messageCount: TAGGED_GLOBAL_MESSAGES.length,
    messages: TAGGED_GLOBAL_MESSAGES,
    workspaceId: 'synthetic-workspace-global-016',
    source: 'global',
    activeBranchBubbleIds: [
      'native-user-016',
      V016_SYNTHETIC_COLLISION_ID,
      'fallback-assistant-016',
      'synthetic-null-payload-016',
      'native-tool-read-016',
      'native-tool-search-016',
    ],
  },
  workspaceFallbackSessions: [
    {
      id: V016_SYNTHETIC_SESSION_ID,
      index: 0,
      title: 'Synthetic workspace fallback',
      createdAt: CREATED_AT,
      lastUpdatedAt: UPDATED_AT,
      messageCount: TAGGED_WORKSPACE_MESSAGES.length,
      messages: TAGGED_WORKSPACE_MESSAGES,
      workspaceId: '',
      source: 'workspace-fallback',
    },
  ],
});

const MERGED_STORE_SOURCE = Object.freeze({
  schemaVersion: 1,
  fixtureKind: 'v0.16-composer-to-complete-merged-input',
  logicalSessionId: V016_SYNTHETIC_SESSION_ID,
  composerProjection: 'tagged-output.json#/globalSession',
  preferredSourceCases: ['composer', 'store'],
  storeRepresentation: 'transcript',
  sourceNativeOrder: [
    {
      label: 'store-only-start',
      placement: 'start',
      role: 'user',
      content: 'Synthetic Store-only turn before Composer history.',
      directTimestamp: '2024-01-15T23:59:59.000Z',
      parentLabel: null,
    },
    {
      label: 'matched-native-user',
      placement: 'matched',
      matchesComposerId: 'native-user-016',
      role: 'user',
      content: 'Synthetic question alpha.',
      enrichment: { source: 'both' },
    },
    {
      label: 'store-only-middle',
      placement: 'middle',
      role: 'assistant',
      content: 'Synthetic Store-only middle turn.',
      directTimestamp: '2024-01-16T00:00:02.500Z',
      parentLabel: 'matched-native-user',
    },
    {
      label: 'matched-tool-read',
      placement: 'matched',
      matchesComposerId: 'native-tool-read-016',
      role: 'assistant',
      content: TAGGED_GLOBAL_MESSAGES[4]!.content,
      appendToolCalls: [
        {
          name: 'synthetic_store_enrichment',
          status: 'completed',
          params: { fixture: true },
          result: 'synthetic enrichment result',
        },
      ],
    },
    {
      label: 'store-collision',
      placement: 'after-middle',
      ...COLLISION_STORE_RECORD,
    },
  ],
  collision: {
    frozenComposerMessageId: V016_SYNTHETIC_COLLISION_ID,
    storeCandidateId: V016_SYNTHETIC_COLLISION_ID,
    expectedAllocatedStoreId: `${V016_SYNTHETIC_COLLISION_ID}:collision:1`,
  },
  relationships: {
    expectedLeafLabel: 'store-collision',
    rewriteParents: true,
    retainComposerBranch: true,
  },
});

export const V016_ALLOWED_PAYLOAD_STRINGS = Object.freeze([
  'Synthetic question alpha.',
  'Composer owns the synthetic collision identity.',
  'Synthetic answer beta.\n```ts\nconst fixtureValue = 16;\n```',
  '[corrupted message]',
  '[Tool: Read File]\nFile: /fixture/v016/project/synthetic.ts\nStatus: ✓ completed',
  '[Tool: Search]\nPattern: synthetic-token\nPath: /fixture/v016/project\nStatus: ✓ completed',
  'Synthetic empty-ID compatibility turn.',
  'Synthetic workspace-native message.',
  'Synthetic workspace missing-ID answer.',
  'Synthetic workspace empty-ID answer.',
  'Synthetic Store-only turn before Composer history.',
  'Synthetic Store-only middle turn.',
  'Synthetic Store collision payload.',
  'synthetic read result',
  'synthetic search result',
  'synthetic enrichment result',
]);

function pathInside(root: string, name: string): string {
  if (basename(name) !== name) throw new TypeError('Fixture artifact names must be basenames.');
  const path = resolve(root, name);
  const relation = relative(resolve(root), path);
  if (relation.startsWith('..') || relation === '') {
    throw new TypeError('Fixture artifact path escaped or replaced the output root.');
  }
  return path;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function createFreshDatabase(
  path: string,
  populate: (database: import('better-sqlite3').Database) => void
): void {
  rmSync(path, { force: true });
  const database = new BetterSqlite3(path);
  try {
    database.pragma('journal_mode = DELETE');
    database.pragma('page_size = 4096');
    database.pragma('auto_vacuum = NONE');
    database.pragma('encoding = "UTF-8"');
    populate(database);
    database.exec('VACUUM');
  } finally {
    database.close();
  }
  const bytes = readFileSync(path);
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
    throw new Error('Synthetic fixture generator did not produce a SQLite 3 database.');
  }
  bytes.writeUInt32BE(PINNED_SQLITE_HEADER_VERSION, 96);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeComposerDatabase(path: string): void {
  createFreshDatabase(path, (database) => {
    database.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY NOT NULL, value TEXT)');
    const insert = database.prepare(
      'INSERT INTO cursorDiskKV (rowid, key, value) VALUES (?, ?, ?)'
    );
    for (const bubble of RAW_BUBBLES) {
      insert.run(
        bubble.rowid,
        bubble.key,
        bubble.value === null ? null : JSON.stringify(bubble.value)
      );
    }
    insert.run(100, `composerData:${V016_SYNTHETIC_SESSION_ID}`, JSON.stringify(COMPOSER_DATA));
  });
}

export interface V016FixtureLogicalInventory {
  composerGlobal: {
    table: 'cursorDiskKV';
    sessionId: string;
    rowids: number[];
    keys: string[];
    bubbleIds: Array<string | null>;
  };
  workspaceFallback: {
    sessionIds: string[];
    messageIds: Array<string | null>;
  };
  taggedProjection: {
    globalMessageIds: Array<string | null>;
    workspaceMessageIds: Array<string | null>;
    sources: string[];
  };
  storeUpgrade: {
    labels: string[];
    collisionCandidateId: string;
    collisionAllocatedId: string;
  };
  payloadStrings: string[];
}

function collectStrings(value: unknown, keys: ReadonlySet<string>, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, keys, result);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key) && typeof nested === 'string') result.add(nested);
    collectStrings(nested, keys, result);
  }
}

/** Read only the four generated artifacts and return their deterministic logical inventory. */
export function inspectV016FixtureSet(root: string): V016FixtureLogicalInventory {
  const payloadStrings = new Set<string>();
  const composerPath = pathInside(root, 'composer-global-state.vscdb');
  const composer = new BetterSqlite3(composerPath, { readonly: true });
  let composerRows: Array<{ rowid: number; key: string; value: string | null }>;
  try {
    composerRows = composer
      .prepare('SELECT rowid, key, value FROM cursorDiskKV ORDER BY rowid ASC')
      .all() as Array<{ rowid: number; key: string; value: string | null }>;
  } finally {
    composer.close();
  }
  const bubbleRows = composerRows.filter(({ key }) => key.startsWith('bubbleId:'));
  for (const row of bubbleRows) {
    if (row.value !== null) {
      collectStrings(JSON.parse(row.value), new Set(['text', 'content', 'result']), payloadStrings);
    }
  }

  const workspace = JSON.parse(
    readFileSync(pathInside(root, 'workspace-fallback.json'), 'utf8')
  ) as typeof WORKSPACE_FALLBACK;
  const tagged = JSON.parse(
    readFileSync(pathInside(root, 'tagged-output.json'), 'utf8')
  ) as typeof TAGGED_OUTPUT;
  const store = JSON.parse(
    readFileSync(pathInside(root, 'merged-store-source.json'), 'utf8')
  ) as typeof MERGED_STORE_SOURCE;
  collectStrings(workspace, new Set(['content', 'text', 'result']), payloadStrings);
  collectStrings(tagged, new Set(['content', 'text', 'result']), payloadStrings);
  collectStrings(store, new Set(['content', 'text', 'result']), payloadStrings);

  return {
    composerGlobal: {
      table: 'cursorDiskKV',
      sessionId: V016_SYNTHETIC_SESSION_ID,
      rowids: composerRows.map(({ rowid }) => rowid),
      keys: composerRows.map(({ key }) => key),
      bubbleIds: bubbleRows.map(({ value }) => {
        if (value === null) return null;
        const parsed = JSON.parse(value) as { bubbleId?: string };
        return parsed.bubbleId ?? null;
      }),
    },
    workspaceFallback: {
      sessionIds: workspace.tabs.map(({ id }) => id),
      messageIds: workspace.tabs.flatMap(({ messages }) =>
        messages.map((message) => ('id' in message ? (message.id ?? null) : null))
      ),
    },
    taggedProjection: {
      globalMessageIds: tagged.globalSession.messages.map(({ id }) => id),
      workspaceMessageIds: tagged.workspaceFallbackSessions.flatMap(({ messages }) =>
        messages.map(({ id }) => id)
      ),
      sources: [
        tagged.globalSession.source,
        ...tagged.workspaceFallbackSessions.map(({ source }) => source),
      ],
    },
    storeUpgrade: {
      labels: store.sourceNativeOrder.map(({ label }) => label),
      collisionCandidateId: store.collision.storeCandidateId,
      collisionAllocatedId: store.collision.expectedAllocatedStoreId,
    },
    payloadStrings: [...payloadStrings].sort(compareCodePoints),
  };
}

export interface FixtureSafetyIssue {
  artifact: string;
  rule: string;
  evidence: string;
}

const SENSITIVE_PATTERNS = Object.freeze([
  { rule: 'posix-home-path', expression: /\/(?:home|Users)\/[A-Za-z0-9._-]+/gi },
  { rule: 'windows-user-path', expression: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+/gi },
  { rule: 'workspace-checkout-path', expression: /\/workspaces\/[A-Za-z0-9._-]+/gi },
  { rule: 'email-address', expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { rule: 'ipv4-address', expression: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { rule: 'private-key', expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'openai-key', expression: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { rule: 'github-token', expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { rule: 'aws-access-key', expression: /\bAKIA[A-Z0-9]{16}\b/g },
  { rule: 'bearer-token', expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi },
  {
    rule: 'credential-assignment',
    expression:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s,"']{6,}/gi,
  },
  { rule: 'machine-hostname', expression: /\b(?:DESKTOP-[A-Z0-9]+|[A-Za-z0-9-]+\.local)\b/g },
]);

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

/** Scan arbitrary committed/generated bytes without consulting host identity. */
export function scanSyntheticFixtureBytes(
  artifact: string,
  bytes: Buffer,
  allowedUuidValues: readonly string[] = [V016_SYNTHETIC_SESSION_ID]
): FixtureSafetyIssue[] {
  const text = bytes.toString('utf8');
  const issues: FixtureSafetyIssue[] = [];
  for (const { rule, expression } of SENSITIVE_PATTERNS) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      issues.push({ artifact, rule, evidence: match[0]!.slice(0, 80) });
    }
  }
  const allowed = new Set(allowedUuidValues.map((value) => value.toLowerCase()));
  UUID_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(UUID_PATTERN)) {
    if (!allowed.has(match[0]!.toLowerCase())) {
      issues.push({ artifact, rule: 'undeclared-cursor-shaped-id', evidence: match[0]! });
    }
  }
  return issues;
}

/** Reject payload strings not declared as wholly synthetic generator inputs. */
export function scanLogicalPayloadInventory(
  inventory: V016FixtureLogicalInventory,
  allowedPayloadStrings: readonly string[] = V016_ALLOWED_PAYLOAD_STRINGS
): FixtureSafetyIssue[] {
  const allowed = new Set(allowedPayloadStrings);
  return inventory.payloadStrings.flatMap((value) =>
    allowed.has(value)
      ? []
      : [
          {
            artifact: 'logical-inventory',
            rule: 'undeclared-payload-content',
            evidence: value.slice(0, 80),
          },
        ]
  );
}

export interface V016FixtureManifest {
  schemaVersion: 1;
  fixtureSchema: typeof V016_FIXTURE_SCHEMA;
  generator: {
    path: string;
    invocation: string;
    deterministic: true;
    forbiddenInputs: string[];
    logicalInputs: {
      sessionId: string;
      workspacePath: string;
      hostname: string;
      createdAt: string;
      updatedAt: string;
      sqliteHeaderVersion: number;
      bubbleRowids: number[];
      allowedPayloadStrings: readonly string[];
    };
  };
  provenance: {
    cursorHistory: {
      tag: string;
      commit: string;
      projectorManifest: string;
      sourceFormat: Record<string, unknown>;
    };
    externalConsumerCertification: {
      manifest: string;
      recurringCiIncludesThirdPartyImplementation: false;
    };
  };
  syntheticIdentities: {
    allowedCursorShapedIds: string[];
    collisionId: string;
  };
  logicalInventory: V016FixtureLogicalInventory;
  artifacts: Record<ArtifactName, { sha256: string; bytes: number }>;
  safety: {
    syntheticOnly: true;
    allowedPathPrefixes: string[];
    requiredScans: string[];
  };
}

/** Generate the locked v0.16 fixture set into one explicit private root. */
export function generateV016Fixtures(outputDirectory: string): V016FixtureManifest {
  requireNonemptyOutput(outputDirectory);
  const root = resolve(outputDirectory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);

  writeComposerDatabase(pathInside(root, 'composer-global-state.vscdb'));
  writeJson(pathInside(root, 'workspace-fallback.json'), WORKSPACE_FALLBACK);
  writeJson(pathInside(root, 'tagged-output.json'), TAGGED_OUTPUT);
  writeJson(pathInside(root, 'merged-store-source.json'), MERGED_STORE_SOURCE);

  const logicalInventory = inspectV016FixtureSet(root);
  const artifacts = Object.fromEntries(
    ARTIFACT_NAMES.map((name) => {
      const bytes = readFileSync(pathInside(root, name));
      return [name, { sha256: sha256(bytes), bytes: bytes.length }];
    })
  ) as V016FixtureManifest['artifacts'];
  const manifest: V016FixtureManifest = {
    schemaVersion: 1,
    fixtureSchema: V016_FIXTURE_SCHEMA,
    generator: {
      path: 'tests/compatibility/support/generate-v016-fixtures.ts',
      invocation:
        'node --no-warnings --experimental-strip-types tests/compatibility/support/generate-v016-fixtures.ts <private-output-directory>',
      deterministic: true,
      forbiddenInputs: [
        'live Cursor roots',
        'user backup archives',
        'environment-derived identity or content',
        'adjacent vibe-history checkout',
        'network resources',
        'wall clock or randomness',
      ],
      logicalInputs: {
        sessionId: V016_SYNTHETIC_SESSION_ID,
        workspacePath: V016_SYNTHETIC_WORKSPACE,
        hostname: V016_SYNTHETIC_HOSTNAME,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        sqliteHeaderVersion: PINNED_SQLITE_HEADER_VERSION,
        bubbleRowids: RAW_BUBBLES.map(({ rowid }) => rowid),
        allowedPayloadStrings: V016_ALLOWED_PAYLOAD_STRINGS,
      },
    },
    provenance: {
      cursorHistory: {
        tag: PROJECTOR_TAG,
        commit: PROJECTOR_COMMIT,
        projectorManifest: 'tests/compatibility/fixtures/v016/projector-manifest.json',
        sourceFormat: {
          composerGlobalTable: 'cursorDiskKV',
          composerGlobalKeys: ['composerData:<session-id>', 'bubbleId:<session-id>:<bubble-id>'],
          bubbleOrder: 'rowid ASC',
          nullBubblePayload: 'preserved as a row-key-ID [corrupted message] entry',
          workspaceFallbackContainer: 'tabs[].messages[]',
        },
      },
      externalConsumerCertification: {
        manifest: 'tests/compatibility/fixtures/v016/vibe-history-consumer-manifest.json',
        recurringCiIncludesThirdPartyImplementation: false,
      },
    },
    syntheticIdentities: {
      allowedCursorShapedIds: [V016_SYNTHETIC_SESSION_ID],
      collisionId: V016_SYNTHETIC_COLLISION_ID,
    },
    logicalInventory,
    artifacts,
    safety: {
      syntheticOnly: true,
      allowedPathPrefixes: ['/fixture/v016/'],
      requiredScans: [
        'byte-sensitive-patterns',
        'declared-Cursor-shaped-identities',
        'declared-logical-payload-content',
        'committed-vs-regenerated-hashes',
      ],
    },
  };
  writeJson(pathInside(root, 'fixture-manifest.json'), manifest);
  return manifest;
}

function requireNonemptyOutput(outputDirectory: string): void {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new TypeError('An explicit fixture output directory is required.');
  }
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    process.stderr.write('Usage: generate-v016-fixtures.ts <private-output-directory>\n');
    process.exitCode = 2;
  } else {
    const manifest = generateV016Fixtures(outputDirectory);
    const manifestPath = pathInside(outputDirectory, 'fixture-manifest.json');
    process.stdout.write(
      `${JSON.stringify({
        fixtureSchema: manifest.fixtureSchema,
        outputDirectory: resolve(outputDirectory),
        manifestSha256: sha256(readFileSync(manifestPath)),
      })}\n`
    );
  }
}
