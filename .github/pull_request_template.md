## Summary

<!-- What user-visible problem does this PR solve? Keep unrelated changes in separate PRs. -->

## Validation

- [ ] Typecheck passes
- [ ] Lint and formatting checks pass
- [ ] Unit/integration/e2e tests pass with no unexpected skip, timeout, cancellation, or zero-test run
- [ ] Built CLI and exact packed-artifact checks pass when public/package behavior changes
- [ ] Manual verification, if required, used only maintainer-authorized data and recorded no content,
      raw path, credential, machine identifier, or user-derived fixture

## Public compatibility and source fidelity

The [project constitution](../.specify/memory/constitution.md), especially Principle VI, applies to
every public value a consumer can persist, compare, address, deduplicate, or use for incremental
synchronization. Complete this section for every such changed or new value. “Internal refactor” is
not sufficient if observable output can change.

- [ ] This PR changes no stable public returned value. Explanation:

<!-- If checked, explain how that was verified and remove/mark the inventory below N/A. -->

### Compatibility evidence inventory

For feature 016 work, this table must cover **100%** of changed/new public returned values, including
values nested in CLI JSON, library objects, exports, errors, help/package declarations, identities,
ordering, paths, timestamps, fidelity, and provenance.

| Public value / surface | Compatibility disposition (`preserved`, `additive`, or `versioned migration`) | Affected released version(s) and locked fixture | Regression test / mutation proving the guard | Migration, warning, or pinning note | Source-fidelity/provenance evidence |
|---|---|---|---|---|---|
| <!-- e.g. Message.id / library + JSON --> | <!-- exact before/after semantics --> | <!-- tag + fixture path/hash --> | <!-- test path/name --> | <!-- none with reason, or shipped guidance --> | <!-- complete/partial and original-source evidence --> |

Add rows as needed. Do not group values whose compatibility disposition or evidence differs.

### Required review questions

- [ ] Native Cursor session/message/tool identifiers remain byte-for-byte unchanged when available.
- [ ] Any synthetic identifier is deterministic, versioned, assigned before merge/filter ordering,
      and regression-tested against every affected supported release.
- [ ] Logical UUIDs remain separate from physical locators, workspace membership, provenance, and
      ephemeral indices; no private locator is exposed in public/default output.
- [ ] Existing index bases and scope/lifetime are preserved and documented, or an intentional
      migration is versioned and tested.
- [ ] Existing public field names, types, values, ordering, stream placement, and error/exit
      semantics are preserved unless each exception has a versioned migration row above.
- [ ] Complete data remains replacement-safe; partial/degraded data is explicitly marked and cannot
      overwrite a complete view.
- [ ] `source` fidelity and actual `resolvedSource`/`sources`/`resolution` provenance are tested
      independently; content is associated with the correct UUID and workspace path.
- [ ] Direct versus inferred timestamp provenance is retained and no inferred value is presented as
      exact source data.
- [ ] Round-trip and idempotent incremental-upgrade coverage exists for each affected release,
      including first replacement/rollback where persistence changes and a no-op repeated sync.
- [ ] The changelog and shipped compatibility documentation contain an actionable migration or
      pinning path for every intentional incompatibility.

## Fixtures and privacy

- [ ] Every compatibility fixture is deterministic and synthetic, identifies its affected release,
      generator/provenance, logical inventory, and cryptographic hash.
- [ ] Fixture regeneration and sensitive-pattern scanning pass, including the poison mutation that
      proves the scanner can fail.
- [ ] No test or fixture reads a live adjacent consumer checkout, Cursor root, user archive,
      environment-derived identity/content, raw user path, credential, or machine identifier.

## Documentation and release impact

- [ ] Public API declarations/JSDoc, CLI help, README/localized canonical links,
      `docs/compatibility.md`, and CHANGELOG are updated where applicable.
- [ ] New/changed examples run against the built CLI or typecheck/run against the exact packed
      package.
- [ ] Compatibility Matrix and Source Read Limits projections remain byte-for-byte aligned with
      their normative versioned contracts, or the policy/matrix version is intentionally advanced.
- [ ] Package contents and release workflow include every required shipped contract and fail closed
      before publication.

## Reviewer notes

<!-- Call out residual risk, deliberately unsupported behavior, follow-up work, and rollback plan. -->
