import Foundation
import YanmoCore

struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}

func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw CheckFailure(description: message) }
}

@main
struct Checks {
    static func main() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = LibraryFile(url: folder.appendingPathComponent("library.json"))
        try require(file.read().manuscripts.isEmpty, "New library must start empty")
        var library = Library()
        library.manuscripts.append(Manuscript(original: "嗯预算不是三百是三千五百元", text: "预算不是三百，是三千五百元。", seconds: 5.6, application: "文本编辑", polished: true))
        library.manuscripts[0].deliveryNote = "未写入：光标位置已改变"
        library.lexicon.append(LexiconEntry(term: "言墨", hint: "产品名"))
        try file.write(library)
        let restored = try file.read()
        try require(restored.manuscripts == library.manuscripts && restored.lexicon == library.lexicon, "Original, edited text, IDs and lexicon must survive persistence")
        let permissions = try FileManager.default.attributesOfItem(atPath: file.url.path)[.posixPermissions] as? Int
        try require(permissions == 0o600, "Library must be private to the user")
        print("PASS: manuscript and lexicon persistence, private permissions")

        try Data("{broken".utf8).write(to: file.url)
        var rejected = false
        do { _ = try file.read() } catch { rejected = true }
        try require(rejected, "Corrupt data must not silently reset the library")
        try require(String(contentsOf: file.url) == "{broken", "Corrupt source must be preserved")
        print("PASS: corrupt library is rejected and preserved")

        try require(ApplicationCategory.detect(bundleID: "com.google.Chrome") == "general", "A browser is not necessarily search")
        try require(ApplicationCategory.detect(bundleID: "com.tencent.xinWeChat") == "messaging", "WeChat categorization")
        try require(ApplicationCategory.detect(bundleID: "com.microsoft.VSCode") == "code_editor", "VS Code categorization")
        print("PASS: application context classification")

        let shortcuts = InputShortcut.defaults + [InputShortcut(keyCode: 2, modifiers: 4096 | 512, keyLabel: "D")]
        let decoded = try JSONDecoder().decode([InputShortcut].self, from: JSONEncoder().encode(shortcuts))
        try require(decoded == shortcuts && decoded[2].label == "⌃⇧D", "Custom shortcuts must survive restart with modifier semantics")
        try require(InputShortcut(keyCode: 12, modifiers: 256, keyLabel: "Q").validationError != nil, "Do not capture Cmd-Q")
        try require(InputShortcut(keyCode: 0, modifiers: 0, keyLabel: "A").validationError != nil, "Do not capture ordinary typing")
        try require(shortcuts[2].validationError == nil && InputShortcut.fn.validationError == nil, "Explicit dictation shortcuts must be allowed")
        print("PASS: shortcut persistence and editing/system-key protection")

        var chord = ModifierChord()
        try require(chord.update(key: 59, down: true) == nil, "Do not trigger before release")
        let leftControl = chord.update(key: 59, down: false)!
        try require(leftControl.modifierKeys == [59] && leftControl.validationError == nil, "Single left Control must record")
        try require(leftControl.id != InputShortcut.modifierOnly([62]).id, "Left and right Control are distinct")
        try require(JSONDecoder().decode(InputShortcut.self, from: JSONEncoder().encode(leftControl)) == leftControl, "Modifier-only shortcuts must persist")
        _ = chord.update(key: 59, down: true); _ = chord.update(key: 56, down: true)
        try require(chord.update(key: 59, down: false) == nil, "Wait until the entire chord is released")
        try require(chord.update(key: 56, down: false)?.modifierKeys == [56, 59], "Control + Shift must record as one chord")
        _ = chord.update(key: 59, down: true); chord.cancel()
        try require(chord.update(key: 59, down: false) == nil, "Control+C or a mouse click must not start recording")
        _ = chord.update(key: 59, down: true); _ = chord.update(key: 62, down: true)
        _ = chord.update(key: 59, down: false)
        try require(chord.update(key: 62, down: false)?.modifierKeys == [59, 62], "Both Controls preserve physical key identity")
        _ = chord.update(key: 59, down: true); _ = chord.update(key: 56, down: true)
        _ = chord.update(key: 56, down: false); _ = chord.update(key: 58, down: true)
        _ = chord.update(key: 58, down: false)
        try require(chord.update(key: 59, down: false) == nil, "Changing a chord mid-release must not trigger")
        print("PASS: modifier-only capture, release, persistence and typing suppression")

        let bindings = InputAction.allCases.flatMap { action in action.defaults.map { ShortcutBinding(action: action, shortcut: $0) } }
        try require(ShortcutBinding.conflict(in: bindings) == nil, "Default action shortcuts must not collide")
        try require(ShortcutBinding.conflict(in: bindings + [ShortcutBinding(action: .selectionTranslation, shortcut: .fn)]) != nil, "Cross-action duplicate must be rejected")
        try require(TranslationLanguage.allCases.count == 4, "First release has exactly four target languages")
        try require(JSONDecoder().decode(TranslationLanguage.self, from: JSONEncoder().encode(TranslationLanguage.german)) == .german, "Target language must survive persistence")
        print("PASS: translation targets and independent shortcut conflict detection")

        let now = Date(timeIntervalSince1970: 1_000_000)
        try require(HistoryRetention.week.includes(now.addingTimeInterval(-6 * 86400), now: now), "Recent history must remain")
        try require(!HistoryRetention.week.includes(now.addingTimeInterval(-8 * 86400), now: now), "Expired history must be pruned")
        let legacy = Data("{\"id\":\"00000000-0000-0000-0000-000000000001\",\"term\":\"言墨\",\"hint\":\"产品\"}".utf8)
        try require(JSONDecoder().decode(LexiconEntry.self, from: legacy).aliases == nil, "Existing 0.1 dictionary entries must remain readable")
        print("PASS: retention boundaries and legacy dictionary migration")
        var timed = Manuscript(original: "测试", text: "测试文本", seconds: 30, application: "言墨", polished: false)
        timed.date = now
        var untimed = timed; untimed.seconds = 0
        let usage = UsageSummary([timed, untimed])
        try require(usage.characters == 8 && usage.audioSeconds == 30 && usage.charactersPerMinute == 8, "Only timed records contribute to speaking speed")
        try require(usage.activeDays == 1 && UsageSummary([]).charactersPerMinute == 0, "Activity groups by day and handles empty history")
        print("PASS: usage totals, speaking speed and active days")
        print("8 core checks passed")
    }
}
