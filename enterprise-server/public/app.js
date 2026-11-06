const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  layers: "m12 3 9 5-9 5-9-5 9-5 M3 12l9 5 9-5 M3 16l9 5 9-5",
  globe:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4 M8 12l3 3 5-6",
  history: "M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  plus: "M12 5v14 M5 12h14",
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 2 M19 16a8 8 0 0 1-13 3l-2-2",
  arrow: "M5 12h14 M14 7l5 5-5 5",
  chevron: "m9 5 7 7-7 7",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l6 6",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
  check: "m5 12 4 4L19 6",
  alert: "m12 3 10 18H2L12 3 M12 9v5 M12 17v.1",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  server: "M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01",
  monitor: "M3 3h18v13H3z M12 16v5 M8 21h8",
  phone: "M7 2h10v20H7z M11 18h2",
  apple:
    "M15 3c0 2-1 3-3 3 M12 8c-6-4-10 2-7 9 2 5 4 5 7 3 3 2 5 2 7-3-4-2-4-5-1-7-2-3-4-3-6-2",
  windows: "M3 5l8-1v8H3z M13 4l8-1v9h-8z M3 14h8v7l-8-1z M13 14h8v9l-8-1z",
  cloud: "M7 18a5 5 0 1 1-1-10 7 7 0 0 1 13 1 4.5 4.5 0 0 1-1 9H7",
  external: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
  download: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
  filter: "M3 5h18 M6 12h12 M10 19h4",
  more: "M5 12h.1 M12 12h.1 M19 12h.1",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.grid}"/></svg>`;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const navs = [
  ["overview", "grid", "总览"],
  ["resources", "globe", "订阅与节点"],
  ["pools", "layers", "资源池"],
  ["employees", "users", "员工与设备"],
  ["usage", "history", "用量统计"],
  ["gateways", "server", "计量网关"],
  ["releases", "shield", "配置发布"],
  ["audit", "history", "审计记录"],
  ["feishu", "link", "飞书集成"],
  ["settings", "settings", "工作空间设置"],
];
let state = null,
  usageData = null,
  me = null,
  page = location.hash.slice(1) || "overview",
  query = "",
  filter = "all",
  busy = false;
let period = "month",
  from = "",
  to = "",
  toastTimer,
  returnFocus;
const $ = (s) => document.querySelector(s),
  fmtDate = (s) =>
    s
      ? new Date(s).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        })
      : "—";
