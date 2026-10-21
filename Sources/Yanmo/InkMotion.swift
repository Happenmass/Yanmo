import SwiftUI

// Ink motion: things settle like ink on paper — they bleed in from soft to sharp,
// spread from a stroke, or diffuse like a drop in water. No bounce, no glow.
// Every effect degrades to a plain fade when Reduce Motion is on.

private struct InkBleed: ViewModifier {
    var amount: Double // 0 settled, 1 not yet on the paper
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.blur(radius: reduceMotion ? 0 : 7 * amount)
            .scaleEffect(reduceMotion ? 1 : 1 + 0.012 * amount)
            .opacity(1 - amount)
    }
}

extension AnyTransition {
    /// Arrives blurred and settles sharp; leaves with a quick fade so pages never smear together.
    static var inkBleed: AnyTransition {
        .asymmetric(insertion: .modifier(active: InkBleed(amount: 1), identity: InkBleed(amount: 0)),
                    removal: .opacity.animation(.easeOut(duration: 0.12)))
    }
}

private struct InkIn: ViewModifier {
    var delay: Double
    var duration: Double
    @State private var shown = false
    func body(content: Content) -> some View {
        content.modifier(InkBleed(amount: shown ? 0 : 1))
            .onAppear { withAnimation(.easeOut(duration: duration).delay(delay)) { shown = true } }
    }
}

/// Reveals text left to right behind a soft ink front, like a brush crossing the paper.
private struct BrushReveal: ViewModifier {
    var delay: Double
    @State private var progress = 0.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.mask(alignment: .leading) {
            GeometryReader { geometry in
                Rectangle().frame(width: (geometry.size.width + 40) * progress).blur(radius: 8).offset(x: -20)
            }
        }.onAppear {
            if reduceMotion { progress = 1 } else { withAnimation(.easeInOut(duration: 1.1).delay(delay)) { progress = 1 } }
        }
    }
}

extension View {
    func inkIn(delay: Double = 0, duration: Double = 0.55) -> some View { modifier(InkIn(delay: delay, duration: duration)) }
    func brushReveal(delay: Double = 0) -> some View { modifier(BrushReveal(delay: delay)) }
}

/// A drop of ink diffusing in water: the busy indicator for recognition, polishing and translation.
struct InkDrop: View {
    var color: Color
    var paused = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: paused || reduceMotion)) { timeline in
            Canvas { context, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let radius = min(size.width, size.height) / 2
                let time = timeline.date.timeIntervalSinceReferenceDate
                context.addFilter(.blur(radius: radius * 0.12))
                for ring in 0..<3 where !reduceMotion {
                    let phase = (time / 1.8 + Double(ring) / 3).truncatingRemainder(dividingBy: 1)
                    let r = radius * (0.3 + 0.7 * phase)
                    let disc = Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
                    context.fill(disc, with: .color(color.opacity(0.2 * (1 - phase) * (1 - phase))))
                    context.stroke(disc, with: .color(color.opacity(0.6 * (1 - phase))), lineWidth: 0.6 + radius * 0.16 * (1 - phase))
                }
                let core = radius * 0.3
                context.fill(Path(ellipseIn: CGRect(x: center.x - core, y: center.y - core, width: core * 2, height: core * 2)), with: .color(color.opacity(0.9)))
            }
        }.accessibilityHidden(true)
    }
}

/// A checkmark written as one brush stroke.
struct BrushCheck: View {
    var color: Color
    @State private var progress = 0.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        CheckStroke().trim(from: 0, to: progress)
            .stroke(color, style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
            .onAppear { if reduceMotion { progress = 1 } else { withAnimation(.easeOut(duration: 0.34)) { progress = 1 } } }
            .accessibilityHidden(true)
    }
    private struct CheckStroke: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX + rect.width * 0.12, y: rect.minY + rect.height * 0.55))
            path.addQuadCurve(to: CGPoint(x: rect.minX + rect.width * 0.4, y: rect.minY + rect.height * 0.82),
                              control: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.minY + rect.height * 0.64))
            path.addQuadCurve(to: CGPoint(x: rect.maxX - rect.width * 0.08, y: rect.minY + rect.height * 0.18),
                              control: CGPoint(x: rect.minX + rect.width * 0.58, y: rect.minY + rect.height * 0.4))
            return path
        }
    }
}

