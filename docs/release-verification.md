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
set -euo pipefail
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

## Private v0.16 deterministic structure-coverage certification (T113)

Before repository freeze, compare the official `v0.16.0` tag and the candidate against the same
maintainer-owned Composer-only source in an owner-private directory outside this repository. This is
a one-time manual release certification, not a CI dependency on vibe-history or another checkout.
The repository's recurring CI remains self-contained and uses only deterministic synthetic Cursor
fixtures plus its generic public key/binding and complete/degraded/idempotence contract. The
owner-authorized external checkout must resolve to the recorded authorized revision (ARR); no exact
third-party adapter, digest, policy, SQLite schema/transaction, rollback, or downstream archive is
copied into recurring CI.

Create the certification workspace as a fresh owner-private directory. Verify the source archive
against the maintainer-approved digest in memory, reject unsafe archive members, and extract it with
owner-only permissions. Before any parser or consumer lane runs, inventory the entire extracted tree
with a private path/type/mode/size/content manifest; compare the exact same inventory again from a
`finally` path after every handled success or failure. An uncatchable process termination invalidates
the run; keep any residue owner-private, explicitly refuse to reuse it, and delete it before a fresh
run. No formal result is valid if the tree changed, if the archive or extracted tree was reused from
an earlier exploratory run, if a non-owner-accessible artifact was created, or if any private
manifest/digest was retained in the external aggregate attestation. Delete the fresh extracted tree
and every private intermediate after certification.

Bind the run before dynamic imports or data access to the candidate revision and one
checksum-addressed pre-freeze packed candidate, the official v0.16 revision/tree/distribution
digest, the ARR revision and authorized source-blob inventory, the validation-harness manifest, the
runtime and resolved production-dependency tree, and the exact policy version. Any mismatch aborts
before source content is opened. The pre-freeze candidate is T113 evidence only; it is not the final
T115 release tarball. Before T113 completes, any repository edit invalidates it and restarts
T112–T113.

T113 first performs one single-pass, non-retaining structural inventory of the authorized v0.16
Composer-only source. The inventory may inspect every session only to compute the versioned
`t113-structure-coverage/v1` boolean/count predicates; it does not perform a full public-value
differential or run the downstream consumer for an unselected session. Every key in this finite
registry is required. “Observed” means that the source-only predicate is true for at least one
v0.16 logical session; it never means that the candidate emitted a value. The named synthetic test
group and mutant are required whether the key is covered by the real sample or only synthetically.

