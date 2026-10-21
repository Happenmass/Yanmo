import Foundation

/// Shared by the recorder and the global listener. A chord commits on release;
/// ordinary typing, mouse clicks, or switching chords while held invalidate it.
public struct ModifierChord {
    public static let names: [UInt16: String] = [59: "左 Control", 62: "右 Control", 56: "左 Shift", 60: "右 Shift", 58: "左 Option", 61: "右 Option", 55: "左 Command", 54: "右 Command"]
    // Device-specific flags from IOKit/hidsystem/IOLLEvent.h, preserving left/right.
    public static let masks: [UInt16: UInt64] = [59: 0x1, 62: 0x2000, 56: 0x2, 60: 0x4, 58: 0x20, 61: 0x40, 55: 0x8, 54: 0x10]
    public private(set) var pressed = Set<UInt16>()
    private var candidate = Set<UInt16>()
    private var invalid = false
    private var releasing = false
    public init() {}
    public mutating func reset() { self = ModifierChord() }
    public mutating func cancel() { invalid = true }
    public mutating func update(key: UInt16, down: Bool) -> InputShortcut? {
        guard Self.names[key] != nil else { cancel(); return nil }
        if down {
            guard !pressed.contains(key) else { return nil }
            if pressed.isEmpty { invalid = false; releasing = false; candidate = [] }
            if releasing { invalid = true }
            pressed.insert(key); candidate.insert(key)
            return nil
        }
        guard pressed.remove(key) != nil else { return nil }
        releasing = true
        guard pressed.isEmpty else { return nil }
        let result = invalid ? nil : InputShortcut.modifierOnly(candidate)
        reset()
        return result
    }
}
