/**
 * Suppression for Node's `node:sqlite` experimental warning.
 *
 * Importing `node:sqlite` makes Node write this to stderr:
 *
 *   ExperimentalWarning: SQLite is an experimental feature and might change at any time
 *
 * cursor-history selects that driver deliberately — the registry prefers it because it needs no
 * native bindings — and documents the tradeoff. Letting Node surface the warning means every CLI
 * invocation that touches a database writes to stderr, which breaks any consumer that reads stderr
 * as a failure signal (`status` is still 0, so the output is otherwise indistinguishable from an
 * error) and tells users nothing they can act on.
 *
 * Only that one warning is dropped. Every other process warning is emitted unchanged, and
 * `process.emit` keeps its normal return contract so `process.on('warning')` consumers for
 * unrelated warnings are unaffected.
 */
const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature';

export function suppressNodeSqliteExperimentalWarning(): void {
  const originalEmit = process.emit.bind(process) as (
    event: string | symbol,
    ...args: unknown[]
  ) => boolean;

  process.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'warning') {
      const warning = args[0] as { name?: unknown; message?: unknown } | undefined;
      if (
        typeof warning === 'object' &&
        warning !== null &&
        warning.name === 'ExperimentalWarning' &&
        typeof warning.message === 'string' &&
        warning.message.includes(SQLITE_EXPERIMENTAL_WARNING)
      ) {
        return false;
      }
    }
    return originalEmit(event, ...args);
  }) as typeof process.emit;
}
