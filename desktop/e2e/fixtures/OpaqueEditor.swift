// Synthetic keyboard editor deliberately exposing no AX text interface.
// It never sends text anywhere; test output is limited to its temporary folder.
import AppKit

final class OpaqueEditor: NSView {
    let output: URL
    private var text = ""
    init(output: URL) { self.output = output; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override var acceptsFirstResponder: Bool { true }
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "v" {
            text += NSPasteboard.general.string(forType: .string) ?? ""
            try? text.write(to: output, atomically: true, encoding: .utf8)
            needsDisplay = true
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
    override func keyDown(with event: NSEvent) { /* Consume synthetic interaction probes. */ }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.textBackgroundColor.setFill(); bounds.fill()
        (text.isEmpty ? "Synthetic editor · no AX text field" : text).draw(
            at: NSPoint(x: 18, y: 40), withAttributes: [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.textColor])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let view = OpaqueEditor(output: output)
let window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 520, height: 120),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "言墨 · 隔离输入测试"
window.contentView = view
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(view)
app.activate(ignoringOtherApps: true)
var alternate: NSWindow?
let switchFile = output.deletingLastPathComponent().appendingPathComponent("switch-window")
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    if app.isActive && window.isKeyWindow {
        try? "ready".write(to: output.deletingLastPathComponent().appendingPathComponent("fixture-ready"), atomically: true, encoding: .utf8)
    }
    guard FileManager.default.fileExists(atPath: switchFile.path) else { return }
    try? FileManager.default.removeItem(at: switchFile)
    let next = NSWindow(contentRect: NSRect(x: 180, y: 340, width: 520, height: 120),
                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
    next.title = "言墨 · 另一个隔离窗口"
    next.contentView = OpaqueEditor(output: output.deletingLastPathComponent().appendingPathComponent("other-output.txt"))
    next.makeKeyAndOrderFront(nil)
    next.makeFirstResponder(next.contentView)
    alternate = next
    try? "ready".write(to: switchFile.appendingPathExtension("ready"), atomically: true, encoding: .utf8)
}
Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { _ in app.terminate(nil) }
app.run()
