import SwiftUI
import YanmoCore

struct ShellView: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 210)
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(model.page.rawValue).font(Ink.serif(15))
                    Text("/").foregroundStyle(Ink.line)
                    Text(subtitle).font(.system(size: 12)).foregroundStyle(Ink.muted)
                    Spacer()
                    HStack(spacing: 6) {
                        Image(systemName: "lock").font(.system(size: 10))
                        Text("所有处理留在本机").font(.system(size: 10))
                    }.foregroundStyle(Ink.muted).padding(.horizontal, 9).padding(.vertical, 6)
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Ink.line, lineWidth: 0.6))
                }.padding(.horizontal, 35).padding(.top, 32).padding(.bottom, 15)
                Group {
                    switch model.page {
                    case .desk: DeskView(model: model)
                    case .manuscripts: ManuscriptsView(model: model)
                    case .dictionary: DictionaryView(model: model)
                    case .settings: PreferencesView(model: model)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                if !model.notice.isEmpty {
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: "info.circle").foregroundStyle(Ink.red)
                        Text(model.notice).font(.system(size: 11)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button { model.notice = "" } label: { Image(systemName: "xmark").font(.system(size: 10)) }.buttonStyle(.plain).accessibilityLabel("关闭提示")
                    }.padding(12).background(Ink.sidebar.opacity(0.7)).padding(.horizontal, 35).padding(.bottom, 8)
                }
                footer
            }.background(Paper())
        }.foregroundStyle(Ink.black)
            .frame(minWidth: 980, minHeight: 720)
            .preferredColorScheme(.light)
            .onAppear {
                model.openMainWindow = { openWindow(id: "main") }
                model.start()
            }
    }

    var subtitle: String {
        switch model.page { case .desk: return "使用概览"; case .manuscripts: return "每一次表达，都有迹可循"; case .dictionary: return "让熟悉的名字，准确落笔"; case .settings: return "本地模型与输入偏好" }
    }

    var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Seal()
                VStack(alignment: .leading, spacing: 2) {
                    Text("言墨").font(Ink.serif(26)).tracking(3)
                    Text("YANMO").font(.system(size: 9, weight: .medium)).tracking(4).foregroundStyle(Ink.muted)
                }
            }.padding(.top, 52).padding(.leading, 27)
            Text("语音输入").font(.system(size: 11)).foregroundStyle(Ink.muted).padding(.leading, 83).padding(.top, 9)
            VStack(spacing: 10) {
                ForEach(Page.allCases, id: \.self) { page in
                    Button { model.page = page } label: {
                        HStack(spacing: 17) {
                            Image(systemName: page.symbol).font(.system(size: 19, weight: .light)).frame(width: 26)
                            Text(page.rawValue).font(Ink.serif(18))
                            Spacer()
                        }.foregroundStyle(model.page == page ? Ink.red : Ink.black)
                            .padding(.horizontal, 21).frame(height: 47)
                            .background(model.page == page ? Ink.line.opacity(0.28) : .clear, in: RoundedRectangle(cornerRadius: 6))
                            .overlay(alignment: .leading) {
                                if model.page == page { UnevenRoundedRectangle(topLeadingRadius: 2, bottomLeadingRadius: 2).fill(Ink.red).frame(width: 3).padding(.vertical, 1) }
                            }
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 14).padding(.top, 32)
            Spacer()
            Rectangle().fill(Ink.line).frame(height: 0.5).padding(.horizontal, 27)
            HStack(spacing: 8) {
                Circle().fill(Ink.jade).frame(width: 7, height: 7)
                Text("本地运行").font(.system(size: 12))
            }.padding(.leading, 31).padding(.top, 19)
            Text("开源 · 私密 · 离线").font(.system(size: 10)).foregroundStyle(Ink.muted).padding(.leading, 46).padding(.top, 7).padding(.bottom, 29)
        }.frame(maxHeight: .infinity).background(Paper(color: Ink.sidebar))
    }

    var footer: some View {
        VStack(spacing: 12) {
            Rectangle().fill(Ink.line).frame(height: 0.5)
            HStack(spacing: 15) {
                ModelDot(ready: model.asrReady, text: "语音识别 · \(model.asrReady ? "本地就绪" : "待配置")")
                Rectangle().fill(Ink.line).frame(width: 0.5, height: 12)
                ModelDot(ready: model.llmReady, text: "文字整理 · \(model.llmReady ? "本地就绪" : "待配置")")
                Spacer()
                Button { model.page = .settings } label: {
                    HStack(spacing: 7) { Keycap(text: model.shortcutLabel); Text("语音输入").font(.system(size: 10)) }
                }.buttonStyle(.plain)
            }
        }.padding(.horizontal, 35).padding(.top, 8).padding(.bottom, 17)
    }
}

