import AppKit
import SwiftUI

@MainActor
final class YanmoDelegate: NSObject, NSApplicationDelegate {
    private var overlay: OverlayController?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let model = AppModel.shared
        let overlay = OverlayController(model: model)
        self.overlay = overlay
        model.overlay = overlay
        NSApp.setActivationPolicy(model.showDock ? .regular : .accessory)
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in AppModel.shared.refreshPermissions() }
        }
        // Development-only visual inspection; never records, reads another app, or writes text.
        if ProcessInfo.processInfo.arguments.contains("--preview-overlay") { overlay.preview() }
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--import-audio"),
           ProcessInfo.processInfo.arguments.count > index + 1 {
            let path = ProcessInfo.processInfo.arguments[index + 1]
            Task {
                try? await Task.sleep(nanoseconds: 500_000_000)
                while model.checking { try? await Task.sleep(nanoseconds: 100_000_000) }
                model.importFile(URL(fileURLWithPath: path))
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        AppModel.shared.showWindow(); return true
    }
    func applicationWillTerminate(_ notification: Notification) { AppModel.shared.terminate() }
}

@main
struct YanmoApp: App {
    @NSApplicationDelegateAdaptor(YanmoDelegate.self) var delegate
    @StateObject private var model = AppModel.shared
    var body: some Scene {
        Window("言墨", id: "main") {
            ShellView(model: model)
        }.defaultSize(width: 1120, height: 800)
            .windowStyle(.hiddenTitleBar)
            .commands {
                CommandGroup(replacing: .appSettings) {
                    Button("设置…") { model.page = .settings; model.showWindow() }.keyboardShortcut(",")
                }
                CommandGroup(after: .newItem) {
                    Button("导入音频…") { model.importAudio() }.keyboardShortcut("o")
                    #if DEBUG
                    Button("验证文本编辑写入") { model.verifyTextEditInsertion() }
                    Button("验证麦克风采集（三秒）") { model.verifyMicrophoneCapture() }
                    #endif
                }
            }
        MenuBarExtra("言墨", systemImage: "waveform") {
            Button(model.stage == .recording ? "结束录音" : "开始录音（\(model.shortcutLabel)）") { model.toggleRecording() }.disabled(model.stage.busy && model.stage != .recording)
            if model.stage.busy { Button("取消") { model.cancel() } }
            Divider()
            Button("打开言墨") { model.showWindow() }
            Button("设置…") { model.page = .settings; model.showWindow() }
            Divider()
            Text("所有处理留在本机")
            Button("退出言墨") { NSApp.terminate(nil) }.keyboardShortcut("q")
        }
    }
}
