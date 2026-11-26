import AppKit
import AVFoundation
import AudioToolbox
import CoreAudio
import YanmoCore

public struct AudioInput: Identifiable {
    public var id: String
    public var deviceID: AudioDeviceID
    public var name: String

    public static func available() -> [AudioInput] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else { return [] }
        return devices.compactMap { device in
            var input = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
            var streams: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(device, &input, 0, nil, &streams) == noErr, streams > 0 else { return nil }
            func string(_ selector: AudioObjectPropertySelector) -> String? {
                var property = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
                var value: Unmanaged<CFString>?
                var length = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
                guard AudioObjectGetPropertyData(device, &property, 0, nil, &length, &value) == noErr else { return nil }
                return value?.takeUnretainedValue() as String?
            }
            guard let uid = string(kAudioDevicePropertyDeviceUID), let name = string(kAudioObjectPropertyName) else { return nil }
            return AudioInput(id: uid, deviceID: device, name: name)
        }
    }
}

/// Float32 PCM at the input's sample rate and channel count.
public struct RecordedWAV: Sendable {
    public let data: Data
    public let seconds: Double
    public let emittedSegments: Int
    public let tailData: Data?

    public init(data: Data, seconds: Double, emittedSegments: Int = 0, tailData: Data? = nil) {
        self.data = data
        self.seconds = seconds
        self.emittedSegments = emittedSegments
        self.tailData = tailData
    }
}

/// Per-process input selection; never changes the computer's default microphone.
public final class AudioRecorder: @unchecked Sendable {
    public init() {}
    @MainActor private var session: RecordingSession?
    @MainActor private var generation = UUID()
    @MainActor public var level: Double { session?.capture.level ?? 0 }

    @MainActor public func start(deviceUID: String = "", onSegment: (@Sendable (Data, Int) -> Void)? = nil) async throws {
        cancel()
        let ticket = generation
        let allowed = await AVCaptureDevice.requestAccess(for: .audio)
        guard generation == ticket, !Task.isCancelled else { throw EngineError(message: "录音已取消。") }
        guard allowed else { throw EngineError(message: "请在系统设置中允许言墨使用麦克风，或先导入音频体验。") }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        if !deviceUID.isEmpty {
            guard let selected = AudioInput.available().first(where: { $0.id == deviceUID }), let unit = input.audioUnit else {
                throw EngineError(message: "所选麦克风未连接，请在设置中重新选择。")
            }
            var deviceID = selected.deviceID
            let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                              &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size))
            guard status == noErr else {
                throw EngineError(message: "无法使用所选麦克风（\(status)），请检查设备或选择跟随系统。")
            }
        }
        // Capture through an input tap only. An input-only device does not need
        // a mixer or output node, and the microphone never routes to speakers.
        let format = input.outputFormat(forBus: 0)
        let capture = try WAVCapture(format: format, onSegment: onSegment)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            capture.append(buffer)
        }
        let session = RecordingSession(engine: engine, input: input, capture: capture)
        let deviceAtStart = session.currentDeviceID
        self.session = session
        do {
            engine.prepare()
            try engine.start()
        } catch {
            cancel()
            throw error
        }
        session.configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
                object: engine, queue: nil) { [weak self] _ in
            // Return to AVAudioEngine before stopping its graph.
            Task { @MainActor in
                guard let self, self.generation == ticket, let session = self.session else { return }
                // Selecting an input can deliver a queued configuration notification
                // after start, even while that same input is still recording.
                if session.isRunning, let deviceAtStart, session.currentDeviceID == deviceAtStart,
                   session.inputFormat == format { return }
                session.capture.fail("录音设备已断开或更改，请重新录音。")
                session.stop()
            }
        }
    }

    @MainActor public func finishWAV() throws -> RecordedWAV {
        generation = UUID()
        guard let session else { throw EngineError(message: "录音没有生成，请重试。") }
        self.session = nil
        if !session.isRunning {
            session.capture.fail("录音设备已断开或更改，请重新录音。")
        }
        session.stop()
        return try session.capture.finish()
    }

    @MainActor public func cancel() {
        generation = UUID()
        session?.stop()
        session = nil
    }
}

