# 远程 HTTPS/SOCKS 节点网关

网关在服务器运行 sing-box，通过一个受保护的 HTTPS 控制 API 接收节点选择，并对 Chrome 暴露标准 HTTPS Proxy。当前版本是单用户部署：所有连接共用一个当前节点，切换节点时会短暂重启 sing-box 并中断已有代理连接。

## 服务器要求

- 一台有公网 IPv4/IPv6 的 Linux 服务器。
- Docker Engine 与 Docker Compose。
- 一个解析到服务器的域名，例如 `proxy.example.com`。
- 域名的可信 TLS 证书和私钥。
- 防火墙开放 TCP 443 和 TCP 8443。

HTTPS Proxy 的证书必须受 Chrome 信任并覆盖代理域名；不要使用自签名证书。

## 1. 准备证书

可以使用 Certbot、acme.sh 或现有反向代理取得证书。以 Let's Encrypt 为例，最终需要两个文件：

```text
/etc/letsencrypt/live/proxy.example.com/fullchain.pem
/etc/letsencrypt/live/proxy.example.com/privkey.pem
```

## 2. 配置环境

在服务器进入项目的 `gateway` 目录：

```sh
cp .env.example .env
```

编辑 `.env`：

```dotenv
PUBLIC_PROXY_HOST=proxy.example.com
PUBLIC_PROXY_PORT=443
PUBLIC_API_PORT=8443

TLS_CERT_FILE=/etc/letsencrypt/live/proxy.example.com/fullchain.pem
TLS_KEY_FILE=/etc/letsencrypt/live/proxy.example.com/privkey.pem

GATEWAY_API_TOKEN=<随机 API Token>
PROXY_USERNAME=<代理用户名>
PROXY_PASSWORD=<随机代理密码>

EXTENSION_ORIGIN=chrome-extension://pinmpjcfbiejgkhccadaffmicjoodpje
```

可以生成两个独立的随机值：

```sh
openssl rand -hex 32
openssl rand -hex 32
```

不要把 `.env`、订阅链接、节点密码或证书私钥提交到 Git。

## 3. 启动网关

```sh
docker compose up -d --build
```

查看状态和日志：

```sh
docker compose ps
docker compose logs --tail=100 gateway
```

未选择节点前，控制 API 会正常运行，但 443 代理端口暂时没有监听。扩展第一次选择节点后，sing-box 会启动 HTTPS Proxy。

## 4. 检测控制 API

```sh
curl https://proxy.example.com:8443/v1/status \
  -H "Authorization: Bearer <API Token>"
```

正常响应包含 `status` 和 `proxy`。`status.running` 在尚未选择节点时为 `false`。

## 5. 配置 Chrome 扩展

在扩展的“订阅与设置”页面填写：

| 字段 | 示例 |
| --- | --- |
| 控制 API 地址 | `https://proxy.example.com:8443` |
| API Token | `.env` 中的 `GATEWAY_API_TOKEN` |
| HTTPS 代理域名 | `proxy.example.com` |
| 端口 | `443` |
| 代理用户名 | `.env` 中的 `PROXY_USERNAME` |
| 代理密码 | `.env` 中的 `PROXY_PASSWORD` |

点击“保存并检测”，成功后再添加订阅。

## API

除健康检查外，所有接口要求：

```http
Authorization: Bearer <GATEWAY_API_TOKEN>
```

- `GET /v1/health`：容器健康检查。
- `GET /v1/status`：代理核心和当前节点状态。
- `POST /v1/subscriptions/refresh`：服务器端获取并解析订阅。
- `POST /v1/nodes/select`：校验节点、生成配置并切换 sing-box。

控制 API 仅对配置的 Chrome 扩展 Origin 返回 CORS 许可。命令行请求不带 Origin 时仍可使用 Token 调试。

## 安全建议

- API Token 和代理密码使用不同的高强度随机值。
- 8443 端口可以进一步通过云防火墙限制为你的固定公网 IP。
- 不要暴露 Docker Socket，也不要给容器 `NET_ADMIN`。
- Compose 已删除全部 Linux capabilities、启用只读根文件系统和 `no-new-privileges`。
- 默认拒绝获取解析到环回、私网、链路本地和运营商 NAT 地址的订阅 URL。
- 为证书续期后执行 `docker compose restart gateway`，让控制 API 重新载入证书；sing-box 会在下次选择节点时重新读取证书。

## 更新

```sh
docker compose build --pull
docker compose up -d
```