| Predicate key | Source-only/v0.16-oracle predicate | Synthetic test group | Required mutant |
|---|---|---|---|
| `id.native` | Message has its own non-empty string `id` | `v016-versioned-exceptions` | `native-id-rewrite` |
| `id.absent` | Message has no own `id` property | `v016-versioned-exceptions` | `absent-id-not-materialized` |
| `id.null` | Message has own `id === null` | `v016-versioned-exceptions` | `null-id-shape-collapse` |
| `id.empty` | Message has own `id === ""` | `v016-versioned-exceptions` | `empty-id-shape-collapse` |
| `type.user` | Released classifier returns `user` | `cli-formatters-table` | `user-role-reclassified` |
| `type.assistant` | Released classifier returns `assistant` | `cli-formatters-table` | `assistant-role-reclassified` |
| `type.tool` | Released classifier returns `tool` | `cli-formatters-table` | `tool-marker-or-structure-ignored` |
| `type.thinking` | Released classifier returns `thinking` | `cli-formatters-table` | `thinking-marker-reclassified` |
| `type.error` | Released classifier returns `error` | `cli-formatters-table` | `error-marker-reclassified` |
| `type.thinking-with-tool` | One `thinking` message also has a non-empty tool-call array | `cli-formatters-table` | `thinking-tool-hidden` |
| `type.error-with-tool` | One `error` message also has a non-empty tool-call array | `cli-formatters-table` | `error-tool-hidden` |
| `source.unknown-bubble-type` | Raw Composer numeric message type is outside `{1, 2}` | `storage-message-mapping` | `unknown-source-type-dropped` |
| `payload.fenced-code` | Message content contains a fenced block recognized by the v0.16 consumer | `v016-composer-upgrade` | `fenced-code-binding-dropped` |
| `shape.optional-present` | A released optional message field is present with a non-null value | `v016-versioned-exceptions` | `optional-present-omitted` |
| `shape.optional-undefined-own` | A released optional message field is own and `undefined` | `v016-versioned-exceptions` | `optional-undefined-omitted` |
| `shape.optional-omitted` | A released optional message field is absent | `v016-versioned-exceptions` | `optional-omitted-materialized` |
| `tool.single` | One message has exactly one tool call | `v016-composer-upgrade` | `single-tool-dropped` |
| `tool.multiple` | One message has at least two ordered tool calls | `v016-composer-upgrade` | `tool-order-collapsed` |
| `tool.completed` | A tool call has status `completed` | `v016-composer-upgrade` | `completed-status-rewritten` |
| `tool.cancelled` | A tool call has status `cancelled` | `storage-message-mapping` | `cancelled-status-rewritten` |
| `tool.error` | A tool call has status `error` | `v016-composer-upgrade` | `tool-error-rewritten` |
| `relationship.parent` | A message has a parent reference | `store-stack-merge` | `parent-binding-rewritten` |
| `relationship.sidechain` | Source marks at least one branch/sidechain message | `store-stack-merge` | `sidechain-admitted-active` |
| `relationship.active-branch` | Source carries active-branch or leaf selection metadata | `store-stack-merge` | `active-branch-member-dropped` |
| `time.message-created-at` | Message has a valid direct Composer `createdAt` | `v016-versioned-exceptions` | `created-at-source-rewritten` |
| `time.message-timing` | Message lacks valid `createdAt` and has valid Composer timing | `v016-versioned-exceptions` | `timing-source-rewritten` |
| `time.inferred-next` | Message lacks direct time and has a later direct message time | `v016-versioned-exceptions` | `next-anchor-ignored` |
| `time.inferred-previous` | Message lacks direct/later time and has an earlier direct message time | `v016-versioned-exceptions` | `previous-anchor-ignored` |
| `time.session-fallback` | No message direct anchor exists and stored session creation is valid | `v016-versioned-exceptions` | `session-anchor-ignored` |
| `time.unknown` | No message direct anchor or deterministic session anchor exists | `v016-versioned-exceptions` | `unknown-uses-read-time` |
| `time.session-created-stored` | Composer metadata has valid stored creation time | `storage-timestamps` | `stored-creation-rewritten` |
| `time.session-updated-stored` | Composer metadata has valid stored update time | `storage-timestamps` | `stored-update-rewritten` |
| `time.session-updated-from-message` | Stored update is absent and a direct message time exists | `storage-timestamps` | `message-update-anchor-ignored` |
| `time.session-epoch-unknown` | Stored and direct session anchors are all absent | `storage-timestamps` | `unknown-session-uses-read-time` |
| `scope.global-complete` | Logical session has a complete global Composer carrier | `workspace-index-roundtrip` | `global-carrier-degraded` |
| `scope.workspace-fallback` | Logical session has a workspace fallback carrier | `workspace-index-roundtrip` | `fallback-carrier-promoted` |
| `scope.real-path` | Workspace attribution is a real path | `workspace-index-roundtrip` | `real-path-rebound` |
| `scope.path-placeholder` | Workspace attribution is absent or a directory-ID placeholder | `v016-versioned-exceptions` | `placeholder-fabricated-path` |
| `occurrence.equivalent` | Two same-role physical occurrences have equal stable v0.16 projections | `session-replica-reconciliation` | `equivalent-replica-duplicated` |
| `occurrence.divergent` | Two same-role physical occurrences differ in stable v0.16 projections | `session-replica-reconciliation` | `divergent-replica-selected` |
| `occurrence.uuid-case-variant` | Canonically equal UUID occurrences use different case spellings | `composer-session-id-case-sensitivity` | `case-variant-physical-key-rewritten` |

For this registry, the released classifier is fixed as: `user` role first; otherwise the explicit
tool, thinking, and error content markers in that order; then a non-empty structured tool-call array;
otherwise `assistant`. “Released optional message field” means one of `thinking`, `model`,
`tokenUsage`, `durationMs`, `toolCalls`, or `metadata`. The named synthetic groups map
to these repository-owned, wholly synthetic tests:

- `v016-versioned-exceptions` →
  `tests/compatibility/v016-versioned-exceptions.test.ts`;
