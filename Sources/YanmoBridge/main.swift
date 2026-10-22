import AppKit
@preconcurrency import AVFoundation
import ApplicationServices
import PermissionFlow
import YanmoCore
import YanmoNative

/// Owns OS handles only. Text generation, windows, and persistent application data
/// remain in the Electron application and its independent inference backend.
@MainActor
final class Bridge {
    private let keys = HotKeys()
    private let recorder = AudioRecorder()
    private var destinations: [String: InputDestination] = [:]
    private var audioFiles = Set<URL>()
    private var meter: Timer?
    private var active = false
    private var readContext = false
    private var recordingGeneration = UUID()
    private var recordingID = ""
    private var deliveryTask: Task<String, Error>?
    private var selectionTask: Task<String, Error>?
    private lazy var permissionFlow = PermissionFlow.makeController()
    private var trustWatch: Timer?
    private let parentPID = pid_t(ProcessInfo.processInfo.environment["YANMO_PARENT_PID"] ?? "0") ?? 0

    init() {
        keys.onAction = { [weak self] action in
            guard let self else { return }
            // Do not issue synchronous AX calls inside a CGEvent tap: the target
            // editor may still be waiting for that keyboard callback to return.
            let application = NSWorkspace.shared.frontmostApplication
            let finishing = self.active
            Task { @MainActor [weak self] in
                guard let self else { return }
                let target = finishing ? [:] : await self.capture(context: self.readContext, in: application, requireForeground: true)
                self.send(["event": "shortcut", "action": action.rawValue, "destination": target])
            }
        }
        keys.onCancel = { [weak self] in self?.send(["event": "cancel"]) }
        keys.isActive = { [weak self] in self?.active == true }
        keys.onCaptureFn = { [weak self] in self?.captured(.fn) }
        keys.onCaptureShortcut = { [weak self] in self?.captured($0) }
    }

    func send(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }

    private func captured(_ shortcut: InputShortcut?) {
        var value: [String: Any] = ["event": "shortcutCaptured"]
        if let shortcut, let data = try? JSONEncoder().encode(shortcut), let json = try? JSONSerialization.jsonObject(with: data) {
            value["shortcut"] = json
            value["label"] = shortcut.label
            value["validationError"] = shortcut.validationError ?? ""
        }
        send(value)
    }

