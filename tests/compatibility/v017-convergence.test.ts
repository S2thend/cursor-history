import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allocateToolCallIdentities,
  prepareStoreIdentityCandidates,
} from '../../src/core/session-identity.js';
import type { Message, Session, ToolCall } from '../../src/lib/types.js';
import {
  normalizeCursorSessionV016,
  readV016ArchiveState,
  syncV016Session,
} from '../helpers/v016-consumer.js';

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'compatibility', 'fixtures', 'v017');

interface LockedSessionFixture {
  session: Session;
}

interface CompleteMergedFixture extends LockedSessionFixture {
  expectedCorrectiveTransition: {
    incomingLegacySource: 'global';
    resolvedSource: 'merged';
    replacementCount: number;
    nextUnchangedWriteCount: number;
    duplicateLogicalContentCount: number;
    preservedIds: string[];
    nonContractualValues: string[];
  };
}

interface RepresentationFixture extends LockedSessionFixture {
  identityBoundary: Record<string, unknown>;
}

interface ArchiveView {
  session: unknown;
  messages: Array<{ id: string; content: string; parent_message_id: string | null }>;
  tools: Array<{ id: string; message_id: string; name: string }>;
  blocks: Array<{ message_id: string; content: string }>;
  foreignKeyViolations: unknown[];
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name), 'utf8')) as T;
}

function cloneLockedSession(session: Session): Session {
  return structuredClone(session);
}

function transcriptIdentity(message: Message) {
  return {
    representation: 'transcript' as const,
    role: message.role,
    content: message.content,
    toolActivity: (message.toolCalls ?? []).map(({ name, params }) => ({
      name,
      ...(params === undefined ? {} : { params }),
    })),
    sourceRelationships: message.parentMessageId
      ? { parentMessageId: message.parentMessageId }
      : [],
  };
}

function attachToolIdentities(message: Message): Message {
  if (!message.toolCalls?.length || !message.id) return message;
  return {
    ...message,
    toolCalls: allocateToolCallIdentities(message.id, message.toolCalls).map(
      ({ call, id, identityOrigin }): ToolCall => ({ ...call, id, identityOrigin })
    ),
  };
}

function correctiveMergedSession(fixture: CompleteMergedFixture): Session {
  const session = cloneLockedSession(fixture.session);
  const storeOnly = session.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => !message.id);
  const candidates = prepareStoreIdentityCandidates(
    storeOnly.map(({ message }) => transcriptIdentity(message))
  );
  const allocatedByIndex = new Map(
    candidates.map((candidate, index) => [
      storeOnly[index]!.index,
      {
        id: candidate.candidateId,
        identityOrigin: candidate.identityOrigin,
      },
    ])
  );
  session.messages = session.messages.map((message, index) => {
    const storeIdentity = allocatedByIndex.get(index);
    const resolved: Message = {
      ...message,
      id: message.id ?? storeIdentity!.id,
      messageIdentityVersion: 1,
      identityOrigin: message.id ? 'composer-native' : storeIdentity!.identityOrigin,
    };
    return attachToolIdentities(resolved);
  });
  session.messageCount = session.messages.length;
  session.source = fixture.expectedCorrectiveTransition.incomingLegacySource;
  session.resolvedSource = fixture.expectedCorrectiveTransition.resolvedSource;
  session.sources = ['composer', 'store'];
  session.messageIdentityVersion = 1;
  session.activeBranchMessageIds = session.messages.map(({ id }) => id!);
  session.activeBranchBubbleIds = [...session.activeBranchMessageIds];
  return session;
}

function leafHash(message: Message): string {
  return createHash('sha256')
    .update(JSON.stringify({ role: message.role, content: message.content }))
    .digest('hex');
}

function correctiveStoreDbSession(fixture: RepresentationFixture): Session {
  const session = cloneLockedSession(fixture.session);
  const candidates = prepareStoreIdentityCandidates(
    session.messages.map((message) => ({
      representation: 'db' as const,
      leafHash: leafHash(message),
    }))
  );
  session.messages = session.messages.map((message, index) =>
    attachToolIdentities({
      ...message,
      id: candidates[index]!.candidateId,
      messageIdentityVersion: 1,
      identityOrigin: 'store-db-v1',
    })
  );
  session.messageCount = session.messages.length;
  session.source = 'global';
  session.resolvedSource = 'store-db';
  session.sources = ['store'];
  session.messageIdentityVersion = 1;
  session.activeBranchMessageIds = session.messages.map(({ id }) => id!);
  session.activeBranchBubbleIds = [...session.activeBranchMessageIds];
  return session;
}

function archiveView(path: string, sessionId: string): ArchiveView {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    return {
      session: db
        .prepare(
          `SELECT id, hostname, provider, created_at, updated_at, project_path,
                  leaf_message_id, first_user_message, message_count, metadata
             FROM sessions WHERE id = ? ORDER BY hostname`
        )
        .get(sessionId),
      messages: db
        .prepare(
          `SELECT id, content, parent_message_id
             FROM messages WHERE session_id = ? ORDER BY id`
        )
        .all(sessionId) as ArchiveView['messages'],
      tools: db
        .prepare(
          `SELECT id, message_id, name
             FROM tool_calls WHERE session_id = ? ORDER BY message_id, id`
        )
        .all(sessionId) as ArchiveView['tools'],
      blocks: db
        .prepare(
          `SELECT message_id, content
             FROM code_blocks WHERE session_id = ? ORDER BY message_id, content`
        )
        .all(sessionId) as ArchiveView['blocks'],
      foreignKeyViolations: db.pragma('foreign_key_check') as unknown[],
    };
  } finally {
    db.close();
  }
}

