const elements = {
  statusBadge: document.querySelector("#statusBadge"),
  card: document.querySelector(".connection-card"),
  title: document.querySelector("#connectionTitle"),
  detail: document.querySelector("#connectionDetail"),
  toggle: document.querySelector("#toggleButton"),
  refresh: document.querySelector("#refreshButton"),
  select: document.querySelector("#nodeSelect"),
  protocol: document.querySelector("#protocolTag"),
  source: document.querySelector("#sourceText"),
  count: document.querySelector("#nodeCount"),
  message: document.querySelector("#message"),
  settings: document.querySelector("#settingsButton")
};

let currentState;

elements.toggle.addEventListener("click", async () => {
  await withLoading(elements.toggle, async () => {
    const result = await call(currentState.connected ? "disconnect" : "connect", {
      nodeId: elements.select.value
    });
    currentState = result.state;
    render(result.state, result.gateway);
  });
});

elements.select.addEventListener("change", async () => {
  await withLoading(elements.select, async () => {
    const result = await call("selectNode", { nodeId: elements.select.value });
    currentState = result.state;
    render(result.state, result.gateway);
  });
});

elements.refresh.addEventListener("click", async () => {
  await withLoading(elements.refresh, async () => {
    const result = await call("refreshSubscriptions");
    currentState = result.state;
    render(result.state);
    showMessage(result.errors?.length ? result.errors.join("；") : "订阅已更新", !result.errors?.length);
  });
});

elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());

load();

async function load() {
  try {
    const result = await call("getState");
    currentState = result.state;
    render(result.state, result.gateway);
  } catch (error) {
    showMessage(error.message);
  }
}

function render(state, gateway = {}) {
  const connected = Boolean(state.connected && gateway.status?.running !== false);
  const selected = state.nodes.find((node) => node.id === state.selectedNodeId) || state.nodes[0];

  elements.statusBadge.textContent = connected ? "已连接" : "未连接";
  elements.statusBadge.classList.toggle("online", connected);
  elements.card.classList.toggle("connected", connected);
  elements.title.textContent = connected ? "代理运行中" : "代理已关闭";
  elements.detail.textContent = connected
    ? `${selected?.name || "节点"} · ${state.proxyHost}:${state.proxyPort}`
    : gateway.available === false
      ? "需要先配置远程网关"
      : "选择一个节点后即可连接";
  elements.toggle.textContent = connected ? "断开连接" : "连接";
  elements.toggle.disabled = !state.nodes.length;

  const groups = new Map();
  for (const node of state.nodes) {
    const list = groups.get(node.sourceName) || [];
    list.push(node);
    groups.set(node.sourceName, list);
  }
  elements.select.replaceChildren();
  if (!state.nodes.length) {
    elements.select.add(new Option("请先添加订阅", ""));
    elements.select.disabled = true;
  } else {
    elements.select.disabled = false;
    for (const [sourceName, nodes] of groups) {
      const group = document.createElement("optgroup");
      group.label = sourceName;
      for (const node of nodes) group.append(new Option(node.name, node.id));
      elements.select.append(group);
    }
    elements.select.value = selected?.id || "";
  }

  elements.protocol.textContent = selected?.protocol || "—";
  elements.source.textContent = selected ? `${selected.sourceName} · ${selected.server}:${selected.port}` : "尚无节点";
  elements.count.textContent = `${state.nodes.length} 个节点`;
  elements.refresh.disabled = !state.subscriptions.length;

  if (state.lastError) showMessage(state.lastError);
  else hideMessage();
}

async function call(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "操作失败");
  return response;
}

async function withLoading(control, task) {
  const original = control.textContent;
  control.disabled = true;
  if (control.tagName === "BUTTON") control.textContent = "处理中…";
  hideMessage();
  try {
    await task();
  } catch (error) {
    showMessage(error.message);
  } finally {
    control.disabled = false;
    if (control.tagName === "BUTTON" && control.textContent === "处理中…") control.textContent = original;
  }
}

function showMessage(text, success = false) {
  elements.message.textContent = text;
  elements.message.classList.add("show");
  elements.message.classList.toggle("success", success);
}

function hideMessage() {
  elements.message.classList.remove("show", "success");
}