struct ManuscriptsView: View {
    @ObservedObject var model: AppModel
    @State private var search = ""
    @State private var deleteID: UUID?
    var items: [Manuscript] { model.library.manuscripts.filter { search.isEmpty || $0.text.localizedCaseInsensitiveContains(search) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("每一笔，都在这里。").font(Ink.serif(29))
                Spacer()
                Button { model.importAudio() } label: { Label("导入音频", systemImage: "square.and.arrow.up") }.buttonStyle(InkButton()).disabled(model.stage.busy)
            }
            HStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("搜索文稿", text: $search).textFieldStyle(.roundedBorder)
                    ScrollView {
                        LazyVStack(spacing: 6) {
                            ForEach(items) { item in
                                Button { model.select(item) } label: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(item.text).lineLimit(3).font(.system(size: 12)).lineSpacing(3).frame(maxWidth: .infinity, alignment: .leading)
                                        HStack {
                                            Text(item.date, format: .dateTime.month().day().hour().minute())
                                            Spacer()
                                            Text("\(item.text.count) 字")
                                        }.font(.system(size: 9)).foregroundStyle(Ink.muted)
                                    }.padding(12).background(model.selectedID == item.id ? Ink.sidebar : Color.white.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
                                }.buttonStyle(.plain).disabled(model.stage.busy)
                                    .contextMenu { Button("删除文稿", role: .destructive) { deleteID = item.id } }
                            }
                            if items.isEmpty { Text(search.isEmpty ? "暂无保存的文稿" : "没有找到匹配的文稿").font(.system(size: 12)).foregroundStyle(Ink.muted).padding(.top, 30) }
                        }
                    }
                }.frame(width: 220)
                Rectangle().fill(Ink.line).frame(width: 0.5)
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(model.selectedID == nil ? "当前文稿" : "文稿正文").font(Ink.serif(18))
                        Spacer()
                        Text("\(model.draft.count) 字").font(.system(size: 11)).foregroundStyle(Ink.muted)
                    }
                    if let note = model.selectedDeliveryNote {
                        Text(note).font(.system(size: 11)).foregroundStyle(note.hasPrefix("未") ? Ink.red : Ink.muted)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                    if model.draft.isEmpty {
                        VStack(spacing: 13) {
                            Image(systemName: "doc.text").font(.system(size: 35, weight: .ultraLight))
                            Text("把刚才的想法，写下来。").font(Ink.serif(18))
                        }.foregroundStyle(Ink.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        TextEditor(text: $model.draft).font(.system(size: 15)).lineSpacing(7)
                            .scrollContentBackground(.hidden).padding(13)
                            .background(.white.opacity(0.35), in: RoundedRectangle(cornerRadius: 6))
                            .disabled(model.stage.busy)
                            .onChange(of: model.draft) { model.updateSelected() }
                        DisclosureGroup("识别原文") { Text(model.original).font(.system(size: 12)).foregroundStyle(Ink.muted).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6) }
                            .font(.system(size: 11))
                        HStack(spacing: 9) {
                            Button { model.copyDraft() } label: { Label("复制正文", systemImage: "doc.on.doc") }.buttonStyle(InkButton(primary: true))
                            Button { model.retryPolish() } label: { Label(model.stage == .polishing ? "正在整理…" : "本地整理", systemImage: "wand.and.stars") }.buttonStyle(InkButton()).disabled(model.stage.busy)
                            Spacer()
                            Button { model.exportDraft() } label: { Image(systemName: "square.and.arrow.up") }.help("导出为文本").buttonStyle(.plain).disabled(model.stage.busy)
                        }
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.padding(.horizontal, 35).padding(.top, 12).padding(.bottom, 18)
            .confirmationDialog("删除这份文稿？此操作无法撤销。", isPresented: Binding(get: { deleteID != nil }, set: { if !$0 { deleteID = nil } })) {
                Button("删除文稿", role: .destructive) { if let id = deleteID { model.deleteManuscript(id) }; deleteID = nil }
                Button("取消", role: .cancel) { deleteID = nil }
            }
    }
}

