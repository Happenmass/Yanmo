import Foundation
import YanmoCore

var failures = 0
func check(_ value: @autoclosure () -> Bool, _ name: String) {
    if value() { print("PASS: \(name)") }
    else { print("FAIL: \(name)"); failures += 1 }
}

var prepared = 0
var appReads = 0
let recovered: Int? = InputFocus.resolve(system: { nil }, application: { appReads += 1; return 42 },
    prepareApplication: { prepared += 1 }, belongsToApplication: { $0 == 42 })
check(recovered == 42, "missing system focus recovers the original application's focused field")
check(prepared == 1 && appReads == 1, "a cold web accessibility tree is prepared before the application lookup")

let direct = InputFocus.resolve(system: { 42 }, application: { appReads += 1; return 42 },
    prepareApplication: { prepared += 1 }, belongsToApplication: { $0 == 42 })
check(direct == 42 && prepared == 1 && appReads == 1, "available focus avoids touching the application accessibility tree")

let foreign = InputFocus.resolve(system: { 7 }, application: { 8 },
    prepareApplication: {}, belongsToApplication: { $0 == 42 })
check(foreign == nil, "a field belonging to another application is never substituted")

let stale = InputFocus.resolve(system: { 7 }, application: { 42 },
    prepareApplication: {}, belongsToApplication: { $0 == 42 })
check(stale == 42, "stale system-wide focus can recover only the pinned application's field")

let unavailable: Int? = InputFocus.resolve(system: { nil }, application: { nil },
    prepareApplication: {}, belongsToApplication: { _ in true })
check(unavailable == nil, "no accessibility field remains unavailable; no arbitrary editor fallback")

let placeholder = "和Codex一起工作"
for position in [0, (placeholder as NSString).length] {
    check(InputContext.capture(value: placeholder, selection: NSRange(location: position, length: 0), placeholder: placeholder) == .empty,
          "a placeholder returned as AXValue is excluded at cursor \(position)")
}
check(InputContext.capture(value: "\n\u{200B}" + placeholder + "\n", selection: NSRange(location: 0, length: 0), placeholder: placeholder) == .empty,
      "placeholder-only values with editor whitespace are excluded")
let realText = "问题：和Codex一起工作，今天预算100元。"
check(InputContext.capture(value: realText, selection: NSRange(location: (realText as NSString).length, length: 0), placeholder: placeholder).before == realText,
      "real text containing the placeholder phrase remains intact")
check(InputContext.capture(value: "实际正文", selection: NSRange(location: 4, length: 0), placeholder: nil).before == "实际正文",
      "a field without placeholder metadata keeps its actual value")
check(InputContext.capture(value: "", selection: NSRange(location: 0, length: 0), placeholder: placeholder) == .empty,
      "an empty field never substitutes its placeholder")
let longBefore = String(repeating: "前", count: 350), longAfter = String(repeating: "后", count: 350)
let selectedContext = InputContext.capture(value: longBefore + "选中内容" + longAfter,
    selection: NSRange(location: 350, length: 4), placeholder: placeholder)
check(selectedContext.before == String(repeating: "前", count: 300) && selectedContext.after == String(repeating: "后", count: 300),
      "context keeps 300 characters per side and excludes the selected text")
check(InputContext.capture(value: "真实正文", selection: nil, placeholder: placeholder) == .empty,
      "missing cursor data never becomes whole-field context")
check(InputContext.capture(value: "真实正文", selection: NSRange(location: 10, length: 0), placeholder: nil) == .empty,
      "a stale cursor range does not manufacture context at the end of the field")
check(InputContext.capture(value: placeholder, selection: NSRange(location: 0, length: 0), placeholder: nil, characterCount: 0) == .empty,
      "an explicitly empty editor excludes synthetic AXValue text even without placeholder metadata")
check(InputContext.capture(value: "真实正文", selection: NSRange(location: 4, length: 0), placeholder: placeholder, characterCount: 4).before == "真实正文",
      "a nonempty editor keeps the text the user entered")

// Reproduces the observed editor metadata: CSS-generated hint appears as value,
// title and description, with a nonzero character count but no AXPlaceholderValue.
let generatedHint = "在此输入问题"
check(InputContext.capture(value: generatedHint, selection: NSRange(location: 0, length: 0), placeholder: nil,
                          characterCount: generatedHint.utf16.count, title: generatedHint, description: generatedHint) == .empty,
      "an empty editor's generated hint is excluded even when AX reports it as real characters")
check(InputContext.capture(value: "\n\u{200B}" + generatedHint + "\n", selection: NSRange(location: 0, length: 0), placeholder: nil,
                          title: generatedHint, description: generatedHint) == .empty,
      "label-derived hints ignore editor padding without a product-specific phrase list")
check(InputContext.capture(value: generatedHint, selection: NSRange(location: generatedHint.utf16.count, length: 0), placeholder: nil,
                          title: generatedHint, description: generatedHint).before == generatedHint,
      "typing the hint phrase as actual content keeps it when the caret has advanced")
check(InputContext.capture(value: generatedHint, selection: NSRange(location: 0, length: 2), placeholder: nil,
                          title: generatedHint, description: generatedHint).after == "输入问题",
      "a real selected range is not mistaken for an untouched generated hint")
check(InputContext.capture(value: realText, selection: NSRange(location: 0, length: 0), placeholder: nil,
                          title: generatedHint, description: generatedHint).after == realText,
      "real body text at the start of a labeled field remains available as context")
check(InputContext.capture(value: generatedHint, selection: NSRange(location: 0, length: 0), placeholder: nil,
                          title: generatedHint, description: "另一个字段说明").after == generatedHint,
      "one coincidentally matching label alone does not discard real text")
if failures > 0 { exit(1) }
