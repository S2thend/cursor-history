"""Real Transformers + TRL preprocessing and one-step CPU smoke test; no weights needed."""
import argparse
import importlib.util
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

import torch
from datasets.exceptions import DatasetGenerationError
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import AutoTokenizer, GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast
from trl import SFTConfig, SFTTrainer

spec = importlib.util.spec_from_file_location(
    "training_example", Path(__file__).resolve().parents[2] / "examples/training/train.py"
)
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)

TEMPLATE = """{{ bos_token }} {% if tools %}TOOLS {{ tools | tojson }} {% endif %}
{% for message in messages %}{{ message.role }} {{ message.content }}
{% if message.tool_calls %}{% for call in message.tool_calls %}CALL {{ call.function | tojson }} {% endfor %}{% endif %}
{% if message.role == 'tool' %}RESULT {{ message.name }} {{ message.tool_call_id }} {% endif %}
{% endfor %}{{ eos_token }}"""


def local_tokenizer():
    backend = Tokenizer(models.WordLevel(
        {"[UNK]": 0, "[PAD]": 1, "[BOS]": 2, "[EOS]": 3,
         "user": 4, "assistant": 5, "tool": 6, "CALL": 7, "RESULT": 8},
        unk_token="[UNK]",
    ))
    backend.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    return PreTrainedTokenizerFast(
        tokenizer_object=backend, unk_token="[UNK]", pad_token="[PAD]",
        bos_token="[BOS]", eos_token="[EOS]", chat_template=TEMPLATE,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset")
    parser.add_argument("--tokenizer", help="Optionally verify a real model's HF tokenizer/template")
    args = parser.parse_args()
    torch.set_num_threads(2)
    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer) if args.tokenizer else local_tokenizer()
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    records = [json.loads(line) for line in Path(args.dataset).read_text().splitlines() if line.strip()]
    assert len(records) == 3
    original = json.dumps(records, sort_keys=True)
    rendered = [tokenizer.apply_chat_template(
        row["messages"], tools=row["tools"], tokenize=False, add_generation_prompt=False,
    ) for row in records]
    assert '"targetFile": "/Users/<user>/a.ts"' in rendered[0]
    assert '"payload": {"items": [1, 2], "enabled": true, "optional": null}' in rendered[0]
    assert '"payload": "hello"' in rendered[1]
    assert '"targetFile": null' not in rendered[1]
    assert 'Read a file in the current project.' in rendered[0]
    assert json.dumps(records, sort_keys=True) == original
    dataset = example.load_training_dataset(args.dataset, tokenizer, 4096)
    assert len(dataset) == 3
    for index, row in enumerate(records):
        assert dataset[index]["input_ids"] == tokenizer.apply_chat_template(
            row["messages"], tools=row["tools"], tokenize=True, return_dict=False, add_generation_prompt=False,
        )

    # Context overflow must fail, not silently truncate a tool trajectory.
    try:
        example.load_training_dataset(args.dataset, tokenizer, 2)
    except DatasetGenerationError as error:
        assert "exceeds --max-length" in str(error.__cause__)
    else:
        raise AssertionError("oversized records were accepted")

    with TemporaryDirectory(prefix="cursor-history-trl-smoke-") as temp:
        # Same-path exports must not reuse an earlier Dataset.from_generator cache.
        same_path = Path(temp) / "overwrite.jsonl"
        same_path.write_text(json.dumps(records[2]) + "\n")
        before = example.load_training_dataset(same_path, tokenizer, 4096)[0]["input_ids"]
        records[2]["messages"][0]["content"] += " hello" * 20
        same_path.write_text(json.dumps(records[2]) + "\n")
        after = example.load_training_dataset(same_path, tokenizer, 4096)[0]["input_ids"]
        assert before != after

        model = GPT2LMHeadModel(GPT2Config(
            vocab_size=len(tokenizer), n_positions=4096, n_ctx=4096,
            n_embd=16, n_layer=1, n_head=2,
            bos_token_id=tokenizer.bos_token_id, eos_token_id=tokenizer.eos_token_id,
            pad_token_id=tokenizer.pad_token_id,
        ))
        trainer = SFTTrainer(
            model=model, processing_class=tokenizer, train_dataset=dataset,
            args=SFTConfig(
                output_dir=temp, use_cpu=True, max_steps=1,
                per_device_train_batch_size=1, max_length=4096,
                bf16=False, fp16=False, gradient_checkpointing=False,
                packing=False, report_to="none", save_strategy="no",
                logging_steps=1, disable_tqdm=True,
            ),
        )
        assert trainer.train_dataset[0]["input_ids"] == dataset[0]["input_ids"]
        result = trainer.train()
        assert trainer.state.global_step == 1
        assert math.isfinite(result.training_loss)
    print(f"PASS: export → template → token IDs → TRL CPU step ({args.tokenizer or 'local tokenizer'})")


if __name__ == "__main__":
    main()
