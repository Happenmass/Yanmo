import AppKit
import Carbon
import YanmoCore

public final class HotKeys {
    public var onCaptureShortcut: ((InputShortcut?) -> Void)?
    public var onAction: ((InputAction) -> Void)?
    public var onCancel: (() -> Void)?
    public var onCaptureFn: (() -> Void)?
    public var isActive: (() -> Bool)?
    public var capturing = false { didSet { pressed.removeAll(); modifierChord.reset() } }
    private var bindings: [ShortcutBinding] = []
    private var actions: [UInt32: InputAction] = [:]
    private var keys: [EventHotKeyRef] = []
    private var pressed = Set<UInt32>()
    private var suppressedKeys = Set<Int64>()
    private var handler: EventHandlerRef?
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var modifierChord = ModifierChord()

    public init() {
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
    public func configure(_ proposed: [ShortcutBinding]) throws {
        if let conflict = ShortcutBinding.conflict(in: proposed) { throw EngineError(message: conflict) }
        let old = bindings
        modifierChord.reset()
        unregister()
        do { try register(proposed); bindings = proposed }
        catch {
            unregister()
            try? register(old)
            throw error
        }
    }

    public func suspend() { capturing = true; unregister() }
    public func resume() throws {
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
    public func enableFn() -> Bool {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true); return true }
        guard AXIsProcessTrusted() else { return false }
        let mask = [CGEventType.flagsChanged, .keyDown, .keyUp, .leftMouseDown, .rightMouseDown, .otherMouseDown].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
            guard let pointer else { return Unmanaged.passUnretained(event) }
            let owner = Unmanaged<HotKeys>.fromOpaque(pointer).takeUnretainedValue()
            return owner.handleEvent(type, event) ? nil : Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        guard let tap else { return false }
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    // Kept in-process so the actual event-tap routing can be checked without
    // posting synthetic input to the user's desktop or requiring permissions.
    package func handleEvent(_ type: CGEventType, _ event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            pressed.removeAll(); suppressedKeys.removeAll(); modifierChord.reset()
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return false
        }
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if type == .keyUp, suppressedKeys.remove(keyCode) != nil { return true }
        if type == .keyDown, suppressedKeys.contains(keyCode) { return true }
        if type == .flagsChanged, let mask = ModifierChord.masks[UInt16(keyCode)] {
            if let chord = modifierChord.update(key: UInt16(keyCode), down: event.flags.rawValue & mask != 0) {
                if capturing {
                    if chord.isFn, let onCaptureFn { onCaptureFn() } else { onCaptureShortcut?(chord) }
                } else if let binding = bindings.first(where: { $0.shortcut.id == chord.id }) { onAction?(binding.action) }
            }
        } else { modifierChord.cancel() }
        if type == .flagsChanged && keyCode == 63 && (capturing || bindings.contains(where: { $0.shortcut.usesFn })) { return true }
        if type == .keyDown, let keyEvent = NSEvent(cgEvent: event) {
            // Function flags are also set on arrows/F-keys by macOS. Only the
            // physical FN flagsChanged event establishes that FN is held.
            let shortcut = HotKeys.shortcut(for: keyEvent, functionPressed: modifierChord.pressed.contains(63))
            if capturing, let capture = onCaptureShortcut {
                suppressedKeys.insert(keyCode)
                if !keyEvent.isARepeat { capture(keyCode == 53 ? nil : shortcut) }
                return true
            }
            if !capturing, let binding = bindings.first(where: {
                $0.shortcut.needsEventTap && $0.shortcut.modifierKeys == nil && !$0.shortcut.isFn && $0.shortcut.id == shortcut.id
            }) {
                suppressedKeys.insert(keyCode)
                onAction?(binding.action)
                return true
            }
        }
        if !capturing && type == .keyDown && keyCode == 53 && isActive?() == true { onCancel?(); return true }
        return false
    }

    public static func shortcut(for event: NSEvent, functionPressed: Bool = false) -> InputShortcut {
        var modifiers: UInt32 = functionPressed ? InputShortcut.functionModifier : 0
        if event.modifierFlags.contains(.command) { modifiers |= UInt32(cmdKey) }
        if event.modifierFlags.contains(.option) { modifiers |= UInt32(optionKey) }
        if event.modifierFlags.contains(.control) { modifiers |= UInt32(controlKey) }
        if event.modifierFlags.contains(.shift) { modifiers |= UInt32(shiftKey) }
        let labels: [UInt16: String] = [49: "Space", 36: "Return", 48: "Tab", 51: "Delete", 123: "←", 124: "→", 125: "↓", 126: "↑", 122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12"]
        let label = labels[event.keyCode] ?? event.charactersIgnoringModifiers?.uppercased() ?? "Key \(event.keyCode)"
        return InputShortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers, keyLabel: label)
    }

    deinit {
        unregister()
        if let handler { RemoveEventHandler(handler) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CFMachPortInvalidate(tap) }
    }
}

