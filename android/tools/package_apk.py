#!/usr/bin/env python3
"""Assemble the Yanmo overlay while preserving the pinned CyIME APK's resource IDs."""

import argparse
from dataclasses import dataclass
from hashlib import sha1
from pathlib import Path
import re
import struct
from zipfile import ZIP_DEFLATED, ZipFile
from zlib import adler32


APK_PACKAGE = "com.cyletix.cyime"
YANMO_PACKAGE = "dev.yanmo.ime"
UPSTREAM_IME = "com.kingzcheung.xime.service.XimeInputMethodService"
YANMO_IME = YANMO_PACKAGE + ".YanmoInputMethodService"
ANDROID_URI = "http://schemas.android.com/apk/res/android"
NONE = 0xFFFFFFFF
STRING = 3
BOOL = 18
INT = 17
REF = 1
ICON_PATH = "res/kA.xml"
YANMO_ICON_PATH = "res/kA.png"
ICON_ID = 0x7F0D000D


def u16(buf, offset):
    return struct.unpack_from("<H", buf, offset)[0]


def u32(buf, offset):
    return struct.unpack_from("<I", buf, offset)[0]


def chunk(kind, header, tail=b""):
    return struct.pack("<HHI", kind, len(header) + 8, len(header) + 8 + len(tail)) + header + tail


def utf16_pool(strings):
    encoded = bytearray()
    offsets = []
    for value in strings:
        offsets.append(len(encoded))
        raw = value.encode("utf-16le")
        units = len(raw) // 2
        if units >= 0x8000:
            encoded += struct.pack("<H", 0x8000 | units >> 16)
        encoded += struct.pack("<H", units & 0x7fff) + raw + b"\0\0"
    encoded += bytes(-len(encoded) % 4)
    header = struct.pack("<5I", len(strings), 0, 0, 28 + 4 * len(strings), 0)
    return chunk(1, header, struct.pack(f"<{len(offsets)}I", *offsets) + encoded)


def read_pool(data):
    count, styles, flags, start, _ = struct.unpack_from("<5I", data, 8)
    if styles:
        raise ValueError("unexpected styled binary XML string")
    result = []
    for index in range(count):
        pos = start + u32(data, 28 + 4 * index)
        if flags & 0x100:
            pos += 2 if data[pos] & 0x80 else 1  # UTF-16 length
            length = data[pos]
            pos += 1
            if length & 0x80:
                length = ((length & 0x7f) << 8) | data[pos]
                pos += 1
            result.append(data[pos:pos + length].decode("utf-8"))
        else:
            length = u16(data, pos)
            pos += 2
            if length & 0x8000:
                length = ((length & 0x7fff) << 16) | u16(data, pos)
                pos += 2
            result.append(data[pos:pos + length * 2].decode("utf-16le"))
    return result


@dataclass
class Tag:
    name: int
    attrs: list
    index: int
    end: int = 0


