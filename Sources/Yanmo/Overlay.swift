import AppKit
import SwiftUI

final class VoicePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class OverlayAppearance: ObservableObject {
    @Published var visible = false
    @Published var preview = false
}

@MainActor
final class OverlayController {
    private let panel: VoicePanel
    private let appearance = OverlayAppearance()
    private var revision = 0
    init(model: AppModel) {
        panel = VoicePanel(contentRect: NSRect(x: 0, y: 0, width: 220, height: 56), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.title = "言墨语音输入"
        panel.identifier = NSUserInterfaceItemIdentifier("voice-overlay")
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        // Keep one host alive: replacing it on every state change reset animations.
        panel.contentView = NSHostingView(rootView: VoiceOverlay(model: model, appearance: appearance))
    }
    func show() { present(preview: false) }
    private func present(preview: Bool) {
        revision += 1
        appearance.preview = preview
        if !panel.isVisible {
            let pointer = NSEvent.mouseLocation
            let screen = NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main
            if let frame = screen?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: frame.midX - panel.frame.width / 2, y: frame.minY + 20))
            }
        }
        panel.orderFrontRegardless()
        appearance.visible = true
    }
    func hide() {
        revision += 1
        let token = revision
        appearance.visible = false
        Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if revision == token { panel.orderOut(nil) }
        }
    }
    func preview() { present(preview: true) }
}

struct VoiceOverlay: View {
    @ObservedObject var model: AppModel
    @ObservedObject var appearance: OverlayAppearance
    private var preview: Bool { appearance.preview }
    private var stage: Stage { preview ? .recording : model.stage }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Content changes only bleed in when the kind of state changes, not on every busy sub-step.
    private var phase: Int { stage == .success ? 1 : stage == .failure ? 2 : stage == .recording ? 3 : 4 }
    var body: some View {
        HStack(spacing: 8) {
            if stage == .success {
                BrushCheck(color: Ink.paper).frame(width: 13, height: 13)
                Text("已写入").font(.system(size: 11))
            } else if stage == .failure {
                Button { model.overlay?.hide(); model.revealDraft() } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "exclamationmark.circle")
                        Text("未完成 · 查看文稿")
                    }.font(.system(size: 11))
                }.buttonStyle(.plain)
            } else {
                control("xmark", title: preview ? "关闭预览" : "取消语音输入", filled: false) {
                    if preview { model.overlay?.hide() } else { model.cancel() }
                }
                if stage == .recording {
                    MeterWaveform(meter: model.meter, preview: preview).frame(width: !preview && model.activeAction == .voiceTranslation ? 44 : 66, height: 16)
                    if !preview && model.activeAction == .voiceTranslation { Text("译").font(.system(size: 9)).frame(width: 14) }
                    Text(preview ? "预览" : model.timeLabel)
                        .font(.system(size: 9, design: .monospaced)).monospacedDigit()
                        .foregroundStyle(Ink.paper.opacity(0.65)).frame(width: 29)
                    control("checkmark", title: preview ? "关闭预览" : "结束录音并写入", filled: true) {
                        if preview { model.overlay?.hide() } else { model.finishRecording() }
                    }
                } else {
                    Text(stage == .translating ? "翻译中…" : stage == .polishing ? "整理中…" : stage == .transcribing ? "识别中…" : "准备中…")
                        .font(.system(size: 11)).frame(maxWidth: .infinity)
                        .contentTransition(.opacity).animation(.easeOut(duration: 0.2), value: stage)
                    // The hidden panel stays alive between inputs, so stop the clock while off screen.
                    InkDrop(color: Ink.paper, paused: !appearance.visible || !stage.busy).frame(width: 18, height: 18).padding(.trailing, 4)
                }
            }
        }.id(phase).transition(.inkBleed)
            .animation(.easeOut(duration: 0.28), value: phase)
            .foregroundStyle(Ink.paper)
            .padding(.horizontal, 8).frame(width: 200, height: 36)
            .background(Ink.black, in: Capsule())
            .overlay(Capsule().stroke(Ink.paper.opacity(0.15), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
            .help(preview ? "输入浮层预览" : "\(model.activeAction.label) · 输入到 \(model.destinationName)；Esc 取消")
            .accessibilityLabel(preview ? "输入浮层预览" : "输入到 \(model.destinationName)")
            .frame(width: 220, height: 56)
            // Appears as one brush stroke laid down left to right; leaves with a short fade.
            .mask(alignment: .leading) {
                Rectangle().frame(width: appearance.visible || reduceMotion ? 220 : 40).blur(radius: appearance.visible ? 0 : 8)
            }
            .opacity(appearance.visible ? 1 : 0)
            .animation(appearance.visible ? .easeOut(duration: 0.3) : .easeIn(duration: 0.14), value: appearance.visible)
    }

    private func control(_ icon: String, title: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 12, weight: .medium))
                .foregroundStyle(filled ? Ink.black : Ink.paper.opacity(0.8))
                .frame(width: 26, height: 26)
                .background(filled ? Ink.paper : .clear, in: Circle())
                .contentShape(Circle())
        }.buttonStyle(.plain).accessibilityLabel(title).help(title)
    }
}

/// The stroke's thickness is the recent microphone level. Silence stays still.
private struct MeterWaveform: View {
    @ObservedObject var meter: AudioMeter
    var preview: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var samples: [Double] {
        preview ? [0.05, 0.12, 0.24, 0.34, 0.22, 0.45, 0.6, 0.42, 0.25, 0.15, 0.28, 0.4, 0.3, 0.18, 0.1, 0.05, 0.03] : meter.samples
    }
    var body: some View {
        BrushStroke(samples: InkSamples(values: samples)).fill(Ink.paper.opacity(0.85))
            .animation(reduceMotion ? nil : .linear(duration: 0.06), value: samples)
            .accessibilityLabel("麦克风音量")
    }
}
