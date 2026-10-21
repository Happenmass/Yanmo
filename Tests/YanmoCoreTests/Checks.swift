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
        print("3 core checks passed")
    }
}
