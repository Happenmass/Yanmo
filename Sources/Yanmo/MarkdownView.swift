import SwiftUI
import YanmoCore

struct MarkdownView: View {
    private let document: MarkdownDocument
    let size: CGFloat
    init(_ source: String, size: CGFloat = 15) {
        document = MarkdownDocument(source)
        self.size = size
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(document.blocks) { block in
                HStack(alignment: .top, spacing: 9) {
                    if block.quoted { Rectangle().fill(Ink.red.opacity(0.5)).frame(width: 3) }
                    if block.depth > 0 {
                        Text(block.marker ?? " ").font(.system(size: size)).foregroundStyle(Ink.muted).frame(width: 24, alignment: .trailing)
                    }
                    content(block).frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, CGFloat(max(0, block.depth - 1)) * 18)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
        })
    }

    @ViewBuilder private func content(_ block: MarkdownDocument.Block) -> some View {
        switch block.kind {
        case .paragraph:
            Text(styled(block.text)).lineSpacing(5)
        case .heading(let level):
            Text(styled(block.text, heading: level)).padding(.top, 5).lineSpacing(3)
        case .rule:
            Rectangle().fill(Ink.line).frame(height: 1).padding(.vertical, 5)
        case .code(let language):
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Text(language?.isEmpty == false ? language! : "代码").font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundStyle(Ink.muted)
                    Spacer()
                    Button("复制代码") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(String(block.text.characters), forType: .string)
                    }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(Ink.red)
                }
                ScrollView(.horizontal) {
                    Text(highlight(String(block.text.characters))).lineSpacing(3).fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(12).background(Ink.black.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Ink.line, lineWidth: 0.5))
        case .table(let rows, let columns):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.cells.enumerated()), id: \.offset) { index, cell in
                                Text(styled(cell, bold: row.header))
                                    .padding(.horizontal, 12).padding(.vertical, 9)
                                    .frame(minWidth: 90, maxWidth: 260, alignment: alignment(columns[index].alignment))
                                    .background(row.header ? Ink.black.opacity(0.06) : Color.white.opacity(0.2))
                                    .overlay(Rectangle().stroke(Ink.line, lineWidth: 0.5))
                            }
                        }
                    }
                }.padding(1)
            }
        }
    }

    private func alignment(_ value: PresentationIntent.TableColumn.Alignment) -> Alignment {
        switch value { case .center: return .center; case .right: return .trailing; default: return .leading }
    }

    private func styled(_ original: AttributedString, heading: Int? = nil, bold: Bool = false) -> AttributedString {
        var text = original
        for run in original.runs {
            let intents = run.inlinePresentationIntent ?? []
            let pointSize = heading.map { size + CGFloat(max(1, 7 - $0)) * 1.7 } ?? size
            var font = intents.contains(.code) ? Font.system(size: size - 1, design: .monospaced) : Font.system(size: pointSize)
            if bold || heading != nil || intents.contains(.stronglyEmphasized) { font = font.bold() }
            if intents.contains(.emphasized) { font = font.italic() }
            text[run.range].font = font
            text[run.range].foregroundColor = intents.contains(.code) ? Ink.jade : Ink.black
            if intents.contains(.code) { text[run.range].backgroundColor = Ink.black.opacity(0.04) }
            if let link = run.link {
                if ["https", "http", "mailto"].contains(link.scheme?.lowercased() ?? "") { text[run.range].foregroundColor = Ink.red }
                else { text[run.range].link = nil }
            }
        }
        return text
    }

    /// Modest, local token colouring for common code examples; source stays intact.
    private func highlight(_ code: String) -> AttributedString {
        var text = AttributedString(code)
        text.font = .system(size: size - 2, design: .monospaced)
        text.foregroundColor = Ink.black
        let pattern = #"(?m)(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')|(//[^\n]*|#[^\n]*)|\b(import|from|def|class|func|let|var|const|return|if|else|for|while|try|catch|throw|async|await|true|false|null|None|True|False|public|private|struct|enum|switch|case|SELECT|FROM|WHERE)\b|\b\d+(?:\.\d+)?\b"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        for match in regex.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
            guard let range = Range(match.range, in: code),
                  let start = AttributedString.Index(range.lowerBound, within: text),
                  let end = AttributedString.Index(range.upperBound, within: text) else { continue }
            text[start..<end].foregroundColor = match.range(at: 1).location != NSNotFound ? Ink.jade : match.range(at: 2).location != NSNotFound ? Ink.muted : Ink.red
        }
        return text
    }
}
