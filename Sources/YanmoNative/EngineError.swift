import Foundation

public struct EngineError: LocalizedError {
    public var message: String
    public var writeAttempted = false
    public var errorDescription: String? { message }
    public init(message: String, writeAttempted: Bool = false) {
        self.message = message
        self.writeAttempted = writeAttempted
    }
}
