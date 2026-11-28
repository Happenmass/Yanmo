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
YANMO_SETTINGS_ENTRY = "dev.yanmo.ime.SettingsEntry"
UPSTREAM_ACTIVITY = "com.kingzcheung.xime.MainActivity"
UPSTREAM_IME = "com.kingzcheung.xime.service.XimeInputMethodService"
LAUNCHER_CATEGORY = "android.intent.category.LAUNCHER"


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
    unused_permissions = {
        "android.permission.READ_CONTACTS", "android.permission.RECEIVE_SMS",
        "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
        "android.permission.READ_EXTERNAL_STORAGE", "android.permission.ACCESS_WIFI_STATE", "android.permission.WAKE_LOCK",
    }
    for permission in root.findall("uses-permission"):
        if permission.get(A + "name") in unused_permissions:
            root.remove(permission)
    camera = root.find(f"uses-feature[@{A}name='android.hardware.camera.any']")
    if camera is None:
        camera = ET.Element("uses-feature", {A + "name": "android.hardware.camera.any", A + "required": "false"})
        root.insert(0, camera)
    else:
        camera.set(A + "required", "false")
    required_permissions = (
        "android.permission.CAMERA",
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.CHANGE_WIFI_MULTICAST_STATE",
        "android.permission.REQUEST_INSTALL_PACKAGES",
        speech_package + ".permission.SPEECH",
    )
    for perm in required_permissions:
        if not any(item.get(A + "name") == perm for item in root.findall("uses-permission")):
            root.insert(0, ET.Element("uses-permission", {A + "name": perm}))
    app.set(A + "allowBackup", "false")
    app.set(A + "networkSecurityConfig", "@xml/network_security_config")
    app.set(A + "label", "@string/app_name")
    app.set(A + "icon", "@drawable/yanmo_mark")
    app.set(A + "roundIcon", "@drawable/yanmo_mark")
    for component in list(app):
        name = component.get(A + "name", "")
        target = component.get(A + "targetActivity")
        if (name in {UPSTREAM_ACTIVITY, "com.kingzcheung.xime.CustomLayoutActivity",
                     "com.kingzcheung.xime.service.AsrInferenceService",
                     "com.kingzcheung.xime.service.DevLearningReceiver",
                     "com.kingzcheung.xime.service.InferenceService",
                     "com.kingzcheung.xime.clipboard.VerificationCodeSmsReceiver",
                     "com.kingzcheung.xime.clipboard.ImageAccessActivity"}
                or name.startswith(("com.kingzcheung.xime.ocr.", "com.kingzcheung.xime.ui.caption."))
                or target == UPSTREAM_ACTIVITY):
            app.remove(component)
            continue
        for intent in component.findall("intent-filter"):
            if intent.find(f"category[@{A}name='{LAUNCHER_CATEGORY}']") is not None:
                component.remove(intent)
    service = next(item for item in app.findall("service") if item.get(A + "name") == UPSTREAM_IME)
    service.set(A + "name", YANMO_SERVICE)
    service.set(A + "label", "@string/app_name")
    launcher = ET.SubElement(app, "activity", {
        A + "name": YANMO_ACTIVITY,
        A + "exported": "true",
    })
    intent = ET.SubElement(launcher, "intent-filter")
    ET.SubElement(intent, "action", {A + "name": "android.intent.action.MAIN"})
    ET.SubElement(intent, "category", {A + "name": LAUNCHER_CATEGORY})
    ET.SubElement(app, "activity-alias", {
        A + "name": YANMO_SETTINGS_ENTRY,
        A + "targetActivity": YANMO_ACTIVITY,
        A + "exported": "true",
    })
    ET.SubElement(app, "activity", {
        A + "name": "dev.yanmo.ime.QrScannerActivity",
        A + "exported": "false",
        A + "theme": "@android:style/Theme.Material.Light.NoActionBar",
    })
    ET.SubElement(app, "service", {
        A + "name": "dev.yanmo.ime.SyncJobService",
        A + "permission": "android.permission.BIND_JOB_SERVICE",
        A + "exported": "false",
    })
    screenshot_service = ET.SubElement(app, "service", {
        A + "name": "dev.yanmo.ime.ScreenCapture",
        A + "label": "@string/yanmo_screenshot_service_label",
        A + "enabled": "@bool/yanmo_screenshot_service_supported",
        A + "exported": "true",
        A + "permission": "android.permission.BIND_ACCESSIBILITY_SERVICE",
    })
    screenshot_filter = ET.SubElement(screenshot_service, "intent-filter")
    ET.SubElement(screenshot_filter, "action", {A + "name": "android.accessibilityservice.AccessibilityService"})
    ET.SubElement(screenshot_service, "meta-data", {
        A + "name": "android.accessibilityservice",
        A + "resource": "@xml/yanmo_screenshot_service",
    })
    ET.SubElement(root.find("queries"), "package", {A + "name": speech_package})
    ET.indent(xml, space="    ")
    xml.write(path, encoding="utf-8", xml_declaration=True)


