import AppKit
import ApplicationServices

/// A short-lived, read-only observation of the exact field receiving a paste.
/// Snapshots never leave memory; only the inserted span is returned for diffing.
@MainActor
public final class CorrectionObservation {
    private let target: InputDestination
    private var original: String
    private var prefix: String
    private var suffix: String
    private let deadline: TimeInterval
    private var timer: Timer?
    private var keyboard: Any?
    private var lastKey: TimeInterval?
    private var lastChange = ProcessInfo.processInfo.systemUptime
    private var latest: String
    private var verified = false
    private let completion: (String, String) -> Void

    public init?(target: InputDestination?, text: String, completion: @escaping (String, String) -> Void) {
        guard let target, !target.secure, let range = target.selection,
              let value = target.observedValue(), text.utf16.count <= 2000,
              range.location >= 0, range.length >= 0,
              range.location + range.length <= (value as NSString).length else { return nil }
        self.target = target; original = text; latest = text
        let ns = value as NSString
        prefix = ns.substring(to: range.location)
        suffix = ns.substring(from: range.location + range.length)
        deadline = ProcessInfo.processInfo.systemUptime + 10
        self.completion = completion
        keyboard = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] _ in
            // Never retain key codes or typed characters.
            MainActor.assumeIsolated { self?.lastKey = ProcessInfo.processInfo.systemUptime }
        }
    }

    public func start() {
        guard target.observedValue() == prefix + original + suffix else { stop(); return }
        verified = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
    }

    private func sample() {
        guard verified, let value = target.observedValue(), value.hasPrefix(prefix), value.hasSuffix(suffix),
              value.utf16.count >= prefix.utf16.count + suffix.utf16.count else { stop(); return }
        let span = (value as NSString).substring(with: NSRange(location: prefix.utf16.count,
            length: value.utf16.count - prefix.utf16.count - suffix.utf16.count))
        guard span.utf16.count <= 4000 else { stop(); return }
        if latest != span { latest = span; lastChange = ProcessInfo.processInfo.systemUptime }
        if ProcessInfo.processInfo.systemUptime >= deadline {
            let final = latest, initial = original
            let stable = ProcessInfo.processInfo.systemUptime - lastChange >= 0.8
            let committed = !target.hasMarkedText()
            let typed = lastKey != nil && ProcessInfo.processInfo.systemUptime - lastKey! >= 0.8
            stop()
            if stable && committed && typed && final != initial { completion(initial, final) }
        }
    }

    public func stop() {
        timer?.invalidate(); timer = nil
        if let keyboard { NSEvent.removeMonitor(keyboard) }; keyboard = nil
        verified = false
        original = ""; prefix = ""; suffix = ""; latest = ""
    }
}
