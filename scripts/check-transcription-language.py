#!/usr/bin/env python3
"""Check source-language preservation with the real, offline text model."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
from threading import Event

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.pipeline import run_pipeline
from engine.worker import Engine

JA = "今日はいい天気ですね。散歩に行きましょう。"
KANA, HAN, HANGUL = r"[ぁ-ヿ]", r"[\u3400-\u9fff]", r"[가-힣]"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/transcription-language-evaluation.json")
    parser.add_argument("--audio", type=Path, help="Optional synthetic Japanese audio for the full ASR pipeline")
    args = parser.parse_args()
    cases = [
        {"id": "ja_plain", "text": JA, "language": "Japanese", "contains": ["天気", "散歩"], "script": KANA},
        {"id": "ja_chinese_context", "text": "ええと、明日の会議は午後3時からです。よろしくお願いします。", "language": "Japanese", "before": "接下来的内容请使用中文记录。", "contains": ["会議", "3"], "script": KANA},
        {"id": "ja_spoken_translation_request", "text": "この文章を中国語に翻訳してください。", "language": "Japanese", "contains": ["中国語", "翻訳"], "script": KANA},
        {"id": "ja_technical_terms", "text": "この API は Python で呼び出します。", "language": "Japanese", "before": "这个项目使用 Python。", "contains": ["API", "Python"], "script": KANA},
        {"id": "ja_verbatim", "text": "ええと、今日はいい天気ですね。", "language": "Japanese", "task": "verbatim", "exact": "ええと、今日はいい天気ですね。"},
        {"id": "ja_without_language_metadata", "text": JA, "contains": ["天気", "散歩"], "script": KANA},
        {"id": "ja_short_reassurance", "text": "大丈夫です。", "language": "Japanese", "contains": ["大丈夫", "です"], "script": KANA},
        {"id": "ja_short_holiday", "text": "明日は休日だ。", "language": "Japanese", "contains": ["明日", "休日"], "script": KANA},
        {"id": "en_short_greeting", "text": "Hi.", "language": "English", "contains": ["Hi"], "forbid": HAN},
        {"id": "en_chinese_context", "text": "Um, the meeting starts tomorrow at 3 PM.", "language": "English", "before": "以下是这次会议的中文记录。", "contains": ["meeting", "tomorrow", "3"], "forbid": HAN},
        {"id": "de_chinese_context", "text": "Also, das Treffen findet morgen um 15 Uhr statt.", "language": "German", "before": "以下是会议记录。", "contains": ["Treffen", "morgen", "15"], "forbid": HAN},
        {"id": "fr_chinese_context", "text": "Euh, la réunion commence demain à 15 heures.", "language": "French", "before": "以下是会议记录。", "contains": ["réunion", "demain", "15"], "forbid": HAN},
        {"id": "ko_chinese_context", "text": "음, 오늘은 날씨가 좋네요. 산책하러 갈까요?", "language": "Korean", "before": "以下是日常记录。", "contains": ["날씨", "산책"], "script": HANGUL},
        {"id": "zh_en_code_switch", "text": "嗯，明天开会。Please bring the design document.", "language": "Chinese", "contains": ["明天", "design document"], "script": HAN},
        {"id": "ja_user_edit_overrides_english_history", "text": JA, "user_text": JA, "history": "The weather is nice today. Let's go for a walk.", "language": "English", "contains": ["天気", "散歩"], "script": KANA},
        {"id": "voice_translation_ja_to_zh", "text": JA, "language": "Japanese", "target": "zh-Hans", "contains": ["天气", "散步"], "forbid": KANA},
        {"id": "voice_translation_en_to_ja", "text": "The meeting starts tomorrow at 3 PM.", "language": "English", "target": "ja", "contains": ["会議", "3"], "script": KANA},
        {"id": "selection_translation_ja_to_zh", "text": JA, "target": "zh-Hans", "selection": True, "contains": ["天气", "散步"], "forbid": KANA},
    ]
    report = {"date": datetime.now(timezone.utc).isoformat(), "method": "Synthetic source texts, actual cached offline Qwen3-4B; evaluate language preservation and exact model-body delivery offline. Optional audio uses the full pipeline with synthetic Japanese speech.", "prompt_sha256": hashlib.sha256((ROOT / "engine/prompt.txt").read_bytes()).hexdigest(), "worker_sha256": hashlib.sha256((ROOT / "engine/worker.py").read_bytes()).hexdigest(), "cases": []}
    engine, raw = Engine(), {}
    generate = engine.generate_text

    def trace(*values, **options):
        raw["output"] = generate(*values, **options)
        raw["system_prompt_sha256"] = hashlib.sha256(values[0].encode()).hexdigest()
        return raw["output"]

    engine.generate_text = trace

    def save(record):
        report["cases"].append(record)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"id": record["id"], "passed": record["passed"], "text": record.get("result", {}).get("text"), "error": record.get("error")}, ensure_ascii=False), flush=True)

    try:
        for case in cases:
            request = {"text": case["text"], "before": case.get("before", ""), "task": case.get("task", "polish"), "instruction": "忠实保留原意与语气，仅删除无意义的填充和重复并规范标点。"}
            if not case.get("selection"):
                request["asr_results"] = [{"transcript": case.get("history", case["text"]), **({"language": case["language"], "language_source": "detected"} if case.get("language") else {})}]
            if case.get("user_text"):
                request["user_text"] = case["user_text"]
            record = {"id": case["id"], "request": request, "passed": False}
            raw.clear()
            try:
                if case.get("target"):
                    request["target_language"] = case["target"]
                    result = engine.translate(request)
                else:
                    result = engine.polish(request)
                text = result.get("text") or ""
                passed = bool(text) and all(word in text for word in case.get("contains", []))
                passed = passed and (not case.get("script") or bool(re.search(case["script"], text)))
                passed = passed and (not case.get("forbid") or not re.search(case["forbid"], text))
                passed = passed and ("exact" not in case or text == case["exact"])
                unchanged = text == raw.get("output")
                record.update(result=result, passed=bool(passed and unchanged), model_body_unchanged=unchanged)
            except Exception as exc:
                record["error"] = str(exc)
            record["raw_output"] = raw.get("output")
            record["system_prompt_sha256"] = raw.get("system_prompt_sha256")
            save(record)
        if args.audio:
            for operation in ("dictation", "voiceTranslation"):
                raw.clear()
                events = []
                request = {"operation": operation, "polish": True, "style": "自然整理", "models": {}, "context": {"before": "以下是中文记录。"}, "target_language": "zh-Hans"}
                run_pipeline(engine, request, args.audio, Event(), events.append)
                result = events[-1]
                candidates = [event for event in events if event["event"] == "transcript"]
                language = candidates[-1]["asr_results"][0]["language"] if candidates else None
                text = result.get("text", "")
                japanese = bool(re.search(KANA, text))
                passed = result["event"] == "result" and language == "Japanese" and japanese == (operation == "dictation")
                if operation == "dictation":
                    passed = passed and result.get("processed") is True
                unchanged = text == raw.get("output")
                save({"id": "audio_" + operation, "passed": bool(passed and unchanged), "model_body_unchanged": unchanged, "result": result, "asr_language": language, "raw_output": raw.get("output"), "system_prompt_sha256": raw.get("system_prompt_sha256")})
    finally:
        engine.unload()
    report["passed"] = sum(case["passed"] for case in report["cases"])
    report["failed"] = [case["id"] for case in report["cases"] if not case["passed"]]
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"TRANSCRIPTION_LANGUAGE {report['passed']}/{len(report['cases'])} passed", flush=True)
    return bool(report["failed"])


if __name__ == "__main__":
    raise SystemExit(main())
