import Foundation

enum AppRoutingMode: String, Codable, CaseIterable {
    case all, include, exclude
    var title: String { switch self { case .all: return "全部应用"; case .include: return "仅所选应用走代理"; case .exclude: return "所选应用不走代理" } }
}
struct LocalApplication: Codable, Identifiable, Equatable {
    var name: String
    var path: String
    var bundle: Bool
    var id: String { path }
    var pattern: String { "^" + NSRegularExpression.escapedPattern(for: path) + (bundle ? "/" : "$") }
    static func from(_ url: URL) throws -> LocalApplication {
        let url = url.resolvingSymlinksInPath().standardizedFileURL
        if url.pathExtension.lowercased() == "app", let app = Bundle(url: url), let executable = app.executableURL,
           FileManager.default.isExecutableFile(atPath: executable.path) {
            let name = (app.localizedInfoDictionary?["CFBundleDisplayName"] ?? app.infoDictionary?["CFBundleDisplayName"] ?? app.infoDictionary?["CFBundleName"]) as? String
            return LocalApplication(name: name ?? url.deletingPathExtension().lastPathComponent, path: url.path, bundle: true)
        }
        var directory: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), !directory.boolValue,
           FileManager.default.isExecutableFile(atPath: url.path) {
            return LocalApplication(name: url.lastPathComponent, path: url.path, bundle: false)
        }
        throw RelayFailure("请选择已安装的 .app 或可执行文件")
    }
}
struct AppRoutingSettings: Codable, Equatable {
    var mode: AppRoutingMode = .all
    var applications: [LocalApplication] = []
    var summary: String { mode.title + (mode == .all ? "" : " · \(applications.count) 个") }
    func validated() throws -> AppRoutingSettings {
        guard applications.count <= 500, Set(applications.map(\.path)).count == applications.count,
              applications.allSatisfy({ $0.path.hasPrefix("/") && $0.path.count < 4096 && !$0.path.contains("\0") && (!$0.bundle || $0.path.hasSuffix(".app")) }) else {
            throw RelayFailure("应用分流设置无效，请重新选择应用并保存")
        }
        return self
    }
    func route(selector: String, direct: String) throws -> [String: Any] {
        _ = try validated()
        if mode == .all { return ["final": selector] }
        if mode == .include && applications.isEmpty { throw RelayFailure("请先选择至少一个需要走代理的应用") }
        var rules: [[String: Any]] = []
        if !applications.isEmpty {
            rules.append(["process_path_regex": applications.map(\.pattern), "action": "route", "outbound": mode == .include ? selector : direct])
        }
        // Unknown/shared process attribution must never silently proxy a selected exclusion.
        if mode == .exclude { rules.append(["process_path_regex": [".+"], "action": "route", "outbound": selector]) }
        return ["rules": rules, "final": direct, "find_process": true]
    }
    static var file: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RelayEnterprise/app-routing.json") }
    static func load() throws -> AppRoutingSettings {
        guard FileManager.default.fileExists(atPath: file.path) else { return AppRoutingSettings() }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: file)).validated()
    }
    func save() throws {
        _ = try validated()
        try JSONEncoder().encode(self).write(to: Self.file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Self.file.path)
    }
}
