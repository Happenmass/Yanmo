import SwiftUI

enum Ink {
    static let paper = Color(red: 0.966, green: 0.954, blue: 0.925)
    static let sidebar = Color(red: 0.940, green: 0.923, blue: 0.883)
    static let black = Color(red: 0.16, green: 0.17, blue: 0.15)
    static let muted = Color(red: 0.49, green: 0.48, blue: 0.44)
    static let line = Color(red: 0.84, green: 0.82, blue: 0.77)
    static let red = Color(red: 0.65, green: 0.26, blue: 0.20)
    static let jade = Color(red: 0.33, green: 0.52, blue: 0.37)
    static func serif(_ size: CGFloat) -> Font { .custom("Songti SC", size: size) }
}

struct Paper: View {
    var color = Ink.paper
    var body: some View {
        color.overlay {
            Canvas { context, size in
                // Deterministic, barely visible fibers; no image or remote asset.
                for i in 0..<900 {
                    let x = CGFloat((i * 73 + 19) % 997) / 997 * size.width
                    let y = CGFloat((i * 131 + 47) % 991) / 991 * size.height
                    context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 0.8, height: 0.8)), with: .color(Ink.black.opacity(0.035)))
                }
            }.allowsHitTesting(false)
        }
    }
}

struct Seal: View {
    var size: CGFloat = 42
    var body: some View {
        Text("言")
            .font(Ink.serif(size * 0.8)).foregroundStyle(Ink.paper)
            .frame(width: size, height: size)
            .background(Ink.red.gradient, in: RoundedRectangle(cornerRadius: size * 0.10))
            .overlay(RoundedRectangle(cornerRadius: size * 0.10).stroke(Ink.paper.opacity(0.15), lineWidth: 1).padding(2))
            .accessibilityHidden(true)
    }
}

struct Keycap: View {
    var text: String
    var body: some View {
        Text(text).font(.system(size: 11, weight: .medium, design: .rounded))
            .foregroundStyle(Ink.black)
            .padding(.horizontal, 7).padding(.vertical, 4)
            .background(.white.opacity(0.38), in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Ink.line, lineWidth: 0.7))
    }
}

struct InkButton: ButtonStyle {
    var primary = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 19).padding(.vertical, 11)
            .foregroundStyle(primary ? Ink.paper : Ink.black)
            .background(primary ? Ink.red : Color.white.opacity(0.35), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(primary ? Ink.red : Ink.line, lineWidth: 0.8))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct ModelDot: View {
    var ready: Bool
    var text: String
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(ready ? Ink.jade : Ink.muted.opacity(0.35)).frame(width: 7, height: 7)
            Text(text).font(.system(size: 11))
        }.foregroundStyle(Ink.muted)
    }
}

struct InkRing: View {
    var active: Bool
    var body: some View {
        ZStack {
            ForEach(0..<5) { index in
                Circle().trim(from: 0.02 + Double(index) * 0.025, to: 0.91 + Double(index) * 0.015)
                    .stroke(Ink.black.opacity(0.18 + Double(index) * 0.08), style: StrokeStyle(lineWidth: index == 2 ? 1.6 : 0.5, lineCap: .round))
                    .padding(CGFloat(index) * 1.1).rotationEffect(.degrees(Double(index) * 9 - 36))
            }
            Image(systemName: "mic").font(.system(size: 34, weight: .light)).foregroundStyle(Ink.red)
        }.frame(width: 106, height: 106)
            .scaleEffect(active ? 1.04 : 1)
            .animation(active ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : .default, value: active)
    }
}
