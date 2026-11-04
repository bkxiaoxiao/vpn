# Relay 企业网络管理服务

沿用已确认的后台 UI，提供资源导入、资源池、员工/设备授权、版本发布与回滚、审计和员工流量计量。独立于旧 `gateway/` 单用户项目，不改动现有扩展与 Karing 源码。

## 本地启动

需要 Node.js 24 或更高版本。

```sh
cd enterprise-server
npm ci
node scripts/init-local.mjs
npm run dev
```

访问 [本地后台](http://127.0.0.1:4181)。初始化器生成 `.env` 中的加密密钥，不输出密钥；保留该文件，否则已保存资源无法解密。数据库为 `data/relay.sqlite`。默认无演示员工、节点或虚构流量。

`LOCAL_DEV=true` 仅允许回环地址访问、无需登录；不能用于公网。生产运行要求外部 PostgreSQL、HTTPS、独立数据密钥和至少 16 字符管理员密码；在 `NODE_ENV=production` 或 Cloud Run 中启用开发模式会直接拒绝启动。

## 使用步骤

1. 导入 HTTPS 订阅或粘贴 Clash / sing-box / 节点链接。服务端加密保存地址和节点凭证，列表不返回它们。
2. 创建资源池，选择资源来源。
3. 按企业飞书应用的 `open_id` 添加员工并分配资源池。相同企业、相同名字不等于相同身份。
4. 发布版本，保存当时的节点快照；回滚会生成更高版本。
5. 为员工注册设备，或让已登录员工调用设备注册 API。设备令牌只显示一次。
6. 四个平台客户端使用设备令牌拉取配置，再上报下载、校验和运行生效阶段。

直连模式可直接下发外购节点，但不具备网关计量。资源刷新不会改变已发布的快照，需要发布新版本。当前支持常见独立节点，不能把全部 Clash/sing-box 原配置无损迁移；规则、provider、detour 等依赖不自动导入，部分不支持的节点会提示跳过。已解析不是连通性保证。

## 每位员工的实际使用量

后台增加了“用量统计”，支持今天、近 7 天、本月和自定义日期；员工汇总、上传/下载、设备明细、采样来源与心跳、CSV 导出。员工页面也显示所选区间的流量。

计量路线：

```text
员工客户端（每台设备独立账号）
  → 自有 HTTPS 代理网关（认证、转发、sing-box 用户计数器）
  → 外购订阅节点

网关采集器 → HTTPS 上报 → Cloud Run 控制服务 → PostgreSQL 用量账本
```

必须有一个自有网关承载被计量的流量。Cloud Run 服务用于 Web/API，不作为这里的长期代理流量网关。

- 只记录网关 `v2ray_api` 用户计数器的增量，不采集员工访问的网址、页面或内容。
- 网关用户名是服务端颁发的设备凭证 ID，服务端再关联员工；上报者不能通过请求里的 employeeId 改变归属。
- 每条采样有唯一 ID、开始/结束时间、上传/下载字节；服务端校验凭证归属、时间和数值。
- 同 ID 重试不累加；同 ID 不同内容和同凭证重叠窗口拒绝；整个批次原子写入。
- 采集器先把采样和下次基线一起写入持久文件，再发送；上报成功后清理队列。网络失败不会丢掉尚未确认的批次。
- 同一网关只能运行一个采集器，必须持久挂载 `/data`。未计量不显示假零；零字节采样表示收到了一个真实零增量窗口。
- 统计按采样结束时刻归属区间，不按窗口内时间比例伪造分摊。日期选择使用北京时间；服务端以 ISO UTC 时间保存。
- 这是代理账号的上传 + 下载字节，不是供应商计费、TLS 线路开销或员工整台电脑的所有联网流量。
- 直连外购节点、绕过网关、采集器停机时的流量无法覆盖。核心意外崩溃会损失最后一次采样到崩溃之间的内存计数器；不能宣传为无损账单系统。
- 网关使用 HTTPS CONNECT；首期计量链路以 TCP 为主，不承诺 UDP/QUIC 可用。
- 网关获取不了控制服务时会保留当前配置和已有连接；本版不提供离线自动断网的强制准入保证。

### 部署计量网关

在后台注册网关，端口推荐 **8443**，保存只显示一次的 ID 和 Token。需要自有 Linux 主机、域名和可信 TLS 证书。

`collector/Dockerfile` 从固定 `sing-box v1.13.21` 源码构建，启用 `with_v2ray_api`、QUIC 与 uTLS。普通发行包可能不含 V2Ray API，不能直接替换。该 API 只监听容器回环地址。

在 `collector/` 目录创建私有 `.env`：

```dotenv
CONTROL_URL=https://你的控制服务域名
GATEWAY_TOKEN=后台注册后显示的网关令牌
CERT_DIRECTORY=/绝对路径/证书目录
```

证书目录内需要 `fullchain.pem` 和 `privkey.pem`，且容器 UID 1000 能读取。创建 `collector/data` 并使 UID 1000 可写，然后：

```sh
cd collector
mkdir -p data
# 在 Linux 部署主机上设置目录所有者；不要让密钥对所有人可读。
sudo chown 1000:1000 data
docker compose up -d --build
```

`.env`、证书、状态文件均不得提交。防火墙仅开放 8443。不要开放计数器端口 10085。

采集器管理 sing-box 子进程：拉取配置 → 核心校验 → 应用 → 探测计数器 API → 确认配置 → 周期采样。节点与授权变更在下一周期拉取后应用（默认 30 秒），重启核心会断开现有连接。网关心跳超过 180 秒时停止下发新的网关客户端配置。停用员工会从下一份网关配置移除账号；这不同于停用外购共享凭证。

为员工注册设备时绑定此网关，确认网关已应用设备配置后，再在设置中切换“企业网关转发”。首版网关在员工授权节点间自动选择线路，不提供每员工交互式切换上游线路。

## 飞书登录

配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TENANT_KEY`；管理员身份额外填入 `FEISHU_ADMIN_IDS`（逗号分隔，使用本应用 open_id）。在飞书后台把以下 URL 加入回调白名单：

```text
https://你的控制服务/auth/feishu/callback
```

使用 `/auth/feishu/start` 发起登录。服务端验证一次性 state、会话 cookie 与企业 tenant，兑换 code 并获取用户身份。已授权员工可注册设备，只有管理员能操作后台。

未配置凭证时明确报“尚未配置”，不假装已连接。管理员可在“飞书集成”配置应用并手动同步部门、员工；部门自动授权和离职事件订阅尚未实现，新员工仍需管理员授权。独立 macOS 0.1.1 客户端已验证真实飞书登录、默认浏览器交接、原生回调与设备会话绑定；未分配/发布线路时连接仍禁用。当前 Karing 工程的缺失源码问题仍未解决。

## API

管理员浏览器使用 HttpOnly/SameSite cookie；写操作校验 Origin。生产密码由环境变量提供，登录有失败次数限制。不要把管理员密码传给员工客户端。

| 接口 | 作用 |
| --- | --- |
| `GET /health` | 数据库健康检查 |
| `POST /api/auth/login` | 管理员密码登录 |
| `GET /api/bootstrap` | 脱敏后台数据 |
| `POST /api/resources` | 导入 URL 或配置内容 |
| `POST /api/resources/refresh` | 刷新全部订阅，失败保留已有配置 |
| `POST /api/pools`, `PUT /api/pools/:id` | 资源池管理 |
| `POST /api/employees`, `PUT /api/employees/:id` | 员工授权与停用 |
| `POST /api/employees/:id/devices` | 管理员代注册设备 |
| `DELETE /api/devices/:id` | 撤销设备与令牌 |
| `POST /api/releases` | 发布或用 rollbackId 回滚 |
| `GET /api/usage?from=ISO&to=ISO` | 指定区间的员工/设备用量 |
| `PUT /api/settings` | 工作空间与分发策略 |
| `POST /api/gateways` | 注册网关并返回一次性令牌 |
| `POST /api/client/devices` | 飞书员工会话注册设备 |
| `GET /api/client/policy` | 设备令牌获取获授权配置 |
| `POST /api/client/ack` | 设备确认 revision 和 stage |
| `GET /api/gateway/config` | 网关专用令牌获取配置 |
| `POST /api/gateway/ack` | 网关确认已运行的配置摘要 |
| `POST /api/gateway/usage` | 网关专用令牌上报增量采样 |
| `POST /api/jobs/refresh` | JOB_TOKEN 触发订阅刷新 |

计量请求示例（令牌与 ID 使用占位符）：

```json
{
  "events": [{
    "eventId": "唯一且重试不变的ID",
    "credentialId": "服务端颁发的设备凭证ID",
    "startedAt": "2026-11-04T01:00:00Z",
    "endedAt": "2026-11-04T01:00:30Z",
    "uploadBytes": 1024,
    "downloadBytes": 4096
  }]
}
```

网关令牌不能访问管理员接口，员工令牌不能上报计量。禁止直接使用客户端自报流量代替网关计数器。

## Google Cloud Run

提供根目录和子目录两种构建入口、锁定的 npm 依赖和 `deploy/cloud-run.sh`。部署前应配置外部 PostgreSQL 与 Secret Manager，实际部署状态以目标 Cloud Run 修订为准。

1. 准备 PostgreSQL / Cloud SQL 数据库与最小权限业务账号。服务启动会创建所需表；数据库账号需要首次建表权限。
2. 在 Secret Manager 创建脚本引用的密钥版本，生产 DATA_KEY 为独立 32 字节随机数的十六进制表示。使用 Cloud SQL Unix Socket 连接字符串，避免在命令行明文传入密码。
3. 服务账号需要 Cloud SQL Client 和仅对应密钥的读取权限。明确 Cloud SQL 区域、备份和连接数预算。
4. 在 `enterprise-server/` 设置 `PROJECT_ID`、`REGION`、`SERVICE_ACCOUNT`、`SQL_INSTANCE`、`PUBLIC_BASE_URL` 后运行 `sh deploy/cloud-run.sh`。脚本允许公共 HTTP 入口以接收飞书回调，业务接口由应用自行鉴权。
5. Cloud Scheduler 使用 POST 请求和独立 `Authorization: Bearer JOB_TOKEN`，定期调用 `/api/jobs/refresh`（例如每 5 分钟，服务端按后台设置判断刷新是否到期）。不要把令牌放 URL 或日志。首版任务同步执行，订阅数量多时需拆分任务或延长/调整调度。
6. 验证登录、数据库读写、授权、飞书回调和网关采样后，再让员工使用。容器读写不依赖实例本地持久文件；健康检查为 `/health`。

控制服务监听 `0.0.0.0:$PORT`，TLS 由 Cloud Run 终止。SIGTERM 会关闭监听并释放数据库。资源和版本中的节点密钥采用 AES-256-GCM 应用层加密；加密密钥轮换需要迁移旧数据，首版尚未提供自动轮换工具。

数据库用独立文档记录保存业务实体，单个实例内排队写入，PostgreSQL 事务使用 advisory lock 跨实例串行化关键变更；用量事件单独建表、去重和建立员工/网关时间索引。适用于首期小团队，尚无高并发压测或大规模计量归档任务。

## 验证与限制

```sh
npm test
node --check server.mjs
node --check public/app.js
node --check collector/agent.mjs
```

已验证：18 项测试（资源解析、SSRF 地址限制、加密脱敏、用量幂等/冲突/原子回滚、跨网关凭证限制、设备停用、版本回滚、客户端配置授权、SQLite 重启持久化、HTTP 登录与权限隔离、真实 sing-box 分流配置校验）。

本机 Homebrew sing-box 没有 `with_v2ray_api`，真实核心校验时排除了计量 API 配置；因此不能据此声称完成了真实网关端到端流量验证。首次本地开发时没有 Docker / PostgreSQL 服务；此限制不代表后续云端验证状态。镜像构建和数据库配置应以部署记录为准。生产上线前还需使用带计量支持的核心、真实节点与飞书身份联调。

官方参考：[Cloud Run 容器约定](https://docs.cloud.google.com/run/docs/container-contract)、[sing-box V2Ray API](https://sing-box.sagernet.org/configuration/experimental/v2ray-api/)、[固定版本计量实现](https://github.com/SagerNet/sing-box/blob/v1.13.21/experimental/v2rayapi/stats.go)、[飞书用户令牌](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)。

浏览器验收：在隔离的内存数据库走通资源导入、资源池创建、员工授权、版本发布、采样 API 到用量页面与设备明细；测试流量为合成样本，未写入正式本地数据库，也不代表真实外购节点流量验证。

## macOS 严格飞书客户端（2026-11-04 更新）

新增 `../mac-client` 原生 macOS 测试安装包及桌面登录协议：

- `POST /api/desktop/auth/start`：创建绑定 challenge 的桌面登录事务。
- `GET /auth/desktop/start`：建立浏览器 OAuth state cookie 并跳转飞书。
- 飞书回调后签发短期一次性交接票据，返回固定 `relay-enterprise://auth/callback`。
- `POST /api/desktop/auth/exchange`：校验原客户端 verifier，签发真实飞书来源的设备会话。
- `GET /api/client/status`、`POST /api/client/logout`：在线授权检查与会话撤销。

所有 `/api/client/*` 均强制要求 `authMethod=feishu` 且认证时间仍有效。本机开发管理员默认绕过不适用于客户端接口；管理员手动签发的设备令牌不能获取策略。此前“管理员注册设备后直接用令牌拉配置”的测试步骤已被此限制替代。飞书 App Secret 仍只放在服务端。

目前共 23 项测试通过；桌面协议测试使用代码层注入的测试上游响应，未向应用或 HTTP 服务提供演示认证后门。真实飞书应用尚未配置，安装包因此维持锁定。

## 仓库根目录构建入口

通过 Cloud Run 控制台关联本仓库时，可以使用默认的根目录 `Dockerfile`，构建上下文为仓库根目录。它只复制 `enterprise-server` 的运行依赖与源码；`.dockerignore` 采用白名单，避免将本地凭证、数据库、macOS 构建产物或 Karing 参考源码送入镜像。

如果手动进入 `enterprise-server/` 后执行 `gcloud run deploy --source .`，则使用该目录原有的 Dockerfile。不能在根目录上下文中直接使用子目录 Dockerfile 而不调整 COPY 路径。

只构建和测试、不部署的配置：`enterprise-server/deploy/cloud-build-verify.yaml`，需要传入 `_IMAGE`。构建成功后，生产服务还必须配置 PostgreSQL、DATA_KEY、ADMIN_PASSWORD 与 PUBLIC_BASE_URL，不能用 LOCAL_DEV 绕过生产鉴权和持久化。

默认部署服务名与密钥前缀均为 `vpn`，可通过 SERVICE_NAME / SECRET_PREFIX 覆盖。飞书凭证可在创建应用后另行绑定，不作为管理后台启动的必要条件；客户端仍会拒绝没有真实飞书认证的配置请求。Cloud SQL Unix Socket 连接字符串应保留 `@localhost/数据库名`，再使用 `?host=/cloudsql/项目:区域:实例` 指定实际连接目录。

线上健康检查统一使用 `/health`。容器仍保留 `/healthz` 兼容本机检查，但 Cloud Run 公网入口可能拦截该保留路径；不要将公网监控指向它。

## 飞书集成配置与通讯录同步

后台新增左侧“飞书集成”入口，“员工与设备”和“工作空间设置”也可进入。管理员填写 App ID、App Secret、tenant_key 与同步根部门后保存，再进行“检查连接”和“同步员工”。页面显示本服务的完整 HTTPS 回调地址、只读权限说明、同步结果与部门列表。

App Secret 使用 DATA_KEY 对称加密后保存到数据库，不回显、不写入日志、员工配置或浏览器本地存储；留空表示保留已有密钥。后台保存的集成配置优先于 FEISHU_* 环境变量，所有实例在后续认证请求时读取最新配置，无需重启。修改配置会使旧飞书会话和未完成授权事务失效；管理员密码登录仍可用于恢复配置。存在员工时不能直接更换应用或企业，避免把不同应用的 open_id 混为同一身份。

推荐按所用 API 开通只读权限：contact:contact.base:readonly、contact:user.base:readonly、contact:user.department:readonly、contact:department.base:readonly、contact:department.organize:readonly。按实际飞书后台对应 API 的权限要求核对，部分权限有替代关系；不需要邮箱、手机或写通讯录权限。应用须发布，应用可用范围与通讯录可访问数据范围必须覆盖需要同步的员工。默认根部门 0 需要全员读取范围；只同步部分部门时填写其 open_department_id。tenant_key 从飞书用户身份接口响应获取，不是数字企业 ID。

同步按部门分页、对跨部门员工按 open_id 去重，仅保存姓名、部门、身份和必要状态。新员工默认待授权；已有人保持原员工记录和资源池，手动停用不会自动恢复。明确离职、冻结、未加入或不再可见的已同步员工会被停用，并撤销设备和会话；不会删除员工历史用量。读接口失败、权限不足、分页异常或同步期间配置变化时，整批不写入。同步有跨实例互斥锁，批量数据库写入减少跨区域往返。

该同步是管理员手动触发，不是实时事件订阅。单次最多 500 个部门、10000 位员工，拉取截止时间约 2 分钟；规模较大时应缩小根部门范围。真实企业凭证尚未配置时不能声称已完成真实通讯录联调。

新增管理员接口：GET/PUT /api/feishu/config、POST /api/feishu/check、POST /api/feishu/sync。GET 和 bootstrap 只返回脱敏配置与状态。当前共 32 项测试通过，新增覆盖配置加密、动态生效、分页去重、空末页省略 items 的兼容、授权保留、离职和可见范围撤权、失败原子性及管理员隔离。缺失分页结束标记或返回错误类型的 items 时仍中止整批同步。
