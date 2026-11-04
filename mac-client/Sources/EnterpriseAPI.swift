import Foundation
import CryptoKit

struct RelayFailure: LocalizedError {
    let message: String
    let status: Int
    init(_ message: String, status: Int = 0) { self.message = message; self.status = status }
    var errorDescription: String? { message }
}
struct AuthStart: Decodable { let authorizationURL: String; let transactionId: String }
struct AuthResult: Decodable { let token: String; let deviceId: String; let name: String; let authentication: String; let expiresAt: String }
struct SessionStatus: Decodable { let authentication: String; let name: String; let expiresAt: String; let deviceId: String }
struct Policy {
    let revision: Int
    let expires: Date
    let config: [String: Any]
    let routes: [String]
    let metering: String
    init(data: Data) throws {
        guard let j = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              j["authentication"] as? String == "feishu", let revision = j["revision"] as? Int,
              let until = j["expiresAt"] as? String, let expires = Self.date(until), expires > Date(),
              let config = j["config"] as? [String: Any], let outbounds = config["outbounds"] as? [[String: Any]] else {
            throw RelayFailure("未获得有效的飞书授权配置", status: 403)
        }
        let routes = outbounds.filter { !["selector", "direct", "block"].contains($0["type"] as? String ?? "") }.compactMap { $0["tag"] as? String }
        guard !routes.isEmpty else { throw RelayFailure("管理员尚未分配可用线路") }
        self.revision = revision; self.expires = expires; self.config = config; self.routes = routes; self.metering = j["metering"] as? String ?? "unmetered"
    }
    static func date(_ value: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
struct EnterpriseAPI {
    let base: URL
    private let session: URLSession
    init(address: String) throws {
        guard let u = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = u.host, u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
              ["", "/"].contains(u.path), u.scheme == "https" || (u.scheme == "http" && ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host)) else {
            throw RelayFailure("请输入 HTTPS 服务地址；本机测试仅允许 http://127.0.0.1:4181")
        }
        self.base = u
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 20; c.timeoutIntervalForResource = 30
        c.httpCookieStorage = nil; c.urlCache = nil
        // Control requests must remain reachable while enabling/disabling our own system proxy.
        c.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0, "ProxyAutoConfigEnable": 0]
        self.session = URLSession(configuration: c)
    }
    func request(_ path: String, method: String = "GET", token: String? = nil, body: [String: Any]? = nil) async throws -> Data {
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw RelayFailure("服务地址无效") }
        var r = URLRequest(url: url); r.httpMethod = method
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: r)
        guard let http = response as? HTTPURLResponse else { throw RelayFailure("服务响应无效") }
        guard (200..<300).contains(http.statusCode) else {
            let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw RelayFailure(j?["error"] as? String ?? "服务请求失败，请检查服务地址", status: http.statusCode)
        }
        return data
    }
    func start(challenge: String, installationId: String) async throws -> AuthStart {
        let data = try await request("/api/desktop/auth/start", method: "POST", body: ["challenge":challenge,"installationId":installationId,"deviceName":String((Host.current().localizedName ?? "Mac").prefix(90))])
        let result = try JSONDecoder().decode(AuthStart.self, from: data)
        guard let url = URL(string: result.authorizationURL), url.scheme == base.scheme, url.host == base.host, url.port == base.port, url.path == "/auth/desktop/start" else { throw RelayFailure("登录地址与企业服务不匹配", status:403) }
        return result
    }
    func exchange(ticket: String, verifier: String, transactionId: String) async throws -> AuthResult {
        let result = try JSONDecoder().decode(AuthResult.self, from: await request("/api/desktop/auth/exchange", method: "POST", body:["ticket":ticket,"verifier":verifier,"transactionId":transactionId]))
        guard result.authentication == "feishu", let expires = Policy.date(result.expiresAt), expires > Date() else { throw RelayFailure("飞书登录凭证无效",status:403) }
        return result
    }
    func status(token: String) async throws -> SessionStatus { try JSONDecoder().decode(SessionStatus.self, from: await request("/api/client/status", token:token)) }
    func policy(token: String) async throws -> Policy { try Policy(data: await request("/api/client/policy", token:token)) }
    func ack(_ policy: Policy, stage: String, token: String) async throws { _ = try await request("/api/client/ack", method:"POST", token:token, body:["revision":policy.revision,"stage":stage]) }
}
