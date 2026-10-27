import Foundation

/// Reads the bridge's newline-delimited commands until Electron closes stdin.
package enum BridgeInput {
    package static func readLines(_ receive: (String) -> Void) {
        // Swift readLine holds stdin's FILE lock while waiting. Foundation's
        // XPath parser also locks stdin (fileno), even when parsing an in-memory
        // HTML selection. Read the pipe directly so the two cannot deadlock.
        let input = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let end = buffer.firstIndex(of: 10) {
                if let line = String(data: buffer[..<end], encoding: .utf8) { receive(line) }
                buffer.removeSubrange(...end)
            }
        }
        if !buffer.isEmpty, let line = String(data: buffer, encoding: .utf8) { receive(line) }
    }
}
