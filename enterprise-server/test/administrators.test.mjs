import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../lib/security.mjs";
import { createControlServer } from "../server.mjs";

async function fixture(t) {
  const config = { local: false, base: "http://127.0.0.1", dataKey: "62".repeat(32), dbFile: ":memory:" };
  let profileId = "ou_other";
  const authFetch = async (url) => new Response(JSON.stringify(url.includes("oauth/token")
    ? { access_token: "test-only-upstream" }
    : { code: 0, data: { open_id: profileId, name: "Other", tenant_key: "tenant_test" } }));
  const app = await createControlServer(config, { authFetch });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  config.base += ":" + app.server.address().port;
  t.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); await app.db.close(); });
  async function employee(name, enabled) {
    const e = await app.service.employee({ name, openId: "ou_" + name, dept: "IT", enabled, poolIds: [] }, null, "fixture");
    await app.db.tx((tx) => tx.put("employees", e.id, { ...e, directoryState: "active" }));
    return e;
  }
  const jack = await employee("jack", true), other = await employee("other", false), worker = await employee("worker", true);
  const form = { appId: "cli_test", appSecret: "test-only-feishu-secret", tenantKey: "tenant_test", rootIds: ["0"], adminIds: [jack.openId] };
  await app.directory.save(form, "fixture");
  const provider = await app.directory.credentials();
  const session = (e, role = "admin", extra = {}) => ({ role, employeeId: e.id, name: e.name, authMethod: "feishu", feishuOpenId: e.openId, feishuAt: Date.now(), providerRevision: provider.revision, ...extra });
  const jackSession = session(jack);
  const jackToken = await app.auth.issue(jackSession);
  const workerToken = await app.auth.issue(session(worker, "employee"));
  const request = (p, token = jackToken, body) => fetch(config.base + "/api" + p, {
    method: body ? "POST" : "GET", headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json", origin: config.base } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { ...app, config, form, jack, other, worker, jackSession, jackToken, workerToken, request, session, provider, profile: (id) => { profileId = id; } };
}
test("admin-only membership API adds selected Feishu identity without changing credentials, client grants or existing sessions", async (t) => {
  const f = await fixture(t);
  for (const token of [null, f.workerToken]) {
    const r = await f.request("/feishu/admins", token, { action: "add", openId: f.other.openId });
    assert.equal(r.status, token ? 403 : 401);
  }
  const before = await f.directory.credentials();
  const response = await f.request("/feishu/admins", f.jackToken, { action: "add", openId: f.other.openId });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.administrators.map((a) => a.name), ["jack", "other"]);
  assert.ok(!JSON.stringify(body).includes(before.appSecret));
  assert.deepEqual(await f.directory.credentials(), { ...before, adminIds: [f.jack.openId, f.other.openId] });
  assert.equal((await f.db.get("employees", f.other.id)).enabled, false);
  assert.equal((await f.request("/bootstrap")).status, 200);
  assert.equal((await f.request("/me", f.workerToken)).status, 200);
  await f.directory.changeAdministrator({ action: "add", openId: f.other.openId }, "jack", f.jackSession);
  assert.equal((await f.directory.administrators()).length, 2);
});
test("real OAuth callback creates an admin browser session even without employee VPN authorization", async (t) => {
  const f = await fixture(t);
  await f.directory.changeAdministrator({ action: "add", openId: f.other.openId }, "jack", f.jackSession);
  const oauth = await f.auth.feishuStart();
  const login = await f.auth.feishuCallback("code", oauth.state, oauth.state);
  assert.equal((await f.request("/bootstrap", login.token)).status, 200);
  assert.equal((await f.request("/client/policy", login.token)).status, 403);
  assert.equal((await f.db.get("sessions", hash(login.token))).feishuOpenId, f.other.openId);
  await f.directory.changeAdministrator({ action: "remove", openId: f.other.openId }, "jack", f.jackSession);
  assert.equal((await f.request("/bootstrap", login.token)).status, 401);
  const oauth2 = await f.auth.feishuStart();
  await assert.rejects(f.auth.feishuCallback("code", oauth2.state, oauth2.state), { status: 403 });
});
test("removal rejects self/last-admin changes and only revokes the removed admin's browser sessions", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.directory.changeAdministrator({ action: "remove", openId: f.jack.openId }, "jack", f.jackSession), { status: 409 });
  await assert.rejects(f.directory.changeAdministrator({ action: "remove", openId: f.jack.openId }, "password admin"), { status: 409 });
  await f.directory.changeAdministrator({ action: "add", openId: f.other.openId }, "jack", f.jackSession);
  const otherToken = await f.auth.issue(f.session(f.other));
  const employeeToken = await f.auth.issue(f.session(f.other, "employee"));
  await f.directory.changeAdministrator({ action: "remove", openId: f.other.openId }, "jack", f.jackSession);
  assert.equal(await f.db.get("sessions", hash(otherToken)), null);
  assert.ok(await f.db.get("sessions", hash(employeeToken)));
  assert.ok(await f.db.get("sessions", hash(f.jackToken)));
  assert.equal((await f.request("/bootstrap")).status, 200);
  const logs = await f.db.list("audit");
  assert.ok(logs.some((l) => l.action === "移除系统管理员" && l.target.includes(f.other.openId)));
});
test("legacy admin sessions are revalidated against current membership on every request", async (t) => {
  const f = await fixture(t);
  const token = await f.auth.issue(f.session(f.worker));
  assert.equal((await f.request("/bootstrap", token)).status, 403);
  const legacy = f.session(f.other); delete legacy.feishuOpenId;
  const legacyToken = await f.auth.issue(legacy);
  await f.directory.changeAdministrator({ action: "add", openId: f.other.openId }, "jack", f.jackSession);
  assert.equal((await f.request("/bootstrap", legacyToken)).status, 200);
  // Simulate old configuration edits without changing the OAuth credential revision.
  await f.db.tx(async (tx) => { const c = await f.directory.credentials(tx); const { revision, ...credentials } = c;
    await tx.put("integrations", "feishu", { revision, encrypted: f.directory.vault.seal({ ...credentials, adminIds: [f.jack.openId] }) }); });
  assert.equal((await f.request("/bootstrap", legacyToken)).status, 403);
});
test("invalid, unsynced and departed candidates cannot receive admin privileges; config save preserves membership", async (t) => {
  const f = await fixture(t);
  await f.db.tx((tx) => tx.put("employees", f.worker.id, { ...f.worker, directoryState: "resigned" }));
  for (const openId of ["ou_missing", f.worker.openId, "bad-id"])
    await assert.rejects(f.directory.changeAdministrator({ action: "add", openId }, "jack", f.jackSession));
  assert.deepEqual((await f.directory.credentials()).adminIds, [f.jack.openId]);
  const { adminIds, ...form } = f.form;
  await f.directory.save(form, "jack", f.jackSession);
  assert.deepEqual((await f.directory.credentials()).adminIds, [f.jack.openId]);
  await assert.rejects(f.directory.save({ ...form, adminIds: [] }, "jack", f.jackSession), { status: 409 });
});
