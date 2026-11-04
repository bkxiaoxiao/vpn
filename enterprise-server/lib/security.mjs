import crypto from "node:crypto";
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
export function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
export function text(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${label}无效`);
  return value.trim();
}
export function equal(a, b) {
  const x = Buffer.from(String(a || "")),
    y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function vault(secret) {
  if (
    !secret ||
    Buffer.from(secret, "hex").length !== 32 ||
    !/^[a-f0-9]{64}$/i.test(secret)
  )
    fail("DATA_KEY 必须是 32 字节十六进制密钥", 500);
  const key = Buffer.from(secret, "hex");
  return {
    seal(value) {
      const iv = crypto.randomBytes(12),
        c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
      return [iv, c.getAuthTag(), data]
        .map((b) => b.toString("base64url"))
        .join(".");
    },
    open(value) {
      const [iv, tag, data] = value
        .split(".")
        .map((v) => Buffer.from(v, "base64url"));
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString());
    },
  };
}
export function loadConfig(env = process.env) {
  const local = env.LOCAL_DEV === "true",
    production = env.NODE_ENV === "production" || !!env.K_SERVICE;
  if (local && production) fail("生产环境禁止 LOCAL_DEV", 500);
  if (!local && !env.DATABASE_URL)
    fail("生产服务需要 DATABASE_URL（PostgreSQL）", 500);
  if (!env.DATA_KEY)
    fail(
      "缺少 DATA_KEY。使用 node scripts/init-local.mjs 初始化本地环境。",
      500,
    );
  if (!local && (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16))
    fail("ADMIN_PASSWORD 至少 16 字符", 500);
  const base = env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.PORT || 4181}`;
  if (!local && new URL(base).protocol !== "https:")
    fail("生产 PUBLIC_BASE_URL 必须为 HTTPS", 500);
  return {
    local,
    production,
    port: Number(env.PORT || 4181),
    host: local ? "127.0.0.1" : "0.0.0.0",
    base,
    dbUrl: env.DATABASE_URL,
    dbFile: env.SQLITE_PATH || "./data/relay.sqlite",
    dataKey: env.DATA_KEY,
    adminPassword: env.ADMIN_PASSWORD,
    feishuId: env.FEISHU_APP_ID,
    feishuSecret: env.FEISHU_APP_SECRET,
    tenant: env.FEISHU_TENANT_KEY,
    adminIds: (env.FEISHU_ADMIN_IDS || "").split(",").filter(Boolean),
    jobToken: env.JOB_TOKEN,
  };
}
export function publicEmployee(e) {
  const { id, name, dept, enabled, poolIds, openId, createdAt } = e;
  return { id, name, dept, enabled, poolIds, openId, createdAt };
}
