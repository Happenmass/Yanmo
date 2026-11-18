#!/usr/bin/env bash
# Verify the Android text API contract on a host JVM, without an emulator or API key.
set -euo pipefail
cd "$(dirname "$0")/.."
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
platform="$sdk/platforms/android-36/android.jar"
java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}"
test -f "$platform"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

version=0.0.20131108.vaadin1
jar_path="com/vaadin/external/google/android-json/$version/android-json-$version.jar"
json_jar="$HOME/.m2/repository/$jar_path"
if [[ ! -f "$json_jar" ]]; then
    json_jar="$work/android-json.jar"
    curl -fsSL --retry 2 "https://repo.maven.apache.org/maven2/$jar_path" -o "$json_jar"
fi
printf '%s  %s\n' dfb7bae2f404cfe0b72b4d23944698cb716b7665171812a0a4d0f5926c0fac79 "$json_jar" | shasum -a 256 -c >/dev/null

original='我想约周四下午三点，please book Room 2A。'
application='contract.editor'
"${java_bin}javac" --release 17 -encoding UTF-8 -classpath "$json_jar:$platform" -d "$work" \
    android/src/main/java/dev/yanmo/ime/Polish.java android/tools/PolishContract.java
"${java_bin}java" -classpath "$work:$json_jar:$platform" dev.yanmo.ime.PolishContract "$work" "$original" "$application"
python3 - "$work" "$original" "$application" <<'PY'
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

# The desktop reference is used up to its HTTP boundary. No HTTP client dependency is needed.
with patch.dict(sys.modules, {"httpx": SimpleNamespace(Timeout=lambda *a, **kw: None)}):
    from engine import fusion, online_provider

work = Path(sys.argv[1])
prompt = Path("engine/polish.txt").read_text(encoding="utf-8")
payload = fusion.build_polish_payload({"text": sys.argv[2], "application": sys.argv[3]})
for label, base_url in [("generic", "https://text.example.test/v1"), ("deepseek", "https://api.deepseek.com/v1")]:
    with patch.object(online_provider, "_post", return_value={
        "choices": [{"message": {"content": "fixture"}, "finish_reason": "stop"}]
    }) as post:
        online_provider.generate({"model": "contract-fixture", "base_url": base_url}, prompt, payload, 4096)

    actual = json.loads((work / f"{label}.json").read_text(encoding="utf-8"))
    expected = post.call_args.kwargs["json"]
    assert actual["messages"][0] == expected["messages"][0], f"{label} system prompt changed"
    for body in [actual, expected]:
        body["messages"][1]["content"] = json.loads(body["messages"][1]["content"])
    assert list(actual["messages"][1]["content"]) == list(payload), f"{label} payload order changed"
    assert actual == expected, f"{label} request differs from the desktop"
print("PASS: disabled API, desktop request parity, exact Chinese/mixed-language output, failure without fallback")
PY
