import Foundation

struct EngineError: LocalizedError {
    var message: String
    var writeAttempted = false
    var errorDescription: String? { message }
}

/// A private, serial stdin/stdout connection. No HTTP server or open port.
final class LocalEngine: @unchecked Sendable {
    private let queue = DispatchQueue(label: "org.yanmo.inference", qos: .userInitiated)
    private let lock = NSLock()
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var buffer = Data()
    private var executable = ""

    func stop() {
        lock.lock()
        let running = process
        lock.unlock()
        if running?.isRunning == true { running?.terminate() }
    }

    func request(_ payload: [String: Any], python: String) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    try self.startIfNeeded(python: python)
                    let id = UUID().uuidString
                    var request = payload
                    request["id"] = id
                    var data = try JSONSerialization.data(withJSONObject: request)
                    data.append(10)
                    guard let input = self.input, let output = self.output else {
                        throw EngineError(message: "本地引擎连接未建立。")
                    }
                    let running = self.process
                    let timeout = DispatchWorkItem { if running?.isRunning == true { running?.terminate() } }
                    DispatchQueue.global().asyncAfter(deadline: .now() + 180, execute: timeout)
                    defer { timeout.cancel() }
                    try input.write(contentsOf: data)
                    while true {
                        if let end = self.buffer.firstIndex(of: 10) {
                            let line = self.buffer.prefix(upTo: end)
                            self.buffer.removeSubrange(...end)
                            guard let response = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                                  response["id"] as? String == id else {
                                throw EngineError(message: "本地引擎返回了无效响应。请重试。")
                            }
                            guard response["ok"] as? Bool == true else {
                                throw EngineError(message: response["error"] as? String ?? "本地推理失败。")
                            }
                            continuation.resume(returning: response)
                            return
                        }
                        let chunk = output.availableData
                        if chunk.isEmpty {
                            throw EngineError(message: "本地引擎已退出或处理超时。已识别的原文会保留，请检查 Python 环境和模型设置。")
                        }
                        self.buffer.append(chunk)
                    }
                } catch {
                    self.stop()
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func startIfNeeded(python: String) throws {
        if process?.isRunning == true && executable == python { return }
        stop()
        buffer.removeAll()
        let path = NSString(string: python).expandingTildeInPath
        guard FileManager.default.isExecutableFile(atPath: path) else {
            throw EngineError(message: "找不到可执行的 Python。请在设置中选择已安装 MLX 的 Python 解释器。")
        }
        let worker = Bundle.main.resourceURL!.appendingPathComponent("engine/worker.py")
        guard FileManager.default.fileExists(atPath: worker.path) else {
            throw EngineError(message: "缺少本地引擎。请运行 scripts/build.sh 构建完整的言墨.app。")
        }
        let process = Process()
        let stdin = Pipe(), stdout = Pipe()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["-u", worker.path]
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONUNBUFFERED"] = "1"
        environment["HF_HUB_OFFLINE"] = "1"
        environment["TRANSFORMERS_OFFLINE"] = "1"
        process.environment = environment
        process.standardInput = stdin
        process.standardOutput = stdout
        // Libraries may log diagnostics. Never persist audio, context, or library output.
        process.standardError = FileHandle.nullDevice
        try process.run()
        lock.lock()
        self.process = process
        lock.unlock()
        self.input = stdin.fileHandleForWriting
        self.output = stdout.fileHandleForReading
        executable = python
    }

    deinit { stop() }
}
