# PR #41: UI simplification, shared sensitive-data rules, and prefix compatibility

## Scope

Keep the local UI and training export features while preserving released source identity,
timestamp, parsing, and read-limit contracts. No new runtime dependencies.

## Requirements

1. UI reads own and dispose their scoped read context per operation. Repeated catalog/search
   responses remain cached for 60 seconds with a finite entry cap and concurrent-request
   deduplication. Refresh must read current source data rather than a stale context snapshot.
   Session details and exports share one lookup/error path. Shutdown is idempotent.
2. Repeated browser controls use small shared rendering helpers. History stays text-only.
   Late navigation responses cannot replace the active view. Refresh is explicit, not timed.
3. A dependency-free core sensitive-data module owns credential detection/redaction and home
   path anonymization. Training calls it before JSON serialization, including display metadata.
   Fixture scans reuse credential rules, retaining their stricter fixture-only privacy checks and
   stable diagnostic names. Catalog title masking and terminal path formatting remain separate.
4. Exact-prefix readers must match the released BLOB-prefix predicate: byte-exact identity,
   signed row-ID order, NULL payload visibility, finite pages, and unchanged limit/cancellation
   outcomes. GLOB may accelerate ordinary TEXT prefixes; NUL-containing prefixes retain byte
   matching. Unknown payload fields and noncanonical IDs must not change results.
5. Missing Composer session times use extrema of all valid direct message times, independent
   of physical insertion order. Compute extrema incrementally with bounded retention.

## Validation

- Real SQLite differential fixtures compare production prefix readers to the released SQL on
  both available drivers, including literal metacharacters, Unicode, NUL, collations, signed
  row IDs, and deterministic generated identifiers. No SQL mocks as equivalence evidence.
- Mutation check: the original PR's GLOB-only predicate must fail the NUL regression.
- Shared-rule tests cover detection, redaction, repeatability, structured JSON and fixture poison
  checks. Existing training and v0.16 fixture hashes must remain valid.
- UI tests cover refresh after source changes, request isolation, errors, cache lifecycle and
  repeated shutdown; browser checks cover text safety and out-of-order responses.
- Run typecheck, lint, build, relevant integration/compatibility tests, then the full suite.
