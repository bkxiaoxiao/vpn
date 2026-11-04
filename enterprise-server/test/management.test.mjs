import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../lib/db.mjs";
import { vault, hash } from "../lib/security.mjs";
import { ControlService } from "../lib/service.mjs";
import { createControlServer } from "../server.mjs";

const content = (names) => JSON.stringify({ outbounds: names.map((name) => ({ type: "trojan", tag: name, server: name.toLowerCase() + ".example.com", server_port: 443, password: "private-test-password" })) });
async function setup(t) {
  const db = await openStore({ file: ":memory:" }); t.after(() => db.close());
  const v = vault("25".repeat(32));
  const s = new ControlService(db, v, { local: true }, async () => content(["Tokyo", "London", "NewYork"]));
  await s.init();
  const r = await s.addResource({ name: "Test", vendor: "Example", url: "https://example.com/private-subscription" }, "test");
  const p = await s.pool({ name: "旧资源池", sourceIds: [r.id] }, null, "test");
  const employee = (name) => s.employee({ name, openId: "ou_" + name, dept: "产品", enabled: true, poolIds: [p.id] }, null, "test");
  return { db, v, s, r, p, a: await employee("A"), b: await employee("B") };
}
test("pool selects individual nodes, publishes only that subset, preserves legacy pools and hides credentials", async (t) => {
  const { s, db, r, p, a } = await setup(t);
  const before = await s.bootstrap();
  assert.equal(before.pools[0].count, 3);
  assert.equal(before.resources[0].nodeDetails.length, 3);
  assert.ok(!JSON.stringify(before).includes("private-test-password"));
  assert.ok(!JSON.stringify(before).includes("private-subscription"));
  const chosen = before.resources[0].nodeDetails[1];
  const subset = await s.pool({ name: "单节点", nodeSelections: [{ resourceId: r.id, nodeIds: [chosen.id, chosen.id] }] }, null, "test");
  await s.employee({ ...a, poolIds: [subset.id] }, a.id, "test");
  await s.publish({ note: "仅 London" }, "test");
  const assigned = await db.tx((tx) => s.assignedNodes(tx, a.id));
  assert.deepEqual(assigned.nodes.map((n) => n.name), ["London"]);
  const after = await s.bootstrap();
  assert.equal(after.pools.find((x) => x.id === subset.id).count, 1);
  assert.equal(after.pools.find((x) => x.id === p.id).count, 3);
  await assert.rejects(s.pool({ name: "Invalid", nodeSelections: [{ resourceId: r.id, nodeIds: ["fake"] }] }, null, "test"));
  await assert.rejects(s.pool({ name: "Invalid", nodeSelections: [{ resourceId: "fake", nodeIds: [chosen.id] }] }, null, "test"));
});
test("subscription refresh cannot expand explicit pool selection; disappeared nodes fail closed", async (t) => {
  const { s, r, p, a, db } = await setup(t);
  const nodeId = (await s.bootstrap()).resources[0].nodeDetails[0].id;
  await s.pool({ name: "明确选择", nodeSelections: [{ resourceId: r.id, nodeIds: [nodeId] }] }, p.id, "test");
  s.fetcher = async () => content(["Tokyo", "London", "NewYork", "Paris"]);
  await s.refreshResource(r.id, "test");
  await s.publish({ note: "刷新后" }, "test");
  assert.deepEqual((await db.tx((tx) => s.assignedNodes(tx, a.id))).nodes.map((n) => n.name), ["Tokyo"]);
  s.fetcher = async () => content(["Paris"]);
  await s.refreshResource(r.id, "test");
  await s.publish({ note: "节点消失" }, "test");
  assert.equal((await s.bootstrap()).pools[0].count, 0);
  await assert.rejects(db.tx((tx) => s.assignedNodes(tx, a.id)), { status: 403 });
});
test("batch add is additive, deduplicates employees and pools, supports remove/replace without enabling users", async (t) => {
  const { s, db, a, b, p } = await setup(t);
  const second = await s.pool({ name: "第二资源池", nodeSelections: [] }, null, "test");
  await db.tx((tx) => tx.put("employees", b.id, { ...b, enabled: false }));
  const result = await s.batchEmployees({ employeeIds: [a.id, b.id, a.id], access: "keep", poolMode: "add", poolIds: [second.id, second.id] }, "admin");
  assert.equal(result.updated, 2);
  assert.deepEqual((await db.get("employees", a.id)).poolIds, [p.id, second.id]);
  assert.equal((await db.get("employees", b.id)).enabled, false);
  await s.batchEmployees({ employeeIds: [a.id], poolMode: "remove", poolIds: [p.id] }, "admin");
  assert.deepEqual((await db.get("employees", a.id)).poolIds, [second.id]);
  await s.batchEmployees({ employeeIds: [a.id], poolMode: "replace", poolIds: [] }, "admin");
  assert.deepEqual((await db.get("employees", a.id)).poolIds, []);
  assert.deepEqual((await db.get("employees", b.id)).poolIds, [p.id, second.id]);
});
test("invalid batch is atomic; directory-inactive employees cannot be re-enabled", async (t) => {
  const { s, db, a, b } = await setup(t);
  await db.tx((tx) => tx.put("employees", b.id, { ...b, directoryState: "resigned", enabled: false }));
  for (const body of [
    { employeeIds: [a.id, "missing"], access: "disable", poolIds: [] },
    { employeeIds: [a.id], access: "disable", poolIds: ["missing"] },
    { employeeIds: [a.id, b.id], access: "enable", poolIds: [] },
    { employeeIds: [], access: "enable", poolIds: [] },
  ]) await assert.rejects(s.batchEmployees(body, "admin"));
  assert.equal((await db.get("employees", a.id)).enabled, true);
  assert.equal((await db.get("employees", b.id)).enabled, false);
});
test("batch disable revokes only selected employees' devices and sessions and records exact targets", async (t) => {
  const { s, db, a, b } = await setup(t);
  const d1 = await s.createDevice(a.id, { name: "A PC", platform: "Windows" }, "test");
  const d2 = await s.createDevice(b.id, { name: "B PC", platform: "Windows" }, "test");
  await s.batchEmployees({ employeeIds: [a.id], access: "disable", poolIds: [] }, "admin");
  assert.ok((await db.get("devices", d1.deviceId)).revokedAt);
  assert.equal(await db.get("sessions", hash(d1.token)), null);
  assert.equal((await db.get("devices", d2.deviceId)).revokedAt, null);
  assert.ok(await db.get("sessions", hash(d2.token)));
  const log = (await db.list("audit")).find((x) => x.action === "批量员工授权");
  assert.deepEqual(JSON.parse(log.target).employeeIds, [a.id]);
});
test("bulk API remains admin-only and management script is served as JavaScript", async (t) => {
  const { s, db, a } = await setup(t);
  const config = { local: false, base: "http://127.0.0.1", dataKey: "25".repeat(32) };
  const app = await createControlServer(config, { db });
  const server = app.server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  config.base = base;
  const token = await app.auth.issue({ role: "employee", employeeId: a.id });
  const response = await fetch(base + "/api/employees/batch", { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ employeeIds: [a.id], access: "disable", poolIds: [] }) });
  assert.equal(response.status, 403);
  assert.equal((await db.get("employees", a.id)).enabled, true);
  const script = await fetch(base + "/management.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
});
