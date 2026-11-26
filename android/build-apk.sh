#!/usr/bin/env bash
# Build Yanmo from the pinned CyIME source and sign it for in-place upgrades.
set -euo pipefail
android_root="$(cd "$(dirname "$0")" && pwd)"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
tools="$sdk/build-tools/${YANMO_ANDROID_BUILD_TOOLS:-36.1.0}"
output="$android_root/build"
cache="${YANMO_ANDROID_CACHE:-$HOME/.cache/codex/yanmo-android}"
speech="${YANMO_SPEECH_PACKAGE:-dev.androidagent.sample}"
keystore="${YANMO_ANDROID_KEYSTORE:-$HOME/.config/sound-software/signing/release.p12}"
certificate_sha256=4a4c42dba046be7d84992d4277fde00744884d13dfa3ad6ac439e901824b7a5e
unsigned=false
case "$#:${1:-}" in
    0:) ;;
    1:--unsigned) unsigned=true ;;
    1:-h|1:--help) printf 'Usage: %s [--unsigned]\n' "$0"; exit 0 ;;
    *) printf 'Usage: %s [--unsigned]\n' "$0" >&2; exit 1 ;;
esac
[[ "$speech" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]] || {
    printf '%s\n' 'YANMO_SPEECH_PACKAGE must be a valid Android application ID' >&2
    exit 1
}
for tool in "$tools/zipalign" "$tools/apksigner"; do
    test -x "$tool" || { printf 'Missing Android SDK tool: %s\n' "$tool" >&2; exit 1; }
done
if ! "$unsigned"; then
    test -f "$keystore" || { printf '%s\n' 'The Android release keystore is missing.' >&2; exit 1; }
fi

mkdir -p "$cache" "$output"
version=1.15.94
pin=6f97a555ced063c0bcad73c600fe420f5e4b2536
release="https://github.com/Cyletix/CyIME/releases/download/$version"
full="$cache/CyIME-$version-full-arm64-v8a.apk"
checkout="${YANMO_ANDROID_BUILD_CHECKOUT:-$cache/cyime-build-$version}"
lock="$checkout.lock"
work="$(mktemp -d "$cache/.build.XXXXXX")"
if ! mkdir "$lock"; then
    rmdir "$work"
    printf 'A Yanmo source build already owns %s\n' "$lock" >&2
    exit 1
fi
trap 'rm -rf "$work"; rmdir "$lock"' EXIT
verify() {
    echo "$2  $1" | shasum -a 256 -c - >/dev/null
}
fetch() {
    local path="$1" digest="$2" temporary
    if [[ -f "$path" ]] && verify "$path" "$digest"; then return; fi
    temporary="$(mktemp "$cache/.download.XXXXXX")"
    if ! curl -fL --retry 2 "$release/$(basename "$path")" -o "$temporary" ||
        ! verify "$temporary" "$digest"; then
        rm -f "$temporary"
        return 1
    fi
    mv "$temporary" "$path"
}
keyboard_assets=()
if [[ "${YANMO_LIGHT_KEYBOARD:-0}" != 1 ]]; then
    fetch "$full" d121abd5345b6f02202803ba10b9368c39a84e49f549143199f5edd38ca19e86
    keyboard_assets=(--keyboard-assets "$full")
fi

export GIT_LFS_SKIP_SMUDGE=1
if [[ ! -e "$checkout" ]]; then
    git -c http.version=HTTP/1.1 clone --depth 1 --filter=blob:none --no-checkout \
        --branch "$version" https://github.com/Cyletix/CyIME.git "$work/cyime" >&2
    git -C "$work/cyime" sparse-checkout set --no-cone \
        '/*' '!*.onnx' '!*.ort' '!*.safetensors' '!*.tflite' '!*.gguf'
    git -C "$work/cyime" checkout --detach "$pin" >&2
    touch "$work/cyime/.git/yanmo-build"
    mv "$work/cyime" "$checkout"
