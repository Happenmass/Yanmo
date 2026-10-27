"""Builds the Windows local runtime: a venv with the hash-locked PyTorch CUDA and transformers wheels.

Run by the desktop app with its bundled Python: `python setup_runtime.py <runtime dir> <lock>`.
Safe to re-run. Stdout carries JSON progress only; pip output goes to stderr.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

# (PyPI index, PyTorch CUDA index): mainland mirrors first, then the official servers.
INDEXES = [
    ("https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirrors.nju.edu.cn/pytorch/whl/cu130"),
    ("https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirror.sjtu.edu.cn/pytorch-wheels/cu130"),
    ("https://pypi.org/simple", "https://download.pytorch.org/whl/cu130"),
]


def emit(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def venv_python(runtime: Path) -> Path:
    return runtime / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python3")


def main(argv=None, run=subprocess.run):
    runtime, lock = (Path(value).resolve() for value in (argv or sys.argv[1:]))
    marker = runtime / "lock.sha256"
    digest = hashlib.sha256(lock.read_bytes()).hexdigest()
    if marker.is_file() and marker.read_text().strip() == digest:
        emit("step", step="done")
        return 0
    # Removed first and written last, so an interrupted install never looks complete.
    marker.unlink(missing_ok=True)
    emit("step", step="venv")
    python = venv_python(runtime)
    if not python.is_file() and run([sys.executable, "-m", "venv", str(runtime)], stdout=sys.stderr).returncode:
        emit("error", message="无法创建运行环境，请检查磁盘空间与目录权限。")
        return 1
    emit("step", step="packages")
    for index, torch_index in INDEXES:
        command = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
                   "--require-hashes", "-i", index, "--extra-index-url", torch_index, "-r", str(lock)]
        if run(command, stdout=sys.stderr).returncode == 0:
            marker.write_text(digest)
            # The cache only serves retries of an interrupted install.
            run([str(python), "-m", "pip", "cache", "purge"], stdout=sys.stderr)
            emit("step", step="done")
            return 0
    emit("error", message="运行库下载失败，请检查网络后重试；已下载的部分会继续使用。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
