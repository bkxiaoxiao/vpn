// Node-level pool membership and explicit, reviewable bulk employee grants.
let employeeDepartment = "", includeChildren = true;
const selectedEmployees = new Set();
const originalEmployees = employees;
const originalRender = render;
const originalResourcesTable = resourcesTable;

function filteredEmployees() {
  const ids = new Set(employeeDepartment ? [employeeDepartment] : []);
  if (employeeDepartment && includeChildren) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of state.feishu?.departments || [])
        if (ids.has(d.parentId) && !ids.has(d.id)) { ids.add(d.id); changed = true; }
    }
  }
  return state.employees.filter((e) => matches(e.name, e.dept, e.openId)
    && (!employeeDepartment || (employeeDepartment.startsWith("manual:")
      ? e.dept === employeeDepartment.slice(7)
      : (e.departmentIds || []).some((id) => ids.has(id)))));
}
function departmentFilter() {
  const departments = state.feishu?.departments || [];
  const manual = [...new Set(state.employees.filter((e) => !e.departmentIds?.length).map((e) => e.dept))];
  return `<select id="employee-department" aria-label="按部门筛选"><option value="">全部部门</option>${departments.map((d) =>
    `<option value="${esc(d.id)}" ${employeeDepartment === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}${manual.map((name) =>
    `<option value="manual:${esc(name)}" ${employeeDepartment === "manual:" + name ? "selected" : ""}>${esc(name)}（手动）</option>`).join("")}</select><label class="inline-check"><input type="checkbox" id="include-child-departments" ${includeChildren ? "checked" : ""}>包含下级部门</label>`;
}
employeeTable = function () {
  const rows = filteredEmployees();
  return table([`<input type="checkbox" id="select-employees" aria-label="全选当前筛选员工" ${rows.length && rows.every((e) => selectedEmployees.has(e.id)) ? "checked" : ""}>`, "员工 / 飞书身份", "部门", "资源池", "设备", "区间用量", "授权状态", ""], rows.map((e) => {
    const u = usageData.employees.find((x) => x.employeeId === e.id);
    return `<tr><td><input type="checkbox" data-select-employee="${esc(e.id)}" aria-label="选择 ${esc(e.name)}" ${selectedEmployees.has(e.id) ? "checked" : ""}></td><td><div class="employee"><span class="avatar">${esc(e.name.slice(0, 1))}</span><span><strong>${esc(e.name)}</strong><small>${esc(e.openId)}</small></span></div></td><td>${esc(e.dept)}</td><td>${e.poolIds.map((id) => esc(state.pools.find((p) => p.id === id)?.name || "已删除")).join("、") || "尚未分配"}</td><td>${e.devices.filter((d) => !d.revokedAt).length} 台</td><td>${u?.metered ? bytes(u.uploadBytes + u.downloadBytes) : '<span class="muted">暂无计量采样</span>'}</td><td>${badge(e.enabled ? "已授权" : e.directoryState === "active" ? "待授权" : "已停用")}</td><td><button class="text-link" data-employee="${e.id}">管理</button></td></tr>`;
  }));
};
employees = function () {
  return originalEmployees().replace(toolbar("搜索姓名、部门或飞书身份"),
    toolbar("搜索姓名、部门或飞书身份", departmentFilter()) + '<div class="bulk-bar"><span id="selection-count"></span><button class="btn primary" data-action="batch-employees">批量授权 / 分配资源</button><button class="text-link" data-action="clear-employees">清空选择</button></div>');
};
render = function () {
  if (state) for (const id of selectedEmployees)
    if (!state.employees.some((e) => e.id === id)) selectedEmployees.delete(id);
  originalRender();
  updateEmployeeSelection();
};
function updateEmployeeSelection() {
  if (page !== "employees" || !state) return;
  const rows = filteredEmployees(), counter = $("#selection-count"), all = $("#select-employees");
  if (counter) counter.textContent = `筛选结果 ${rows.length} 人 · 已选择 ${selectedEmployees.size} 人`;
  if (all) {
    const count = rows.filter((e) => selectedEmployees.has(e.id)).length;
    all.checked = rows.length > 0 && count === rows.length;
    all.indeterminate = count > 0 && count < rows.length;
  }
}
function batchEmployees() {
  const selected = state.employees.filter((e) => selectedEmployees.has(e.id));
  if (!selected.length) return notify("请勾选员工，或筛选部门后全选筛选结果");
  modal("批量授权与资源分配", `本次仅修改已勾选的 ${selected.length} 位员工，不自动授权部门未来新增成员。`,
    `<details class="batch-preview"><summary>查看本次 ${selected.length} 位员工（含跨筛选选择）</summary><ul>${selected.map((e) => `<li>${esc(e.name)} · ${esc(e.dept)} · ${e.enabled ? "已授权" : "未授权"}</li>`).join("")}</ul></details>
    ${select("访问授权", "access", [["keep", "保持当前授权状态"], ["enable", "授权使用 VPN"], ["disable", "停用并撤销会话与设备"]], "keep")}
    ${select("资源池分配方式", "poolMode", [["add", "追加（保留员工原有资源池）"], ["remove", "移除选中的资源池"], ["replace", "替换全部资源池（未选则清空）"]], "add")}
    ${checks("选择资源池", "poolIds", state.pools, [])}
    <p class="form-hint">分配资源池不会自动启用未授权员工。停用会撤销登录和设备；重新启用后需要重新登录。替换会覆盖原分配，请核对所选人员。</p>`,
    "应用到所选员工", async (d) => {
      const result = await api("/employees/batch", "POST", { employeeIds: selected.map((e) => e.id), access: d.get("access"), poolMode: d.get("poolMode"), poolIds: d.getAll("poolIds") });
      selectedEmployees.clear(); close(); await reload();
      notify(`已更新 ${result.updated} 位员工；节点变更请到配置发布中发布`);
    });
}
actions["batch-employees"] = batchEmployees;
actions["clear-employees"] = () => { selectedEmployees.clear(); render(); };

function nodeTable(nodes, resourceId) {
  return table(["节点名称", "协议", "服务器", "端口", "所属资源池"], nodes.map((n) => {
    const pools = state.pools.filter((p) => Array.isArray(p.nodeSelections)
      ? p.nodeSelections.some((s) => s.resourceId === resourceId && s.nodeIds.includes(n.id))
      : p.sourceIds.includes(resourceId));
    return `<tr><td><strong>${esc(n.name)}</strong></td><td>${esc(n.protocol)}</td><td>${esc(n.server)}</td><td>${esc(n.port)}</td><td>${pools.map((p) => esc(p.name)).join("、") || "尚未加入"}</td></tr>`;
  }));
}
resourcesTable = function (rows) {
  return originalResourcesTable(rows) + rows.map((r) => `<details class="node-expander"><summary>${esc(r.name)} · 展开 ${r.nodeCount} 个节点</summary>${nodeTable(r.nodeDetails || [], r.id)}</details>`).join("");
};
editPool = function (p) {
  const selected = new Set();
  for (const r of state.resources) for (const n of r.nodeDetails || []) {
    const includes = Array.isArray(p?.nodeSelections)
      ? p.nodeSelections.some((s) => s.resourceId === r.id && s.nodeIds.includes(n.id))
      : p?.sourceIds.includes(r.id);
    if (includes) selected.add(r.id + ":" + n.id);
  }
  const stale = (p?.nodeSelections || []).reduce((count, s) => count + s.nodeIds.filter((id) =>
    !state.resources.find((r) => r.id === s.resourceId)?.nodeDetails?.some((n) => n.id === id)).length, 0);
  modal(p ? "管理资源池" : "创建资源池", "勾选要分配的节点，可跨订阅组合；未勾选的节点不会加入。",
    `${field("资源池名称", "name", p?.name)}${field("用途说明", "desc", p?.desc, "text", false)}
    <p class="form-hint">保存为明确的节点清单，订阅后续新增节点需要另行勾选。保存后发布新版本，客户端才会同步更新。</p>
    ${stale ? `<p class="form-hint">有 ${stale} 个已选节点被上游移除或更换；本次保存将移除失效选择。</p>` : ""}
    <label class="field"><span>搜索节点、服务器或订阅</span><input id="pool-node-search" type="search" placeholder="输入关键词筛选"></label>
    <div class="node-picker">${state.resources.map((r) => `<section class="node-source"><div class="node-source-title"><b>${esc(r.name)} · ${esc(r.vendor)}</b><span><button type="button" class="text-link" data-source-select="${r.id}">全选可见</button> <button type="button" class="text-link" data-source-clear="${r.id}">清空可见</button></span></div>
      ${(r.nodeDetails || []).map((n) => `<label class="node-choice" data-node-search="${esc([r.name, r.vendor, n.name, n.protocol, n.server, n.port].join(" ").toLowerCase())}"><input type="checkbox" name="nodeKeys" value="${r.id}:${n.id}" data-node-source="${r.id}" ${selected.has(r.id + ":" + n.id) ? "checked" : ""}><span><strong>${esc(n.name)}</strong><small>${esc(n.protocol)} · ${esc(n.server)}:${n.port}</small></span></label>`).join("")}</section>`).join("") || '<p class="muted">请先导入订阅或节点。</p>'}</div><p class="form-hint" id="node-selection-count"></p>`,
    "保存资源池", (d) => {
      const nodeSelections = state.resources.map((r) => ({ resourceId: r.id, nodeIds: d.getAll("nodeKeys").filter((key) => key.startsWith(r.id + ":")).map((key) => key.slice(r.id.length + 1)) })).filter((s) => s.nodeIds.length);
      return done("/pools" + (p ? "/" + p.id : ""), p ? "PUT" : "POST", { name: d.get("name"), desc: d.get("desc"), nodeSelections }, "资源池已保存；请发布新版本使节点选择生效");
    });
  $("#overlay .modal").classList.add("wide-modal"); updateNodeCount();
};
function updateNodeCount() {
  const counter = $("#node-selection-count");
  if (counter) counter.textContent = "已选择 " + document.querySelectorAll('#modal-form [name="nodeKeys"]:checked').length + " 个节点";
}
// Capture resource clicks before the original summary-only modal handler.
document.addEventListener("click", (e) => {
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.resource) {
    e.stopImmediatePropagation();
    const r = state.resources.find((r) => r.id === el.dataset.resource);
    modal("节点明细", esc(r.name), `<p class="guide-text">在资源池中按节点勾选并发布配置。此处不显示订阅链接或节点密钥。</p>${nodeTable(r.nodeDetails || [], r.id)}`, null);
    $("#overlay .modal").classList.add("wide-modal");
  } else if (el.dataset.sourceSelect || el.dataset.sourceClear) {
    const id = el.dataset.sourceSelect || el.dataset.sourceClear;
    for (const input of document.querySelectorAll('[name="nodeKeys"]'))
      if (input.dataset.nodeSource === id && !input.closest(".node-choice").hidden) input.checked = !!el.dataset.sourceSelect;
    updateNodeCount();
  }
}, true);
document.addEventListener("change", (e) => {
  const target = e.target;
  if (target.dataset.selectEmployee) {
    if (target.checked) selectedEmployees.add(target.dataset.selectEmployee); else selectedEmployees.delete(target.dataset.selectEmployee);
    updateEmployeeSelection();
  } else if (target.id === "select-employees") {
    for (const employee of filteredEmployees()) {
      if (target.checked) selectedEmployees.add(employee.id); else selectedEmployees.delete(employee.id);
    }
    $("#results").innerHTML = employeeTable(); updateEmployeeSelection();
  } else if (target.id === "employee-department" || target.id === "include-child-departments") {
    employeeDepartment = $("#employee-department").value; includeChildren = $("#include-child-departments").checked;
    $("#results").innerHTML = employeeTable(); updateEmployeeSelection();
  } else if (target.name === "nodeKeys") updateNodeCount();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "pool-node-search") {
    const term = e.target.value.trim().toLowerCase();
    for (const row of document.querySelectorAll(".node-choice")) row.hidden = !row.dataset.nodeSearch.includes(term);
  } else if (e.target.id === "search") updateEmployeeSelection();
});
const originalSettings = settings;
function systemAdministrators() {
  const admins = state.feishu?.administrators || [];
  return `<div class="system-admins"><div class="section-title"><h2>系统管理员</h2><button type="button" class="btn" data-action="add-system-admin">${icon("plus")}添加管理员</button></div>
    <p>选择可通过飞书登录本管理后台的账号，可管理资源、员工、配置与工作空间。此权限与员工 VPN 使用授权分别管理。</p>
    <div class="admin-list">${admins.map((a) => {
      const self = a.openId === me.feishuOpenId || (a.employeeId && a.employeeId === me.employeeId);
      return `<div class="admin-row"><span><strong>${esc(a.name)}</strong> ${self ? badge("当前账号", "neutral") : ""}<small>${esc(a.dept || "未同步部门")}</small><small>${esc(a.openId)}</small></span><button type="button" class="text-link" data-remove-admin="${esc(a.openId)}" ${self || admins.length <= 1 ? 'disabled title="需保留当前账号及至少一位管理员"' : ""}>移除</button></div>`;
    }).join("") || '<p class="muted">尚未设置飞书管理员。</p>'}</div>
    <p class="form-hint">添加后请使用对应飞书账号重新登录。移除后旧后台会话立即失效；当前账号不能移除自己，且至少保留一位管理员。账号还须在飞书应用可用范围内。</p></div>`;
}
settings = function () {
  const marker = "<p>同步不会自动授权新员工。明确离职、冻结或不再可见的已同步员工会被停用。</p>";
  return originalSettings().replace(marker, marker + systemAdministrators());
};
actions["add-system-admin"] = () => {
  if (!state.feishu?.configured) return notify("请先配置飞书应用并同步员工");
  const candidates = state.employees.filter((e) => !state.feishu.adminIds.includes(e.openId)
    && e.directoryState === "active");
  modal("添加系统管理员", "所选账号将有权登录并设置整个 VPN 管理后台。员工 VPN 授权保持原样。",
    `<label class="field"><span>搜索飞书账号</span><input type="search" id="admin-account-search" placeholder="搜索姓名、部门或飞书身份"></label>
    <div class="admin-candidates">${candidates.map((e) => `<label class="admin-choice" data-admin-search="${esc([e.name, e.dept, e.openId].join(" ").toLowerCase())}"><input type="radio" name="openId" required value="${esc(e.openId)}"><span><strong>${esc(e.name)}</strong><small>${esc(e.dept)}</small><small>${esc(e.openId)}</small></span></label>`).join("") || '<p class="muted">暂无可添加账号，请先同步飞书员工。</p>'}</div>`,
    candidates.length ? "添加为系统管理员" : null, (d) => done("/feishu/admins", "POST", { action: "add", openId: d.get("openId") }, "系统管理员已添加，请使用对应飞书账号重新登录"));
};
document.addEventListener("input", (e) => {
  if (e.target.id !== "admin-account-search") return;
  const term = e.target.value.trim().toLowerCase();
  for (const row of document.querySelectorAll(".admin-choice")) row.hidden = !row.dataset.adminSearch.includes(term);
});
document.addEventListener("click", (e) => {
  const el = e.target.closest("button[data-remove-admin]");
  if (!el || el.disabled) return;
  const a = state.feishu.administrators.find((a) => a.openId === el.dataset.removeAdmin);
  if (!a) return;
  modal("移除系统管理员", `${esc(a.name)} · ${esc(a.dept)}`,
    '<p class="guide-text">移除后该账号不能再管理后台，已有后台会话立即失效。员工 VPN 使用授权与资源池分配保持原样。</p>',
    "确认移除管理员", () => done("/feishu/admins", "POST", { action: "remove", openId: a.openId }, "系统管理员已移除"));
});
init();