- `v016-composer-upgrade` → `tests/compatibility/v016-composer-upgrade.test.ts`;
- `cli-formatters-table` → `tests/unit/cli-formatters-table.test.ts`;
- `store-stack-merge` → `tests/unit/store-stack-merge.test.ts`;
- `storage-message-mapping` → `tests/unit/storage.test.ts`;
- `storage-timestamps` → `tests/unit/storage.test.ts` and `tests/unit/lib-index.test.ts`;
- `workspace-index-roundtrip` → `tests/integration/workspace-index-roundtrip.test.ts`;
- `session-replica-reconciliation` →
  `tests/integration/session-replica-reconciliation.test.ts`; and
- `composer-session-id-case-sensitivity` →
  `tests/integration/composer-session-id-case-sensitivity.test.ts`.

The T113 harness manifest maps each mutant name to a self-test and must prove that enabling it fails
certification.

Classification uses only raw source facts and the official v0.16 view. For each v0.16 logical
session, union the predicates of every physical contributor. Let `requiredObserved` be the union over
the source. Select at most eight logical sessions. Start with an empty selection and, while predicates
remain uncovered and fewer than eight sessions are selected, choose the unselected session covering the greatest number of currently
uncovered predicates; break a tie by the greater total number of registry predicates and then by the
earlier v0.16 global ordinal. IDs, paths, titles, content, timestamps, and hashes must not participate
in scoring or tie-breaking. Stop when all `requiredObserved` predicates are covered or eight sessions
have been selected. An empty corpus fails certification. Freeze the owner-private membership before
the candidate view is opened; never select from candidate output. Every still-uncovered registry
predicate must have the fictional/mutation mapping described below—the cap never expands
automatically.

The public v0.16-versus-candidate differential and unchanged-consumer real lane must use exactly the
same selected set. Within each selected session, compare every session, message, code-block, and tool
value; every own-property/null/omission shape; all ordering; and every key, relationship, and binding.
Candidate-only fields are permitted only when they appear in the locked additive-field allowlist,
and each such field must still satisfy its own type, value, provenance, and canonical-order contract;
“additive” is not a wildcard that suppresses drift. Every non-additive difference must satisfy
exactly one predicate in FR-006, FR-024, or FR-036. No record cap or early-success exit is permitted
inside a selected session. Exact forward/reverse maps, cardinality checks, and duplicate detection
may replace quadratic all-corpus enumeration.
Every required structural predicate absent from the selected real sample, whether because of the
eight-session cap or because it does not occur in the source, must map to a deterministic wholly
fictional regression and a mutation that proves drift is detected. A missing mapping blocks T113.

Create an owner-private sampled Composer source projection for the real consumer without modifying
the extracted source. Copy only the selected raw Composer carriers and their required membership
metadata. Copy per-session records byte-for-byte. When a shared carrier contains several sessions,
rebuild only its container while preserving each selected JSON subtree recursively, including keys,
values, own-property shape, and relative order. Prove that every selected stable v0.16 public value
and own-property shape equals the same session in the unmodified source, and give the public oracle,
public candidate, consumer oracle, and consumer candidate four isolated copies of one frozen
blueprint. Projection-local numeric indices, pagination totals, and page positions are contextual
addresses rather than stable source values: they may differ from the unmodified source, but they must
be exact between projected oracle and candidate results and round-trip inside each projection. Prove
that the projection contains zero unselected payload records, and include mutations for an unselected
carrier leak and an allowed index/page-context renumbering. For source-to-projection equality, the
only other excluded values are v0.16 read-time-derived timestamp fallbacks whose direct source is
absent; the projection must preserve the same absence predicate, and the projected
v0.16-versus-candidate comparison must classify the resulting scalar only under FR-024/FR-036. The
projection remains private and is deleted in `finally`; it is not a fixture and no derived value
enters the repository or the fictional lane. T113 then runs two
separately reported, mandatory external-consumer lanes from the same pinned owner-authorized ARR
checkout:

1. The **real-corpus lane** keeps Store provably empty and passes the selected Composer-only
   projection through the unchanged vibe-history adapter and its real sync policy/SQLite persistence
   path. Import the v0.16 view, repeat it with zero session/content mutations, apply the candidate
   view, compare every non-excepted selected durable old value and every selected
   key/relationship/binding, separately count each allowed predicate-guarded scalar correction, and
   apply the unchanged candidate again with zero session/content mutations. The logical snapshot and
   sequence must remain unchanged on both repeats. Each consumer synchronization still executes
   exactly one pre-existing `sync_metadata` schema-version upsert statement; instrument and report
   that bookkeeping DML separately for initial import, v0.16 repeat, candidate upgrade, and candidate
   repeat. The initial import may create the metadata row; later same-version invocations are
   value-preserving.