def source_ime(java):
    service = java / "service/XimeInputMethodService.kt"
    replace_once(service, "class XimeInputMethodService :", "open class XimeInputMethodService :")
    replace_once(java / "ui/theme/TonalThemes.kt",
                 "longArrayOf(0xF7E1D9, 0xFFFBF9, 0xE6C8BD, 0x34211A, 0xD1AFA3, 0x62453B, 0x534B49, 0xD8CFCC, 0xEFD9D1)",
                 "longArrayOf(0xF2EDE3, 0xFCFAF4, 0xE6DED1, 0x29251F, 0xE6B2A5, 0x992D24, 0x302B23, 0xDDD4C4, 0xF1D4CA)")
    replace_once(java / "ui/theme/TonalThemes.kt",
                 "longArrayOf(0x1E110C, 0x42332D, 0x32201A, 0xF6EEEB, 0x8E6F64, 0xEBC8BC, 0xBEB5B2, 0x332C2A, 0x30201A)",
                 "longArrayOf(0x24211F, 0x38332F, 0x302B27, 0xF3EBDF, 0x8E3D30, 0xF0BEAE, 0xE6DACE, 0x494039, 0x50322B)")


def wire_correction_learning(java):
    service = java / "service/XimeInputMethodService.kt"
    replace_once(service, "    internal val uiState = mutableStateOf(InputUIState())",
                 """    internal val uiState = mutableStateOf(InputUIState())

    protected open fun onYanmoManualCommit(editor: InputConnection, text: String) {}
    open fun onYanmoEditorAction(editor: InputConnection) {}
    protected fun yanmoComposing(): Boolean = inlineComposition.text != null || candidateState.value.isComposing
""")
    replace_once(service, "        if (isSensitive || isSecretEditor()) return TextCommitResult.ACCEPTED_HOST",
                 """        if (isSensitive || isSecretEditor()) return TextCommitResult.ACCEPTED_HOST
        if (!isPaste) onYanmoManualCommit(connection, delivered)""")
    router = java / "service/ImeKeyRouter.kt"
    replace_once(router, "        // Ctrl+回车在没声明动作的框里执行",
                 """        if (plan != EnterKeyAction.Newline) service.onYanmoEditorAction(ic)
        // Ctrl+回车在没声明动作的框里执行""")


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


def prune_legacy_sources(checkout, patches):
    subprocess.run(["git", "-C", str(checkout), "apply", str(patches / "yanmo-legacy-cleanup.patch")], check=True)
    for name in (patches / "yanmo-unused-source.txt").read_text().splitlines():
        if name and not name.startswith("#"):
            (checkout / name).unlink()
    assets = checkout / "app/src/main/assets"
    for name in ("handwriting", "ocr", "plugins", "licenses/ocr"):
        path = assets / name
        if path.is_dir():
            shutil.rmtree(path)


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

    subprocess.run(status + ["apply", str(android / "patches/yanmo-keyboard-ui.patch")], check=True)
    source_ime(src / "java/com/kingzcheung/xime")
    replace_once(app / "build.gradle.kts", 'applicationId = "com.cyletix.cyime"', 'applicationId = "dev.yanmo.ime"')
    write_manifest(src / "AndroidManifest.xml", args.speech_package)
    use_bundled_onnx_headers(app / "build-logic/tasks-native.gradle.kts")
    prune_legacy_sources(args.checkout, android / "patches")
    replace_once(
        app / "build.gradle.kts",
        '    implementation("com.google.zxing:core:3.5.4")',
        '    implementation("com.google.zxing:core:3.5.4")\n'
        '    implementation("org.bouncycastle:bcprov-jdk18on:1.79")\n'
        '    implementation("androidx.camera:camera-camera2:1.6.2")\n'
        '    implementation("androidx.camera:camera-lifecycle:1.6.2")\n'
        '    implementation("androidx.camera:camera-view:1.6.2")',
    )
    proguard = app / "proguard-rules.pro"
    proguard.write_text(proguard.read_text() + "\n-dontwarn org.bouncycastle.**\n")
    wire_correction_learning(src / "java/com/kingzcheung/xime")
    for strings in (src / "res").glob("values*/strings.xml"):
        content = strings.read_text()
        branded = re.sub(r">([^<>]*?)</string>",
                         lambda match: match.group(0).replace("CyIME", "言墨"), content)
        if content != branded:
            strings.write_text(branded)
    icon = src / "res/drawable-nodpi/yanmo_mark.png"
    icon.parent.mkdir(exist_ok=True)
    shutil.copyfile(android.parent / "site/assets/logo.png", icon)
    shutil.copytree(android / "src/main/res", src / "res", dirs_exist_ok=True)
    for name in ("polish.txt", "correction-terms.txt"):
        shutil.copyfile(android.parent / "engine" / name, src / "assets" / name)
    java = src / "java/dev/yanmo/ime"
    shutil.copytree(android / "src/main/java/dev/yanmo/ime", java)
    shutil.copytree(android / "src/main/kotlin/dev/yanmo/ime", java, dirs_exist_ok=True)
    (java / "PrototypeBuild.java").write_text(
        'package dev.yanmo.ime;\nfinal class PrototypeBuild {\n'
        f'    static final String SPEECH_PACKAGE = "{args.speech_package}";\n'
        '}\n')
    if args.keyboard_assets:
        target = src / "assets/rime_chinese/t9_ngram.lm"
        with ZipFile(args.keyboard_assets) as full, full.open("assets/rime_chinese/t9_ngram.lm") as data, \
                target.open("wb") as output:
            shutil.copyfileobj(data, output)
    print(args.checkout)


if __name__ == "__main__":
    main()
