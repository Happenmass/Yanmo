import AVFoundation
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

        // Verify 48kHz stereo PCM WAV -> 16kHz mono FLAC archival produces a valid playable FLAC file.
        let tempDir = FileManager.default.temporaryDirectory
        let wavURL = tempDir.appendingPathComponent("yanmo-check-\(UUID().uuidString).wav")
        let flacURL = tempDir.appendingPathComponent("yanmo-check-\(UUID().uuidString).flac")
        defer {
            try? FileManager.default.removeItem(at: wavURL)
            try? FileManager.default.removeItem(at: flacURL)
        }
        let stereoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false)!
        do {
            let wavFile = try AVAudioFile(forWriting: wavURL, settings: stereoFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            let frames: AVAudioFrameCount = 24000
            let buffer = AVAudioPCMBuffer(pcmFormat: stereoFormat, frameCapacity: frames)!
            buffer.frameLength = frames
            for i in 0..<Int(frames) {
                let sample = sin(Float(i) * 0.04) * 0.25
                buffer.floatChannelData![0][i] = sample
                buffer.floatChannelData![1][i] = sample
            }
            try wavFile.write(from: buffer)
        }
        let flacData = try AudioArchiver.encodeFLAC(from: wavURL)
        guard flacData.prefix(4) == Data("fLaC".utf8) else {
            print("FAIL: encoded archive does not start with fLaC magic")
            exit(1)
        }
        try flacData.write(to: flacURL, options: .atomic)
        let decoded = try AVAudioFile(forReading: flacURL)
        guard decoded.fileFormat.sampleRate == 16000, decoded.fileFormat.channelCount == 1, decoded.length > 7000 else {
            print("FAIL: decoded FLAC metadata invalid: rate=\(decoded.fileFormat.sampleRate), ch=\(decoded.fileFormat.channelCount), len=\(decoded.length)")
            exit(1)
        }
        print("PASS: AudioArchiver encodes 48kHz stereo WAV into valid 16kHz mono FLAC (\(flacData.count) bytes)")
    }
}
