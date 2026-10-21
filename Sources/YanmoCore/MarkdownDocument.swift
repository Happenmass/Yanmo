import Foundation

/// Parse locally with Foundation's Markdown parser. No HTML execution or image loading.
public struct MarkdownDocument {
    public struct Row {
        public var header: Bool
        public var cells: [AttributedString]
    }
    public struct Block: Identifiable {
        public enum Kind {
            case paragraph, heading(Int), code(String?), rule
            case table([Row], [PresentationIntent.TableColumn])
        }
        public var id: Int
        public var text: AttributedString
        public var kind: Kind
        public var marker: String?
        public var depth: Int
        public var quoted: Bool
    }
    public let blocks: [Block]

    public init(_ source: String) {
        guard let parsed = try? AttributedString(markdown: source, options: .init(interpretedSyntax: .full)) else {
            blocks = [Block(id: 0, text: AttributedString(source), kind: .paragraph, depth: 0, quoted: false)]
            return
        }
        var leaves: [(id: Int, text: AttributedString, intents: [PresentationIntent.IntentType])] = []
        for run in parsed.runs {
            let intents = run.presentationIntent?.components ?? []
            let id = intents.first?.identity ?? 0
            var text = AttributedString(parsed[run.range])
            text.presentationIntent = nil
            if leaves.last?.id == id { leaves[leaves.count - 1].text.append(text) }
            else { leaves.append((id, text, intents)) }
        }
        var result: [Block] = []
        var shownItems = Set<Int>()
        var i = 0
        while i < leaves.count {
            let leaf = leaves[i]
            let quoted = leaf.intents.contains { $0.kind == .blockQuote }
            let items = leaf.intents.filter { if case .listItem = $0.kind { return true }; return false }
            var marker: String?
            if let item = items.first, shownItems.insert(item.identity).inserted,
               case .listItem(let ordinal) = item.kind {
                let parentIndex = leaf.intents.firstIndex { $0.identity == item.identity }! + 1
                marker = parentIndex < leaf.intents.count && leaf.intents[parentIndex].kind == .orderedList ? "\(ordinal)." : "•"
            }
            let depth = items.count
            var kind: Block.Kind = .paragraph
            if let table = leaf.intents.first(where: { if case .table = $0.kind { return true }; return false }),
               case .table(let columns) = table.kind {
                var rows: [Row] = []
                var lastRow: Int?
                while i < leaves.count, leaves[i].intents.contains(where: { $0.identity == table.identity }) {
                    let cell = leaves[i]
                    let row = cell.intents.first { if case .tableRow = $0.kind { return true }; return $0.kind == .tableHeaderRow }
                    if row?.identity != lastRow {
                        rows.append(Row(header: row?.kind == .tableHeaderRow, cells: Array(repeating: AttributedString(), count: columns.count)))
                        lastRow = row?.identity
                    }
                    if case .tableCell(let column) = cell.intents.first?.kind, !rows.isEmpty, column < columns.count {
                        rows[rows.count - 1].cells[column] = cell.text
                    }
                    i += 1
                }
                kind = .table(rows, columns)
            } else {
                switch leaf.intents.first?.kind {
                case .header(let level): kind = .heading(level)
                case .codeBlock(let language): kind = .code(language)
                case .thematicBreak: kind = .rule
                default: break
                }
                i += 1
            }
            result.append(Block(id: leaf.id, text: leaf.text, kind: kind, marker: marker, depth: depth, quoted: quoted))
        }
        blocks = result.isEmpty && !source.isEmpty ? [Block(id: 0, text: AttributedString(source), kind: .paragraph, depth: 0, quoted: false)] : result
    }
}
