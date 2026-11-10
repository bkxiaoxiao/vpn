import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct AppRoutingView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft = AppRoutingSettings()
    @State private var catalog: [LocalApplication] = []
    @State private var search = ""
    @State private var error = ""
    private var rows: [LocalApplication] {
        Array(Dictionary((catalog + draft.applications).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first }).values)
            .filter { search.isEmpty || ($0.name + " " + $0.path).localizedCaseInsensitiveContains(search) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("应用分流").font(.title2.bold())
            Text("仅对进入本地代理的连接生效。不遵循系统代理的软件不会自动接管；无法识别进程的连接默认直连。").font(.callout).foregroundStyle(.secondary)
            Picker("代理范围", selection: $draft.mode) { ForEach(AppRoutingMode.allCases, id: \.self) { Text($0.title).tag($0) } }
            HStack { TextField("搜索本机应用或路径", text: $search).textFieldStyle(.roundedBorder); Button("浏览添加…", action: browse); Button("刷新列表", action: scan) }
            List(rows) { app in
                Toggle(isOn: Binding(get: { draft.applications.contains(where: { $0.path == app.path }) }, set: { checked in
                    draft.applications.removeAll { $0.path == app.path }; if checked { draft.applications.append(app) }
                })) {
                    HStack { Image(nsImage: NSWorkspace.shared.icon(forFile: app.path)).resizable().frame(width: 28, height: 28)
                        VStack(alignment: .leading) { Text(app.name); Text(app.path).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        if !FileManager.default.fileExists(atPath: app.path) { Text("已移除").font(.caption).foregroundStyle(.orange) }
                    }
                }.toggleStyle(.checkbox).disabled(draft.mode == .all)
            }.frame(minHeight: 240)
            HStack { Text("已选择 \(draft.applications.count) 个应用"); Spacer(); Button("清空选择") { draft.applications = [] }.disabled(draft.mode == .all) }.font(.caption)
            Text("Mac 按应用包路径匹配，含包内辅助进程；共享或包外网络进程需另选可执行文件。设置仅保存在本机，保存后下次连接生效。").font(.caption).foregroundStyle(.secondary)
            if !error.isEmpty { Text(error).foregroundStyle(.red).font(.callout) }
            HStack { Spacer(); Button("取消") { dismiss() }; Button("保存设置") { do { try model.saveAppRouting(draft); dismiss() } catch { self.error = (error as? RelayFailure)?.message ?? "无法保存设置，请重试" } }.buttonStyle(.borderedProminent) }
        }.padding(24).frame(width: 650, height: 570).onAppear { draft = model.appRouting; scan() }
    }
    private func scan() {
        var apps: [LocalApplication] = []
        for root in ["/Applications", NSHomeDirectory() + "/Applications", "/System/Applications"] {
            guard let list = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in list where url.pathExtension.lowercased() == "app" {
                if let app = try? LocalApplication.from(url) { apps.append(app) }
            }
        }
        catalog = apps
    }
    private func browse() {
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true; panel.allowedContentTypes = [.applicationBundle, .executable]
        guard panel.runModal() == .OK else { return }
        do { for url in panel.urls { let app = try LocalApplication.from(url); catalog.append(app); if !draft.applications.contains(where: { $0.path == app.path }) { draft.applications.append(app) } } }
        catch { self.error = "请选择已安装的 .app 或可执行文件" }
    }
}
