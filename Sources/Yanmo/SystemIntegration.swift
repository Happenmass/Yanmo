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

final class AudioRecorder {
    private var recorder: AVAudioRecorder?
    private var url: URL?
    var level: Double {
        recorder?.updateMeters()
        return max(0, min(1, pow(10, Double(recorder?.averagePower(forChannel: 0) ?? -80) / 35)))
    }
    func start() async throws {
        let allowed = await AVCaptureDevice.requestAccess(for: .audio)
        guard allowed else { throw EngineError(message: "请在系统设置中允许言墨使用麦克风，或先导入音频体验。") }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yanmo-\(UUID().uuidString).wav")
        let recorder = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false
        ])
        recorder.isMeteringEnabled = true
        guard recorder.record() else { throw EngineError(message: "无法启动麦克风，请检查音频设备。") }
        self.recorder = recorder
        self.url = url
    }
    func finish() -> URL? {
        recorder?.stop()
        recorder = nil
        let result = url
        url = nil
        return result
    }
    func cancel() {
        if let url = finish() { try? FileManager.default.removeItem(at: url) }
    }
}

final class HotKeys {
    var onToggle: (() -> Void)?
    var onCancel: (() -> Void)?
    var isActive: (() -> Bool)?
    private var key: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var fnDown = false
    private var combined = false

    init() {
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, pointer in
            guard let pointer else { return noErr }
            let owner = Unmanaged<HotKeys>.fromOpaque(pointer).takeUnretainedValue()
            owner.onToggle?()
            return noErr
        }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &handler)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), EventHotKeyID(signature: 0x59414E4D, id: 1), GetApplicationEventTarget(), 0, &key)
    }

    @discardableResult
    func enableFn() -> Bool {
        if tap != nil { return true }
        guard AXIsProcessTrusted() else { return false }
        let mask = (CGEventMask(1) << CGEventType.flagsChanged.rawValue) | (CGEventMask(1) << CGEventType.keyDown.rawValue)
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
            guard let pointer else { return Unmanaged.passUnretained(event) }
            let owner = Unmanaged<HotKeys>.fromOpaque(pointer).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap = owner.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            let keycode = event.getIntegerValueField(.keyboardEventKeycode)
            if type == .flagsChanged && keycode == 63 {
                let down = event.flags.contains(.maskSecondaryFn)
                if down {
                    owner.fnDown = true
                    owner.combined = !event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
                } else if owner.fnDown {
                    let toggle = !owner.combined
                    owner.fnDown = false
                    if toggle { owner.onToggle?() }
                }
                return nil
            }
            if owner.fnDown { owner.combined = true }
            if type == .keyDown && keycode == 53 && owner.isActive?() == true {
                owner.onCancel?()
                return nil
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        guard let tap else { return false }
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    deinit {
        if let key { UnregisterEventHotKey(key) }
        if let handler { RemoveEventHandler(handler) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CFMachPortInvalidate(tap) }
    }
}
