import Foundation

public struct Manuscript: Codable, Identifiable, Equatable {
    public var id = UUID()
    public var date = Date()
    public var original: String
    public var text: String
    public var seconds: Double
    public var application: String
    public var polished: Bool
    public var deliveryNote: String?

    public init(original: String, text: String, seconds: Double, application: String, polished: Bool) {
        self.original = original
        self.text = text
        self.seconds = seconds
        self.application = application
        self.polished = polished
        self.deliveryNote = nil
    }
}

public struct LexiconEntry: Codable, Identifiable, Equatable {
    public var id = UUID()
    public var term: String
    public var hint: String

    public init(term: String, hint: String = "") {
        self.term = term.trimmingCharacters(in: .whitespacesAndNewlines)
        self.hint = hint.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public enum WritingStyle: String, CaseIterable, Codable {
    case natural = "自然整理"
    case verbatim = "保留原话"
    case message = "即时消息"
    case document = "文档段落"
}

public enum ApplicationCategory {
    public static func detect(bundleID: String) -> String {
        let id = bundleID.lowercased()
        if ["mail", "outlook"].contains(where: id.contains) { return "email" }
        if ["wechat", "xinwechat", "dingtalk", "slack", "lark", "feishu", "telegram"].contains(where: id.contains) { return "messaging" }
        if ["xcode", "vscode", "vs.code", "cursor", "zed", "jetbrains"].contains(where: id.contains) { return "code_editor" }
        if ["word", "notion", "obsidian", "pages", "textedit"].contains(where: id.contains) { return "document" }
        // A browser can contain a document, email or chat. Do not assume search.
        return "general"
    }
}

public struct Library: Codable {
    public var manuscripts: [Manuscript] = []
    public var lexicon: [LexiconEntry] = []
    public init() {}
}

public struct LibraryFile {
    public let url: URL
    public init(url: URL) { self.url = url }

    public func read() throws -> Library {
        guard FileManager.default.fileExists(atPath: url.path) else { return Library() }
        return try JSONDecoder().decode(Library.self, from: Data(contentsOf: url))
    }

    public func write(_ library: Library) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(library).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
