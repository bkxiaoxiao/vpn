import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { parseSubscription } from "../extension/lib/subscriptions.js";
import { loadConfig } from "./lib/config.mjs";
import { fetchSubscription } from "./lib/subscription-fetch.mjs";
import { SingBoxManager } from "./lib/singbox.mjs";

export function createGatewayServer({ config, manager, subscriptionFetcher = fetchSubscription }) {
  const tls = {
    cert: fs.readFileSync(config.tlsCertPath),
    key: fs.readFileSync(config.tlsKeyPath),
    minVersion: "TLSv1.2"
  };

  return https.createServer(tls, async (request, response) => {
    applyCors(request, response, config.extensionOrigin);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    try {
      const url = new URL(request.url, "https://gateway.invalid");
      if (request.method === "GET" && url.pathname === "/v1/health") {
        json(response, 200, { ok: true, service: "vpn-remote-gateway" });
        return;
      }
      authorize(request, config.apiToken);

      if (request.method === "GET" && url.pathname === "/v1/status") {
        json(response, 200, publicStatus(config, manager));
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/subscriptions/refresh") {
        const body = await readJson(request);
        const source = {
          id: requiredString(body.id, "缺少订阅 ID"),
          name: requiredString(body.name, "缺少订阅名称")
        };
        const content = await subscriptionFetcher(requiredString(body.url, "缺少订阅地址"), {
          maxBytes: config.subscriptionMaxBytes,
          allowPrivate: config.allowPrivateSubscriptions
        });
        const parsed = parseSubscription(content, source);
        const nodes = parsed.nodes.map(({ raw: _raw, ...node }) => node);
        json(response, 200, { nodes, warnings: parsed.warnings });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/nodes/select") {
        const body = await readJson(request);
        const status = await manager.selectNode(body.node);
        json(response, 200, { status, proxy: proxyInfo(config) });
        return;
      }

      json(response, 404, { error: "接口不存在" });
    } catch (error) {
      const status = error.statusCode || 400;
      json(response, status, { error: error.message || "网关内部错误" });
    }
  });
}

export async function startGateway() {
  const config = loadConfig();
  const manager = new SingBoxManager(config);
  await manager.initialize();
  const server = createGatewayServer({ config, manager });
  server.listen(config.apiPort, "0.0.0.0", () => {
    console.log(`gateway api listening on :${config.apiPort}`);
  });

  const shutdown = async () => {
    server.close();
    await manager.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function publicStatus(config, manager) {
  return { status: manager.status(), proxy: proxyInfo(config) };
}

function proxyInfo(config) {
  return {
    scheme: "https",
    host: config.publicProxyHost,
    port: config.publicProxyPort,
    username: config.proxyUsername
  };
}

function authorize(request, expectedToken) {
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(expectedToken);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    const error = new Error("API Token 无效");
    error.statusCode = 401;
    throw error;
  }
}

function applyCors(request, response, allowedOrigin) {
  const origin = request.headers.origin;
  if (origin && origin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  }
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("JSON 请求格式无效");
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startGateway().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
