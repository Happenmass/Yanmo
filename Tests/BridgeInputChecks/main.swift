import Foundation
import YanmoCore
import YanmoNative

@main
struct BridgeInputChecks {
    static func main() throws {
        if CommandLine.arguments.contains("--worker") {
            let reading = DispatchSemaphore(value: 0)
            Thread.detachNewThread { BridgeInput.readLines { _ in reading.signal() } }
            guard reading.wait(timeout: .now() + 2) == .success else { exit(2) }
            // Let the reader wait for the next command, as it does in the app.
            Thread.sleep(forTimeInterval: 0.05)
            let html = "<html><body><p><strong>Fixture</strong> selection.</p></body></html>"
            let markdown = SelectionMarkdown.fromCopiedText("Fixture selection.", html: html)
            guard markdown.contains("**Fixture**") else { exit(3) }
            FileHandle.standardOutput.write(Data("converted\n".utf8))
            return
        }

        if CommandLine.arguments.contains("--echo") {
            BridgeInput.readLines { FileHandle.standardOutput.write(Data(($0 + "\n").utf8)) }
            return
        }

        let child = Process(), input = Pipe(), output = Pipe()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--worker"]
        child.standardInput = input; child.standardOutput = output
        let finished = DispatchSemaphore(value: 0)
        child.terminationHandler = { _ in finished.signal() }
        try child.run()
        input.fileHandleForWriting.write(Data("start\n".utf8))
        // Keep stdin open: a request/reply bridge must not need EOF to parse HTML.
        guard finished.wait(timeout: .now() + 3) == .success else {
            child.terminate(); child.waitUntilExit()
            print("FAIL: HTML selection conversion stalled while the command reader waited on open stdin")
            exit(1)
        }
        let result = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
        guard child.terminationStatus == 0, result == "converted\n" else {
            print("FAIL: HTML selection conversion failed (exit \(child.terminationStatus))")
            exit(1)
        }
        print("PASS: HTML selection conversion completes while the bridge waits for its next command")

        let echo = Process(), fragmented = Pipe(), echoed = Pipe()
        echo.executableURL = child.executableURL; echo.arguments = ["--echo"]
        echo.standardInput = fragmented; echo.standardOutput = echoed
        let echoedResult = DispatchSemaphore(value: 0)
        echo.terminationHandler = { _ in echoedResult.signal() }
        try echo.run()
        let first = Data("{\"text\":\"中文选区\"}\n".utf8)
        // Split inside a Chinese character, then send multiple commands in one read.
        fragmented.fileHandleForWriting.write(first.prefix(11))
        Thread.sleep(forTimeInterval: 0.02)
        fragmented.fileHandleForWriting.write(first.dropFirst(11) + Data("{}\n{\"last\":true}".utf8))
        try fragmented.fileHandleForWriting.close()
        guard echoedResult.wait(timeout: .now() + 3) == .success else {
            echo.terminate(); echo.waitUntilExit(); print("FAIL: command framing stalled"); exit(1)
        }
        let commands = String(data: echoed.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
        guard echo.terminationStatus == 0, commands == "{\"text\":\"中文选区\"}\n{}\n{\"last\":true}\n" else {
            print("FAIL: fragmented UTF-8 or EOF command was lost"); exit(1)
        }
        print("PASS: fragmented UTF-8, batched commands and a final command without newline survive pipe reads")
    }
}
