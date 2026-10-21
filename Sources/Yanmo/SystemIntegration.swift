import AppKit
import AVFoundation
import ApplicationServices
import Carbon
import YanmoCore

struct InputDestination {
    let application: NSRunningApplication
    let element: AXUIElement?
    let selection: CFRange?
    let before: String
    let after: String
    let secure: Bool

    var name: String { application.localizedName ?? "当前应用" }
    var category: String { ApplicationCategory.detect(bundleID: application.bundleIdentifier ?? "") }

    static func capture(readContext: Bool, in requestedApp: NSRunningApplication? = nil) -> InputDestination? {
        var focus: CFTypeRef?
        let system = requestedApp.map { AXUIElementCreateApplication($0.processIdentifier) } ?? AXUIElementCreateSystemWide()
        let valid = AXIsProcessTrusted() && AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focus) == .success
        var element: AXUIElement?
        if valid, let focus, CFGetTypeID(focus) == AXUIElementGetTypeID() { element = (focus as! AXUIElement) }
        // The focused field owns the destination; workspace activation can lag behind.
        var pid: pid_t = 0
        if let element { AXUIElementGetPid(element, &pid) }
        guard let app = (pid > 0 ? NSRunningApplication(processIdentifier: pid) : nil) ?? requestedApp ?? NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        if let requestedApp, app.processIdentifier != requestedApp.processIdentifier { return nil }
        var subrole: CFTypeRef?
        if let element { AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole) }
        let secure = subrole as? String == "AXSecureTextField"
        var range: CFRange?
        if let element, !secure {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
               let value, CFGetTypeID(value) == AXValueGetTypeID() {
                var selection = CFRange()
                if AXValueGetValue(value as! AXValue, .cfRange, &selection) { range = selection }
            }
        }
        var before = "", after = ""
        if readContext, !secure, let element, let range {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
               let text = value as? String {
                let ns = text as NSString
                let location = min(max(0, range.location), ns.length)
                let end = min(ns.length, location + max(0, range.length))
                before = ns.substring(with: NSRange(location: max(0, location - 300), length: min(300, location)))
                after = ns.substring(with: NSRange(location: end, length: min(300, ns.length - end)))
            }
        }
        return InputDestination(application: app, element: element, selection: range, before: before, after: after, secure: secure)
    }

    /// Read only the explicit selection. Never substitute the whole field or an
    /// existing clipboard value when an application does not expose selected text.
    func selectedText() async throws -> String {
        guard !secure else { throw EngineError(message: "密码输入框中的内容不支持划词翻译。") }
        guard AXIsProcessTrusted() else { throw EngineError(message: "划词翻译需要辅助功能权限，请在设置中允许言墨。") }
        func checked(_ text: String) throws -> String {
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { throw EngineError(message: "没有读取到选中文字，请先选中一段可复制的文本。") }
            guard value.count <= 4000 else { throw EngineError(message: "单次支持 4000 字以内的翻译，请缩小选区。") }
            return value
        }
        var accessibleText: String?
        if let element {
            var selected: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &selected) == .success,
               let text = selected as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { accessibleText = text }
            if let selection, selection.length > 0 {
                var value: CFTypeRef?
                AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
                if let text = value as? String {
                    let ns = text as NSString
                    if selection.location >= 0, selection.location <= ns.length, selection.length <= ns.length - selection.location {
                        if accessibleText == nil { accessibleText = ns.substring(with: NSRange(location: selection.location, length: selection.length)) }
                    }
                }
            }
        }
        if let accessibleText { _ = try checked(accessibleText) }
        if accessibleText == nil, let selection, selection.length == 0 {
            throw EngineError(message: "请先选中文字，再按划词翻译快捷键。")
        }
        guard !application.isTerminated, NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
            // Explicit background verification/native selections can still use AX.
            if let accessibleText { return try checked(accessibleText) }
            throw EngineError(message: "原应用已切换，请重新选中文字再翻译。")
        }
        let clipboard = NSPasteboard.general
        let saved: [[NSPasteboard.PasteboardType: Data]] = (clipboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
        }
        clipboard.clearContents()
        let cleared = clipboard.changeCount
        var ownedChange = cleared
        defer {
            if clipboard.changeCount == ownedChange {
                clipboard.clearContents()
                let items = saved.map { values -> NSPasteboardItem in
                    let item = NSPasteboardItem()
                    for (type, data) in values { item.setData(data, forType: type) }
                    return item
                }
                if !items.isEmpty { clipboard.writeObjects(items) }
            }
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 8, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 8, keyDown: false) else {
            throw EngineError(message: "无法读取选区，请重试。")
        }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 40_000_000)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
                throw EngineError(message: "读取时切换了应用，请重新选择文字。")
            }
            if clipboard.changeCount != cleared {
                ownedChange = clipboard.changeCount
                let plain = clipboard.string(forType: .string) ?? ""
                // A custom Copy handler must not expand an explicit AX selection.
                func compact(_ text: String) -> String { text.filter { !$0.isWhitespace } }
                if let accessibleText, compact(plain) != compact(accessibleText) { return try checked(accessibleText) }
                return try checked(SelectionMarkdown.fromCopiedText(plain, html: clipboard.string(forType: .html)))
            }
        }
        if let accessibleText { return try checked(accessibleText) }
        throw EngineError(message: "没有读取到选中文字。请确认文本可复制；图片中的文字暂不支持。")
    }

    /// Writes only to the original focused field. Read back before reporting success.
    func insert(_ text: String) async throws {
        guard !secure else { throw EngineError(message: "密码输入框中不写入语音文字。正文已保留在文稿中。") }
        guard AXIsProcessTrusted() else { throw EngineError(message: "写入其他应用需要辅助功能权限。可先在文稿中复制文字。") }
        guard !application.isTerminated, let element else {
            throw EngineError(message: "无法确认原输入框的位置。正文已保留，请手动复制。")
        }
        var rangeValue: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeValue)
        var current = CFRange()
        if let selection {
            guard let rangeValue, CFGetTypeID(rangeValue) == AXValueGetTypeID(),
                  AXValueGetValue(rangeValue as! AXValue, .cfRange, &current),
                  current.location == selection.location, current.length == selection.length else {
                throw EngineError(message: "光标位置已改变，正文已保留，请手动复制。")
            }
        }
        var oldValue: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &oldValue)
        func verified() -> Bool {
            var updatedValue: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &updatedValue)
            guard let old = oldValue as? String, let updated = updatedValue as? String else { return false }
            guard let selection else {
                // Web editors may expose a value but no AX cursor range.
                return updated != old && updated.contains(text)
            }
            let oldNS = old as NSString
            guard selection.location >= 0, selection.length >= 0, selection.location + selection.length <= oldNS.length else { return false }
            return updated == oldNS.replacingCharacters(in: NSRange(location: selection.location, length: selection.length), with: text)
        }
        var settable = DarwinBoolean(false)
        // Web editors often have JS-controlled input state. Their AX setters can
        // report success without firing input events, so use normal paste there.
        var inWebContent = false
        var ancestor: AXUIElement? = element
        for _ in 0..<16 {
            guard let node = ancestor else { break }
            var role: CFTypeRef?
            AXUIElementCopyAttributeValue(node, kAXRoleAttribute as CFString, &role)
            if role as? String == "AXWebArea" { inWebContent = true; break }
            var parent: CFTypeRef?
            AXUIElementCopyAttributeValue(node, kAXParentAttribute as CFString, &parent)
            if let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() { ancestor = (parent as! AXUIElement) }
            else { ancestor = nil }
        }
        // A focused rich editor can acknowledge AXSelectedText without updating
        // its real input state. Prefer ordinary paste in the active application.
        let targetIsActive = NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier
        if !targetIsActive, !inWebContent, selection != nil,
           AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success,
           settable.boolValue,
           AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success {
            try await Task.sleep(nanoseconds: 80_000_000)
            if verified() { return }
            // Never follow a successful AX mutation with a paste: it could duplicate text.
            throw EngineError(message: "输入框已接受写入，但无法读回核验。请检查原输入框，正文仍保留在文稿中。", writeAttempted: true)
        }
        // Editors without a writable AX selection need a foreground paste.
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != application.processIdentifier {
            guard application.activate() else { throw EngineError(message: "无法回到原应用，请手动复制正文。") }
            try await Task.sleep(nanoseconds: 180_000_000)
        }
        var focus: CFTypeRef?
        AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &focus)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier,
              let focus, CFEqual(element, focus) else {
            throw EngineError(message: "无法回到原输入框，正文已保留，请手动复制。")
        }
        // Preserve every pasteboard representation, and avoid replacing a newer copy.
        let clipboard = NSPasteboard.general
        let saved: [[NSPasteboard.PasteboardType: Data]] = (clipboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
        }
        clipboard.clearContents()
        clipboard.setString(text, forType: .string)
        let ownChange = clipboard.changeCount
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else {
            throw EngineError(message: "无法创建粘贴操作，请手动复制正文。")
        }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        try await Task.sleep(nanoseconds: 650_000_000)
        if clipboard.changeCount == ownChange {
            clipboard.clearContents()
            let items = saved.map { values -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for (type, data) in values { item.setData(data, forType: type) }
                return item
            }
            if !items.isEmpty { clipboard.writeObjects(items) }
        }
        if verified() { return }
        throw EngineError(message: "已尝试粘贴，但目标应用未提供可核验的结果。请检查输入框；文稿保留了正文。", writeAttempted: true)
    }
}
