#!/bin/bash
# Provisions the dedicated Yanmo WSL runtime: a Python 3.12 venv with the hash-locked vLLM/CUDA wheels.
# Run as root by the desktop app; safe to re-run. Stdout carries JSON progress only; diagnostics go to stderr.
set -euo pipefail
LOCK="$(realpath "$1")"
RUNTIME=/opt/yanmo
APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/ubuntu
PYPI_INDEXES=(https://pypi.tuna.tsinghua.edu.cn/simple https://pypi.org/simple)
export DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1
step() { printf '{"event":"step","step":"%s"}\n' "$1"; }
fail() { printf '{"event":"error","message":"%s"}\n' "$1"; exit 1; }

step system
# gcc and Python headers are needed by Triton, which compiles small CUDA helpers at runtime.
if ! dpkg -s python3-venv python3-dev gcc >/dev/null 2>&1; then
  sources=$(ls /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true)
  install() { apt-get update -q >&2 && apt-get install -y -q --no-install-recommends python3-venv python3-dev gcc >&2; }
  for file in $sources; do
    [ -e "$file.yanmo-orig" ] || cp "$file" "$file.yanmo-orig"
    sed -i -E "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#$APT_MIRROR/#g" "$file"
  done
  if ! install; then
    # Mirror unreachable: fall back to the official sources.
    for file in $sources; do cp "$file.yanmo-orig" "$file"; done
    install || fail "系统组件安装失败，请检查网络后重试。"
  fi
fi

step packages
digest=$(sha256sum "$LOCK" | cut -d' ' -f1)
if [ "$(cat "$RUNTIME/lock.sha256" 2>/dev/null)" != "$digest" ]; then
  # The marker is removed first and written last, so an interrupted install never looks complete.
  rm -f "$RUNTIME/lock.sha256"
  mkdir -p "$RUNTIME"
  [ -x "$RUNTIME/venv/bin/python3" ] || python3 -m venv "$RUNTIME/venv"
  installed=
  for index in "${PYPI_INDEXES[@]}"; do
    if "$RUNTIME/venv/bin/python3" -m pip install --no-input --require-hashes --only-binary=:all: -i "$index" -r "$LOCK" >&2; then
      installed=1; break
    fi
  done
  [ -n "$installed" ] || fail "运行库下载失败，请检查网络后重试。"
  echo "$digest" > "$RUNTIME/lock.sha256"
  # The cache only serves retries of an interrupted install; drop it once complete.
  "$RUNTIME/venv/bin/python3" -m pip cache purge >&2 || true
fi
step done
