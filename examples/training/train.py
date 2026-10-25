"""Train with TRL exports without Arrow coercion of heterogeneous tool arguments."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory


def load_training_dataset(path, tokenizer, max_length):
    """Render/tokenize each JSONL record before Arrow ingestion; reject truncation.

    Accepts the explicit cursor-history TRL profile. The model's template controls
    tool/reasoning rendering. No schema inference, argument rewriting or flattening
    is performed here; those belong to the shared exporter.
    """
    from datasets import Dataset

    def examples():
        with Path(path).open(encoding="utf-8-sig") as source:
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                    if record.get("schema") != "cursor-history-training-trl/v1":
                        raise ValueError("export with --schema trl first")
                    # Pass the unmodified Python objects directly to the template.
                    # Loading nested JSON into Arrow first may insert null keys or
                    # reject a parameter whose type differs between tool calls.
                    ids = tokenizer.apply_chat_template(
                        record["messages"],
                        tools=record["tools"],
                        tokenize=True,
                        return_dict=False,
                        add_generation_prompt=False,
                    )
                    if len(ids) < 2:
                        raise ValueError("chat template produced fewer than two tokens")
                    if len(ids) > max_length:
                        raise ValueError(
                            f"{len(ids)} tokens exceeds --max-length {max_length}; "
                            "increase the context limit or export shorter user-turn groups"
                        )
                    yield {"input_ids": ids}
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError(f"{path}:{line_number}: {error}") from error

    # A fresh cache prevents stale records if the same export path is overwritten.
    with TemporaryDirectory(prefix="cursor-history-dataset-") as cache:
        return Dataset.from_generator(examples, keep_in_memory=True, cache_dir=cache)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", help="JSONL exported with --schema trl")
    parser.add_argument("--model", required=True, help="HF model ID or local model directory")
    parser.add_argument("--validation", help="Optional validation JSONL from the same export")
    parser.add_argument("--max-length", type=int, default=4096)
    parser.add_argument("--max-steps", type=int, default=100)
    parser.add_argument("--output-dir", default="./cursor-history-sft")
    parser.add_argument("--check", action="store_true", help="Only load/template/tokenize; no model weights")
    args = parser.parse_args()
    if args.max_length < 2 or args.max_steps < 1:
        parser.error("--max-length must be at least 2 and --max-steps must be positive")

    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    if tokenizer.chat_template is None:
        parser.error("the tokenizer must provide a chat template for this model")
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    train = load_training_dataset(args.dataset, tokenizer, args.max_length)
    validation = (
        load_training_dataset(args.validation, tokenizer, args.max_length)
        if args.validation else None
    )
    print(f"Prepared {len(train)} training records" + (
        f" and {len(validation)} validation records" if validation is not None else ""
    ))
    if args.check:
        return

    from trl import SFTConfig, SFTTrainer

    trainer = SFTTrainer(
        model=args.model,
        processing_class=tokenizer,
        train_dataset=train,
        eval_dataset=validation,
        args=SFTConfig(
            output_dir=args.output_dir,
            max_length=args.max_length,
            max_steps=args.max_steps,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=4,
            # Explicit portable defaults. Tune precision/PEFT for your hardware.
            bf16=False,
            fp16=False,
            packing=False,
            report_to="none",
            eval_strategy="steps" if validation is not None else "no",
            eval_steps=50,
        ),
    )
    trainer.train()
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)


if __name__ == "__main__":
    main()
