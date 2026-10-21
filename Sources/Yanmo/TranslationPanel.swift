import AppKit
import SwiftUI
import YanmoCore

@MainActor
final class TranslationResult: ObservableObject {
    @Published var source = ""
    @Published var result = ""
    @Published var error = ""
    @Published var loading = false
    @Published var copied = false
    @Published var language: TranslationLanguage = .english
    func reset(language: TranslationLanguage) {
        source = ""; result = ""; error = ""; copied = false; loading = true; self.language = language
    }
    func copy() {
        guard !result.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(result, forType: .string)
        copied = true
    }
}

@MainActor
final class TranslationPanelController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private weak var model: AppModel?
    init(model: AppModel) {
        self.model = model
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 490), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "言墨 · 划词翻译"
        panel.identifier = NSUserInterfaceItemIdentifier("translation-result")
        panel.minSize = NSSize(width: 440, height: 360)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.contentView = NSHostingView(rootView: TranslationView(model: model, result: model.translation))
    }
    func show() {
        if !panel.isVisible {
            let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
            if let area = screen?.visibleFrame { panel.setFrameOrigin(NSPoint(x: area.midX - panel.frame.width / 2, y: area.midY - panel.frame.height / 2)) }
        }
        panel.orderFrontRegardless()
    }
    func windowWillClose(_ notification: Notification) { model?.closeTranslation() }
}

private struct TranslationView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var result: TranslationResult
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("划词翻译").font(Ink.serif(24))
                Spacer()
                Picker("译为", selection: $result.language) {
                    ForEach(TranslationLanguage.allCases) { Text($0.label).tag($0) }
                }.frame(width: 160).disabled(result.loading || model.stage.busy)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("原文").font(.system(size: 11)).foregroundStyle(Ink.muted)
                    Text(result.source.isEmpty ? "选中其他应用中的文字，再按划词翻译快捷键。" : result.source)
                        .font(.system(size: 13)).lineSpacing(4).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    Rectangle().fill(Ink.line).frame(height: 0.5)
                    Text("译文 · \(result.language.label)").font(.system(size: 11)).foregroundStyle(Ink.muted)
                    if result.loading { Text("正在本机翻译…").foregroundStyle(Ink.muted).font(.system(size: 13)) }
                    else if !result.error.isEmpty { Text(result.error).foregroundStyle(Ink.red).font(.system(size: 13)) }
                    else { Text(result.result).font(.system(size: 15)).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Text("本地翻译 · 不自动替换原文").font(.system(size: 10)).foregroundStyle(Ink.muted)
                Spacer()
                if result.loading { Button("取消") { model.cancel() }.buttonStyle(InkButton()) }
                else {
                    Button("重新翻译") { model.retrySelectionTranslation() }.buttonStyle(InkButton()).disabled(result.source.isEmpty || model.stage.busy)
                    Button(result.copied ? "已复制" : "复制译文") { result.copy() }.buttonStyle(InkButton(primary: true)).disabled(result.result.isEmpty)
                }
            }
        }.padding(24).background(Paper()).foregroundStyle(Ink.black).preferredColorScheme(.light)
            .onChange(of: result.language) { _, _ in
                // A changed target must never label the old-language result as new.
                result.result = ""; result.copied = false
                if !result.loading { model.retrySelectionTranslation() }
            }
    }
}
