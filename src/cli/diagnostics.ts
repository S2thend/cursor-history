import type { AmbiguousSessionSummary, SessionDiagnostic } from '../core/types.js';

/** CLI-owned, operation-scoped diagnostic sink with deterministic de-duplication. */
export interface CliDiagnosticCollector {
  readonly diagnostics: SessionDiagnostic[];
  readonly onDiagnostic: (diagnostic: SessionDiagnostic) => void;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function diagnosticKey(diagnostic: SessionDiagnostic): string {
  if (diagnostic.code === 'SESSION_AMBIGUOUS') {
    return JSON.stringify([
      diagnostic.code,
      diagnostic.sessionId ?? '',
      [...(diagnostic.occurrenceRefs ?? [])].sort(compareCodePoints),
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
  return createSessionAmbiguityDiagnostic(summary.id, summary.diagnosticOccurrenceRefs);
}

/** Create the same safe public diagnostic when ambiguity appears after listing. */
export function createSessionAmbiguityDiagnostic(
  sessionId: string,
  occurrenceRefs: readonly string[]
): SessionDiagnostic {
  const refs = [...new Set(occurrenceRefs)].sort(compareCodePoints);
  return {
    code: 'SESSION_AMBIGUOUS',
    message: `Session ${sessionId} has divergent physical occurrences.`,
    sessionId,
    occurrenceCount: refs.length,
    occurrenceRefs: refs,
    remedy: 'Resolve or remove the divergent replicas, then retry the operation.',
  };
}
