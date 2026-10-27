"""Application-independent inference flow. Providers never own cursor insertion."""
from threading import Event
from time import monotonic
from engine.diagnostics import record, task_id


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
        payload = {**request["context"], **request["models"], "online": request.get("online") or {}, "command": command, **values}
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
            primary = invoke("transcribe", audio=str(audio))
            original = primary["text"]
            language = primary.get("language")
            def candidate(value):
                return {"engine_name": value.get("engine", "Qwen3-ASR"), "transcript": value["text"],
                        "language": value.get("language"), "language_source": value.get("language_source", "unknown")}
            candidates.append(candidate(primary))
            emit({"event": "transcript", "text": original, "asr_results": list(candidates)})
            if primary.get("secondary") and primary.get("language_source") == "detected" and language in ("Chinese", "English"):
                stage("reviewing")
                secondary = invoke("transcribe_secondary", audio=str(audio), language=language)
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
            instruction = "忠实保留原意与语气，仅删除无意义的填充和重复并规范标点。"
            if request["style"] == "即时消息":
                instruction += "输出适合即时通讯的自然短句，不添加问候。"
            if request["style"] == "文档段落":
                instruction += "按语义分段，不增加标题或信息。"
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
