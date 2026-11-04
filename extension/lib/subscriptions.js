const SUPPORTED_SCHEMES = new Set(["ss", "vless"]);

export function parseSubscription(content, source = {}) {
  const text = normalizeContent(content);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const nodes = [];
  const warnings = [];

  for (const line of lines) {
    const scheme = line.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
    if (!scheme) continue;
    if (!SUPPORTED_SCHEMES.has(scheme)) {
      warnings.push(`暂不支持 ${scheme}:// 节点`);
      continue;
    }

    try {
      const parsed = scheme === "ss" ? parseShadowsocks(line) : parseVless(line);
      parsed.sourceId = source.id || "manual";
      parsed.sourceName = source.name || "未命名订阅";
      parsed.id = `${parsed.protocol}-${fingerprint(`${source.id || "manual"}:${line}`)}`;
      parsed.raw = line;
      nodes.push(parsed);
    } catch (error) {
      warnings.push(error.message || `无法解析节点：${line.slice(0, 32)}`);
    }
  }

  if (!nodes.length) {
    const yamlHint = /(^|\n)\s*proxies\s*:/i.test(text)
      ? "当前版本暂不解析 Clash YAML，请使用 Base64/纯文本 URI 订阅。"
      : "订阅中没有可用的 ss:// 或 vless:// 节点。";
    const details = warnings.length ? ` ${warnings.slice(0, 2).join("；")}` : "";
    throw new Error(`${yamlHint}${details}`);
  }

  return { nodes: deduplicate(nodes), warnings: unique(warnings) };
}

export function parseShadowsocks(uri) {
  if (!uri.toLowerCase().startsWith("ss://")) throw new Error("不是 Shadowsocks 节点");

  const fragmentIndex = uri.indexOf("#");
  const name = decodeLabel(fragmentIndex >= 0 ? uri.slice(fragmentIndex + 1) : "") || "Shadowsocks";
  const withoutFragment = uri.slice(5, fragmentIndex >= 0 ? fragmentIndex : undefined);
  const queryIndex = withoutFragment.indexOf("?");
  const main = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
  const query = new URLSearchParams(queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : "");

  let credentials;
  let authority;
  const atIndex = main.lastIndexOf("@");
  if (atIndex >= 0) {
    const encodedCredentials = main.slice(0, atIndex);
    credentials = encodedCredentials.includes(":")
      ? decodeURIComponent(encodedCredentials)
      : decodeBase64(encodedCredentials);
    authority = main.slice(atIndex + 1).replace(/\/$/, "");
  } else {
    const decoded = decodeBase64(main.replace(/\/$/, ""));
    const decodedAtIndex = decoded.lastIndexOf("@");
    if (decodedAtIndex < 0) throw new Error(`${name}：SS 地址缺少服务器信息`);
    credentials = decoded.slice(0, decodedAtIndex);
    authority = decoded.slice(decodedAtIndex + 1);
  }

  const separator = credentials.indexOf(":");
  if (separator < 1) throw new Error(`${name}：SS 加密方式或密码无效`);
  const method = credentials.slice(0, separator);
  const password = credentials.slice(separator + 1);
  const { hostname, port } = parseAuthority(authority, name);
  const pluginValue = query.get("plugin") || "";
  const [plugin, ...pluginOptions] = pluginValue.split(";");

  return {
    protocol: "ss",
    name,
    server: hostname,
    port,
    method,
    password,
    plugin: plugin || "",
    pluginOpts: pluginOptions.join(";")
  };
}

export function parseVless(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("VLESS 地址格式无效");
  }

  const name = decodeLabel(url.hash.slice(1)) || "VLESS";
  const uuid = decodeURIComponent(url.username);
  if (!uuid || !url.hostname || !url.port) throw new Error(`${name}：VLESS 地址缺少 UUID、服务器或端口`);

  const transport = (url.searchParams.get("type") || "tcp").toLowerCase();
  const supportedTransports = new Set(["tcp", "ws", "grpc", "http", "h2", "httpupgrade", "quic"]);
  if (!supportedTransports.has(transport)) {
    throw new Error(`${name}：暂不支持 VLESS ${transport} 传输`);
  }

  const security = (url.searchParams.get("security") || "none").toLowerCase();
  if (!["none", "tls", "reality"].includes(security)) {
    throw new Error(`${name}：暂不支持 VLESS security=${security}`);
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name}：端口无效`);

  return {
    protocol: "vless",
    name,
    server: stripIpv6Brackets(url.hostname),
    port,
    uuid,
    flow: url.searchParams.get("flow") || "",
    encryption: url.searchParams.get("encryption") || "none",
    security,
    serverName: url.searchParams.get("sni") || url.searchParams.get("serverName") || "",
    allowInsecure: truthy(url.searchParams.get("allowInsecure")),
    alpn: splitList(url.searchParams.get("alpn")),
    fingerprint: url.searchParams.get("fp") || "",
    realityPublicKey: url.searchParams.get("pbk") || url.searchParams.get("publicKey") || "",
    realityShortId: url.searchParams.get("sid") || url.searchParams.get("shortId") || "",
    transport: transport === "h2" ? "http" : transport,
    host: url.searchParams.get("host") || "",
    path: url.searchParams.get("path") || "",
    serviceName: url.searchParams.get("serviceName") || "",
    headerType: url.searchParams.get("headerType") || "",
    packetEncoding: url.searchParams.get("packetEncoding") || "xudp"
  };
}

function normalizeContent(content) {
  const trimmed = String(content ?? "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new Error("订阅内容为空");
  if (/^(ss|vless):\/\//im.test(trimmed)) return trimmed;

  try {
    const decoded = decodeBase64(trimmed.replace(/\s+/g, ""));
    if (/^(ss|vless):\/\//im.test(decoded)) return decoded;
  } catch {
    // Keep the original body so the caller receives a useful format error.
  }
  return trimmed;
}

function parseAuthority(authority, name) {
  try {
    const url = new URL(`http://${authority}`);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return { hostname: stripIpv6Brackets(url.hostname), port };
  } catch {
    throw new Error(`${name}：SS 服务器或端口无效`);
  }
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Base64 内容无效");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeLabel(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

function splitList(value) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function stripIpv6Brackets(value) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function truthy(value) {
  return ["1", "true", "yes"].includes(String(value).toLowerCase());
}

function fingerprint(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function deduplicate(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    const key = `${node.protocol}:${node.server}:${node.port}:${node.uuid || `${node.method}:${node.password}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values) {
  return [...new Set(values)];
}