class Axml:
    def __init__(self, data):
        self.parts = []
        self.tags = []
        self.ids = []
        self.updates = {}
        stack = []
        pos = 8
        while pos < len(data):
            kind = u16(data, pos)
            size = u32(data, pos + 4)
            raw = data[pos:pos + size]
            index = len(self.parts)
            self.parts.append(raw)
            if kind == 1:
                self.strings = read_pool(raw)
                self.pool_index = index
            elif kind == 0x180:
                self.ids = list(struct.unpack(f"<{(size - 8)//4}I", raw[8:]))
                self.map_index = index
            elif kind == 0x102:
                name = u32(raw, 20)
                attrs = [list(struct.unpack_from("<IIIHBBI", raw, 36 + i * 20))
                         for i in range(u16(raw, 28))]
                tag = Tag(name, attrs, index)
                stack.append(tag)
                self.tags.append(tag)
            elif kind == 0x103:
                stack.pop().end = index
            pos += size
        self.android = self.intern(ANDROID_URI)

    def intern(self, value):
        if value not in self.strings:
            self.strings.append(value)
        return self.strings.index(value)

    def find(self, tag, name=None):
        return next(t for t in self.tags if self.strings[t.name] == tag
                    and (name is None or self.get(t, "name") == name))

    def get(self, tag, name):
        for attr in tag.attrs:
            if self.strings[attr[1]] == name:
                return self.strings[attr[6]] if attr[5] == STRING else attr[6]
        return None

    def attr(self, name, value, ns=True, kind=STRING):
        namespace = self.android if ns else NONE
        index = self.intern(name)
        if ns and (index >= len(self.ids) or not self.ids[index]):
            # Framework attribute IDs are needed for PackageParser's styleable lookups.
            resource_id = {"foregroundServiceType": 0x01010599}.get(name)
            if resource_id is None:
                raise ValueError(f"unknown framework attribute: {name}")
            self.ids.extend([0] * (index + 1 - len(self.ids)))
            self.ids[index] = resource_id
        data = self.intern(value) if kind == STRING else value
        return [namespace, index, data if kind == STRING else NONE, 8, 0, kind, data]

    def set(self, tag, name, value, ns=True, kind=STRING):
        replacement = self.attr(name, value, ns, kind)
        tag.attrs = [attr for attr in tag.attrs if attr[:2] != replacement[:2]] + [replacement]
        self.parts[tag.index] = self.start(tag.name, tag.attrs, self.parts[tag.index][8:16])

    def start(self, name, attrs, node=struct.pack("<II", 0, NONE)):
        def attr_key(attr):
            index = attr[1]
            return self.ids[index] if attr[0] != NONE and index < len(self.ids) else 0

        attrs = sorted(attrs, key=attr_key)
        values = b"".join(struct.pack("<IIIHBBI", *attr) for attr in attrs)
        body = struct.pack("<II6H", NONE, name, 20, 20, len(attrs), 0, 0, 0)
        return chunk(0x102, node, body + values)

    def element(self, name, attrs=(), children=b""):
        tag = self.intern(name)
        attr_data = [self.attr(*attr) for attr in attrs]
        node = struct.pack("<II", 0, NONE)
        return self.start(tag, attr_data) + children + chunk(0x103, node, struct.pack("<II", NONE, tag))

    def add(self, parent, name, attrs, prepend=False, children=b""):
        content = self.element(name, attrs, children)
        index = parent.index + 1 if prepend else parent.end
        self.updates[index] = self.updates.get(index, b"") + content

    def serialize(self):
        self.parts[self.pool_index] = utf16_pool(self.strings)
        self.parts[self.map_index] = chunk(0x180, b"", struct.pack(f"<{len(self.ids)}I", *self.ids))
        body = b"".join(self.updates.get(i, b"") + part for i, part in enumerate(self.parts))
        return chunk(3, b"", body)


