// Isolated AX-readable editor for correction-learning checks; synthetic data only.
import AppKit
import ApplicationServices
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let menu = NSMenu()
let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
let edit = NSMenu(title: "Edit")
edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editItem.submenu = edit; menu.addItem(editItem); app.mainMenu = menu
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 600, height: 250), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "言墨 · 纠词隔离测试"
final class SendEditor: NSTextView {
    override func insertNewline(_ sender: Any?) {
        save("sent.txt", string)
        string = ""
    }
}
let editor = SendEditor(frame: NSRect(x: 0, y: 0, width: 600, height: 170))
editor.font = .systemFont(ofSize: 20)
let other = SendEditor(frame: NSRect(x: 10, y: 180, width: 500, height: 30))
let container = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 250))
container.addSubview(editor); container.addSubview(other); window.contentView = container
window.makeKeyAndOrderFront(nil); window.makeFirstResponder(editor); app.activate(ignoringOtherApps: true)
func save(_ name: String, _ text: String) { try? text.write(to: folder.appendingPathComponent(name), atomically: true, encoding: .utf8) }
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    save("value.txt", editor.string)
    let command = folder.appendingPathComponent("command.json")
    guard let data = try? Data(contentsOf: command), let value = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return }
    try? FileManager.default.removeItem(at: command)
    if value["action"] == "quit" { app.terminate(nil) }
    if value["action"] == "focusOther" {
        other.string = value["text"] ?? ""
        window.makeFirstResponder(other)
    }
    if value["action"] == "reset" {
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("sent.txt"))
        editor.string = value["text"] ?? ""; window.makeFirstResponder(editor)
        other.string = ""
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        app.activate(ignoringOtherApps: true)
    }
    if value["action"] == "type" {
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(editor); app.activate(ignoringOtherApps: true)
        let chars = Array((value["text"] ?? "").utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
        down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            editor.setSelectedRange(NSRange(location: 0, length: editor.string.utf16.count))
            down.post(tap: .cghidEventTap)
            CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)!.post(tap: .cghidEventTap)
        }
    }
    if value["action"] == "enter" {
        CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false)?.post(tap: .cghidEventTap)
    }
    save("ack", value["id"] ?? "")
}
save("ready", "ready")
Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { _ in app.terminate(nil) }
app.run()
