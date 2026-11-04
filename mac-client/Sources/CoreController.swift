import Foundation

// Only loopback control traffic; the per-process secret never leaves this Mac.
struct CoreController: Sendable {
    let port: Int
    let secret: String
    let selector: String
    private static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"))!
    }
    private func request(route: String, delayURL: URL? = nil, selection: String? = nil) async throws -> Data {
        var url = URLComponents()
        url.scheme = "http"; url.host = "127.0.0.1"; url.port = port
        url.percentEncodedPath = "/proxies/" + Self.component(route) + (delayURL == nil ? "" : "/delay")
        if let delayURL { url.queryItems = [URLQueryItem(name: "url", value: delayURL.absoluteString), URLQueryItem(name: "timeout", value: "5000")] }
        guard let endpoint = url.url else { throw RelayFailure("本地线路控制地址无效") }
        var r = URLRequest(url: endpoint)
        r.timeoutInterval = delayURL == nil ? 4 : 8
        r.setValue("Bearer " + secret, forHTTPHeaderField: "Authorization")
        if let selection {
            r.httpMethod = "PUT"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["name": selection])
        }
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil; c.urlCache = nil
        c.timeoutIntervalForResource = delayURL == nil ? 5 : 9
        c.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0, "ProxyAutoConfigEnable": 0]
        let session = URLSession(configuration: c)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: r)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw RelayFailure("本地线路控制请求未成功")
        }
        return data
    }
    func selected() async throws -> String {
        let data = try await request(route: selector)
        guard let j = try JSONSerialization.jsonObject(with: data) as? [String: Any], let name = j["now"] as? String else {
            throw RelayFailure("无法确认当前线路")
        }
        return name
    }
    func select(_ route: String) async throws {
        _ = try await request(route: selector, selection: route)
        guard try await selected() == route else { throw RelayFailure("线路切换结果未确认") }
    }
    func latency(_ route: String, target: URL = URL(string: "https://www.gstatic.com/generate_204")!) async -> RouteLatency {
        do {
            let data = try await request(route: route, delayURL: target)
            guard let j = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let milliseconds = j["delay"] as? Int, (0...65535).contains(milliseconds) else { return .unreachable }
            return .measured(milliseconds)
        } catch { return .unreachable }
    }
}
