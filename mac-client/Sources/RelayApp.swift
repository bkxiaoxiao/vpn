import SwiftUI
import AppKit

@main struct RelayEnterpriseApp:App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model=AppModel()
    var body:some Scene {
        WindowGroup("Relay 企业连接") {MainView(model:model).onAppear{delegate.model=model}.frame(minWidth:760,minHeight:570)}
        .windowStyle(.hiddenTitleBar).defaultSize(width:900,height:640)
        .commands{CommandGroup(replacing:.newItem){};CommandGroup(after:.appInfo){Button("恢复网络代理"){model.recover()}}}
    }
}
@MainActor final class AppDelegate:NSObject,NSApplicationDelegate {
    weak var model:AppModel?
    func application(_ application:NSApplication,open urls:[URL]) {
        for url in urls where model?.handleLoginCallback(url)==true {
            application.activate(ignoringOtherApps:true)
            application.windows.first(where:{$0.canBecomeKey})?.makeKeyAndOrderFront(nil)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {true}
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {model?.shutdown();return .terminateNow}
}
private let forest=Color(red:0.13,green:0.43,blue:0.32)
struct MainView:View {
    @ObservedObject var model:AppModel
    var body:some View {
        HStack(spacing:0){
            VStack(alignment:.leading,spacing:28){
                HStack(spacing:9){Image(systemName:"arrow.up.right").font(.system(size:22,weight:.bold)).foregroundStyle(.white).frame(width:35,height:37).background(forest,in:RoundedRectangle(cornerRadius:10));Text("relay").font(.system(size:29,weight:.bold))}.padding(.top,22)
                VStack(alignment:.leading,spacing:6){Text("企业专属客户端").font(.system(size:12,weight:.semibold));Text("macOS · 安装测试版").font(.system(size:10)).foregroundStyle(.secondary)}
                Label("企业连接",systemImage:"network.badge.shield.half.filled").font(.system(size:12,weight:.medium)).foregroundStyle(forest).padding(12).frame(maxWidth:.infinity,alignment:.leading).background(forest.opacity(0.08),in:RoundedRectangle(cornerRadius:8))
                Spacer()
                VStack(alignment:.leading,spacing:12){Image(systemName:"lock.shield").font(.system(size:24)).foregroundStyle(forest);Text("以企业身份连接").font(.system(size:12,weight:.semibold));Text("只有完成飞书登录，才能同步配置和使用线路。").font(.system(size:10)).foregroundStyle(.secondary).lineSpacing(5)}.padding(16).background(Color.white.opacity(0.7),in:RoundedRectangle(cornerRadius:10))
                HStack{Circle().fill(model.isAuthenticated ? forest:Color.gray.opacity(0.5)).frame(width:6,height:6);Text(model.displayName).font(.system(size:11));Spacer();if model.isAuthenticated{Button("退出"){model.logout()}.buttonStyle(.plain).foregroundStyle(.secondary).font(.system(size:10))}}.padding(.bottom,20)
            }.padding(.horizontal,20).frame(width:195).background(Color(red:0.96,green:0.98,blue:0.96))
            Rectangle().fill(Color.gray.opacity(0.12)).frame(width:1)
            VStack(alignment:.leading,spacing:22){
                HStack{Text("WORKSPACE CONNECTION").font(.system(size:9,weight:.medium)).tracking(2).foregroundStyle(.secondary);Spacer();Label(model.isAuthenticated ? "已通过飞书认证":"飞书登录保护",systemImage:model.isAuthenticated ? "checkmark.shield":"lock.fill").font(.system(size:10)).foregroundStyle(forest)}
                VStack(alignment:.leading,spacing:8){Text(model.isConnected ? "连接已就绪":"安全连接，从身份开始。").font(.system(size:26,weight:.semibold));Text("使用企业飞书身份，自动获取管理员分配的网络配置。").font(.system(size:11)).foregroundStyle(.secondary)}
                VStack(alignment:.leading,spacing:12){
                    Text("企业服务地址").font(.system(size:11,weight:.medium))
                    TextField("https://你的企业控制服务",text:$model.serverAddress).textFieldStyle(.roundedBorder).disabled(model.isAuthenticated||model.busy).font(.system(size:12)).accessibilityIdentifier("server-address")
                    HStack(spacing:8){Image(systemName:"info.circle");Text("本机测试可使用 http://127.0.0.1:4181，正式服务使用 HTTPS。").lineLimit(2)}.font(.system(size:10)).foregroundStyle(.secondary)
                }.padding(18).background(.white,in:RoundedRectangle(cornerRadius:10))
                HStack(spacing:0){step("1","飞书登录",done:model.isAuthenticated);Image(systemName:"chevron.right").foregroundStyle(.tertiary);step("2","同步配置",done:model.revision != nil);Image(systemName:"chevron.right").foregroundStyle(.tertiary);step("3","连接使用",done:model.isConnected)}
                VStack(alignment:.leading,spacing:14){
                    HStack{Text("企业线路").font(.system(size:12,weight:.semibold));Spacer();if let revision=model.revision{Text("配置 v\(revision)").font(.system(size:10)).foregroundStyle(.secondary)}}
                    if !model.isAuthenticated {HStack(spacing:12){Image(systemName:"lock.circle").font(.system(size:28)).foregroundStyle(forest.opacity(0.55));VStack(alignment:.leading,spacing:5){Text("登录后自动同步").font(.system(size:12,weight:.medium));Text("不支持匿名连接、手动导入或跳过登录。").font(.system(size:10)).foregroundStyle(.secondary)}}.padding(.vertical,10)}
                    else if model.routes.isEmpty {Text("等待管理员发布或分配配置。").font(.system(size:11)).foregroundStyle(.secondary)}
                    else {Picker("选择线路",selection:Binding(get:{model.selectedRoute},set:{route in Task{await model.chooseRoute(route)}})){ForEach(model.routes,id:\.self){route in Text(routeName(route)+" · "+model.latency.label(for:route,measuring:model.measuringLatency)).tag(route)}}.disabled(model.busy).accessibilityIdentifier("route-picker")
                        HStack(spacing:6){if model.measuringLatency{ProgressView().controlSize(.mini)};Text(model.measuringLatency ? "正在检测线路延迟…":model.latency.updatedAt.map{"延迟更新于 "+$0.formatted(date:.omitted,time:.shortened)+" · 每小时更新"} ?? "首次连接后检测延迟，每小时更新").font(.system(size:9)).foregroundStyle(.secondary)}
                        Text(model.metering=="gateway" ? "企业网关计量模式":"外购节点直连 · 不包含企业网关用量统计").font(.system(size:10)).foregroundStyle(.secondary)}
                    Divider()
                    Toggle("接管当前网络的系统代理",isOn:$model.useSystemProxy).toggleStyle(.switch).font(.system(size:11)).disabled(model.busy||model.isConnected)
                    Text("仅代理遵循系统代理设置的应用，不是全设备 TUN VPN。接管时 macOS 可能要求管理员授权。").font(.system(size:9)).foregroundStyle(.secondary).lineSpacing(3)
                }.padding(18).background(.white,in:RoundedRectangle(cornerRadius:10))
                HStack(spacing:10){
                    if !model.isAuthenticated{Button{if model.waitingForBrowser{model.reopenLogin()}else{Task{await model.login()}}}label:{Label(model.waitingForBrowser ? "重新打开飞书":model.busy ? "正在验证…":"通过飞书登录",systemImage:"person.crop.circle.badge.checkmark").frame(minWidth:135)}.buttonStyle(.borderedProminent).tint(forest).disabled(model.busy && !model.waitingForBrowser).accessibilityIdentifier("feishu-login")}
                    if model.busy && !model.isAuthenticated{Button("取消登录"){model.cancelLogin()}.buttonStyle(.bordered).accessibilityIdentifier("cancel-login")}
                    Button{Task{await model.sync()}}label:{Label("同步配置",systemImage:"arrow.triangle.2.circlepath")}.buttonStyle(.bordered).disabled(!model.isAuthenticated||model.busy||model.isConnected).accessibilityIdentifier("sync-policy")
                    if model.isConnected{Button("断开连接"){model.disconnect()}.buttonStyle(.borderedProminent).tint(forest)}else{Button("连接"){Task{await model.connect()}}.buttonStyle(.borderedProminent).tint(forest).disabled(!model.isAuthenticated||model.revision==nil||model.busy||model.needsRecovery).accessibilityIdentifier("connect")}
                    if model.busy{ProgressView().controlSize(.small)}
                    Spacer()
                }
                HStack(alignment:.top,spacing:8){Image(systemName:model.isConnected ? "checkmark.circle":"info.circle").foregroundStyle(forest);Text(model.message).font(.system(size:10)).foregroundStyle(.secondary).lineSpacing(4).textSelection(.enabled);Spacer()}
                if model.needsRecovery{Button("恢复网络代理"){model.recover()}.buttonStyle(.bordered).tint(.orange)}
                if model.isConnected{Text("本地代理 127.0.0.1:\(model.localPort) · 每 30 秒校验授权").font(.system(size:9,design:.monospaced)).foregroundStyle(.secondary)}
                Spacer(minLength:0)
            }.padding(30).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading).background(Color(red:0.975,green:0.981,blue:0.975))
        }.foregroundStyle(Color(red:0.11,green:0.19,blue:0.15))
    }
    private func routeName(_ route:String)->String {route.components(separatedBy:" · ").first ?? route}
    private func step(_ number:String,_ title:String,done:Bool)->some View{HStack(spacing:7){Text(done ? "✓":number).font(.system(size:10,weight:.semibold)).frame(width:23,height:23).background(done ? forest.opacity(0.13):Color.gray.opacity(0.08),in:Circle()).foregroundStyle(done ? forest:.secondary);Text(title).font(.system(size:10)).foregroundStyle(done ? forest:.secondary)}.frame(maxWidth:.infinity)}
}
