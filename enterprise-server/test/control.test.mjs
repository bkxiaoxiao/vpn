import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "../lib/db.mjs";
import { ControlService } from "../lib/service.mjs";
import { vault, loadConfig } from "../lib/security.mjs";
import { parseNodes, isPublicIp } from "../lib/subscriptions.mjs";
import { deltaEvents } from "../collector/agent.mjs";
import { createControlServer } from "../server.mjs";
const key = "12".repeat(32),
  nodeContent = JSON.stringify({
    outbounds: [
      {
        type: "trojan",
        tag: "Tokyo",
        server: "edge.example.com",
        server_port: 443,
        password: "private-node-password",
        tls: { enabled: true, server_name: "edge.example.com" },
      },
    ],
  });
async function fixture(t) {
  const db = await openStore({ file: ":memory:" });
  t.after(() => db.close());
  const s = new ControlService(db, vault(key), { local: true });
  await s.init();
  const r = await s.addResource(
    { name: "采购订阅", vendor: "供应商", content: nodeContent },
    "test",
  );
  const p = await s.pool({ name: "办公", sourceIds: [r.id] }, null, "test");
  const e = await s.employee(
    {
      name: "员工甲",
      openId: "ou_test",
      dept: "运营",
      enabled: true,
      poolIds: [p.id],
    },
    null,
    "test",
  );
  const g = await s.addGateway(
    { name: "计量网关", host: "gateway.example.com" },
    "test",
  );
  const device = await s.createDevice(
    e.id,
    { name: "电脑", platform: "Windows", gatewayId: g.id },
    "test",
  );
  const d = await db.get("devices", device.deviceId);
  await s.publish({ note: "首版" }, "test");
  const start = new Date(Date.parse(d.createdAt) + 1000).toISOString(),
    end = new Date(Date.parse(d.createdAt) + 11000).toISOString();
  const event = {
    eventId: "evt-1",
    credentialId: d.credentialId,
    startedAt: start,
    endedAt: end,
    uploadBytes: 1024,
    downloadBytes: 4096,
  };
  return { db, s, r, p, e, g, d, event };
}

