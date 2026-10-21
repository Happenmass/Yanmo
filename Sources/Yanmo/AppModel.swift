import AppKit
import AVFoundation
import SwiftUI
import UniformTypeIdentifiers
import YanmoCore

enum Page: String, CaseIterable {
    case desk = "书案", manuscripts = "文稿", dictionary = "词库", settings = "设置"
    var symbol: String {
        switch self { case .desk: return "tray"; case .manuscripts: return "doc.text"; case .dictionary: return "book"; case .settings: return "gearshape" }
    }
}

enum Stage: Equatable {
    case idle, preparing, recording, transcribing, polishing, success, failure
    var busy: Bool { [.preparing, .recording, .transcribing, .polishing].contains(self) }
    var label: String {
        switch self {
        case .idle: return "等待开口"
        case .preparing: return "正在准备…"
        case .recording: return "正在聆听"
        case .transcribing: return "正在识别…"
        case .polishing: return "正在落笔…"
        case .success: return "文字已写入"
        case .failure: return "文稿已保留"
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    @Published var page: Page = .desk
    @Published var stage: Stage = .idle
    @Published var library = Library()
    @Published var selectedID: UUID?
    @Published var draft = ""
    @Published var original = ""
    @Published var notice = ""
    @Published var level = 0.0
    @Published var seconds = 0.0
    @Published var asrReady = false
    @Published var llmReady = false
    @Published var checking = false
    @Published var checked = false
    @Published var fnReady = false
    @Published var python: String { didSet { defaults.set(python, forKey: "python"); invalidateCheck() } }
    @Published var asrModel: String { didSet { defaults.set(asrModel, forKey: "asr"); invalidateCheck() } }
    @Published var llmModel: String { didSet { defaults.set(llmModel, forKey: "llm"); invalidateCheck() } }
    @Published var polishEnabled: Bool { didSet { defaults.set(polishEnabled, forKey: "polish") } }
    @Published var readContext: Bool { didSet { defaults.set(readContext, forKey: "context") } }
    @Published var keepHistory: Bool { didSet { defaults.set(keepHistory, forKey: "history") } }
    @Published var style: WritingStyle = .natural
    weak var overlay: OverlayController?
    var openMainWindow: (() -> Void)?
    private let defaults = UserDefaults.standard
    private let engine = LocalEngine()
    private let recorder = AudioRecorder()
    private let storage: LibraryFile
    private var hotkeys: HotKeys?
    private var timer: Timer?
    private var started = Date()
    private var operation = UUID()
    private var destination: InputDestination?
    private var saveAllowed = true

    var destinationName: String { destination?.name ?? "言墨文稿" }
    var todayCharacters: Int {
        library.manuscripts.filter { Calendar.current.isDateInToday($0.date) }.reduce(0) { $0 + $1.text.count }
    }
    var totalMinutes: Int { Int(library.manuscripts.reduce(0) { $0 + $1.seconds } / 60) }
    var timeLabel: String { String(format: "%02d:%02d", Int(seconds) / 60, Int(seconds) % 60) }

    private init() {
        python = defaults.string(forKey: "python") ?? ProcessInfo.processInfo.environment["YANMO_PYTHON"] ?? Bundle.main.object(forInfoDictionaryKey: "YanmoPython") as? String ?? "/usr/bin/python3"
        asrModel = defaults.string(forKey: "asr") ?? "mlx-community/Qwen3-ASR-1.7B-8bit"
        llmModel = defaults.string(forKey: "llm") ?? ProcessInfo.processInfo.environment["YANMO_LLM"] ?? Bundle.main.object(forInfoDictionaryKey: "YanmoLLM") as? String ?? "mlx-community/Qwen3-4B-4bit"
        polishEnabled = defaults.object(forKey: "polish") as? Bool ?? true
        readContext = defaults.bool(forKey: "context")
        keepHistory = defaults.object(forKey: "history") as? Bool ?? true
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Yanmo")
        storage = LibraryFile(url: folder.appendingPathComponent("library.json"))
        do { library = try storage.read() }
        catch {
            saveAllowed = false
            notice = "文稿库读取失败，已保留原文件并暂停覆盖保存。请先备份并检查：\(storage.url.path)"
        }
    }

    func start() {
        guard hotkeys == nil else { return }
        let keys = HotKeys()
        // Carbon and the event tap run on the main run loop. Capture focus in the
        // key callback, before deferring microphone access or inference to a task.
        keys.onToggle = { [weak self] in self?.toggleRecording() }
        keys.onCancel = { [weak self] in self?.cancel() }
        keys.isActive = { [weak self] in self?.stage.busy == true }
        fnReady = keys.enableFn()
        hotkeys = keys
        Task { await checkModels() }
    }

    func refreshPermissions() { fnReady = hotkeys?.enableFn() ?? false }

    func invalidateCheck() {
        asrReady = false; llmReady = false; checked = false
    }

    func checkModels() async {
        guard !stage.busy, !checking else { return }
        checking = true
        defer { checking = false }
        let config = (python, asrModel, llmModel)
        do {
            let result = try await engine.request(["command": "check", "asr_model": config.1, "llm_model": config.2], python: config.0)
            guard config == (python, asrModel, llmModel) else { return }
            let models = result["models"] as? [String: [String: Any]] ?? [:]
            asrReady = models["asr"]?["ready"] as? Bool ?? false
            llmReady = models["llm"]?["ready"] as? Bool ?? false
            checked = true
        } catch { notice = error.localizedDescription }
    }

    func toggleRecording() {
        if stage == .recording { finishRecording(); return }
        guard !stage.busy, !checking else { return }
        destination = InputDestination.capture(readContext: readContext)
        if destination?.secure == true {
            notice = "密码输入框中不启动语音输入。"
            return
        }
        notice = ""
        draft = ""; original = ""; selectedID = nil
        seconds = 0; level = 0
        let token = UUID(); operation = token
        stage = .preparing
        overlay?.show()
        Task {
            do {
                try await recorder.start()
                guard operation == token else { recorder.cancel(); return }
                stage = .recording
                started = Date()
                timer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, self.stage == .recording else { return }
                        self.seconds = Date().timeIntervalSince(self.started)
                        self.level = self.recorder.level
                        if self.seconds >= 300 { self.finishRecording() }
                    }
                }
            } catch {
                guard operation == token else { return }
                fail(error.localizedDescription)
            }
        }
    }

