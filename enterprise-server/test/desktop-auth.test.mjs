import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { createControlServer } from "../server.mjs";
const key = "7a".repeat(32),
  sample = {
    outbounds: [
      {
        type: "trojan",
        tag: "test",
        server: "edge.example.com",
        server_port: 443,
        password: "test-only",
        tls: { enabled: true },
      },
    ],
  };
async function app(t, configured = true) {
  const config = {
    local: true,
    dataKey: key,
    dbFile: ":memory:",
    base: "http://127.0.0.1",
    ...(configured
      ? {
          feishuId: "test-app",
          feishuSecret: "test-only-secret",
          tenant: "test-tenant",
          adminIds: [],
        }
      : {}),
  };
  const authFetch = async (url) =>
    url.includes("/oauth/token")
      ? new Response(JSON.stringify({ access_token: "test-only-upstream" }))
      : new Response(
          JSON.stringify({
            code: 0,
            data: {
              open_id: "ou_employee",
              tenant_key: "test-tenant",
              name: "Employee",
            },
          }),
        );
  const app = await createControlServer(config, { authFetch });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  config.base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await app.db.close();
  });
  const resource = await app.service.addResource(
      { name: "r", vendor: "v", content: JSON.stringify(sample) },
      "test",
    ),
    pool = await app.service.pool(
      { name: "p", sourceIds: [resource.id] },
      null,
      "test",
    );
  const employee = await app.service.employee(
    {
      name: "Employee",
      openId: "ou_employee",
      dept: "IT",
      enabled: true,
      poolIds: [pool.id],
    },
    null,
    "test",
  );
  await app.service.publish({ note: "test" }, "test");
  const request = (path, body, token, headers = {}) =>
    fetch(config.base + path, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { ...app, config, employee, request };
}
async function begin(a, installationId = randomUUID()) {
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = await a.request("/api/desktop/auth/start", {
    challenge,
    installationId,
    deviceName: "Mac Test",
  });
  assert.equal(start.status, 200);
  const body = await start.json();
  const browser = await a.request(
    new URL(body.authorizationURL).pathname +
      new URL(body.authorizationURL).search,
  );
  assert.equal(browser.status, 302);
  const state = new URL(browser.headers.get("location")).searchParams.get(
    "state",
  );
  const cookie = browser.headers.get("set-cookie").split(";")[0];
  const callback = await a.request(
    "/auth/feishu/callback?" +
      new URLSearchParams({ code: "test-only-code", state }),
    undefined,
    undefined,
    { cookie },
  );
  assert.equal(callback.status, 302);
  const url = new URL(callback.headers.get("location"));
  assert.equal(url.protocol, "relay-enterprise:");
  assert.ok(!url.search.includes("token="));
  return {
    ticket: url.searchParams.get("ticket"),
    transactionId: body.transactionId,
    verifier,
    installationId,
  };
}
test("unconfigured Feishu fails closed and anonymous client access has no local admin bypass", async (t) => {
  const a = await app(t, false);
  const r = await a.request("/api/desktop/auth/start", {
    challenge: "a".repeat(43),
    installationId: randomUUID(),
    deviceName: "Mac",
  });
  assert.equal(r.status, 503);
  assert.equal((await a.request("/api/client/policy")).status, 401);
  assert.equal((await a.db.list("sessions")).length, 0);
});
test("admin-created device tokens cannot fetch policy or impersonate Feishu", async (t) => {
  const a = await app(t),
    d = await a.service.createDevice(
      a.employee.id,
      { name: "admin device", platform: "macOS" },
      "test",
    );
  assert.equal(
    (await a.request("/api/client/policy", undefined, d.token)).status,
    403,
  );
  assert.equal(
    (
      await a.request(
        "/api/client/devices",
        { name: "forged", platform: "macOS", authMethod: "feishu" },
        d.token,
      )
    ).status,
    403,
  );
});
test("desktop exchange requires original verifier, consumes grant once and returns Feishu-only policy", async (t) => {
  const a = await app(t),
    flow = await begin(a);
  assert.equal(
    (
      await a.request("/api/desktop/auth/exchange", {
        ...flow,
        verifier: "x".repeat(43),
      })
    ).status,
    403,
  );
  const r = await a.request("/api/desktop/auth/exchange", flow);
  assert.equal(r.status, 200);
  const session = await r.json();
  assert.equal(session.authentication, "feishu");
  assert.equal(
    (await a.request("/api/desktop/auth/exchange", flow)).status,
    403,
  );
  const p = await a.request("/api/client/policy", undefined, session.token);
  assert.equal(p.status, 200);
  assert.equal((await p.json()).authentication, "feishu");
  assert.equal(
    (await a.request("/api/client/logout", {}, session.token)).status,
    200,
  );
  assert.equal(
    (await a.request("/api/client/policy", undefined, session.token)).status,
    401,
  );
});
test("repeat real login reuses installation, invalidates old token, and respects disabled employee", async (t) => {
  const a = await app(t),
    id = randomUUID();
  const first = await (
    await a.request("/api/desktop/auth/exchange", await begin(a, id))
  ).json();
  const second = await (
    await a.request("/api/desktop/auth/exchange", await begin(a, id))
  ).json();
  assert.equal(first.deviceId, second.deviceId);
  assert.equal((await a.db.list("devices")).length, 1);
  assert.equal(
    (await a.request("/api/client/policy", undefined, first.token)).status,
    401,
  );
  await a.service.employee(
    { ...a.employee, enabled: false },
    a.employee.id,
    "test",
  );
  assert.equal(
    (await a.request("/api/client/policy", undefined, second.token)).status,
    401,
  );
});
test("expired or substituted desktop grants cannot be exchanged", async (t) => {
  const a = await app(t),
    flow = await begin(a);
  assert.equal(
    (
      await a.request("/api/desktop/auth/exchange", {
        ...flow,
        transactionId: "0".repeat(64),
      })
    ).status,
    403,
  );
  const grant = (await a.db.list("desktopGrants"))[0];
  await a.db.tx((t) =>
    t.put("desktopGrants", grant.id, { ...grant, expires: 0 }),
  );
  assert.equal(
    (await a.request("/api/desktop/auth/exchange", flow)).status,
    403,
  );
});
