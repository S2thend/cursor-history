/**
 * Shared mock database helpers for testing
 */
import { vi } from 'vitest';

/**
 * Create a mock Statement that returns preconfigured results
 */
export function createMockStatement(getResult?: unknown, allResult?: unknown[]) {
  return {
    get: vi.fn((..._args: unknown[]) => getResult),
    all: vi.fn((..._args: unknown[]) => allResult ?? []),
    run: vi.fn(),
  };
}

/**
 * Create a mock Database.
 *
 * queryMap keys should match the SQL prefix that `prepare()` is called with.
 * The value is { get?, all? } return values.
 *
 * For convenience, any `prepare()` call not found in the map returns a statement
 * whose get() returns undefined and all() returns [].
 */
export function createMockDb(queryMap: Record<string, { get?: unknown; all?: unknown[] }> = {}) {
  return {
    prepare: vi.fn((sql: string) => {
      // Find first matching key
      for (const [key, result] of Object.entries(queryMap)) {
        if (sql.includes(key)) {
          return createMockStatement(result.get, result.all);
        }
      }
      return createMockStatement(undefined, []);
    }),
    close: vi.fn(),
    runSQL: vi.fn(),
  };
}

/**
 * Create a mock DatabaseDriver
 */
export function createMockDriver(name: string, available = true) {
  const mockDb = createMockDb();
  return {
    name,
    isAvailable: vi.fn().mockResolvedValue(available),
    open: vi.fn().mockReturnValue(mockDb),
    backup: vi.fn().mockResolvedValue(undefined),
  };
}
