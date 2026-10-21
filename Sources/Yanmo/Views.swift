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
        switch model.page { case .desk: return "语音输入"; case .manuscripts: return "每一次表达，都有迹可循"; case .dictionary: return "让熟悉的名字，准确落笔"; case .settings: return "本地模型与输入偏好" }
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
                    HStack(spacing: 7) { Keycap(text: model.fnReady ? "Fn" : "⌃⌥ Space"); Text(model.fnReady ? "语音输入" : "Fn 待授权").font(.system(size: 10)) }
                }.buttonStyle(.plain)
            }
        }.padding(.horizontal, 35).padding(.top, 8).padding(.bottom, 17)
    }
}

struct DeskView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Text("言语之间，自有笔墨。").font(Ink.serif(36)).tracking(1).padding(.top, 12)
                Text("说出所想，余下的交给言墨。").font(Ink.serif(20)).foregroundStyle(Ink.muted).padding(.top, 9).padding(.bottom, 26)
                recordingCard
                HStack(spacing: 0) {
                    statistic("今日落笔", value: "\(model.todayCharacters)", unit: "字")
                    Rectangle().fill(Ink.line).frame(width: 0.5, height: 40)
                    statistic("累计口述", value: "\(model.totalMinutes)", unit: "分钟")
                    Rectangle().fill(Ink.line).frame(width: 0.5, height: 40)
                    statistic("常用词", value: "\(model.library.lexicon.count)", unit: "个")
                }.padding(.vertical, 19)
                Rectangle().fill(Ink.line).frame(height: 0.5)
                HStack {
                    Text("最近文稿").font(Ink.serif(19))
                    Spacer()
                    Button { model.page = .manuscripts } label: { Text("查看全部  →").font(.system(size: 11)) }.buttonStyle(.plain)
                }.padding(.top, 17)
                if model.library.manuscripts.isEmpty {
                    VStack(spacing: 9) {
                        Image(systemName: "doc.text").font(.system(size: 29, weight: .ultraLight)).foregroundStyle(Ink.muted.opacity(0.6))
                        Text("第一段文字，从开口开始。").font(Ink.serif(15)).foregroundStyle(Ink.muted)
                    }.frame(height: 78)
                } else {
                    ForEach(model.library.manuscripts.prefix(2)) { item in
                        Button { model.select(item); model.page = .manuscripts } label: {
                            HStack {
                                Text(item.text).font(.system(size: 12)).lineLimit(1)
                                Spacer()
                                Text(item.date, style: .time).font(.system(size: 10)).foregroundStyle(Ink.muted)
                            }.padding(.vertical, 12)
                        }.buttonStyle(.plain)
                    }
                }
            }.padding(.horizontal, 35)
        }.scrollIndicators(.hidden)
    }

    var recordingCard: some View {
        VStack(spacing: 0) {
            HStack { Text(model.stage.busy ? model.stage.label : "开始一段新的表达").font(.system(size: 12)); Spacer() }.padding(21)
            InkRing(active: model.stage == .recording).padding(.top, 0)
            HStack(spacing: 7) {
                if model.stage == .recording { Text("正在聆听 · \(model.timeLabel)").monospacedDigit() }
                else if model.stage.busy { Text(model.stage.label) }
                else { Text("按下"); Keycap(text: "Fn"); Text("，开始说话") }
            }.font(Ink.serif(18)).padding(.top, 16)
            Text(model.stage == .recording ? "再次按下 Fn 或点击完成，文字落在光标处" : "再次按下结束，文字落在光标处")
                .font(.system(size: 12)).foregroundStyle(Ink.muted).padding(.top, 8)
            if model.stage.busy {
                Text("输入到 · \(model.destinationName)").font(.system(size: 10)).foregroundStyle(Ink.red).padding(.top, 6)
            }
            HStack(spacing: 14) {
                if model.stage == .recording {
                    Button { model.finishRecording() } label: { Label("完成录音", systemImage: "checkmark") }.buttonStyle(InkButton(primary: true))
                } else if model.stage.busy {
                    Button { model.cancel() } label: { Label("取消处理", systemImage: "xmark") }.buttonStyle(InkButton())
                } else {
                    Button { model.toggleRecording() } label: { Label("开始录音", systemImage: "mic") }.buttonStyle(InkButton(primary: true)).disabled(model.checking)
                    Button { model.importAudio() } label: { Label("导入音频", systemImage: "square.and.arrow.up") }.buttonStyle(InkButton()).disabled(model.checking)
                }
            }.padding(.top, 23).padding(.bottom, 24)
        }.frame(maxWidth: .infinity)
            .background(Color.white.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Ink.line, lineWidth: 0.7))
    }

    func statistic(_ title: String, value: String, unit: String) -> some View {
        VStack(spacing: 4) {
            Text(title).font(.system(size: 11)).foregroundStyle(Ink.muted)
            HStack(alignment: .firstTextBaseline, spacing: 5) { Text(value).font(Ink.serif(27)); Text(unit).font(Ink.serif(15)) }
        }.frame(maxWidth: .infinity)
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
    var body: some View {
        VStack(alignment: .leading, spacing: 23) {
            Text("名字，值得写对。").font(Ink.serif(31))
            Text("把常用的人名、产品名和专业词交给言墨，在本地整理时辅助校对。")
                .font(.system(size: 12)).foregroundStyle(Ink.muted)
            HStack(spacing: 12) {
                TextField("词语，例如：言墨", text: $term).textFieldStyle(.roundedBorder)
                TextField("备注（可选）", text: $hint).textFieldStyle(.roundedBorder)
                Button("加入词库") { model.addTerm(term, hint: hint); term = ""; hint = "" }.buttonStyle(InkButton(primary: true)).disabled(term.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                                }
                                Spacer()
                                Button { model.removeTerm(entry) } label: { Image(systemName: "xmark").font(.system(size: 10)) }.buttonStyle(.plain).accessibilityLabel("移除\(entry.term)")
                            }.padding(16).background(.white.opacity(0.35), in: RoundedRectangle(cornerRadius: 7)).overlay(RoundedRectangle(cornerRadius: 7).stroke(Ink.line, lineWidth: 0.6))
                        }
                    }
                }
            }
            Text("词语是拼写参考，不会强制替换发音相似但无关的内容。").font(.system(size: 11)).foregroundStyle(Ink.muted)
        }.padding(.horizontal, 35).padding(.top, 15).padding(.bottom, 20)
    }
}

