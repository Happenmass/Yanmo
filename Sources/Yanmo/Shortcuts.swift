import AppKit
import Carbon
import SwiftUI
import YanmoCore

final class HotKeys {
    var onToggle: (() -> Void)?
    var onCancel: (() -> Void)?
    var onCaptureFn: (() -> Void)?
    var isActive: (() -> Bool)?
    var capturing = false { didSet { fnDown = false; combined = false; pressed.removeAll() } }
    private var shortcuts: [InputShortcut] = []
    private var keys: [EventHotKeyRef] = []
    private var pressed = Set<UInt32>()
    private var handler: EventHandlerRef?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var fnDown = false
    private var combined = false

    init() {
        var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)), EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, pointer in
            guard let pointer, let event else { return noErr }
            let owner = Unmanaged<HotKeys>.fromOpaque(pointer).takeUnretainedValue()
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            if GetEventKind(event) == UInt32(kEventHotKeyReleased) { owner.pressed.remove(id.id) }
            else if !owner.capturing && owner.pressed.insert(id.id).inserted { owner.onToggle?() }
            return noErr
        }, types.count, &types, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    /// Registration is transactional: a rejected new combination leaves the old keys active.
    func configure(_ proposed: [InputShortcut]) throws {
        let old = shortcuts
        unregister()
        do { try register(proposed); shortcuts = proposed }
        catch {
            unregister()
            try? register(old)
            throw error
        }
    }

    func suspend() { capturing = true; unregister() }
    func resume() throws {
        capturing = false
        unregister()
        do { try register(shortcuts) }
        catch { unregister(); throw error }
    }

    private func register(_ values: [InputShortcut]) throws {
        for (index, shortcut) in values.enumerated() where !shortcut.isFn {
            var key: EventHotKeyRef?
            let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, EventHotKeyID(signature: 0x59414E4D, id: UInt32(index + 1)), GetApplicationEventTarget(), 0, &key)
            guard status == noErr, let key else { throw EngineError(message: "\(shortcut.label) 无法注册，可能已被其他应用占用。原快捷键已保留。") }
            keys.append(key)
        }
    }
    private func unregister() { keys.forEach { UnregisterEventHotKey($0) }; keys = []; pressed = [] }

    @discardableResult
    func enableFn() -> Bool {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true); return true }
        guard AXIsProcessTrusted() else { return false }
        let mask = (CGEventMask(1) << CGEventType.flagsChanged.rawValue) | (CGEventMask(1) << CGEventType.keyDown.rawValue)
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
            guard let pointer else { return Unmanaged.passUnretained(event) }
            let owner = Unmanaged<HotKeys>.fromOpaque(pointer).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                owner.fnDown = false; owner.pressed.removeAll()
                if let tap = owner.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if type == .flagsChanged && keyCode == 63 && (owner.capturing || owner.shortcuts.contains(.fn)) {
                let down = event.flags.contains(.maskSecondaryFn)
                if down {
                    owner.fnDown = true
                    owner.combined = !event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
                } else if owner.fnDown {
                    let trigger = !owner.combined
                    owner.fnDown = false
                    if trigger {
                        if owner.capturing { owner.onCaptureFn?() } else { owner.onToggle?() }
                    }
                }
                return nil
            }
            if owner.fnDown { owner.combined = true }
            if !owner.capturing && type == .keyDown && keyCode == 53 && owner.isActive?() == true {
                owner.onCancel?(); return nil
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
        unregister()
        if let handler { RemoveEventHandler(handler) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CFMachPortInvalidate(tap) }
    }
}

/// Capture only while the explicit recorder is focused; normal typing remains untouched.
struct ShortcutRecorder: NSViewRepresentable {
    var onCapture: (InputShortcut?) -> Void
    func makeNSView(context: Context) -> RecorderView {
        let view = RecorderView(); view.onCapture = onCapture
        return view
    }
    func updateNSView(_ view: RecorderView, context: Context) { view.onCapture = onCapture }
    final class RecorderView: NSView {
        var onCapture: ((InputShortcut?) -> Void)?
        override var acceptsFirstResponder: Bool { true }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { [weak self] in if let self { self.window?.makeFirstResponder(self) } }
        }
        override func performKeyEquivalent(with event: NSEvent) -> Bool { keyDown(with: event); return true }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 53 { onCapture?(nil); return }
            guard !event.isARepeat else { return }
            var modifiers: UInt32 = 0
            if event.modifierFlags.contains(.command) { modifiers |= UInt32(cmdKey) }
            if event.modifierFlags.contains(.option) { modifiers |= UInt32(optionKey) }
            if event.modifierFlags.contains(.control) { modifiers |= UInt32(controlKey) }
            if event.modifierFlags.contains(.shift) { modifiers |= UInt32(shiftKey) }
            let labels: [UInt16: String] = [49: "Space", 36: "Return", 48: "Tab", 51: "Delete", 123: "←", 124: "→", 125: "↓", 126: "↑", 122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12"]
            let label = labels[event.keyCode] ?? event.charactersIgnoringModifiers?.uppercased() ?? "Key \(event.keyCode)"
            onCapture?(InputShortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers, keyLabel: label))
        }
    }
}
