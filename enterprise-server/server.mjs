import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openStore } from "./lib/db.mjs";
import { loadConfig, vault, fail, hash, text, now } from "./lib/security.mjs";
import { ControlService } from "./lib/service.mjs";
import { Auth } from "./lib/auth.mjs";
import { DesktopAuth } from "./lib/desktop-auth.mjs";
import { FeishuDirectory } from "./lib/feishu-directory.mjs";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
export async function createControlServer(config, options = {}) {
  const db =
      options.db ||
      (await openStore({ url: config.dbUrl, file: config.dbFile })),
    v = vault(config.dataKey),
    service = new ControlService(db, v, config, options.fetcher),
    directory = new FeishuDirectory(
      db,
      v,
      config,
      service.audit.bind(service),
      options.directoryFetch,
    ),
    auth = new Auth(db, config, options.authFetch, () =>
      directory.credentials(),
    );
  const desktop = new DesktopAuth(db, auth, service, config);
  await service.init();
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, "http://localhost"),
        p = url.pathname,
        m = req.method;
      if (m === "GET" && ["/health", "/healthz"].includes(p)) {
        await db.get("settings", "main");
        return json(res, 200, { ok: true });
      }
      if (
        m === "GET" &&
        ["/", "/index.html", "/app.js", "/management.js", "/style.css", "/favicon.svg"].includes(
          p,
        )
      ) {
        const f = p === "/" ? "index.html" : p.slice(1);
        const body = await readFile(path.join(publicDir, f));
        res.setHeader(
          "content-type",
          {
            html: "text/html; charset=utf-8",
            js: "text/javascript; charset=utf-8",
            css: "text/css; charset=utf-8",
            svg: "image/svg+xml",
          }[f.split(".").at(-1)],
        );
        res.end(body);
        return;
      }
      if (m === "GET" && p === "/auth/feishu/start") {
        const x = await auth.feishuStart();
        res.setHeader(
          "set-cookie",
          `relay_oauth=${x.state}; HttpOnly; SameSite=Lax; Path=/auth/feishu; Max-Age=300${config.local ? "" : "; Secure"}`,
        );
        return redirect(res, x.url);
      }
      if (m === "GET" && p === "/auth/feishu/callback") {
        const result = await auth.feishuCallback(
          text(url.searchParams.get("code"), "code", 3000),
          text(url.searchParams.get("state"), "state", 200),
          /(?:^|;\s*)relay_oauth=([^;]+)/.exec(req.headers.cookie || "")?.[1],
        );
        if (result.desktop)
          return redirect(res, await desktop.complete(result));
        auth.setCookie(res, result.token);
        return redirect(res, "/");
      }
      if (m === "GET" && p === "/auth/desktop/start") {
        const state = text(url.searchParams.get("state"), "登录事务", 200);
        const dest = await desktop.authorize(state);
        res.setHeader(
          "set-cookie",
          `relay_oauth=${state}; HttpOnly; SameSite=Lax; Path=/auth/feishu; Max-Age=300${config.local ? "" : "; Secure"}`,
        );
        return redirect(res, dest);
      }
      // Browser writes must be same-origin; machine API callers use Bearer authentication.
      if (!["GET", "HEAD"].includes(m)) {
        if (
          req.headers.origin &&
          req.headers.origin !== new URL(config.base).origin
        )
          fail("跨站请求已拒绝", 403);
        if (req.headers["sec-fetch-site"] === "cross-site")
          fail("跨站请求已拒绝", 403);
        if (
          !req.headers.origin &&
          !req.headers.authorization &&
          !["/api/desktop/auth/start", "/api/desktop/auth/exchange"].includes(
            p,
          ) &&
          !(
            config.local &&
            ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket.remoteAddress,
            )
          )
        )
          fail("缺少请求来源", 403);
      }
      if (m === "POST" && p === "/api/desktop/auth/start")
        return json(res, 200, await desktop.start(await readJson(req)));
      if (m === "POST" && p === "/api/desktop/auth/exchange")
        return json(res, 200, await desktop.exchange(await readJson(req)));
      if (m === "POST" && p === "/api/auth/login") {
        const body = await readJson(req),
          result = await auth.login(body.password, req);
        if (!result.ok) fail(result.error, result.status);
        const token = await auth.issue({ role: "admin", name: "管理员" });
        auth.setCookie(res, token);
        return json(res, 200, { ok: true });
      }
      if (p.startsWith("/api/gateway/")) {
        const g = await auth.gateway(req);
        if (m === "GET" && p === "/api/gateway/config") {
          const data = await service.gatewayConfig(g.id);
          data.digest = hash(JSON.stringify(data.config));
          await db.tx(async (t) => {
            const current = await t.get("gateways", g.id);
            await t.put("gateways", g.id, {
              ...current,
              desiredDigest: data.digest,
              desiredCredentialIds: data.config.inbounds[0].users.map(
                (u) => u.username,
              ),
            });
          });
          return json(res, 200, data);
        }
        if (m === "POST" && p === "/api/gateway/ack") {
          const b = await readJson(req);
          await db.tx(async (t) => {
            const current = await t.get("gateways", g.id);
            if (!b.digest || b.digest !== current.desiredDigest)
              fail("配置已变更，请重新获取", 409);
            await t.put("gateways", g.id, {
              ...current,
              appliedDigest: b.digest,
              appliedCredentialIds: current.desiredCredentialIds,
              appliedAt: now(),
              lastSeen: now(),
            });
          });
          return json(res, 200, { ok: true });
        }
        if (m === "POST" && p === "/api/gateway/usage")
          return json(
            res,
            200,
            await service.ingest(g.id, await readJson(req)),
          );
        fail("接口不存在", 404);
      }
      if (m === "POST" && p === "/api/jobs/refresh") {
        if (
          !config.jobToken ||
          req.headers.authorization !== "Bearer " + config.jobToken
        )
          fail("任务凭证无效", 401);
        return json(res, 200, {
          results: await service.refreshAll("定时任务", { dueOnly: true }),
        });
      }
      const session = await auth.session(req),
        actor = session.name || "管理员";
      if (m === "GET" && p === "/api/me")
        return json(res, 200, {
          role: session.role,
          name: actor,
          local: !!session.local,
          employeeId: session.employeeId,
          feishuOpenId: session.feishuOpenId,
        });
      if (m === "POST" && p === "/api/auth/logout") {
        if (auth.cookie(req))
          await db.tx((t) => t.del("sessions", hash(auth.cookie(req))));
        res.setHeader(
          "set-cookie",
          "relay_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        );
        return json(res, 200, { ok: true });
      }
      if (p.startsWith("/api/client/")) {
        service.requireFeishu(session);
        if (m === "GET" && p === "/api/client/status")
          return json(res, 200, {
            authentication: "feishu",
            name: session.name,
            expiresAt: new Date(session.expires).toISOString(),
            deviceId: session.deviceId,
          });
        if (m === "POST" && p === "/api/client/logout") {
          await db.tx((t) => t.del("sessions", session.id));
          return json(res, 200, { ok: true });
        }
        if (!session.employeeId) fail("需要员工身份", 403);
        if (m === "POST" && p === "/api/client/devices")
          return json(
            res,
            201,
            await service.createDevice(
              session.employeeId,
              await readJson(req),
              actor,
              {
                authMethod: "feishu",
                feishuAt: session.feishuAt,
                providerRevision: session.providerRevision,
              },
            ),
          );
        if (!session.deviceId) fail("需要设备令牌", 403);
        if (m === "GET" && p === "/api/client/policy") {
          const data = await service.clientPolicy(session);
          return json(res, 200, data);
        }
        if (m === "POST" && p === "/api/client/ack") {
          const b = await readJson(req);
          await db.tx(async (t) => {
            const d = await t.get("devices", session.deviceId),
              assigned = await service.assignedNodes(t, session.employeeId);
            if (b.revision !== assigned.revision) fail("版本已变更", 409);
            if (!["downloaded", "validated", "applied"].includes(b.stage))
              fail("回执阶段无效");
            await t.put("devices", d.id, {
              ...d,
              ackRevision: b.revision,
              ackStage: b.stage,
              lastSeen: now(),
            });
          });
          return json(res, 200, { ok: true });
        }
        fail("接口不存在", 404);
      }
      if (session.role !== "admin") fail("仅限管理员访问", 403);
      if (m === "GET" && p === "/api/bootstrap") {
        const data = await service.bootstrap();
        data.feishu = await directory.status();
        data.environment.feishu = data.feishu.configured;
        return json(res, 200, data);
      }
      if (m === "GET" && p === "/api/feishu/config")
        return json(res, 200, await directory.status());
      if (m === "PUT" && p === "/api/feishu/config")
        return json(res, 200, await directory.save(await readJson(req), actor, session));
      if (m === "POST" && p === "/api/feishu/admins")
        return json(res, 200, await directory.changeAdministrator(await readJson(req), actor, session));
      if (m === "POST" && p === "/api/feishu/check")
        return json(res, 200, await directory.check());
      if (m === "POST" && p === "/api/feishu/sync")
        return json(res, 200, await directory.sync(actor));
      if (m === "GET" && p === "/api/usage") {
        const from =
            url.searchParams.get("from") ||
            new Date(new Date().setUTCDate(1)).toISOString().slice(0, 10) +
              "T00:00:00Z",
          to = url.searchParams.get("to") || now();
        return json(res, 200, await service.usage(from, to));
      }
      if (m === "POST" && p === "/api/resources")
        return json(
          res,
          201,
          await service.addResource(await readJson(req), actor),
        );
      if (m === "POST" && p === "/api/resources/refresh")
        return json(res, 200, { results: await service.refreshAll(actor) });
      if (m === "POST" && p === "/api/pools")
        return json(
          res,
          201,
          await service.pool(await readJson(req), null, actor),
        );
      let match;
      if (m === "PUT" && (match = p.match(/^\/api\/pools\/([^/]+)$/)))
        return json(
          res,
          200,
          await service.pool(await readJson(req), match[1], actor),
        );
      if (m === "POST" && p === "/api/employees")
        return json(
          res,
          201,
          await service.employee(await readJson(req), null, actor),
        );
      if (m === "POST" && p === "/api/employees/batch")
        return json(res, 200, await service.batchEmployees(await readJson(req), actor));
      if (m === "PUT" && (match = p.match(/^\/api\/employees\/([^/]+)$/)))
        return json(
          res,
          200,
          await service.employee(await readJson(req), match[1], actor),
        );
      if (
        m === "POST" &&
        (match = p.match(/^\/api\/employees\/([^/]+)\/devices$/))
      )
        return json(
          res,
          201,
          await service.createDevice(match[1], await readJson(req), actor),
        );
      if (m === "DELETE" && (match = p.match(/^\/api\/devices\/([^/]+)$/))) {
        await service.revokeDevice(match[1], actor);
        return json(res, 200, { ok: true });
      }
      if (m === "POST" && p === "/api/releases")
        return json(
          res,
          201,
          await service.publish(await readJson(req), actor),
        );
      if (m === "POST" && p === "/api/gateways")
        return json(
          res,
          201,
          await service.addGateway(await readJson(req), actor),
        );
      if (m === "PUT" && p === "/api/settings") {
        const b = await readJson(req);
        if (
          ![15, 30, 60, 360].includes(b.interval) ||
          ![1, 2, 3, 5, 10].includes(b.limit) ||
          ![1, 4, 24].includes(b.grace) ||
          !["direct", "gateway"].includes(b.deliveryMode)
        )
          fail("设置参数无效");
        const data = {
          workspace: text(b.workspace, "工作空间名称", 100),
          interval: b.interval,
          limit: b.limit,
          grace: b.grace,
          deliveryMode: b.deliveryMode,
        };
        await db.tx(async (t) => {
          await t.put("settings", "main", data);
          await service.audit(t, "保存工作空间设置", data.workspace, actor);
        });
        return json(res, 200, data);
      }
      fail("接口不存在", 404);
    } catch (e) {
      if (res.headersSent) return res.end();
      json(res, e.status || 500, {
        error: e.status ? e.message : "服务暂时不可用，请稍后重试",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return { server, db, service, auth, desktop, directory };
}
async function readJson(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json"))
    fail("请求应为 JSON", 415);
  let size = 0,
    parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 3 * 1024 * 1024) fail("请求过大", 413);
    parts.push(part);
  }
  let b;
  try {
    b = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    fail("JSON 格式无效");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) fail("请求必须为对象");
  return b;
}
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function redirect(res, url) {
  res.writeHead(302, { location: url });
  res.end();
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const config = loadConfig(),
    app = await createControlServer(config);
  app.server.listen(config.port, config.host, () =>
    console.log(
      `Relay ready: ${config.local ? "http://127.0.0.1:" + config.port : "PORT " + config.port} (${app.db.type}${config.local ? ", LOCAL DEV" : ""})`,
    ),
  );
  const shutdown = () => {
    app.server.close(async () => {
      await app.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
