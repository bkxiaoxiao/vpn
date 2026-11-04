import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { parseDocument } from "yaml";
import { createHash } from "node:crypto";
import { fail } from "./security.mjs";

export function isPublicIp(ip) {
  const x = ip.toLowerCase();
  if (net.isIPv4(x)) {
    const [a, b, c] = x.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 88)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0)
    );
  }
  // Only global unicast IPv6; deny mapped IPv4, documentation and transition ranges.
  return (
    net.isIPv6(x) &&
    /^[23]/.test(x) &&
    !x.startsWith("2001:db8") &&
    !x.startsWith("2002:") &&
    !x.startsWith("2001:0:")
  );
}
export async function fetchSubscription(input, redirects = 0) {
  let u;
  try {
    u = new URL(input);
  } catch {
    fail("订阅地址无效");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    fail("订阅地址仅支持无用户名密码的 HTTPS URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicIp(a.address)))
    fail("订阅目标不是允许的公网地址");
  // Pin the validated address for the request; prevent DNS rebinding between validation and connect.
  const a = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const req = https.get(
      u,
      {
        lookup: (_h, _o, cb) => cb(null, a.address, a.family),
        family: a.family,
        agent: false,
        headers: {
          "user-agent": "Clash.Meta Relay/0.1",
          accept: "text/plain, application/json, application/yaml",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            res.destroy();
            reject(new Error("订阅超过 2 MB"));
          } else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            code: res.statusCode,
            location: res.headers.location,
            text: Buffer.concat(chunks).toString(),
          }),
        );
        res.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("订阅请求超时")),
      15000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", () =>
      reject(new Error("订阅请求失败，请检查供应商地址与证书")),
    );
  });
  if ([301, 302, 303, 307, 308].includes(response.code)) {
    if (redirects >= 3 || !response.location) fail("订阅重定向无效");
    return fetchSubscription(
      new URL(response.location, u).toString(),
      redirects + 1,
    );
  }
  if (response.code !== 200) fail(`订阅返回 HTTP ${response.code}`);
  return response.text;
}
const supported = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "hysteria2",
  "tuic",
  "http",
  "socks",
]);
export function parseNodes(content) {
  let body = String(content).trim();
  if (!body) fail("订阅内容为空");
  if (
    !body.includes("://") &&
    !body.startsWith("{") &&
    !body.includes("proxies:")
  ) {
    const decoded = Buffer.from(
      body.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString();
    if (decoded.includes("://")) body = decoded;
  }
  let nodes = [],
    warnings = [];
  if (body.startsWith("{")) {
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      fail("sing-box JSON 无效");
    }
    if (!Array.isArray(j.outbounds)) fail("sing-box 缺少 outbounds");
    for (const o of j.outbounds) {
      if (!supported.has(o.type)) continue;
      const allowed = [
        "type",
        "tag",
        "server",
        "server_port",
        "method",
        "password",
        "uuid",
        "security",
        "alter_id",
        "flow",
        "tls",
        "transport",
        "network",
        "username",
        "version",
        "congestion_control",
        "udp_relay_mode",
        "zero_rtt_handshake",
        "heartbeat",
        "up_mbps",
        "down_mbps",
        "obfs",
      ];
      const clean = Object.fromEntries(
        allowed.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
      );
      if (o.detour) fail("暂不支持依赖 detour 的节点，请导入独立节点");
      nodes.push(clean);
    }
  } else if (/(^|\n)\s*proxies\s*:/.test(body)) {
    const doc = parseDocument(body, { uniqueKeys: true });
    if (doc.errors.length) fail("Clash YAML 解析失败");
    let data;
    try {
      data = doc.toJS({ maxAliasCount: 20 });
    } catch {
      fail("Clash YAML 别名过多");
    }
    if (!Array.isArray(data?.proxies)) fail("Clash 缺少 proxies");
    for (const p of data.proxies) {
      try {
        nodes.push(fromClash(p));
      } catch {
        warnings.push(`部分节点的协议或参数暂不支持`);
      }
    }
  } else {
    for (const line of body.split(/\r?\n/).filter((s) => s.trim())) {
      try {
        nodes.push(fromUri(line.trim()));
      } catch {
        warnings.push("部分节点链接暂不支持或格式无效");
      }
    }
  }
  nodes = nodes.filter((n) => n && supported.has(n.type));
  if (!nodes.length) fail("没有可用节点：支持 Clash、sing-box 和常用节点链接");
  if (nodes.length > 2000) fail("单个资源最多 2000 个节点");
  const seen = new Set();
  nodes = nodes
    .map((n, i) => {
      if (
        typeof n.server !== "string" ||
        !n.server ||
        !Number.isInteger(n.server_port) ||
        n.server_port < 1 ||
        n.server_port > 65535
      )
        fail("节点服务器或端口无效");
      for (const k of {
        shadowsocks: ["method", "password"],
        vmess: ["uuid"],
        vless: ["uuid"],
        trojan: ["password"],
        hysteria2: ["password"],
        tuic: ["uuid", "password"],
      }[n.type] || []) {
        if (typeof n[k] !== "string" || !n[k] || n[k] === "undefined")
          fail("节点缺少必要的协议凭证");
      }
      const serialized = JSON.stringify(n);
      if (
        serialized.length > 16000 ||
        /("(?:path|certificate_path|key_path|private_key_path|ca_path)"\s*:)/.test(
          JSON.stringify(n.tls || {}),
        )
      )
        fail("节点含不允许的本地文件引用");
      const tag = String(n.tag || `节点 ${i + 1}`).slice(0, 150);
      n.tag = tag;
      const key = createHash("sha256")
        .update(JSON.stringify(n))
        .digest("hex")
        .slice(0, 20);
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        id: key,
        name: tag,
        protocol: n.type,
        server: n.server,
        port: n.server_port,
        outbound: n,
      };
    })
    .filter(Boolean);
  return { nodes, warnings: [...new Set(warnings)] };
}
function fromClash(p) {
  if (!p || typeof p !== "object") throw Error();
  const type =
    {
      ss: "shadowsocks",
      socks5: "socks",
      hysteria2: "hysteria2",
      hy2: "hysteria2",
    }[p.type] || p.type;
  if (!supported.has(type) || p.plugin || p["dialer-proxy"]) throw Error();
  const o = {
    type,
    tag: p.name,
    server: p.server,
    server_port: Number(p.port),
  };
  if (type === "shadowsocks") {
    o.method = p.cipher;
    o.password = String(p.password);
  }
  if (["vmess", "vless", "tuic"].includes(type)) o.uuid = p.uuid;
  if (
    ["trojan", "hysteria2", "tuic", "http", "socks"].includes(type) &&
    p.password !== undefined
  )
    o.password = String(p.password);
  if (["http", "socks"].includes(type) && p.username) o.username = p.username;
  if (type === "vmess") {
    o.security = p.cipher || "auto";
    o.alter_id = Number(p.alterId || 0);
  }
  if (p.flow) o.flow = p.flow;
  if (p.tls || ["trojan", "hysteria2", "tuic"].includes(type)) {
    o.tls = {
      enabled: true,
      server_name: p.servername || p.sni || p.server,
      insecure: !!p["skip-cert-verify"],
    };
    if (p.alpn) o.tls.alpn = p.alpn;
    if (p["client-fingerprint"])
      o.tls.utls = { enabled: true, fingerprint: p["client-fingerprint"] };
    if (p["reality-opts"])
      o.tls.reality = {
        enabled: true,
        public_key: p["reality-opts"]["public-key"],
        short_id: p["reality-opts"]["short-id"] || "",
      };
  }
  if (p.network && p.network !== "tcp") {
    if (p.network === "ws")
      o.transport = {
        type: "ws",
        path: p["ws-opts"]?.path || "/",
        headers: p["ws-opts"]?.headers || {},
      };
    else if (p.network === "grpc")
      o.transport = {
        type: "grpc",
        service_name: p["grpc-opts"]?.["grpc-service-name"] || "",
      };
    else throw Error();
  }
  return o;
}
function fromUri(line) {
  if (line.startsWith("ss://")) {
    let raw = line.slice(5).split("#")[0].split("?")[0];
    if (line.includes("plugin=")) throw Error();
    if (!raw.includes("@")) raw = Buffer.from(raw, "base64").toString();
    const at = raw.lastIndexOf("@");
    let creds = raw.slice(0, at);
    if (!creds.includes(":")) creds = Buffer.from(creds, "base64").toString();
    const i = creds.indexOf(":"),
      a = new URL("http://" + raw.slice(at + 1));
    return {
      type: "shadowsocks",
      tag: decodeURIComponent(line.split("#")[1] || "Shadowsocks"),
      server: a.hostname,
      server_port: Number(a.port),
      method: creds.slice(0, i),
      password: creds.slice(i + 1),
    };
  }
  const u = new URL(line),
    type = u.protocol.slice(0, -1);
  if (
    !["vless", "trojan", "hysteria2", "http", "https", "socks"].includes(type)
  )
    throw Error();
  const o = {
    type: type === "https" ? "http" : type,
    tag: decodeURIComponent(u.hash.slice(1)) || type,
    server: u.hostname.replace(/^\[|\]$/g, ""),
    server_port: Number(u.port) || { http: 80, https: 443 }[type],
  };
  if (type === "vless") {
    o.uuid = decodeURIComponent(u.username);
    if (u.searchParams.get("flow")) o.flow = u.searchParams.get("flow");
  } else if (["trojan", "hysteria2"].includes(type))
    o.password = decodeURIComponent(u.username);
  else {
    o.username = decodeURIComponent(u.username);
    o.password = decodeURIComponent(u.password);
  }
  const s = u.searchParams,
    security = s.get("security");
  if (
    ["trojan", "hysteria2", "https"].includes(type) ||
    ["tls", "reality"].includes(security)
  ) {
    o.tls = { enabled: true, server_name: s.get("sni") || u.hostname };
    if (security === "reality")
      o.tls.reality = {
        enabled: true,
        public_key: s.get("pbk"),
        short_id: s.get("sid") || "",
      };
    if (s.get("fp")) o.tls.utls = { enabled: true, fingerprint: s.get("fp") };
  }
  if (s.get("type") === "ws")
    o.transport = {
      type: "ws",
      path: s.get("path") || "/",
      headers: s.get("host") ? { Host: s.get("host") } : {},
    };
  else if (s.get("type") === "grpc")
    o.transport = { type: "grpc", service_name: s.get("serviceName") || "" };
  else if (s.has("type") && s.get("type") !== "tcp") throw Error();
  return o;
}