test("Clash YAML / sing-box / base64 URI supported without executing remote rules", () => {
  assert.equal(
    parseNodes(
      "proxies:\n  - name: SG\n    type: ss\n    server: edge.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret\n",
    ).nodes[0].protocol,
    "shadowsocks",
  );
  assert.equal(parseNodes(nodeContent).nodes.length, 1);
  assert.equal(
    parseNodes(
      Buffer.from("trojan://secret@edge.example.com:443#SG").toString("base64"),
    ).nodes[0].outbound.password,
    "secret",
  );
  assert.throws(() => parseNodes('{"outbounds":[{"type":"direct"}]}'));
  assert.throws(() =>
    parseNodes(
      JSON.stringify({
        outbounds: [
          {
            type: "trojan",
            server: "x",
            server_port: 443,
            tls: { certificate_path: "/etc/passwd" },
          },
        ],
      }),
    ),
  );
});
test("subscription SSRF blocks internal, mapped IPv6 and reserved networks", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.2",
    "::1",
    "::ffff:7f00:1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700::1111"), true);
});
test("configuration rejects unsafe production mode and missing persistence", () => {
  assert.throws(() =>
    loadConfig({ LOCAL_DEV: "true", K_SERVICE: "production" }),
  );
  assert.throws(() =>
    loadConfig({ DATA_KEY: key, ADMIN_PASSWORD: "a".repeat(20) }),
  );
});
test("resource and gateway secrets excluded from bootstrap; encryption authenticated", async (t) => {
  const f = await fixture(t),
    state = await f.s.bootstrap(),
    serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("private-node-password"));
  assert.ok(!serialized.includes(f.g.token));
  assert.ok(!serialized.includes("tokenHash"));
  assert.ok(!serialized.includes("encrypted"));
  assert.equal(
    vault(key).open((await f.db.get("resources", f.r.id)).encrypted).nodes
      .length,
    1,
  );
  assert.throws(() =>
    vault("34".repeat(32)).open(state.encrypted || "invalid"),
  );
});
test("usage retries idempotent, conflicting IDs rejected, employee determined server-side", async (t) => {
  const { s, g, event, e } = await fixture(t);
  assert.deepEqual(
    await s.ingest(g.id, { events: [{ ...event, employeeId: "forged" }] }),
    { accepted: 1, duplicates: 0 },
  );
  assert.deepEqual(await s.ingest(g.id, { events: [event] }), {
    accepted: 0,
    duplicates: 1,
  });
  await assert.rejects(
    s.ingest(g.id, { events: [{ ...event, uploadBytes: 2 }] }),
    /不一致/,
  );
  const u = await s
    .usage("2020-01-01", new Date(Date.now() + 20000).toISOString())
    .catch(() => null);
  assert.equal(u, null);
  const result = await s.usage(
    new Date(Date.now() - 86400000).toISOString(),
    new Date(Date.now() + 20000).toISOString(),
  );
  assert.equal(result.employees[0].employeeId, e.id);
  assert.equal(result.employees[0].downloadBytes, 4096);
});
test("usage rejects negative, foreign credentials, overlapping windows and rolls back batches", async (t) => {
  const { s, g, event } = await fixture(t);
  await assert.rejects(
    s.ingest(g.id, { events: [{ ...event, uploadBytes: -1 }] }),
  );
  await assert.rejects(
    s.ingest(g.id, { events: [{ ...event, credentialId: "other" }] }),
  );
  await s.ingest(g.id, { events: [event] });
  await assert.rejects(
    s.ingest(g.id, { events: [{ ...event, eventId: "overlap" }] }),
    /重叠/,
  );
  const next = {
    ...event,
    eventId: "next",
    startedAt: event.endedAt,
    endedAt: new Date(Date.parse(event.endedAt) + 1000).toISOString(),
  };
  await assert.rejects(
    s.ingest(g.id, {
      events: [next, { ...event, eventId: "invalid", downloadBytes: 0.5 }],
    }),
  );
  assert.deepEqual(await s.ingest(g.id, { events: [next] }), {
    accepted: 1,
    duplicates: 0,
  });
});
test("concurrent identical samples count once", async (t) => {
  const { s, g, event } = await fixture(t);
  const result = await Promise.all(
    Array.from({ length: 8 }, () => s.ingest(g.id, { events: [event] })),
  );
  assert.equal(
    result.reduce((n, r) => n + r.accepted, 0),
    1,
  );
});
test("no samples stays unmetered and revoked historical usage is retained", async (t) => {
  const { s, g, event, d } = await fixture(t);
  let result = await s.usage(
    new Date(Date.now() - 86400000).toISOString(),
    new Date(Date.now() + 20000).toISOString(),
  );
  assert.equal(result.employees[0].metered, false);
  await s.ingest(g.id, { events: [event] });
  await s.revokeDevice(d.id, "test");
  result = await s.usage(
    new Date(Date.now() - 86400000).toISOString(),
    new Date(Date.now() + 20000).toISOString(),
  );
  assert.equal(result.employees[0].downloadBytes, 4096);
  await assert.rejects(
    s.clientPolicy({
      authMethod: "feishu",
      feishuAt: Date.now(),
      deviceId: d.id,
      employeeId: d.employeeId,
    }),
    /停用/,
  );
});
test("current employee authorization gates historic releases and gateway users", async (t) => {
  const { s, db, e, p, d, g } = await fixture(t);
  assert.equal(
    (
      await s.clientPolicy({
        authMethod: "feishu",
        feishuAt: Date.now(),
        deviceId: d.id,
        employeeId: e.id,
      })
    ).metering,
    "unmetered",
  );
  await s.employee({ ...e, poolIds: [], enabled: true }, e.id, "test");
  await assert.rejects(
    s.clientPolicy({
      authMethod: "feishu",
      feishuAt: Date.now(),
      deviceId: d.id,
      employeeId: e.id,
    }),
    /没有获授权/,
  );
  const config = await s.gatewayConfig(g.id);
  assert.equal(config.config.inbounds[0].users.length, 0);
  assert.deepEqual(config.config.route.rules.at(-1), { action: "reject" });
  await s.employee({ ...e, poolIds: [p.id], enabled: false }, e.id, "test");
  assert.ok((await db.get("devices", d.id)).revokedAt);
});
test("rollback publishes a higher immutable revision", async (t) => {
  const { s, db } = await fixture(t);
  const first = (await db.list("releases"))[0];
  await s.publish({ note: "second" }, "test");
  const rollback = await s.publish(
    { note: "rollback", rollbackId: first.id },
    "test",
  );
  assert.equal(rollback.revision, 3);
  assert.equal((await db.list("releases")).length, 3);
  assert.equal((await db.get("releases", first.id)).note, "首版");
});
test("gateway policy waits for applied credential, not merely a heartbeat", async (t) => {
  const { s, db, d, e, g } = await fixture(t);
  await db.tx(async (t) => {
    const settings = await t.get("settings", "main");
    await t.put("settings", "main", { ...settings, deliveryMode: "gateway" });
    const gw = await t.get("gateways", g.id);
    await t.put("gateways", g.id, {
      ...gw,
      lastSeen: new Date().toISOString(),
    });
  });
  await assert.rejects(
    s.clientPolicy({
      authMethod: "feishu",
      feishuAt: Date.now(),
      deviceId: d.id,
      employeeId: e.id,
    }),
    /未就绪/,
  );
  await db.tx(async (t) => {
    const gw = await t.get("gateways", g.id);
    await t.put("gateways", g.id, {
      ...gw,
      appliedCredentialIds: [d.credentialId],
      appliedDigest: "x",
      desiredDigest: "x",
    });
  });
  const policy = await s.clientPolicy({
    authMethod: "feishu",
    feishuAt: Date.now(),
    deviceId: d.id,
    employeeId: e.id,
  });
  assert.equal(policy.metering, "gateway");
  assert.equal(policy.config.outbounds[1].username, d.credentialId);
  assert.ok(!JSON.stringify(policy).includes("private-node-password"));
});
test("collector computes deltas and handles resets without negative traffic", () => {
  const s = {
    at: "2026-11-04T00:00:00Z",
    counters: { cred: { upload: 100, download: 200 } },
  };
  const r = deltaEvents(
    s,
    [
      { name: "user>>>cred>>>traffic>>>uplink", value: "150" },
      { name: "user>>>cred>>>traffic>>>downlink", value: "50" },
    ],
    "2026-11-04T00:00:30Z",
  );
  assert.equal(r.events[0].uploadBytes, 50);
  assert.equal(r.events[0].downloadBytes, 50);
  assert.equal(r.resets, 1);
  assert.throws(() => deltaEvents(s, [], "2026-11-05T00:00:00Z"));
});
test("SQLite resources survive a service restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-test-"));
  try {
    let db = await openStore({ file: path.join(dir, "test.sqlite") });
    await db.tx((t) => t.put("settings", "main", { workspace: "persistent" }));
    await db.close();
    db = await openStore({ file: path.join(dir, "test.sqlite") });
    assert.equal((await db.get("settings", "main")).workspace, "persistent");
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("HTTP auth, same-origin, privilege separation and gateway token scopes", async (t) => {
  const config = {
    local: false,
    dataKey: key,
    dbFile: ":memory:",
    base: "http://127.0.0.1",
    adminPassword: "long-admin-password-only-test",
  };
  const app = await createControlServer(config);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  config.base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await app.db.close();
  });
  const request = (p, method = "GET", b, headers = {}) =>
    fetch(config.base + p, {
      method,
      headers: {
        ...(b
          ? { "content-type": "application/json", origin: config.base }
          : {}),
        ...headers,
      },
      body: b ? JSON.stringify(b) : undefined,
    });
  assert.equal((await request("/health")).status, 200);
  assert.equal((await request("/healthz")).status, 200);
  assert.equal((await request("/api/bootstrap")).status, 401);
  assert.equal(
    (await request("/api/auth/login", "POST", { password: "wrong" })).status,
    401,
  );
  const login = await request("/api/auth/login", "POST", {
    password: config.adminPassword,
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await request(
        "/api/settings",
        "PUT",
        {},
        { cookie, origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const g = await app.service.addGateway(
    { name: "g", host: "g.example.com" },
    "test",
  );
  assert.equal(
    (
      await request("/api/bootstrap", "GET", undefined, {
        authorization: "Bearer " + g.token,
      })
    ).status,
    401,
  );
  const cfg = await request("/api/gateway/config", "GET", undefined, {
    authorization: "Bearer " + g.token,
  });
  assert.equal(cfg.status, 200);
  const data = await cfg.json();
  assert.equal(
    (
      await request(
        "/api/gateway/ack",
        "POST",
        { digest: data.digest },
        { authorization: "Bearer " + g.token },
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/bootstrap", "GET", undefined, { cookie })).status,
    200,
  );
});

test("generated gateway routes pass installed sing-box validation (metering API tested separately)", async (t) => {
  const { existsSync } = await import("node:fs"),
    { execFileSync } = await import("node:child_process"),
    { writeFile } = await import("node:fs/promises");
  const core = ["/opt/homebrew/bin/sing-box", "/usr/local/bin/sing-box"].find(
    existsSync,
  );
  if (!core) {
    t.skip("sing-box not installed");
    return;
  }
  const { s, g } = await fixture(t),
    config = (await s.gatewayConfig(g.id)).config,
    dir = await mkdtemp(path.join(os.tmpdir(), "relay-core-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  config.inbounds[0].tls.certificate_path = path.join(dir, "cert.pem");
  config.inbounds[0].tls.key_path = path.join(dir, "key.pem");
  // Homebrew core lacks with_v2ray_api. Validate all remaining real routes/inbounds/outbounds.
  delete config.experimental;
  await writeFile(path.join(dir, "config.json"), JSON.stringify(config));
  execFileSync(core, ["check", "-c", path.join(dir, "config.json")], {
    stdio: "pipe",
  });
});

test("employee identity cannot be replaced and inherit someone else's usage", async (t) => {
  const { s, db, e, d } = await fixture(t);
  await assert.rejects(
    s.employee({ ...e, openId: "ou_reassigned", enabled: true }, e.id, "test"),
    /不能替换/,
  );
  assert.equal((await db.get("employees", e.id)).openId, e.openId);
  assert.equal((await db.get("devices", d.id)).revokedAt, null);
});
test("scheduled refresh obeys settings while manual refresh bypasses the due window", async (t) => {
  const { s, db, r } = await fixture(t);
  const result = await s.refreshAll("job", { dueOnly: true });
  assert.equal(result[0].skipped, true);
  const record = await db.get("resources", r.id);
  record.encrypted = s.vault.seal({
    sourceUrl: "https://provider.example.com/sub",
    nodes: [],
  });
  await db.tx((t) => t.put("resources", r.id, record));
  let fetches = 0;
  s.fetcher = async () => {
    fetches++;
    return nodeContent;
  };
  await s.refreshAll("admin");
  assert.equal(fetches, 1);
  await s.refreshAll("job", { dueOnly: true });
  assert.equal(fetches, 1);
});

test("identical nodes from multiple subscriptions do not produce duplicate outbound tags", async (t) => {
  const { s, r, p, e, g, d } = await fixture(t);
  const second = await s.addResource(
    { name: "另一个供应商", vendor: "供应商B", content: nodeContent },
    "test",
  );
  await s.pool({ ...p, sourceIds: [r.id, second.id] }, p.id, "test");
  await s.publish({ note: "duplicate sources" }, "test");
  const policy = await s.clientPolicy({
    authMethod: "feishu",
    feishuAt: Date.now(),
    deviceId: d.id,
    employeeId: e.id,
  });
  const tags = policy.config.outbounds.map((o) => o.tag);
  assert.equal(new Set(tags).size, tags.length);
  const config = (await s.gatewayConfig(g.id)).config;
  const gatewayTags = config.outbounds.map((o) => o.tag);
  assert.equal(new Set(gatewayTags).size, gatewayTags.length);
});