    func finishRecording() {
        guard stage == .recording else { return }
        timer?.invalidate(); timer = nil
        seconds = Date().timeIntervalSince(started)
        guard let url = recorder.finish() else { fail("录音没有生成，请重试。"); return }
        if seconds < 0.35 {
            try? FileManager.default.removeItem(at: url)
            fail("录音太短，请再说一句。"); return
        }
        let token = operation
        stage = .transcribing
        Task { await processAudio(url, owned: true, token: token) }
    }

    func importAudio() {
        guard !stage.busy, !checking else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "选择音频，所有识别与整理都在本机完成。"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        importFile(url)
    }

    func importFile(_ url: URL) {
        guard !stage.busy, !checking else { return }
        destination = nil
        selectedID = nil; draft = ""; original = ""; notice = ""
        let token = UUID(); operation = token
        stage = .transcribing
        overlay?.show()
        Task {
            let asset = AVURLAsset(url: url)
            seconds = (try? await asset.load(.duration).seconds) ?? 0
            guard operation == token else { return }
            guard seconds.isFinite, seconds > 0, seconds <= 300 else {
                fail("首版支持 5 分钟以内的音频，请分段后导入。")
                return
            }
            await processAudio(url, owned: false, token: token)
        }
    }

    private func processAudio(_ url: URL, owned: Bool, token: UUID) async {
        defer { if owned { try? FileManager.default.removeItem(at: url) } }
        do {
            let response = try await engine.request(["command": "transcribe", "audio": url.path, "asr_model": asrModel], python: python)
            guard operation == token else { return }
            original = response["text"] as? String ?? ""
            guard !original.isEmpty else { throw EngineError(message: "没有识别到正文。") }
            draft = original
            var polished = false
            var polishFailure: String?
            if polishEnabled && style != .verbatim {
                stage = .polishing
                do {
                    let result = try await polishText(original)
                    guard operation == token else { return }
                    draft = result
                    polished = true
                } catch { polishFailure = "文字整理未完成，已保留原文。\(error.localizedDescription)" }
            }
            guard operation == token else { return }
            saveManuscript(polished: polished)
            // Never insert a fallback draft after the requested processing failed.
            if let polishFailure {
                fail(polishFailure)
                if destination == nil { revealDraft() }
                return
            }
            if let destination {
                do {
                    try await destination.insert(draft)
                    guard operation == token else { return }
                    stage = .success
                    notice = "文字已写入\(destination.name)。"
                    updateDelivery(notice)
                    dismissOverlay(after: 1.5, token: token)
                } catch {
                    guard operation == token else { return }
                    let status = (error as? EngineError)?.writeAttempted == true ? "未确认写入：" : "未写入："
                    updateDelivery(status + error.localizedDescription)
                    fail(error.localizedDescription)
                }
            } else {
                stage = .idle
                overlay?.hide()
                revealDraft()
                notice = "已生成文稿，所有处理均在本机完成。"
            }
        } catch {
            guard operation == token else { return }
            fail(error.localizedDescription)
        }
    }

    private func polishText(_ text: String) async throws -> String {
        var instruction = "忠实保留原意与语气，仅删除无意义的填充和重复并规范标点。"
        if style == .message { instruction += "输出适合即时通讯的自然短句，不添加问候。" }
        if style == .document { instruction += "按语义分段，不增加标题或信息。" }
        let response = try await engine.request([
            "command": "polish", "text": text, "llm_model": llmModel,
            "instruction": instruction, "application": destinationName,
            "category": destination?.category ?? "general", "key_terms": library.lexicon.map(\.term),
            "before": destination?.before ?? "", "after": destination?.after ?? ""
        ], python: python)
        guard let text = response["text"] as? String, !text.isEmpty else { throw EngineError(message: "整理结果为空。") }
        return text
    }

