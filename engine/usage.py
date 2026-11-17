"""Store local text API usage independently of the result stream."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
from time import time_ns
from uuid import uuid4

try:
    from .diagnostics import record
except ImportError:
    from diagnostics import record


def _write(path, sql, parameters):
    try:
        with closing(sqlite3.connect(path, uri=True, timeout=1)) as db, db:
            db.execute(sql, parameters)
    except sqlite3.Error as exc:
        record("usage_save_failed", error_type=type(exc).__name__)
        return False
    return True


def start_call(purpose, model):
    filename = os.environ.get("YANMO_USAGE_DB")
    if not filename:
        return None
    path = Path(filename).absolute().as_uri() + "?mode=rw"
    call_id = str(uuid4())
    saved = _write(path, """
        INSERT INTO llm_usage_events (call_id, started_at_ms, purpose, model, status)
        VALUES (?, ?, ?, ?, 'pending')
    """, (call_id, time_ns() // 1_000_000, purpose, model))
    return (path, call_id) if saved else None


def _count(value):
    return value if type(value) is int and 0 <= value <= 2**53 - 1 else None


def finish_call(call, status, result=None):
    if call is None:
        return
    path, call_id = call
    usage = result.get("usage") if isinstance(result, dict) else None
    usage = usage if isinstance(usage, dict) else {}
    input_tokens = _count(usage.get("prompt_tokens"))
    output_tokens = _count(usage.get("completion_tokens"))
    total = _count(usage.get("total_tokens"))
    if total is None and input_tokens is not None and output_tokens is not None:
        total = _count(input_tokens + output_tokens)
    _write(path, """
        UPDATE llm_usage_events SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?
        WHERE call_id = ?
    """, (status, input_tokens, output_tokens, total, call_id))
