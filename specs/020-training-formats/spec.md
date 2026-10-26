# Reusable training formats and TRL integration

## Scope

Promote reusable coding conversations as a primary feature. Keep the existing messages
default and ShareGPT export compatible; add an explicit TRL profile without new Node runtime
dependencies or changes to source history.

## Requirements

1. One projection owns message extraction, sanitization, segmentation and provenance. A separate
   reusable format module owns messages/ShareGPT/TRL conversion and JSONL serialization.
   Preserve existing core imports through re-exports and existing projection return fields.
2. `--schema trl` emits role/content messages with object-valued function arguments and correlated
   tool responses. Tool-enabled TRL exports require a user-supplied `--tools-file` containing
   function JSON schemas; never infer original definitions from observed calls. Messages exports
   may optionally carry these definitions as well. Reject malformed or missing definitions with
   actionable errors. Keep extensions such as status, reasoning and provenance explicit.
3. ShareGPT retains its current human/gpt mappings and textual tool/reasoning extensions.
   Existing messages keep string-valued arguments. Format conversion does not mutate input.
4. A runnable Python example loads JSONL and renders the target tokenizer's chat template before
   Arrow ingestion, preserving heterogeneous tool arguments without schema coercion. Support
   validation-only preprocessing and SFT training; do not silently truncate long conversations.
5. Document the feature prominently in English and Chinese, with text-only and tool-enabled
   workflows, format boundaries, model-template requirements and reproducible verification.

## Validation

- Regressions for unchanged messages/ShareGPT, nested arguments and sanitization, tool definitions,
  unknown additive fields, parallel call correlation, errors and grouped split consistency.
- Built CLI fixtures exercise all three formats, invalid inputs and tool-free TRL export.
- Real Python Transformers/TRL smoke test: exported JSONL, chat template, dataset preparation and
  one CPU optimization step with a tiny local model. No pretrained weights or user data required.
- Typecheck, lint, build and the repository test suite; record exact Python dependency versions
  and distinguish pipeline compatibility from model quality or real-corpus validation.
