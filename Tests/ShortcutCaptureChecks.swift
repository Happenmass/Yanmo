import AppKit
import YanmoCore
import YanmoNative

/// Exercise the real event-tap handler in process. Nothing is posted to macOS.
@main
struct ShortcutCaptureChecks {
    static func main() throws {
        let keys = HotKeys()
        var actions: [InputAction] = []
        var captured: [InputShortcut] = []
        keys.onAction = { actions.append($0) }
        keys.onCaptureShortcut = { if let shortcut = $0 { captured.append(shortcut) } }
        func send(_ type: CGEventType, _ code: UInt16, _ flags: UInt64 = 0, repeatKey: Bool = false) -> Bool {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: type != .keyUp)!
            event.type = type; event.flags = CGEventFlags(rawValue: flags)
            event.setIntegerValueField(.keyboardEventAutorepeat, value: repeatKey ? 1 : 0)
            return keys.handleEvent(type, event)
        }
        let fn: UInt64 = 1 << 23, shift: UInt64 = 1 << 17
        let control: UInt64 = (1 << 18) | 0x1
        try keys.configure(InputAction.allCases.flatMap { action in action.defaults.map { ShortcutBinding(action: action, shortcut: $0) } })

        precondition(send(.flagsChanged, 63, fn))
        precondition(actions.isEmpty)
        precondition(send(.flagsChanged, 63))
        precondition(actions == [.dictation])
        print("PASS: FN triggers once on release and is suppressed from the system")

        // Either Shift key and either press/release order must produce exactly
        // one translation, with no extra bare FN when the last key is released.
        for (shiftCode, side): (UInt16, UInt64) in [(56, 0x2), (60, 0x4)] {
            for fnFirst in [true, false] {
                for fnReleasedFirst in [true, false] {
                    actions.removeAll()
                    _ = send(.flagsChanged, fnFirst ? 63 : shiftCode, fnFirst ? fn : shift | side)
                    _ = send(.flagsChanged, fnFirst ? shiftCode : 63, fn | shift | side)
                    precondition(actions.isEmpty)
                    _ = send(.flagsChanged, fnReleasedFirst ? 63 : shiftCode, fnReleasedFirst ? shift | side : fn)
                    precondition(actions.isEmpty)
                    _ = send(.flagsChanged, fnReleasedFirst ? shiftCode : 63)
                    precondition(actions == [.voiceTranslation])
                }
            }
        }
        print("PASS: FN + Shift routes once for both sides and all eight key orders")

        for fnReleasedFirst in [true, false] {
            actions.removeAll()
            _ = send(.flagsChanged, 63, fn)
            precondition(send(.keyDown, 49, fn))
            precondition(send(.keyDown, 49, fn, repeatKey: true))
            precondition(actions == [.selectionTranslation])
            if fnReleasedFirst { _ = send(.flagsChanged, 63) }
            precondition(send(.keyUp, 49, fnReleasedFirst ? 0 : fn))
            if !fnReleasedFirst { _ = send(.flagsChanged, 63) }
            precondition(actions == [.selectionTranslation])
        }
        actions.removeAll()
        precondition(!send(.keyDown, 49))
        _ = send(.keyUp, 49)
        _ = send(.flagsChanged, 63, fn); _ = send(.keyDown, 0, fn)
        _ = send(.keyUp, 0, fn); _ = send(.flagsChanged, 63)
        _ = send(.flagsChanged, 63, fn); _ = send(.leftMouseDown, 0); _ = send(.flagsChanged, 63)
        precondition(actions.isEmpty)
        print("PASS: FN + 空格 consumes repeats/key-up, ordinary typing/clicks do not trigger FN")

        keys.suspend()
        _ = send(.flagsChanged, 63, fn); _ = send(.flagsChanged, 56, fn | shift | 0x2)
        _ = send(.flagsChanged, 56, fn); _ = send(.flagsChanged, 63)
        _ = send(.flagsChanged, 63, fn); _ = send(.keyDown, 49, fn)
        _ = send(.keyUp, 49, fn); _ = send(.flagsChanged, 63)
        _ = send(.flagsChanged, 59, control); _ = send(.keyDown, 49, control)
        _ = send(.keyUp, 49, control); _ = send(.flagsChanged, 59)
        precondition(captured.map(\.id) == ["63:512", "49:\(InputShortcut.functionModifier)", "49:4096"])
        try keys.resume()
        print("PASS: recording FN combinations and Control + 空格 emits one complete shortcut")

        try keys.configure([
            ShortcutBinding(action: .dictation, shortcut: .modifierOnly([59])),
            ShortcutBinding(action: .voiceTranslation, shortcut: .modifierOnly([56, 59])),
            ShortcutBinding(action: .selectionTranslation, shortcut: InputShortcut(keyCode: 49, modifiers: 4096, keyLabel: "Space"))
        ])
        _ = send(.flagsChanged, 59, control); _ = send(.flagsChanged, 59)
        _ = send(.flagsChanged, 59, control); _ = send(.flagsChanged, 56, control | shift | 0x2)
        _ = send(.flagsChanged, 56, control); _ = send(.flagsChanged, 59)
        precondition(send(.keyDown, 49, control)); _ = send(.keyUp, 49, control)
        precondition(actions == [.dictation, .voiceTranslation, .selectionTranslation])
        let functionKey = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.control, .function], timestamp: 0, windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 122)!
        precondition(HotKeys.shortcut(for: functionKey).modifiers == 4096)
        print("PASS: original custom shortcuts coexist; F-keys are not mistaken for physical FN")
    }
}
