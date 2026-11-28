import Foundation

/// Compares dictation text against the editor draft after stripping invisible AX artifacts.
public enum CorrectionDiff {
    private static let invisibleScalars: Set<UInt32> = [
        0x200B, // ZERO WIDTH SPACE
        0x200C, // ZERO WIDTH NON-JOINER
        0x200D, // ZERO WIDTH JOINER
        0x2060, // WORD JOINER
        0xFEFF, // ZERO WIDTH NO-BREAK SPACE / BOM
        0xFFFC, // OBJECT REPLACEMENT CHARACTER
    ]
    private static let trailingSentencePunctuation = Set("。！？.!?")

    public static func normalize(_ text: String) -> String {
        var stripped = String.UnicodeScalarView()
        stripped.reserveCapacity(text.unicodeScalars.count)
        for scalar in text.unicodeScalars where !invisibleScalars.contains(scalar.value) {
            stripped.append(scalar)
        }
        return String(stripped)
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .precomposedStringWithCanonicalMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func hasSubstantiveChange(original: String, draft: String) -> Bool {
        let normOriginal = normalize(original)
        let normDraft = normalize(draft)
        guard !normOriginal.isEmpty, !normDraft.isEmpty else { return false }
        if normDraft == normOriginal { return false }
        if stripTrailingSentencePunctuation(normDraft) == stripTrailingSentencePunctuation(normOriginal) {
            return false
        }
        if containsAtSafeBoundary(draft: normDraft, original: normOriginal) {
            return false
        }
        return true
    }

    private static func stripTrailingSentencePunctuation(_ text: String) -> String {
        var end = text.endIndex
        while end > text.startIndex {
            let prev = text.index(before: end)
            if trailingSentencePunctuation.contains(text[prev]) {
                end = prev
            } else {
                break
            }
        }
        return end > text.startIndex ? String(text[..<end]) : text
    }

    private static func isLatinWordScalar(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        if v == 0x5F /* _ */ || (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A) {
            return true
        }
        guard v < 0x0250 else { return false }
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .decimalNumber:
            return true
        default:
            return false
        }
    }

    private static func isCJKOrKanaOrHangul(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF, 0x20000...0x2EBEF,
             0x3040...0x30FF, 0x31F0...0x31FF,
             0xAC00...0xD7AF, 0x1100...0x11FF:
            return true
        default:
            return false
        }
    }

    private static func isShortPlainPhrase(_ text: String) -> Bool {
        guard text.count <= 4 else { return false }
        for scalar in text.unicodeScalars {
            if CharacterSet.whitespacesAndNewlines.contains(scalar) || CharacterSet.punctuationCharacters.contains(scalar) {
                return false
            }
        }
        return true
    }

    private static func containsAtSafeBoundary(draft: String, original: String) -> Bool {
        guard let firstOrig = original.unicodeScalars.first,
              let lastOrig = original.unicodeScalars.last else { return false }
        let shortPlain = isShortPlainPhrase(original)
        var searchStart = draft.startIndex
        while searchStart < draft.endIndex,
              let match = draft.range(of: original, options: .literal, range: searchStart..<draft.endIndex) {
            var leftJoined = false
            if match.lowerBound > draft.startIndex,
               let before = draft[..<match.lowerBound].unicodeScalars.last {
                leftJoined = (isLatinWordScalar(before) && isLatinWordScalar(firstOrig))
                    || (shortPlain && isCJKOrKanaOrHangul(before) && isCJKOrKanaOrHangul(firstOrig))
            }
            var rightJoined = false
            if match.upperBound < draft.endIndex,
               let after = draft[match.upperBound...].unicodeScalars.first {
                let dottedToken = lastOrig.value == 0x2E /* . */
                    && original.unicodeScalars.dropLast().last.map(isLatinWordScalar) == true
                    && isLatinWordScalar(after)
                rightJoined = dottedToken
                    || (isLatinWordScalar(lastOrig) && isLatinWordScalar(after))
                    || (shortPlain && isCJKOrKanaOrHangul(lastOrig) && isCJKOrKanaOrHangul(after))
            }
            if !leftJoined && !rightJoined {
                return true
            }
            searchStart = draft.index(after: match.lowerBound)
        }
        return false
    }
}
