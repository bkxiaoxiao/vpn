import Foundation

@main struct CoreRoutingTests {
    struct Fixture: Decodable { let a: Int; let b: Int; let unavailable: Int }
    @MainActor static func policy(_ ports: [String: Int], expires: Date = Date().addingTimeInterval(300)) throws -> Policy {
        let tags = ["测试 / A ?#%", "测试 B", "不可达"]
        let outbounds = zip(tags, [ports["a"]!, ports["b"]!, ports["unavailable"]!]).map { tag, port -> [String: Any] in
            ["type": "http", "tag": tag, "server": "127.0.0.1", "server_port": port]
        }
        return try Policy(data: JSONSerialization.data(withJSONObject: ["authentication": "feishu", "revision": 1, "expiresAt": ISO8601DateFormatter().string(from: expires), "config": ["outbounds": outbounds]]))
    }
    static func traffic(_ port: Int) throws -> String {
        let curl = Process(); curl.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        curl.arguments = ["--silent", "--show-error", "--noproxy", "", "--proxy", "http://127.0.0.1:\(port)", "--max-time", "5", "http://relay.test.invalid/check"]
        let output = Pipe(); curl.standardOutput = output; curl.standardError = FileHandle.nullDevice
        try curl.run(); let body = output.fileHandleForReading.readDataToEndOfFile(); curl.waitUntilExit()
        guard curl.terminationStatus == 0 else { throw RelayFailure("Local proxy fixture request failed") }
        return String(decoding: body, as: UTF8.self)
    }
    @MainActor static func main() async throws {
        let instant = Date(timeIntervalSince1970: 10_000)
        var snapshot = RouteLatencySnapshot()
        assert(snapshot.needsRefresh(at: instant))
        snapshot.updatedAt = instant; snapshot.values["a"] = .measured(42)
        assert(!snapshot.needsRefresh(at: instant.addingTimeInterval(3599)))
        assert(snapshot.needsRefresh(at: instant.addingTimeInterval(3600)))
        assert(snapshot.needsRefresh(at: instant.addingTimeInterval(-1)))
        assert(snapshot.label(for: "a", measuring: false) == "42 ms")
        assert(RouteLatency.unreachable.label == "超时/不可达")
        print("PASS hourly freshness boundary, clock changes and honest latency labels")

        let fixture = Process(); fixture.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        fixture.arguments = ["python3", "Tests/core-fixture.py"]
        let output = Pipe(); fixture.standardOutput = output; fixture.standardError = FileHandle.nullDevice
        try fixture.run(); defer { fixture.terminate(); fixture.waitUntilExit() }
        var line = Data()
        while true { let byte = output.fileHandleForReading.readData(ofLength: 1); if byte.isEmpty || byte == Data([10]) { break }; line.append(byte) }
        let settings = try JSONDecoder().decode(Fixture.self, from: line)
        let ports = ["a": settings.a, "b": settings.b, "unavailable": settings.unavailable]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("relay-routing-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = ProxyEngine(directory: directory, coreURL: URL(fileURLWithPath: "/opt/homebrew/bin/sing-box"), watcherURL: URL(fileURLWithPath: FileManager.default.currentDirectoryPath + "/Resources/core-watchdog.sh"))
        defer { engine.stop() }
        let authorized = try policy(ports)
        try await engine.start(policy: authorized, route: authorized.routes[0])
        let port = engine.port, run = engine.runId
        let firstTraffic = try traffic(port)
        assert(firstTraffic == "route-a")
        try await engine.select(authorized.routes[1])
        let current = try await engine.currentRoute()
        assert(current == authorized.routes[1] && engine.port == port && engine.runId == run)
        let switchedTraffic = try traffic(port)
        assert(switchedTraffic == "route-b")
        print("PASS live selector switches actual traffic without restarting core or changing proxy port")
        do { try await engine.select("unauthorized"); fatalError("Unauthorized route selected") } catch {}
        let file = directory.appendingPathComponent("core-run.json")
        let config = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let api = (config["experimental"] as! [String: Any])["clash_api"] as! [String: Any]
        assert((api["external_controller"] as! String).hasPrefix("127.0.0.1:"))
        assert((api["secret"] as! String).count > 32)
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber
        assert(permissions.intValue & 0o777 == 0o600)
        let controllerPort = Int((api["external_controller"] as! String).split(separator: ":").last!)!
        let selector = (config["route"] as! [String: Any])["final"] as! String
        let wrongSecret = CoreController(port: controllerPort, secret: "wrong-secret", selector: selector)
        do { _ = try await wrongSecret.selected(); fatalError("Unauthenticated controller access succeeded") } catch {}
        print("PASS authorized members only, loopback controller and protected random secret")
        let target = URL(string: "https://www.apple.com/library/test/success.html")!
        for route in authorized.routes.prefix(2) {
            let measured = await engine.measureLatency(route, target: target)
            guard case .measured(let milliseconds) = measured, milliseconds >= 35 else {
                throw RelayFailure("Expected an actual HTTPS delay, received \(measured)")
            }
        }
        let failed = await engine.measureLatency(authorized.routes[2], target: target)
        assert(failed == .unreachable)
        let afterProbes = try await engine.currentRoute()
        assert(afterProbes == current && engine.runId == run && engine.port == port)
        print("PASS per-outbound latency and failure handling leave active selection unchanged")
        try engine.renewAuthorization(policy(ports, expires: Date().addingTimeInterval(600)))
        assert(engine.runId == run)
        engine.stop(); assert(!engine.running && engine.port == 0 && engine.runId == nil)
        assert(!FileManager.default.fileExists(atPath: file.path))
        print("PASS renewed authorization preserves core; stopping removes control state and credentials")
    }
}
