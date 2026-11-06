import { id, hash, now, fail, equal } from "./security.mjs";
export class Auth {
  constructor(db, config, fetcher = fetch, provider = null) {
    Object.assign(this, { db, config, fetcher, provider });
  }
  async feishuConfig() {
    return this.provider
      ? this.provider()
      : {
          appId: this.config.feishuId,
          appSecret: this.config.feishuSecret,
          tenantKey: this.config.tenant,
          adminIds: this.config.adminIds || [],
          revision: "environment",
        };
  }
  cookie(req) {
    return /(?:^|;\s*)relay_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
  }
  async session(req) {
    if (
      this.config.local &&
      !req.url.startsWith("/api/client/") &&
      !req.headers.authorization &&
      !this.cookie(req) &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      ) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(
        (req.headers.host || "").replace(/:\d+$/, ""),
      )
    )
      return { role: "admin", name: "本地管理员", local: true };
    const token =
      req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ||
      this.cookie(req);
    if (!token) fail("请先登录", 401);
    const s = await this.db.get("sessions", hash(token));
    if (!s || s.expires < Date.now()) fail("会话已失效，请重新登录", 401);
    let provider;
    if (s.authMethod === "feishu") {
      provider = await this.feishuConfig();
      if (provider.revision !== s.providerRevision)
        fail("飞书应用配置已变更，请重新登录", 401);
    }
    if (s.employeeId) {
      const e = await this.db.get("employees", s.employeeId);
      const webAdmin = s.authMethod === "feishu" && s.role === "admin" && !s.deviceId;
      if (webAdmin) {
        const openId = s.feishuOpenId || e?.openId;
        if (!openId || !provider.adminIds.includes(openId)) fail("后台管理员权限已移除", 403);
        if (e?.directoryState && e.directoryState !== "active") fail("飞书成员已离职或不在同步范围内", 403);
      } else if (!e?.enabled) fail("员工已停用或未授权", 403);
      s.name = e?.name || s.name;
      if (s.deviceId) {
        const d = await this.db.get("devices", s.deviceId);
        if (!d || d.revokedAt) fail("设备已停用", 403);
      }
    }
    if (!s.employeeId && s.authMethod === "feishu" && s.role === "admin"
      && (!s.feishuOpenId || !provider.adminIds.includes(s.feishuOpenId)))
      fail("后台管理员权限已移除，请重新登录", 403);
    return s;
  }
  async issue(data, lifetime = 8 * 3600_000) {
    const token = id() + id();
    await this.db.tx((t) =>
      t.put("sessions", hash(token), {
        ...data,
        id: hash(token),
        expires: Date.now() + lifetime,
      }),
    );
    return token;
  }
  setCookie(res, token) {
    res.setHeader(
      "set-cookie",
      `relay_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${this.config.local ? "" : "; Secure"}`,
    );
  }
  async login(password, req) {
    const key = hash(req.socket.remoteAddress || "unknown");
    return this.db.tx(async (t) => {
      const attempts = (await t.get("loginAttempts", key)) || {
        count: 0,
        until: 0,
      };
      if (attempts.count >= 8 && attempts.until > Date.now())
        return { error: "尝试过多，请 15 分钟后再试", status: 429 };
      if (!equal(password, this.config.adminPassword)) {
        await t.put("loginAttempts", key, {
          count: attempts.until > Date.now() ? attempts.count + 1 : 1,
          until: Date.now() + 900000,
        });
        return { error: "管理员密码无效", status: 401 };
      }
      await t.del("loginAttempts", key);
      return { ok: true };
    });
  }
  async gateway(req) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) fail("需要网关凭证", 401);
    const g = (await this.db.list("gateways")).find((g) =>
      equal(g.tokenHash, hash(token)),
    );
    if (!g) fail("网关凭证无效", 401);
    return g;
  }
  async feishuStart(options = {}) {
    const provider = await this.feishuConfig();
    if (!provider.appId || !provider.appSecret || !provider.tenantKey)
      fail("尚未配置飞书应用", 503);
    const state = id() + id();
    await this.db.tx(async (t) => {
      for (const x of await t.list("oauth"))
        if (x.expires < Date.now()) await t.del("oauth", x.id);
      await t.put("oauth", hash(state), {
        id: hash(state),
        expires: Date.now() + 300000,
        desktop: options.desktop || null,
        providerRevision: provider.revision,
      });
    });
    return { url: await this.authorizationURL(state), state };
  }
  async authorizationURL(state) {
    const provider = await this.feishuConfig();
    const u = new URL(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    u.search = new URLSearchParams({
      client_id: provider.appId,
      response_type: "code",
      redirect_uri: this.config.base + "/auth/feishu/callback",
      state,
    });
    return u.toString();
  }
  async feishuCallback(code, state, cookieState) {
    if (!equal(state, cookieState)) fail("登录事务不匹配", 403);
    const transaction = await this.db.tx(async (t) => {
      const x = await t.get("oauth", hash(state));
      if (!x || x.expires < Date.now()) fail("登录事务已过期或被使用", 403);
      await t.del("oauth", x.id);
      return x;
    });
    const provider = await this.feishuConfig();
    if (transaction.providerRevision !== provider.revision)
      fail("飞书配置已变更，请重新发起登录", 403);
    const r = await this.fetcher(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: provider.appId,
          client_secret: provider.appSecret,
          code,
          redirect_uri: this.config.base + "/auth/feishu/callback",
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const token = await r.json();
    if (!r.ok || !token.access_token) fail("飞书授权码兑换失败", 403);
    const u = await this.fetcher(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      {
        headers: { authorization: "Bearer " + token.access_token },
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = await u.json(),
      profile = result.data;
    if (
      result.code !== 0 ||
      !profile?.open_id ||
      profile.tenant_key !== provider.tenantKey
    )
      fail("飞书身份或企业不匹配", 403);
    let employee = (await this.db.list("employees")).find(
      (e) => e.openId === profile.open_id,
    );
    if (
      employee?.directoryAppId &&
      employee.directoryScope !==
        hash(JSON.stringify([...(provider.rootIds || ["0"])].sort()))
    )
      fail("组织同步范围已变更，请管理员先同步飞书通讯录", 403);
    const admin = provider.adminIds.includes(profile.open_id);
    if (employee?.directoryState && employee.directoryState !== "active")
      fail("飞书成员已离职或不在同步范围内", 403);
    if (!employee?.enabled && !admin)
      fail("尚未获得管理员授权，请联系管理员添加员工", 403);
    if (transaction.desktop) {
      if (!employee?.enabled) fail("桌面客户端需要已授权的员工身份", 403);
      return {
        desktop: transaction.desktop,
        transactionId: transaction.id,
        employeeId: employee.id,
        name: employee.name,
        authenticatedAt: Date.now(),
        providerRevision: provider.revision,
      };
    }
    const session = await this.issue({
      role: admin ? "admin" : "employee",
      employeeId: employee?.id,
      name: profile.name,
      authMethod: "feishu",
      feishuOpenId: profile.open_id,
      providerRevision: provider.revision,
      feishuAt: Date.now(),
    });
    return { token: session };
  }
}