def update_manifest(data, speech_package):
    xml = Axml(data)
    root = xml.find("manifest")
    app = xml.find("application")
    xml.set(root, "package", YANMO_PACKAGE, ns=False)
    xml.set(app, "label", "言墨")
    xml.set(app, "allowBackup", 0, kind=BOOL)
    for tag in xml.tags:
        authority = xml.get(tag, "authorities")
        if isinstance(authority, str) and authority.startswith(APK_PACKAGE + "."):
            xml.set(tag, "authorities", YANMO_PACKAGE + authority[len(APK_PACKAGE):])
        component_permission = xml.get(tag, "permission")
        if isinstance(component_permission, str) and component_permission.startswith(APK_PACKAGE + "."):
            xml.set(tag, "permission", YANMO_PACKAGE + component_permission[len(APK_PACKAGE):])
        tag_name = xml.strings[tag.name]
        if tag_name in ("permission", "uses-permission"):
            value = xml.get(tag, "name")
            if isinstance(value, str) and value.startswith(APK_PACKAGE + "."):
                xml.set(tag, "name", YANMO_PACKAGE + value[len(APK_PACKAGE):])
        if tag_name == "activity-alias" and xml.get(tag, "targetActivity") == "com.kingzcheung.xime.MainActivity":
            # Retain aliases for CyIME's settings code but the prototype uses its own launcher.
            xml.set(tag, "targetActivity", YANMO_PACKAGE + ".YanmoActivity")
            xml.set(tag, "label", "言墨")
            xml.set(tag, "icon", ICON_ID, kind=REF)
            xml.set(tag, "enabled", 0, kind=BOOL)
    ime = xml.find("service", UPSTREAM_IME)
    xml.set(ime, "name", YANMO_IME)
    xml.set(ime, "label", "言墨")
    launcher = xml.element("intent-filter", children=
                           xml.element("action", [("name", "android.intent.action.MAIN")]) +
                           xml.element("category", [("name", "android.intent.category.LAUNCHER")]))
    xml.add(app, "activity", [
        ("name", YANMO_PACKAGE + ".YanmoActivity"),
        ("exported", NONE, True, BOOL),
    ], prepend=True, children=launcher)
    xml.add(app, "service", [
        ("name", YANMO_PACKAGE + ".ScreenCapture"),
        ("exported", 0, True, BOOL),
        ("foregroundServiceType", 32, True, INT),
    ])
    for permission in (
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
        speech_package + ".permission.SPEECH",
    ):
        if not any(xml.strings[tag.name] == "uses-permission" and xml.get(tag, "name") == permission
                   for tag in xml.tags):
            xml.add(root, "uses-permission", [("name", permission)], prepend=True)
    xml.add(xml.find("queries"), "package", [("name", speech_package)])
    return xml.serialize()


def rename_resource_package(data):
    patched = bytearray(data)
    pos = u16(data, 2)
    while pos < len(data):
        if u16(data, pos) == 0x0200:
            start = pos + 12
            current = data[start:start + 256].decode("utf-16le").split("\0", 1)[0]
            if current == APK_PACKAGE:
                patched[start:start + 256] = YANMO_PACKAGE.encode("utf-16le").ljust(256, b"\0")
                old = ICON_PATH.encode("ascii")
                new = YANMO_ICON_PATH.encode("ascii")
                if patched.count(old) != 1:
                    raise ValueError("the pinned CyIME launcher icon was missing or ambiguous")
                return patched.replace(old, new)
        pos += u32(data, pos + 4)
    raise ValueError("the pinned CyIME resource package was missing")


def uleb(data, offset):
    value = 0
    shift = 0
    while True:
        byte = data[offset]
        value |= (byte & 0x7f) << shift
        offset += 1
        if byte < 0x80:
            return value, offset
        shift += 7


def clear_lifecycle_final(data, class_def):
    method_ids = u32(data, 92)
    string_ids = u32(data, 60)
    lifecycle = {b"onCreate", b"onCreateInputView", b"onStartInput",
                 b"onFinishInputView", b"onFinishInput", b"onDestroy"}
    offset = u32(data, class_def + 24)
    counts = []
    for _ in range(4):
        count, offset = uleb(data, offset)
        counts.append(count)
    for _ in range(counts[0] + counts[1]):
        _, offset = uleb(data, offset)
        _, offset = uleb(data, offset)
    for count in counts[2:]:
        method = 0
        for _ in range(count):
            delta, offset = uleb(data, offset)
            method += delta
            flags_offset = offset
            _, offset = uleb(data, offset)
            _, offset = uleb(data, offset)
            string = u32(data, method_ids + 8 * method + 4)
            _, name_start = uleb(data, u32(data, string_ids + 4 * string))
            name = bytes(data[name_start:data.index(b"\0", name_start)])
            if name in lifecycle:
                data[flags_offset] &= ~16
                lifecycle.remove(name)
    if lifecycle:
        raise ValueError(f"the pinned CyIME lifecycle methods were missing: {lifecycle}")


