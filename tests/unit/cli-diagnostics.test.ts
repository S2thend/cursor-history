import { describe, expect, it } from 'vitest';

import {
  createAmbiguousSessionDiagnostic,
  createCliDiagnosticCollector,
} from '../../src/cli/diagnostics.js';

describe('CLI diagnostic collection', () => {
  it('emits one ambiguity diagnostic for repeated reports of the same occurrence set', () => {
    const collector = createCliDiagnosticCollector();
    const diagnostic = {
      code: 'SESSION_AMBIGUOUS' as const,
      message: 'First rendering of the ambiguity.',
      sessionId: 'session-1',
      occurrenceCount: 2,
      occurrenceRefs: ['occurrence:v1:b', 'occurrence:v1:a'],
      remedy: 'Resolve the replicas.',
    };

    collector.onDiagnostic(diagnostic);
    collector.onDiagnostic({
      ...diagnostic,
      message: 'A second rendering must not create another group.',
      occurrenceRefs: [...diagnostic.occurrenceRefs].reverse(),
    });

    expect(collector.diagnostics).toEqual([diagnostic]);
  });

  it('projects an ambiguous summary without exposing physical locators', () => {
    const diagnostic = createAmbiguousSessionDiagnostic({
      id: 'session-1',
      index: 1,
      indexScope: 'workspace',
      indexWorkspacePath: '/workspaces/a',
      resolutionState: 'ambiguous',
      sourceRoles: ['composer'],
      occurrenceCount: 2,
      diagnosticOccurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
    });

    expect(diagnostic).toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      sessionId: 'session-1',
      occurrenceCount: 2,
      occurrenceRefs: ['occurrence:v1:a', 'occurrence:v1:b'],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('indexWorkspacePath');
    expect(JSON.stringify(diagnostic)).not.toContain('locator');
  });
});
