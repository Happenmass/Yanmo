"""Loopback-only, authenticated inference API; the desktop supervises its process."""
import asyncio
import contextlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
from threading import Event

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from typing import Literal

from engine.worker import DEFAULT_ASR, DEFAULT_LLM, DEFAULT_SENSEVOICE, Engine
from backend.pipeline import run_pipeline


class OnlineEndpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = Field(pattern=r"^(https://|http://(localhost|127\.0\.0\.1|\[::1\])(:|/|$))", max_length=500)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="", max_length=1000)


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: str = Field(pattern=r"^[a-zA-Z0-9-]{1,64}$")
    operation: Literal["dictation", "voiceTranslation", "selectionTranslation", "polish"]
    text: str = Field(default="", max_length=20000)
    target_language: Literal["en", "zh-Hans", "ja", "de"] = "en"
    polish: bool = True
    style: Literal["自然整理", "保留原话", "即时消息", "文档段落"] = "自然整理"
    models: dict[str, str] = Field(default_factory=dict)
    online: dict[Literal["asr", "text"], OnlineEndpoint] = Field(default_factory=dict)
    context: dict = Field(default_factory=dict)
    asr_results: list[dict[str, str | None]] = Field(default_factory=list, max_length=2)


def create_app(engine=None, token=None, announce=None):
    api_only = os.environ.get('YANMO_API_ONLY') == '1'
    engine = engine or Engine()
    token = token or os.environ.get("YANMO_BACKEND_TOKEN")
    if not token:
        raise RuntimeError("Backend authentication is required")
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="yanmo-inference")
    tasks: dict[str, Event] = {}

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        if announce:
            announce()
        try:
            yield
        finally:
            for cancelled in tasks.values():
                cancelled.set()
            executor.shutdown(wait=True, cancel_futures=True)
            engine.unload()

    async def authorized(authorization: str = Header(default="")):
        if not secrets.compare_digest(authorization, "Bearer " + token):
            raise HTTPException(status_code=401, detail="Authentication required")

    app = FastAPI(lifespan=lifespan, dependencies=[Depends(authorized)], docs_url=None, redoc_url=None, openapi_url=None)

    async def serial(request):
        def invoke():
            with contextlib.redirect_stdout(sys.stderr):
                return engine.handle(request)
        return await asyncio.get_running_loop().run_in_executor(executor, invoke)

    @app.get("/v1/status")
    async def status(asr_model: str = DEFAULT_ASR, llm_model: str = DEFAULT_LLM, sensevoice_model: str = DEFAULT_SENSEVOICE, model_source: Literal["modelscope", "huggingface"] = "modelscope", online: str = "{}"):
        if api_only:
            from engine.online_provider import check_services
            configs = json.loads(online)
            error = await asyncio.get_running_loop().run_in_executor(executor, check_services, configs)
            return {"protocol": 1, "provider": "api", "offline": False, "metal": False, "models": {}, "service_error": error}
        result = await serial({"command": "check", "asr_model": asr_model, "llm_model": llm_model, "sensevoice_model": sensevoice_model, "model_source": model_source})
        import platform
        available = False
        try:
            import mlx.core as mx
            available = mx.metal.is_available()
        except ImportError:
            pass
        return {"protocol": 1, "provider": "mlx", "offline": True, "metal": available,
                "architecture": platform.machine(), "capabilities": ["transcribe", "polish", "translate"], **result}

    @app.post("/v1/warmup")
    async def warmup(request: dict):
        if api_only:
            raise HTTPException(status_code=400, detail="API 版不加载本地模型。")
        allowed = {key: request[key] for key in ("asr_model", "llm_model", "include_llm", "model_source") if key in request}
        try:
            return await serial({"command": "warmup", **allowed})
        except Exception:
            raise HTTPException(status_code=503, detail="本地模型预加载未完成，正式处理时会重试。") from None

    @app.post("/v1/tasks")
    async def task(request: str = Form(...), audio: UploadFile | None = File(default=None)):
        try:
            payload = TaskRequest.model_validate_json(request).model_dump()
        except ValidationError:
            raise HTTPException(status_code=422, detail="推理任务参数无效。") from None
        if api_only and set(payload["online"]) != {"asr", "text"}:
            raise HTTPException(status_code=422, detail="API 版需要配置语音与文字两项服务。")
        task_id = payload["task_id"]
        if tasks:
            raise HTTPException(status_code=409, detail="请等待当前推理任务结束。")
        if set(payload["models"]) - {"asr_model", "llm_model", "sensevoice_model", "model_source"}:
            raise HTTPException(status_code=422, detail="模型配置无效。")
        context_keys = {"application", "category", "key_terms", "term_notes", "lexicon", "before", "after", "user_text"}
        if set(payload["context"]) - context_keys:
            raise HTTPException(status_code=422, detail="上下文参数无效。")
        if any(not isinstance(item.get("transcript"), str) or len(item["transcript"]) > 20000 for item in payload["asr_results"]):
            raise HTTPException(status_code=422, detail="识别对照参数无效。")
        if payload["operation"] in ("dictation", "voiceTranslation") and audio is None:
            raise HTTPException(status_code=422, detail="缺少录音文件。")
        cancelled = Event()
        tasks[task_id] = cancelled
        path = None
        try:
            if audio:
                with tempfile.NamedTemporaryFile(prefix="yanmo-backend-", suffix=".wav", delete=False) as output:
                    path = Path(output.name)
                    size = 0
                    while chunk := await audio.read(1024 * 1024):
                        size += len(chunk)
                        if size > 160 * 1024 * 1024:
                            raise HTTPException(status_code=413, detail="音频文件过大，请分段处理。")
                        output.write(chunk)
        except BaseException:
            tasks.pop(task_id, None)
            if path:
                path.unlink(missing_ok=True)
            raise
        finally:
            if audio:
                await audio.close()
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        def emit(event):
            loop.call_soon_threadsafe(queue.put_nowait, {"task_id": task_id, **event})

        def work():
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    if path:
                        import soundfile as sf
                        info = sf.info(str(path))
                        if info.duration <= 0 or info.duration > 300:
                            raise ValueError("首版支持 5 分钟以内的音频。")
                    run_pipeline(engine, payload, path, cancelled, emit)
            except Exception as exc:
                emit({"event": "error", "message": str(exc), "original": ""})
            finally:
                if path:
                    path.unlink(missing_ok=True)
                loop.call_soon_threadsafe(tasks.pop, task_id, None)
                loop.call_soon_threadsafe(queue.put_nowait, None)

        executor.submit(work)

        async def events():
            try:
                while (value := await queue.get()) is not None:
                    yield "data: " + json.dumps(value, ensure_ascii=False) + "\n\n"
            finally:
                cancelled.set()

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    @app.post("/v1/tasks/{task_id}/cancel")
    async def cancel(task_id: str):
        if task_id in tasks:
            tasks[task_id].set()
        return {"cancelled": True}

    return app


def main():
    import uvicorn
    if os.environ.get("YANMO_SUPERVISED") == "1":
        import signal
        from threading import Thread, Timer

        def watch_parent():
            sys.stdin.buffer.read()
            # Pipe EOF also covers a crashed Electron process.
            timer = Timer(5, lambda: os._exit(0))
            timer.daemon = True
            timer.start()
            os.kill(os.getpid(), signal.SIGTERM)

        Thread(target=watch_parent, daemon=True).start()
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]

    def announce():
        print(json.dumps({"event": "ready", "protocol": 1, "port": port}), flush=True)

    app = create_app(announce=announce)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False, log_level="error"))
    asyncio.run(server.serve(sockets=[sock]))


if __name__ == "__main__":
    main()
