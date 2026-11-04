import test from "node:test";
import assert from "node:assert/strict";
import {
  parseShadowsocks,
  parseSubscription,
  parseVless
} from "../extension/lib/subscriptions.js";

test("parses SIP002 Shadowsocks URI", () => {
  const credentials = Buffer.from("aes-256-gcm:p@ssword").toString("base64url");
  const node = parseShadowsocks(`ss://${credentials}@example.com:8388#Hong%20Kong`);
  assert.equal(node.protocol, "ss");
  assert.equal(node.name, "Hong Kong");
  assert.equal(node.method, "aes-256-gcm");
  assert.equal(node.password, "p@ssword");
  assert.equal(node.server, "example.com");
  assert.equal(node.port, 8388);
});

test("parses legacy Base64 Shadowsocks URI and plugin", () => {
  const payload = Buffer.from("chacha20-ietf-poly1305:secret@[2001:db8::1]:443").toString("base64url");
  const node = parseShadowsocks(`ss://${payload}?plugin=obfs-local%3Bobfs%3Dhttp#IPv6`);
  assert.equal(node.server, "2001:db8::1");
  assert.equal(node.plugin, "obfs-local");
  assert.equal(node.pluginOpts, "obfs=http");
});

test("parses VLESS WebSocket TLS fields", () => {
  const node = parseVless(
    "vless://11111111-1111-1111-1111-111111111111@edge.example.com:443?encryption=none&security=tls&sni=origin.example.com&type=ws&host=cdn.example.com&path=%2Fws&fp=chrome#Tokyo"
  );
  assert.equal(node.protocol, "vless");
  assert.equal(node.transport, "ws");
  assert.equal(node.serverName, "origin.example.com");
  assert.equal(node.host, "cdn.example.com");
  assert.equal(node.path, "/ws");
});

test("decodes a Base64 subscription and skips unrelated protocols", () => {
  const body = [
    "vless://11111111-1111-1111-1111-111111111111@one.example.com:443?security=tls#One",
    "trojan://secret@two.example.com:443#Two"
  ].join("\n");
  const encoded = Buffer.from(body).toString("base64");
  const result = parseSubscription(encoded, { id: "sub-1", name: "Test" });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].sourceId, "sub-1");
  assert.match(result.warnings[0], /trojan/);
});

test("explains unsupported Clash YAML", () => {
  assert.throws(
    () => parseSubscription("proxies:\n  - name: one\n    type: ss"),
    /Clash YAML/
  );
});
