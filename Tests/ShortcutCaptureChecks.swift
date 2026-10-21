import AppKit
import YanmoCore

/// In-process events only: does not post keyboard input to macOS or other apps.
@main
struct ShortcutCaptureChecks {
    static func event(_ type: NSEvent.EventType, key: UInt16, flags: NSEvent.ModifierFlags = [], text: String = "") -> NSEvent {
        NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: 0,
                        windowNumber: 0, context: nil, characters: text,
                        charactersIgnoringModifiers: text, isARepeat: false, keyCode: key)!
    }
    static func main() {
        let recorder = ShortcutRecorder.RecorderView()
        var captured: [InputShortcut] = []
        recorder.onCapture = { if let shortcut = $0 { captured.append(shortcut) } }
        let leftControl = NSEvent.ModifierFlags(rawValue: NSEvent.ModifierFlags.control.rawValue | 0x1)
        recorder.flagsChanged(with: event(.flagsChanged, key: 59, flags: leftControl))
        recorder.keyDown(with: event(.keyDown, key: 49, flags: leftControl, text: " "))
        recorder.flagsChanged(with: event(.flagsChanged, key: 59))
        precondition(captured == [InputShortcut(keyCode: 49, modifiers: 4096, keyLabel: "Space")],
                     "Control release after Space must not record a duplicate bare Control")
        print("PASS: Control+Space capture emits exactly one full combination")

        captured.removeAll()
        recorder.flagsChanged(with: event(.flagsChanged, key: 59, flags: leftControl))
        recorder.flagsChanged(with: event(.flagsChanged, key: 59))
        precondition(captured == [.modifierOnly([59])], "Bare left Control capture must still work")
        print("PASS: bare modifier capture remains available")
    }
}
