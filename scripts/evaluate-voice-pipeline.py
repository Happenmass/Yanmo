#!/usr/bin/env python3
"""Exercise real offline ASR and fusion using explicitly supplied synthetic audio."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from threading import Event
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.pipeline import run_pipeline
from engine.worker import Engine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    fixtures = {
        'zh': {'voice': 'Tingting', 'spoken': '周五下午三点开会，预算三千五百元，不是周四。', 'language': 'Chinese', 'contains_any': [['3点', '三点'], ['3500元', '三千五百元']]},
        'en': {'voice': 'Samantha', 'spoken': 'Please schedule the meeting for Friday at three p.m. The budget is three thousand five hundred dollars, not four thousand.', 'language': 'English', 'contains_any': [['three p.m.', '3 p.m.', '3 PM', '3pm', 'three PM'], ['3500', '3,500', 'three thousand five hundred'], ['4000', '4,000', 'four thousand']]},
        'ja': {'voice': 'Kyoko', 'spoken': '金曜日の午後三時に会議を開きます。予算を確認してください。', 'language': 'Japanese', 'contains_any': [['3時', '三時']]},
    }
    cases = [
        ('zh', 'zh', {}, True, 'dictation'), ('en', 'en', {}, True, 'dictation'), ('ja', 'ja', {}, True, 'dictation'),
        ('zh-context', 'zh', {'before': '上一条旧会议预算9999元。现在记录新的时间与预算：', 'after': '请保留新口述中的否定和新决定。'}, True, 'dictation'),
        ('en-context', 'en', {'before': 'The previous meeting had a budget of 9999 dollars. The new plan is: ', 'after': 'Keep the speaker’s new decision.'}, True, 'dictation'),
        ('zh-verbatim', 'zh', {}, False, 'dictation'), ('en-verbatim', 'en', {}, False, 'dictation'),
        ('en-translation', 'en', {}, True, 'voiceTranslation'),
    ]
    report = {'date': datetime.now(timezone.utc).isoformat(), 'method': 'macOS say synthetic audio; real cached offline Qwen3-ASR + SenseVoice + Qwen3-4B; integration checks, not an accuracy benchmark',
              'prompt_sha256': hashlib.sha256((ROOT / 'engine/prompt.txt').read_bytes()).hexdigest(), 'fixtures': fixtures, 'cases': []}
    engine = Engine()
    try:
        for case_id, locale, context, polish, operation in cases:
            audio = args.audio_dir / f'yanmo-dual-{locale}.wav'
            if not audio.is_file():
                raise FileNotFoundError(audio)
            events, started = [], time.monotonic()
            def emit(event):
                events.append({**event, 'elapsed': round(time.monotonic() - started, 3)})
            request = {'operation': operation, 'target_language': 'zh-Hans', 'context': context,
                       'models': {'model_source': 'modelscope'}, 'online': {}, 'polish': polish, 'style': '自然整理'}
            run_pipeline(engine, request, audio, Event(), emit)
            record = {'id': case_id, 'context': context, 'events': events, 'passed': False}
            try:
                assert events[-1]['event'] == 'result', events[-1]
                raw = [item for item in events if item['event'] == 'transcript'][-1]['asr_results']
                assert raw[0]['language'] == fixtures[locale]['language'], raw
                assert raw[0]['language_source'] == 'detected', raw
                assert len(raw) == (1 if locale == 'ja' else 2), raw
                text = events[-1]['text']
                expected = fixtures[locale]['contains_any'] if operation == 'dictation' else [['3点', '三点'], ['3500', '3,500', '三千五百'], ['4000', '4,000', '四千']]
                assert all(any(word.casefold() in text.casefold() for word in group) for group in expected), text
                assert '9999' not in text and all('9999' not in item['transcript'] for item in raw), record
                if locale == 'zh':
                    assert all(word in text for word in ['周五', '不是周四']), text
                if locale == 'en' and operation == 'dictation':
                    assert 'Friday' in text and 'not' in text.lower(), text
                if operation == 'voiceTranslation':
                    assert not any(item.get('stage') == 'polishing' for item in events)
                record['passed'] = True
            except AssertionError as exc:
                record['error'] = str(exc)
            report['cases'].append(record)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(record, ensure_ascii=False), flush=True)
    finally:
        engine.unload()
    report['failed'] = [case['id'] for case in report['cases'] if not case['passed']]
    report['passed'] = len(report['cases']) - len(report['failed'])
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f"VOICE_PIPELINE {report['passed']}/{len(report['cases'])} passed", flush=True)
    return bool(report['failed'])


if __name__ == '__main__':
    raise SystemExit(main())
