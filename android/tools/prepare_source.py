#!/usr/bin/env python3
"""Apply the Yanmo source integration to a clean pinned CyIME checkout."""

import argparse
from hashlib import file_digest
from pathlib import Path
import re
import shutil
import subprocess
from zipfile import ZipFile
import xml.etree.ElementTree as ET


PIN = "6f97a555ced063c0bcad73c600fe420f5e4b2536"
FULL_SHA = "d121abd5345b6f02202803ba10b9368c39a84e49f549143199f5edd38ca19e86"
MANIFEST_NS = "http://schemas.android.com/apk/res/android"
TOOLS_NS = "http://schemas.android.com/tools"
A = f"{{{MANIFEST_NS}}}"
YANMO_SERVICE = "dev.yanmo.ime.YanmoInputMethodService"
YANMO_ACTIVITY = "dev.yanmo.ime.YanmoActivity"
UPSTREAM_ACTIVITY = "com.kingzcheung.xime.MainActivity"
UPSTREAM_IME = "com.kingzcheung.xime.service.XimeInputMethodService"


def replace_once(path, original, modified):
    text = path.read_text()
    if text.count(original) != 1:
        raise ValueError(f"Expected exactly one upstream anchor {original!r} in {path}")
    path.write_text(text.replace(original, modified))


def write_manifest(path, speech_package):
    ET.register_namespace("android", MANIFEST_NS)
    ET.register_namespace("tools", TOOLS_NS)
    xml = ET.parse(path)
    root = xml.getroot()
    app = root.find("application")
    app.set(A + "allowBackup", "false")
    app.set(A + "label", "言墨")
    for item in app.findall("activity-alias"):
        if item.get(A + "targetActivity") == UPSTREAM_ACTIVITY:
            item.set(A + "enabled", "false")
            item.set(A + "icon", "@mipmap/cyime_launcher_facet")
            item.set(A + "label", "言墨")
    service = next(item for item in app.findall("service") if item.get(A + "name") == UPSTREAM_IME)
    service.set(A + "name", YANMO_SERVICE)
    service.set(A + "label", "言墨")
    launcher = ET.SubElement(app, "activity", {
        A + "name": YANMO_ACTIVITY,
        A + "exported": "true",
    })
    intent = ET.SubElement(launcher, "intent-filter")
    ET.SubElement(intent, "action", {A + "name": "android.intent.action.MAIN"})
    ET.SubElement(intent, "category", {A + "name": "android.intent.category.LAUNCHER"})
    ET.SubElement(app, "service", {
        A + "name": "dev.yanmo.ime.ScreenCapture",
        A + "exported": "false",
        A + "foregroundServiceType": "mediaProjection",
    })
    for permission in (
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
        speech_package + ".permission.SPEECH",
    ):
        if not any(item.get(A + "name") == permission for item in root.findall("uses-permission")):
            root.insert(0, ET.Element("uses-permission", {A + "name": permission}))
    ET.SubElement(root.find("queries"), "package", {A + "name": speech_package})
    ET.indent(xml, space="    ")
    xml.write(path, encoding="utf-8", xml_declaration=True)


def source_ime(java):
    service = java / "service/XimeInputMethodService.kt"
    replace_once(service, "class XimeInputMethodService :", "open class XimeInputMethodService :")
    handlers = java / "service/ImeKeyboardCallbacks.kt"
    replace_once(handlers, """            onVoiceStickyToggle = {
                val state = service.uiState.value
                if (state.isVoiceMode""", """            onVoiceStickyToggle = {
                val state = service.uiState.value
                if (service is dev.yanmo.ime.YanmoInputMethodService) {
                    service.onDictationHoldStart()
                } else if (state.isVoiceMode""")
    replace_once(handlers, """                if (state.isVoiceMode && state.voiceSticky) service.endVoiceSession()
            },""", """                if (service is dev.yanmo.ime.YanmoInputMethodService) service.onDictationHoldEnd()
                else if (state.isVoiceMode && state.voiceSticky) service.endVoiceSession()
            },""")
    replace_once(handlers, """                if (state.isVoiceMode && state.voiceSticky) service.cancelVoiceSession()
            },""", """                if (service is dev.yanmo.ime.YanmoInputMethodService) service.onDictationHoldCancel()
                else if (state.isVoiceMode && state.voiceSticky) service.cancelVoiceSession()
            },""")
    replace_once(java / "ui/theme/TonalThemes.kt",
                 "longArrayOf(0xF7E1D9, 0xFFFBF9, 0xE6C8BD, 0x34211A, 0xD1AFA3, 0x62453B, 0x534B49, 0xD8CFCC, 0xEFD9D1)",
                 "longArrayOf(0xF2EDE3, 0xFCFAF4, 0xE6DED1, 0x29251F, 0xE6B2A5, 0x992D24, 0x302B23, 0xDDD4C4, 0xF1D4CA)")


