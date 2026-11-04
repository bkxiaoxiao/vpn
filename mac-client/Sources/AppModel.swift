import Foundation
import AppKit
import CryptoKit
import Security
import Combine

@MainActor final class AppModel:NSObject,ObservableObject {
    @Published var serverAddress:String = UserDefaults.standard.string(forKey:"RelayServerAddress") ?? "https://vpn-243359801139.asia-east1.run.app"
    @Published var useSystemProxy=true
    @Published var isAuthenticated=false
    @Published var isConnected=false
    @Published var busy=false
    @Published var waitingForBrowser=false
    @Published var displayName="未登录"
    @Published var message="请先通过飞书登录，才能同步企业配置与连接。"
    @Published var revision:Int?
    @Published var routes:[String]=[]
    @Published var selectedRoute=""
    @Published var localPort=0
    @Published var metering=""
    @Published var needsRecovery=false
    @Published var lastSync:Date?
    private var token:String?
    private var sessionExpires:Date?
    private var policy:Policy?
    private var api:EnterpriseAPI?
    private let browserLogin=BrowserLogin(opener: { NSWorkspace.shared.open($0) })
    private var maintenance:Task<Void,Never>?
    private var generation=UUID()
    private let engine:ProxyEngine
    private let proxy:SystemProxy
    private let installationId:String
    override init(){
        let base=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("RelayEnterprise",isDirectory:true)
        try? FileManager.default.createDirectory(at:base,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        self.engine=ProxyEngine(directory:base);self.proxy=SystemProxy(directory:base)
        let identifier=UserDefaults.standard.string(forKey:"RelayInstallationId") ?? UUID().uuidString
        self.installationId=identifier;UserDefaults.standard.set(identifier,forKey:"RelayInstallationId")
        super.init();needsRecovery=proxy.needsRecovery
        if needsRecovery {message="发现上次的代理恢复记录，请先恢复网络代理，再登录连接。"}
        engine.onExit={ [weak self] in guard let self,self.isConnected else{return};self.forceLock("代理核心已停止，请重新登录后连接。") }
    }
    private func base64url(_ data:Data)->String {data.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")}
    func login() async {
        guard !busy,!isAuthenticated else{return}
        let epoch=UUID();generation=epoch;busy=true;message="正在向企业服务申请飞书登录…";defer{if generation==epoch {busy=false}}
        do {
            let service=try EnterpriseAPI(address:serverAddress)
            var random=[UInt8](repeating:0,count:32);guard SecRandomCopyBytes(kSecRandomDefault,random.count,&random)==errSecSuccess else{throw RelayFailure("无法生成安全登录参数")}
            let verifier=base64url(Data(random)),challenge=base64url(Data(SHA256.hash(data:Data(verifier.utf8))))
            let start=try await service.start(challenge:challenge,installationId:installationId)
            guard generation==epoch else{return}
            UserDefaults.standard.set(service.base.absoluteString,forKey:"RelayServerAddress")
            waitingForBrowser=true;message="已在默认浏览器打开飞书登录。完成后会返回客户端；未出现时可点击“重新打开飞书”。"
            let callback=try await browserLogin.begin(url:URL(string:start.authorizationURL)!,transactionId:start.transactionId)
            guard generation==epoch else{return};waitingForBrowser=false
            guard let c=URLComponents(url:callback,resolvingAgainstBaseURL:false),c.scheme=="relay-enterprise",c.host=="auth",c.path=="/callback",let ticket=c.queryItems?.first(where:{$0.name=="ticket"})?.value,c.queryItems?.first(where:{$0.name=="transaction"})?.value==start.transactionId else{throw RelayFailure("登录回调不匹配",status:403)}
            let result=try await service.exchange(ticket:ticket,verifier:verifier,transactionId:start.transactionId)
            guard generation==epoch else{return}
            self.api=service;token=result.token;sessionExpires=Policy.date(result.expiresAt);displayName=result.name;isAuthenticated=true
            UserDefaults.standard.set(service.base.absoluteString,forKey:"RelayServerAddress")
            message="飞书登录成功，正在同步企业配置…"
            try await synchronize(epoch:epoch)
            if generation==epoch {beginMaintenance()}
        } catch {if generation==epoch{if waitForPolicy(error){beginMaintenance()}else{forceLock(friendly(error))}}}
    }
    func reopenLogin(){
        guard waitingForBrowser else{return}
        if browserLogin.reopen(){message="已重新打开默认浏览器，请完成飞书认证并允许返回 Relay。"}
    }
    func cancelLogin(){guard busy,!isAuthenticated else{return};forceLock("已取消飞书登录，可以重新发起。")}
    @discardableResult func handleLoginCallback(_ url:URL)->Bool {
        guard waitingForBrowser else{return false}
        return browserLogin.accept(url)
    }
    func sync() async {
        guard isAuthenticated,!busy else{return};let epoch=generation;busy=true;defer{if generation==epoch{busy=false}}
        do {try await synchronize(epoch:epoch)}catch {if generation==epoch,!waitForPolicy(error){forceLock(friendly(error))}}
    }
    private func authorize() async throws -> (EnterpriseAPI,String){
        guard isAuthenticated,let token,let api,let expires=sessionExpires,expires>Date() else {throw RelayFailure("请重新通过飞书登录",status:401)}
        let status=try await api.status(token:token);guard status.authentication=="feishu",let serverExpiry=Policy.date(status.expiresAt),serverExpiry>Date() else{throw RelayFailure("飞书认证已失效",status:403)}
        return (api,token)
    }
    private func synchronize(epoch:UUID) async throws {
        let (service,bearer)=try await authorize();let next=try await service.policy(token:bearer);guard generation==epoch else{return}
        let changed=revision != nil && revision != next.revision
        if changed && isConnected {disconnect();message="组织配置已更新，连接已断开，请选择线路后重新连接。"}
        policy=next;revision=next.revision;routes=next.routes;metering=next.metering;lastSync=Date()
        if !routes.contains(selectedRoute){selectedRoute=routes[0]}
        try await service.ack(next,stage:"validated",token:bearer)
        if generation==epoch {message=isConnected ? "连接正常，飞书授权已校验。":"配置 v\(next.revision) 已同步。连接前会再次校验飞书授权。"}
    }
    func connect() async {
        guard isAuthenticated,!busy,!isConnected else{return};let epoch=generation;busy=true;defer{if generation==epoch{busy=false}}
        do {
            guard !proxy.needsRecovery else {throw RelayFailure("请先恢复上次的网络代理设置")}
            try await synchronize(epoch:epoch);guard generation==epoch,let policy else{return}
            let (service,bearer)=try await authorize();guard generation==epoch else{return}
            message="正在启动已授权线路…";try await engine.start(policy:policy,route:selectedRoute)
            guard generation==epoch else{engine.stop();return}
            if useSystemProxy{try proxy.enable(port:engine.port)}
            guard generation==epoch else{disconnect();return}
            isConnected=true;localPort=engine.port;needsRecovery=proxy.needsRecovery
            try await service.ack(policy,stage:"applied",token:bearer)
            guard generation==epoch else{return}
            message=useSystemProxy ? "已连接。当前活动网络的系统代理已接管。":"已连接本地代理。请将测试应用代理设为 127.0.0.1:\(localPort)。"
        } catch {if generation==epoch,!waitForPolicy(error){forceLock(friendly(error))}}
    }
    func disconnect(){
        engine.stop();isConnected=false;localPort=0
        do{try proxy.restore();needsRecovery=false;message="已断开，网络代理设置已恢复。"}catch{needsRecovery=proxy.needsRecovery;message="代理已停止，但系统设置尚未恢复。请点击“恢复网络代理”。"}
    }
    func recover(){do{try proxy.restore();needsRecovery=false;message="已恢复之前的系统代理设置。"}catch{needsRecovery=true;message=friendly(error)}}
    func logout(){
        let oldAPI=api,oldToken=token
        forceLock("已退出飞书登录。配置已清理，代理已停止。")
        if let oldAPI,let oldToken{Task{_ = try? await oldAPI.request("/api/client/logout",method:"POST",token:oldToken,body:[:])}}
    }
    private func forceLock(_ reason:String){
        generation=UUID();maintenance?.cancel();maintenance=nil;browserLogin.cancel();waitingForBrowser=false
        token=nil;sessionExpires=nil;api=nil;policy=nil;isAuthenticated=false;displayName="未登录";revision=nil;routes=[];selectedRoute="";metering="";lastSync=nil;busy=false
        disconnect();message=needsRecovery ? reason+" 请恢复网络代理。":reason
    }
    private func waitForPolicy(_ error:Error)->Bool {
        guard isAuthenticated,let failure=error as? RelayFailure,failure.isPolicyUnavailable else{return false}
        disconnect();policy=nil;revision=nil;routes=[];selectedRoute="";metering="";lastSync=Date()
        message="飞书登录成功。\(failure.message)，请管理员分配并发布线路后同步配置。"
        return true
    }
    private func beginMaintenance(){
        maintenance?.cancel();maintenance=Task{[weak self] in
            while !Task.isCancelled {
                do{try await Task.sleep(nanoseconds:30_000_000_000)}catch{return}
                guard let self,self.isAuthenticated else{return}
                let epoch=self.generation
                do{
                    _ = try await self.authorize()
                    guard self.generation==epoch else{return}
                    if let p=self.policy,p.expires<=Date(){throw RelayFailure("配置授权已过期，请重新登录",status:403)}
                    if !self.busy,let last=self.lastSync,Date().timeIntervalSince(last)>300 {try await self.synchronize(epoch:epoch)}
                }catch{if self.generation==epoch{if !self.waitForPolicy(error){self.forceLock("无法确认飞书授权，已停止代理。"+self.friendly(error));return}}else{return}}
            }
        }
    }
    private func friendly(_ error:Error)->String {
        if let error=error as? RelayFailure{return error.message}
        if error is URLError{return "无法连接企业服务，请检查服务地址和网络。"}
        return "操作未完成，请重试或联系管理员。"
    }
    func shutdown(){generation=UUID();maintenance?.cancel();browserLogin.cancel();token=nil;policy=nil;disconnect()}
}
