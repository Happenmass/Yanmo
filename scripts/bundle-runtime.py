#!/usr/bin/env python3
"""Build a relocatable Mac runtime. Never copies or downloads model weights."""
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "runtime/macos/python"
LOCK = ROOT / "backend/requirements-macos.lock"
PYTHON_VERSION = "3.12.12"


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("This runtime is built on Apple Silicon macOS.")
    if not LOCK.is_file():
        run(["uv", "pip", "compile", str(ROOT / "backend/requirements.in"), "--python", "3.12", "--generate-hashes", "-o", str(LOCK)])
    fingerprint = hashlib.sha256(LOCK.read_bytes()).hexdigest()
    marker = TARGET / ".yanmo-runtime.json"
    if marker.is_file() and json.loads(marker.read_text()).get("lock_sha256") == fingerprint:
        run([str(TARGET / "bin/python3.12"), "-I", "-c", f"import platform; assert platform.python_version() == '{PYTHON_VERSION}'"])
        print("Mac runtime already matches the dependency lock.")
        return
    base_python = Path(run(["uv", "python", "find", PYTHON_VERSION, "--managed-python", "--no-project"], capture_output=True, text=True).stdout.strip()).resolve()
    base = base_python.parent.parent
    if (base / "pyvenv.cfg").exists():
        raise SystemExit("Use a standalone Python distribution, not a virtual environment.")
    if TARGET.exists():
        shutil.rmtree(TARGET)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(base, TARGET, symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "test", "tests"))
    python = TARGET / "bin/python3.12"
    site = TARGET / "lib/python3.12/site-packages"
    site.mkdir(parents=True, exist_ok=True)
    run(["uv", "pip", "install", "--python", str(python), "--target", str(site), "--require-hashes", "-r", str(LOCK)])
    env = {key: value for key, value in os.environ.items() if key not in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")}
    run([str(python), "-I", "-c", "import sys, mlx.core as mx, mlx_audio, mlx_lm, fastapi, uvicorn, soundfile; assert mx.metal.is_available(); assert sys.prefix.startswith(sys.argv[1]); print('Standalone Python + MLX runtime verified')", str(TARGET)], env=env)
    marker.write_text(json.dumps({"python": PYTHON_VERSION, "lock_sha256": fingerprint}) + "\n")


if __name__ == "__main__":
    main()