const bytes = (n) => {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 2 : 0) + " " + u[i];
};
const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
function notify(t) {
  $("#toast").textContent = t;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 4200);
}
async function api(path, method = "GET", data) {
  const r = await fetch("/api" + path, {
    method,
    headers: data ? { "content-type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const b = await r.json();
  if (!r.ok) {
    if (r.status === 401) login();
    throw Error(b.error || "请求失败");
  }
  return b;
}
async function reload() {
  state = await api("/bootstrap");
  usageData = await loadUsage();
  render();
}
function range() {
  const end = new Date(),
    china = new Date(end.getTime() + 8 * 3600000),
    date = china.toISOString().slice(0, 10);
  let begin;
  if (period === "today") begin = date;
  else if (period === "week")
    begin = new Date(china.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  else begin = date.slice(0, 8) + "01";
  return {
    from:
      period === "custom"
        ? from + "T00:00:00+08:00"
        : begin + "T00:00:00+08:00",
    to:
      period === "custom"
        ? new Date(Date.parse(to + "T00:00:00+08:00") + 86400000).toISOString()
        : end.toISOString(),
  };
}
async function loadUsage() {
  const r = range();
  return api("/usage?" + new URLSearchParams(r));
}
const heading = (eyebrow, title, desc, actions = "") =>
  `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`;
const button = (label, action, ic = "plus", primary = false) =>
  `<button class="btn ${primary ? "primary" : ""}" data-action="${action}">${icon(ic)}${label}</button>`;
const link = (label, p) =>
  `<button class="text-link" data-nav="${p}">${label}${icon("arrow")}</button>`;
const ph = (title, desc, right = "") =>
  `<div class="panel-header"><div><h2>${title}</h2><p>${desc}</p></div>${right}</div>`;
const badge = (s, tone = "") =>
  `<span class="badge ${tone || (/未|待|异常|停用/.test(s) ? "warn" : "")}">${esc(s)}</span>`;
const note = (s) =>
  `<div class="note-box">${icon("shield")}<span>${s}</span></div>`;
const empty = (s, action, label) =>
  `<div class="empty">${icon("layers")}<p>${s}</p>${action ? button(label, action) : ""}</div>`;
const table = (headers, rows) =>
  `<div class="table-wrap"><table><thead><tr>${headers.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}" class="empty">暂无记录</td></tr>`}</tbody></table></div>`;
const field = (label, name, value = "", type = "text", required = true) =>
  `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""} maxlength="${type === "password" ? 200 : 4000}"></label>`;
const select = (label, name, options, value) =>
  `<label class="field"><span>${label}</span><select name="${name}">${options.map(([id, n]) => `<option value="${esc(id)}" ${String(value) === String(id) ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`;
const checks = (label, name, items, values = []) =>
  `<div class="field"><span>${label}</span>${items.length ? items.map((x) => `<label class="check-item"><input type="checkbox" name="${name}" value="${esc(x.id)}" ${values.includes(x.id) ? "checked" : ""}> ${esc(x.name)}</label>`).join("") : "<small>暂无可选项，请先创建。</small>"}</div>`;
const stat = (label, value, unit, ic, desc) =>
  `<article class="stat"><div class="stat-top">${label}<span class="stat-icon">${icon(ic)}</span></div><div class="stat-number">${value}<small>${unit}</small></div><div class="stat-bottom">${desc}</div></article>`;
function go(p) {
  page = p;
  query = "";
  filter = "all";
  location.hash = p;
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (!state) return;
  if (!navs.some((n) => n[0] === page)) page = "overview";
  const title = navs.find((n) => n[0] === page)[2];
  document.title = title + " · Relay";
  $("#workspace-name").textContent = state.settings.workspace;
  $("#crumb").textContent = title;
  $(".demo-pill").innerHTML =
    `<i></i>${me.local ? "本地开发模式" : "企业控制服务"} · ${state.environment.database}`;
  $("#bell").innerHTML = icon("bell");
  $(".user b").textContent = me.name;
  $("#navigation").innerHTML = navs
    .map(
      ([id, ic, label]) =>
        `<button data-nav="${id}" aria-label="${label}" title="${label}" class="${id === page ? "active " : ""}${id === "settings" ? "nav-section" : ""}" ${id === page ? 'aria-current="page"' : ""}>${icon(ic)}<span class="nav-text">${label}</span>${id === "usage" ? '<span class="count">NEW</span>' : ""}</button>`,
    )
    .join("");
  $("#main").innerHTML = {
    overview,
    resources,
    pools,
    employees,
    usage,
    gateways,
    releases,
    audit,
    feishu,
    settings,
  }[page]();
}
function toolbar(placeholder, extra = "") {
  return `<div class="toolbar"><label class="search">${icon("search")}<input id="search" value="${esc(query)}" placeholder="${placeholder}" aria-label="${placeholder}"></label>${extra}</div>`;
}
function matches(...v) {
  return v.join(" ").toLowerCase().includes(query.toLowerCase());
}
function overview() {
  const devices = state.employees.flatMap((e) => e.devices),
    active = state.employees.filter((e) => e.enabled),
    total =
      sum(usageData.employees, "uploadBytes") +
      sum(usageData.employees, "downloadBytes"),
    last = state.releases[0],
    applied = devices.filter(
      (d) =>
        !d.revokedAt &&
        d.ackStage === "applied" &&
        d.ackRevision === last?.revision,
    ).length;
  return (
    heading(
      "WORKSPACE OVERVIEW",
      "每一次连接，尽在掌握",
      "你的网络资源、团队权限和实际计量，在一个工作空间管理。",
      button("刷新数据", "refresh", "refresh") +
        button("导入资源", "import", "plus", true),
    ) +
    `<section class="stats">${stat("资源总数", state.resources.length, "个", "globe", sum(state.resources, "nodeCount") + " 个已解析节点")}${stat("已授权员工", active.length, "人", "users", devices.filter((d) => !d.revokedAt).length + " 台有效设备")}${stat("区间计量流量", bytes(total), "", "history", usageData.employees.filter((e) => e.metered).length + " 位员工有网关采样")}${stat("当前版本已生效", applied, "台", "shield", last ? "版本 v" + last.revision : "尚未发布配置")}</section><section class="middle-grid"><article class="panel">${ph("员工用量排行", "按当前统计区间的上传 + 下载汇总", link("查看用量", "usage"))}${usageRanking(
      usageData.employees
        .filter((e) => e.metered)
        .sort(
          (a, b) =>
            b.uploadBytes + b.downloadBytes - (a.uploadBytes + a.downloadBytes),
        )
        .slice(0, 5),
    )}</article><article class="panel">${ph("连接与同步", "仅展示服务端已确认的状态")}<div class="health-list" style="padding-top:20px"><div class="health-item"><span>飞书应用配置</span>${badge(state.environment.feishu ? "已配置 · 待真实联调" : "未配置", "neutral")}</div><div class="health-item"><span>计量网关</span><b>${state.gateways.length} 台</b></div><div class="health-item"><span>配置分发模式</span><b>${state.settings.deliveryMode === "gateway" ? "企业计量网关" : "外购节点直连"}</b></div><div class="health-item"><span>订阅自动刷新</span><b>需配置外部调度</b></div></div><div class="inline-note">${state.settings.deliveryMode === "direct" ? "直连外购节点的流量无法在此计量。" : "仅统计实际经过网关的认证账号流量。"}</div></article></section><section class="bottom-grid"><article class="panel table-panel">${ph("订阅资源", "服务端解析与加密存储", link("查看全部", "resources"))}${resourcesTable(state.resources.slice(0, 4))}</article><article class="panel">${ph("最近活动", "可追溯的资源、授权和配置变更")}<div class="timeline">${
      state.logs
        .slice(0, 4)
        .map(
          (l) =>
            `<div class="event"><b>${esc(l.action)}</b><p>${esc(l.target)}</p><small>${fmtDate(l.time)}</small></div>`,
        )
        .join("") || '<p class="muted">尚无操作记录</p>'
    }</div></article></section>`
  );
}
function resourcesTable(rows) {
  return table(
    ["资源名称", "格式", "节点", "状态", "最近同步", ""],
    rows.map(
      (r) =>
        `<tr><td><div class="resource-title"><span class="resource-icon">${icon("globe")}</span><span><strong>${esc(r.name)}</strong><small>${esc(r.vendor)}</small></span></div></td><td>${esc(r.format)}</td><td>${r.nodeCount}</td><td>${badge(r.status)}</td><td>${fmtDate(r.updatedAt)}</td><td><button class="text-link" data-resource="${r.id}">详情</button></td></tr>`,
    ),
  );
}
function resources() {
  return (
    heading(
      "RESOURCE MANAGEMENT",
      "订阅与节点",
      "集中管理外购资源；节点解析后，需加入资源池并发布配置。",
      button("刷新订阅", "sync", "refresh") +
        button("导入资源", "import", "plus", true),
    ) +
    `<section class="panel">${toolbar("搜索资源或供应商")}<div id="results">${resourcesTable(state.resources.filter((r) => matches(r.name, r.vendor)))}</div></section><div style="height:20px"></div>${note("上游地址和节点密钥加密保存于服务端。已解析表示格式可用，不代表已完成节点连通测试。")}`
  );
}
function pools() {
  return (
    heading(
      "RESOURCE POOLS",
      "资源池",
      "按节点组合资源池，再按员工或部门分配。",
      button("创建资源池", "new-pool", "plus", true),
    ) +
    `<div class="pool-cards">${state.pools.map((p) => `<article class="panel pool-card"><div class="pool-card-head"><span class="pool-square">◎</span>${badge(p.sourceIds.length + " 个来源", "neutral")}</div><h2>${esc(p.name)}</h2><p>${esc(p.desc) || "未填写用途说明"}</p><div class="pool-meta"><span><b>${p.count}</b><small>当前节点</small></span><span><b>${p.members}</b><small>已授权员工</small></span></div><button class="btn" data-pool="${p.id}">管理资源池 ${icon("arrow")}</button></article>`).join("")}</div>${!state.pools.length ? `<section class="panel">${empty("尚未创建资源池", "new-pool", "创建第一个资源池")}</section>` : ""}`
  );
}
function employeeTable() {
  return table(
    ["员工 / 飞书身份", "部门", "资源池", "设备", "区间用量", "授权状态", ""],
    state.employees
      .filter((e) => matches(e.name, e.dept, e.openId))
      .map((e) => {
        const u = usageData.employees.find((x) => x.employeeId === e.id);
        return `<tr><td><div class="employee"><span class="avatar">${esc(e.name.slice(0, 1))}</span><span><strong>${esc(e.name)}</strong><small>${esc(e.openId)}</small></span></div></td><td>${esc(e.dept)}</td><td>${e.poolIds.map((id) => esc(state.pools.find((p) => p.id === id)?.name || "已删除")).join("、") || "尚未分配"}</td><td>${e.devices.filter((d) => !d.revokedAt).length} 台</td><td>${u?.metered ? bytes(u.uploadBytes + u.downloadBytes) : '<span class="muted">暂无计量采样</span>'}</td><td>${badge(e.enabled ? "已授权" : e.directoryState === "active" ? "待授权" : "已停用")}</td><td><button class="text-link" data-employee="${e.id}">管理</button></td></tr>`;
      }),
  );
}
function employees() {
  return (
    heading(
      "PEOPLE & DEVICES",
      "员工与设备",
      "从飞书同步部门和员工，再按需分配网络访问权限。",
      button("飞书配置", "feishu-config", "settings") +
        button("同步飞书员工", "feishu-sync", "refresh") +
        button("添加员工", "new-employee", "plus", true),
    ) +
    `<section class="panel">${toolbar("搜索姓名、部门或飞书身份")}<div id="results">${employeeTable()}</div></section><div style="height:20px"></div>${note("停用员工会撤销企业会话和设备授权。网关凭证会在采集器下次应用配置时移除；外购共享凭证需要供应商另外轮换。")}`
  );
}
function usageRanking(rows) {
  const max = Math.max(1, ...rows.map((r) => r.uploadBytes + r.downloadBytes));
  return rows.length
    ? `<div class="ranking">${rows.map((r, i) => `<button class="rank-row" data-usage="${r.employeeId}"><span class="rank-number">${i + 1}</span><span class="avatar">${esc(r.name.slice(0, 1))}</span><span class="rank-label"><b>${esc(r.name)}</b><small>${esc(r.dept)}</small><span class="track"><i style="width:${(100 * (r.uploadBytes + r.downloadBytes)) / max}%"></i></span></span><strong>${bytes(r.uploadBytes + r.downloadBytes)}</strong></button>`).join("")}</div>`
    : empty(
        "暂无网关采样。接入计量网关后展示实际用量。",
        "new-gateway",
        "接入计量网关",
      );
}
function usageTable() {
  return table(
    ["员工", "部门", "上传", "下载", "合计", "数据覆盖", "最后采样", ""],
    usageData.employees
      .filter((e) => matches(e.name, e.dept))
      .sort(
        (a, b) =>
          b.uploadBytes + b.downloadBytes - (a.uploadBytes + a.downloadBytes),
      )
      .map(
        (e) =>
          `<tr><td><strong>${esc(e.name)}</strong>${!e.enabled ? " " + badge("已停用", "neutral") : ""}</td><td>${esc(e.dept)}</td><td>${e.metered ? bytes(e.uploadBytes) : "—"}</td><td>${e.metered ? bytes(e.downloadBytes) : "—"}</td><td><strong>${e.metered ? bytes(e.uploadBytes + e.downloadBytes) : "—"}</strong></td><td>${badge(e.metered ? (e.unmeteredDevices ? "部分设备有采样" : "有网关采样") : "暂无采样", e.metered ? "" : "neutral")}</td><td>${fmtDate(e.lastReport)}</td><td><button class="text-link" data-usage="${e.employeeId}">设备明细</button></td></tr>`,
      ),
  );
}
function usage() {
  const u = usageData.employees,
    totalUp = sum(u, "uploadBytes"),
    totalDown = sum(u, "downloadBytes");
  return (
    heading(
      "EMPLOYEE TRAFFIC",
      "用量统计",
      "实际经过企业网关的账号流量 · 上传 + 下载 · 日期按北京时间选择。",
      button("导出 CSV", "usage-export", "download") +
        button("刷新用量", "refresh", "refresh", true),
    ) +
    `<div class="period-bar"><div class="segmented">${[
      ["today", "今天"],
      ["week", "近 7 天"],
      ["month", "本月"],
      ["custom", "自定义"],
    ]
      .map(
        ([id, n]) =>
          `<button data-period="${id}" class="${period === id ? "selected" : ""}">${n}</button>`,
      )
      .join(
        "",
      )}</div>${period === "custom" ? `<label>开始 <input type="date" id="from-date" value="${esc(from)}"></label><label>结束 <input type="date" id="to-date" value="${esc(to)}"></label><button class="btn" data-action="date-apply">应用</button>` : ""}<span>${fmtDate(usageData.from)} — ${fmtDate(usageData.to)}</span></div><section class="stats">${stat("已记录总流量", bytes(totalUp + totalDown), "", "history", "统计已接收的网关采样")}${stat("上传流量", bytes(totalUp), "", "external", "员工 → 网关")}${stat("下载流量", bytes(totalDown), "", "download", "网关 → 员工")}${stat("有采样员工", u.filter((e) => e.metered).length, "人", "users", "共 " + u.length + " 位员工")}</section>${note("“暂无采样”不代表用量为零。直连外购节点、绕过网关或采集器离线的流量不在统计内；计量口径为代理账号字节，不等于供应商账单或整台设备的全部流量。")}<section class="panel">${toolbar("搜索员工或部门")}<div id="results">${usageTable()}</div><div class="table-foot"><span>按采样窗口结束时间归属统计区间；窗口最多 1 小时。</span><span>IEC 单位 · 1 GiB = 1024³ B</span></div></section><div class="section-title"><h2>计量网关状态</h2>${link("管理网关", "gateways")}</div>${gatewayTable()}`
  );
}
function gatewayTable() {
  return `<section class="panel">${table(
    ["网关", "接入地址", "配置应用", "最近心跳"],
    state.gateways.map(
      (g) =>
        `<tr><td><strong>${esc(g.name)}</strong></td><td>${esc(g.host)}:${g.port}</td><td>${badge(g.appliedDigest ? (g.appliedDigest === g.desiredDigest ? "已应用" : "待应用新配置") : "尚未应用配置")}</td><td>${fmtDate(g.lastSeen)} ${g.lastSeen && Date.now() - Date.parse(g.lastSeen) > 180000 ? badge("已过期") : ""}</td></tr>`,
    ),
  )}</section>`;
}
function gateways() {
  return (
    heading(
      "METERING GATEWAYS",
      "计量网关",
      "独立网关使用设备专属账号，转发至外购节点并上报用量。",
      button("注册网关", "new-gateway", "plus", true),
    ) +
    note(
      "网关与 Cloud Run 控制服务分别部署。需要自有 Linux 主机、域名和 TLS 证书。注册后将得到一次性显示的网关密钥，用于配置采集器。",
    ) +
    gatewayTable() +
    `<div class="section-title"><h2>设备到计量的连接路径</h2></div><section class="panel architecture"><span>员工客户端<small>设备专属凭证</small></span>${icon("arrow")}<span>企业网关<small>认证 · 转发 · 计量</small></span>${icon("arrow")}<span>外购节点<small>已有订阅资源</small></span></section>`
  );
}
function releases() {
  const last = state.releases[0];
  return (
    heading(
      "CONFIGURATION DELIVERY",
      "配置发布",
      "发布不可变配置快照；回滚生成新版本，保留完整历史。",
      button("发布新版本", "publish", "plus", true),
    ) +
    `<section class="panel release-hero"><div class="stat-top">当前已发布版本 ${badge(last ? "已发布" : "尚未发布", "neutral")}</div><div class="release-number">${last ? "v" + last.revision : "—"}</div><p>${last ? esc(last.note) : "先导入资源、创建资源池并授权员工，然后发布首个版本。"}</p><div class="detail-row"><span>发布时间</span><b>${fmtDate(last?.time)}</b></div><div class="detail-row"><span>应用确认</span><b>${state.employees.flatMap((e) => e.devices).filter((d) => d.ackStage === "applied" && d.ackRevision === last?.revision && !d.revokedAt).length} 台设备</b></div></section><div class="section-title"><h2>历史版本</h2></div><section class="panel">${table(
      ["版本", "变更说明", "发布时间", "操作人", ""],
      state.releases.map(
        (r) =>
          `<tr><td><strong>v${r.revision}</strong></td><td>${esc(r.note)}</td><td>${fmtDate(r.time)}</td><td>${esc(r.actor)}</td><td>${r.id !== last?.id ? `<button class="text-link" data-rollback="${r.id}">回滚到此版本</button>` : "当前版本"}</td></tr>`,
      ),
    )}</section>`
  );
}
function auditTable() {
  return table(
    ["操作", "对象", "操作人", "时间"],
    state.logs
      .filter((l) => matches(l.action, l.target, l.actor))
      .map(
        (l) =>
          `<tr><td><strong>${esc(l.action)}</strong></td><td>${esc(l.target)}</td><td>${esc(l.actor)}</td><td>${fmtDate(l.time)}</td></tr>`,
      ),
  );
}
function audit() {
  return (
    heading(
      "ACTIVITY LOG",
      "审计记录",
      "最近 300 条资源、授权与配置变更记录。",
    ) +
    `<section class="panel">${toolbar("搜索操作、对象或操作人")}<div id="results">${auditTable()}</div></section>`
  );
}
function settings() {
  const s = state.settings;
  return (
    heading(
      "WORKSPACE SETTINGS",
      "工作空间设置",
      "管理组织与同步策略。",
      button("保存设置", "save-settings", "check", true),
    ) +
    `<form id="settings-form"><div class="form-grid"><section class="panel form-panel"><h2>组织设置</h2><p>当前工作空间统一管理员工与资源。</p>${field("工作空间名称", "workspace", s.workspace)}${select(
      "每人设备上限",
      "limit",
      [1, 2, 3, 5, 10].map((n) => [n, n + " 台"]),
      s.limit,
    )}${select(
      "订阅刷新间隔",
      "interval",
      [
        [15, "15 分钟"],
        [30, "30 分钟"],
        [60, "1 小时"],
        [360, "6 小时"],
      ],
      s.interval,
    )}<p>外部定时任务调用刷新接口时，服务端按此间隔判断哪些订阅需要更新。</p></section><section class="panel form-panel"><h2>配置与计量模式</h2><p>切换网关模式前，先注册网关并为设备绑定网关。</p>${select(
      "配置分发模式",
      "deliveryMode",
      [
        ["direct", "外购节点直连（无法在此计量）"],
        ["gateway", "企业网关转发（网关侧计量）"],
      ],
      s.deliveryMode,
    )}${select(
      "客户端配置有效期",
      "grace",
      [
        [1, "1 小时"],
        [4, "4 小时"],
        [24, "24 小时"],
      ],
      s.grace,
    )}<p>客户端须执行过期策略。当前未修改 Karing 客户端，服务端到期时间不会自动限制外购共享节点。</p></section><section class="panel form-panel"><h2>飞书身份与组织同步</h2><p>在飞书集成中配置应用、检查权限并同步员工。</p><div class="detail-row"><span>应用配置</span>${badge(state.environment.feishu ? "已配置" : "未配置", "neutral")}</div><div class="detail-row"><span>最近同步</span><b>${fmtDate(state.feishu?.lastSync?.at)}</b></div><button type="button" class="btn" data-action="feishu-config" style="margin-top:18px">${icon("settings")}配置飞书集成</button><p>同步不会自动授权新员工。明确离职、冻结或不再可见的已同步员工会被停用。</p></section><section class="panel form-panel"><h2>服务部署</h2><p>${state.environment.deployed ? "当前服务运行于 Google Cloud Run。" : "Cloud Run 部署文件已提供，尚未执行云端部署。"}</p><div class="detail-row"><span>当前数据库</span><b>${state.environment.database}</b></div><div class="detail-row"><span>当前环境</span><b>${state.environment.local ? "本机开发" : "服务端环境"}</b></div><div class="detail-row"><span>Cloud Run 持久化</span><b>外部 PostgreSQL</b></div><p>流量网关和计量采集器独立运行，控制服务不承载员工代理流量。</p></section></div></form>`
  );
}
function modal(title, desc, body, label, submit) {
  returnFocus = document.activeElement;
  $("#overlay").innerHTML =
    `<div class="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><div><h2 id="modal-title">${title}</h2><p>${desc}</p></div><button class="close" data-action="close" aria-label="关闭">×</button></div><form id="modal-form">${body}<div class="modal-actions"><button type="button" class="btn" data-action="close">关闭</button>${label ? `<button type="submit" class="btn primary">${label}</button>` : ""}</div></form></section></div>`;
  $("#modal-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target,
      b = form.querySelector("[type=submit]");
    if (b) b.disabled = true;
    try {
      await submit(new FormData(form));
    } catch (e) {
      notify(e.message);
    } finally {
      if (b) b.disabled = false;
    }
  };
  setTimeout(
    () => $("#overlay input, #overlay textarea, #overlay .close")?.focus(),
    0,
  );
}
function close() {
  $("#overlay").innerHTML = "";
  returnFocus?.focus();
}
async function done(path, method, data, message) {
  await api(path, method, data);
  close();
  await reload();
  notify(message);
}
function importResource() {
  modal(
    "导入网络资源",
    "支持 HTTPS 订阅、Clash YAML、sing-box JSON 或节点链接。",
    `${field("资源名称", "name")}${field("供应商", "vendor")}<label class="field"><span>HTTPS 订阅链接（定时刷新来源）</span><input name="url" type="url" placeholder="https://…"><small>与下方配置二选一，地址只保存在服务端。</small></label><label class="field"><span>节点链接 / 配置内容</span><textarea name="content" rows="6" placeholder="粘贴节点链接、Clash YAML 或 sing-box JSON"></textarea></label>${select(
      "资源格式标签",
      "format",
      [
        ["Clash", "Clash"],
        ["sing-box", "sing-box"],
        ["节点链接", "节点链接"],
      ],
      "Clash",
    )}`,
    "解析并保存",
    async (d) => {
      if (!d.get("url") && !d.get("content"))
        throw Error("请填写订阅链接或配置内容");
      const result = await api("/resources", "POST", Object.fromEntries(d));
      close();
      await reload();
      notify(
        `已保存 ${result.nodeCount} 个节点${result.warnings.length ? "；" + result.warnings.join("；") : ""}`,
      );
    },
  );
}
function editPool(p) {
  modal(
    p ? "管理资源池" : "创建资源池",
    "选择可用于该资源池的来源，员工授权请在员工页面管理。",
    `${field("资源池名称", "name", p?.name)}${field("用途说明", "desc", p?.desc, "text", false)}${checks("资源来源", "sourceIds", state.resources, p?.sourceIds || [])}`,
    "保存资源池",
    (d) =>
      done(
        "/pools" + (p ? "/" + p.id : ""),
        p ? "PUT" : "POST",
        {
          name: d.get("name"),
          desc: d.get("desc"),
          sourceIds: d.getAll("sourceIds"),
        },
        "资源池已保存；发布新版本后更新节点快照",
      ),
  );
}
function editEmployee(e) {
  modal(
    e ? "管理员工" : "添加员工",
    "通过当前飞书应用的 open_id 绑定真实身份。",
    `${field("员工姓名", "name", e?.name)}${field("飞书 open_id", "openId", e?.openId).replace(" name=", e ? " readonly name=" : " name=")}${field("部门", "dept", e?.dept)}${checks("资源池授权", "poolIds", state.pools, e?.poolIds || [])}${select(
      "访问状态",
      "enabled",
      [
        ["true", "已授权"],
        ["false", "已停用"],
      ],
      String(e?.enabled ?? true),
    )}${e ? `<div class="section-title"><h2>设备管理</h2><button type="button" class="text-link" data-new-device="${e.id}">注册设备 ${icon("plus")}</button></div>${e.devices.map((d) => `<div class="detail-row"><span>${esc(d.name)} · ${esc(d.platform)}<small style="display:block">${d.gatewayId ? "已绑定网关" : "直连 · 不计量"}</small></span>${d.revokedAt ? badge("已撤销", "neutral") : `<button type="button" class="text-link" data-revoke="${d.id}">撤销设备</button>`}</div>`).join("") || '<p class="muted">尚无设备</p>'}` : ""}`,
    "保存授权",
    (d) =>
      done(
        "/employees" + (e ? "/" + e.id : ""),
        e ? "PUT" : "POST",
        {
          name: d.get("name"),
          openId: d.get("openId"),
          dept: d.get("dept"),
          poolIds: d.getAll("poolIds"),
          enabled: d.get("enabled") === "true",
        },
        "员工授权已保存",
      ),
  );
}
function secretResult(title, data) {
  modal(
    title,
    "以下密钥仅在本次操作后显示。请安全保存，勿发送到聊天中。",
    `<label class="field"><span>接入参数</span><textarea readonly rows="7">${esc(JSON.stringify(data, null, 2))}</textarea></label>`,
    "完成",
    () => close(),
  );
}
function newDevice(employeeId) {
  modal(
    "注册员工设备",
    "生成设备令牌供客户端接入。选择计量网关后才能获取网关计量。",
    `${field("设备名称", "name")}${select(
      "平台",
      "platform",
      ["Windows", "macOS", "Android", "iOS"].map((x) => [x, x]),
      "Windows",
    )}${select("计量网关", "gatewayId", [["", "不绑定 · 外购节点直连"], ...state.gateways.map((g) => [g.id, g.name])], "")}`,
    "注册设备",
    async (d) => {
      const r = await api(
        "/employees/" + employeeId + "/devices",
        "POST",
        Object.fromEntries(d),
      );
      close();
      await reload();
      secretResult("设备已注册", r);
    },
  );
}
function publish(rollbackId) {
  const r = state.releases.find((x) => x.id === rollbackId);
  modal(
    r ? "回滚配置" : "发布配置快照",
    r
      ? "将历史内容发布为更高版本，员工授权仍按当前权限校验。"
      : "包含当前所有资源池的节点快照。",
    `<label class="field"><span>变更说明</span><textarea name="note" required maxlength="500">${r ? "回滚至 v" + r.revision : ""}</textarea></label>`,
    "确认发布",
    (d) =>
      done(
        "/releases",
        "POST",
        { note: d.get("note"), rollbackId },
        "配置版本已发布",
      ),
  );
}
function usageDetail(id) {
  const e = usageData.employees.find((e) => e.employeeId === id);
  modal(
    "员工用量明细",
    `${esc(e.name)} · ${esc(e.dept)} · 当前统计区间`,
    `${table(
      ["设备", "上传", "下载", "采集来源"],
      e.devices.map(
        (d) =>
          `<tr><td><strong>${esc(d.name)}</strong><small style="display:block">${esc(d.platform)}${d.revokedAt ? " · 已撤销" : ""}</small></td><td>${d.metered ? bytes(d.uploadBytes) : "—"}</td><td>${d.metered ? bytes(d.downloadBytes) : "—"}</td><td>${d.gatewayId ? esc(state.gateways.find((g) => g.id === d.gatewayId)?.name || "网关") + (d.metered ? "" : " · 暂无采样") : "未接入计量"}</td></tr>`,
      ),
    )}<p class="muted" style="font-size:10px;line-height:1.8">最近采样：${fmtDate(e.lastReport)}<br>未收到采样的设备不应被视为零用量。</p>`,
    null,
  );
}
function downloadCSV(rows, name) {
  const safe = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob(["\ufeff" + rows.map((r) => r.map(safe).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const actions = {
  close,
  refresh: reload,
  import: importResource,
  sync: async () => {
    const r = await api("/resources/refresh", "POST", {});
    await reload();
    notify(
      r.results.some((x) => x.error)
        ? "部分订阅更新失败，已保留原配置"
        : "订阅更新完成",
    );
  },
  "feishu-config": () => go("feishu"),
  "save-feishu": async () => {
    if (!$("#feishu-form").reportValidity()) return;
    const d = Object.fromEntries(new FormData($("#feishu-form")));
    d.rootIds = d.roots.split(/[,，\s]+/).filter(Boolean);
    delete d.roots;
    await api("/feishu/config", "PUT", d);
    await reload();
    notify("飞书配置已加密保存；请检查连接并同步员工。");
  },
  "feishu-check": async () => {
    const r = await api("/feishu/check", "POST", {});
    notify(r.message);
  },
  "feishu-sync": () => {
    if (!state.feishu?.configured) {
      go("feishu");
      notify("请先保存飞书应用配置");
      return;
    }
    modal(
      "同步飞书组织与员工",
      "只读取已配置范围内的部门和基本身份信息。",
      '<p class="guide-text">新员工默认待授权；已有员工保留资源池分配。明确离职、冻结或不再可见的已同步员工会被停用并撤销设备会话。任何分页失败都会中止，不写入半份通讯录。</p>',
      "开始同步",
      async () => {
        const r = await api("/feishu/sync", "POST", {});
        close();
        await reload();
        notify(
          `同步完成：新增 ${r.added}，更新 ${r.updated}，停用 ${r.disabled}`,
        );
      },
    );
  },
  "copy-feishu-callback": async () => {
    await navigator.clipboard.writeText(state.feishu.callbackURL);
    notify("已复制飞书回调地址");
  },
  "new-pool": () => editPool(),
  "new-employee": () => editEmployee(),
  publish: () => publish(),
  "new-gateway": () =>
    modal(
      "注册计量网关",
      "填写自有网关域名和 HTTPS 代理端口。",
      `${field("网关名称", "name")}${field("公网域名", "host")}${field("HTTPS 端口", "port", "8443", "number")}`,
      "注册并生成密钥",
      async (d) => {
        const r = await api("/gateways", "POST", Object.fromEntries(d));
        close();
        await reload();
        secretResult("网关已注册", r);
      },
    ),
  "save-settings": async () => {
    const d = Object.fromEntries(new FormData($("#settings-form")));
    for (const k of ["interval", "limit", "grace"]) d[k] = Number(d[k]);
    await api("/settings", "PUT", d);
    await reload();
    notify("设置已保存");
  },
  "usage-export": () =>
    downloadCSV(
      [
        [
          "员工ID",
          "姓名",
          "部门",
          "上传字节",
          "下载字节",
          "合计字节",
          "数据覆盖",
          "最近采样",
          "区间开始",
          "区间结束",
        ],
        ...usageData.employees.map((e) => [
          e.employeeId,
          e.name,
          e.dept,
          e.metered ? e.uploadBytes : "",
          e.metered ? e.downloadBytes : "",
          e.metered ? e.uploadBytes + e.downloadBytes : "",
          e.metered ? "网关采样" : "暂无采样",
          e.lastReport,
          usageData.from,
          usageData.to,
        ]),
      ],
      "relay-employee-usage.csv",
    ),
  "date-apply": async () => {
    from = $("#from-date").value;
    to = $("#to-date").value;
    if (!from || !to) throw Error("请选择开始和结束日期");
    usageData = await loadUsage();
    render();
  },
  guide: () =>
    modal(
      "从资源到员工",
      "按以下步骤启用服务。",
      '<p class="guide-text">1. 导入订阅，创建资源池。<br>2. 添加飞书员工身份并分配资源池。<br>3. 发布配置快照。<br>4. 注册设备；客户端使用设备令牌获取配置。<br>5. 如需员工计量，注册并部署独立网关、为设备绑定网关，再在设置中启用网关模式。</p>',
      null,
    ),
  notifications: () => notify("网关状态和待处理配置请查看计量网关页面。"),
  workspace: () => notify(state.settings.workspace),
  profile: () =>
    modal(
      "管理员会话",
      esc(me.name),
      `<p class="guide-text">${me.local ? "当前为仅本机可用的开发模式，无需管理员密码。" : "当前为已认证管理员会话。"}</p>`,
      me.local ? null : "退出登录",
      async () => {
        await api("/auth/logout", "POST", {});
        close();
        state = null;
        login();
      },
    ),
};
document.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el) return;
  try {
    if (el.dataset.nav) go(el.dataset.nav);
    else if (el.dataset.action) {
      if (busy && el.dataset.action !== "close") return;
      busy = true;
      try {
        await actions[el.dataset.action]?.();
      } finally {
        busy = false;
      }
    } else if (el.dataset.pool)
      editPool(state.pools.find((p) => p.id === el.dataset.pool));
    else if (el.dataset.employee)
      editEmployee(state.employees.find((x) => x.id === el.dataset.employee));
    else if (el.dataset.newDevice) newDevice(el.dataset.newDevice);
    else if (el.dataset.revoke) {
      modal(
        "撤销设备",
        "撤销设备令牌与网关访问授权。",
        '<p class="guide-text">网关将在下次拉取并应用配置时移除此设备账号，届时会重启核心以断开既有连接。</p>',
        "确认撤销",
        () =>
          done(
            "/devices/" + el.dataset.revoke,
            "DELETE",
            undefined,
            "设备已撤销",
          ),
      );
    } else if (el.dataset.rollback) publish(el.dataset.rollback);
    else if (el.dataset.usage) usageDetail(el.dataset.usage);
    else if (el.dataset.period) {
      period = el.dataset.period;
      if (period === "custom") {
        from = new Date().toISOString().slice(0, 10);
        to = from;
        render();
      } else {
        usageData = await loadUsage();
        render();
      }
    } else if (el.dataset.resource) {
      const r = state.resources.find((r) => r.id === el.dataset.resource);
      modal(
        "资源详情",
        esc(r.name),
        `<div class="detail-row"><span>节点数量</span><b>${r.nodeCount}</b></div><div class="detail-row"><span>最近同步</span><b>${fmtDate(r.updatedAt)}</b></div><p class="guide-text">节点密钥与上游订阅地址不返回到管理页面。更新资源后需发布新版本才能应用快照。</p>`,
        null,
      );
    }
  } catch (err) {
    notify(err.message);
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id !== "search") return;
  query = e.target.value;
  $("#results").innerHTML =
    {
      resources: () =>
        resourcesTable(
          state.resources.filter((r) => matches(r.name, r.vendor)),
        ),
      employees: employeeTable,
      usage: usageTable,
      audit: auditTable,
    }[page]?.() || "";
});
document.addEventListener("keydown", (e) => {
  const modal = $("#overlay .modal");
  if (!modal) return;
  if (e.key === "Escape") close();
  if (e.key === "Tab") {
    const list = [
      ...modal.querySelectorAll("button,input,select,textarea"),
    ].filter((e) => !e.disabled);
    if (e.shiftKey && document.activeElement === list[0]) {
      e.preventDefault();
      list.at(-1).focus();
    } else if (!e.shiftKey && document.activeElement === list.at(-1)) {
      e.preventDefault();
      list[0].focus();
    }
  }
});
window.addEventListener("hashchange", () => {
  const p = location.hash.slice(1);
  if (p !== page) {
    page = p;
    query = "";
    render();
  }
});
function login() {
  $("#main").innerHTML =
    `<div class="login-card panel form-panel"><div class="eyebrow">RELAY CONTROL</div><h1>登录企业控制台</h1><p>管理员使用密码或已授权的飞书身份登录。</p><form id="login-form">${field("管理员密码", "password", "", "password")}<button class="btn primary" type="submit">登录</button></form><a class="btn" href="/auth/feishu/start" style="margin-top:18px">使用飞书登录 ${icon("arrow")}</a></div>`;
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(
        "/auth/login",
        "POST",
        Object.fromEntries(new FormData(e.target)),
      );
      await init();
    } catch (e) {
      notify(e.message);
    }
  };
}
async function init() {
  try {
    me = await api("/me");
    if (me.role !== "admin") {
      $("#main").innerHTML =
        '<section class="panel form-panel"><h1>飞书登录成功</h1><p>你的身份已验证，请返回企业客户端注册设备并同步配置。管理控制台仅向管理员开放。</p></section>';
      return;
    }
    await reload();
  } catch (e) {
    if (!$("#login-form"))
      $("#main").innerHTML =
        `<section class="panel form-panel"><h1>暂时无法连接服务</h1><p>${esc(e.message)}</p><button class="btn" data-action="retry">重试</button></section>`;
    actions.retry = init;
  }
}
// management.js installs the resource and employee views before initialization.

function feishu() {
  const f = state.feishu || { rootIds: ["0"], adminIds: [], departments: [] },
    last = f.lastSync;
  const doc = "https://open.feishu.cn/document/server-docs/contact-v3";
  return (
    heading(
      "FEISHU INTEGRATION",
      "飞书集成",
      "配置企业身份、通讯录读取范围与员工同步。",
      button("检查连接", "feishu-check", "link") +
        button("同步员工", "feishu-sync", "refresh", true),
    ) +
    `<div class="form-grid"><section class="panel form-panel"><h2>企业自建应用</h2><p>App Secret 加密保存在服务端数据库，页面不会回显密钥。</p><form id="feishu-form">${field("App ID", "appId", f.appId || "")}<label class="field"><span>App Secret</span><input name="appSecret" type="password" autocomplete="new-password" maxlength="500" placeholder="${f.secretConfigured ? "已保存；留空保留原密钥" : "填写飞书应用密钥"}" ${f.secretConfigured ? "" : "required"}><small>不要把密钥发到聊天、订阅链接或员工客户端。</small></label>${field("企业 tenant_key", "tenantKey", f.tenantKey || "")}<p class="form-hint">tenant_key 是飞书身份接口返回的企业标识，不是数字企业 ID 或 App ID。</p>${field("同步根部门 ID", "roots", (f.rootIds || ["0"]).join(", "))}<p class="form-hint">默认 0 代表全员范围；如只授权部分部门，填写其 open_department_id，多个用逗号分隔。应用必须有相应数据范围。</p><p class="form-hint">系统管理员请在“工作空间设置”的飞书区域选择账号添加或移除。</p><button type="button" class="btn" data-nav="settings">管理系统管理员</button><button type="button" class="btn primary" data-action="save-feishu">${icon("check")}保存配置</button></form></section>
  <section class="panel form-panel setup-guide"><h2>飞书开放平台配置步骤</h2><p>应用配置需在飞书后台发布并获管理员批准后生效。</p><ol><li><b>创建企业自建应用</b><p>在“凭证与基础信息”复制 App ID 和 App Secret；添加网页应用能力以使用授权登录。</p></li><li><b>配置重定向 URL</b><p>将下方完整 HTTPS 地址填入应用安全设置的重定向 URL。这里填写服务端地址，不是 relay-enterprise://。</p><input class="callback-input" readonly aria-label="飞书回调地址" value="${esc(f.callbackURL || "")}"><button type="button" class="text-link" data-action="copy-feishu-callback">复制回调地址 ${icon("download")}</button></li><li><b>开通通讯录只读权限</b><p>按 API 要求启用获取通讯录基本信息、用户基本信息、用户组织架构、部门基本信息和部门组织架构的只读权限。无需手机号、邮箱、薪酬或写通讯录权限。</p><code>contact:contact.base:readonly<br>contact:user.base:readonly<br>contact:user.department:readonly<br>contact:department.base:readonly<br>contact:department.organize:readonly</code></li><li><b>配置可用范围与可访问数据范围</b><p>全员同步时，应用通讯录数据范围需要覆盖全员；应用可用范围也应覆盖需要登录的员工。保存并发布版本。</p></li><li><b>保存 → 检查连接 → 同步员工</b><p>检查成功仅证明凭证与所选部门读取可用；tenant_key 会在真实飞书登录回调中再次校验。同步后到“员工与设备”授权并分配资源池。</p></li></ol><a class="text-link" href="${doc}" target="_blank" rel="noopener noreferrer">飞书官方通讯录文档 ${icon("external")}</a></section></div>
  <div class="section-title"><h2>同步状态</h2>${badge(f.configured ? "应用已配置" : "尚未配置", "neutral")}</div><section class="panel"><div class="toolbar"><span>最近同步：${fmtDate(last?.at)}</span><span class="muted">${last ? `${last.employees} 位员工 · ${last.departments} 个部门 · 新增 ${last.added} / 更新 ${last.updated} / 停用 ${last.disabled}` : "暂无同步记录"}</span></div></section>
  <div class="section-title"><h2>同步部门</h2><span class="muted">${(f.departments || []).length} 个</span></div><section class="panel">${table(
    ["部门", "open_department_id", "上级部门"],
    (f.departments || []).map(
      (d) =>
        `<tr><td><strong>${esc(d.name)}</strong></td><td>${esc(d.id)}</td><td>${esc((f.departments || []).find((x) => x.id === d.parentId)?.name || d.parentId || "—")}</td></tr>`,
    ),
  )}</section><div style="height:20px"></div>${note("同步为管理员手动触发，不是实时离职事件订阅。新员工不会自动获得网络权限；已有授权保留，已停用员工也不会因重新同步而自动启用。")}`
  );
}
