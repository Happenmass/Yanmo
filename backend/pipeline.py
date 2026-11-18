"""Application-independent inference flow. Providers never own cursor insertion."""
import base64
from pathlib import Path
from threading import Event
from time import monotonic
from engine.audio import encode_opus
from engine.diagnostics import record, task_id
from engine.fusion import normalize_lexicon


ASR_HOTWORD_LIMIT = 64


class TaskCancelled(Exception):
    pass


def run_pipeline(engine, request, audio, cancelled: Event, emit):
    original = ""
    token = task_id.set(request.get("task_id", ""))
    started = monotonic()
    current_stage = "starting"
    record("task_start", operation=request["operation"])

    def check():
        if cancelled.is_set():
            raise TaskCancelled()

    def invoke(command, **values):
        check()
        context = request["context"]
        if command == "transcribe":
            hotwords = request.get("asr_hotwords")
            if hotwords is None:
                hotwords = [entry["term"] for entry in normalize_lexicon(context)]
            context = {**context, "lexicon": hotwords[:ASR_HOTWORD_LIMIT]}
        payload = {**context, **request["models"], "online": request.get("online") or {}, "command": command, **values}
        begin = monotonic()
        record("model_start", command=command)
        response = engine.handle(payload)
        record("model_complete", command=command, elapsed_ms=round((monotonic()-begin)*1000), output_chars=len(response.get("text") or ""))
        check()
        return response

    def stage(name):
        nonlocal current_stage
        current_stage = name
        record("stage", stage=name)
        check()
        emit({"event": "stage", "stage": name})

    try:
        operation = request["operation"]
        candidates = list(request.get("asr_results") or [])
        if operation in ("dictation", "voiceTranslation"):
            stage("transcribing")
            source = str(audio) if isinstance(audio, Path) else audio
            primary = invoke("transcribe", audio=source)
            original = primary["text"]
            language = primary.get("language")
            def candidate(value):
                return {"engine_name": value.get("engine", "Qwen3-ASR"), "transcript": value["text"],
                        "language": value.get("language"), "language_source": value.get("language_source", "unknown")}
            candidates.append(candidate(primary))
            emit({"event": "transcript", "text": original, "asr_results": list(candidates)})
            check()
            if request.get("archive_audio", False):
                try:
                    encoded = encode_opus(audio)
                    check()
                    emit({"event": "audio", "audio_opus": base64.b64encode(encoded).decode("ascii")})
                except TaskCancelled:
                    raise
                except Exception as exc:
                    check()
                    record("audio_archive_failed", error_type=type(exc).__name__)
                    emit({"event": "audio", "audio_warning": "录音未保存：音频压缩失败，文字处理继续。"})
            if primary.get("secondary") and primary.get("language_source") == "detected" and language in ("Chinese", "English"):
                stage("reviewing")
                secondary = invoke("transcribe_secondary", audio=source, language=language)
                candidates.append(candidate(secondary))
                emit({"event": "transcript", "text": original, "asr_results": list(candidates)})
        else:
            original = request["text"]
        result, processed = original, False
        if operation in ("selectionTranslation", "voiceTranslation"):
            stage("translating")
            response = invoke("translate", text=original, target_language=request["target_language"], asr_results=candidates)
            processed = True
        else:
            stage("polishing")
            task = "verbatim" if operation != "polish" and (not request["polish"] or request["style"] == "保留原话") else "polish"
            instruction = ""
            if request["style"] == "即时消息":
                instruction = "整理为即时消息。"
            if request["style"] == "文档段落":
                instruction = "整理为文档段落。"
            response = invoke("polish", text=original, instruction=instruction, asr_results=candidates, task=task)
            processed = task != "verbatim"
        result = response.get("text")
        if not result:
            record("task_error", stage=current_stage, error_type="EmptyModelOutput")
            emit({"event": "error", "message": "模型没有返回正文，识别原文已保留，请重试。", "original": original})
            return
        check()
        record("task_complete", elapsed_ms=round((monotonic()-started)*1000))
        emit({"event": "result", "text": result, "original": original, "processed": processed})
    except TaskCancelled:
        record("task_cancelled", stage=current_stage)
        emit({"event": "cancelled", "original": original})
    except Exception as exc:
        record("task_error", stage=current_stage, error_type=type(exc).__name__, elapsed_ms=round((monotonic()-started)*1000))
        emit({"event": "error", "message": str(exc), "original": original})
    finally:
        task_id.reset(token)
