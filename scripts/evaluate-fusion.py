#!/usr/bin/env python3
"""Run reproducible synthetic ASR disagreements against the real local text model."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from engine.worker import Engine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cases', type=Path, default=ROOT / 'docs/asr-fusion-cases.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/asr-fusion-evaluation.json')
    args = parser.parse_args()
    fixture = json.loads(args.cases.read_text())
    report = {'date': datetime.now(timezone.utc).isoformat(), 'method': fixture['method'], 'model': 'mlx-community/Qwen3-4B-Instruct-2507-4bit', 'prompt_sha256': hashlib.sha256((ROOT / 'engine/prompt.txt').read_bytes()).hexdigest(), 'worker_sha256': hashlib.sha256((ROOT / 'engine/worker.py').read_bytes()).hexdigest(), 'cases': []}
    engine = Engine()
    raw = {}
    original_generate = engine.generate_text
    def trace(*values, **options):
        value = original_generate(*values, **options)
        raw['output'] = value
        raw['system_prompt_sha256'] = hashlib.sha256(values[0].encode()).hexdigest()
        return value
    engine.generate_text = trace
    try:
        for case in fixture['cases']:
            started = time.monotonic()
            record = {'id': case['id']}
            raw.clear()
            try:
                request = case['request']
                result = engine.translate(request) if case.get('operation') == 'translate' else engine.polish(request)
                record['result'] = result
                text = result.get('text') or ''
                unchanged = text == raw.get('output')
                passed = bool(text) and unchanged
                passed = passed and all(word.casefold() in text.casefold() for word in case.get('contains', []))
                passed = passed and all(any(word.casefold() in text.casefold() for word in group) for group in case.get('contains_any', []))
                passed = passed and not any(word.casefold() in text.casefold() for word in case.get('forbid', []))
                record.update(passed=passed, model_body_unchanged=unchanged)
            except Exception as exc:
                record.update(passed=False, error=str(exc))
            record['raw_output'] = raw.get('output')
            record['system_prompt_sha256'] = raw.get('system_prompt_sha256')
            record['elapsed'] = round(time.monotonic() - started, 3)
            report['cases'].append(record)
            print(json.dumps(record, ensure_ascii=False), flush=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    finally:
        engine.unload()
    failed = [case['id'] for case in report['cases'] if not case['passed']]
    report.update(passed=len(report['cases']) - len(failed), failed=failed)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f"FUSION_EVALUATION {report['passed']}/{len(report['cases'])} passed", flush=True)
    return bool(failed)


if __name__ == '__main__':
    raise SystemExit(main())
