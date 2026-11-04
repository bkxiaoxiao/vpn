import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export class SingBoxManager {
  constructor(config) {
    this.config = config;
    this.process = null;
    this.stopping = false;
    this.selectedNode = null;
    this.lastError = "";
    this.logLines = [];
    this.operation = Promise.resolve();
    this.configPath = path.join(config.dataDir, "sing-box.json");
    this.nodePath = path.join(config.dataDir, "selected-node.json");
  }

  async initialize() {
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    try {
      this.selectedNode = JSON.parse(await fs.readFile(this.nodePath, "utf8"));
      await this.applyNode(this.selectedNode);
    } catch (error) {
      if (error.code !== "ENOENT") this.lastError = error.message;
    }
  }

  async selectNode(node) {
    this.operation = this.operation.then(() => this.applyNode(node));
    return this.operation;
  }

  async applyNode(node) {
    const generated = buildSingBoxConfig(node, this.config);
    await atomicJson(this.configPath, generated);
    await runCommand(this.config.singBoxPath, ["check", "-c", this.configPath], 10_000);
    await atomicJson(this.nodePath, node);
    await this.stop();
    this.selectedNode = node;
    this.lastError = "";
    this.startProcess();
    await this.waitUntilRunning();
    return this.status();
  }

  startProcess() {
    this.stopping = false;
    const child = spawn(this.config.singBoxPath, ["run", "-c", this.configPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.process = child;
    child.stdout.on("data", (chunk) => this.captureLog(chunk));
    child.stderr.on("data", (chunk) => this.captureLog(chunk));
    child.on("error", (error) => { this.lastError = error.message; });
    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      if (!this.stopping && code !== 0) this.lastError = `sing-box 已退出：${signal || code}`;
    });
  }

  async stop() {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (this.process === child) this.process = null;
  }

  status() {
    return {
      running: Boolean(this.process && this.process.exitCode === null),
      selectedNodeId: this.selectedNode?.id || "",
      selectedNodeName: this.selectedNode?.name || "",
      selectedProtocol: this.selectedNode?.protocol || "",
      lastError: this.lastError,
      recentLogs: this.logLines.slice(-12)
    };
  }

  captureLog(chunk) {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    this.logLines.push(...lines);
    if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
  }

  async waitUntilRunning() {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error(this.lastError || this.logLines.at(-1) || "sing-box 启动失败");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (Date.now() + 2_600 < deadline) continue;
      return;
    }
  }
}

export function buildSingBoxConfig(node, config) {
  return {
    log: { level: "warn", timestamp: true },
    inbounds: [{
      type: "http",
      tag: "https-proxy-in",
      listen: "0.0.0.0",
      listen_port: config.proxyPort,
      users: [{ username: config.proxyUsername, password: config.proxyPassword }],
      tls: {
        enabled: true,
        certificate_path: config.tlsCertPath,
        key_path: config.tlsKeyPath
      }
    }],
    outbounds: [buildOutbound(node)],
    route: {
      rules: [{ action: "sniff" }],
      final: "proxy",
      auto_detect_interface: true
    }
  };
}

export function buildOutbound(node) {
  if (!node || typeof node !== "object") throw new Error("节点信息无效");
  const server = requiredText(node.server, "节点缺少服务器地址");
  const serverPort = requiredPort(node.port);

  if (node.protocol === "ss") {
    const outbound = {
      type: "shadowsocks",
      tag: "proxy",
      server,
      server_port: serverPort,
      method: requiredText(node.method, "Shadowsocks 节点缺少加密方式"),
      password: requiredText(node.password, "Shadowsocks 节点缺少密码")
    };
    if (node.plugin) {
      if (!["obfs-local", "v2ray-plugin"].includes(node.plugin)) {
        throw new Error(`sing-box 不支持 Shadowsocks 插件 ${node.plugin}`);
      }
      outbound.plugin = node.plugin;
      if (node.pluginOpts) outbound.plugin_opts = node.pluginOpts;
    }
    return outbound;
  }

  if (node.protocol === "vless") {
    const outbound = {
      type: "vless",
      tag: "proxy",
      server,
      server_port: serverPort,
      uuid: requiredText(node.uuid, "VLESS 节点缺少 UUID")
    };
    if (node.flow) {
      if (node.flow !== "xtls-rprx-vision") throw new Error(`sing-box 不支持 VLESS flow=${node.flow}`);
      outbound.flow = node.flow;
    }
    if (node.packetEncoding) outbound.packet_encoding = node.packetEncoding;
    const tls = buildTls(node, server);
    if (tls) outbound.tls = tls;
    const transport = buildTransport(node);
    if (transport) outbound.transport = transport;
    return outbound;
  }
  throw new Error("远程网关仅支持 Shadowsocks 和 VLESS 节点");
}

function buildTls(node, server) {
  const security = String(node.security || "none").toLowerCase();
  if (security === "none") return null;
  if (!["tls", "reality"].includes(security)) throw new Error(`不支持 VLESS security=${security}`);
  const tls = {
    enabled: true,
    server_name: node.serverName || server,
    insecure: Boolean(node.allowInsecure)
  };
  if (node.alpn?.length) tls.alpn = node.alpn;
  if (node.fingerprint) tls.utls = { enabled: true, fingerprint: node.fingerprint };
  if (security === "reality") {
    tls.reality = {
      enabled: true,
      public_key: requiredText(node.realityPublicKey, "Reality 节点缺少公钥 pbk"),
      short_id: node.realityShortId || ""
    };
  }
  return tls;
}

function buildTransport(node) {
  const type = String(node.transport || "tcp").toLowerCase();
  if (type === "tcp") {
    if (node.headerType && node.headerType !== "none") throw new Error(`不支持 VLESS TCP headerType=${node.headerType}`);
    return null;
  }
  if (type === "ws") {
    const transport = { type: "ws", path: node.path || "/" };
    if (node.host) transport.headers = { Host: node.host };
    return transport;
  }
  if (type === "grpc") return { type: "grpc", service_name: node.serviceName || "" };
  if (type === "http") {
    const transport = { type: "http", path: node.path || "/" };
    if (node.host) transport.host = node.host.split(",").map((value) => value.trim()).filter(Boolean);
    return transport;
  }
  if (type === "httpupgrade") return { type, host: node.host || "", path: node.path || "/" };
  if (type === "quic") return { type };
  throw new Error(`不支持 VLESS ${type} 传输`);
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("sing-box 配置检查超时"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(output.trim().split(/\r?\n/).at(-1) || `sing-box check 退出码 ${code}`));
    });
  });
}

function requiredText(value, message) {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function requiredPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("节点端口无效");
  return port;
}