2. The **fictional-transaction lane** uses only fixed fictional Composer and Store values with that
   same unchanged adapter, comparison policy, digest, and real SQLite transaction. Import a fictional
   Composer baseline, force its candidate complete-replacement transition to fail late, reopen the
   database to prove exact pre-transaction rollback, retry the same transition successfully and prove
   it is complete, then repeat with zero session/content mutations. Report the one `sync_metadata`
   upsert statement separately for the baseline import, forced failure, retry, and final repeat. This
   lane must not
   copy, transform, hash into, or otherwise derive any ID, path, title, content, timestamp, ordering,
   or tool value from the real corpus. Its result must never be described as a Store transition
   observed in the real corpus.

Both lanes must pass before T113 passes. Evidence must distinguish the real-corpus compatibility
result from the fictional transaction result; neither lane substitutes for the other.

For write accounting, a **session/content mutation** is an insert, update, or delete of session,
message, relationship, code-block, or tool-call state. A **metadata upsert** is the unchanged
consumer's `sync_metadata` schema-version statement and is never folded into the content count. Count
one metadata-upsert statement for every synchronization attempt after target `open()` succeeds,
including a forced-failure attempt, and separately count logical metadata-value changes. The first
open of a fresh target inserts the schema-version row; subsequent same-version upserts execute one
statement but change zero logical metadata values. The upsert precedes the content transaction, so a
forced late failure still executes that one bookkeeping statement. For that failure, report both
attempted content statements and committed content mutations; after reopening, committed content
mutations and metadata-value changes must both be zero, and the exact pre-transaction logical content
snapshot must be restored.

The structural synthetic regressions run before this private pass and cover v0.16
`String.localeCompare()` equal-time workspace discovery, canonical UUID lookup versus exact
physical Composer keys, pointer-only membership with one opposite-case global carrier, and leading,
middle, and trailing Store-only active-branch turns under both preferred backbones. Compact 32-hex
non-UUID identifiers remain exact. Migration evidence also shows metadata-only off-scope projection
and complete-batch refusal before any write. Those deterministic regressions plus their mutations are
the exhaustive edge-case gate. The bounded private sample confirms that the selected structurally
rich real sessions introduce no unclassified public-value drift; it never derives a committed
fixture from real data and must never be described as full-corpus real-data certification.

The harness may emit fixed, non-sensitive progress events containing only a stage name and aggregate
selected/processed counts. It must never emit membership, IDs, paths, values, content-derived hashes,
or raw errors. Removing redundant pre-hydration is permitted, but each unchanged-consumer sync must
still execute the original provider/aggregator/SQLite call chain without return-value caching or
provider/target filtering.

Never retain or print raw errors or diffs that can contain IDs, paths, titles, content, timestamps,
or stable hashes. Raw source, full outputs, comparison intermediates, and the downstream database
remain `0700`/`0600` private temporary artifacts and are deleted after certification. The retained
external record may contain only non-private code/artifact bindings, aggregate counts, named
compatibility categories, and pass/fail assertions. It must not retain the source-archive digest,
raw-tree manifest, or any content-derived per-session digest.

Real data is discovery and bounded selected-session evidence only. Apart from the ephemeral
owner-private archive/tree integrity digests required above—which must be deleted and must not
enter aggregate evidence—it must never be
copied, transformed, redacted, hashed into, or otherwise used as input to a committed regression
fixture or the fictional lane. When the inventory reveals a required structural predicate not
already mapped to a deterministic regression and mutation, hand-author the analogous case with fixed
fictional values in the no-input synthetic fixture generator, run deterministic
regeneration/hash/sensitive-scan/poison checks, and rerun the focused regression. Any resulting
repository change invalidates the previous preflight/differential and restarts T112–T113.

T113 writes no repository file. Its result remains only in the owner-private external attestation
described below and is deleted under the maintainer's local secure-data procedure after the release
decision. No raw or aggregate real-data result, selected membership, derived value, or pass/fail
status is copied into this repository, a commit, a fixture, or recurring CI. T114 must prove that the
candidate revision and tracked tree are unchanged after T113; any repository edit invalidates the
candidate and restarts T112–T113.

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
set -euo pipefail
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
information only. They are separate gates: T113 binds its one pre-freeze candidate artifact but has
no final release-tarball hash, while T115 binds the later frozen revision to the formal workflow
artifact. Delete private raw inputs and working artifacts according to the maintainer's local
secure-data procedure after verification.

