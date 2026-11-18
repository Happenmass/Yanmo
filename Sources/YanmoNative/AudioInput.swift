import AppKit
import AVFoundation
import AudioToolbox
import CoreAudio

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
}

/// Per-process input selection; never changes the computer's default microphone.
public final class AudioRecorder: @unchecked Sendable {
    public init() {}
    @MainActor private var session: RecordingSession?
    @MainActor private var generation = UUID()
    @MainActor public var level: Double { session?.capture.level ?? 0 }

    @MainActor public func start(deviceUID: String = "") async throws {
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
        let capture = try WAVCapture(format: format)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            capture.append(buffer)
        }
        let session = RecordingSession(engine: engine, input: input, capture: capture)
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

    /// The legacy Swift app still supplies a path to its inference engine.
    @MainActor public func finish() -> URL? {
        guard let recording = try? finishWAV() else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yanmo-\(UUID().uuidString).wav")
        do {
            try recording.data.write(to: url, options: .atomic)
            return url
        } catch { return nil }
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
    private let bytesLimit = 160 * 1024 * 1024
    private var data: Data
    private var interleaved = [Float]()
    private var frames = 0
    private var failure: EngineError?
    private var closed = false
    private var power = 0.0

    init(format: AVAudioFormat) throws {
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
        data = Data(count: headerSize)
    }

    var level: Double { lock.withLock { power } }

    func append(_ buffer: AVAudioPCMBuffer) {
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
            var header = Data()
            func integer<T: FixedWidthInteger>(_ number: T) {
                var littleEndian = number.littleEndian
                withUnsafeBytes(of: &littleEndian) { header.append(contentsOf: $0) }
            }
            let block = UInt16(channels * MemoryLayout<Float>.size)
            header.append(contentsOf: "RIFF".utf8)
            integer(UInt32(data.count - 8))
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
            integer(UInt32(frames))
            header.append(contentsOf: "data".utf8)
            integer(UInt32(data.count - headerSize))
            data.replaceSubrange(0..<headerSize, with: header)
            return RecordedWAV(data: data, seconds: Double(frames) / Double(sampleRate))
        }
    }
}