private final class RecordingSession {
    private var engine: AVAudioEngine?
    private let input: AVAudioInputNode
    let capture: WAVCapture
    var configurationObserver: NSObjectProtocol?

    init(engine: AVAudioEngine, input: AVAudioInputNode, capture: WAVCapture) {
        self.engine = engine
        self.input = input
        self.capture = capture
    }

    var isRunning: Bool { engine?.isRunning == true }

    var inputFormat: AVAudioFormat { input.outputFormat(forBus: 0) }

    var currentDeviceID: AudioDeviceID? {
        guard let unit = input.audioUnit else { return nil }
        var id = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout.size(ofValue: id))
        let status = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global, 0, &id, &size)
        return status == noErr && id != kAudioObjectUnknown ? id : nil
    }

    func stop() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if let engine {
            engine.stop()
            input.removeTap(onBus: 0)
            self.engine = nil
        }
    }

    deinit { stop() }
}

/// The audio tap and the main thread share this buffer. The final header is
/// filled in place so the WAV can leave the recorder without another PCM copy.
final class WAVCapture: @unchecked Sendable {
    private let lock = NSLock()
    private let sampleRate: UInt32
    private let channels: Int
    private let headerSize: Int
    private let framesLimit: Int
    private let bytesLimit = 120 * 1024 * 1024
    private let vad: AdaptiveVad
    private let onSegment: (@Sendable (Data, Int) -> Void)?
    private let segmentFrameSamples: Int
    private var vadAccumSq = 0.0
    private var vadAccumCount = 0
    private var vadFrameStartSample = 0
    private var segmentIndex = 0
    private var data: Data
    private var interleaved = [Float]()
    private var frames = 0
    private var failure: EngineError?
    private var closed = false
    private var power = 0.0

    init(format: AVAudioFormat, onSegment: (@Sendable (Data, Int) -> Void)? = nil) throws {
        let sampleRate = format.sampleRate.rounded()
        let channels = Int(format.channelCount)
        guard sampleRate.isFinite, sampleRate >= 1, sampleRate <= Double(UInt32.max),
              channels > 0, channels <= Int(UInt16.max) / MemoryLayout<Float>.size,
              sampleRate * Double(channels * MemoryLayout<Float>.size) <= Double(UInt32.max),
              format.commonFormat == .pcmFormatFloat32 else {
            throw EngineError(message: "麦克风没有可用的音频通道或采样格式。")
        }
        self.sampleRate = UInt32(sampleRate.rounded())
        self.channels = channels
        headerSize = channels > 2 ? 80 : 58
        framesLimit = 300 * Int(self.sampleRate)
        self.vad = AdaptiveVad(sampleRate: Int(self.sampleRate))
        self.onSegment = onSegment
        self.segmentFrameSamples = max(1, Int((Double(self.sampleRate) * 0.02).rounded()))
        data = Data(count: headerSize)
    }

    var level: Double { lock.withLock { power } }

