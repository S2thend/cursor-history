import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Canonical system temp directory.
 *
 * macOS exposes `/var` as a symlink to `/private/var`, so `os.tmpdir()` and any
 * `realpathSync()` of the same directory disagree on macOS but agree on Linux (where CI runs).
 * Production code deliberately canonicalizes temp paths — `createPrivateTempWorkspace()`
 * resolves the requested parent with `realpathSync()` before creating anything — so fixtures
 * must build their expectations from the same canonical root rather than from `os.tmpdir()`.
 *
 * On platforms without symlinked temp roots this is a no-op, so using it never changes
 * behaviour on Linux or Windows.
 */
export function canonicalTempDir(): string {
  return realpathSync(tmpdir());
}