struct DictionaryView: View {
    @ObservedObject var model: AppModel
    @State private var term = ""
    @State private var hint = ""
    @State private var search = ""
    @State private var aliases = ""
    @State private var editing: UUID?
    var body: some View {
        VStack(alignment: .leading, spacing: 23) {
            Text("名字，值得写对。").font(Ink.serif(31))
            Text("把常用的人名、产品名和专业词交给言墨，在本地整理时辅助校对。")
                .font(.system(size: 12)).foregroundStyle(Ink.muted)
            HStack(spacing: 12) {
                TextField("词语，例如：言墨", text: $term).textFieldStyle(.roundedBorder)
                TextField("备注（可选）", text: $hint).textFieldStyle(.roundedBorder)
                Button(editing == nil ? "加入词库" : "保存词条") {
                    if model.addTerm(term, hint: hint, aliases: aliases.components(separatedBy: CharacterSet(charactersIn: ",，、")), editing: editing) {
                        term = ""; hint = ""; aliases = ""; editing = nil
                    }
                }.buttonStyle(InkButton(primary: true)).disabled(term.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            HStack {
                TextField("常见误识别（可选，多个用逗号分隔）", text: $aliases).textFieldStyle(.roundedBorder)
                if editing != nil { Button("取消编辑") { term = ""; hint = ""; aliases = ""; editing = nil }.buttonStyle(.link) }
            }
            Rectangle().fill(Ink.line).frame(height: 0.5)
            HStack {
                Text("全部词语 · \(model.library.lexicon.count)").font(Ink.serif(17))
                Spacer()
                TextField("搜索词语", text: $search).textFieldStyle(.roundedBorder).frame(width: 180)
            }
            if model.library.lexicon.isEmpty {
                VStack(spacing: 13) {
                    Image(systemName: "book").font(.system(size: 37, weight: .ultraLight))
                    Text("从一个熟悉的名字开始。").font(Ink.serif(19))
                }.foregroundStyle(Ink.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        ForEach(model.library.lexicon.filter { search.isEmpty || $0.term.localizedCaseInsensitiveContains(search) }) { entry in
                            HStack {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(entry.term).font(Ink.serif(19))
                                    if !entry.hint.isEmpty { Text(entry.hint).font(.system(size: 11)).foregroundStyle(Ink.muted) }
                                    if let aliases = entry.aliases, !aliases.isEmpty { Text("纠正：" + aliases.joined(separator: "、")).font(.system(size: 10)).foregroundStyle(Ink.red).lineLimit(2) }
                                }
                                Spacer()
                                Button {
                                    editing = entry.id; term = entry.term; hint = entry.hint; aliases = (entry.aliases ?? []).joined(separator: "，")
                                } label: { Image(systemName: "pencil").font(.system(size: 11)) }.buttonStyle(.plain).accessibilityLabel("编辑\(entry.term)")
                                Button { model.removeTerm(entry) } label: { Image(systemName: "xmark").font(.system(size: 10)) }.buttonStyle(.plain).accessibilityLabel("移除\(entry.term)")
                            }.padding(16).background(.white.opacity(0.35), in: RoundedRectangle(cornerRadius: 7)).overlay(RoundedRectangle(cornerRadius: 7).stroke(Ink.line, lineWidth: 0.6))
                        }
                    }
                }
            }
            Text("词语与备注辅助消歧；你明确填写的常见误识别会按原文匹配纠正。识别原文始终保留。").font(.system(size: 11)).foregroundStyle(Ink.muted)
        }.padding(.horizontal, 35).padding(.top, 15).padding(.bottom, 20)
    }
}

