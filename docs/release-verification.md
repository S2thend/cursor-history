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
or smoke failure. The actual `publish` job depends directly on both this complete runtime matrix
and the full package/declaration/documentation verification. That job uses the protected
`npm-release-verification` environment, so maintainer approval occurs on the same job that later
requests the npm OIDC token and publishes the preserved candidate.

The exact-candidate smoke uses one topology-valid fictional Store workspace: `meta.cwd` is
`/work/a`, the chat directory is keyed by MD5 of `/work/a`, and the project directory uses the
forward-sanitized `/work/a` token. Scoped list/show/search must round-trip the same session without
relaxing workspace discovery. Its backup assertion preserves the settled BB version split: outer
`manifest.version` is exactly `"1.0.0"`, optional
`composerWorkspaceInventory.schemaVersion` is exactly `1`, and a legacy v1 manifest without the
inventory remains readable.

## Official release-candidate handoff

The official release candidate is the artifact produced by the tag-triggered
`.github/workflows/npm-publish.yml` workflow, not a tarball packed on a maintainer workstation. After
T114 passes, tag that exact frozen revision with `v0.18.0` (the `v` prefix plus the current
`package.json` version) and start the workflow. Leave the protected publish job unapproved until the
private T115 verification below passes. Wait for source validation, every runtime-candidate job, and
the full package verification before treating the candidate as eligible for approval.

Download the `npm-candidate-<sha256>` artifact from that exact workflow run into an owner-private
directory. It must contain exactly one `.tgz` file plus `candidate.sha256` and
`candidate-metadata.json`. Recompute the tarball SHA-256 directly and require all of these bindings:

- `candidate.sha256` validates the downloaded tarball;
- the recomputed digest equals both the artifact-name suffix and
  `candidate-metadata.json.sha256`;
- `candidate-metadata.json.revision` equals the frozen T114 revision and the tagged commit;
- `candidate-metadata.json.version` equals the current `package.json` version;
- `candidate-metadata.json.tag` equals `v` followed by that version; and
- `candidate-metadata.json.tarball` equals the downloaded tarball filename.

Any missing file, additional tarball, checksum mismatch, metadata mismatch, or workflow-run mismatch
invalidates the candidate. Do not rebuild, repack, substitute, rename, or modify it. In particular,
do not run a local `npm pack` to replace the official artifact.

On a POSIX release host, record the run ID and checksum suffix from the protected workflow without
including private-data paths. From the clean frozen T114 checkout, use this sequence; values in
angle brackets are mandatory operator inputs, not defaults:

```sh
umask 077
test -z "$(git status --porcelain=v1 --untracked-files=all)"
FROZEN_REVISION="$(git rev-parse HEAD)"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
RUN_ID='<tag-workflow-run-id>'
CANDIDATE_SHA256='<64-character-artifact-checksum-suffix>'
PRIVATE_RELEASE_ROOT='<owner-private-absolute-directory>'
install -d -m 700 "$PRIVATE_RELEASE_ROOT/candidate"
gh run download "$RUN_ID" \
  --name "npm-candidate-$CANDIDATE_SHA256" \
  --dir "$PRIVATE_RELEASE_ROOT/candidate"
cd "$PRIVATE_RELEASE_ROOT/candidate"
test "$(find . -maxdepth 1 -type f -name '*.tgz' | wc -l)" -eq 1
CANDIDATE_TARBALL="$(find . -maxdepth 1 -type f -name '*.tgz')"
sha256sum -c candidate.sha256
ACTUAL_SHA256="$(sha256sum "$CANDIDATE_TARBALL" | cut -d ' ' -f 1)"
test "$ACTUAL_SHA256" = "$CANDIDATE_SHA256"
node -e 'const fs=require("node:fs"); const [file,sha,revision,version]=process.argv.slice(1); const metadata=JSON.parse(fs.readFileSync("candidate-metadata.json","utf8")); const expected={sha256:sha,revision,version,tag:`v${version}`,tarball:file.replace(/^\.\//u,"")}; for (const [key,value] of Object.entries(expected)) { if (metadata[key] !== value) throw new Error(`candidate metadata mismatch: ${key}`); }' \
  "$CANDIDATE_TARBALL" "$CANDIDATE_SHA256" "$FROZEN_REVISION" "$PACKAGE_VERSION"
```

Keep the workflow publish job waiting for protected-environment approval after these commands. A
failed command discards this candidate and returns the release to the owning task; it never permits
an operator to repair the artifact in place.

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

## Private v0.16 full-corpus differential (T113)

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

The structural synthetic regressions run before this private pass and cover v0.16
`String.localeCompare()` equal-time workspace discovery, canonical UUID lookup versus exact
physical Composer keys, pointer-only membership with one opposite-case global carrier, and leading,
middle, and trailing Store-only active-branch turns under both preferred backbones. Compact 32-hex
non-UUID identifiers remain exact. Migration evidence also shows metadata-only off-scope projection
and complete-batch refusal before any write. The private pass confirms that these fixes introduce no
unclassified public-value drift; it never derives a committed fixture from real data.

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

## Exact-tarball maintainer verification (T115)

Create a fresh owner-private runner outside the repository and perform a production install whose
cursor-history package source is only the verified official `.tgz` from the handoff above. Load the
library through the installed package name, `import 'cursor-history'`, and invoke the CLI through the
package bin installed in that runner. Do not use `npm link`, run `npm pack` or `npm run build`, import
from the repository `src/`, invoke the repository `dist/`, or fall back to a registry installation.
The runner may use external read-only I/O instrumentation, but every cursor-history operation must
execute code installed from the formal tarball.

