# Private Release Verification

This procedure is for the maintainer who owns and is authorized to inspect the Cursor data used for
the release check. It is not suitable for CI, contributor data, shared-machine data, customer data,
or an attached issue/PR artifact.

## Automated exact-candidate gates

The v0.18.0 product runtime contract is finite: Node 20.x and 22.x–26.x, with Node 20.0.0 as the
exact minimum. Node 21 is not supported because the packaged native SQLite dependency does not
advertise that major. Source-level `npm ci`, typecheck, lint, the complete nonempty test suite, and
build run on Node 24.x, which satisfies the Vite 7 development-tool requirement. Those tools are not
used to judge whether the packed product runs on Node 20.0.0.

After source validation, the workflow builds and packs once, records the revision and SHA-256, and
runs that same checksum-addressed tarball on all of these profiles:

- Node 20.0.0: `node:sqlite` unavailable; automatic backup uses `better-sqlite3` and forcing
  `node:sqlite` fails explicitly;
- Node 22.15.1 and 23.7.0: `node:sqlite` reads but lacks online backup; automatic backup falls back
  to `better-sqlite3` and forcing `node:sqlite` reports the missing `onlineBackup` capability;
- Node 22.16.0 and 23.8.0: `node:sqlite` online backup is supported and selected automatically; and
- Node 24.x, 25.x, and 26.x: the packaged CLI, ESM/CJS library, real SQLite backup, archive
  validation, and scoped session operations all run successfully with capable `node:sqlite`.

The 24 LTS and 26 Current labels describe the v0.18.0 release date; the explicit versions above are
the durable gate. Runtime jobs perform a production tarball install without repository
devDependencies; a native dependency may still use host build tooling when no compatible prebuild
is available. Jobs fail on a wrong provider, wrong capability outcome, checksum/metadata mismatch,
or smoke failure. Protected approval depends on both this complete runtime matrix and the full
package/declaration/documentation verification.

## Source Read Limits v1 preflight

The preflight reads metadata only and retains no conversation content. For recognized Composer
SQLite databases it queries row counts and `length(value)` metadata without returning keys or
values. For cursor-history backup ZIPs it reads the central directory without extracting entries.
Its output contains only carrier counts, aggregate maxima, the locked policy fingerprint, exceeded
field names, and pass/fail.

Accepted inputs are limited to source carriers that cursor-history v0.16 could read:

- maintainer-owned live or custom Cursor Composer roots containing `globalStorage/state.vscdb`
  and/or `workspaceStorage/<id>/state.vscdb`;
- an explicitly selected recognized Cursor Composer `state.vscdb`; and
- cursor-history backup ZIPs containing `manifest.json` and Composer `state.vscdb` entries.

Never pass a vibe-history database or archive. The downstream archive is covered by the pinned
owner-authorized external T113 certification; it is deliberately outside this parser preflight. Store
databases, Store transcripts, exports, arbitrary SQLite files, and arbitrary ZIPs are also outside
this v0.16 compatibility measurement.

First create a private directory outside the repository. On POSIX, verify it is owner-only:

```sh
install -d -m 700 /private/path/cursor-history-release-check
node scripts/preflight-source-limits.mjs --check-policy
node scripts/preflight-source-limits.mjs \
  --composer-root /authorized/Cursor/User \
  --composer-root /authorized/custom/workspaceStorage \
  --backup /authorized/cursor-history-backup.zip \
  --output /private/path/cursor-history-release-check/source-limit-maxima.json
```

The evidence file is created exclusively with mode `0600`; an existing file is never overwritten.
Inspect the aggregate JSON locally. Do not retain commands containing paths, raw debug output,
database/ZIP files, exports, session IDs, workspace names, or the private directory path in the
repository, CI logs, release notes, issues, or pull requests.

`withinDefaults` must be `true`, `exceeded` must be empty, and `policyFingerprint` must match the
successful `--check-policy` result. A legitimate input above a default blocks release. Do not add an
override to vibe-history and do not automatically retry with a higher limit. Raise the inclusive v1
default, update and re-lock all of the following, then restart the affected work from T020:

