"""Explicit download command used by the desktop and developer setup script."""
import argparse
import contextlib
import json
import sys
from engine.model_cache import DEFAULT_SOURCE, prepare_model, resolve_cached_model


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=["modelscope", "huggingface"], default=DEFAULT_SOURCE)
    parser.add_argument("--asr", default="mlx-community/Qwen3-ASR-1.7B-8bit")
    parser.add_argument("--llm", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    parser.add_argument("--sensevoice", default="mlx-community/SenseVoiceSmall")
    # The Windows vLLM path has no SenseVoice review.
    parser.add_argument("--without-sensevoice", action="store_true")
    # Report cache completeness only; never downloads.
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    models = [args.asr] + ([] if args.without_sensevoice else [args.sensevoice]) + [args.llm]
    for model in dict.fromkeys(models):
        if args.check:
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    resolve_cached_model(model, args.source)
                ready = True
            except ValueError:
                ready = False
            print(json.dumps({"event": "checked", "model": model, "ready": ready}), flush=True)
            continue
        print(json.dumps({"event": "preparing", "model": model, "source": args.source}), flush=True)
        with contextlib.redirect_stdout(sys.stderr):
            path, reused = prepare_model(model, args.source)
        print(json.dumps({"event": "prepared", "model": model, "reused": reused, "path": str(path)}), flush=True)


if __name__ == "__main__":
    main()
