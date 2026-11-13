import AppKit

/// Keep the last dictation in memory until the next eligible Return or expiry.
@MainActor
public final class CorrectionObservation {
    private var written: String
    private var transcript: String?
    private let deadline = ProcessInfo.processInfo.systemUptime + 10
    private var timer: Timer?
    private let completion: (String, String, String?) -> Void

    public init?(text: String, transcript: String?, completion: @escaping (String, String, String?) -> Void) {
        guard !text.isEmpty, text.utf16.count <= 2000 else { return nil }
        written = text
        self.transcript = transcript
        self.completion = completion
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    /// Capture the current editor before the key reaches the app and can clear it.
    public func returnPressed() {
        guard timer != nil, ProcessInfo.processInfo.systemUptime < deadline,
              let draft = InputDestination.correctionDraft() else { return }
        let original = written
        let transcript = self.transcript
        stop()
        let whitespace = CharacterSet.whitespacesAndNewlines
        let final = draft.trimmingCharacters(in: whitespace)
        guard !final.isEmpty, final != original.trimmingCharacters(in: whitespace) else { return }
        let completion = self.completion
        Task { @MainActor in completion(original, draft, transcript) }
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
        written = ""
        transcript = nil
    }
}
