import dns from "node:dns/promises";
import net from "node:net";

export async function fetchSubscription(url, options = {}) {
  const maxBytes = options.maxBytes || 2 * 1024 * 1024;
  const allowPrivate = Boolean(options.allowPrivate);
  let current = new URL(url);

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await validateDestination(current, allowPrivate);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent": "Clash.Meta/1.19 Remote-Gateway/0.2",
        accept: "text/plain, application/octet-stream, */*"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("订阅重定向缺少 Location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`订阅服务器返回 HTTP ${response.status}`);
    return readLimitedText(response, maxBytes);
  }
  throw new Error("订阅重定向次数过多");
}

async function validateDestination(url, allowPrivate) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("订阅地址只支持 HTTP/HTTPS");
  if (url.username || url.password) throw new Error("订阅地址不能在 URL 中包含用户名或密码");
  if (allowPrivate) return;

  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("订阅域名无法解析");
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("订阅地址解析到内网或本机地址，已被安全策略拒绝");
  }
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`订阅内容超过 ${Math.floor(maxBytes / 1024)} KB`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function isPrivateAddress(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  if (net.isIPv6(normalized)) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  }
  return false;
}
