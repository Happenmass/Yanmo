import AppKit
import SwiftUI

final class VoicePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class OverlayController {
    private let panel: VoicePanel
    private let model: AppModel
    init(model: AppModel) {
        self.model = model
        panel = VoicePanel(contentRect: NSRect(x: 0, y: 0, width: 328, height: 100), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.title = "言墨语音输入"
        panel.identifier = NSUserInterfaceItemIdentifier("voice-overlay")
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: VoiceOverlay(model: model))
    }
    func show() {
        panel.contentView = NSHostingView(rootView: VoiceOverlay(model: model))
        present()
    }
    private func present() {
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main
        if let frame = screen?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: frame.midX - panel.frame.width / 2, y: frame.minY + 25))
        }
        panel.orderFrontRegardless()
    }
    func hide() { panel.orderOut(nil) }
    func preview() {
        panel.contentView = NSHostingView(rootView: VoiceOverlay(model: model, preview: true))
        present()
    }
}

struct VoiceOverlay: View {
    @ObservedObject var model: AppModel
    var preview = false
    private var stage: Stage { preview ? .recording : model.stage }
    var body: some View {
        HStack(spacing: 13) {
            if stage == .success {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 21)).foregroundStyle(Color(red: 0.63, green: 0.78, blue: 0.58))
                Text("文字已写入").font(.system(size: 14))
            } else if stage == .failure {
                Button { model.overlay?.hide(); model.showWindow() } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(Color(red: 0.85, green: 0.56, blue: 0.42))
                        Text(model.selectedDeliveryNote?.hasPrefix("未确认") == true ? "请检查输入框 · 查看文稿" : (model.draft.isEmpty ? "处理未完成，点此查看" : "正文已保留，点此查看")).font(.system(size: 12))
                    }
                }.buttonStyle(.plain)
            } else {
                circleButton("xmark", title: preview ? "关闭预览" : "取消语音输入", light: false) { if preview { model.overlay?.hide() } else { model.cancel() } }
                if stage == .recording {
                    Circle().fill(Color(red: 0.75, green: 0.32, blue: 0.24)).frame(width: 8, height: 8)
                    Waveform(level: preview ? 0.75 : model.level).frame(width: 82, height: 25).accessibilityLabel(preview ? "波形预览" : "麦克风音量")
                    Text(preview ? "预览" : model.timeLabel).font(.system(size: 11, design: .monospaced)).monospacedDigit().foregroundStyle(Ink.paper.opacity(0.85))
                    circleButton("checkmark", title: preview ? "关闭预览" : "结束录音并写入", light: true) { if preview { model.overlay?.hide() } else { model.finishRecording() } }
                } else {
                    Spacer(minLength: 0)
                    ProgressView().controlSize(.small).colorScheme(.dark).scaleEffect(0.8)
                    Text(stage.busy ? stage.label : "语音输入已就绪").font(.system(size: 13))
                    Spacer(minLength: 0)
                }
            }
        }.foregroundStyle(Ink.paper)
            .padding(.horizontal, 11).frame(width: 296, height: 56)
            .background(Ink.black, in: Capsule())
            .overlay(Capsule().stroke(Ink.paper.opacity(0.25), lineWidth: 1).padding(1))
            .shadow(color: .black.opacity(0.22), radius: 8, y: 4)
            .overlay(alignment: .top) {
                if !preview && stage.busy {
                    Text("输入到 · \(model.destinationName)").font(.system(size: 10)).foregroundStyle(Ink.black)
                        .padding(.horizontal, 8).padding(.vertical, 3).background(Ink.paper, in: Capsule())
                        .offset(y: -19)
                }
            }
            .frame(width: 328, height: 100)
    }

    func circleButton(_ icon: String, title: String, light: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 18, weight: .regular))
                .foregroundStyle(light ? Ink.black : Ink.paper)
                .frame(width: 36, height: 36)
                .background(light ? Ink.paper : .white.opacity(0.12), in: Circle())
        }.buttonStyle(.plain).accessibilityLabel(title).help(title)
    }
}

struct Waveform: View {
    var level: Double
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<13) { index in
                let envelope = 1 - abs(Double(index) - 6) / 7
                let wobble = 0.35 + abs(sin(Double(index) * 1.7 + level * 12)) * 0.65
                Capsule().fill(Ink.paper.opacity(0.75 + envelope * 0.25)).frame(width: 3, height: 3 + CGFloat(level * envelope * wobble) * 23)
            }
        }.animation(.easeOut(duration: 0.08), value: level)
    }
}
