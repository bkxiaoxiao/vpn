import { id, now, hash, text, fail } from "./security.mjs";

// App credentials are encrypted with the existing server DATA_KEY, never returned to the browser.
export class FeishuDirectory {
  constructor(db, vault, config, audit, fetcher = fetch) {
    Object.assign(this, { db, vault, config, audit, fetcher });
    this.tokenCache = null;
  }
  async credentials(store = this.db) {
    const saved = await store.get("integrations", "feishu");
    if (saved)
      return { ...this.vault.open(saved.encrypted), revision: saved.revision };
    return {
      appId: this.config.feishuId || "",
      appSecret: this.config.feishuSecret || "",
      tenantKey: this.config.tenant || "",
      adminIds: this.config.adminIds || [],
      rootIds: ["0"],
      revision: hash(
        JSON.stringify([
          this.config.feishuId,
          this.config.feishuSecret,
          this.config.tenant,
        ]),
      ),
    };
  }
  async status() {
    const c = await this.credentials(),
      saved = await this.db.get("integrations", "feishu"),
      sync = await this.db.get("integrationStatus", "feishu");
    return {
      appId: c.appId,
      tenantKey: c.tenantKey,
      adminIds: c.adminIds,
      rootIds: c.rootIds,
      secretConfigured: !!c.appSecret,
      configured: !!(c.appId && c.appSecret && c.tenantKey),
      source: saved ? "admin" : "environment",
      callbackURL: this.config.base + "/auth/feishu/callback",
      lastSync: sync || null,
      departments: await this.db.list("departments"),
    };
  }
  async save(body, actor) {
    return this.db.tx(async (t) => {
      const old = await this.credentials(t),
        appId = text(body.appId, "App ID", 100),
        tenantKey = text(body.tenantKey, "tenant_key", 100);
      if (
        !/^cli_[A-Za-z0-9_]+$/.test(appId) ||
        !/^[A-Za-z0-9_-]+$/.test(tenantKey)
      )
        fail("App ID 应以 cli_ 开头，tenant_key 应为当前企业标识");
      if (
        ((old.appId && old.appId !== appId) ||
          (old.tenantKey && old.tenantKey !== tenantKey)) &&
        (await t.list("employees")).length
      )
        fail(
          "工作空间已有员工，不能直接更换飞书应用或企业；请使用独立工作空间",
          409,
        );
      const appSecret = body.appSecret
        ? text(body.appSecret, "App Secret", 500)
        : old.appSecret;
      if (!appSecret || appSecret.length < 8) fail("请填写有效的 App Secret");
      const rootIds = Array.isArray(body.rootIds)
        ? [...new Set(body.rootIds)]
        : ["0"];
      if (
        !rootIds.length ||
        rootIds.length > 50 ||
        rootIds.some(
          (x) => typeof x !== "string" || !/^[A-Za-z0-9_-]{1,150}$/.test(x),
        )
      )
        fail("同步部门 ID 无效");
      const adminIds = Array.isArray(body.adminIds)
        ? [...new Set(body.adminIds)]
        : [];
      if (
        adminIds.length > 100 ||
        adminIds.some(
          (x) => typeof x !== "string" || !/^ou_[A-Za-z0-9_-]+$/.test(x),
        )
      )
        fail("管理员 open_id 无效");
      await t.put("integrations", "feishu", {
        revision: id(),
        updatedAt: now(),
        encrypted: this.vault.seal({
          appId,
          appSecret,
          tenantKey,
          adminIds,
          rootIds,
        }),
      });
      await this.audit(t, "保存飞书集成配置", appId, actor);
      this.tokenCache = null;
      return { saved: true };
    });
  }
  async call(path, token, body) {
    let r, j;
    try {
      r = await this.fetcher("https://open.feishu.cn/open-apis/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12000),
      });
      j = await r.json();
    } catch {
      fail("无法连接飞书服务，请稍后重试", 502);
    }
    if (!r.ok || j.code !== 0) {
      const code = Number.isInteger(j.code) ? j.code : r.status;
      fail(
        `飞书请求失败（代码 ${code}）。请检查应用凭证、发布状态、通讯录只读权限和可访问数据范围。`,
        502,
      );
    }
    return j;
  }
  async token(c) {
    if (!c.appId || !c.appSecret || !c.tenantKey)
      fail("尚未配置飞书应用，请先保存飞书集成配置", 503);
    if (
      this.tokenCache?.revision === c.revision &&
      this.tokenCache.until > Date.now()
    )
      return this.tokenCache.value;
    const j = await this.call("auth/v3/tenant_access_token/internal", null, {
      app_id: c.appId,
      app_secret: c.appSecret,
    });
    if (!j.tenant_access_token) fail("飞书未返回应用访问令牌", 502);
    this.tokenCache = {
      revision: c.revision,
      value: j.tenant_access_token,
      until:
        Date.now() +
        Math.max(0, Math.min(Number(j.expire) || 3600, 7200) - 120) * 1000,
    };
    return j.tenant_access_token;
  }
  async pages(path, params, token, deadline) {
    const result = [];
    let next = "",
      seen = new Set();
    for (let n = 0; n < 500; n++) {
      if (Date.now() > deadline)
        fail("同步超时，请缩小同步部门范围后重试；现有员工未变更", 504);
      const q = new URLSearchParams({
        ...params,
        page_size: "50",
        ...(next ? { page_token: next } : {}),
      });
      const data = (await this.call(path + "?" + q, token)).data;
      // Feishu omits items for an empty final page. Require its explicit end
      // marker so malformed responses cannot masquerade as an empty directory.
      const items = data?.items === undefined && data?.has_more === false
        ? []
        : data?.items;
      if (!data || !Array.isArray(items))
        fail("飞书通讯录响应不完整；本次同步未写入", 502);
      result.push(...items);
      if (result.length > 10000)
        fail("单次同步数据过多，请按部门缩小范围", 400);
      if (!data.has_more) return result;
      if (
        typeof data.page_token !== "string" ||
        !data.page_token ||
        seen.has(data.page_token)
      )
        fail("飞书分页异常；本次同步未写入", 502);
      next = data.page_token;
      seen.add(next);
    }
    fail("飞书分页超过上限；本次同步未写入", 502);
  }
  async check() {
    const c = await this.credentials(),
      token = await this.token(c),
      root = c.rootIds[0];
    // Probe both permissions with minimal page size, not the entire directory.
    for (const path of [
      "contact/v3/departments/" +
        encodeURIComponent(root) +
        "/children?" +
        new URLSearchParams({
          department_id_type: "open_department_id",
          fetch_child: "false",
          page_size: "1",
        }),
      "contact/v3/users/find_by_department?" +
        new URLSearchParams({
          department_id: root,
          department_id_type: "open_department_id",
          user_id_type: "open_id",
          page_size: "1",
        }),
    ])
      await this.call(path, token);
    return {
      ok: true,
      checkedAt: now(),
      message:
        "应用凭证及所选部门的通讯录读取检查通过；tenant_key 将在实际登录时校验。",
    };
  }
  async sync(actor) {
    const lease = id();
    await this.db.tx(async (t) => {
      const lock = await t.get("integrationLocks", "feishu");
      if (lock && lock.expires > Date.now())
        fail("已有飞书同步正在执行，请稍后查看结果", 409);
      await t.put("integrationLocks", "feishu", {
        id: lease,
        expires: Date.now() + 180000,
      });
    });
    try {
      return await this.runSync(actor);
    } finally {
      await this.db.tx(async (t) => {
        const lock = await t.get("integrationLocks", "feishu");
        if (lock?.id === lease) await t.del("integrationLocks", "feishu");
      });
    }
  }
  async runSync(actor) {
    const c = await this.credentials(),
      token = await this.token(c),
      deadline = Date.now() + 120000;
    const departments = new Map(),
      users = new Map(),
      queue = [...c.rootIds],
      visited = new Set();
    for (const root of queue) {
      if (root === "0")
        departments.set("0", { id: "0", name: "企业根部门", parentId: null });
      else {
        const d = (
          await this.call(
            "contact/v3/departments/" +
              encodeURIComponent(root) +
              "?department_id_type=open_department_id",
            token,
          )
        ).data?.department;
        if (!d?.open_department_id || !d.name)
          fail("同步根部门信息不完整", 502);
        departments.set(root, {
          id: root,
          name: d.name,
          parentId: d.parent_department_id || null,
        });
      }
    }
    while (queue.length) {
      if (visited.size >= 500) fail("部门数量超过单次同步上限，请缩小同步范围");
      const departmentId = queue.shift();
      if (visited.has(departmentId)) continue;
      visited.add(departmentId);
      const children = await this.pages(
        "contact/v3/departments/" +
          encodeURIComponent(departmentId) +
          "/children",
        { department_id_type: "open_department_id", fetch_child: "false" },
        token,
        deadline,
      );
      for (const d of children) {
        if (!d?.open_department_id || typeof d.name !== "string")
          fail("飞书部门数据不完整；本次未写入", 502);
        departments.set(d.open_department_id, {
          id: d.open_department_id,
          name: d.name,
          parentId: departmentId,
        });
        if (!visited.has(d.open_department_id))
          queue.push(d.open_department_id);
      }
      const entries = await this.pages(
        "contact/v3/users/find_by_department",
        {
          department_id: departmentId,
          department_id_type: "open_department_id",
          user_id_type: "open_id",
        },
        token,
        deadline,
      );
      for (const u of entries) {
        if (
          typeof u.open_id !== "string" ||
          typeof u.name !== "string" ||
          !u.name.trim()
        )
          fail(
            "缺少员工 open_id 或姓名，请检查用户基本信息权限；本次未写入",
            502,
          );
        const previous = users.get(u.open_id),
          status = u.status || {};
        const inactive = !!(
          status.is_exited ||
          status.is_resigned ||
          status.is_frozen ||
          status.is_unjoin ||
          status.is_activated === false
        );
        users.set(u.open_id, {
          openId: u.open_id,
          name: u.name.slice(0, 100),
          departmentIds: [
            ...new Set([
              ...(previous?.departmentIds || []),
              departmentId,
              ...(Array.isArray(u.department_ids) ? u.department_ids : []),
            ]),
          ],
          inactive: inactive || previous?.inactive || false,
        });
        if (users.size > 10000) fail("员工超过单次同步上限，请按部门同步");
      }
    }
    // Do not hold a database transaction during network calls. Commit only a complete snapshot.
    return this.db.tx(async (t) => {
      const latest = await this.credentials(t);
      if (latest.revision !== c.revision)
        fail("同步期间飞书配置已变更，请重试", 409);
      const devices = await t.list("devices"),
        sessions = await t.list("sessions");
      const employees = await t.list("employees"),
        existing = new Map(employees.map((e) => [e.openId, e]));
      let added = 0,
        updated = 0,
        disabled = 0;
      const employeeWrites = [],
        deviceWrites = new Map(),
        sessionDeletes = new Set();
      const disable = async (e) => {
        if (e.enabled) disabled++;
        for (const d of devices)
          if (d.employeeId === e.id && !d.revokedAt)
            deviceWrites.set(d.id, { ...d, revokedAt: now() });
        for (const s of sessions)
          if (s.employeeId === e.id) sessionDeletes.add(s.id);
      };
      const staleDepartments = (await t.list("departments"))
        .filter((d) => d.appId === c.appId && !departments.has(d.id))
        .map((d) => d.id);
      await t.delMany("departments", staleDepartments);
      await t.putMany(
        "departments",
        [...departments.values()].map((d) => ({ ...d, appId: c.appId })),
      );
      for (const u of users.values()) {
        const old = existing.get(u.openId),
          e = {
            ...(old || {}),
            id: old?.id || id(),
            openId: u.openId,
            name: u.name,
            dept:
              u.departmentIds
                .map((x) => departments.get(x)?.name)
                .filter(Boolean)
                .join(" / ")
                .slice(0, 200) || "未归属部门",
            poolIds: old?.poolIds || [],
            enabled: !u.inactive && !!old?.enabled,
            createdAt: old?.createdAt || now(),
            directoryAppId: c.appId,
            directoryScope: hash(JSON.stringify([...c.rootIds].sort())),
            directoryState: u.inactive ? "inactive" : "active",
            departmentIds: u.departmentIds,
            directorySyncedAt: now(),
          };
        if (u.inactive) await disable(old || e);
        employeeWrites.push(e);
        if (old) updated++;
        else added++;
      }
      for (const old of employees)
        if (old.directoryAppId === c.appId && !users.has(old.openId)) {
          await disable(old);
          employeeWrites.push({
            ...old,
            enabled: false,
            directoryState: "not_visible",
            directorySyncedAt: now(),
          });
        }
      await t.putMany("employees", employeeWrites);
      await t.putMany("devices", [...deviceWrites.values()]);
      await t.delMany("sessions", [...sessionDeletes]);
      const summary = {
        at: now(),
        added,
        updated,
        disabled,
        employees: users.size,
        departments: departments.size,
        appId: c.appId,
      };
      await t.put("integrationStatus", "feishu", summary);
      await this.audit(
        t,
        "同步飞书通讯录",
        `新增 ${added}，更新 ${updated}，停用 ${disabled}`,
        actor,
      );
      return summary;
    });
  }
}
