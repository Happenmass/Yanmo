import Foundation

public enum TranslationLanguage: String, Codable, CaseIterable, Identifiable {
    case english = "en", simplifiedChinese = "zh-Hans", japanese = "ja", german = "de"
    public var id: String { rawValue }
    public var label: String {
        switch self { case .english: return "英语"; case .simplifiedChinese: return "简体中文"; case .japanese: return "日语"; case .german: return "德语" }
    }
}

public enum InputAction: String, Codable, CaseIterable, Identifiable {
    case dictation, voiceTranslation, selectionTranslation
    public var id: String { rawValue }
    public var label: String {
        switch self { case .dictation: return "语音输入"; case .voiceTranslation: return "口述翻译"; case .selectionTranslation: return "划词翻译" }
    }
    public var defaults: [InputShortcut] {
        switch self {
        case .dictation: return InputShortcut.defaults
        case .voiceTranslation: return [InputShortcut(keyCode: 17, modifiers: 4096 | 2048, keyLabel: "T")]
        case .selectionTranslation: return [InputShortcut(keyCode: 1, modifiers: 4096 | 2048, keyLabel: "S")]
        }
    }
}

public struct ShortcutBinding {
    public let action: InputAction
    public let shortcut: InputShortcut
    public init(action: InputAction, shortcut: InputShortcut) { self.action = action; self.shortcut = shortcut }
    public static func conflict(in bindings: [ShortcutBinding]) -> String? {
        var owners: [String: InputAction] = [:]
        for binding in bindings {
            if let owner = owners[binding.shortcut.id] { return "\(binding.shortcut.label) 已用于\(owner.label)，请选择不同的快捷键。" }
            owners[binding.shortcut.id] = binding.action
        }
        return nil
    }
}
