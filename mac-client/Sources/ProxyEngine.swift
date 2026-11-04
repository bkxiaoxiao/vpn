import Foundation
import Darwin

@MainActor final class ProxyEngine {
    private var process:Process?
    private let directory:URL
    private var monitor:DispatchSourceProcess?
    private let coreURL:URL?
    private let watcherURL:URL?
    private struct Runtime { let id:UUID; let controller:CoreController; let routes:[String]; let revision:Int; let expires:Date }
    private var runtime:Runtime?
    var runId:UUID? {runtime?.id}
    var onExit:(()->Void)?
    private(set) var port=0
    var running:Bool { process?.isRunning == true }
    init(directory:URL,coreURL:URL?=Bundle.main.url(forResource:"sing-box",withExtension:nil),watcherURL:URL?=Bundle.main.url(forResource:"core-watchdog",withExtension:"sh")){self.directory=directory;self.coreURL=coreURL;self.watcherURL=watcherURL;try? FileManager.default.removeItem(at:directory.appendingPathComponent("core-run.json"))}
    private func freePort() throws -> Int {
        let fd=socket(AF_INET,SOCK_STREAM,0); guard fd>=0 else {throw RelayFailure("无法创建本地代理端口")}; defer{Darwin.close(fd)}
        var addr=sockaddr_in();addr.sin_len=UInt8(MemoryLayout<sockaddr_in>.size);addr.sin_family=sa_family_t(AF_INET);addr.sin_port=0;addr.sin_addr.s_addr=inet_addr("127.0.0.1")
        let result=withUnsafePointer(to:&addr){$0.withMemoryRebound(to:sockaddr.self,capacity:1){Darwin.bind(fd,$0,socklen_t(MemoryLayout<sockaddr_in>.size))}}
        guard result==0 else {throw RelayFailure("无法分配代理端口")};var len=socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok=withUnsafeMutablePointer(to:&addr){$0.withMemoryRebound(to:sockaddr.self,capacity:1){getsockname(fd,$0,&len)}}
        guard ok==0 else {throw RelayFailure("无法读取代理端口")};return Int(UInt16(bigEndian:addr.sin_port))
    }
    func start(policy:Policy,route:String) async throws {
        stop()
        guard policy.expires>Date(),policy.routes.contains(route),let core=coreURL,let watcher=watcherURL else {throw RelayFailure("授权配置或代理核心不可用")}
        port=try freePort()
        var controlPort=try freePort();while controlPort==port {controlPort=try freePort()}
        let selector="relay-active-"+UUID().uuidString
        let controller=CoreController(port:controlPort,secret:UUID().uuidString+UUID().uuidString,selector:selector)
        var outbounds=policy.config["outbounds"] as! [[String:Any]]
        outbounds.append(["type":"selector","tag":selector,"outbounds":policy.routes,"default":route,"interrupt_exist_connections":true])
        let config:[String:Any]=["log":["disabled":true],"inbounds":[["type":"mixed","tag":"relay-local","listen":"127.0.0.1","listen_port":port]],"outbounds":outbounds,"route":["final":selector],"experimental":["clash_api":["external_controller":"127.0.0.1:\(controlPort)","secret":controller.secret,"access_control_allow_origin":["http://127.0.0.1"],"access_control_allow_private_network":false]]]
        let file=directory.appendingPathComponent("core-run.json");try JSONSerialization.data(withJSONObject:config).write(to:file,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        let check=Process();check.executableURL=core;check.arguments=["check","-c",file.path];check.standardOutput=FileHandle.nullDevice;check.standardError=FileHandle.nullDevice
        try check.run();check.waitUntilExit();guard check.terminationStatus==0 else {try? FileManager.default.removeItem(at:file);throw RelayFailure("线路配置未通过核心校验，请联系管理员")}
        let p=Process();p.executableURL=URL(fileURLWithPath:"/bin/sh");p.arguments=[watcher.path,core.path,file.path,String(getpid())];p.standardOutput=FileHandle.nullDevice;p.standardError=FileHandle.nullDevice
        let run=Runtime(id:UUID(),controller:controller,routes:policy.routes,revision:policy.revision,expires:policy.expires)
        p.terminationHandler={ [weak self] _ in Task { @MainActor in guard self?.runtime?.id==run.id else{return};self?.onExit?() } };try p.run();process=p;runtime=run
        try await Task.sleep(nanoseconds:700_000_000)
        guard runtime?.id==run.id else{throw CancellationError()}
        guard p.isRunning else {stop();throw RelayFailure("代理核心未能启动")}
        do{guard try await controller.selected()==route,runtime?.id==run.id else{throw RelayFailure("代理线路初始化失败")}}catch{if runtime?.id==run.id{stop()};throw RelayFailure("代理线路控制接口未能启动")}
        // No system proxy is changed until the process has passed its local startup checks.
    }
    func select(_ route:String) async throws {
        guard running,let run=runtime,run.expires>Date(),run.routes.contains(route) else{throw RelayFailure("线路已失效，请重新同步配置")}
        try await run.controller.select(route)
        guard runtime?.id==run.id,running else{throw RelayFailure("连接已结束")}
    }
    func currentRoute() async throws -> String {
        guard running,let run=runtime else{throw RelayFailure("代理未运行")}
        let route=try await run.controller.selected()
        guard runtime?.id==run.id,run.routes.contains(route) else{throw RelayFailure("无法确认已授权线路")}
        return route
    }
    func measureLatency(_ route:String,target:URL=URL(string:"https://www.gstatic.com/generate_204")!) async -> RouteLatency {
        guard running,let run=runtime,run.expires>Date(),run.routes.contains(route) else{return .unreachable}
        return await run.controller.latency(route,target:target)
    }
    func renewAuthorization(_ policy:Policy) throws {
        guard let run=runtime,running,run.revision==policy.revision,run.routes==policy.routes,policy.expires>Date() else{throw RelayFailure("运行配置已变更，请重新连接")}
        runtime=Runtime(id:run.id,controller:run.controller,routes:run.routes,revision:run.revision,expires:policy.expires)
    }
    func stop(){runtime=nil;let p=process;process=nil;p?.terminationHandler=nil;if p?.isRunning==true {p?.terminate()};try? FileManager.default.removeItem(at:directory.appendingPathComponent("core-run.json"));port=0}
}
