#!/usr/bin/env python3
"""Synthetic Markdown translation checks; never reads user selections."""
import json
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
from worker import Engine

code = '```python\n# Keep this comment unchanged\ndef greet(name):\n    return f"Hello, {name}"\n```'
cases = [
    ('zh-Hans', '# Quick start\n\nUse **local mode** with `timeout=30`.\n\n1. Install the package.\n2. Run the example.\n\n> Keep your data local.\n\n' + code + '\n\n| Option | Default |\n| --- | --- |\n| Timeout | 30 seconds |\n\nSee [documentation](https://example.com/docs).', [code, '`timeout=30`', 'https://example.com/docs', '**', '|']),
    ('en', '## 部署说明\n\n**先检查配置**，不要修改 `user_id`。\n\n- 启动服务\n  - 检查状态\n- 阅读[文档](https://example.com/guide)\n\n```json\n{"port": 8080, "message": "你好"}\n```', ['```json\n{"port": 8080, "message": "你好"}\n```', '`user_id`', 'https://example.com/guide', '**']),
    ('zh-Hans', code, [code]),
]
engine = Engine()
results = []
try:
    for target, source, required in cases:
        started = time.monotonic()
        result = engine.handle({'command': 'translate', 'text': source, 'target_language': target})['text']
        missing = [s for s in required if s not in result]
        row = {'target': target, 'source': source, 'result': result, 'seconds': round(time.monotonic()-started, 3), 'preservation_pass': not missing, 'missing': missing}
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
finally:
    engine.unload()
if len(sys.argv) > 1:
    Path(sys.argv[1]).write_text(json.dumps(results, ensure_ascii=False, indent=2)+'\n')
if any(not row['preservation_pass'] for row in results):
    raise SystemExit(1)
