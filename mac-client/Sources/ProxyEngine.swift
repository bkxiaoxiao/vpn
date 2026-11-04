import Foundation
import Darwin

@MainActor final class ProxyEngine {
    private var process:Process?
    private let directory:URL
    private var monitor:DispatchSourceProcess?
    var onExit:(()->Void)?
    private(set) var port=0
    var running:Bool { process?.isRunning == true }
    init(directory:URL){self.directory=directory;try? FileManager.default.removeItem(at:directory.appendingPathComponent("core-run.json"))}
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
        guard policy.expires>Date(),policy.routes.contains(route),let core=Bundle.main.url(forResource:"sing-box",withExtension:nil),let watcher=Bundle.main.url(forResource:"core-watchdog",withExtension:"sh") else {throw RelayFailure("授权配置或代理核心不可用")}
        port=try freePort()
        let config:[String:Any]=["log":["disabled":true],"inbounds":[["type":"mixed","tag":"relay-local","listen":"127.0.0.1","listen_port":port]],"outbounds":policy.config["outbounds"]!,"route":["final":route]]
        let file=directory.appendingPathComponent("core-run.json");try JSONSerialization.data(withJSONObject:config).write(to:file,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        let check=Process();check.executableURL=core;check.arguments=["check","-c",file.path];check.standardOutput=FileHandle.nullDevice;check.standardError=FileHandle.nullDevice
        try check.run();check.waitUntilExit();guard check.terminationStatus==0 else {try? FileManager.default.removeItem(at:file);throw RelayFailure("线路配置未通过核心校验，请联系管理员")}
        let p=Process();p.executableURL=URL(fileURLWithPath:"/bin/sh");p.arguments=[watcher.path,core.path,file.path,String(getpid())];p.standardOutput=FileHandle.nullDevice;p.standardError=FileHandle.nullDevice
        p.terminationHandler={ [weak self] _ in Task { @MainActor in self?.onExit?() } };try p.run();process=p
        try await Task.sleep(nanoseconds:700_000_000)
        guard p.isRunning else {stop();throw RelayFailure("代理核心未能启动")}
        // No system proxy is changed until the process has passed its local startup checks.
    }
    func stop(){let p=process;process=nil;p?.terminationHandler=nil;if p?.isRunning==true {p?.terminate()};try? FileManager.default.removeItem(at:directory.appendingPathComponent("core-run.json"));port=0}
}
