import AppKit
import AVFoundation
import ApplicationServices
import Carbon
import YanmoCore

public struct InputDestination {
    public let application: NSRunningApplication
    public let element: AXUIElement?
    public let selection: CFRange?
    public let before: String
    public let after: String
    public let secure: Bool

    public var name: String { application.localizedName ?? "当前应用" }
    public var category: String { ApplicationCategory.detect(bundleID: application.bundleIdentifier ?? "") }

    private static func focusedElement(in app: NSRunningApplication) -> AXUIElement? {
        func focused(_ root: AXUIElement) -> AXUIElement? {
            var focus: CFTypeRef?
            guard AXIsProcessTrusted(), AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute as CFString, &focus) == .success,
                  let focus, CFGetTypeID(focus) == AXUIElementGetTypeID() else { return nil }
            return (focus as! AXUIElement)
        }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        return InputFocus.resolve(system: { focused(AXUIElementCreateSystemWide()) }, application: { focused(root) },
            prepareApplication: {
                // Electron exposes its Chromium tree to assistive clients through
                // this documented flag. It grants no macOS permission.
                AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            }, belongsToApplication: { element in
                var pid: pid_t = 0
                return AXUIElementGetPid(element, &pid) == .success && pid == app.processIdentifier
            })
    }

    public static func capture(readContext: Bool, in requestedApp: NSRunningApplication? = nil) -> InputDestination? {
        guard let app = requestedApp ?? NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        let focused = AXIsProcessTrusted() ? focusedElement(in: app) : nil
        var role: CFTypeRef?
        if let focused { AXUIElementCopyAttributeValue(focused, kAXRoleAttribute as CFString, &role) }
        let element = focused
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
                var placeholder: CFTypeRef?
                var characterCount: CFTypeRef?
                var title: CFTypeRef?
                var description: CFTypeRef?
                AXUIElementCopyAttributeValue(element, "AXPlaceholderValue" as CFString, &placeholder)
                AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute as CFString, &characterCount)
                AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
                AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &description)
                let context = InputContext.capture(value: text, selection: NSRange(location: range.location, length: range.length),
                                                   placeholder: placeholder as? String, characterCount: (characterCount as? NSNumber)?.intValue,
                                                   title: title as? String, description: description as? String)
                before = context.before
                after = context.after
            }
        }
        // Window/group/button focus alone says nothing about the editor's text.
        // Custom views without a text role or selection use window validation.
        let textInput = range != nil || ["AXTextArea", "AXTextField", "AXComboBox", "AXSecureTextField"].contains(role as? String ?? "")
        return InputDestination(application: app, element: textInput ? element : nil, selection: range, before: before, after: after, secure: secure)
    }

    /// Read only the explicit selection. Never substitute the whole field or an
    /// existing clipboard value when an application does not expose selected text.
    public func selectedText() async throws -> String {
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

    /// Deliver a normal paste to the application that owns focus now. The
    /// recording-time AX snapshot is context only, never an insertion lock.
    @MainActor
    public static func pasteAtCurrentFocus(_ text: String) async throws -> String {
        guard AXIsProcessTrusted() else { throw EngineError(message: "写入其他应用需要辅助功能权限。可先在文稿中复制文字。") }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else {
            throw EngineError(message: "无法创建粘贴操作，请手动复制正文。")
        }
        let clipboard = NSPasteboard.general
        let saved: [[NSPasteboard.PasteboardType: Data]] = (clipboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
        }
        clipboard.clearContents()
        clipboard.setString(text, forType: .string)
        let ownChange = clipboard.changeCount
        defer {
            if clipboard.changeCount == ownChange {
                clipboard.clearContents()
                let items = saved.map { values -> NSPasteboardItem in
                    let item = NSPasteboardItem()
                    for (type, data) in values { item.setData(data, forType: type) }
                    return item
                }
                if !items.isEmpty { clipboard.writeObjects(items) }
            }
        }
        // Resolve immediately before posting; do not activate a recorded app,
        // compare old selections, inspect AX setters, or gate on field visibility.
        guard let application = NSWorkspace.shared.frontmostApplication else {
            throw EngineError(message: "没有前台应用，正文已保留，请手动复制。")
        }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.postToPid(application.processIdentifier); up.postToPid(application.processIdentifier)
        try await Task.sleep(nanoseconds: 650_000_000)
        return application.localizedName ?? "当前应用"
    }

    @MainActor
    public func insert(_ text: String) async throws {
        _ = try await Self.pasteAtCurrentFocus(text)
    }
}
