import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertCanonicalContractOrder,
  assertNoPhysicalLocators,
  assertPathlessAlias,
  assertPublicIdentity,
  canonicalizeContractSets,
  compareUnicodeCodePoints,
  parseStructuredJson,
} from '../helpers/contract-assertions.js';
import {
  assertNoSessionPayloadIo,
  combineIoObservers,
  createIoEventRecorder,
  createPoisonCanary,
  createPoisonIoObserver,
} from '../helpers/io-probe.js';
import { runBuiltCli, withBuiltCliTempRoot } from '../helpers/run-cli.js';
import type { AdapterIoEvent } from '../../src/core/io-observer.js';

describe('built CLI subprocess helper', () => {
  it('captures exact stream bytes, nonzero status, and cleans its temporary root', async () => {
    await withBuiltCliTempRoot(async (fixtureRoot) => {
      const script = join(fixtureRoot, 'fixture-cli.mjs');
      writeFileSync(
        script,
        'process.stdout.write(Buffer.from([0x61,0x00,0x62]));process.stderr.write(Buffer.from([0x65,0x72,0x72,0x0a]));process.exitCode=7;'
      );
      const result = await runBuiltCli([], { cliPath: script });

      expect(result.stdoutBytes).toEqual(Buffer.from([0x61, 0x00, 0x62]));
      expect(result.stderrBytes).toEqual(Buffer.from('err\n'));
      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(existsSync(result.tempRoot)).toBe(false);
    });
  });

  it('retains an owned root only when requested and cleans it idempotently', async () => {
    await withBuiltCliTempRoot(async (fixtureRoot) => {
      const script = join(fixtureRoot, 'fixture-cli.mjs');
      writeFileSync(script, 'process.stdout.write(process.env.TMPDIR ?? "missing");');
      const result = await runBuiltCli([], { cliPath: script, retainTempRoot: true });

      expect(result.stdout).toBe(result.tempRoot);
      expect(existsSync(result.tempRoot)).toBe(true);
      result.cleanup();
      result.cleanup();
      expect(existsSync(result.tempRoot)).toBe(false);
    });
  });

  it('reports a terminating signal without converting it to an exception', async () => {
    if (process.platform === 'win32') return;

    await withBuiltCliTempRoot(async (fixtureRoot) => {
      const script = join(fixtureRoot, 'signal-cli.mjs');
      writeFileSync(script, "process.kill(process.pid, 'SIGTERM');");
      const result = await runBuiltCli([], { cliPath: script });

      expect(result.status).toBeNull();
      expect(result.signal).toBe('SIGTERM');
      expect(result.timedOut).toBe(false);
      expect(existsSync(result.tempRoot)).toBe(false);
    });
  });
});

describe('I/O probe helpers', () => {
  const metadataEvent: AdapterIoEvent = {
    adapter: 'filesystem',
    operation: 'read',
    contextId: 'context',
    dataSourceIdentity: 'source',
    logicalSessionId: 'session-a',
    resourceClass: 'workspace-membership-json',
    classification: 'catalog-metadata',
  };
  const payloadEvent: AdapterIoEvent = {
    ...metadataEvent,
    adapter: 'sqlite',
    operation: 'query',
    logicalSessionId: 'session-b',
    resourceClass: 'global-bubble',
    classification: 'conversation-payload',
  };

  it('records immutable events and filters all adapter kinds deterministically', () => {
    const recorder = createIoEventRecorder();
    recorder.observer(metadataEvent);
    recorder.observer(payloadEvent);

    expect(recorder.count()).toBe(2);
    expect(recorder.count({ classification: 'conversation-payload' })).toBe(1);
    expect(recorder.snapshot({ adapter: 'sqlite' })).toEqual([payloadEvent]);
    expect(() => recorder.assertNone({ logicalSessionId: 'session-b' })).toThrow('forbidden I/O');
    assertNoSessionPayloadIo(recorder.snapshot(), 'session-a');
  });

  it('supports generic and event-filtered poison canaries without swallowing failures', () => {
    const canary = createPoisonCanary('fixture-file');
    expect(() => canary.touch()).toThrow('Poison canary touched: fixture-file');
    expect(canary.touchCount).toBe(1);

    const recorder = createIoEventRecorder();
    const poison = createPoisonIoObserver(
      { logicalSessionId: 'session-b', classification: 'conversation-payload' },
      'workspace-b'
    );
    const combined = combineIoObservers(recorder.observer, poison, vi.fn());
    expect(() => combined(payloadEvent)).toThrow('Poison canary touched: workspace-b');
    expect(recorder.count()).toBe(1);
  });
});

describe('structured contract assertion helpers', () => {
  it('canonicalizes only set-like fields using declared and code-point order', () => {
    const original = {
      sources: ['store', 'composer'],
      workspaceMemberships: [{ workspacePath: '/z' }, { workspacePath: '/a' }],
      messages: [{ id: 'second' }, { id: 'first' }],
    };
    const canonical = canonicalizeContractSets(original);
    expect(canonical).toEqual({
      sources: ['composer', 'store'],
      workspaceMemberships: [{ workspacePath: '/a' }, { workspacePath: '/z' }],
      messages: original.messages,
    });
    expect(() => assertCanonicalContractOrder(original)).toThrow('non-canonical');
    expect(() => assertCanonicalContractOrder(canonical)).not.toThrow();
    expect(compareUnicodeCodePoints('😀', '\uE000')).toBeGreaterThan(0);
  });

  it('checks identity, pathless aliases, structured JSON, and locator absence', () => {
    const library = { id: 'native-uuid', workspace: 'unknown', messages: [] };
    assertPublicIdentity(library, 'native-uuid');
    assertPathlessAlias(library, 'library');
    assertPathlessAlias({ workspacePath: null }, 'core-json');
    expect(parseStructuredJson(Buffer.from('{"ok":true}'))).toEqual({ ok: true });
    expect(() =>
      assertNoPhysicalLocators(
        { diagnostic: { message: 'safe' } },
        { forbiddenValues: ['/private/source'] }
      )
    ).not.toThrow();
    expect(() => assertNoPhysicalLocators({ storeDbPath: '/private/source' })).toThrow(
      'Physical locator field'
    );
  });
});
