import Foundation

public struct VadSegment: Equatable, Sendable {
    public let startFrame: Int
    public let endFrame: Int
    public let speechMs: Int

    public init(startFrame: Int, endFrame: Int, speechMs: Int) {
        self.startFrame = startFrame
        self.endFrame = endFrame
        self.speechMs = speechMs
    }
}

/// Adaptive-noise-floor 20 ms frame VAD with Balanced-Tier pause thresholds,
/// asymmetric quiet-mic tracking, zero-drop contiguous splitting, and 24 s max window.
public final class AdaptiveVad {
    public static let minSpeechMs = 260
    public static let postPadMs = 320
    public static let shortUtteranceMs = 2_500
    public static let longUtteranceMs = 15_000
    public static let pauseShortMs = 1_200
    public static let pauseMediumMs = 800
    public static let pauseLongMs = 400
    public static let maxSegmentMs = 24_000

    private static let minNoiseFloor = 0.0004
    private static let maxNoiseFloor = 0.025
    private static let minEnterThreshold = 0.0025
    private static let minExitThreshold = 0.0016

    public let sampleRate: Int
    public private(set) var emittedCount = 0
    public var hasActiveSpeech: Bool { hasSpeech }

    private let postPadFrames: Int
    private let silentCapKeepFrames: Int
    private var noiseRms = 0.0015
    private var initialized = false
    private var inSpeech = false
    private var hasSpeech = false
    private var lastCutFrame = 0
    private var speechOnsetFrame = 0
    private var lastSpeechEndFrame = 0
    private var speechFramesMs = 0
    private var tailPeakRms = 0.0

    public init(sampleRate: Int) {
        let rate = max(1, sampleRate)
        self.sampleRate = rate
        self.postPadFrames = Int((Double(rate) * Double(Self.postPadMs) / 1000.0).rounded())
        self.silentCapKeepFrames = Int((Double(rate) * 0.5).rounded())
    }

    public func feed(frameRms: Double, frameStartSample: Int, frameEndSample: Int) -> VadSegment? {
        guard frameEndSample > frameStartSample else { return nil }
        let frameMs = framesToMs(frameEndSample - frameStartSample)

        if !initialized {
            initialized = true
            noiseRms = clampNoise(min(frameRms, 0.003))
        } else if frameRms < noiseRms {
            // Fast downward tracking snaps to room silence even when speech begins at t = 0.
            noiseRms = clampNoise(0.85 * noiseRms + 0.15 * frameRms)
        }

        let enterThreshold = max(Self.minEnterThreshold, noiseRms * 2.6)
        let exitThreshold = max(Self.minExitThreshold, noiseRms * 1.7)
        let isSpeech = inSpeech ? (frameRms >= exitThreshold) : (frameRms >= enterThreshold)
        if frameRms > tailPeakRms {
            tailPeakRms = frameRms
        }

        if isSpeech {
            if !hasSpeech {
                hasSpeech = true
                speechOnsetFrame = frameStartSample
                speechFramesMs = 0
            }
            inSpeech = true
            lastSpeechEndFrame = frameEndSample
            speechFramesMs += frameMs
        } else {
            inSpeech = false
            // Track floor upward slowly only on clear non-speech so soft speech never raises it.
            if frameRms < enterThreshold {
                noiseRms = clampNoise(0.995 * noiseRms + 0.005 * frameRms)
            }
            if hasSpeech {
                let silenceMs = framesToMs(frameEndSample - lastSpeechEndFrame)
                let utteranceMs = framesToMs(lastSpeechEndFrame - speechOnsetFrame)
                let pauseThreshold = pauseThresholdMs(forUtteranceMs: utteranceMs)
                if silenceMs >= pauseThreshold {
                    if speechFramesMs >= Self.minSpeechMs {
                        // Contiguous split inside the pause: never drops inter-segment audio.
                        let pad = min(postPadFrames, (frameEndSample - lastSpeechEndFrame) / 2)
                        let cut = min(frameEndSample, lastSpeechEndFrame + pad)
                        if cut > lastCutFrame {
                            let seg = emit(startFrame: lastCutFrame, endFrame: cut, speechMs: speechFramesMs)
                            resetSegment()
                            return seg
                        }
                    } else {
                        resetSegment()
                        return nil
                    }
                }
            }
        }

        if framesToMs(frameEndSample - lastCutFrame) >= Self.maxSegmentMs {
            if hasSpeech && speechFramesMs >= Self.minSpeechMs {
                let seg = emit(startFrame: lastCutFrame, endFrame: frameEndSample, speechMs: speechFramesMs)
                resetSegment()
                return seg
            } else if !hasSpeech && emittedCount == 0 {
                lastCutFrame = max(lastCutFrame, frameEndSample - silentCapKeepFrames)
                resetSegment()
            }
        }
        return nil
    }

    public func finish(totalFrames: Int) -> VadSegment? {
        guard totalFrames > 0 else { return nil }
        if emittedCount == 0 {
            let seg = emit(startFrame: 0, endFrame: totalFrames, speechMs: framesToMs(totalFrames))
            resetSegment()
            return seg
        }
        guard totalFrames > lastCutFrame else { return nil }
        let exitThreshold = max(Self.minExitThreshold, noiseRms * 1.7)
        if hasSpeech || tailPeakRms >= exitThreshold {
            let seg = emit(startFrame: lastCutFrame, endFrame: totalFrames, speechMs: max(speechFramesMs, 1))
            resetSegment()
            return seg
        }
        return nil
    }

    private func emit(startFrame: Int, endFrame: Int, speechMs: Int) -> VadSegment {
        emittedCount += 1
        lastCutFrame = endFrame
        tailPeakRms = 0.0
        return VadSegment(startFrame: startFrame, endFrame: endFrame, speechMs: speechMs)
    }

    private func resetSegment() {
        inSpeech = false
        hasSpeech = false
        speechOnsetFrame = lastCutFrame
        lastSpeechEndFrame = lastCutFrame
        speechFramesMs = 0
    }

    private func pauseThresholdMs(forUtteranceMs utteranceMs: Int) -> Int {
        if utteranceMs < Self.shortUtteranceMs { return Self.pauseShortMs }
        if utteranceMs < Self.longUtteranceMs { return Self.pauseMediumMs }
        return Self.pauseLongMs
    }

    private func framesToMs(_ frames: Int) -> Int {
        guard frames > 0 else { return 0 }
        return Int((Double(frames) * 1000.0 / Double(sampleRate)).rounded())
    }

    private func clampNoise(_ value: Double) -> Double {
        min(Self.maxNoiseFloor, max(Self.minNoiseFloor, value))
    }
}
