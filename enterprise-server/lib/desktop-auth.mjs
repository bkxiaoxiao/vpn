import { id, hash, text, fail, equal } from "./security.mjs";
import { createHash } from "node:crypto";

export class DesktopAuth {
  constructor(db, auth, service, config) {
    Object.assign(this, { db, auth, service, config });
  }
  async start(body) {
    const challenge = text(body.challenge, "登录绑定参数", 43),
      installationId = text(body.installationId, "安装标识", 100),
      deviceName = text(body.deviceName, "设备名称", 100);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      !/^[A-Za-z0-9-]{36}$/.test(installationId)
    )
      fail("桌面登录参数无效");
    const result = await this.auth.feishuStart({
      desktop: { challenge, installationId, deviceName },
    });
    return {
      authorizationURL:
        this.config.base +
        "/auth/desktop/start?state=" +
        encodeURIComponent(result.state),
      transactionId: hash(result.state),
      expiresIn: 300,
    };
  }
  async authorize(state) {
    const x = await this.db.get("oauth", hash(state));
    if (!x?.desktop || x.expires < Date.now())
      fail("桌面登录已过期，请重新发起", 403);
    return this.auth.authorizationURL(state);
  }
  async complete(result) {
    const ticket = id() + id();
    await this.db.tx(async (t) => {
      for (const x of await t.list("desktopGrants"))
        if (x.expires < Date.now()) await t.del("desktopGrants", x.id);
      await t.put("desktopGrants", hash(ticket), {
        id: hash(ticket),
        ...result,
        expires: Date.now() + 60000,
      });
    });
    return (
      "relay-enterprise://auth/callback?" +
      new URLSearchParams({ ticket, transaction: result.transactionId })
    );
  }
  async exchange(body) {
    const ticket = text(body.ticket, "登录票据", 200),
      verifier = text(body.verifier, "登录校验参数", 128),
      transactionId = text(body.transactionId, "登录事务", 64);
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) fail("登录校验参数无效");
    const provider = await this.auth.feishuConfig();
    const grant = await this.db.tx(async (t) => {
      const g = await t.get("desktopGrants", hash(ticket));
      if (
        !g ||
        g.expires < Date.now() ||
        g.transactionId !== transactionId ||
        g.providerRevision !== provider.revision
      )
        fail("登录票据已失效", 403);
      const expected = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (!equal(g.desktop.challenge, expected))
        fail("客户端登录绑定校验失败", 403);
      const employee = await t.get("employees", g.employeeId);
      if (!employee?.enabled) fail("员工未授权", 403);
      await t.del("desktopGrants", g.id);
      return g;
    });
    const device = await this.service.createDevice(
      grant.employeeId,
      { name: grant.desktop.deviceName, platform: "macOS" },
      grant.name,
      {
        authMethod: "feishu",
        providerRevision: grant.providerRevision,
        feishuAt: grant.authenticatedAt,
        installationId: grant.desktop.installationId,
      },
    );
    return { ...device, name: grant.name, authentication: "feishu" };
  }
}
