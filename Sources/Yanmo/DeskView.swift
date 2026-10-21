import SwiftUI
import YanmoCore

/// The desk is a usage overview. Recording controls live only in the floating input bar.
struct DeskView: View {
    @ObservedObject var model: AppModel
    private var usage: UsageSummary { UsageSummary(model.library.manuscripts) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 9) {
                    Text("言语之间，自有笔墨。").font(Ink.serif(32)).tracking(1)
                    Text("让表达回到自然，让文字留有余地。").font(.system(size: 12)).foregroundStyle(Ink.muted)
                }.padding(.top, 12)
                HStack(alignment: .top, spacing: 28) {
                    VStack(alignment: .leading, spacing: 22) {
                        Text("表达概览").font(Ink.serif(20))
                        LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 22) {
                            statistic("累计落笔", value: usage.characters.formatted(), unit: "字")
                            statistic("音频时长", value: duration, unit: durationUnit)
                            statistic("平均口述速度", value: usage.charactersPerMinute == 0 ? "—" : "\(usage.charactersPerMinute)", unit: "字 / 分钟")
                            statistic("活跃天数", value: "\(usage.activeDays)", unit: "天")
                        }
                        Rectangle().fill(Ink.line).frame(height: 0.5)
                        ActivityCalendar(days: usage.dailyCharacters)
                        Text("按本机保留的文稿统计，包含导入音频。").font(.system(size: 10)).foregroundStyle(Ink.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Rectangle().fill(Ink.line).frame(width: 0.5)
                    VStack(alignment: .leading, spacing: 16) {
                        Text("随处落笔").font(Ink.serif(20))
                        Text("在任意输入框按下快捷键，\n说完后再按一次。").font(.system(size: 12)).lineSpacing(5).foregroundStyle(Ink.muted)
                        ForEach(model.shortcuts) { shortcut in
                            Keycap(text: shortcut.label)
                        }
                        ForEach([InputAction.voiceTranslation, .selectionTranslation]) { action in
                            Text(action.label).font(.system(size: 11)).foregroundStyle(Ink.muted)
                            ForEach(model.shortcuts(for: action)) { Keycap(text: $0.label) }
                        }
                        Text("Esc 取消本次输入").font(.system(size: 11)).foregroundStyle(Ink.muted)
                        Button("自定义快捷键 →") { model.page = .settings }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Ink.red)
                        Rectangle().fill(Ink.line).frame(height: 0.5).padding(.vertical, 4)
                        Button { model.importAudio() } label: { Label("导入音频", systemImage: "square.and.arrow.down") }
                            .buttonStyle(.plain).font(.system(size: 12)).disabled(model.stage.busy || model.checking)
                        Text("已有录音，也可在本机整理。").font(.system(size: 10)).foregroundStyle(Ink.muted)
                    }.frame(width: 178, alignment: .leading)
                }.fixedSize(horizontal: false, vertical: true)
                Rectangle().fill(Ink.line).frame(height: 0.5)
                recentManuscripts
            }.padding(.horizontal, 35).padding(.bottom, 20)
        }.scrollIndicators(.hidden)
    }

    private var duration: String {
        usage.audioSeconds < 60 ? "\(Int(usage.audioSeconds))" : "\(Int(usage.audioSeconds / 60))"
    }
    private var durationUnit: String { usage.audioSeconds < 60 ? "秒" : "分钟" }
    private func statistic(_ title: String, value: String, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(value).font(Ink.serif(32)).monospacedDigit()
                Text(unit).font(.system(size: 10)).foregroundStyle(Ink.muted)
            }
            Text(title).font(.system(size: 11)).foregroundStyle(Ink.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var recentManuscripts: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack {
                Text("最近文稿").font(Ink.serif(20))
                Spacer()
                Button("查看全部 →") { model.page = .manuscripts }.font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(Ink.muted)
            }
            if model.library.manuscripts.isEmpty {
                Text("第一段文字，从开口开始。").font(Ink.serif(16)).foregroundStyle(Ink.muted).padding(.vertical, 16)
            } else {
                ForEach(model.library.manuscripts.prefix(3)) { item in
                    Button { model.select(item); model.page = .manuscripts } label: {
                        HStack(spacing: 16) {
                            Text(item.text).font(.system(size: 12)).lineLimit(1)
                            Spacer(minLength: 0)
                            Text(item.date, format: .dateTime.month().day().hour().minute()).font(.system(size: 10)).foregroundStyle(Ink.muted)
                        }.padding(.vertical, 5).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(model.stage.busy)
                }
            }
        }
    }
}

private struct ActivityCalendar: View {
    let days: [Date: Int]
    private let calendar = Calendar.current
    private var today: Date { calendar.startOfDay(for: Date()) }
    private var start: Date {
        let weekday = calendar.component(.weekday, from: today)
        return calendar.date(byAdding: .day, value: -((weekday + 5) % 7) - 19 * 7, to: today)!
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("落笔日历").font(Ink.serif(17))
                Spacer()
                Text("近 20 周").font(.system(size: 10)).foregroundStyle(Ink.muted)
            }
            HStack(alignment: .top, spacing: 5) {
                VStack(spacing: 4) {
                    ForEach(0..<7) { row in
                        Text(["一", "", "三", "", "五", "", "日"][row]).font(.system(size: 8)).foregroundStyle(Ink.muted).frame(height: 12)
                    }
                }.frame(width: 12)
                ForEach(0..<20) { week in
                    VStack(spacing: 4) {
                        ForEach(0..<7) { row in
                            let date = calendar.date(byAdding: .day, value: week * 7 + row, to: start)!
                            let count = days[date, default: 0]
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Ink.black.opacity(date > today ? 0.025 : opacity(count)))
                                .frame(height: 12)
                                .help("\(date.formatted(date: .abbreviated, time: .omitted)) · \(count) 字")
                                .accessibilityLabel("\(date.formatted(date: .abbreviated, time: .omitted))，\(count) 字")
                        }
                    }
                }
            }
            HStack(spacing: 4) {
                Spacer()
                Text("少").font(.system(size: 8)).foregroundStyle(Ink.muted)
                ForEach([0.06, 0.2, 0.4, 0.65], id: \.self) { opacity in
                    RoundedRectangle(cornerRadius: 2).fill(Ink.black.opacity(opacity)).frame(width: 8, height: 8)
                }
                Text("多").font(.system(size: 8)).foregroundStyle(Ink.muted)
            }
        }
    }
    private func opacity(_ count: Int) -> Double {
        count == 0 ? 0.06 : count < 100 ? 0.2 : count < 500 ? 0.4 : 0.65
    }
}
