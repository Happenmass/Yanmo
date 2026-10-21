#!/bin/bash
set -euo pipefail
YANMO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$YANMO_ROOT"
if ! command -v uv >/dev/null; then
    printf '%s\n' '请先安装 uv（https://docs.astral.sh/uv/），再运行此脚本。' >&2
    exit 1
fi
if [ ! -x .venv/bin/python ]; then uv venv --python 3.12 .venv; fi
uv pip install --python .venv/bin/python -r engine/requirements.txt
printf '%s\n' 'Python 环境已准备好。模型不会自动下载；请运行 .venv/bin/python scripts/prepare-models.py（首次需联网）。'
