import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../lib/config.mjs";
import { isPrivateAddress } from "../lib/subscription-fetch.mjs";
import { buildOutbound, buildSingBoxConfig } from "../lib/singbox.mjs";

const baseConfig = {
  proxyPort: 1443,
  proxyUsername: "chrome-user",
  proxyPassword: "strong-password",
  tlsCertPath: "/certs/fullchain.pem",
  tlsKeyPath: "/certs/privkey.pem"
};

test("builds a TLS-authenticated HTTPS gateway inbound", () => {
  const config = buildSingBoxConfig({
    protocol: "ss",
    name: "SS node",
    server: "ss.example.com",
    port: 8388,
    method: "aes-256-gcm",
    password: "secret"
  }, baseConfig);
  const inbound = config.inbounds[0];
  assert.equal(inbound.type, "http");
  assert.equal(inbound.listen_port, 1443);
  assert.equal(inbound.users[0].username, "chrome-user");
  assert.equal(inbound.tls.enabled, true);
  assert.equal(config.route.final, "proxy");
});

test("builds VLESS Reality and WebSocket outbounds", () => {
  const outbound = buildOutbound({
    protocol: "vless",
    server: "edge.example.com",
    port: 443,
    uuid: "11111111-1111-1111-1111-111111111111",
    security: "reality",
    serverName: "www.example.com",
    realityPublicKey: "public-key",
    realityShortId: "01234567",
    fingerprint: "chrome",
    transport: "ws",
    path: "/ws",
    host: "cdn.example.com"
  });
  assert.equal(outbound.type, "vless");
  assert.equal(outbound.tls.reality.public_key, "public-key");
  assert.equal(outbound.transport.headers.Host, "cdn.example.com");
});

test("blocks loopback, private, link-local, and carrier NAT subscription targets", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.20.1.2", "192.168.1.1", "169.254.1.2", "100.64.1.2", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("loads and validates gateway environment", () => {
  const config = loadConfig({
    DATA_DIR: "/tmp/gateway-test",
    PUBLIC_PROXY_HOST: "proxy.example.com",
    PUBLIC_PROXY_PORT: "443",
    GATEWAY_API_TOKEN: "token",
    PROXY_USERNAME: "user",
    PROXY_PASSWORD: "password"
  });
  assert.equal(config.publicProxyHost, "proxy.example.com");
  assert.equal(config.proxyPort, 1443);
  assert.equal(config.apiPort, 8443);
});
