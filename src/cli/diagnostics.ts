import type { AmbiguousSessionSummary, SessionDiagnostic } from '../core/types.js';

/** CLI-owned, operation-scoped diagnostic sink with deterministic de-duplication. */
export interface CliDiagnosticCollector {
  readonly diagnostics: SessionDiagnostic[];
  readonly onDiagnostic: (diagnostic: SessionDiagnostic) => void;
}

function diagnosticKey(diagnostic: SessionDiagnostic): string {
  if (diagnostic.code === 'SESSION_AMBIGUOUS') {
    return JSON.stringify([
      diagnostic.code,
      diagnostic.sessionId ?? '',
      [...(diagnostic.occurrenceRefs ?? [])].sort(),
    ]);
  }
  return JSON.stringify(diagnostic);
}

/**
 * Collect diagnostics for one CLI operation. Repeated ambiguity reports for
 * the same logical UUID/occurrence set are emitted only once.
 */
export function createCliDiagnosticCollector(): CliDiagnosticCollector {
  const diagnostics: SessionDiagnostic[] = [];
  const seen = new Set<string>();

  return {
    diagnostics,
    onDiagnostic(diagnostic): void {
      const snapshot = structuredClone(diagnostic);
      const key = diagnosticKey(snapshot);
      if (seen.has(key)) return;
      seen.add(key);
      diagnostics.push(snapshot);
    },
  };
}

/** Create the safe public diagnostic for one unresolved logical UUID. */
export function createAmbiguousSessionDiagnostic(
  summary: AmbiguousSessionSummary
): SessionDiagnostic {
  return {
    code: 'SESSION_AMBIGUOUS',
    message: `Session ${summary.id} has divergent physical occurrences.`,
    sessionId: summary.id,
    occurrenceCount: summary.occurrenceCount,
    occurrenceRefs: [...summary.diagnosticOccurrenceRefs],
    remedy: 'Resolve or remove the divergent replicas, then retry the operation.',
  };
}
