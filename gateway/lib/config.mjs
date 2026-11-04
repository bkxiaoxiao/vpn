import path from "node:path";

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || "/data");
  return {
    dataDir,
    apiPort: integer(env.GATEWAY_API_PORT || "8443", "GATEWAY_API_PORT"),
    proxyPort: integer(env.GATEWAY_PROXY_PORT || "1443", "GATEWAY_PROXY_PORT"),
    publicProxyHost: required(env.PUBLIC_PROXY_HOST, "PUBLIC_PROXY_HOST"),
    publicProxyPort: integer(env.PUBLIC_PROXY_PORT || "443", "PUBLIC_PROXY_PORT"),
    apiToken: required(env.GATEWAY_API_TOKEN, "GATEWAY_API_TOKEN"),
    proxyUsername: required(env.PROXY_USERNAME, "PROXY_USERNAME"),
    proxyPassword: required(env.PROXY_PASSWORD, "PROXY_PASSWORD"),
    extensionOrigin: env.EXTENSION_ORIGIN || "chrome-extension://pinmpjcfbiejgkhccadaffmicjoodpje",
    tlsCertPath: path.resolve(env.TLS_CERT_PATH || "/certs/fullchain.pem"),
    tlsKeyPath: path.resolve(env.TLS_KEY_PATH || "/certs/privkey.pem"),
    singBoxPath: env.SING_BOX_PATH || "/usr/local/bin/sing-box",
    allowPrivateSubscriptions: env.ALLOW_PRIVATE_SUBSCRIPTIONS === "true",
    subscriptionMaxBytes: integer(env.SUBSCRIPTION_MAX_BYTES || String(2 * 1024 * 1024), "SUBSCRIPTION_MAX_BYTES")
  };
}

function required(value, name) {
  if (!value || !String(value).trim()) throw new Error(`缺少环境变量 ${name}`);
  return String(value).trim();
}

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 && name.includes("PORT")) {
    throw new Error(`环境变量 ${name} 无效`);
  }
  return parsed;
}