### T113 aggregate attestation

```text
task: T113
candidate_source_revision: [pre-freeze candidate revision]
candidate_artifact_sha256: [single pre-freeze packed candidate digest]
candidate_artifact_verified_before_import: [pass/fail]
v016_oracle_revision: [official v0.16.0 revision]
v016_oracle_tree: [official source tree]
v016_oracle_distribution_sha256: [built distribution digest]
external_consumer_arr: [authorized external revision]
external_consumer_provenance: [license and source-blob verification pass/fail]
validation_harness_manifest_sha256: [non-private harness manifest digest]
runtime_dependency_tree_sha256: [non-private resolved production tree digest]
source_archive_maintainer_digest_verified: [pass/fail; do not retain the digest]
fresh_safe_extraction: [pass/fail]
raw_tree_before_after_identical: [pass/fail and aggregate entry count; do not retain manifests]
owner_only_artifacts: [pass/fail]
platform: [OS/architecture]
node: [version]
source_inventory_counts: [aggregate sessions/messages/code-blocks/tools]
selection_policy: t113-structure-coverage/v1
real_sample_count: [1..8]
structure_registry_predicates: 41
structure_predicates_observed_in_source: [aggregate count]
structure_predicates_covered_by_sample: [aggregate count]
structure_predicates_covered_synthetically: [aggregate count]
structure_predicates_unmapped: 0
same_sample_public_and_consumer: [pass/fail]
sample_projection_selected_values_exact: [pass/fail]
sample_projection_unselected_payload_records: 0
public_sample_value_shape_differential: [pass/fail and aggregate category counts]
public_sample_association: [pass/fail and aggregate association counts]
real_sample_initial_import: [pass/fail]
real_sample_initial_import_session_content_mutations: [positive aggregate committed count]
real_sample_initial_import_sync_metadata_upserts: 1
real_sample_initial_import_sync_metadata_value_changes: 1
real_sample_v016_repeat_session_content_mutations: 0
real_sample_v016_repeat_sync_metadata_upserts: 1
real_sample_v016_repeat_sync_metadata_value_changes: 0
real_sample_candidate_upgrade: [pass/fail]
real_sample_candidate_upgrade_session_content_mutations: [aggregate committed count]
real_sample_candidate_upgrade_sync_metadata_upserts: 1
real_sample_candidate_upgrade_sync_metadata_value_changes: 0
real_sample_old_binding_preservation: [pass/fail and aggregate session/message/code-block/tool counts]
real_sample_durable_exception_counts: [aggregate FR-024/FR-036 predicate category counts]
real_sample_candidate_repeat_session_content_mutations: 0
real_sample_candidate_repeat_sync_metadata_upserts: 1
real_sample_candidate_repeat_sync_metadata_value_changes: 0
fictional_transaction_baseline_import: [pass/fail]
fictional_transaction_baseline_import_session_content_mutations: [positive aggregate committed count]
fictional_transaction_baseline_import_sync_metadata_upserts: 1
fictional_transaction_baseline_import_sync_metadata_value_changes: 1
fictional_transaction_forced_failure: [pass/fail]
fictional_transaction_forced_failure_attempted_session_content_mutations: [positive aggregate statement count]
fictional_transaction_forced_failure_committed_session_content_mutations: 0
fictional_transaction_forced_failure_sync_metadata_upserts: 1
fictional_transaction_forced_failure_sync_metadata_value_changes: 0
fictional_transaction_rollback_reopen: [pass/fail with exact pre-transaction state restored]
fictional_transaction_retry_complete_replacement: [pass/fail]
fictional_transaction_retry_session_content_mutations: [positive aggregate committed count]
fictional_transaction_retry_sync_metadata_upserts: 1
fictional_transaction_retry_sync_metadata_value_changes: 0
fictional_transaction_final_repeat_session_content_mutations: 0
fictional_transaction_final_repeat_sync_metadata_upserts: 1
fictional_transaction_final_repeat_sync_metadata_value_changes: 0
fictional_transaction_real_values_derived: 0
documented_drift_categories: [aggregate additive/exception counts]
private_modes: [aggregate mode results]
temporary_residue_count: 0
private_material_deleted: [pass/fail]
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