struct PreferencesView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                Text("一方书案，随你心意。").font(Ink.serif(29))
                section("输入与权限", symbol: "keyboard") {
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Fn 语音输入").font(.system(size: 13, weight: .medium))
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
                    HStack {
                        Text("可先预览输入浮层的外观，不使用麦克风。").font(.system(size: 11)).foregroundStyle(Ink.muted)
                        Spacer()
                        Button("预览输入浮层") { model.overlay?.preview() }.buttonStyle(.link)
                    }
                    Text("如果 Typeless 等应用也使用 Fn，请只保留一个应用响应此键。").font(.system(size: 11)).foregroundStyle(Ink.muted)
                }
                section("本地模型", symbol: "externaldrive") {
                    Text("模型从用户级缓存加载。运行期间不联网，也不会自动下载模型。").font(.system(size: 11)).foregroundStyle(Ink.muted)
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
                    Text("录音处理结束后删除临时音频。关闭保存不删除已有文稿；已有内容可在文稿页逐条删除。词库和设置始终仅保存在本机。")
                        .font(.system(size: 11)).foregroundStyle(Ink.muted).fixedSize(horizontal: false, vertical: true)
                }
                Text("言墨 0.1.0  ·  MIT 开源  ·  为中文表达留一方清静之地")
                    .font(.system(size: 10)).foregroundStyle(Ink.muted).padding(.bottom, 15)
            }.padding(.horizontal, 35).padding(.top, 12)
        }.disabled(model.stage.busy)
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