struct PreferencesView: View {
    @ObservedObject var model: AppModel
    @State private var proposedRetention: HistoryRetention?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                Text("一方书案，随你心意。").font(Ink.serif(29))
                section("快捷键与翻译", symbol: "keyboard") {
                    ForEach(InputAction.allCases) { action in
                        shortcutEditor(action)
                        if action != .selectionTranslation { Rectangle().fill(Ink.line).frame(height: 0.5).padding(.vertical, 4) }
                    }
                    if !model.shortcutNotice.isEmpty { Text(model.shortcutNotice).font(.system(size: 11)).foregroundStyle(Ink.red) }
                    Text("支持单独左／右修饰键、Control＋Shift，或包含 Control／Command 的普通组合键。三种功能的快捷键不能重复。")
                        .font(.system(size: 11)).foregroundStyle(Ink.muted)
                }
                section("麦克风", symbol: "mic") {
                    HStack {
                        Picker("麦克风", selection: $model.microphone) {
                            Text("跟随系统").tag("")
                            ForEach(model.audioInputs) { Text($0.name).tag($0.id) }
                            if !model.microphone.isEmpty && !model.audioInputs.contains(where: { $0.id == model.microphone }) { Text("所选设备未连接").tag(model.microphone) }
                        }.font(.system(size: 12))
                        Button("刷新设备") { model.audioInputs = AudioInput.available() }.buttonStyle(.link)
                    }
                    HStack {
                        Text("录音状态仅在输入浮层显示。").font(.system(size: 11)).foregroundStyle(Ink.muted)
                        Spacer()
                        Button("预览输入浮层") { model.overlay?.preview() }.buttonStyle(.link)
                    }
                }
                section("权限", symbol: "hand.raised") {
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("跨应用输入").font(.system(size: 13, weight: .medium))
                            Text(model.fnReady ? "轻按开始，再按结束；Esc 取消。" : "辅助功能授权后启用 Fn；也可先用 ⌃⌥ Space。")
                                .font(.system(size: 11)).foregroundStyle(Ink.muted)
                        }
                        Spacer()
                        ModelDot(ready: model.fnReady, text: model.fnReady ? "已启用" : "待授权")
                        Button("打开权限设置") { model.openPrivacy("Privacy_Accessibility") }.buttonStyle(InkButton())
                    }
                    HStack {
                        Text("麦克风仅在开始录音时请求使用权限。").font(.system(size: 11)).foregroundStyle(Ink.muted)
                        Spacer()
                        Button("麦克风设置") { model.openPrivacy("Privacy_Microphone") }.buttonStyle(.link)
                        Button("重新检查权限") { model.refreshPermissions() }.buttonStyle(.link)
                    }
                }
                section("本地模型", symbol: "externaldrive") {
                    Text("模型从用户级缓存加载。运行期间不联网，也不会自动下载模型。").font(.system(size: 11)).foregroundStyle(Ink.muted)
                    Text("空闲 1 小时后自动释放模型内存；下次录音时后台加载。连续使用期间保持就绪。").font(.system(size: 11)).foregroundStyle(Ink.muted)
                    field("Python 解释器", text: $model.python)
                    field("语音识别模型", text: $model.asrModel)
                    field("文字整理模型", text: $model.llmModel)
                    HStack {
                        ModelDot(ready: model.asrReady, text: model.asrReady ? "ASR 缓存完整" : "ASR 待检查")
                        ModelDot(ready: model.llmReady, text: model.llmReady ? "LLM 缓存完整" : "LLM 待检查")
                        Spacer()
                        Button(model.checking ? "正在检查…" : "检查本地环境") { Task { await model.checkModels() } }.buttonStyle(InkButton()).disabled(model.checking || model.stage.busy)
                    }
                }
                section("文字与隐私", symbol: "text.alignleft") {
                    Toggle("识别后使用本地 LLM 整理", isOn: $model.polishEnabled).font(.system(size: 12))
                    Picker("整理风格", selection: $model.style) { ForEach(WritingStyle.allCases, id: \.self) { Text($0.rawValue).tag($0) } }.font(.system(size: 12)).frame(maxWidth: 360)
                    Toggle("读取光标前后各最多 300 字，辅助衔接与消歧", isOn: $model.readContext).font(.system(size: 12))
                    Toggle("在本机保存新文稿", isOn: $model.keepHistory).font(.system(size: 12))
                    Picker("文稿保留时间", selection: Binding(get: { model.retention }, set: { value in
                        if model.library.manuscripts.contains(where: { !value.includes($0.date) }) { proposedRetention = value }
                        else { model.setRetention(value) }
                    })) { ForEach(HistoryRetention.allCases, id: \.self) { Text($0.label).tag($0) } }.font(.system(size: 12)).frame(maxWidth: 360)
                    Text("录音处理结束后删除临时音频。关闭保存不删除已有文稿；已有内容可在文稿页逐条删除。词库和设置始终仅保存在本机。")
                        .font(.system(size: 11)).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
                }
                section("启动", symbol: "power") {
                    Toggle("登录时启动言墨", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) })).font(.system(size: 12))
                    Toggle("在 Dock 中显示言墨", isOn: $model.showDock).font(.system(size: 12))
                    Text("关闭主窗口后仍可从菜单栏使用言墨。").font(.system(size: 11)).foregroundStyle(Ink.muted)
                }
                Text("言墨 0.3.0  ·  MIT 开源  ·  为中文表达留一方清静之地")
                    .font(.system(size: 10)).foregroundStyle(Ink.muted).padding(.bottom, 15)
            }.padding(.horizontal, 35).padding(.top, 12)
        }.disabled(model.stage.busy)
            .onDisappear { if model.recordingShortcut { model.endShortcutCapture() } }
            .confirmationDialog("更改保留时间后，超期文稿将从本机永久删除。", isPresented: Binding(get: { proposedRetention != nil }, set: { if !$0 { proposedRetention = nil } })) {
                Button("更改并删除超期文稿", role: .destructive) { if let value = proposedRetention { model.setRetention(value) }; proposedRetention = nil }
                Button("取消", role: .cancel) { proposedRetention = nil }
            }
    }

    @ViewBuilder
    private func shortcutEditor(_ action: InputAction) -> some View {
        HStack {
            Text(action.label).font(.system(size: 13, weight: .medium))
            Spacer()
            if action == .voiceTranslation {
                Picker("译为", selection: $model.voiceTarget) { ForEach(TranslationLanguage.allCases) { Text($0.label).tag($0) } }.frame(width: 170)
            } else if action == .selectionTranslation {
                Picker("译为", selection: $model.selectionTarget) { ForEach(TranslationLanguage.allCases) { Text($0.label).tag($0) } }.frame(width: 170)
            }
        }
        Text(action == .dictation ? "轻按开始，再按结束；Esc 取消。" : action == .voiceTranslation ? "说完后翻译成目标语言，并粘贴到原输入框。" : "选中文字后按快捷键，在独立弹窗查看译文。")
            .font(.system(size: 11)).foregroundStyle(Ink.muted)
        ForEach(model.shortcuts(for: action)) { shortcut in
            HStack {
                Keycap(text: shortcut.label)
                Spacer()
                if shortcut.needsEventTap { ModelDot(ready: model.fnReady, text: model.fnReady ? "已启用" : "待授权") }
                Button("移除") { model.setShortcuts(model.shortcuts(for: action).filter { $0.id != shortcut.id }, for: action) }
                    .buttonStyle(.link).disabled((action == .dictation && model.shortcuts.count == 1) || model.recordingShortcut)
                    .accessibilityLabel("移除\(action.label)快捷键 \(shortcut.label)")
            }
        }
        if model.recordingShortcut && model.captureAction == action {
            HStack {
                Text("请按下一组快捷键，松开保存；Esc 取消…").font(.system(size: 12)).foregroundStyle(Ink.red)
                ShortcutRecorder(onCapture: { model.captureShortcut($0) }, onPreview: { model.shortcutNotice = $0 }).frame(width: 1, height: 1).accessibilityLabel("录制快捷键")
                Spacer()
                Button("取消录制") { model.endShortcutCapture() }.buttonStyle(.link)
            }.padding(12).background(Ink.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        } else {
            HStack {
                Button("添加快捷键") { model.beginShortcutCapture(for: action) }.buttonStyle(InkButton()).accessibilityLabel("添加\(action.label)快捷键")
                Spacer()
                Button("恢复默认") { model.setShortcuts(action.defaults, for: action) }.buttonStyle(.link).accessibilityLabel("恢复\(action.label)默认快捷键")
            }.disabled(model.recordingShortcut)
        }
    }

    func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 11)).foregroundStyle(Ink.muted)
            TextField("模型 ID 或完整本地路径", text: text).textFieldStyle(.roundedBorder).font(.system(size: 11, design: .monospaced))
        }
    }

    func section<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: symbol).font(Ink.serif(19))
            content()
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(.white.opacity(0.32), in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(Ink.line, lineWidth: 0.6))
    }
}