def open_upstream_ime(data):
    # DEX class_defs stores access_flags separately from methods. Keep all code and references intact.
    string_ids, type_ids = u32(data, 60), u32(data, 68)
    class_count, class_defs = u32(data, 96), u32(data, 100)
    descriptor = "L" + UPSTREAM_IME.replace(".", "/") + ";"
    for index in range(class_count):
        pos = class_defs + 32 * index
        string_id = u32(data, type_ids + 4 * u32(data, pos))
        start = u32(data, string_ids + 4 * string_id)
        while data[start] & 0x80:
            start += 1
        start += 1
        if data[start:data.index(b"\0", start)] != descriptor.encode("ascii"):
            continue
        patched = bytearray(data)
        flags = u32(data, pos + 4)
        struct.pack_into("<I", patched, pos + 4, flags & ~16)
        clear_lifecycle_final(patched, pos)
        # Replace the light variant of upstream cream_beige. Colors appear in
        # TonalThemes as a single 64-bit DEX fill-array-data payload.
        old = struct.pack("<9Q", 0xF7E1D9, 0xFFFBF9, 0xE6C8BD, 0x34211A, 0xD1AFA3,
                          0x62453B, 0x534B49, 0xD8CFCC, 0xEFD9D1)
        paper = struct.pack("<9Q", 0xF2EDE3, 0xFCFAF4, 0xE6DED1, 0x29251F, 0xE6B2A5,
                            0x992D24, 0x302B23, 0xDDD4C4, 0xF1D4CA)
        if patched.count(old) != 1:
            raise ValueError("the pinned CyIME cream palette was missing or ambiguous")
        patched = patched.replace(old, paper)
        patched[12:32] = sha1(patched[32:]).digest()
        struct.pack_into("<I", patched, 8, adler32(patched[12:]))
        return patched, True
    return data, False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("upstream", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("overlay_dex", type=Path)
    parser.add_argument("speech_package")
    parser.add_argument("--keyboard-assets", type=Path)
    args = parser.parse_args()
    android = Path(__file__).resolve().parents[1]
    patched = False
    dex_index = 1
    grammar = "assets/rime_chinese/t9_ngram.lm"
    grammar_manifest = "assets/rime-bundled-manifest.tsv"
    with ZipFile(args.upstream) as upstream, ZipFile(args.output, "w", ZIP_DEFLATED) as output:
        for entry in upstream.infolist():
            name = entry.filename
            if name == ICON_PATH or args.keyboard_assets and name in (grammar, grammar_manifest):
                continue
            if re.fullmatch(r"META-INF/(MANIFEST.MF|.*\.(SF|RSA|DSA|EC))", name, re.IGNORECASE):
                continue
            data = upstream.read(entry)
            dex = re.fullmatch(r"classes(\d*)\.dex", name)
            if dex:
                dex_index = max(dex_index, int(dex[1] or "1"))
                data, found = open_upstream_ime(data)
                patched |= found
            if name == "AndroidManifest.xml":
                data = update_manifest(data, args.speech_package)
            elif name == "resources.arsc":
                data = rename_resource_package(data)
            output.writestr(entry, data)
        if not patched:
            raise ValueError("the pinned CyIME input service class was missing")
        for dex in sorted(args.overlay_dex.glob("classes*.dex")):
            dex_index += 1
            output.write(dex, f"classes{dex_index}.dex")
        if args.keyboard_assets:
            with ZipFile(args.keyboard_assets) as full:
                output.writestr(full.getinfo(grammar), full.read(grammar))
                output.writestr(full.getinfo(grammar_manifest), full.read(grammar_manifest))
        output.write(android.parent / "engine/polish.txt", "assets/polish.txt")
        output.write(android.parent / "site/assets/logo.png", YANMO_ICON_PATH)


if __name__ == "__main__":
    main()
