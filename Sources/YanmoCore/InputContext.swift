import Foundation

/// Nearby user text only. Labels, help text, and placeholder prompts are never
/// alternative sources for a missing field value or cursor position.
public struct InputContext: Equatable {
    public let before: String
    public let after: String
    public static let empty = InputContext(before: "", after: "")

    public static func capture(value: String, selection: NSRange?, placeholder: String?, characterCount: Int? = nil,
                               title: String? = nil, description: String? = nil) -> InputContext {
        guard let selection, characterCount != 0 else { return .empty }
        let padding = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{200B}\u{2060}\u{FEFF}"))
        let normalized = value.trimmingCharacters(in: padding)
        let hint = placeholder?.trimmingCharacters(in: padding) ?? ""
        if !hint.isEmpty {
            // Some web accessibility providers expose a visible placeholder as
            // AXValue. Discard that snapshot, never substrings of real text.
            if normalized == hint { return .empty }
        } else if selection.location == 0, selection.length == 0, !normalized.isEmpty,
                  let title, let description,
                  normalized == title.trimmingCharacters(in: padding),
                  normalized == description.trimmingCharacters(in: padding) {
            // CSS-generated hints can count as AX characters while omitting
            // AXPlaceholderValue. At the untouched caret, a value equal to both
            // accessible labels is ambiguous: omit context, never edit the field.
            return .empty
        }
        let text = value as NSString
        guard selection.location >= 0, selection.length >= 0, selection.location <= text.length,
              selection.length <= text.length - selection.location else { return .empty }
        let location = selection.location
        let end = location + selection.length
        return InputContext(
            before: text.substring(with: NSRange(location: max(0, location - 300), length: min(300, location))),
            after: text.substring(with: NSRange(location: end, length: min(300, text.length - end))))
    }
}
