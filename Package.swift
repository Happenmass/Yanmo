// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Yanmo",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Yanmo", targets: ["Yanmo"])],
    targets: [
        .target(name: "YanmoCore"),
        .executableTarget(name: "Yanmo", dependencies: ["YanmoCore"]),
        // Standalone checks also run with Command Line Tools, which omit XCTest.
        .executableTarget(name: "YanmoChecks", dependencies: ["YanmoCore"], path: "Tests/YanmoCoreTests")
    ]
)