- `spec.md`, `research.md`, `data-model.md`, `quickstart.md`, and `tasks.md` for feature 016;
- `contracts/internal-resolution.md`, `contracts/library-api.md`, and `contracts/cli-json.md`;
- `src/core/source-read-limits.ts`, all boundary/reset/override tests, and
  `docs/compatibility.md`; and
- the policy fingerprint in `scripts/preflight-source-limits.mjs` and every artifact marker checked
  by that script.

Rerun T020, T022, T057, T060, T063, T069, T085, T088, T092, T099, T105, and T110–T112 before the
preliminary full validation. Any later failure returns to the owning task and restarts the preflight
through release-candidate sequence.

## Private v0.16 full-corpus differential

Before repository freeze, compare the official `v0.16.0` tag and the candidate against the same
maintainer-owned Composer-only source in an owner-private directory outside this repository. This is
a one-time manual release certification, not a CI dependency on vibe-history or another checkout.
The repository's recurring CI remains self-contained and uses only deterministic synthetic Cursor
fixtures plus its generic public key/binding and complete/degraded/idempotence contract. The
owner-authorized external checkout must resolve to the recorded authorized revision (ARR); no exact
third-party adapter, digest, policy, SQLite schema/transaction, rollback, or downstream archive is
copied into recurring CI.

The private differential must cover every discovered session, not a sample. Compare every
pre-existing public library field, optional own-property, ordering rule, null/omission shape, message
binding, and tool binding separately from allowlisted additive fields and individually documented
versioned exceptions. Then, in that owner-authorized external ARR checkout, pass every normalized
session through the unchanged vibe-history adapter and its real sync policy/SQLite transaction:
import the v0.16 view, apply the candidate view, and apply it again. All old keys must retain their
original message/tool bindings, no row may be lost or duplicated, and the final repeated
synchronization must write nothing. Force one transaction failure and reopen the real external
database to prove complete rollback before the successful retry.

Do not introduce sampling, record caps, time budgets, or early success exits for this certification.
It is an infrequent manual release gate, so exhaustive validation takes precedence over runtime: use
an independent all-candidate association pass when needed to prove one-to-one session, message, and
tool bindings, even when the straightforward validation is quadratic in corpus size.

Never retain or print raw errors or diffs that can contain IDs, paths, titles, content, timestamps,
or stable hashes. Raw source, full outputs, comparison intermediates, and the downstream database
remain `0700`/`0600` private temporary artifacts and are deleted after certification. The retained
external record may contain only aggregate counts and named compatibility categories.

Real data is discovery evidence only. It must never be copied, transformed, redacted, hashed, or
used as generator input for a committed regression fixture. When it reveals a missing structural
case, hand-author the analogous case with fixed fictional values in the no-input synthetic fixture
generator, run deterministic regeneration/hash/sensitive-scan/poison checks, and rerun the focused
regression. Any resulting repository change invalidates the previous preflight/differential and
restarts T112–T113.

## External aggregate attestation template

Keep this record outside the repository. Replace every bracketed item with aggregate or abstract
information only. Delete the private raw inputs and working artifacts according to the maintainer's
local secure-data procedure after verification.

```text
revision/tag: [revision]
candidate sha256: [tarball sha256]
platform: [OS/architecture]
node: [version]
sqlite capability profile: [abstract profile]
source-limit policy: source-read-limits/v1
source-limit policy sha256: [fingerprint]
source-limit carrier counts: [aggregate Composer DB count / backup count]
source-limit maxima: [aggregate numeric map]
source-limit exceeded fields: []

operations:
- live-list: [pass/fail; redacted count]
- live-scoped-search: [pass/fail; aggregate low-level metadata/payload event totals]
- custom-path-export: [pass/fail; redacted count]
- backup-create-read: [pass/fail]

identity check: [pass/fail; salted one-run hashes only; salt not retained]
fidelity states: [aggregate complete/partial/ambiguous counts]
off-scope payload events: 0
poison-canary hits: 0
private modes: [aggregate mode results]
temporary residue count: 0
overall approval: [pass/fail]
```

Only a passing protected approval may publish the exact checksum-addressed tarball already tested.
Do not rebuild or repack after approval.
