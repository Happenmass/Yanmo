import Foundation

/// Converts the copied selection's semantic HTML, without loading a web page or resources.
public enum SelectionMarkdown {
    public static func fromCopiedText(_ plain: String, html: String?) -> String {
        // Editors may copy Markdown source inside a plain HTML wrapper. Keep it intact.
        guard let html, html.range(of: "(?i)<(?:h[1-6]|strong|b|em|i|del|s|code|pre|ul|ol|blockquote|table|a)(?:\\s|>)", options: .regularExpression) != nil,
              let markdown = fromHTML(html) else { return plain }
        return markdown
    }

    public static func fromHTML(_ html: String) -> String? {
        guard html.utf8.count <= 2_000_000,
              !html.localizedCaseInsensitiveContains("<!DOCTYPE"),
              !html.localizedCaseInsensitiveContains("<!ENTITY") else { return nil }
        var fragment = html
        if let start = html.range(of: "<!--StartFragment-->"),
           let end = html.range(of: "<!--EndFragment-->"), start.upperBound <= end.lowerBound {
            fragment = String(html[start.upperBound..<end.lowerBound])
        }
        guard let document = try? XMLDocument(xmlString: fragment, options: [.documentTidyHTML, .nodeLoadExternalEntitiesNever, .nodePreserveWhitespace]) else { return nil }
        let converter = Converter()
        let root = (try? document.nodes(forXPath: "//body").first) ?? document.rootElement()
        guard let root else { return nil }
        var output = converter.render(root)
        guard !converter.exceeded else { return nil }
        output = output.replacingOccurrences(of: "\n[ \t]+\n", with: "\n\n", options: .regularExpression)
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        for (key, value) in converter.code { output = output.replacingOccurrences(of: key, with: value) }
        return output.isEmpty ? nil : output
    }

    private final class Converter {
        var code: [(String, String)] = []
        let prefix = UUID().uuidString
        var count = 0
        var exceeded = false
        func stored(_ value: String) -> String {
            let token = "YANMO-\(prefix)-\(code.count)"
            code.append((token, value)); return token
        }
        func escape(_ value: String) -> String {
            var result = value
            for symbol in ["\\", "`", "*", "_", "[", "]", "#", ">", "|", "!"] { result = result.replacingOccurrences(of: symbol, with: "\\" + symbol) }
            return result
        }
        func children(_ node: XMLNode, depth: Int) -> String {
            (node.children ?? []).map { render($0, depth: depth + 1) }.joined()
        }
        func render(_ node: XMLNode, depth: Int = 0) -> String {
            count += 1
            guard depth < 80, count < 20000 else { exceeded = true; return "" }
            if node.kind == .text {
                return escape((node.stringValue ?? "").replacingOccurrences(of: "[\\s\\u00a0]+", with: " ", options: .regularExpression))
            }
            guard let element = node as? XMLElement else { return "" }
            let tag = (element.name ?? "").lowercased()
            if ["head", "script", "style", "noscript", "button", "svg", "img", "iframe", "object"].contains(tag) { return "" }
            if element.attribute(forName: "hidden") != nil || element.attribute(forName: "aria-hidden")?.stringValue == "true" { return "" }
            if tag == "pre" {
                let codeNode = (try? element.nodes(forXPath: ".//code").first) ?? element
                let raw = codeNode.stringValue ?? ""
                let classes = (codeNode as? XMLElement)?.attribute(forName: "class")?.stringValue ?? ""
                let language = classes.split(separator: " ").first { $0.hasPrefix("language-") }.map { String($0.dropFirst(9)).filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "+" } } ?? ""
                let fence = String(repeating: "`", count: max(3, longestBackticks(raw) + 1))
                return "\n\n" + stored(fence + language + "\n" + raw + (raw.hasSuffix("\n") ? "" : "\n") + fence) + "\n\n"
            }
            if tag == "code" {
                let raw = (element.stringValue ?? "").replacingOccurrences(of: "\n", with: " ")
                let fence = String(repeating: "`", count: max(1, longestBackticks(raw) + 1))
                let pad = raw.hasPrefix("`") || raw.hasSuffix("`") || (raw.hasPrefix(" ") && raw.hasSuffix(" ")) ? " " : ""
                return stored(fence + pad + raw + pad + fence)
            }
            if tag == "ul" || tag == "ol" {
                let items = (element.children ?? []).compactMap { $0 as? XMLElement }.filter { $0.name?.lowercased() == "li" }
                let start = Int(element.attribute(forName: "start")?.stringValue ?? "1") ?? 1
                return "\n\n" + items.enumerated().map { index, item in
                    let marker = tag == "ol" ? "\(start + index). " : "- "
                    let content = children(item, depth: depth).trimmingCharacters(in: .whitespacesAndNewlines)
                    let lines = content.components(separatedBy: "\n")
                    return marker + lines.joined(separator: "\n" + String(repeating: " ", count: marker.count))
                }.joined(separator: "\n") + "\n\n"
            }
            if tag == "table" {
                let rows = (try? element.nodes(forXPath: "./tr|./thead/tr|./tbody/tr|./tfoot/tr")) ?? []
                let cells = rows.map { row in
                    (row.children ?? []).compactMap { $0 as? XMLElement }.filter { ["td", "th"].contains($0.name?.lowercased() ?? "") }.map {
                        children($0, depth: depth).trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
                    }
                }.filter { !$0.isEmpty }
                guard let first = cells.first else { return "" }
                let width = cells.map(\.count).max() ?? first.count
                func line(_ row: [String]) -> String { "| " + (row + Array(repeating: "", count: width - row.count)).joined(separator: " | ") + " |" }
                return "\n\n" + ([line(first), line(Array(repeating: "---", count: width))] + cells.dropFirst().map(line)).joined(separator: "\n") + "\n\n"
            }
            let value = children(element, depth: depth)
            switch tag {
            case "h1", "h2", "h3", "h4", "h5", "h6":
                return "\n\n" + String(repeating: "#", count: Int(tag.dropFirst()) ?? 1) + " " + value.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n"
            case "strong", "b": return emphasis(value, marker: "**")
            case "em", "i": return emphasis(value, marker: "*")
            case "del", "s": return emphasis(value, marker: "~~")
            case "br": return "\n"
            case "hr": return "\n\n---\n\n"
            case "blockquote": return "\n\n" + value.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n") + "\n\n"
            case "p", "div", "section", "article": return "\n\n" + value + "\n\n"
            case "a":
                guard let href = element.attribute(forName: "href")?.stringValue,
                      let url = URL(string: href), ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return value }
                let safe = href.replacingOccurrences(of: " ", with: "%20").replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")
                return "[" + value + "](\(safe))"
            default: return value
            }
        }
        func emphasis(_ value: String, marker: String) -> String {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return value }
            return (value.first?.isWhitespace == true ? " " : "") + marker + trimmed + marker + (value.last?.isWhitespace == true ? " " : "")
        }
        func longestBackticks(_ value: String) -> Int {
            var longest = 0, current = 0
            for char in value { current = char == "`" ? current + 1 : 0; longest = max(longest, current) }
            return longest
        }
    }
}
