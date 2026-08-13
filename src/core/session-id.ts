const NATIVE_CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether a source ID is a canonical hyphenated native Cursor UUID. */
export function isNativeCursorUuid(sessionId: string): boolean {
  return NATIVE_CURSOR_UUID.test(sessionId);
}

/**
 * Canonical key for one native Cursor session UUID.
 *
 * UUID hexadecimal digits are ASCII and case-insensitive. Non-UUID legacy/test identifiers remain
 * exact: the UUID policy must never collapse arbitrary public strings. Keep this key private;
 * public IDs and physical locators retain a real spelling observed in a Cursor source.
 */
export function logicalSessionIdKey(sessionId: string): string {
  return isNativeCursorUuid(sessionId) ? sessionId.toLowerCase() : sessionId;
}

/** Compare two native UUID spellings by their case-insensitive logical identity. */
export function sessionIdsEqual(left: string, right: string): boolean {
  return logicalSessionIdKey(left) === logicalSessionIdKey(right);
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

/** Group native source spellings without losing any physical spelling. */
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