/// One horizontal brush stroke whose thickness follows recent microphone levels.
/// Silence leaves a thin, still hairline; ends taper like a lifted brush.
struct BrushStroke: Shape {
    var samples: InkSamples
    var animatableData: InkSamples {
        get { samples }
        set { samples = newValue }
    }
    func path(in rect: CGRect) -> Path {
        let values = samples.values
        guard values.count > 1 else { return Path() }
        let step = rect.width / CGFloat(values.count - 1)
        let points = values.indices.map { index -> (CGFloat, CGFloat) in
            let u = Double(index) / Double(values.count - 1)
            let taper = pow(sin(Double.pi * u), 0.4)
            let half = (0.7 + min(max(values[index], 0), 1) * rect.height * 0.46) * max(taper, 0.25)
            return (rect.minX + CGFloat(index) * step, CGFloat(half))
        }
        var path = Path()
        // Upper edge left → right, lower edge right → left, smoothed through midpoints.
        path.move(to: CGPoint(x: points[0].0, y: rect.midY - points[0].1))
        for index in 1..<points.count {
            let previous = points[index - 1], current = points[index]
            path.addQuadCurve(to: CGPoint(x: (previous.0 + current.0) / 2, y: rect.midY - (previous.1 + current.1) / 2),
                              control: CGPoint(x: previous.0, y: rect.midY - previous.1))
        }
        path.addLine(to: CGPoint(x: points.last!.0, y: rect.midY + points.last!.1))
        for index in stride(from: points.count - 2, through: 0, by: -1) {
            let previous = points[index + 1], current = points[index]
            path.addQuadCurve(to: CGPoint(x: (previous.0 + current.0) / 2, y: rect.midY + (previous.1 + current.1) / 2),
                              control: CGPoint(x: previous.0, y: rect.midY + previous.1))
        }
        path.closeSubpath()
        return path
    }
}

/// Lets the meter's fixed-length sample window interpolate between 60 ms ticks.
struct InkSamples: VectorArithmetic {
    var values: [Double]
    static var zero: InkSamples { InkSamples(values: []) }
    private static func combine(_ a: InkSamples, _ b: InkSamples, _ op: (Double, Double) -> Double) -> InkSamples {
        let count = max(a.values.count, b.values.count)
        return InkSamples(values: (0..<count).map { op($0 < a.values.count ? a.values[$0] : 0, $0 < b.values.count ? b.values[$0] : 0) })
    }
    static func + (a: InkSamples, b: InkSamples) -> InkSamples { combine(a, b, +) }
    static func - (a: InkSamples, b: InkSamples) -> InkSamples { combine(a, b, -) }
    mutating func scale(by rhs: Double) { values = values.map { $0 * rhs } }
    var magnitudeSquared: Double { values.reduce(0) { $0 + $1 * $1 } }
}

/// Distant mountains in light ink wash, generated (no image asset) and drawn once.
struct InkMountains: View {
    var body: some View {
        Canvas { context, size in
            let ridges: [(base: CGFloat, height: CGFloat, opacity: Double, seed: Double)] = [
                (0.58, 0.42, 0.05, 1.3), (0.72, 0.34, 0.075, 4.1), (0.86, 0.24, 0.10, 7.7)
            ]
            for ridge in ridges {
                var path = Path()
                path.move(to: CGPoint(x: 0, y: size.height))
                for x in stride(from: 0, through: size.width, by: 4) {
                    let u = Double(x / size.width)
                    // Folded sines give pointed peaks rather than rolling hills.
                    let swell = (1 - abs(sin(u * 4.3 + ridge.seed))) * 0.55 + (1 - abs(sin(u * 9.7 + ridge.seed * 2.3))) * 0.28 + sin(u * 29 + ridge.seed) * 0.05 - 0.35
                    // Mountains gather on the right and melt into the paper on the left (留白).
                    let rise = max(0, min(1, (u - 0.15) / 0.55)), peak = CGFloat(rise * rise * (3 - 2 * rise))
                    let top = size.height * (ridge.base - ridge.height * CGFloat(0.55 + swell))
                    let y = size.height + (top - size.height) * peak
                    path.addLine(to: CGPoint(x: x, y: y))
                }
                path.addLine(to: CGPoint(x: size.width, y: size.height))
                path.closeSubpath()
                var layer = context
                layer.addFilter(.blur(radius: 2.5))
                // Ink is densest along the ridge and dissolves into mist at the foot.
                layer.fill(path, with: .linearGradient(
                    Gradient(colors: [Ink.black.opacity(ridge.opacity), Ink.black.opacity(0)]),
                    startPoint: CGPoint(x: 0, y: size.height * (ridge.base - ridge.height)),
                    endPoint: CGPoint(x: 0, y: size.height * min(1, ridge.base + 0.12))))
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}
