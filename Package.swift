// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Yanmo",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Yanmo", targets: ["Yanmo"]), .executable(name: "YanmoBridge", targets: ["YanmoBridge"])],
    dependencies: [.package(url: "https://github.com/jaywcjlove/PermissionFlow", from: "2.9.1")],
    targets: [
        .target(name: "YanmoCore"),
        .target(name: "YanmoNative", dependencies: ["YanmoCore"]),
        .executableTarget(name: "Yanmo", dependencies: ["YanmoCore", "YanmoNative"]),
        .executableTarget(name: "YanmoBridge", dependencies: ["YanmoCore", "YanmoNative", .product(name: "PermissionFlow", package: "PermissionFlow")]),
        .executableTarget(name: "YanmoLifecycleChecks", dependencies: ["YanmoNative"], path: "Tests", exclude: ["YanmoCoreTests", "InputCaptureChecks", "ShortcutCaptureChecks.swift"], sources: ["EngineLifecycleChecks.swift"]),
        .executableTarget(name: "YanmoInputChecks", dependencies: ["YanmoCore"], path: "Tests/InputCaptureChecks"),
        .executableTarget(name: "YanmoShortcutChecks", dependencies: ["YanmoCore", "YanmoNative"], path: "Tests", exclude: ["YanmoCoreTests", "InputCaptureChecks", "EngineLifecycleChecks.swift"], sources: ["ShortcutCaptureChecks.swift"]),
        // Standalone checks also run with Command Line Tools, which omit XCTest.
        .executableTarget(name: "YanmoChecks", dependencies: ["YanmoCore"], path: "Tests/YanmoCoreTests")
    ],
    swiftLanguageModes: [.v5]
)
