import Foundation
import AppKit
import SystemConfiguration

struct ProxySetting: Codable {
    let enabled: Bool
    let host: String
    let port: Int
}
struct ProxySnapshot: Codable {
    let service: String
    let http: ProxySetting
    let https: ProxySetting
    let socks: ProxySetting
}
@MainActor final class SystemProxy {
    let recoveryURL: URL
    private(set) var owned = false
    init(directory: URL) { recoveryURL = directory.appendingPathComponent("proxy-recovery.json") }
    var needsRecovery: Bool { FileManager.default.fileExists(atPath:recoveryURL.path) }
    private func read(_ args: [String]) throws -> String {
        let p=Process(); p.executableURL=URL(fileURLWithPath:"/usr/sbin/networksetup"); p.arguments=args
        let pipe=Pipe(); p.standardOutput=pipe; p.standardError=FileHandle.nullDevice
        try p.run(); let data=pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
        guard p.terminationStatus==0 else { throw RelayFailure("无法读取当前网络代理设置") }
        return String(decoding:data,as:UTF8.self)
    }
    private func activeService() throws -> String {
        guard let prefs=SCPreferencesCreate(nil,"Relay" as CFString,nil) else { throw RelayFailure("无法读取网络服务") }
        for family in ["IPv4","IPv6"] {
            if let info=SCDynamicStoreCopyValue(nil,"State:/Network/Global/\(family)" as CFString) as? [String:Any],
               let identifier=info["PrimaryService"] as? String,
               let service=SCNetworkServiceCopy(prefs,identifier as CFString), let name=SCNetworkServiceGetName(service) { return name as String }
        }
        throw RelayFailure("没有活动网络，请先连接 Wi-Fi 或以太网")
    }
    private func setting(_ type:String, service:String) throws -> ProxySetting {
        let out=try read(["-get\(type)",service]); var fields=[String:String]()
        for line in out.components(separatedBy:"\n") { if let i=line.firstIndex(of:":") { fields[String(line[..<i])]=line[line.index(after:i)...].trimmingCharacters(in:.whitespaces) } }
        if fields["Authenticated Proxy Enabled"] == "1" { throw RelayFailure("检测到已有认证代理。请关闭系统代理接管，使用本地代理模式测试。") }
        return ProxySetting(enabled:fields["Enabled"] == "Yes",host:fields["Server"] ?? "",port:Int(fields["Port"] ?? "0") ?? 0)
    }
    private func quote(_ s:String)->String { "'"+s.replacingOccurrences(of:"'",with:"'\\''")+"'" }
    private func authorized(_ commands:[String]) throws {
        let shell=commands.joined(separator:" && ")
        let encoded=shell.replacingOccurrences(of:"\\",with:"\\\\").replacingOccurrences(of:"\"",with:"\\\"")
        var error:NSDictionary?
        NSAppleScript(source:"do shell script \"\(encoded)\" with administrator privileges")?.executeAndReturnError(&error)
        if error != nil { throw RelayFailure("系统代理授权未完成。若已有改动，请点击“恢复网络代理”。") }
    }
    func enable(port:Int) throws {
        guard !needsRecovery else { throw RelayFailure("请先恢复上次保存的网络代理设置") }
        let service=try activeService()
        let pac=try read(["-getautoproxyurl",service]), discovery=try read(["-getproxyautodiscovery",service])
        guard !pac.contains("Enabled: Yes"), !discovery.lowercased().contains("on") else { throw RelayFailure("当前启用了 PAC 或自动代理发现，请关闭系统接管，使用本地代理模式。") }
        let snapshot=ProxySnapshot(service:service,http:try setting("webproxy",service:service),https:try setting("securewebproxy",service:service),socks:try setting("socksfirewallproxy",service:service))
        try JSONEncoder().encode(snapshot).write(to:recoveryURL,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:recoveryURL.path)
        let svc=quote(service), root="/usr/sbin/networksetup"
        try authorized(["\(root) -setwebproxy \(svc) 127.0.0.1 \(port)","\(root) -setsecurewebproxy \(svc) 127.0.0.1 \(port)","\(root) -setsocksfirewallproxy \(svc) 127.0.0.1 \(port)"])
        owned=true
    }
    func restore() throws {
        guard needsRecovery else { owned=false; return }
        let snapshot=try JSONDecoder().decode(ProxySnapshot.self,from:Data(contentsOf:recoveryURL))
        let svc=quote(snapshot.service), root="/usr/sbin/networksetup"
        var commands=[String]()
        for (type,value) in [("webproxy",snapshot.http),("securewebproxy",snapshot.https),("socksfirewallproxy",snapshot.socks)] {
            if value.enabled { guard value.port>0,!value.host.isEmpty else { throw RelayFailure("保存的网络恢复信息无效") }; commands.append("\(root) -set\(type) \(svc) \(quote(value.host)) \(value.port)") }
            commands.append("\(root) -set\(type)state \(svc) \(value.enabled ? "on":"off")")
        }
        try authorized(commands); try FileManager.default.removeItem(at:recoveryURL); owned=false
    }
}
