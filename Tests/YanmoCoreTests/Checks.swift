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

        let controlSpace = InputShortcut(keyCode: 49, modifiers: 4096, keyLabel: "Space")
        try require(controlSpace.validationError == nil && controlSpace.needsEventTap, "Control+Space must bypass Carbon/system hotkey interception through the event tap")
        try require(ShortcutBinding.conflict(in: [
            ShortcutBinding(action: .dictation, shortcut: .modifierOnly([59])),
            ShortcutBinding(action: .voiceTranslation, shortcut: .modifierOnly([56, 59])),
            ShortcutBinding(action: .selectionTranslation, shortcut: controlSpace)
        ]) == nil, "Control+Space must coexist with bare Control and Control+Shift")
        try require(!InputShortcut.standard.needsEventTap, "Unrelated Control+Option+Space must retain Carbon registration")
        print("PASS: Control+Space routing and modifier-only coexistence")

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
        let markdown = MarkdownDocument("""
        # Title **bold**

        - First `value`
          - Nested

        > A quote

        ```python
        print("hello")
        ```

        | Key | Value |
        | --- | ---: |
        | timeout | 30 |

        ---
        """)
        try require(markdown.blocks.count == 7, "Markdown blocks must preserve headings, nesting, quotes, code, tables and rule")
        if case .heading(1) = markdown.blocks[0].kind {} else { throw CheckFailure(description: "Heading level lost") }
        try require(markdown.blocks[0].text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }, "Bold span must survive parsing")
        try require(markdown.blocks[1].marker == "•" && markdown.blocks[2].depth == 2 && markdown.blocks[3].quoted, "Nested list and quote structure must survive")
        if case .code("python") = markdown.blocks[4].kind {} else { throw CheckFailure(description: "Code fence language lost") }
        try require(String(markdown.blocks[4].text.characters) == "print(\"hello\")\n", "Code content must remain literal")
        if case .table(let rows, let columns) = markdown.blocks[5].kind {
            try require(rows.count == 2 && rows[0].header && rows[1].cells.count == 2 && columns[1].alignment == .right, "Table cells and alignment must survive")
        } else { throw CheckFailure(description: "GFM table lost") }
        let plain = MarkdownDocument("普通文本 & <script>alert(1)</script>")
        try require(!plain.blocks.isEmpty, "Untrusted text must render locally as content")
        print("PASS: structured Markdown parsing and literal code preservation")
        let copiedHTML = """
        <meta charset="utf-8"><h2>Setup &amp; usage</h2><p>Use <strong>local mode</strong> and <em>check</em> <code>retry_count</code>.</p>
        <ol start="3"><li>Install<ul><li>Keep data local</li></ul></li><li>Run</li></ol>
        <blockquote><p>Remember the configuration.</p></blockquote>
        <pre><code class="language-python"><span>def</span> greet():
            return &quot;Hello&quot;

        # keep blank line
        </code></pre>
        <table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>Retries</td><td>3</td></tr></tbody></table>
        <p><a href="https://example.com/docs">Docs</a></p>
        """
        let converted = SelectionMarkdown.fromHTML(copiedHTML) ?? ""
        try require(converted.contains("## Setup & usage") && converted.contains("**local mode**") && converted.contains("*check*") && converted.contains("`retry_count`"), "Copied HTML must retain heading, emphasis and inline code")
        let richDocument = MarkdownDocument(converted)
        try require(richDocument.blocks.contains { $0.depth == 2 } && richDocument.blocks.contains { $0.marker == "3." } && richDocument.blocks.contains { $0.quoted }, "Copied nested lists, numbering and quotes must render structurally")
        try require(richDocument.blocks.contains { if case .table = $0.kind { return true }; return false }, "Copied HTML table must become a Markdown table")
        try require(converted.contains("[Docs](https://example.com/docs)"), "Link labels and addresses retained")
        try require(converted.contains("    return \"Hello\"\n\n# keep blank line"), "Highlighted code must preserve exact whitespace and decoded entities")
        print("PASS: copied rich HTML becomes structured Markdown with literal code")
        let fragment = SelectionMarkdown.fromHTML("<div>outside<!--StartFragment--><h3>Selected</h3><p><b>Only this</b></p><!--EndFragment-->outside</div>") ?? ""
        try require(fragment.contains("### Selected") && !fragment.contains("outside"), "Copy context outside selection must be excluded")
        try require(SelectionMarkdown.fromHTML("<p>Literal *star* _name_ [label]</p>")?.contains("\\*star\\*") == true, "Literal punctuation must not create new Markdown formatting")
        print("PASS: selection fragment boundary and literal text escaping")
        try require(SelectionMarkdown.fromCopiedText("# Title **bold**", html: "<p># Title **bold**</p>") == "# Title **bold**", "Plain HTML wrappers must not escape existing Markdown source")
        try require(SelectionMarkdown.fromCopiedText("Plain fallback", html: nil) == "Plain fallback", "Applications without HTML must retain the plain-text path")
        try require(SelectionMarkdown.fromHTML("<!DOCTYPE html [<!ENTITY file SYSTEM 'file:///etc/passwd'>]><p>&file;</p>") == nil, "External entity declarations must not be read")
        let inert = SelectionMarkdown.fromHTML("<h1>Safe</h1><script>secret()</script><img src='https://example.com/pixel'><button>Copy</button><a href='javascript:alert(1)'>Label</a>") ?? ""
        try require(inert == "# Safe\n\nLabel", "Scripts, controls, remote resources and unsafe link targets must be dropped")
        print("PASS: inert HTML conversion and entity/resource exclusion")
        print("13 core checks passed")
    }
}
