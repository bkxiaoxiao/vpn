import { id, now, hash, text, fail, publicEmployee } from "./security.mjs";
import { parseNodes, fetchSubscription } from "./subscriptions.mjs";
import { poolNodes, validateSelections } from "./resource-selection.mjs";

export class ControlService {
  constructor(db, vault, config, fetcher = fetchSubscription) {
    Object.assign(this, { db, vault, config, fetcher });
  }
  async init() {
    await this.db.tx(async (t) => {
      if (!(await t.get("settings", "main")))
        await t.put("settings", "main", {
          workspace: "企业网络工作空间",
          interval: 30,
          limit: 3,
          grace: 4,
          deliveryMode: "direct",
        });
    });
  }
  async audit(t, action, target, actor = "管理员") {
    await t.put("audit", `${now()}-${id()}`, {
      id: id(),
      action,
      target,
      actor,
      time: now(),
      status: "成功",
    });
  }
  async bootstrap() {
    const [
      resources,
      pools,
      employees,
      devices,
      logs,
      releases,
      gateways,
      settings,
    ] = await Promise.all(
      [
        "resources",
        "pools",
        "employees",
        "devices",
        "audit",
        "releases",
        "gateways",
      ]
        .map((k) => this.db.list(k))
        .concat(this.db.get("settings", "main")),
    );
    const publicResources = resources.map(({ encrypted, ...r }) => ({
      ...r,
      nodes: r.nodeCount,
      nodeDetails: this.vault.open(encrypted).nodes.map(
        ({ id, name, protocol, server, port }) => ({ id, name, protocol, server, port }),
      ),
      updated: r.updatedAt || "尚未同步",
    }));
    return {
      resources: publicResources,
      pools: pools.map((p) => ({
        ...p,
        count: new Set(poolNodes(p, resources, this.vault).map((n) => n.id)).size,
        members: employees.filter((e) => e.poolIds.includes(p.id)).length,
      })),
      employees: employees.map((e) => ({
        ...publicEmployee(e),
        devices: devices
          .filter((d) => d.employeeId === e.id)
          .map(({ password, ...d }) => d),
      })),
      logs: logs.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 300),
      releases: releases
        .map(({ encrypted, ...r }) => r)
        .sort((a, b) => b.revision - a.revision),
      gateways: gateways.map(({ tokenHash, ...g }) => g),
      settings,
      environment: {
        local: this.config.local,
        database: this.db.type,
        feishu: !!(this.config.feishuId && this.config.tenant),
        deployed: !!this.config.cloudRun,
      },
    };
  }
  async addResource(body, actor) {
    const name = text(body.name, "资源名称", 100),
      vendor = text(body.vendor, "供应商", 100);
    let content, sourceUrl;
    if (body.url) {
      sourceUrl = text(body.url, "订阅链接", 4096);
      content = await this.fetcher(sourceUrl);
    } else content = text(body.content, "节点或配置", 2 * 1024 * 1024);
    const { nodes, warnings } = parseNodes(content);
    const r = {
      id: id(),
      name,
      vendor,
      format: body.format ? text(body.format, "资源格式", 30) : "自动识别",
      nodeCount: nodes.length,
      status: "已解析",
      createdAt: now(),
      updatedAt: now(),
      encrypted: this.vault.seal({ sourceUrl, nodes }),
    };
    await this.db.tx(async (t) => {
      await t.put("resources", r.id, r);
      await this.audit(t, "导入资源", name, actor);
    });
    return { id: r.id, nodeCount: nodes.length, warnings };
  }
  async refreshResource(resourceId, actor) {
    const r = await this.db.get("resources", resourceId);
    if (!r) fail("资源不存在", 404);
    const { sourceUrl } = this.vault.open(r.encrypted);
    if (!sourceUrl) return { id: r.id, skipped: true };
    const parsed = parseNodes(await this.fetcher(sourceUrl));
    await this.db.tx(async (t) => {
      const current = await t.get("resources", r.id);
      if (!current || current.encrypted !== r.encrypted)
        fail("资源已变更，请重试", 409);
      await t.put("resources", r.id, {
        ...current,
        nodeCount: parsed.nodes.length,
        updatedAt: now(),
        status: "已解析",
        encrypted: this.vault.seal({ sourceUrl, nodes: parsed.nodes }),
      });
      await this.audit(t, "更新订阅", r.name, actor);
    });
    return {
      id: r.id,
      nodeCount: parsed.nodes.length,
      warnings: parsed.warnings,
    };
  }
  async refreshAll(actor, { dueOnly = false } = {}) {
    const results = [],
      settings = await this.db.get("settings", "main");
    for (const r of await this.db.list("resources")) {
      if (
        dueOnly &&
        r.updatedAt &&
        Date.now() - Date.parse(r.updatedAt) < settings.interval * 60000
      ) {
        results.push({ id: r.id, skipped: true });
        continue;
      }
      try {
        results.push(await this.refreshResource(r.id, actor));
      } catch {
        results.push({ id: r.id, error: "订阅更新失败，已保留原配置" });
        await this.db.tx(async (t) => {
          await this.audit(t, "订阅更新失败", r.name, actor);
        });
      }
    }
    return results;
  }
  async pool(body, poolId, actor) {
    return this.db.tx(async (t) => {
      const resources = await t.list("resources");
      const sourceIds = Array.isArray(body.sourceIds)
        ? [...new Set(body.sourceIds)]
        : [];
      if (sourceIds.some((x) => !resources.some((r) => r.id === x)))
        fail("资源来源不存在");
      const nodeSelections = body.nodeSelections === undefined ? undefined
        : validateSelections(body.nodeSelections, resources, this.vault);
      const p = {
        id: poolId || id(),
        name: text(body.name, "资源池名称", 100),
        desc: String(body.desc || "").slice(0, 300),
        sourceIds: nodeSelections ? nodeSelections.map((s) => s.resourceId) : sourceIds,
        ...(nodeSelections ? { nodeSelections } : {}),
      };
      if (poolId && !(await t.get("pools", poolId))) fail("资源池不存在", 404);
      await t.put("pools", p.id, p);
      await this.audit(t, "保存资源池", p.name, actor);
      return p;
    });
  }
  async employee(body, employeeId, actor) {
    return this.db.tx(async (t) => {
      const old = employeeId ? await t.get("employees", employeeId) : null;
      if (employeeId && !old) fail("员工不存在", 404);
      const openId = text(body.openId, "飞书 open_id", 100),
        name = text(body.name, "姓名", 100),
        dept = text(body.dept, "部门", 100);
      if (old && old.openId !== openId)
        fail("飞书身份不能替换，请为另一位员工创建独立记录");
      if (
        (await t.list("employees")).some(
          (e) => e.openId === openId && e.id !== employeeId,
        )
      )
        fail("该飞书身份已经存在", 409);
      const pools = await t.list("pools");
      const poolIds = Array.isArray(body.poolIds)
        ? [...new Set(body.poolIds)]
        : [];
      if (poolIds.some((x) => !pools.some((p) => p.id === x)))
        fail("资源池不存在");
      if (typeof body.enabled !== "boolean") fail("enabled 必须为布尔值");
      if (
        body.enabled &&
        old?.directoryState &&
        old.directoryState !== "active"
      )
        fail("该员工已离职、冻结或不在同步范围内，不能启用");
      const e = {
        ...(old || {}),
        id: employeeId || id(),
        openId,
        name,
        dept,
        poolIds,
        enabled: body.enabled,
        createdAt: old?.createdAt || now(),
      };
      await t.put("employees", e.id, e);
      if (!e.enabled) {
        for (const d of await t.list("devices"))
          if (d.employeeId === e.id && !d.revokedAt)
            await t.put("devices", d.id, { ...d, revokedAt: now() });
        for (const s of await t.list("sessions"))
          if (s.employeeId === e.id) await t.del("sessions", s.id);
      }
      await this.audit(
        t,
        e.enabled ? "保存员工授权" : "停用员工",
        e.name,
        actor,
      );
      return publicEmployee(e);
    });
  }
  async batchEmployees(body, actor) {
    if (!Array.isArray(body.employeeIds) || !body.employeeIds.length || body.employeeIds.length > 5000)
      fail("请选择 1 至 5000 位员工");
    const ids = [...new Set(body.employeeIds)];
    const access = body.access ?? "keep", mode = body.poolMode ?? "add";
    if (!["keep", "enable", "disable"].includes(access) || !["add", "remove", "replace"].includes(mode))
      fail("批量操作无效");
    if (!Array.isArray(body.poolIds)) fail("资源池选择格式无效");
    const poolIds = [...new Set(body.poolIds)];
    if (access === "keep" && mode !== "replace" && !poolIds.length) fail("请选择授权或资源变更");
    return this.db.tx(async (t) => {
      const employees = await t.list("employees"), pools = await t.list("pools");
      if (poolIds.some((x) => !pools.some((p) => p.id === x))) fail("资源池不存在");
      const selected = ids.map((id) => employees.find((e) => e.id === id));
      if (selected.some((e) => !e)) fail("部分员工不存在，请刷新后重试", 409);
      if (access === "enable" && selected.some((e) => e.directoryState && e.directoryState !== "active"))
        fail("所选员工中包含已离职、冻结或不在同步范围内的成员，不能启用", 409);
      for (const e of selected) {
        const assigned = mode === "replace" ? poolIds : mode === "remove"
          ? e.poolIds.filter((id) => !poolIds.includes(id)) : [...new Set([...e.poolIds, ...poolIds])];
        await t.put("employees", e.id, { ...e, poolIds: assigned,
          enabled: access === "keep" ? e.enabled : access === "enable" });
      }
      if (access === "disable") {
        for (const d of await t.list("devices"))
          if (ids.includes(d.employeeId) && !d.revokedAt)
            await t.put("devices", d.id, { ...d, revokedAt: now() });
        for (const s of await t.list("sessions"))
          if (ids.includes(s.employeeId)) await t.del("sessions", s.id);
      }
      await this.audit(t, "批量员工授权", JSON.stringify({ employeeIds: ids, access, poolMode: mode, poolIds }), actor);
      return { updated: selected.length };
    });
  }
  async addGateway(body, actor) {
    const token = id() + id();
    const host = text(body.host, "网关域名", 253);
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || host === "localhost")
      fail("网关域名无效");
    const port = Number(body.port || 8443);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      fail("网关端口无效");
    const g = {
      id: id(),
      name: text(body.name, "网关名称", 100),
      host,
      port,
      tokenHash: hash(token),
      createdAt: now(),
      lastSeen: null,
      configRevision: null,
    };
    await this.db.tx(async (t) => {
      await t.put("gateways", g.id, g);
      await this.audit(t, "注册计量网关", g.name, actor);
    });
    return { id: g.id, token };
  }
  async createDevice(employeeId, body, actor, proof = {}) {
    const sessionToken = id() + id();
    return this.db.tx(async (t) => {
      const e = await t.get("employees", employeeId);
      if (!e?.enabled) fail("员工未授权或已停用", 403);
      const settings = await t.get("settings", "main");
      const devices = await t.list("devices");
      const existing =
        proof.authMethod === "feishu" && proof.installationId
          ? devices.find(
              (d) =>
                d.employeeId === e.id &&
                d.installationId === proof.installationId &&
                !d.revokedAt,
            )
          : null;
      if (existing) {
        for (const old of await t.list("sessions"))
          if (old.deviceId === existing.id) await t.del("sessions", old.id);
        const expires = Date.now() + 8 * 3600_000;
        await t.put("sessions", hash(sessionToken), {
          id: hash(sessionToken),
          employeeId: e.id,
          deviceId: existing.id,
          role: "employee",
          authMethod: "feishu",
          providerRevision: proof.providerRevision,
          feishuAt: proof.feishuAt,
          expires,
        });
        await this.audit(
          t,
          "飞书设备重新登录",
          e.name + " · " + existing.name,
          actor,
        );
        return {
          deviceId: existing.id,
          token: sessionToken,
          expiresAt: new Date(expires).toISOString(),
        };
      }
      if (
        devices.filter((d) => d.employeeId === e.id && !d.revokedAt).length >=
        settings.limit
      )
        fail("已达到设备数量上限");
      const gatewayId = body.gatewayId || null;
      if (gatewayId && !(await t.get("gateways", gatewayId)))
        fail("网关不存在");
      const platform = text(body.platform, "平台", 20);
      if (!["Windows", "macOS", "Android", "iOS"].includes(platform))
        fail("平台无效");
      const d = {
        id: id(),
        credentialId: id(),
        employeeId: e.id,
        name: text(body.name, "设备名称", 100),
        platform,
        gatewayId,
        installationId: proof.installationId || null,
        createdAt: now(),
        revokedAt: null,
        ackRevision: null,
        lastSeen: null,
        password: this.vault.seal(id() + id()),
      };
      await t.put("devices", d.id, d);
      await t.put("sessions", hash(sessionToken), {
        id: hash(sessionToken),
        employeeId: e.id,
        deviceId: d.id,
        role: "employee",
        authMethod: proof.authMethod || "admin-provisioned",
        providerRevision: proof.providerRevision,
        feishuAt: proof.authMethod === "feishu" ? proof.feishuAt : null,
        expires: Date.now() + 8 * 3600_000,
      });
      await this.audit(t, "注册设备", `${e.name} · ${d.name}`, actor);
      return {
        deviceId: d.id,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      };
    });
  }
  async revokeDevice(deviceId, actor) {
    return this.db.tx(async (t) => {
      const d = await t.get("devices", deviceId);
      if (!d) fail("设备不存在", 404);
      await t.put("devices", d.id, { ...d, revokedAt: now() });
      for (const s of await t.list("sessions"))
        if (s.deviceId === d.id) await t.del("sessions", s.id);
      await this.audit(t, "撤销设备", d.name, actor);
    });
  }
  async publish(body, actor) {
    return this.db.tx(async (t) => {
      const note = text(body.note, "变更说明", 500);
      let snapshot;
      if (body.rollbackId) {
        const old = await t.get("releases", body.rollbackId);
        if (!old) fail("历史版本不存在", 404);
        snapshot = this.vault.open(old.encrypted);
      } else {
        const resources = await t.list("resources");
        snapshot = (await t.list("pools")).map((p) => ({
          ...p,
          nodes: poolNodes(p, resources, this.vault),
        }));
      }
      const revision =
        Math.max(0, ...(await t.list("releases")).map((r) => r.revision)) + 1;
      const r = {
        id: id(),
        revision,
        note,
        time: now(),
        actor,
        encrypted: this.vault.seal(snapshot),
      };
      await t.put("releases", r.id, r);
      await this.audit(
        t,
        body.rollbackId ? "回滚配置" : "发布配置",
        `v${revision} · ${note}`,
        actor,
      );
      return { id: r.id, revision };
    });
  }
  async assignedNodes(t, employeeId) {
    const employee = await t.get("employees", employeeId);
    if (!employee?.enabled) fail("员工未授权", 403);
    const releases = (await t.list("releases")).sort(
      (a, b) => b.revision - a.revision,
    );
    if (!releases.length) fail("管理员尚未发布配置", 409);
    const release = releases[0],
      snapshot = this.vault.open(release.encrypted),
      currentPools = await t.list("pools");
    const granted = new Set(
      employee.poolIds.filter((p) => currentPools.some((x) => x.id === p)),
    );
    const nodes = snapshot
      .filter((p) => granted.has(p.id))
      .flatMap((p) => p.nodes);
    if (!nodes.length) fail("没有获授权的已发布节点", 403);
    const dedup = [...new Map(nodes.map((n) => [n.id, n])).values()];
    return { nodes: dedup, revision: release.revision };
  }
  requireFeishu(session) {
    if (
      session.authMethod !== "feishu" ||
      !Number.isFinite(session.feishuAt) ||
      Date.now() - session.feishuAt > 8 * 3600_000
    )
      fail("必须先通过飞书登录", 403);
  }
  async clientPolicy(session) {
    this.requireFeishu(session);
    return this.db.tx(async (t) => {
      const d = await t.get("devices", session.deviceId);
      if (!d || d.revokedAt) fail("设备已停用", 403);
      const settings = await t.get("settings", "main");
      const { nodes, revision } = await this.assignedNodes(t, d.employeeId);
      let outbounds;
      if (settings.deliveryMode === "gateway") {
        const g = d.gatewayId && (await t.get("gateways", d.gatewayId));
        if (!g) fail("该设备尚未绑定计量网关", 409);
        if (
          !g.lastSeen ||
          !g.appliedCredentialIds?.includes(d.credentialId) ||
          g.appliedDigest !== g.desiredDigest ||
          Date.now() - Date.parse(g.lastSeen) > 180000
        )
          fail("计量网关尚未就绪或心跳已过期", 503);
        outbounds = [
          {
            type: "http",
            tag: "企业计量网关",
            server: g.host,
            server_port: g.port,
            username: d.credentialId,
            password: this.vault.open(d.password),
            tls: { enabled: true, server_name: g.host },
          },
        ];
      } else
        outbounds = nodes.map((n) => ({
          ...n.outbound,
          tag: `${n.name} · ${n.id}`,
        }));
      await t.put("devices", d.id, { ...d, lastSeen: now() });
      const tags = outbounds.map((o) => o.tag);
      return {
        revision,
        authentication: "feishu",
        deviceId: d.id,
        metering: settings.deliveryMode === "gateway" ? "gateway" : "unmetered",
        expiresAt: new Date(
          Date.now() + settings.grace * 3600_000,
        ).toISOString(),
        config: {
          outbounds: [
            {
              type: "selector",
              tag: "企业线路",
              outbounds: tags,
              default: tags[0],
            },
            ...outbounds,
          ],
          route: { final: "企业线路" },
        },
      };
    });
  }
  async gatewayConfig(gatewayId) {
    return this.db.tx(async (t) => {
      const g = await t.get("gateways", gatewayId);
      if (!g) fail("网关不存在", 404);
      const users = [],
        outbounds = [],
        rules = [];
      let revision = 0;
      for (const d of await t.list("devices")) {
        if (d.gatewayId !== g.id || d.revokedAt) continue;
        let assigned;
        try {
          assigned = await this.assignedNodes(t, d.employeeId);
        } catch (e) {
          if ([403, 409].includes(e.status)) continue;
          throw e;
        }
        revision = assigned.revision;
        users.push({
          username: d.credentialId,
          password: this.vault.open(d.password),
        });
        const tags = assigned.nodes.map((n) => {
          const tag = `n-${d.id}-${n.id}`;
          outbounds.push({ ...n.outbound, tag });
          return tag;
        });
        const group = `device-${d.id}`;
        outbounds.push({
          type: "urltest",
          tag: group,
          outbounds: tags,
          url: "https://www.gstatic.com/generate_204",
          interval: "5m",
        });
        rules.push({
          auth_user: [d.credentialId],
          action: "route",
          outbound: group,
        });
      }
      const result = {
        revision,
        config: {
          log: { level: "warn" },
          inbounds: [
            {
              type: "http",
              tag: "employees",
              listen: "0.0.0.0",
              listen_port: g.port,
              users,
              tls: {
                enabled: true,
                certificate_path: "/certs/fullchain.pem",
                key_path: "/certs/privkey.pem",
              },
            },
          ],
          outbounds: [
            ...outbounds,
            { type: "direct", tag: "blocked-placeholder" },
          ],
          route: { rules: [...rules, { action: "reject" }] },
          experimental: {
            v2ray_api: {
              listen: "127.0.0.1:10085",
              stats: { enabled: true, users: users.map((u) => u.username) },
            },
          },
        },
      };
      return result;
    });
  }
  async ingest(gatewayId, body) {
    const events = body.events;
    if (!Array.isArray(events) || !events.length || events.length > 500)
      fail("events 数量应为 1–500");
    return this.db.tx(async (t) => {
      const g = await t.get("gateways", gatewayId);
      if (!g) fail("网关不存在", 403);
      const devices = await t.list("devices");
      let accepted = 0,
        duplicates = 0;
      for (const raw of events) {
        const eventId = text(raw.eventId, "eventId", 100),
          credentialId = text(raw.credentialId, "credentialId", 100),
          d = devices.find(
            (d) => d.credentialId === credentialId && d.gatewayId === gatewayId,
          );
        if (!d) fail("计量凭证不属于当前网关", 403);
        const upload = raw.uploadBytes,
          download = raw.downloadBytes;
        for (const n of [upload, download])
          if (!Number.isSafeInteger(n) || n < 0 || n > 1e14)
            fail("流量必须为非负安全整数字节数");
        const start = Date.parse(raw.startedAt),
          end = Date.parse(raw.endedAt);
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= start ||
          end - start > 3600_000 ||
          end > Date.now() + 60000 ||
          start < Date.parse(d.createdAt) - 60000
        )
          fail("计量时间窗口无效（最大 1 小时）");
        const startedAt = new Date(start).toISOString(),
          endedAt = new Date(end).toISOString(),
          fp = hash(
            JSON.stringify([
              credentialId,
              startedAt,
              endedAt,
              upload,
              download,
            ]),
          );
        const old = await t.q(
          "SELECT fingerprint FROM usage_events WHERE gateway_id=$1 AND event_id=$2",
          [gatewayId, eventId],
        );
        if (old.length) {
          if (old[0].fingerprint !== fp) fail("重复事件内容不一致", 409);
          duplicates++;
          continue;
        }
        // Reject overlapping windows from duplicate collectors even when event IDs differ.
        const overlap = await t.q(
          "SELECT event_id FROM usage_events WHERE gateway_id=$1 AND credential_id=$2 AND started_at<$3 AND ended_at>$4 LIMIT 1",
          [gatewayId, credentialId, endedAt, startedAt],
        );
        if (overlap.length) fail("该凭证的计量窗口重叠", 409);
        await t.q(
          "INSERT INTO usage_events VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            gatewayId,
            eventId,
            credentialId,
            d.employeeId,
            d.id,
            startedAt,
            endedAt,
            upload,
            download,
            fp,
            now(),
          ],
        );
        accepted++;
      }
      await t.put("gateways", g.id, {
        ...g,
        lastSeen: now(),
        configRevision: body.configRevision ?? g.configRevision,
      });
      return { accepted, duplicates };
    });
  }
  async usage(from, to) {
    const a = Date.parse(from),
      b = Date.parse(to);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a >= b ||
      b - a > 367 * 86400_000
    )
      fail("日期区间无效（最多 367 天）");
    const rows = await this.db.q(
      `SELECT employee_id,device_id,gateway_id,SUM(upload_bytes) AS upload,SUM(download_bytes) AS download,MAX(ended_at) AS last_report,COUNT(*) AS samples FROM usage_events WHERE ended_at>$1 AND ended_at<=$2 GROUP BY employee_id,device_id,gateway_id`,
      [new Date(a).toISOString(), new Date(b).toISOString()],
    );
    const devices = await this.db.list("devices"),
      gateways = await this.db.list("gateways");
    return {
      from: new Date(a).toISOString(),
      to: new Date(b).toISOString(),
      attribution: "采样窗口结束时间；上传 + 下载；网关认证账号口径",
      employees: (await this.db.list("employees")).map((e) => {
        const matches = rows.filter((r) => r.employee_id === e.id),
          own = devices.filter((d) => d.employeeId === e.id);
        return {
          employeeId: e.id,
          name: e.name,
          dept: e.dept,
          enabled: e.enabled,
          uploadBytes: matches.reduce((n, r) => n + Number(r.upload), 0),
          downloadBytes: matches.reduce((n, r) => n + Number(r.download), 0),
          metered: matches.length > 0,
          lastReport:
            matches
              .map((r) => r.last_report)
              .sort()
              .at(-1) || null,
          deviceCount: own.length,
          unmeteredDevices: own.filter((d) => !d.gatewayId).length,
          devices: own.map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            gatewayId: d.gatewayId,
            revokedAt: d.revokedAt,
            metered: matches.some((r) => r.device_id === d.id),
            uploadBytes: matches
              .filter((r) => r.device_id === d.id)
              .reduce((n, r) => n + Number(r.upload), 0),
            downloadBytes: matches
              .filter((r) => r.device_id === d.id)
              .reduce((n, r) => n + Number(r.download), 0),
          })),
        };
      }),
      gateways: gateways.map(({ tokenHash, ...g }) => g),
    };
  }
}