    func retryPolish() {
        guard !stage.busy, !draft.isEmpty else { return }
        let token = UUID(); operation = token
        let input = draft
        stage = .polishing
        Task {
            do {
                let result = try await polishText(input)
                guard operation == token else { return }
                draft = result
                updateSelected(polished: true)
                stage = .idle
                notice = "文字已在本机整理完成，请核对正文。"
            } catch {
                guard operation == token else { return }
                stage = .idle; notice = error.localizedDescription
            }
        }
    }

    func cancel() {
        guard stage.busy else { overlay?.hide(); return }
        operation = UUID()
        timer?.invalidate(); timer = nil
        recorder.cancel()
        engine.stop()
        stage = .idle
        overlay?.hide()
        if !original.isEmpty {
            draft = original
            saveManuscript(polished: false)
            revealDraft()
            notice = "已停止整理，识别原文已保留。"
        } else { notice = "已取消，本次临时录音已删除。" }
    }

    private func fail(_ message: String) {
        stage = .failure
        notice = message
        overlay?.show()
        dismissOverlay(after: 3.5, token: operation)
    }

    private func dismissOverlay(after delay: Double, token: UUID) {
        Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard operation == token else { return }
            overlay?.hide()
            if !stage.busy { stage = .idle }
        }
    }

    func revealDraft() {
        page = .manuscripts
        showWindow()
    }

    func showWindow() {
        openMainWindow?()
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first(where: { $0.identifier?.rawValue == "main" || ($0.canBecomeMain && !($0 is NSPanel)) })?.makeKeyAndOrderFront(nil)
    }

    private func saveManuscript(polished: Bool) {
        let item = Manuscript(original: original, text: draft, seconds: seconds, application: destinationName, polished: polished)
        selectedID = item.id
        if keepHistory { library.manuscripts.insert(item, at: 0); save() }
    }

    func updateSelected(polished: Bool? = nil) {
        guard let index = library.manuscripts.firstIndex(where: { $0.id == selectedID }) else { return }
        library.manuscripts[index].text = draft
        if let polished { library.manuscripts[index].polished = polished }
        save()
    }

    private func updateDelivery(_ message: String) {
        guard let index = library.manuscripts.firstIndex(where: { $0.id == selectedID }) else { return }
        library.manuscripts[index].deliveryNote = message
        save()
    }

    var selectedDeliveryNote: String? { library.manuscripts.first { $0.id == selectedID }?.deliveryNote }

    func select(_ item: Manuscript) {
        guard !stage.busy else { return }
        selectedID = item.id; draft = item.text; original = item.original
    }

    func copyDraft() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(draft, forType: .string)
        notice = "正文已复制。"
    }

    func addTerm(_ term: String, hint: String) {
        let entry = LexiconEntry(term: term, hint: hint)
        guard !entry.term.isEmpty else { return }
        guard !library.lexicon.contains(where: { $0.term.localizedCaseInsensitiveCompare(entry.term) == .orderedSame }) else {
            notice = "词库中已有这个词。"; return
        }
        library.lexicon.append(entry); save()
    }

    func removeTerm(_ entry: LexiconEntry) { library.lexicon.removeAll { $0.id == entry.id }; save() }

    func deleteManuscript(_ id: UUID) {
        library.manuscripts.removeAll { $0.id == id }
        if selectedID == id { selectedID = nil; draft = ""; original = "" }
        save()
    }

    func exportDraft() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "言墨文稿.txt"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try draft.write(to: url, atomically: true, encoding: .utf8); notice = "文稿已导出。" }
        catch { notice = error.localizedDescription }
    }

    private func save() {
        guard saveAllowed else { return }
        do { try storage.write(library) }
        catch { notice = "本地保存失败：\(error.localizedDescription)" }
    }

    func openPrivacy(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }

    func terminate() {
        timer?.invalidate()
        recorder.cancel()
        engine.stop()
    }

    #if DEBUG
    /// Development check at the actual capture/insert seam; no audio or inference.
    func verifyTextEditInsertion() {
        guard !stage.busy, let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit").first else {
            notice = "请先打开文本编辑的空白测试文稿。"; return
        }
        stage = .preparing
        Task {
            defer { stage = .idle }
            guard let target = InputDestination.capture(readContext: false, in: app), target.element != nil else {
                notice = "写入自检：没有找到文本编辑的输入框。"
                return
            }
            do {
                try await target.insert("言墨写入验证：预算三千五百元，周五交付，不是周四。")
                notice = "写入自检通过：正文已写入文本编辑。"
            } catch { notice = "写入自检失败：\(error.localizedDescription)" }
        }
    }
    #endif
}
