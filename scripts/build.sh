#!/bin/bash
set -euo pipefail
YANMO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$YANMO_ROOT"
YANMO_CONFIGURATION="${YANMO_CONFIGURATION:-debug}"
swift build --configuration "$YANMO_CONFIGURATION"
YANMO_BIN="$(swift build --configuration "$YANMO_CONFIGURATION" --show-bin-path)"
YANMO_APP="$YANMO_ROOT/dist/言墨.app"
mkdir -p "$YANMO_APP/Contents/MacOS" "$YANMO_APP/Contents/Resources/engine"
cp "$YANMO_BIN/Yanmo" "$YANMO_APP/Contents/MacOS/Yanmo"
cp engine/worker.py engine/prompt.txt "$YANMO_APP/Contents/Resources/engine/"
YANMO_PYTHON="${YANMO_PYTHON:-$YANMO_ROOT/.venv/bin/python}"
YANMO_LLM="${YANMO_LLM:-mlx-community/Qwen3-4B-Instruct-2507-4bit}"
export YANMO_APP YANMO_PYTHON YANMO_LLM
python3 - <<'PY'
import os, plistlib
from pathlib import Path
app = Path(os.environ['YANMO_APP'])
info = {
    'CFBundleName': '言墨', 'CFBundleDisplayName': '言墨',
    'CFBundleIdentifier': 'org.yanmo.desktop', 'CFBundleExecutable': 'Yanmo',
    'CFBundlePackageType': 'APPL', 'CFBundleVersion': '3',
    'CFBundleShortVersionString': '0.3.0', 'LSMinimumSystemVersion': '14.0',
    'NSHighResolutionCapable': True,
    'NSMicrophoneUsageDescription': '言墨需要录音，将你的声音在本机转换为文字。音频不会上传，处理结束后删除临时录音。',
    'NSPrincipalClass': 'NSApplication',
    'CFBundleIconFile': 'Yanmo.icns',
    'YanmoPython': os.environ['YANMO_PYTHON'],
    'YanmoLLM': os.environ['YANMO_LLM'],
}
with (app / 'Contents/Info.plist').open('wb') as f:
    plistlib.dump(info, f)
PY
mkdir -p .build/Yanmo.iconset
swift scripts/make-icon.swift .build/Yanmo.iconset
iconutil -c icns .build/Yanmo.iconset -o "$YANMO_APP/Contents/Resources/Yanmo.icns"
codesign --force --deep --sign - "$YANMO_APP"
printf '构建完成：%s\n' "$YANMO_APP"
