import AppKit
import Carbon
import SwiftUI
import YanmoCore
import YanmoNative

/// Capture only while the explicit recorder is focused; normal typing remains untouched.
struct ShortcutRecorder: NSViewRepresentable {
    var onCapture: (InputShortcut?) -> Void
    var onPreview: (String) -> Void
    func makeNSView(context: Context) -> RecorderView {
        let view = RecorderView(); view.onCapture = onCapture; view.onPreview = onPreview
        return view
    }
    func updateNSView(_ view: RecorderView, context: Context) { view.onCapture = onCapture; view.onPreview = onPreview }
    static func shortcut(for event: NSEvent) -> InputShortcut { HotKeys.shortcut(for: event) }
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
            onCapture?(HotKeys.shortcut(for: event, functionPressed: modifiers.pressed.contains(63)))
        }
    }
}
