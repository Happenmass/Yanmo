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
    public var aliases: [String]? // Optional for compatibility with 0.1 libraries.

    public init(term: String, hint: String = "", aliases: [String] = []) {
        self.term = term.trimmingCharacters(in: .whitespacesAndNewlines)
        self.hint = hint.trimmingCharacters(in: .whitespacesAndNewlines)
        self.aliases = aliases.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && $0 != self.term }
    }
}

public enum HistoryRetention: Int, Codable, CaseIterable {
    case forever = 0, day = 1, week = 7, month = 30, year = 365
    public var label: String {
        switch self { case .forever: return "一直保留"; case .day: return "24 小时"; case .week: return "7 天"; case .month: return "30 天"; case .year: return "1 年" }
    }
    public func includes(_ date: Date, now: Date = Date()) -> Bool {
        self == .forever || date >= now.addingTimeInterval(-Double(rawValue) * 86400)
    }
}

/// Carbon modifier bits are persisted rather than a keyboard-layout-dependent string.
public struct InputShortcut: Codable, Equatable, Identifiable {
    public var id: String { "\(keyCode):\(modifiers)" }
    public var keyCode: UInt32
    public var modifiers: UInt32
    public var keyLabel: String
    public init(keyCode: UInt32, modifiers: UInt32, keyLabel: String) {
        self.keyCode = keyCode; self.modifiers = modifiers; self.keyLabel = keyLabel
    }
    public static let fn = InputShortcut(keyCode: 63, modifiers: 0, keyLabel: "Fn")
    public static let standard = InputShortcut(keyCode: 49, modifiers: 4096 | 2048, keyLabel: "Space")
    public static let defaults = [fn, standard]
    public var isFn: Bool { self == .fn }
    public var label: String {
        (modifiers & 4096 != 0 ? "⌃" : "") + (modifiers & 2048 != 0 ? "⌥" : "") +
        (modifiers & 512 != 0 ? "⇧" : "") + (modifiers & 256 != 0 ? "⌘" : "") + keyLabel
    }
    public var validationError: String? {
        if isFn { return nil }
        if modifiers & (256 | 4096) == 0 { return "请搭配 Control 或 Command，避免影响正常打字。" }
        if [36, 48, 51, 53, 63, 117].contains(keyCode) { return "请选一个字母、数字、空格或功能键。" }
        if modifiers == 256 && [0, 4, 6, 7, 8, 9, 12, 13, 46, 49].contains(keyCode) { return "这是常用系统或编辑快捷键，请换一组组合。" }
        return nil
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

public struct UsageSummary {
    public let characters: Int
    public let audioSeconds: Double
    public let charactersPerMinute: Int
    public let dailyCharacters: [Date: Int]
    public var activeDays: Int { dailyCharacters.count }
    public init(_ manuscripts: [Manuscript], calendar: Calendar = .current) {
        characters = manuscripts.reduce(0) { $0 + $1.text.count }
        let timed = manuscripts.filter { $0.seconds.isFinite && $0.seconds > 0 }
        audioSeconds = timed.reduce(0) { $0 + $1.seconds }
        charactersPerMinute = audioSeconds > 0 ? Int((Double(timed.reduce(0) { $0 + $1.text.count }) * 60 / audioSeconds).rounded()) : 0
        dailyCharacters = manuscripts.reduce(into: [:]) { days, item in
            days[calendar.startOfDay(for: item.date), default: 0] += item.text.count
        }
    }
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
