#!/usr/bin/env bash
# Build the arm64 Yanmo prototype from the checksum-locked regular CyIME release.
set -euo pipefail
android_root="$(cd "$(dirname "$0")" && pwd)"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
tools="$sdk/build-tools/${YANMO_ANDROID_BUILD_TOOLS:-36.1.0}"
platform="$sdk/platforms/android-36/android.jar"
output="$android_root/build"
cache="${YANMO_ANDROID_CACHE:-$HOME/.cache/codex/yanmo-android}"
speech="${YANMO_SPEECH_PACKAGE:-dev.androidagent.sample}"
[[ "$speech" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]] || {
    printf '%s\n' 'YANMO_SPEECH_PACKAGE must be a valid Android application ID' >&2
    exit 1
}
java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}"
for tool in "$tools/d8" "$tools/zipalign" "$tools/apksigner"; do
    test -x "$tool" || { printf 'Missing Android SDK tool: %s\n' "$tool" >&2; exit 1; }
done
test -f "$platform"

mkdir -p "$cache" "$output"
version=1.15.94
release="https://github.com/Cyletix/CyIME/releases/download/$version"
base="$cache/CyIME-$version-arm64-v8a.apk"
full="$cache/CyIME-$version-full-arm64-v8a.apk"
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
fetch "$base" cfd89ac151f90298b70824007f5c03193e183c72cb26d0eb45ef00976b65e7f4
keyboard_assets=()
if [[ "${YANMO_LIGHT_KEYBOARD:-0}" != 1 ]]; then
    fetch "$full" d121abd5345b6f02202803ba10b9368c39a84e49f549143199f5edd38ca19e86
    keyboard_assets=(--keyboard-assets "$full")
fi

work="$(mktemp -d "$output/.build.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work"/{stub,classes,dex,generated/dev/yanmo/ime}
cat > "$work/generated/dev/yanmo/ime/PrototypeBuild.java" <<EOF
package dev.yanmo.ime;
final class PrototypeBuild {
    static final String SPEECH_PACKAGE = "$speech";
    static final boolean SOURCE_HOOK = false;
}
EOF
"${java_bin}javac" --release 17 -classpath "$platform" -d "$work/stub" \
    "$android_root/src/upstream-stub/com/kingzcheung/xime/service/XimeInputMethodService.java"
find "$android_root/src/main/java" "$work/generated" -type f -name '*.java' -print0 |
    xargs -0 "${java_bin}javac" --release 17 -encoding UTF-8 -classpath "$platform:$work/stub" -d "$work/classes"
"${java_bin}jar" --create --file "$work/overlay.jar" -C "$work/classes" .
"$tools/d8" --min-api 28 --lib "$platform" --classpath "$work/stub" --output "$work/dex" "$work/overlay.jar"

python3 "$android_root/tools/package_apk.py" "$base" "$work/unsigned.apk" "$work/dex" "$speech" ${keyboard_assets[@]+"${keyboard_assets[@]}"}
"$tools/zipalign" -f -P 16 4 "$work/unsigned.apk" "$work/aligned.apk"

artifact="Yanmo-Android-Prototype-arm64-v8a.apk"
if [[ "$speech" != dev.androidagent.sample ]]; then
    artifact="Yanmo-Android-Prototype-arm64-v8a-$speech.apk"
fi
keystore="${YANMO_ANDROID_KEYSTORE:-$HOME/.android/debug.keystore}"
if [[ -z "${YANMO_ANDROID_KEYSTORE:-}" && ! -f "$keystore" ]]; then
    mkdir -p "$(dirname "$keystore")"
    "${java_bin}keytool" -genkeypair -keystore "$keystore" -storetype PKCS12 \
        -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 \
        -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi
if [[ -n "${YANMO_ANDROID_KEYSTORE:-}" ]]; then
    : "${YANMO_ANDROID_KEY_ALIAS:?Required with a custom signing keystore}"
    : "${YANMO_ANDROID_STORE_PASSWORD:?Required with a custom signing keystore}"
    : "${YANMO_ANDROID_KEY_PASSWORD:?Required with a custom signing keystore}"
    signing=(--ks-key-alias "$YANMO_ANDROID_KEY_ALIAS" --ks-pass env:YANMO_ANDROID_STORE_PASSWORD --key-pass env:YANMO_ANDROID_KEY_PASSWORD)
else
    signing=(--ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android)
fi
"$tools/apksigner" sign --ks "$keystore" "${signing[@]}" --v1-signing-enabled true \
    --out "$work/$artifact" "$work/aligned.apk"
"$tools/apksigner" verify "$work/$artifact"
mv "$work/$artifact" "$output/"
printf '%s\n' "$output/$artifact"
