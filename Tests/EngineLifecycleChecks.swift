import Foundation
import Darwin

/// Compile with LocalEngine.swift; uses the real pipe, queue and idle timer with
/// a tiny worker so the one-hour boundary can be checked without loading models.
@main
struct EngineLifecycleChecks {
    static func require(_ condition: Bool, _ message: String) {
        precondition(condition, message)
    }

    static func pause(_ seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    static func main() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let worker = folder.appendingPathComponent("worker.py")
        try """
        import sys, json, os, time
        for line in sys.stdin:
            request = json.loads(line)
            time.sleep(request.get('delay', 0))
            print(json.dumps({'id': request['id'], 'ok': True, 'pid': os.getpid()}), flush=True)
        """.write(to: worker, atomically: true, encoding: .utf8)
        let engine = LocalEngine(idleTimeout: 0.3, workerURL: worker)
        defer { engine.stop() }
        func request(_ delay: Double = 0) async throws -> Int32 {
            let response = try await engine.request(["command": "check", "delay": delay], python: "/usr/bin/python3")
            return Int32(response["pid"] as! Int)
        }

        let first = try await request()
        try await pause(0.7)
        require(kill(first, 0) != 0, "Idle worker must exit, releasing all model allocations")
        let second = try await request()
        require(second != first, "Next request must automatically restart the worker")
        print("PASS: idle exit and automatic restart")

        engine.setActive(true)
        try await pause(0.7)
        require(try await request() == second, "Recording must keep the same warm worker")
        engine.setActive(false)
        try await pause(0.7)
        require(kill(second, 0) != 0, "Finishing/cancelling activity must start the idle countdown")
        print("PASS: recording hold and completion countdown")

        let third = try await request(0.7)
        require(kill(third, 0) == 0, "A request longer than the idle timeout must complete alive")
        try await pause(0.15)
        require(try await request() == third, "Recent use must reuse the loaded worker")
        try await pause(0.2)
        require(kill(third, 0) == 0, "Old timer must not fire after renewed activity")
        try await pause(0.5)
        require(kill(third, 0) != 0, "Timeout must run from the latest completion")
        print("PASS: long inference protection, warm reuse and countdown reset")

        let fourth = try await request()
        try await pause(0.15)
        engine.setActive(true)
        try await pause(0.4)
        require(kill(fourth, 0) == 0, "New recording must invalidate an already scheduled timer")
        engine.setActive(false)
        try await pause(0.7)
        require(kill(fourth, 0) != 0, "Worker must exit after recording ends")
        print("PASS: new activity invalidates stale expiry")
        print("4 lifecycle checks passed")
    }
}