    func append(_ buffer: AVAudioPCMBuffer) {
        var pendingSegments: [(Data, Int)] = []
        lock.withLock {
            guard failure == nil, !closed, frames < framesLimit, buffer.frameLength > 0 else { return }
            guard Int(buffer.format.channelCount) == channels, buffer.format.sampleRate.rounded() == Double(sampleRate),
                  let samples = buffer.floatChannelData else {
                failure = EngineError(message: "录音设备的音频格式已更改，请重新录音。")
                return
            }
            let count = min(Int(buffer.frameLength), framesLimit - frames)
            let sampleCount = count * channels
            let byteCount = sampleCount * MemoryLayout<Float>.size
            guard byteCount <= bytesLimit - data.count else {
                failure = EngineError(message: "音频过大，请分段录音。")
                return
            }
            if channels == 1 || buffer.format.isInterleaved {
                data.append(UnsafeRawBufferPointer(start: samples[0], count: byteCount).bindMemory(to: UInt8.self))
            } else {
                if interleaved.count < sampleCount {
                    interleaved = [Float](repeating: 0, count: sampleCount)
                }
                for channel in 0..<channels {
                    let source = samples[channel]
                    for frame in 0..<count { interleaved[frame * channels + channel] = source[frame] }
                }
                interleaved.withUnsafeBytes { bytes in
                    data.append(bytes.prefix(byteCount).bindMemory(to: UInt8.self))
                }
            }
            frames += count
            let stride = buffer.format.isInterleaved ? channels : 1
            let first = samples[0]
            let square = (0..<count).reduce(0.0) { sum, frame in
                let sample = first[frame * stride]
                return sum + Double(sample * sample)
            }
            power = min(1, pow(sqrt(square / Double(count)), 0.65) * 2)

            if onSegment != nil {
                for frame in 0..<count {
                    let sample = Double(first[frame * stride])
                    vadAccumSq += sample * sample
                    vadAccumCount += 1
                    if vadAccumCount >= segmentFrameSamples {
                        let rms = sqrt(vadAccumSq / Double(segmentFrameSamples))
                        let endSample = vadFrameStartSample + segmentFrameSamples
                        if let seg = vad.feed(frameRms: rms, frameStartSample: vadFrameStartSample, frameEndSample: endSample),
                           let segWav = sliceWAV(startFrame: seg.startFrame, endFrame: seg.endFrame) {
                            let idx = segmentIndex
                            segmentIndex += 1
                            pendingSegments.append((segWav, idx))
                        }
                        vadFrameStartSample = endSample
                        vadAccumSq = 0
                        vadAccumCount = 0
                    }
                }
            }
        }
        if let onSegment, !pendingSegments.isEmpty {
            for (wav, idx) in pendingSegments {
                onSegment(wav, idx)
            }
        }
    }

    func fail(_ message: String) {
        lock.withLock { failure = EngineError(message: message); power = 0 }
    }

    func finish() throws -> RecordedWAV {
        try lock.withLock {
            guard !closed else { throw EngineError(message: "录音已经结束。") }
            closed = true
            defer { data = Data() }
            if let failure { throw failure }
            guard frames > 0 else { throw EngineError(message: "录音没有生成，请重试。") }
            let emitted = vad.emittedCount
            var tailData: Data?
            if onSegment != nil && emitted > 0, let tail = vad.finish(totalFrames: frames) {
                tailData = sliceWAV(startFrame: tail.startFrame, endFrame: tail.endFrame)
            }
            let header = makeHeader(frameCount: frames, pcmByteCount: data.count - headerSize)
            data.replaceSubrange(0..<headerSize, with: header)
            return RecordedWAV(
                data: data,
                seconds: Double(frames) / Double(sampleRate),
                emittedSegments: emitted,
                tailData: tailData
            )
        }
    }

    private func sliceWAV(startFrame: Int, endFrame: Int) -> Data? {
        let clampedStart = max(0, min(frames, startFrame))
        let clampedEnd = max(clampedStart, min(frames, endFrame))
        let frameCount = clampedEnd - clampedStart
        guard frameCount > 0 else { return nil }
        let frameBytes = channels * MemoryLayout<Float>.size
        let startByte = headerSize + clampedStart * frameBytes
        let endByte = headerSize + clampedEnd * frameBytes
        guard endByte <= data.count, endByte > startByte else { return nil }
        var wav = makeHeader(frameCount: frameCount, pcmByteCount: endByte - startByte)
        wav.append(data.subdata(in: startByte..<endByte))
        return wav
    }