    private func capture(context: Bool, in application: NSRunningApplication?, requireForeground: Bool) async -> [String: Any] {
        guard let application, application.processIdentifier != parentPID else { return [:] }
        var fallback: InputDestination?
        func retain(_ target: InputDestination) -> [String: Any] {
            if destinations.count >= 32 { destinations.removeAll() }
            let id = UUID().uuidString
            destinations[id] = target
            return ["id": id, "name": target.name, "category": target.category, "before": target.before,
                    "after": target.after, "secure": target.secure]
        }
        // Pin the app at the trigger; never recover focus from a different app.
        for attempt in 0..<4 {
            guard !application.isTerminated,
                  !requireForeground || NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
                return [:] // Context is optional; a focus change never blocks recording.
            }
            if let target = InputDestination.capture(readContext: context, in: application) {
                if target.element != nil { return retain(target) }
                if fallback == nil { fallback = target }
            }
            if attempt < 3 { try? await Task.sleep(nanoseconds: 70_000_000) }
        }
        // AX readability is optional. An opaque app still records normally;
        // delivery resolves the current focus later, independently of this snapshot.
        if let fallback { return retain(fallback) }
        return [:]
    }

    private func status() -> [String: Any] {
        ["accessibility": AXIsProcessTrusted(), "eventTap": keys.enableFn(),
         "microphone": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
         "devices": AudioInput.available().map { ["id": $0.id, "name": $0.name] }]
    }

    /// Opens Accessibility settings with a floating panel the user drags 言墨 from into the list.
    private func guideAccessibility(app: String?, source: [String: Double]?) {
        var frame: CGRect?
        if let source, let x = source["x"], let y = source["y"], let width = source["width"], let height = source["height"], let screen = NSScreen.screens.first {
            frame = CGRect(x: x, y: screen.frame.maxY - y - height, width: width, height: height) // Electron's origin is top-left.
        }
        NSApp.setActivationPolicy(.accessory) // A prohibited process cannot show the panel.
        permissionFlow.authorize(pane: .accessibility, suggestedAppURLs: app.map { [URL(fileURLWithPath: $0)] } ?? [], sourceFrameInScreen: frame)
        // macOS posts no grant notification; poll until granted (a no-op once settings are closed).
        trustWatch?.invalidate()
        trustWatch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self, AXIsProcessTrusted() else { return }
                timer.invalidate()
                self.permissionFlow.closePanel(returnToPreviousApp: true)
                NSApp.setActivationPolicy(.prohibited)
                self.send(["event": "permissions"])
            }
        }
    }

    private func legacySettings() -> [String: Any] {
        let defaults = UserDefaults(suiteName: "org.yanmo.desktop")!
        var result: [String: Any] = [:]
        for key in ["asr", "llm", "polish", "context", "history", "microphone", "showDock", "retention", "style", "voiceTarget", "selectionTarget"] {
            if let value = defaults.object(forKey: key) { result[key] = value }
        }
        for key in ["shortcuts", "voiceTranslationShortcuts", "selectionTranslationShortcuts"] {
            if let data = defaults.data(forKey: key), let value = try? JSONSerialization.jsonObject(with: data) { result[key] = value }
        }
        return result
    }

    private func decode<T: Decodable>(_ value: Any, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    private func normalizedAudio(_ path: String) async throws -> [String: Any] {
        let inputURL = URL(fileURLWithPath: path)
        let duration = try await AVURLAsset(url: inputURL).load(.duration).seconds
        guard duration.isFinite, duration > 0, duration <= 300 else { throw EngineError(message: "首版支持 5 分钟以内的音频，请分段后导入。") }
        let input = try AVAudioFile(forReading: inputURL)
        guard input.length > 0, input.length < Int64(UInt32.max),
              let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: AVAudioFrameCount(input.length)),
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: input.processingFormat, to: format) else {
            throw EngineError(message: "音频格式无法读取，请换一个音频文件。")
        }
        try input.read(into: buffer)
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / input.processingFormat.sampleRate)) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw EngineError(message: "音频转换失败。") }
        var supplied = false
        var conversionError: NSError?
        let result = converter.convert(to: output, error: &conversionError) { _, state in
            if supplied { state.pointee = .endOfStream; return nil }
            supplied = true; state.pointee = .haveData; return buffer
        }
        guard result != .error, conversionError == nil, output.frameLength > 0 else { throw conversionError ?? EngineError(message: "音频转换失败。") as NSError }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yanmo-import-\(UUID().uuidString).wav")
        do {
            let file = try AVAudioFile(forWriting: url, settings: format.settings)
            try file.write(from: output)
        } catch { try? FileManager.default.removeItem(at: url); throw error }
        audioFiles.insert(url)
        return ["path": url.path, "seconds": duration]
    }

    func handle(_ message: [String: Any]) async {
        let id = message["id"] as? String ?? ""
        let args = message["args"] as? [String: Any] ?? [:]
        do {
            var result: [String: Any] = [:]
            switch message["command"] as? String {
            case "status": result = status()
            case "legacySettings": result = legacySettings()
            case "permissions":
                if args["request"] as? Bool == true, !AXIsProcessTrusted() {
                    guideAccessibility(app: args["app"] as? String, source: args["source"] as? [String: Double])
                }
                result = status()
            case "configure":
                var bindings: [ShortcutBinding] = []
                for item in args["bindings"] as? [[String: Any]] ?? [] {
                    guard let name = item["action"] as? String, let action = InputAction(rawValue: name), let raw = item["shortcut"] else { throw EngineError(message: "快捷键配置无效。") }
                    let shortcut = try decode(raw, as: InputShortcut.self)
                    if let error = shortcut.validationError { throw EngineError(message: error) }
                    bindings.append(ShortcutBinding(action: action, shortcut: shortcut))
                }
                let wasCapturing = keys.capturing
                do { try keys.configure(bindings); keys.capturing = false }
                catch { if wasCapturing { keys.suspend() }; throw error }
                readContext = args["readContext"] as? Bool ?? false
                result = status()
            case "captureShortcut":
                if args["enabled"] as? Bool == true { keys.suspend() } else { try keys.resume() }
                result = status()
            case "active":
                active = args["value"] as? Bool ?? false
                if !active { destinations.removeAll(); deliveryTask?.cancel(); selectionTask?.cancel() }
            case "capture":
                let bundleID = args["applicationBundleID"] as? String
                let application = bundleID.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first } ?? (bundleID == nil ? NSWorkspace.shared.frontmostApplication : nil)
                result = await capture(context: args["readContext"] as? Bool ?? false, in: application, requireForeground: bundleID == nil)
            case "release": if let targetID = args["destinationId"] as? String { destinations.removeValue(forKey: targetID) }
            case "selection":
                guard let targetID = args["destinationId"] as? String, let target = destinations.removeValue(forKey: targetID) else { throw EngineError(message: "请先选中文字，再按划词翻译快捷键。") }
                let reading = Task { try await target.selectedText() }; selectionTask = reading
                defer { selectionTask = nil }
                result = ["text": try await reading.value]
            case "insert":
                guard let text = args["text"] as? String else { throw EngineError(message: "没有可写入的正文。") }
                let writing = Task { try await InputDestination.pasteAtCurrentFocus(text) }; deliveryTask = writing
                defer { deliveryTask = nil }
                let name = try await writing.value
                result = ["delivery": "attempted_unverified", "name": name, "message": "已向写入时的前台输入位置发送一次粘贴。"]
            case "record.start":
                let generation = UUID(); recordingGeneration = generation
                recorder.cancel()
                try await recorder.start(deviceUID: args["device"] as? String ?? "")
                guard recordingGeneration == generation else { recorder.cancel(); throw EngineError(message: "录音已取消。") }
                recordingID = args["taskId"] as? String ?? ""
                meter?.invalidate()
                meter = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { guard let self else { return }; self.send(["event": "meter", "taskId": self.recordingID, "level": self.recorder.level]) }
                }
            case "record.finish":
                meter?.invalidate(); meter = nil
                guard let url = recorder.finish() else { throw EngineError(message: "录音没有生成，请重试。") }
                audioFiles.insert(url); result = ["path": url.path]
            case "record.cancel":
                recordingGeneration = UUID(); meter?.invalidate(); meter = nil; recorder.cancel()
            case "audio.import": result = try await normalizedAudio(args["path"] as? String ?? "")
            case "audio.delete":
                let url = URL(fileURLWithPath: args["path"] as? String ?? "")
                if audioFiles.remove(url) != nil { try? FileManager.default.removeItem(at: url) }
            case "quit": shutdown(); NSApp.terminate(nil)
            default: throw EngineError(message: "未知的系统桥接操作。")
            }
            send(["id": id, "ok": true, "result": result])
        } catch { send(["id": id, "ok": false, "error": error.localizedDescription]) }
    }

    func shutdown() {
        recordingGeneration = UUID(); meter?.invalidate(); recorder.cancel(); trustWatch?.invalidate()
        deliveryTask?.cancel(); selectionTask?.cancel()
        for url in audioFiles { try? FileManager.default.removeItem(at: url) }
        audioFiles.removeAll(); destinations.removeAll()
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let bridge = MainActor.assumeIsolated {
    let value = Bridge()
    value.send(["event": "ready", "protocol": 1, "pid": ProcessInfo.processInfo.processIdentifier])
    return value
}
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { Task { @MainActor in await bridge.handle(message) } }
    }
    DispatchQueue.main.async { bridge.shutdown(); NSApp.terminate(nil) }
}
application.run()
