"""Content-free, bounded local diagnostics. Never pass exception messages or payloads."""
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path

task_id = ContextVar('diagnostic_task', default='')
_logger = None


def record(event, **fields):
    global _logger
    directory = os.environ.get('YANMO_DIAGNOSTICS_DIR')
    if not directory:
        return
    try:
        if _logger is None:
            folder = Path(directory)
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = folder / 'inference.jsonl'
            fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            os.close(fd)
            handler = RotatingFileHandler(path, maxBytes=2_000_000, backupCount=2, encoding='utf-8')
            logger = logging.Logger('yanmo-diagnostics')
            logger.addHandler(handler)
            _logger = logger
        _logger.info(json.dumps({'time': datetime.now(timezone.utc).isoformat(), 'task_id': task_id.get(), 'event': event, **fields}, ensure_ascii=False))
    except Exception:
        pass  # Diagnostics must never interrupt input.
