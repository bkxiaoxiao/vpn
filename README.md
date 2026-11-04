# Relay 企业网络管理

企业订阅与节点统一管理、飞书身份授权、员工配置分发，以及独立网关的员工/设备流量计量。

## 项目入口

| 目录 | 用途 |
| --- | --- |
| [enterprise-server](enterprise-server/README.md) | 可运行的管理后台与控制 API、SQLite/PostgreSQL、Cloud Run 部署文件 |
| [mac-client](mac-client/README.md) | SwiftUI 原生 macOS 客户端、严格飞书登录、sing-box 系统代理模式及 DMG 构建 |
| [enterprise-admin](enterprise-admin/README.txt) | 最初的交互 UI 原型，使用演示数据 |
| [gateway](gateway/README.md) / extension | 早期 Chrome 扩展与单用户远程网关 |
| karing | 上游 Karing 源码参考，作为子模块固定在 `4faa4a0965097b637f900e5639512e5ed41ec3b8` |

## 企业服务本地运行

需要 Node.js 24+：

```sh
cd enterprise-server
npm ci
node scripts/init-local.mjs
npm run dev
```

访问 `http://127.0.0.1:4181`。在“飞书集成”中保存应用信息、检查连接并同步员工，再到“员工与设备”授权和分配资源池。本地管理员开发入口仅用于管理面板；员工配置接口始终要求经过飞书验证的设备会话。

## macOS 构建与登录

在 Apple Silicon Mac 上安装 Xcode 和 arm64 sing-box 后：

```sh
sh mac-client/scripts/build.sh
```

输出在 `mac-client/dist/`。客户端未登录时不能同步或连接，不包含默认订阅或真实节点。真实使用前需创建飞书自建应用、设置服务端凭证、配置员工权限并发布配置。当前版本为原生系统代理测试客户端，不是 Karing 的完整构建或全设备 TUN VPN。

## 员工使用量

通过独立企业网关按设备账号采集上传/下载字节，并在后台按员工、设备与日期汇总。直连外购节点没有可信的员工计量，界面会显示暂无采样。详见企业服务的网关部署说明。

## 验证与部署状态

企业服务 33 项测试通过，包括强制飞书来源、一次性桌面票据、Windows/macOS 设备身份、用量幂等、权限隔离与飞书空分页兼容。macOS 0.1.2 提供在线切换线路与每小时延迟检测；12 组原生检查通过。新增 [Windows x64 客户端](windows-client/README.md)，提供独立运行时、安装器、便携包和相同的飞书/线路功能。Mac 已验证真实飞书浏览器授权和原生回调，Windows 实机安装与登录、供应商线路及网关计量仍需按实际配置验收。Cloud Run 使用根目录 Dockerfile，生产环境必须通过密钥配置外部 PostgreSQL。

此仓库不包含真实 `.env`、供应商订阅、数据库、证书私钥、安装包、依赖或构建缓存。请按 `.env.example` 配置，勿提交真实凭证。

## 上游参考与许可

普通开发不需要下载 Karing 子模块。如需复现源码审计：

```sh
git submodule update --init karing
python3 tools/audit_karing.py
```

Karing 与 sing-box 的许可及品牌限制须按各自上游文件遵守；本项目的企业测试客户端不表示与 Karing 官方存在关联。仓库没有包含 sing-box 二进制，构建时从本机指定路径复制，许可与核心版本信息会随测试包附带。

---

# 历史组件：节点订阅助手（单用户远程网关）

这是一个不依赖本机代理程序的 Chrome 扩展。Shadowsocks/VLESS 协议运行在你自己的远程服务器上，Chrome 直接连接服务器提供的 HTTPS 代理。

```text
Chrome 扩展
  ├─ HTTPS 控制 API：更新订阅、选择节点
  └─ HTTPS Proxy：浏览器流量
            ↓
      远程 sing-box 网关
            ↓
      Shadowsocks / VLESS 节点
```

## 目录

- `extension/`：Chrome Manifest V3 扩展。
- `gateway/`：Node.js 控制 API、sing-box 管理器和 Docker 部署文件。
- `native-host/`：早期本机桥接版本，仅留作参考；当前扩展不再声明或使用 `nativeMessaging`。

## 当前功能

- 纯文本和 Base64 `ss://`、`vless://` 订阅。
- 服务器端获取并解析订阅，避免浏览器 CORS 限制。
- VLESS TLS、Reality、TCP、WS、gRPC、HTTP、HTTPUpgrade、QUIC。
- HTTPS 代理 TLS 加密与用户名/密码认证。
- 控制 API Bearer Token 鉴权。
- 扩展自动响应 Chrome 的代理认证请求。
- 手动和定时更新订阅、远程切换节点。
- 默认阻止订阅 URL 访问服务器内网地址，降低 SSRF 风险。

Clash YAML、VMess、Trojan、Hysteria、VLESS XHTTP/KCP 暂未支持。

## 开始使用

1. 按照 [gateway/README.md](gateway/README.md) 在 Linux 服务器部署网关。
2. 打开 `chrome://extensions`，开启开发者模式。
3. 选择“加载已解压的扩展程序”，加载本项目的 `extension` 文件夹。
4. 打开扩展设置页，填写网关 API、Token 和 HTTPS 代理凭据。
5. 添加订阅，选择节点并连接。

扩展固定 ID 为 `pinmpjcfbiejgkhccadaffmicjoodpje`，网关默认只允许这个扩展来源调用控制 API。

## 开发验证

```sh
npm test
npm run check
```

项目本身没有 npm 运行时依赖。

## 企业管理后台

新增独立的 [Relay 企业控制服务](enterprise-server/README.md)，包含订阅/节点管理、资源池、员工与设备授权、配置版本，以及按员工和设备汇总的网关流量计量。沿用已确认 UI，提供本地 SQLite 与 Cloud Run 所需 PostgreSQL 配置；不替换上面的旧单用户浏览器网关。
