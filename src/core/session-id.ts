const NATIVE_CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether a source ID is a canonical hyphenated native Cursor UUID. */
export function isNativeCursorUuid(sessionId: string): boolean {
  return NATIVE_CURSOR_UUID.test(sessionId);
}

/**
 * Exact key for one Cursor session ID.
 *
 * v0.16 treated every session ID as a byte-exact public value, including canonical UUID syntax.
 * Preserve that compatibility rule for lookup, grouping, and cross-source association.
 */
export function logicalSessionIdKey(sessionId: string): string {
  return sessionId;
}

/** Compare two session IDs using the byte-exact v0.16 identity rule. */
export function sessionIdsEqual(left: string, right: string): boolean {
  return left === right;
}

/** Unicode code-point ordering without locale/process dependence. */
export function compareSessionIdSpellings(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/**
 * Select one deterministic spelling that was actually observed in source data.
 *
 * Callers that have a fidelity/source preference should pass only that preferred tier. This
 * helper never manufactures a lowercase presentation ID.
 */
export function selectNativeSessionIdSpelling(sessionIds: Iterable<string>): string | undefined {
  return [...new Set(sessionIds)].sort(compareSessionIdSpellings)[0];
}

/** Group source IDs without folding or rewriting their spelling. */
export function groupSessionIdSpellings(
  sessionIds: Iterable<string>
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const sessionId of sessionIds) {
    const key = logicalSessionIdKey(sessionId);
    const values = grouped.get(key) ?? [];
    if (!values.includes(sessionId)) values.push(sessionId);
    grouped.set(key, values);
  }
  return new Map(
    [...grouped.entries()].map(([key, values]) => [
      key,
      Object.freeze(values.sort(compareSessionIdSpellings)),
    ])
  );
}