    private func makeHeader(frameCount: Int, pcmByteCount: Int) -> Data {
        var header = Data()
        func integer<T: FixedWidthInteger>(_ number: T) {
            var littleEndian = number.littleEndian
            withUnsafeBytes(of: &littleEndian) { header.append(contentsOf: $0) }
        }
        let block = UInt16(channels * MemoryLayout<Float>.size)
        header.append(contentsOf: "RIFF".utf8)
        integer(UInt32(headerSize + pcmByteCount - 8))
        header.append(contentsOf: "WAVEfmt ".utf8)
        integer(UInt32(channels > 2 ? 40 : 18))
        integer(UInt16(channels > 2 ? 0xfffe : 3))
        integer(UInt16(channels))
        integer(sampleRate)
        integer(sampleRate * UInt32(block))
        integer(block)
        integer(UInt16(32))
        if channels > 2 {
            integer(UInt16(22))
            integer(UInt16(32))
            integer(UInt32(0)) // The input may not have a speaker-position channel mask.
            header.append(contentsOf: [3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113])
        } else {
            integer(UInt16(0))
        }
        header.append(contentsOf: "fact".utf8)
        integer(UInt32(4))
        integer(UInt32(frameCount))
        header.append(contentsOf: "data".utf8)
        integer(UInt32(pcmByteCount))
        return header
    }
}

public enum AudioArchiver {
    /// Normalize any AVAudioFile-readable audio into 16 kHz mono 16-bit FLAC for persistent history.
    public static func encodeFLAC(from inputURL: URL) throws -> Data {
        let input = try AVAudioFile(forReading: inputURL)
        guard input.length > 0 else {
            throw EngineError(message: "录音没有音频帧。")
        }
        guard let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: input.processingFormat, to: pcmFormat) else {
            throw EngineError(message: "音频压缩初始化失败。")
        }
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("yanmo-archive-\(UUID().uuidString).flac")
        defer { try? FileManager.default.removeItem(at: outputURL) }

        let flacSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatFLAC,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
        ]

        var totalFramesWritten: AVAudioFrameCount = 0
        do {
            // Scope AVAudioFile so it deallocates and flushes the FLAC STREAMINFO header before reading.
            let output = try AVAudioFile(forWriting: outputURL, settings: flacSettings)
            let chunkFrames: AVAudioFrameCount = 32768
            guard let readBuffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: chunkFrames),
                  let convertBuffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: chunkFrames) else {
                throw EngineError(message: "音频压缩缓冲区分配失败。")
            }
            var eof = false
            while true {
                convertBuffer.frameLength = 0
                var conversionError: NSError?
                var readFailure: Error?
                let status = converter.convert(to: convertBuffer, error: &conversionError) { requestedFrames, outStatus in
                    if eof || input.framePosition >= input.length {
                        eof = true
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                    let remaining = AVAudioFrameCount(max(0, input.length - input.framePosition))
                    let toRead = min(readBuffer.frameCapacity, min(requestedFrames, remaining))
                    if toRead == 0 {
                        eof = true
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                    do {
                        readBuffer.frameLength = 0
                        try input.read(into: readBuffer, frameCount: toRead)
                    } catch {
                        readFailure = error
                        eof = true
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                    if readBuffer.frameLength == 0 {
                        eof = true
                        outStatus.pointee = .endOfStream
                        return nil
                    }
                    outStatus.pointee = .haveData
                    return readBuffer
                }
                if let readFailure { throw readFailure }
                if status == .error, let conversionError { throw conversionError }
                if convertBuffer.frameLength > 0 {
                    try output.write(from: convertBuffer)
                    totalFramesWritten += convertBuffer.frameLength
                }
                if status == .endOfStream || (eof && convertBuffer.frameLength == 0) {
                    break
                }
            }
        }
        guard totalFramesWritten > 0 else {
            throw EngineError(message: "音频压缩未产生音频帧。")
        }
        return try Data(contentsOf: outputURL)
    }
}