def use_bundled_onnx_headers(path):
    text = path.read_text()
    start = text.index("        // 下载 v1.28 core/session/")
    end = text.index("        // 4. Marker", start)
    path.write_text(text[:start] + """        // The same official Maven AAR ships the version-matched native headers.
        val dstHeaders = file("$cppDir/include")
        val aarHeaders = File(aarDir, "headers")
        check(File(aarHeaders, "onnxruntime_c_api.h").isFile) { "Missing ONNX Runtime C API header" }
        aarHeaders.copyRecursively(dstHeaders, overwrite = true)

""" + text[end:])


def use_external_speech(app):
    speech = app / "build-logic/tasks-speech.gradle.kts"
    replace_once(speech, """        fetch("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
            File(speechAssets.get().asFile, "speech/silero_vad.onnx"),
            "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")""",
                 """        // Legacy sources still compile against the AAR. Yanmo does not use its VAD model.
        speechAssets.get().asFile.mkdirs()""")
    replace_once(app / "build.gradle.kts",
                 'apply(from = "build-logic/tasks-offline-translate.gradle.kts")\n', '')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("--speech-package", default="dev.androidagent.sample")
    parser.add_argument("--keyboard-assets", type=Path,
                        help="verified CyIME full APK to supply the optional upstream T9 language model")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+", args.speech_package):
        parser.error("Invalid speech service application ID")
    android = Path(__file__).resolve().parents[1]
    app = args.checkout / "app"
    src = app / "src/main"
    status = ["git", "-C", str(args.checkout)]
    if subprocess.check_output(status + ["rev-parse", "HEAD"], text=True).strip() != PIN:
        parser.error(f"Expected upstream commit {PIN}")
    if subprocess.check_output(status + ["status", "--porcelain"], text=True):
        parser.error("The upstream checkout must be clean")
    if args.keyboard_assets:
        with args.keyboard_assets.open("rb") as apk:
            if file_digest(apk, "sha256").hexdigest() != FULL_SHA:
                parser.error("Unexpected checksum for the upstream full APK")

    source_ime(src / "java/com/kingzcheung/xime")
    replace_once(app / "build.gradle.kts", 'applicationId = "com.cyletix.cyime"', 'applicationId = "dev.yanmo.ime"')
    write_manifest(src / "AndroidManifest.xml", args.speech_package)
    use_bundled_onnx_headers(app / "build-logic/tasks-native.gradle.kts")
    use_external_speech(app)
    replace_once(src / "res/values/strings.xml",
                 '<string name="app_name" translatable="false">CyIME</string>',
                 '<string name="app_name" translatable="false">言墨</string>')
    icon_variants = list((src / "res").glob("mipmap*/cyime_launcher_facet.xml"))
    for icon in icon_variants:
        icon.unlink()
    icon = src / "res/mipmap-xxxhdpi/cyime_launcher_facet.png"
    icon.parent.mkdir(exist_ok=True)
    shutil.copyfile(android.parent / "site/assets/logo.png", icon)
    shutil.copyfile(android.parent / "engine/polish.txt", src / "assets/polish.txt")
    java = src / "java/dev/yanmo/ime"
    shutil.copytree(android / "src/main/java/dev/yanmo/ime", java)
    (java / "PrototypeBuild.java").write_text(
        'package dev.yanmo.ime;\nfinal class PrototypeBuild {\n'
        f'    static final String SPEECH_PACKAGE = "{args.speech_package}";\n'
        '    static final boolean SOURCE_HOOK = true;\n}\n')
    if args.keyboard_assets:
        target = src / "assets/rime_chinese/t9_ngram.lm"
        with ZipFile(args.keyboard_assets) as full, full.open("assets/rime_chinese/t9_ngram.lm") as data, \
                target.open("wb") as output:
            shutil.copyfileobj(data, output)
    print(args.checkout)


if __name__ == "__main__":
    main()
