# Relay 企业连接 · Windows x64

0.1.3 新增应用分流：从开始菜单和注册表发现本机桌面应用，可搜索或浏览补充 .exe，选择全部、仅所选、排除所选。规则按可执行文件完整路径匹配，不区分大小写；独立辅助进程需要另外选择。断开后修改，下次连接生效。列表仅存于本机 `%LOCALAPPDATA%\RelayEnterprise\app-routing.json`，不上传后台，损坏时阻止连接直到重新保存。

只处理进入本地代理的连接，不强制接管忽略系统代理、QUIC/UDP 等直接联网流量。分流模式中无法识别进程的连接默认直连；不是网络隔离策略。目录不是完整的 Microsoft Store/UWP 清单。Windows CI 以实际测试进程发送请求，验证仅所选/排除所选的命中与未命中，另验证路径大小写、正则边界、持久化与损坏设置；不修改 runner 系统代理。

Windows 10 / 11 x64 原生 WPF 客户端，功能与 macOS 0.1.3 对齐。自带 .NET 10 桌面运行时和官方 sing-box 1.13.21，无需员工另外安装 .NET。

产物在 `dist/`：

- `Relay-Enterprise-0.1.3-Windows-x64-Setup.exe`：按当前用户安装的 NSIS 安装程序。
- `Relay-Enterprise-0.1.3-Windows-x64-Portable.zip`：完整解压后运行 `RelayEnterprise.exe`。
- `SHA256SUMS.txt`：两个分发文件的 SHA-256。

默认服务为 `https://vpn-243359801139.asia-east1.run.app`。先完成飞书登录，再按后台分配的资源池同步已发布配置。安装包不含生产飞书凭证、订阅或节点密钥。当前飞书应用的实际可用范围由飞书后台决定。

## 登录与网络

通过默认浏览器授权，使用当前用户 `relay-enterprise` 协议回调和仅当前用户可访问的命名管道把回调送回原实例。客户端验证事务，再携带本机随机 PKCE verifier 兑换一次性票据。任意 URI、重复回调或后台管理员密码不能创建客户端登录状态。

会话仅保存在内存；重开应用需重新飞书登录。设备安装标识和服务地址保存在 `%LOCALAPPDATA%\RelayEnterprise`。节点运行配置只在连接期间写入同一用户专用 ACL 目录，停止和重开时清理。连接/切换前在线校验，连接中每 30 秒维护授权、约每 5 分钟同步。

连接中可手动切换已授权线路，保持本地端口不变，已有连接在新线路重建。首次连接检测逐线路 HTTPS 请求延迟，连接期间每小时更新、最多 4 条并发；检测不会改变当前选择，不可达显示失败状态。

系统代理使用 WinINET 当前用户的连接选项，记录并恢复原代理及自动发现标志；已有 PAC 时拒绝自动接管。它不是 TUN VPN，仅覆盖遵循系统代理的应用。Windows Job Object 在应用退出时停止核心；另有看护进程在异常退出后尝试恢复仍由本实例接管的代理。其他程序变更代理时保留恢复记录，供用户明确恢复。

本版没有 Authenticode 签名。Windows 安装、浏览器回跳、真实账号、系统代理接管/恢复及供应商线路仍需目标 Windows 电脑验收。不要将编译成功等同于这些场景已通过。

## 构建与测试

需要 .NET SDK 10.0.403、Python 3 和 NSIS 3.x；SDK 版本由 `global.json` 指定。核心下载脚本校验官方发布归档 SHA-256，不接受任意未验证的核心。

Windows PowerShell：

```powershell
cd windows-client
./scripts/fetch-core.ps1
$env:RELAY_TEST_CORE = (Resolve-Path .tools/sing-box.exe).Path
dotnet run --project tests/RelayTests.csproj -c Release
./scripts/build.ps1
```

macOS 交叉编译：`sh scripts/build.sh`，可通过 `DOTNET_COMMAND` 和 `MAKENSIS_COMMAND` 指定工具。安装器使用明确的文件清单卸载，不递归删除用户选定的安装目录，也不删除用户设置和代理恢复记录。

`.github/workflows/windows-client.yml` 在 Windows runner 上执行同一套核心测试并打包，产物保留 30 天。测试覆盖 PKCE、URI 事务绑定/单次使用、超时/取消、服务地址限制、一小时缓存、真实核心在线切换、控制接口鉴权及逐线路延迟。延迟集成测试通过隔离回环代理发送两次无凭证 Apple 公开 HTTPS HEAD 请求，需要互联网；Windows 上额外只读验证 WinINET 查询接口，不改变测试机系统代理。

参考：[.NET 10](https://dotnet.microsoft.com/download/dotnet/10.0)、[Windows Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects)、[WinINET 连接设置](https://learn.microsoft.com/windows/win32/api/wininet/nf-wininet-internetsetoptionw)、[sing-box 固定版本](https://github.com/SagerNet/sing-box/releases/tag/v1.13.21)。
