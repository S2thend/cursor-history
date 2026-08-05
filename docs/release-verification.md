# Private Release Verification

This procedure is for the maintainer who owns and is authorized to inspect the Cursor data used for
the release check. It is not suitable for CI, contributor data, shared-machine data, customer data,
or an attached issue/PR artifact.

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
unchanged-consumer compatibility harness; it is deliberately outside this parser preflight. Store
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
