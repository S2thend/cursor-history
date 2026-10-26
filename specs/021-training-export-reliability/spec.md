# Training export reliability, quality and publish verification

## Requirements

- Stage train/validation/optional report files in private sibling directories. Finish every write
  before publishing complete files. Preserve existing targets on projection/write errors; roll back
  earlier publications if a later publication fails. Never clobber an appearing target without
  --force. Report recovery paths if rollback itself fails. This is per-file atomic publication,
  not a crash-atomic multi-file transaction. Empty successful splits replace stale content.
- Keep existing messages/ShareGPT bytes and projection fields compatible. Make legacy shareGpt
  access lazy/memoized; CLI serialization converts only the record actually being emitted.
- Aggregate quality counters from actual extraction/truncation decisions, not marker matching.
  Count partial/unknown source sessions separately from emitted tool and truncation counters.
  Expose quality in JSON/human summaries and an optional --report file. No implicit filtering.
- Show training export scan/process/finalization progress on stderr. Default on human TTYs;
  --progress enables plain lines for logs/JSON mode, --no-progress disables it. Throttle updates,
  finish/clear on success and failure, and never contaminate stdout JSON.
- Add a pinned CPU-only, offline-model TRL smoke check exclusively to the existing tag-triggered
  npm publish workflow. No new workflow or PR/ordinary-push trigger. A failed check blocks publish.
- Update docs and verify failure preservation, rollback, empty splits, lazy conversion, exact
  quality counts, progress modes, publish gating, full Node checks and actual TRL smoke.
