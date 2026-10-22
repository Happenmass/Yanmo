#!/usr/bin/env python3
"""Offline prompt-quality checks, never an inference-time content gate."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
from threading import Event
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.pipeline import run_pipeline
from engine.worker import Engine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--audio', type=Path, help='Optional synthetic Chinese speech for full dual-ASR translation')
    args = parser.parse_args()
    cases = [
        {'id': 'zh_indefinite_a', 'text': '我想做一个新的动画效果。', 'contains': ['animation'], 'article': True},
        {'id': 'zh_indefinite_an', 'text': '我有一个想法。', 'contains': ['idea'], 'article': True},
        {'id': 'zh_two_different_spellings', 'text': '嗯，我有一个问题，明天还需要开会吗？', 'secondary': '我有一个问题。明天还需要开会吗？', 'contains': ['question', 'tomorrow'], 'article': True},
        {'id': 'zh_article_with_context', 'text': '我想提出一个建议。', 'before': '以下是关于界面效果的中文讨论。', 'contains_any': [['suggestion', 'suggest something']], 'forbid': ['1']},
        {'id': 'zh_explicit_quantity', 'text': '这次预算一百元，需要买三件。', 'contains_any': [['100 yuan', 'one hundred yuan'], ['3 items', 'three items']]},
        {'id': 'zh_number_context_correction', 'text': '预算100元。', 'secondary': '预算101元。', 'before': '本条预算已经确认为101元。', 'contains': ['101'], 'forbid': ['100']},
        {'id': 'en_to_zh_quantities', 'text': 'The budget is one hundred dollars for three items.', 'language': 'English', 'target': 'zh-Hans', 'contains_any': [['100美元', '一百美元'], ['3件', '三件', '3项', '三项']]},
        {'id': 'en_to_zh_article', 'text': 'I have an idea.', 'language': 'English', 'target': 'zh-Hans', 'contains': ['想法']},
        {'id': 'zh_to_ja', 'text': '明天的会议从下午三点开始。', 'target': 'ja', 'contains': ['会議', '3']},
        {'id': 'zh_to_de', 'text': '明天的会议从十五点开始。', 'target': 'de', 'contains': ['15'], 'any_of': ['morgen', 'nächsten Tag']},
        {'id': 'zh_idioms_keep_number_words', 'operation': 'dictation', 'text': '做决定前要三思而后行，我们一起讨论。', 'contains': ['三思而后行', '一起'], 'forbid': ['3思', '1起']},
        {'id': 'zh_approximate_quantity', 'operation': 'dictation', 'text': '找三五个人一起商量，不用着急。', 'contains': ['三五个人', '一起'], 'forbid': ['35', '1起']},
        {'id': 'zh_fixed_names_weekdays', 'operation': 'dictation', 'text': '一些建议，一起统一格式，四川周五开会。', 'contains': ['一些', '一起', '统一', '四川', '周五']},
    ]
    report = {'date': datetime.now(timezone.utc).isoformat(), 'method': 'Synthetic transcripts with real offline Qwen3-4B; mock only ASR for text cases. Optional synthetic audio uses actual Qwen3-ASR + SenseVoice. Assert quality and exact model-body delivery offline; no runtime content rules.',
              'source_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ('engine/prompt.txt', 'engine/fusion.py', 'engine/worker.py', 'backend/pipeline.py')}, 'cases': []}
    engine, raw = Engine(), []
    generate = engine.generate_text

    def trace(*values, **options):
        output = generate(*values, **options)
        raw.append(output)
        return output

    engine.generate_text = trace

    def run(case, audio=None):
        raw.clear()
        events = []
        request = {'operation': case.get('operation', 'voiceTranslation'), 'target_language': case.get('target', 'en'), 'polish': True, 'style': '自然整理', 'models': {}, 'context': {'before': case.get('before', '')}}
        primary = {'text': case.get('text', ''), 'engine': 'Qwen3-ASR', 'language': case.get('language', 'Chinese'), 'language_source': 'detected'}
        secondary = {**primary, 'text': case.get('secondary', primary['text']), 'engine': 'SenseVoice Small', 'language_source': 'forced'}
        if audio:
            run_pipeline(engine, request, audio, Event(), events.append)
        else:
            with patch.object(engine, 'transcribe', return_value=primary), patch.object(engine, 'transcribe_secondary', return_value=secondary):
                run_pipeline(engine, request, 'synthetic.wav', Event(), events.append)
        result = events[-1]
        text = result.get('text') or ''
        passed = result['event'] == 'result' and bool(text)
        passed = passed and all(word.casefold() in text.casefold() for word in case.get('contains', []))
        passed = passed and not any(word in text for word in case.get('forbid', []))
        if case.get('any_of'):
            passed = passed and any(word.casefold() in text.casefold() for word in case['any_of'])
        passed = passed and all(any(word.casefold() in text.casefold() for word in group) for group in case.get('contains_any', []))
        if case.get('article'):
            passed = passed and bool(re.search(r'\b(?:a|an)\b', text, re.I)) and '1' not in text
        if request['operation'] == 'voiceTranslation' and request['target_language'] == 'en':
            passed = passed and not re.search(r'[\u3400-\u9fff]', text)
        unchanged = bool(raw) and raw[-1] == text
        passed = bool(passed and unchanged)
        record = {'id': case['id'], 'passed': passed, 'model_body_unchanged': unchanged, 'fixture': case, 'events': events, 'raw_output': raw[-1] if raw else None}
        report['cases'].append(record)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'id': case['id'], 'passed': passed, 'model_body_unchanged': unchanged, 'result': result}, ensure_ascii=False), flush=True)

    try:
        for case in cases:
            run(case)
        if args.audio:
            run({'id': 'audio_zh_dual_translation', 'contains': ['animation'], 'article': True}, args.audio)
    finally:
        engine.unload()
    report['failed'] = [case['id'] for case in report['cases'] if not case['passed']]
    report['passed'] = len(report['cases']) - len(report['failed'])
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f"TRANSLATION_OUTPUT {report['passed']}/{len(report['cases'])} passed", flush=True)
    return bool(report['failed'])


if __name__ == '__main__':
    raise SystemExit(main())
