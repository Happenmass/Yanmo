"""Application-independent inference flow. Providers never own cursor insertion."""
from threading import Event


class TaskCancelled(Exception):
    pass


def run_pipeline(engine, request, audio, cancelled: Event, emit):
    original = ""

    def check():
        if cancelled.is_set():
            raise TaskCancelled()

    def invoke(command, **values):
        check()
        payload = {**request["context"], **request["models"], "online": request.get("online") or {}, "command": command, **values}
        response = engine.handle(payload)
        check()
        return response

    def stage(name):
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
            if primary.get("engine") == "Qwen3-ASR" and primary.get("language_source") == "detected" and language in ("Chinese", "English"):
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
            emit({"event": "error", "message": "模型没有返回正文，识别原文已保留，请重试。", "original": original})
            return
        check()
        emit({"event": "result", "text": result, "original": original, "processed": processed})
    except TaskCancelled:
        emit({"event": "cancelled", "original": original})
    except Exception as exc:
        emit({"event": "error", "message": str(exc), "original": original})
