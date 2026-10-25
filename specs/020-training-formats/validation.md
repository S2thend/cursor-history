# Training export validation

Date: 2026-10-25. Checkout: `maintainer/pr41-improvements` based on `22cbb25`.

## Node/TypeScript

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed (ESM, CommonJS and UI assets).
- Full Vitest suite with one worker and the repository result verifier:
  **1,785 passed, 0 failed, 1 allowed platform skip** (1,786 total).
- New tests cover unchanged messages/ShareGPT serialization, nested JSON arguments, explicit
  tool definitions, additive schema extensions, shared sanitization, parallel call correlation,
  malformed input, all three built CLI profiles, identical grouped splits and stream failures.
- Full-suite testing exposed a pre-existing output-finalization race: sequential finish listeners
  could miss the second split's completion and exit without a report. Completion promises now
  attach at stream creation and are awaited together. The full suite passes with both splits.
- After the Python return-type fix, the final package/documentation suite was rerun: **10 passed**.
- Package smoke tests include the optional Python examples and verify packaged Markdown links.
  The new guide and examples are shipped; no Python dependency is added to the Node runtime.

## Python integration

Verified with Python **3.13.5**, PyTorch **2.14.1+cpu**, TRL **1.16.0**, Transformers
**5.20.2**, Datasets **5.1.0**, PyArrow **26.0.0**, Tokenizers **0.23.3** and Accelerate
**1.15.0**. The optional example pins TRL/Transformers/Datasets; PyTorch installation is
hardware-specific and documented separately.

- `node tests/trl/export-fixture.mjs /tmp/cursor-history-trl.jsonl`: exported three synthetic
  examples through production projection/serialization, including parallel calls, nested arrays,
  booleans/null, one parameter with object versus string values, and a text-only record.
- `python tests/trl/smoke.py /tmp/cursor-history-trl.jsonl`: passed with a local tokenizer and tiny
  randomly initialized GPT-2 model. TRL completed one CPU optimization step with finite loss.
- The same smoke test with `--tokenizer Qwen/Qwen2.5-0.5B-Instruct`: passed using the actual Qwen
  chat template (revision `7ae557604adf67be50417f59c2c2f167def9a775`) and the same tiny local model architecture (not Qwen model weights). It verifies
  that tool definitions, nested arguments and tool output survive template rendering. One CPU
  optimization step completed with finite loss.
- `python examples/training/train.py /tmp/cursor-history-trl.jsonl --model
  Qwen/Qwen2.5-0.5B-Instruct --check`: passed, preparing all three records with the documented CLI.
- Negative/regression checks pass: token overflow raises an actionable error, arguments are not
  padded with unrelated null fields, and overwriting a JSONL path changes the prepared dataset.
- Actual-framework testing caught Transformers' dictionary return default: tokenization now
  explicitly sets `return_dict=False`, so token-length checks and TRL receive token ID lists.

Only tokenizer assets were downloaded from Hugging Face. The CPU smoke tests use synthetic
conversations and random local weights; they are integration tests, not model quality evaluations.

## Scope

Synthetic fixtures exercise the production projector and serializers. Source reads and CLI
integration are separately covered by the built CLI tests. This does not certify a contributor's
private Cursor corpus, model quality, every model's tool/reasoning template, or production GPU
training. Before merging, the contributor should still retest their own workflows.
