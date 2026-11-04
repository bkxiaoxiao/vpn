import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../lib/db.mjs";
import { vault, hash } from "../lib/security.mjs";
import { ControlService } from "../lib/service.mjs";
import { FeishuDirectory } from "../lib/feishu-directory.mjs";
import { createControlServer } from "../server.mjs";
const key = "31".repeat(32),
  secret = "test-only-feishu-secret-1234";
const active = { is_activated: true };
const ok = (data) => new Response(JSON.stringify({ code: 0, data }));
async function setup(t) {
  const db = await openStore({ file: ":memory:" });
  t.after(() => db.close());
  const config = { local: true, base: "http://localhost", dataKey: key },
    v = vault(key),
    service = new ControlService(db, v, config);
  await service.init();
  let mode = "full";
  const fetcher = async (input, opts) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/tenant_access_token/internal"))
      return new Response(
        JSON.stringify({
          code: 0,
          tenant_access_token: "test-only-tenant-token",
          expire: 7200,
        }),
      );
    assert.equal(opts.headers.authorization, "Bearer test-only-tenant-token");
    if (url.pathname.includes("/children"))
      return ok({
        items: url.pathname.includes("/0/")
          ? [
              { open_department_id: "od_sales", name: "销售" },
              { open_department_id: "od_rd", name: "研发" },
            ]
          : [],
        has_more: false,
      });
    const department = url.searchParams.get("department_id"),
      page = url.searchParams.get("page_token");
    if (mode === "fail" && department === "od_rd")
      return new Response(JSON.stringify({ code: 99991672, msg: secret }), {
        status: 403,
      });
    if (mode === "empty") return ok({ items: [], has_more: false });
    if (department === "0") return ok({ items: [], has_more: false });
    if (department === "od_sales") {
      if (mode === "broken-page")
        return ok({
          items: [{ open_id: "ou_a", name: "半份结果", status: active }],
          has_more: true,
        });
      if (!page)
        return ok({
          items: [
            {
              open_id: "ou_a",
              name: "甲",
              status: mode === "inactive" ? { is_resigned: true } : active,
              email: "not-to-store@example.com",
              mobile: "not-to-store",
            },
          ],
          has_more: true,
          page_token: "page2",
        });
      return ok({
        items: [{ open_id: "ou_b", name: "乙", status: active }],
        has_more: false,
      });
    }
    return ok({
      items: [
        {
          open_id: "ou_a",
          name: "甲",
          status: mode === "inactive" ? { is_resigned: true } : active,
        },
      ],
      has_more: false,
    });
  };
  const directory = new FeishuDirectory(
    db,
    v,
    config,
    service.audit.bind(service),
    fetcher,
  );
  await directory.save(
    {
      appId: "cli_test",
      appSecret: secret,
      tenantKey: "tenant_test",
      rootIds: ["0"],
      adminIds: [],
    },
    "test",
  );
  return { db, v, service, directory, setMode: (m) => (mode = m) };
}
test("Feishu configuration is encrypted, never echoed, and a blank secret preserves it", async (t) => {
  const { db, directory } = await setup(t);
  const status = await directory.status();
  assert.equal(status.secretConfigured, true);
  assert.equal(status.appSecret, undefined);
  assert.ok(
    !JSON.stringify(await db.get("integrations", "feishu")).includes(secret),
  );
  await directory.save(
    {
      appId: "cli_test",
      tenantKey: "tenant_test",
      appSecret: "",
      rootIds: ["0"],
      adminIds: [],
    },
    "test",
  );
  assert.equal((await directory.credentials()).appSecret, secret);
  assert.ok(!JSON.stringify(await directory.status()).includes(secret));
});
test("paginated and multi-department sync deduplicates employees; new accounts remain unauthorized", async (t) => {
  const { db, directory } = await setup(t);
  const result = await directory.sync("test");
  assert.equal(result.added, 2);
  assert.equal(result.employees, 2);
  assert.equal(result.departments, 3);
  const rows = await db.list("employees");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((e) => e.enabled === false && e.poolIds.length === 0));
  assert.equal(rows.find((e) => e.openId === "ou_a").departmentIds.length, 2);
  assert.ok(!JSON.stringify(rows).includes("not-to-store"));
});
test("existing grants and employee identity are preserved; explicit departure revokes devices and sessions", async (t) => {
  const { db, service, directory, setMode } = await setup(t);
  const pool = await service.pool(
    { name: "办公", sourceIds: [] },
    null,
    "test",
  );
  const old = await service.employee(
    {
      name: "旧名字",
      openId: "ou_a",
      dept: "原部门",
      poolIds: [pool.id],
      enabled: true,
    },
    null,
    "test",
  );
  const device = await service.createDevice(
    old.id,
    { name: "Mac", platform: "macOS" },
    "test",
  );
  await directory.sync("test");
  let employee = await db.get("employees", old.id);
  assert.equal(employee.name, "甲");
  assert.equal(employee.enabled, true);
  assert.deepEqual(employee.poolIds, [pool.id]);
  setMode("inactive");
  const result = await directory.sync("test");
  assert.equal(result.disabled, 1);
  employee = await db.get("employees", old.id);
  assert.equal(employee.enabled, false);
  assert.equal(employee.directoryState, "inactive");
  assert.ok((await db.get("devices", device.deviceId)).revokedAt);
  assert.equal(
    (await db.list("sessions")).filter((s) => s.employeeId === old.id).length,
    0,
  );
  await assert.rejects(
    service.employee({ ...employee, enabled: true }, old.id, "test"),
    /不能启用/,
  );
});
test("visibility removal disables previously synced users without deleting identities or history", async (t) => {
  const { db, service, directory, setMode } = await setup(t);
  await directory.sync("test");
  const rows = await db.list("employees"),
    e = rows[0];
  await service.employee({ ...e, enabled: true }, e.id, "test");
  setMode("empty");
  await directory.sync("test");
  assert.equal((await db.list("employees")).length, 2);
  const current = await db.get("employees", e.id);
  assert.equal(current.enabled, false);
  assert.equal(current.directoryState, "not_visible");
});
test("permission errors and malformed pages roll back the entire sync, redact upstream messages and release lock", async (t) => {
  const { db, directory, setMode } = await setup(t);
  await directory.sync("test");
  const before = await db.list("employees");
  setMode("fail");
  await assert.rejects(
    directory.sync("test"),
    (e) => e.status === 502 && !e.message.includes(secret),
  );
  assert.deepEqual(await db.list("employees"), before);
  assert.equal(await db.get("integrationLocks", "feishu"), null);
  setMode("broken-page");
  await assert.rejects(directory.sync("test"), /分页异常/);
  assert.deepEqual(await db.list("employees"), before);
});
test("sync never re-enables manually disabled employees and concurrent syncs are refused", async (t) => {
  const { db, directory } = await setup(t);
  await directory.sync("test");
  await directory.sync("test");
  assert.ok((await db.list("employees")).every((e) => e.enabled === false));
  await db.tx((t) =>
    t.put("integrationLocks", "feishu", {
      id: "other",
      expires: Date.now() + 60000,
    }),
  );
  await assert.rejects(directory.sync("test"), (e) => e.status === 409);
});
test("identity application cannot change in an existing employee workspace", async (t) => {
  const { directory } = await setup(t);
  await directory.sync("test");
  await assert.rejects(
    directory.save(
      {
        appId: "cli_other",
        appSecret: secret,
        tenantKey: "tenant_test",
        rootIds: ["0"],
        adminIds: [],
      },
      "test",
    ),
    (e) => e.status === 409,
  );
});
test("admin-only configuration endpoints hot-load credentials and revoke old Feishu sessions on rotation", async (t) => {
  const config = {
    local: false,
    dataKey: key,
    dbFile: ":memory:",
    base: "http://127.0.0.1",
    adminPassword: "test-only-long-admin-password",
  };
  const app = await createControlServer(config);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  config.base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await app.db.close();
  });
  const request = (p, method = "GET", body, token) =>
    fetch(config.base + "/api" + p, {
      method,
      headers: {
        origin: config.base,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await request("/feishu/config")).status, 401);
  const admin = await app.auth.issue({ role: "admin", name: "test" });
  const form = {
    appId: "cli_test",
    appSecret: secret,
    tenantKey: "tenant_test",
    rootIds: ["0"],
    adminIds: [],
  };
  assert.equal(
    (await request("/feishu/config", "PUT", form, admin)).status,
    200,
  );
  const status = await (
    await request("/bootstrap", "GET", undefined, admin)
  ).json();
  assert.equal(status.feishu.configured, true);
  assert.ok(!JSON.stringify(status).includes(secret));
  const employee = await app.service.employee(
    {
      name: "Employee",
      openId: "ou_test",
      dept: "IT",
      enabled: true,
      poolIds: [],
    },
    null,
    "test",
  );
  const provider = await app.directory.credentials();
  const session = await app.auth.issue({
    role: "employee",
    employeeId: employee.id,
    authMethod: "feishu",
    feishuAt: Date.now(),
    providerRevision: provider.revision,
  });
  assert.equal(
    (await request("/feishu/config", "GET", undefined, session)).status,
    403,
  );
  const oauth = await app.auth.feishuStart();
  assert.equal(new URL(oauth.url).searchParams.get("client_id"), "cli_test");
  assert.equal(
    (
      await request(
        "/feishu/config",
        "PUT",
        { ...form, appSecret: secret + "-rotated" },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/client/status", "GET", undefined, session)).status,
    401,
  );
});
