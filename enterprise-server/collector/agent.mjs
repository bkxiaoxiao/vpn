import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

export function deltaEvents(snapshot, stats, at = new Date().toISOString()) {
  const end = Date.parse(at),
    start = Date.parse(snapshot.at);
  if (!Number.isFinite(start) || end <= start || end - start > 3600000)
    throw Error("采样间隔异常，拒绝伪造统计窗口");
  const counters = {};
  for (const stat of stats) {
    const m = /^user>>>([^>]+)>>>traffic>>>(uplink|downlink)$/.exec(stat.name);
    if (!m) continue;
    const value = Number(stat.value);
    if (!Number.isSafeInteger(value) || value < 0)
      throw Error("计数器超出安全整数范围");
    (counters[m[1]] ||= { upload: 0, download: 0 })[
      m[2] === "uplink" ? "upload" : "download"
    ] = value;
  }
  const events = [];
  let resets = 0;
  for (const [credentialId, current] of Object.entries(counters)) {
    const prev = snapshot.counters[credentialId] || { upload: 0, download: 0 };
    if (current.upload < prev.upload || current.download < prev.download)
      resets++;
    const upload =
        current.upload >= prev.upload
          ? current.upload - prev.upload
          : current.upload,
      download =
        current.download >= prev.download
          ? current.download - prev.download
          : current.download;
    events.push({
      eventId: randomUUID(),
      credentialId,
      startedAt: snapshot.at,
      endedAt: at,
      uploadBytes: upload,
      downloadBytes: download,
    });
  }
  return { snapshot: { at, counters }, events, resets };
}
export async function atomicState(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + ".tmp", JSON.stringify(data), { mode: 0o600 });
  await rename(file + ".tmp", file);
}
export async function runAgent(env = process.env) {
  const base = env.CONTROL_URL,
    token = env.GATEWAY_TOKEN;
  if (!base || !token) throw Error("需要 CONTROL_URL 与 GATEWAY_TOKEN");
  if (!base.startsWith("https://") && env.ALLOW_LOCAL_HTTP !== "true")
    throw Error("控制服务必须使用 HTTPS");
  const stateFile = resolve(
      env.COLLECTOR_STATE || "./data/collector.local.json",
    ),
    configFile = resolve(env.CORE_CONFIG || "./data/core.local.json"),
    coreBin = env.SING_BOX_PATH || "sing-box",
    interval = Number(env.COLLECT_INTERVAL || 30);
  if (!Number.isInteger(interval) || interval < 5 || interval > 300)
    throw Error("COLLECT_INTERVAL 应为 5–300 秒");
  const def = protoLoader.loadSync(
    fileURLToPath(new URL("./stats.proto", import.meta.url)),
    { longs: String, defaults: true },
  );
  const pkg = grpc.loadPackageDefinition(def);
  const client = new pkg.v2ray.core.app.stats.command.StatsService(
    env.STATS_ADDRESS || "127.0.0.1:10085",
    grpc.credentials.createInsecure(),
  );
  const query = () =>
    new Promise((resolve, reject) =>
      client.QueryStats(
        { pattern: "user>>>", reset: false },
        { deadline: Date.now() + 10000 },
        (e, r) => (e ? reject(e) : resolve(r.stat || [])),
      ),
    );
  async function request(path, method = "GET", body) {
    const r = await fetch(base.replace(/\/$/, "") + "/api/gateway/" + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error(`控制服务 HTTP ${r.status}`);
    return r.json();
  }
  let saved = {
    pending: [],
    snapshot: { at: new Date().toISOString(), counters: {} },
    digest: null,
  };
  try {
    saved = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let child,
    stopping = false,
    applied = null,
    timer,
    wake;
  const persist = () => atomicState(stateFile, saved);
  async function flush() {
    while (saved.pending.length) {
      const batch = saved.pending.slice(0, 500);
      await request("usage", "POST", { events: batch });
      saved.pending.splice(0, batch.length);
      await persist();
    }
  }
  async function sample() {
    const output = deltaEvents(saved.snapshot, await query());
    saved.snapshot = output.snapshot;
    saved.pending.push(...output.events);
    await persist();
    if (output.resets)
      console.warn("检测到核心计数器重置，部分重置前流量可能缺失");
  }
  async function stopCore() {
    if (!child) return;
    const c = child;
    child = null;
    const exited = new Promise((r) => c.once("exit", r));
    c.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
  async function apply(data) {
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    await atomicState(configFile, data.config);
    await new Promise((resolve, reject) => {
      const p = spawn(coreBin, ["check", "-c", configFile], {
        stdio: "ignore",
      });
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(Error("sing-box 配置校验失败")),
      );
    });
    await stopCore();
    child = spawn(coreBin, ["run", "-c", configFile], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    let startupError;
    child.on("error", (e) => {
      startupError = e;
    });
    await new Promise((r) => setTimeout(r, 600));
    if (startupError || child.exitCode !== null)
      throw Error("sing-box 启动失败");
    saved.snapshot = { at: new Date().toISOString(), counters: {} };
    await persist();
    // Probe the actual API before acknowledging configuration, including builds missing with_v2ray_api.
    await query();
    await request("ack", "POST", { digest: data.digest });
    applied = data.digest;
  }
  async function tick() {
    if (child && child.exitCode === null) {
      try {
        await sample();
      } catch {
        console.error("计数器不可用，重启核心并重新建立采样基线；本段可能缺失");
        await stopCore();
      }
    }
    try {
      await flush();
    } catch {
      console.error("计量待重试，继续检查访问配置");
    }
    const data = await request("config");
    if (applied !== data.digest || !child || child.exitCode !== null)
      await apply(data);
    else await request("ack", "POST", { digest: applied });
  }
  const shutdown = async () => {
    stopping = true;
    clearTimeout(timer);
    wake?.();
    try {
      if (child && child.exitCode === null) {
        await sample();
        await flush();
      }
    } catch {}
    await stopCore();
    client.close();
  };
  const requestStop = () => {
    stopping = true;
    clearTimeout(timer);
    wake?.();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    while (!stopping) {
      try {
        await tick();
        console.log("网关配置与计量已同步");
      } catch {
        console.error("网关同步失败；保留待发送计量，下一周期重试");
      }
      if (!stopping)
        await new Promise((r) => {
          wake = r;
          timer = setTimeout(r, interval * 1000);
        });
    }
  } finally {
    await shutdown();
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  runAgent().catch(() => {
    console.error("采集器启动失败，请检查环境变量、状态文件和核心路径");
    process.exit(1);
  });