Continue from the verified absolute tarball path and private root above. This bootstrap proves both
entry points resolve from the production-only install before any private-data operation begins:

```sh
CANDIDATE_TARBALL="$(cd "$(dirname "$CANDIDATE_TARBALL")" && pwd)/$(basename "$CANDIDATE_TARBALL")"
install -d -m 700 "$PRIVATE_RELEASE_ROOT/runner"
cd "$PRIVATE_RELEASE_ROOT/runner"
npm init --yes >/dev/null
npm install --omit=dev --no-audit --no-fund --save-exact "$CANDIDATE_TARBALL"
unset NODE_PATH
node --input-type=module -e "const api = await import('cursor-history'); if (typeof api.listSessions !== 'function') process.exit(1)"
./node_modules/.bin/cursor-history --version
```

Do not add the current checkout, a global installation, or a registry copy to this runner's module
or executable search path. The checkout supplies only the already-audited verification helper and
test procedure; the product library and CLI under test come from the installed tarball bytes.

Use only maintainer-owned data. Keep the source archive, extracted tree, commands embedding private
paths, complete library/CLI output, errors and diffs, IDs, paths, titles, content, timestamps,
exports, backups, downstream databases, and all intermediate artifacts in `0700` directories with
`0600` files. Only the official candidate SHA-256 and one-run salted identity comparisons may leave
that private workspace; do not retain the salt or any raw identity hash.

Exercise this matrix. `live` means the normal public path with no caller-supplied `dataPath`;
`custom-path` means the same authorized Composer root selected explicitly; `created-backup` means a
new archive produced by the installed candidate and then read again. Choose workspace filters,
search terms, numeric indices, and IDs inside the private runner so none are retained in commands or
logs.

| Source | Library operations | CLI operations |
|---|---|---|
| `live` | `list`, `show-index`, `show-id`, `search`, `export-json`, `export-markdown`, `backup-create` | `list`, `show-index`, `show-id`, `search`, `export-json`, `export-markdown`, `backup-create` |
| `custom-path` | `list`, `show-index`, `show-id`, `search`, `export-json`, `export-markdown`, `backup-create` | `list`, `show-index`, `show-id`, `search`, `export-json`, `export-markdown`, `backup-create` |
| `created-backup` | `list`, `show-index`, `show-id`, `search`, `export-json`, `export-markdown` | `list`, `show-index`, `show-id`, `search`, `export-json`, `export-markdown` |

Compare index and ID reads with one-run salted associations, confirm JSON and Markdown exports cover
the same logical sessions, and record only aggregate complete/partial/ambiguous fidelity counts.
Trusted low-level instrumentation must report aggregate metadata and payload event totals, zero
off-scope payload events, and zero poison-canary hits. Verify owner-private modes throughout and zero
temporary residue after success and handled failure checks. Delete the fresh runner, extracted copy,
outputs, exports, backups, databases, salt, and raw evidence after the attestation is reviewed; do not
delete the maintainer's original source archive without separate authorization.

## External aggregate attestations

Keep both records outside the repository. Replace every bracketed item with aggregate or abstract
information only. They are separate gates: T113 runs before the final checklist freeze and therefore
has no official tarball hash, while T115 binds the later frozen revision to the formal workflow
artifact. Delete private raw inputs and working artifacts according to the maintainer's local
secure-data procedure after verification.

### T113 aggregate attestation

```text
task: T113
candidate_source_revision: [pre-freeze candidate revision]
v016_oracle_revision: [official v0.16.0 revision]
external_consumer_arr: [authorized external revision]
external_consumer_provenance: [license and source-blob verification pass/fail]
platform: [OS/architecture]
node: [version]
corpus_counts: [aggregate sessions/messages/tools]
public_value_shape_differential: [pass/fail and aggregate category counts]
all_candidate_association: [pass/fail and aggregate association counts]
unchanged_consumer_initial_import: [pass/fail and aggregate writes]
forced_transaction_failure: [pass/fail]
transaction_rollback_reopen: [pass/fail with exact pre-transaction state restored]
candidate_retry: [pass/fail and aggregate writes]
old_key_binding_preservation: [pass/fail and aggregate session/message/tool counts]
repeated_sync_writes: 0
documented_drift_categories: [aggregate additive/exception counts]
private_modes: [aggregate mode results]
temporary_residue_count: 0
overall_result: [pass/fail]
```

### T115 aggregate attestation

```text
task: T115
frozen_revision_tag: [revision/tag]
official_artifact: [npm-candidate-<sha256>]
candidate_sha256: [tarball sha256]
candidate_metadata_binding: [pass/fail]
platform: [OS/architecture]
node: [version]
sqlite_capability_profile: [abstract profile]
formal_tarball_install: [pass/fail]
operation_matrix: [pass/fail with aggregate counts]
source_limit_policy: source-read-limits/v1
source_limit_policy_sha256: [fingerprint]
source_limit_carrier_counts: [aggregate Composer DB count / backup count]
source_limit_maxima: [aggregate numeric map]
source_limit_exceeded_fields: []
identity_check: [pass/fail; salted one-run hashes only; salt not retained]
fidelity_states: [aggregate complete/partial/ambiguous counts]
io_event_totals: [aggregate metadata/payload totals]
off_scope_payload_events: 0
poison_canary_hits: 0
private_modes: [aggregate mode results]
temporary_residue_count: 0
overall_approval: [pass/fail]
```

Only a passing protected approval may publish the exact checksum-addressed tarball already tested.
Do not rebuild or repack after approval.
