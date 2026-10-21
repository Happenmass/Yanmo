import AppKit
import Carbon
import SwiftUI
import YanmoCore

final class HotKeys {
    var onAction: ((InputAction) -> Void)?
    var onCancel: (() -> Void)?
    var onCaptureFn: (() -> Void)?
    var isActive: (() -> Bool)?
    var capturing = false { didSet { fnDown = false; combined = false; pressed.removeAll(); modifierChord.reset() } }
    private var bindings: [ShortcutBinding] = []
    private var actions: [UInt32: InputAction] = [:]
    private var keys: [EventHotKeyRef] = []
    private var pressed = Set<UInt32>()
    private var suppressedKeys = Set<Int64>()
    private var handler: EventHandlerRef?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var modifierChord = ModifierChord()
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
            else if !owner.capturing && owner.pressed.insert(id.id).inserted { if let action = owner.actions[id.id] { owner.onAction?(action) } }
            return noErr
        }, types.count, &types, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    /// Registration is transactional: a rejected new combination leaves the old keys active.
    func configure(_ proposed: [ShortcutBinding]) throws {
        if let conflict = ShortcutBinding.conflict(in: proposed) { throw EngineError(message: conflict) }
        let old = bindings
        unregister()
        do { try register(proposed); bindings = proposed }
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
        do { try register(bindings) }
        catch { unregister(); throw error }
    }

    private func register(_ values: [ShortcutBinding]) throws {
        for (index, binding) in values.enumerated() where !binding.shortcut.needsEventTap {
            let shortcut = binding.shortcut
            var key: EventHotKeyRef?
            let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, EventHotKeyID(signature: 0x59414E4D, id: UInt32(index + 1)), GetApplicationEventTarget(), 0, &key)
            guard status == noErr, let key else { throw EngineError(message: "\(shortcut.label) 无法注册，可能已被其他应用占用。原快捷键已保留。") }
            keys.append(key)
            actions[UInt32(index + 1)] = binding.action
        }
    }
    private func unregister() { keys.forEach { UnregisterEventHotKey($0) }; keys = []; pressed = []; actions = [:] }

    @discardableResult
    func enableFn() -> Bool {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true); return true }
        guard AXIsProcessTrusted() else { return false }
        let mask = [CGEventType.flagsChanged, .keyDown, .keyUp, .leftMouseDown, .rightMouseDown, .otherMouseDown].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
            guard let pointer else { return Unmanaged.passUnretained(event) }
            let owner = Unmanaged<HotKeys>.fromOpaque(pointer).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                owner.fnDown = false; owner.pressed.removeAll(); owner.suppressedKeys.removeAll(); owner.modifierChord.reset()
                if let tap = owner.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if type == .keyUp, owner.suppressedKeys.remove(keyCode) != nil { return nil }
            if type == .keyDown, owner.suppressedKeys.contains(keyCode) { return nil }
            if type == .flagsChanged, let mask = ModifierChord.masks[UInt16(keyCode)] {
                let chord = owner.modifierChord.update(key: UInt16(keyCode), down: event.flags.rawValue & mask != 0)
                if !owner.capturing, let chord, let binding = owner.bindings.first(where: { $0.shortcut.id == chord.id }) { owner.onAction?(binding.action) }
            } else { owner.modifierChord.cancel() }
            if type == .flagsChanged && keyCode == 63 && (owner.capturing || owner.bindings.contains(where: { $0.shortcut.isFn })) {
                let down = event.flags.contains(.maskSecondaryFn)
                if down {
                    owner.fnDown = true
                    owner.combined = !event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
                } else if owner.fnDown {
                    let trigger = !owner.combined
                    owner.fnDown = false
                    if trigger {
                        if owner.capturing { owner.onCaptureFn?() } else if let binding = owner.bindings.first(where: { $0.shortcut.isFn }) { owner.onAction?(binding.action) }
                    }
                }
                return nil
            }
            if owner.fnDown { owner.combined = true }
            if type == .keyDown, let keyEvent = NSEvent(cgEvent: event) {
                // Record before macOS handles reserved combinations. Use the same
                // view path as ordinary keys, including invalidating bare Control.
                if owner.capturing, NSApp.isActive,
                   let recorder = NSApp.keyWindow?.firstResponder as? ShortcutRecorder.RecorderView {
                    owner.suppressedKeys.insert(keyCode)
                    recorder.keyDown(with: keyEvent)
                    return nil
                }
                let shortcut = ShortcutRecorder.shortcut(for: keyEvent)
                if !owner.capturing, let binding = owner.bindings.first(where: {
                    $0.shortcut.needsEventTap && $0.shortcut.modifierKeys == nil && !$0.shortcut.isFn && $0.shortcut.id == shortcut.id
                }) {
                    owner.suppressedKeys.insert(keyCode)
                    owner.onAction?(binding.action)
                    return nil
                }
            }
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
    var onPreview: (String) -> Void
    func makeNSView(context: Context) -> RecorderView {
        let view = RecorderView(); view.onCapture = onCapture; view.onPreview = onPreview
        return view
    }
    func updateNSView(_ view: RecorderView, context: Context) { view.onCapture = onCapture; view.onPreview = onPreview }
    static func shortcut(for event: NSEvent) -> InputShortcut {
        var modifiers: UInt32 = 0
        if event.modifierFlags.contains(.command) { modifiers |= UInt32(cmdKey) }
        if event.modifierFlags.contains(.option) { modifiers |= UInt32(optionKey) }
        if event.modifierFlags.contains(.control) { modifiers |= UInt32(controlKey) }
        if event.modifierFlags.contains(.shift) { modifiers |= UInt32(shiftKey) }
        let labels: [UInt16: String] = [49: "Space", 36: "Return", 48: "Tab", 51: "Delete", 123: "←", 124: "→", 125: "↓", 126: "↑", 122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12"]
        let label = labels[event.keyCode] ?? event.charactersIgnoringModifiers?.uppercased() ?? "Key \(event.keyCode)"
        return InputShortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers, keyLabel: label)
    }
    final class RecorderView: NSView {
        var onCapture: ((InputShortcut?) -> Void)?
        var onPreview: ((String) -> Void)?
        private var modifiers = ModifierChord()
        override func flagsChanged(with event: NSEvent) {
            guard let mask = ModifierChord.masks[event.keyCode] else { modifiers.cancel(); return }
            if let shortcut = modifiers.update(key: event.keyCode, down: event.modifierFlags.rawValue & UInt(mask) != 0) {
                onCapture?(shortcut)
            } else if !modifiers.pressed.isEmpty {
                onPreview?(InputShortcut.modifierOnly(modifiers.pressed).label + "，松开保存，或继续按其他键")
            }
        }
        override func resignFirstResponder() -> Bool { modifiers.reset(); return super.resignFirstResponder() }
        override var acceptsFirstResponder: Bool { true }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { [weak self] in if let self { self.window?.makeFirstResponder(self) } }
        }
        override func performKeyEquivalent(with event: NSEvent) -> Bool { keyDown(with: event); return true }
        override func keyDown(with event: NSEvent) {
            modifiers.cancel()
            if event.keyCode == 53 { onCapture?(nil); return }
            guard !event.isARepeat else { return }
            onCapture?(ShortcutRecorder.shortcut(for: event))
        }
    }
}
