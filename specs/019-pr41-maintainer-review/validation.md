# Validation

Base: PR #41 head `99ca1090dfc4e75f1fb091c9c2ce0876cfeb4ab3`.
Environment: Linux, Node.js 24.18.0; synthetic fixtures only.

- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Full suite: `vitest run --no-file-parallelism --reporter=json --outputFile=.vitest-results.tmp`
  followed by `npm run test:verify`: 1,750 passed, zero failures, one allowed platform skip.
- After extending shared detection to retain the old fixture scanner's conservative assignment
  policy, reran typecheck/lint/build and the affected suites: sensitive data, training, v0.16
  fixture regeneration/safety, and prefix equivalence. All 75 tests passed. The full-suite count
  above precedes those three additional sensitive-data cases.
- Both better-sqlite3 and node:sqlite ran the prefix contract with BINARY and NOCASE schemas:
  18 explicit edge IDs, 64 deterministic generated IDs, missing/empty prefixes, three page sizes,
  signed/large row IDs, nullable payloads and unknown future JSON fields.
- Mutation check: temporarily removed the NUL fallback, restoring GLOB-only matching. Four of
  six prefix regression tests failed on both drivers. Restored source passed all six tests.
- UI integration tests cover live-source changes, shared session/export validation, HEAD, repeated
  shutdown and cache eviction; client tests execute the shipped JS in a minimal DOM/HTTP harness
  to verify stale-response exclusion, explicit refresh, text-only rendering and immutable filtering.
- Catalog timestamp integration tests cover missing endpoint timestamps and out-of-order extrema.

The UI cache caps entry count, not bytes; a single large catalog or search can still be large.
Detail reads intentionally resolve fresh data rather than retaining decoded sessions between HTTP
requests. Sensitive-text rules are heuristic credential protection, not complete anonymization of
arbitrary personal data. No real-history validation or manual browser visual inspection was run.
