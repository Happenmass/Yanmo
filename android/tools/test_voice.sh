#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
platform="${YANMO_ANDROID_PLATFORM:-$sdk/platforms/android-36/android.jar}"
tools="${YANMO_ANDROID_BUILD_TOOLS:-$sdk/build-tools/36.1.0}"
keystore="${YANMO_ANDROID_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/classes" "$work/dex" "$work/assets"
cp "$repo/engine/"{polish,correction-terms}.txt "$work/assets/"
cat > "$work/AndroidManifest.xml" <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.yanmo.ime.voiceprobe">
  <uses-permission android:name="android.permission.INTERNET"/>
  <permission android:name="dev.yanmo.ime.voiceprobe.permission.SPEECH" android:protectionLevel="signature"/>
  <uses-permission android:name="dev.yanmo.ime.voiceprobe.permission.SPEECH"/>
  <uses-permission android:name="dev.androidagent.sample.fixture.permission.SPEECH"/>
  <queries><package android:name="dev.androidagent.sample.fixture"/></queries>
  <application android:debuggable="true">
    <service android:name="dev.yanmo.ime.SpeechWireProbeService" android:exported="true"
        android:permission="dev.yanmo.ime.voiceprobe.permission.SPEECH"
        android:process=":speechwire" android:isolatedProcess="true">
      <intent-filter><action android:name="dev.androidagent.action.SPEECH_SERVICE_V1"/></intent-filter>
    </service>
  </application>
  <instrumentation android:name="dev.yanmo.ime.VoiceSessionProbe" android:targetPackage="dev.yanmo.ime.voiceprobe"/>
</manifest>
XML
main="$repo/android/src/main/java/dev/yanmo/ime"
javac --release 8 -cp "$platform" -d "$work/classes" \
    "$main"/{VoiceSession,VoiceFailureHistory,LocalAsr,Manuscripts,Lexicon,Polish,ScreenCapture,CorrectionWindow,EditorContext}.java \
    "$repo"/android/src/androidTest/java/dev/yanmo/ime/{VoiceSessionProbe,ManuscriptStoreProbe,SpeechWireProbeService}.java
jar cf "$work/classes.jar" -C "$work/classes" .
"$tools/d8" --lib "$platform" --min-api 28 --output "$work/dex" "$work/classes.jar"
"$tools/aapt2" link -I "$platform" --min-sdk-version 28 --target-sdk-version 35 \
    --manifest "$work/AndroidManifest.xml" -A "$work/assets" -o "$work/base.apk"
(cd "$work/dex" && zip -q "$work/base.apk" classes.dex)
"$tools/zipalign" -p -f 4 "$work/base.apk" "$work/aligned.apk"
"$tools/apksigner" sign --ks "$keystore" --ks-pass pass:android --out "$work/probe.apk" "$work/aligned.apk"

adb="$sdk/platform-tools/adb"
"$adb" install -r "$work/probe.apk"
output=$("$adb" shell am instrument -r -w "$@" dev.yanmo.ime.voiceprobe/dev.yanmo.ime.VoiceSessionProbe)
printf '%s\n' "$output"
[[ "$output" == *"Voice session passed:"* && "$output" == *"INSTRUMENTATION_CODE: -1"* ]]
