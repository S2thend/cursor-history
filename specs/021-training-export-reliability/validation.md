# Validation: training export reliability

Date: 2026-10-26. Based on `32d1da3` in `maintainer/pr41-improvements`.

## Verified behavior

- Existing messages, ShareGPT and TRL records retain their content and split assignments.
  The legacy ShareGPT view is created once on demand; messages/TRL serialization never invokes it.
- Real-file publication tests cover successful replacement, empty splits, abandoned exports,
  appearing destinations, injected stream failure, later-file publication failure, rollback,
  retained recovery copies, path aliases and non-regular outputs. Identity checks use bigint
  device/inode values. Files are staged privately; no partial file is published.
- Built CLI tests verify all prior outputs survive a late missing-tool-definition error after
  a valid record has been staged, successful empty splits clear stale data, report JSON equals
  stdout JSON, and progress is stderr-only, plain when redirected and opt-in for JSON mode.
- Quality tests count explicit partial/unknown sources, actual truncations, tool failures,
  cancellations, missing results and dropped segments. Discarded segments do not inflate emitted
  tool/truncation counts; source marker strings do not fake truncation counts.
- Publish-workflow tests retain the tag-only trigger and source-quality dependency. Removing the
  real TRL smoke command is detected. No PR or ordinary branch-push workflow was added.

## Checks

- Typecheck, ESLint, Prettier check, and ESM/CommonJS/UI build: passed.
- Initial full suite: 1,807 passed, 0 failed, 1 allowed platform skip.
- Focused post-review suite: 47 passed (CLI, staging, quality, progress and publish workflow).
- Final full suite on the completed source: **1,808 passed, 0 failed, 1 allowed platform skip**
  (1,809 total), including the repository result verifier.
- Actual offline TRL CPU smoke: passed with the production synthetic export fixture and one
  optimization step. Python 3.13.5, torch 2.14.1+cpu, TRL 1.16.0, Transformers 5.20.2,
  Datasets 5.1.0. Uses the same local-tokenizer/offline-model path configured for publish.

## Boundaries

The GitHub workflow configuration was verified locally; no release tag was pushed and no publish
was triggered. Synthetic data and injected filesystem failures validate the integration, not a
private corpus or model quality. Publication is atomic per file with rollback for handled errors,
not crash-atomic across files. Forced concurrent writers are not supported; abrupt termination
may leave private staging directories. Rollback failures retain and report recovery locations.