fi
if [[ -L "$checkout" || ! -f "$checkout/.git/yanmo-build" ||
      "$(git -C "$checkout" rev-parse HEAD)" != "$pin" ]]; then
    printf 'Expected a dedicated Yanmo build checkout at %s\n' "$checkout" >&2
    exit 1
fi
# Refresh only the build-owned checkout. Keep downloaded and compiled dependencies.
git -C "$checkout" restore --staged --worktree --source="$pin" -- .
git -C "$checkout" clean -fd -- app/src/main >&2
git -C "$checkout" -c http.version=HTTP/1.1 submodule update --init --depth 1 --jobs 6 >&2
git -C "$checkout/app/src/main/jni/librime" -c http.version=HTTP/1.1 submodule update --init --depth 1 --jobs 6 >&2
git -C "$checkout" submodule foreach --recursive 'git restore --staged --worktree --source=HEAD -- .' >&2
python3 "$android_root/tools/prepare_source.py" "$checkout" --speech-package "$speech" \
    ${keyboard_assets[@]+"${keyboard_assets[@]}"} >&2

# The light release already excludes these optional Japanese conversion assets.
ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk" "$checkout/gradlew" -p "$checkout" \
    -I "$checkout/scripts/phone-release-abi.gradle" \
    -PversionCode=20261465 -PversionName=1.15.94-yanmo.18 \
    -x :app:prepareJapaneseDictionaries -x :app:prepareAzooKeyLibraries \
    :app:assembleRelease >&2
apk=$(python3 - "$checkout/app/build/outputs/apk/release/output-metadata.json" <<'PY'
import json
from pathlib import Path
import sys

metadata = Path(sys.argv[1])
elements = json.loads(metadata.read_text())["elements"]
arm64, = (
    output for output in elements
    if any(f.get("filterType") == "ABI" and f.get("value") == "arm64-v8a" for f in output["filters"])
)
print(metadata.parent / arm64["outputFile"])
PY
)
"$tools/zipalign" -f -P 16 4 "$apk" "$work/aligned.apk"

artifact="Yanmo-Android-Prototype-phone-arm64-v8a.apk"
if [[ "$speech" != dev.androidagent.sample ]]; then
    artifact="Yanmo-Android-Prototype-arm64-v8a-$speech.apk"
fi
if "$unsigned"; then
    artifact="${artifact%.apk}-unsigned.apk"
    "$tools/zipalign" -c -P 16 4 "$work/aligned.apk"
    mv "$work/aligned.apk" "$output/$artifact"
    printf '%s\n' "$output/$artifact"
    exit 0
fi
sign() {
    "$tools/apksigner" sign --ks "$keystore" --v1-signing-enabled true --v4-signing-enabled false \
        "$@" --out "$work/$artifact" "$work/aligned.apk"
}
if [[ -n "${YANMO_ANDROID_KEYSTORE:-}" ]]; then
    : "${YANMO_ANDROID_KEY_ALIAS:?Required with a custom signing keystore}"
    : "${YANMO_ANDROID_STORE_PASSWORD:?Required with a custom signing keystore}"
    : "${YANMO_ANDROID_KEY_PASSWORD:?Required with a custom signing keystore}"
    sign --ks-key-alias "$YANMO_ANDROID_KEY_ALIAS" \
        --ks-pass env:YANMO_ANDROID_STORE_PASSWORD --key-pass env:YANMO_ANDROID_KEY_PASSWORD
else
    sign --ks-key-alias sound-software --ks-pass file:/dev/fd/3 \
        3< <(/usr/bin/security find-generic-password -a Happenmass -s dev.soundsoftware.app.release.signing -w)
fi
certificate=$("$tools/apksigner" verify --print-certs "$work/$artifact" | awk '/certificate SHA-256 digest/ {print $NF}')
if [[ "$certificate" != "$certificate_sha256" ]]; then
    printf '%s\n' 'The APK signing certificate must match the installed Yanmo and AI SDK release certificate.' >&2
    exit 1
fi
"$tools/zipalign" -c -P 16 4 "$work/$artifact"
mv "$work/$artifact" "$output/"
printf '%s\n' "$output/$artifact"
