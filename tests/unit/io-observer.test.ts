import { describe, expect, it, vi } from 'vitest';
import {
  classifyIoResource,
  createOperationIoContext,
  observeAdapterIo,
  registerIoObserver,
} from '../../src/core/io-observer.js';
import { SOURCE_READ_LIMITS_V1_DEFAULTS } from '../../src/core/source-read-limits.js';

describe('low-level I/O observer', () => {
  it('classifies reviewed metadata and payload resources', () => {
    expect(classifyIoResource('workspace-membership-json')).toEqual({
      resourceClass: 'workspace-membership-json',
      classification: 'catalog-metadata',
    });
    expect(classifyIoResource('store-transcript')).toEqual({
      resourceClass: 'store-transcript',
      classification: 'conversation-payload',
    });
  });

  it('fails unknown resource classes closed without exposing the input', () => {
    expect(classifyIoResource('/private/workspace/state.vscdb')).toEqual({
      resourceClass: 'unclassified-resource',
      classification: 'conversation-payload',
    });
  });

  it('emits a frozen event with the operation-bound identity and safe provenance', () => {
    const emit = vi.fn();
    const limits = SOURCE_READ_LIMITS_V1_DEFAULTS;
    const context = createOperationIoContext({
      contextId: 'context-1',
      dataSourceIdentity: 'live-source-1',
      sourceReadLimits: limits,
      emit,
    });

    const event = observeAdapterIo(context, {
      adapter: 'sqlite',
      operation: 'query',
      logicalSessionId: 'aaaaaaaa-0000-0000-0000-000000000001',
      sourceRole: 'composer',
      representation: 'composer-global',
      resourceClass: 'global-bubble',
    });

    expect(event).toEqual({
      adapter: 'sqlite',
      operation: 'query',
      contextId: 'context-1',
      dataSourceIdentity: 'live-source-1',
      logicalSessionId: 'aaaaaaaa-0000-0000-0000-000000000001',
      sourceRole: 'composer',
      representation: 'composer-global',
      resourceClass: 'global-bubble',
      classification: 'conversation-payload',
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(emit).toHaveBeenCalledWith(event);
  });

  it('registers observers immutably without process-global state', () => {
    const original = createOperationIoContext({
      contextId: 'context-2',
      dataSourceIdentity: 'backup-source-1',
      sourceReadLimits: SOURCE_READ_LIMITS_V1_DEFAULTS,
    });
    const emit = vi.fn();
    const observed = registerIoObserver(original, emit);

    expect(original.emit).toBeUndefined();
    expect(observed).not.toBe(original);
    expect(Object.isFrozen(observed)).toBe(true);
    observeAdapterIo(observed, {
      adapter: 'filesystem',
      operation: 'read',
      resourceClass: 'backup-manifest',
    });
    expect(emit).toHaveBeenCalledOnce();
  });

  it('propagates observer failures so poison canaries stop I/O', () => {
    const context = createOperationIoContext({
      contextId: 'context-3',
      dataSourceIdentity: 'live-source-2',
      sourceReadLimits: SOURCE_READ_LIMITS_V1_DEFAULTS,
      emit: () => {
        throw new Error('off-scope poison canary');
      },
    });

    expect(() =>
      observeAdapterIo(context, {
        adapter: 'key-value',
        operation: 'get',
        resourceClass: 'workspace-conversation',
      })
    ).toThrow('off-scope poison canary');
  });

  it('rejects unsafe operation identities at registration time', () => {
    expect(() =>
      createOperationIoContext({
        contextId: 'context\nleak',
        dataSourceIdentity: 'source',
        sourceReadLimits: SOURCE_READ_LIMITS_V1_DEFAULTS,
      })
    ).toThrow('contextId must be a non-empty single-line string');
  });
});
