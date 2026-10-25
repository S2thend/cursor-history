# Turn Cursor history into training datasets

Reuse local coding conversations for supervised fine-tuning (SFT): extract multi-turn examples,
retain available tool calls and results, redact recognized credentials, and split by session to
keep related conversation segments together. Export runs locally and does not upload history.

## Choose an export profile

| Profile | Message fields | Function arguments | Tool definitions |
| --- | --- | --- | --- |
| `messages` (default) | `messages`, `role`, `content` | JSON string | Optional `--tools-file` |
| `trl` | `messages`, `role`, `content` | JSON object | Required with tools enabled |
| `sharegpt` | `conversations`, `from`, `value` | Textual `[tool_call]` extension | Not included |

All profiles use the same extraction, sanitization and splitting functions. Existing messages
and ShareGPT records remain compatible. TRL records use `schema: "cursor-history-training-trl/v1"`
to distinguish object arguments from the existing `cursor-history-training/v1` messages profile.
The record ID and provenance metadata are retained, but the training example consumes only
messages and tool definitions.

ShareGPT's `human`/`gpt` mapping is a community convention; this project's `[tool_call]`,
`[tool_result]` and `[reasoning]` strings are extensions, not a universal tool protocol.
[TRL is a training library](https://huggingface.co/docs/trl/sft_trainer), not a competing storage
format. Its SFT pipeline applies the selected model's chat template to structured messages.

## Start with text-only SFT

```bash
cursor-history export-training --schema trl --no-tools --no-reasoning -o sft.jsonl
```

This retains natural-language user/assistant turns and omits structured tool calls and results.
It is suitable when you want conversational examples without teaching the tool interface. Review
whether tool-dependent answers still have enough context for your application.

## Export tool-calling conversations

Provide a JSON array of the actual function definitions used by your agent. For example,
[tools.json](../examples/training/tools.json) defines one `read_file` function with a `targetFile`
parameter. Adapt it to your history; it is not a complete Cursor tool catalog.

```bash
cursor-history --workspace /path/to/project export-training \
  --schema trl --tools-file ./tools.json --no-reasoning \
  --valid-ratio 0.05 -o ./training/agent.jsonl
```

Every TRL record includes `tools` (an empty array in text-only mode). Tool calls have JSON-object
arguments, and each tool response has a matching `tool_call_id` and function `name`. The exporter
checks the definition envelope, duplicate names, coverage of called functions and call/result
correlations. Unknown schema extensions are preserved. It does not invent definitions or perform
full JSON Schema validation of every argument against your supplied schema.

The supplied definitions are used for all exported conversations, including available tools that
were not called. Export separate datasets if different histories used different tool catalogs.
Tool descriptions and schema strings pass through the same credential/path sanitization as
conversation text. Review them before training.

A missing tool definition produces an actionable error. Supply that definition or choose
`--no-tools`; a failed streaming export may leave partial output from earlier records, so rerun
with `--force` after correcting the input.

## Run the TRL example

From a checkout of this repository (the example is also included in the npm package):

```bash
python3 -m venv .venv-training
. .venv-training/bin/activate
# Select the appropriate PyTorch build for your hardware; CPU verification uses:
pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
pip install -r examples/training/requirements.txt

# Download only the tokenizer, then validate every record and its token length.
python examples/training/train.py ./training/agent.jsonl \
  --model Qwen/Qwen2.5-0.5B-Instruct --check

# Train; this downloads model weights and uses full-parameter SFT.
python examples/training/train.py ./training/agent.jsonl \
  --model Qwen/Qwen2.5-0.5B-Instruct \
  --max-steps 100 --output-dir ./cursor-history-sft
```

Use `--validation ./training/agent.validation.jsonl` when that split contains records. With small
datasets, hashing may assign no sessions to one split; empty splits are not usable for training.
The seed and assignment are shared by all three formats. `--valid-ratio` is a per-session hash
threshold, so the observed fraction need not be exact.

The example processes each JSONL record directly with `tokenizer.apply_chat_template`, then
constructs a Hugging Face dataset containing only token IDs. This avoids Arrow changing nested
argument dictionaries (for example, inserting null keys from another tool) or rejecting a field
whose type differs between tools. A fresh temporary cache prevents reusing a previous export's
data when a file is overwritten. Tokenization checks `--max-length` and fails instead of silently
truncating a tool loop. Export character limits are approximate and split only at user turns;
a single long turn can still exceed the model's token window.

The example uses full-sequence loss, including user and tool tokens. Assistant-only masking,
LoRA/QLoRA, precision and packing are model/training choices and are not enabled implicitly.
For production training, tune these settings for your task and hardware.

## Compatibility and quality boundaries

- Use a tokenizer template that supports the tool calls you retain. Function arguments follow
  [Hugging Face tool-use conventions](https://huggingface.co/docs/transformers/chat_extras).
  The TRL profile does not guarantee compatibility with every model's template or hosted API.
- `reasoning_content` and tool execution `status` remain explicit extensions. A template may
  ignore them. Examples use `--no-reasoning`; retaining reasoning requires a template that renders
  it as intended. An error/cancelled tool result remains an observed outcome, not a success label.
- Exported history may contain failed attempts, incomplete results, repetitions, truncation markers
  and source gaps. Inspect provenance and curate examples before training. SFT format compatibility
  does not establish dataset quality or improved model performance.
- Default credential redaction and home-path replacement are heuristic. They do not constitute
  complete PII anonymization. Review your dataset and tool definitions before sharing them.
- This is an SFT workflow. Preference training such as DPO requires additional chosen/rejected
  examples; those labels cannot be inferred merely by converting conversation formats.

## Reproduce compatibility checks

After `npm run build` and installing the pinned Python dependencies:

```bash
node tests/trl/export-fixture.mjs /tmp/cursor-history-trl.jsonl
python tests/trl/smoke.py /tmp/cursor-history-trl.jsonl
# Optional: download only the real Qwen tokenizer/template for the same CPU test
python tests/trl/smoke.py /tmp/cursor-history-trl.jsonl --tokenizer Qwen/Qwen2.5-0.5B-Instruct
```

The smoke test uses synthetic exported conversations, a local tokenizer and a tiny randomly
initialized model. It checks tool schema/argument preservation, preprocessing and a CPU training
step without downloading pretrained weights. It verifies the integration, not model quality.
Verified on Python 3.13.5, PyTorch 2.14.1+cpu, TRL 1.16.0, Transformers 5.20.2 and
Datasets 5.1.0, with both the local test template and the Qwen2.5 template. The checkout
includes exact validation results in
`specs/020-training-formats/validation.md`.