function withArchive(run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'cursor-history-v017-convergence-'));
  try {
    run(join(root, 'archive.sqlite'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectNoDuplicateLogicalContent(view: ArchiveView, expected: number): void {
  const counts = new Map<string, number>();
  for (const message of view.messages) {
    counts.set(message.content, (counts.get(message.content) ?? 0) + 1);
  }
  expect([...counts.values()].filter((count) => count > 1)).toHaveLength(expected);
}

describe('locked v0.17 corrective convergence', () => {
  const mergedFixture = readFixture<CompleteMergedFixture>('complete-merged.json');
  const degradedFixture = readFixture<LockedSessionFixture>('degraded-store.json');
  const transcriptFixture = readFixture<RepresentationFixture>('transcript-complete.json');
  const storeDbFixture = readFixture<RepresentationFixture>('store-db-complete.json');

  it('converges a transitional merged session through one replacement with native Composer IDs', () => {
    withArchive((path) => {
      const transitional = cloneLockedSession(mergedFixture.session);
      expect(syncV016Session(path, transitional).action).toBe('added');
      const transitionalId = normalizeCursorSessionV016(transitional).id;
      const before = archiveView(path, transitionalId);

      const corrective = correctiveMergedSession(mergedFixture);
      expect(syncV016Session(path, corrective)).toEqual({
        action: 'replaced',
        messagesAppended: corrective.messages.length,
      });
      const corrected = archiveView(path, transitionalId);
      expect(corrected).not.toEqual(before);
      expect(corrected.messages).toHaveLength(corrective.messages.length);
      expect(corrected.foreignKeyViolations).toEqual([]);
      expectNoDuplicateLogicalContent(
        corrected,
        mergedFixture.expectedCorrectiveTransition.duplicateLogicalContentCount
      );
      for (const nativeId of mergedFixture.expectedCorrectiveTransition.preservedIds) {
        expect(corrected.messages.map(({ id }) => id)).toContain(`${transitionalId}:${nativeId}`);
      }

      const afterReplacement = archiveView(path, transitionalId);
      expect(syncV016Session(path, corrective)).toEqual({ action: 'skipped', messagesAppended: 0 });
      expect(archiveView(path, transitionalId)).toEqual(afterReplacement);
      expect(mergedFixture.expectedCorrectiveTransition.replacementCount).toBe(1);
      expect(mergedFixture.expectedCorrectiveTransition.nextUnchangedWriteCount).toBe(0);
      expect(mergedFixture.expectedCorrectiveTransition.nonContractualValues).toContain(
        'v0.17 Store positional IDs'
      );
    });
  });

  it('pins a complete corrected view during degradation and converges on retry without writes', () => {
    withArchive((path) => {
      const complete = correctiveMergedSession(mergedFixture);
      expect(syncV016Session(path, complete).action).toBe('added');
      const sessionId = normalizeCursorSessionV016(complete).id;
      const pinned = archiveView(path, sessionId);

      const degraded = cloneLockedSession(degradedFixture.session);
      degraded.source = 'workspace-fallback';
      expect(syncV016Session(path, degraded)).toEqual({ action: 'skipped', messagesAppended: 0 });
      expect(archiveView(path, sessionId)).toEqual(pinned);

      expect(syncV016Session(path, complete)).toEqual({ action: 'skipped', messagesAppended: 0 });
      expect(archiveView(path, sessionId)).toEqual(pinned);
    });
  });

  it('treats complete transcript-to-Store-DB as one replacement boundary and then a no-op', () => {
    withArchive((path) => {
      const transcript = cloneLockedSession(transcriptFixture.session);
      expect(syncV016Session(path, transcript).action).toBe('added');
      const sessionId = normalizeCursorSessionV016(transcript).id;
      const transcriptView = archiveView(path, sessionId);
      const db = correctiveStoreDbSession(storeDbFixture);

      expect(syncV016Session(path, db)).toEqual({
        action: 'replaced',
        messagesAppended: db.messages.length,
      });
      const dbView = archiveView(path, sessionId);
      expect(dbView).not.toEqual(transcriptView);
      expect(dbView.messages).toHaveLength(db.messages.length);
      expect(dbView.messages.every(({ id }) => id.includes(':store:v1:db:'))).toBe(true);
      expect(
        dbView.messages.some(({ id }) => transcriptView.messages.some((old) => old.id === id))
      ).toBe(false);
      expectNoDuplicateLogicalContent(dbView, 0);

      const converged = archiveView(path, sessionId);
      expect(syncV016Session(path, db)).toEqual({ action: 'skipped', messagesAppended: 0 });
      expect(archiveView(path, sessionId)).toEqual(converged);
    });
  });

  it('rolls back a representation transition fault, reopens old complete state, and retries', () => {
    withArchive((path) => {
      const transcript = cloneLockedSession(transcriptFixture.session);
      syncV016Session(path, transcript);
      const sessionId = normalizeCursorSessionV016(transcript).id;
      const oldComplete = archiveView(path, sessionId);
      const db = correctiveStoreDbSession(storeDbFixture);

      expect(() => syncV016Session(path, db, { failAfterDelete: true })).toThrow(
        'intentional replacement fault'
      );
      expect(archiveView(path, sessionId)).toEqual(oldComplete);
      expect(readV016ArchiveState(path, sessionId).messageIds).toEqual(
        oldComplete.messages.map(({ id }) => id)
      );

      expect(syncV016Session(path, db).action).toBe('replaced');
      const newComplete = archiveView(path, sessionId);
      expect(newComplete).not.toEqual(oldComplete);
      expect(syncV016Session(path, db).action).toBe('skipped');
      expect(archiveView(path, sessionId)).toEqual(newComplete);
    });
  });
});
