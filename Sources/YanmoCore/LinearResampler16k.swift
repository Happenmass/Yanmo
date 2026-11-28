import Foundation

/// Stateful linear resampler from an arbitrary input sample rate to 16 kHz mono Float32 PCM.
public struct LinearResampler16k: Sendable {
    public let inputSampleRate: Double
    private let step: Double
    private var sourcePosition: Double = 0.0
    private var lastSample: Float = 0.0
    private var hasLastSample = false

    public init(inputSampleRate: Double) {
        let safeRate = max(1.0, inputSampleRate)
        self.inputSampleRate = safeRate
        self.step = safeRate / 16000.0
    }

    public mutating func reset() {
        sourcePosition = 0.0
        lastSample = 0.0
        hasLastSample = false
    }

    public mutating func process(_ input: [Float]) -> [Float] {
        input.withUnsafeBufferPointer { buf in
            guard let base = buf.baseAddress else { return [] }
            return process(base, count: buf.count, stride: 1)
        }
    }

    public mutating func process(_ input: UnsafePointer<Float>, count: Int, stride: Int = 1) -> [Float] {
        guard count > 0, stride >= 1 else { return [] }
        if abs(step - 1.0) < 1e-6 {
            var out = [Float](repeating: 0, count: count)
            for i in 0..<count {
                out[i] = input[i * stride]
            }
            lastSample = input[(count - 1) * stride]
            hasLastSample = true
            return out
        }

        var out: [Float] = []
        out.reserveCapacity(max(1, Int(Double(count) / step) + 4))
        var pos = sourcePosition
        while pos < Double(count) {
            let idx = Int(floor(pos))
            let s1Idx = idx + 1
            if s1Idx >= count {
                break
            }
            let frac = Float(pos - Double(idx))
            let s0: Float = idx < 0 ? (hasLastSample ? lastSample : input[0]) : input[idx * stride]
            let s1 = input[s1Idx * stride]
            out.append(s0 + (s1 - s0) * frac)
            pos += step
        }
        sourcePosition = pos - Double(count)
        lastSample = input[(count - 1) * stride]
        hasLastSample = true
        return out
    }
}
