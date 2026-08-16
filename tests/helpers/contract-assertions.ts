const SOURCE_ROLE_ORDER = ['composer', 'store'] as const;
const REASON_CODE_ORDER = [
  'workspace-scope-omitted',
  'source-unavailable',
  'source-read-failed',
  'source-partial',
  'expected-store-db-unavailable',
  'store-db-expectation-unknown',
  'store-conversation-unavailable',
] as const;
const REPRESENTATION_ORDER = [
  'composer-global',
  'composer-workspace',
  'store-db',
  'store-transcript',
  'store-metadata',
] as const;
const INSTANCE_STATE_ORDER = [
  'contributed',
  'equivalent-replica',
  'omitted-by-scope',
  'failed',
  'superseded',
] as const;

const FORBIDDEN_LOCATOR_KEYS = new Set([
  'dbpath',
  'storedbpath',
  'storedatabasepath',
  'transcriptpath',
  'chatdir',
  'sessiondir',
  'physicalpath',
  'physicallocator',
  'internallocator',
  'recordkey',
  'sqlitekey',
]);

/** Compare strings by Unicode code point rather than locale or UTF-16 code unit. */
export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function enumComparator(order: readonly string[]): (left: unknown, right: unknown) => number {
  return (left, right): number => order.indexOf(String(left)) - order.indexOf(String(right));
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareUnicodeCodePoints(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown, field?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    if (
      field === 'sources' ||
      field === 'sourceRoles' ||
      field === 'expectedSourceRoles' ||
      field === 'loadedSourceRoles' ||
      field === 'omittedSourceRoles' ||
      field === 'failedSourceRoles'
    ) {
      return items.sort(enumComparator(SOURCE_ROLE_ORDER));
    }
    if (field === 'reasonCodes') return items.sort(enumComparator(REASON_CODE_ORDER));
    if (
      field === 'workspacePaths' ||
      field === 'occurrenceRefs' ||
      field === 'diagnosticOccurrenceRefs'
    ) {
      return items.sort((left, right) => compareUnicodeCodePoints(String(left), String(right)));
    }
    if (field === 'workspaceMemberships') {
      return items.sort((left, right) =>
        compareUnicodeCodePoints(
          String((left as Record<string, unknown>)['workspacePath']),
          String((right as Record<string, unknown>)['workspacePath'])
        )
      );
    }
    if (field === 'sourceInstances') {
      return items.sort((left, right) => {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const byRole = enumComparator(SOURCE_ROLE_ORDER)(
          leftRecord['sourceRole'],
          rightRecord['sourceRole']
        );
        if (byRole !== 0) return byRole;
        const byRepresentation = enumComparator(REPRESENTATION_ORDER)(
          leftRecord['representation'],
          rightRecord['representation']
        );
        if (byRepresentation !== 0) return byRepresentation;
        const byPaths = compareStringArrays(
          (leftRecord['workspacePaths'] as string[] | undefined) ?? [],
          (rightRecord['workspacePaths'] as string[] | undefined) ?? []
        );
        if (byPaths !== 0) return byPaths;
        return enumComparator(INSTANCE_STATE_ORDER)(leftRecord['state'], rightRecord['state']);
      });
    }
    // Messages, branches, tools, files, and unknown arrays are semantically
    // ordered and must never be sorted by this helper.
    return items;
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, canonicalize(nested, key)])
  );
}

/** Return a clone with only contract-defined set-like collections reordered. */
export function canonicalizeContractSets<T>(value: T): T {
  return canonicalize(value) as T;
}

/** Fail when any contract-defined set-like collection is not canonical. */
export function assertCanonicalContractOrder(value: unknown): void {
  const canonical = canonicalizeContractSets(value);
  if (JSON.stringify(value) !== JSON.stringify(canonical)) {
    throw new Error('Structured output contains a non-canonical set-like collection.');
  }
}

/** Require an exact public identity without permitting source/workspace decoration. */
export function assertPublicIdentity(value: unknown, expectedId: string): void {
  if (!isRecord(value) || value['id'] !== expectedId) {
    throw new Error(`Expected public identity ${JSON.stringify(expectedId)}.`);
  }
}

/** Assert the documented unknown-path aliases without inventing a canonical path. */
export function assertPathlessAlias(value: unknown, surface: 'core-json' | 'library'): void {
  if (!isRecord(value)) throw new Error('Expected a structured pathless value.');
  if (value['canonicalWorkspacePath'] !== undefined) {
    throw new Error('Pathless output must omit canonicalWorkspacePath.');
  }
  if (surface === 'core-json' && value['workspacePath'] !== null) {
    throw new Error('Pathless core/JSON output must use workspacePath: null.');
  }
  if (surface === 'library' && value['workspace'] !== 'unknown') {
    throw new Error('Pathless library output must use workspace: "unknown".');
  }
}

/** Parse exactly one structured JSON value from captured bytes. */
export function parseStructuredJson(bytes: Uint8Array | string): unknown {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) && !Array.isArray(value)) {
    throw new Error('Expected a JSON object or array structured output.');
  }
  return value;
}

export interface NoLocatorOptions {
  /** Known private roots/paths whose appearance in any string is forbidden. */
  forbiddenValues?: readonly string[];
}

/** Reject internal locator keys and caller-supplied private path values recursively. */
export function assertNoPhysicalLocators(value: unknown, options: NoLocatorOptions = {}): void {
  const visit = (nested: unknown, pointer: string): void => {
    if (typeof nested === 'string') {
      for (const forbidden of options.forbiddenValues ?? []) {
        if (forbidden.length > 0 && nested.includes(forbidden)) {
          throw new Error(`Physical locator value exposed at ${pointer}.`);
        }
      }
      return;
    }
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (!isRecord(nested)) return;
    for (const [key, child] of Object.entries(nested)) {
      if (FORBIDDEN_LOCATOR_KEYS.has(key.toLowerCase())) {
        throw new Error(`Physical locator field exposed at ${pointer}/${key}.`);
      }
      visit(child, `${pointer}/${key}`);
    }
  };
  visit(value, '$');
}
