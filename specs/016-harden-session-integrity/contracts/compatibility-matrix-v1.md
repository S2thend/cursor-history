# Compatibility Matrix v1 — Design Contract Projection

**Feature**: `016-harden-session-integrity`
**Contract version**: `1`
**Normative source**: [`../spec.md`](../spec.md), “Compatibility Matrix v1”

This file is the design-time contract projection of the specification's normative matrix. It does
not define a second matrix and is not itself included in the npm package. If the two differ, the
specification is authoritative and this projection must be corrected before implementation. The
published package repeats the verified matrix in `docs/compatibility.md`.

`Required` cells are release-blocking scenarios. `Unsupported` cells describe behavior the product
must reject rather than silently approximate. `N/A` means the carrier cannot contain that
representation under the supported contract. Supported backup archives capture Composer
`state.vscdb` data only; they do not capture Store databases, Store transcripts, Store metadata, or
merged source sets.

| Source representation or resolution scenario | Live default path | Custom data path | Supported backup | Expected result / preferred orientation |
|---|---|---|---|---|
| Composer global | Required | Required | Required | Complete Composer |
| Composer workspace fallback | Required | Required | Required | Degraded Composer fallback |
| Store database conversation | Required | Required | N/A | Complete Store database |
| Store transcript with no discovered or expected database | Required | Required | N/A | Complete transcript primary |
| Store transcript after an expected database fails | Required | Required | N/A | Degraded transcript fallback |
| Store transcript selected instead of a usable Store database | Unsupported | Unsupported | N/A | Reject; database remains Store backbone |
| Complete Composer/Store merge, Composer-preferred ordering | Required | Required | N/A | Complete merged, Composer-preferred |
| Complete Composer/Store merge, Store-preferred ordering | Required | Required | N/A | Complete merged, Store-preferred |
| Scoped merged UUID with a known contributor outside the default workspace I/O boundary | Required | Required | N/A | Explicit partial with omitted contributor; never silent single-source completeness |
| Scoped merged UUID with explicit selected-UUID cross-workspace contributor opt-in | Required | Required | N/A | Complete merged with every broadened contributor disclosed |
| Store metadata indicating a possible conversation but no usable payload | Required | Required | N/A | Metadata-only degraded row |
| Equivalent same-role Composer replicas | Required | Required | Required | One reconciled logical row |
| Divergent same-role Composer replicas | Required | Required | Required | One unresolved ambiguity row |
| Equivalent same-role Store replicas | Required | Required | N/A | One reconciled logical row |
| Divergent same-role Store replicas | Required | Required | N/A | One unresolved ambiguity row |
| Automatic selection or union of divergent replicas | Unsupported | Unsupported | Unsupported | Reject; never resolve silently |

Adding a source representation, carrier, or preferred-orientation rule must increment the matrix
version or explicitly classify every new cell before release. Every `Required` cell must have an
executable fixture, every `Unsupported` cell must have a rejection test, and `N/A` cells must never
be counted as successful supported coverage. Capability discovery from the implementation under
test cannot remove or reclassify a cell.

## Verification notes

- Both preferred merge orientations preserve matched Composer identity, v0.16 Composer fallback
  keys, Composer tool order, and rewritten relationships.
- The confirmed no-consumer-change archive transition remains v0.16 Composer-only to a complete
  Composer-backed merged live/custom-path view. The unchanged test-only vibe-history adapter owns
  persistence, transaction, and rollback; its revision/source blobs and SQLite schema are pinned,
  and rollback is verified against a deterministic synthetic database after close/reopen.
- The committed v0.16 raw-layout SQLite fixture is deterministic and wholly synthetic, with a
  logical-content manifest, reproducible generation instructions, SHA-256, and a sensitive-pattern
  scan.
- Defensive JSONL/SQLite/ZIP parsing, platform permission applicability, fatal JSON stderr
  migration, backup producer semantics, and packed-schema validation are cross-cutting acceptance
  gates defined by the linked specification; they do not add source/carrier rows to this matrix.
