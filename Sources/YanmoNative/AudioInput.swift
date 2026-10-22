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

/// Per-process input selection; never changes the computer's default microphone.
public final class AudioRecorder: @unchecked Sendable {
    public init() {}
    private var engine: AVAudioEngine?
    private var url: URL?
    private let lock = NSLock()
    private var power = 0.0
    private var writeError: Error?
    public var level: Double { lock.lock(); defer { lock.unlock() }; return power }

    public func start(deviceUID: String = "") async throws {
        let allowed = await AVCaptureDevice.requestAccess(for: .audio)
        guard allowed else { throw EngineError(message: "请在系统设置中允许言墨使用麦克风，或先导入音频体验。") }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        if !deviceUID.isEmpty {
            guard let selected = AudioInput.available().first(where: { $0.id == deviceUID }), let unit = input.audioUnit else {
                throw EngineError(message: "所选麦克风未连接，请在设置中重新选择。")
            }
            var deviceID = selected.deviceID
            let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size))
            guard status == noErr else {
                throw EngineError(message: "无法使用所选麦克风（\(status)），请检查设备或选择跟随系统。")
            }
        }
        // Capture through an input tap only. Do not create a main mixer or output
        // node: input-only devices cannot initialize an output graph, and dictation
        // must never route microphone audio to the speakers.
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw EngineError(message: "麦克风没有可用的音频通道。") }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yanmo-\(UUID().uuidString).wav")
        do {
            let file = try AVAudioFile(forWriting: url, settings: format.settings)
            lock.withLock { power = 0; writeError = nil }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self else { return }
                do { try file.write(from: buffer) }
                catch { self.lock.lock(); self.writeError = error; self.lock.unlock() }
                if let data = buffer.floatChannelData, buffer.frameLength > 0 {
                    let count = Int(buffer.frameLength)
                    let square = (0..<count).reduce(0.0) { $0 + Double(data[0][$1] * data[0][$1]) }
                    let rms = sqrt(square / Double(count))
                    self.lock.lock(); self.power = min(1, pow(rms, 0.65) * 2); self.lock.unlock()
                }
            }
            self.engine = engine; self.url = url
            engine.prepare()
            try engine.start()
        } catch {
            self.engine?.inputNode.removeTap(onBus: 0); self.engine = nil; self.url = nil
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }
    public func finish() -> URL? {
        engine?.stop(); engine?.inputNode.removeTap(onBus: 0); engine = nil
        let result = url; url = nil
        lock.lock(); let failed = writeError != nil; power = 0; lock.unlock()
        if failed, let result { try? FileManager.default.removeItem(at: result); return nil }
        return result
    }
    public func cancel() { if let url = finish() { try? FileManager.default.removeItem(at: url) } }
}
