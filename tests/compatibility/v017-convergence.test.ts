import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allocateToolCallIdentities,
  prepareStoreIdentityCandidates,
} from '../../src/core/session-identity.js';
import type { Message, Session, ToolCall } from '../../src/lib/types.js';
import {
  applyGenericCompleteView,
  projectV016DownstreamContract,
  type GenericDownstreamState,
  type LegacyDownstreamView,
} from '../helpers/v016-downstream-contract.js';

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

function expectNoDuplicateLogicalContent(view: LegacyDownstreamView, expected: number): void {
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
    const state: GenericDownstreamState = {};
    const transitional = cloneLockedSession(mergedFixture.session);
    expect(applyGenericCompleteView(state, transitional, 'complete').action).toBe('added');
    const before = structuredClone(state.view!);

    const corrective = correctiveMergedSession(mergedFixture);
    expect(applyGenericCompleteView(state, corrective, 'complete')).toEqual({
      action: 'replaced',
      recordsWritten: corrective.messages.length,
    });
    const corrected = state.view!;
    expect(corrected).not.toEqual(before);
    expectNoDuplicateLogicalContent(
      corrected,
      mergedFixture.expectedCorrectiveTransition.duplicateLogicalContentCount
    );
    for (const nativeId of mergedFixture.expectedCorrectiveTransition.preservedIds) {
      expect(corrected.messages.map(({ key }) => key)).toContain(
        `cursor:${corrective.id}:${nativeId}`
      );
    }
    const converged = structuredClone(state);
    expect(applyGenericCompleteView(state, corrective, 'complete')).toEqual({
      action: 'skipped',
      recordsWritten: 0,
    });
    expect(state).toEqual(converged);
  });

  it('pins a complete corrected view during degradation and converges on retry without writes', () => {
    const state: GenericDownstreamState = {};
    const complete = correctiveMergedSession(mergedFixture);
    applyGenericCompleteView(state, complete, 'complete');
    const pinned = structuredClone(state);
    const degraded = cloneLockedSession(degradedFixture.session);
    expect(applyGenericCompleteView(state, degraded, 'degraded')).toEqual({
      action: 'skipped',
      recordsWritten: 0,
    });
    expect(state).toEqual(pinned);
    expect(applyGenericCompleteView(state, complete, 'complete').action).toBe('skipped');
  });

  it('treats complete transcript-to-Store-DB as one replacement boundary and then a no-op', () => {
    const state: GenericDownstreamState = {};
    const transcript = cloneLockedSession(transcriptFixture.session);
    applyGenericCompleteView(state, transcript, 'complete');
    const transcriptView = structuredClone(state.view!);
    const db = correctiveStoreDbSession(storeDbFixture);
    expect(applyGenericCompleteView(state, db, 'complete')).toEqual({
      action: 'replaced',
      recordsWritten: db.messages.length,
    });
    const dbView = state.view!;
    expect(dbView.messages.every(({ key }) => key.includes(':store:v1:db:'))).toBe(true);
    expect(
      dbView.messages.some(({ key }) => transcriptView.messages.some((old) => old.key === key))
    ).toBe(false);
    expectNoDuplicateLogicalContent(dbView, 0);
    expect(applyGenericCompleteView(state, db, 'complete').action).toBe('skipped');
  });

  it('documents that exact third-party transaction rollback remains an external certification', () => {
    expect(
      projectV016DownstreamContract(cloneLockedSession(transcriptFixture.session))
    ).toBeDefined();
    expect(mergedFixture.expectedCorrectiveTransition.nonContractualValues).toContain(
      'v0.17 Store positional IDs'
    );
  });
});
