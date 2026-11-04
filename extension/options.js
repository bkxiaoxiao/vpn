const elements = {
  gatewayForm: document.querySelector("#gatewayForm"),
  gatewayUrl: document.querySelector("#gatewayUrl"),
  apiToken: document.querySelector("#apiToken"),
  proxyHost: document.querySelector("#proxyHost"),
  proxyPort: document.querySelector("#proxyPort"),
  proxyUsername: document.querySelector("#proxyUsername"),
  proxyPassword: document.querySelector("#proxyPassword"),
  subscriptionForm: document.querySelector("#subscriptionForm"),
  name: document.querySelector("#subscriptionName"),
  url: document.querySelector("#subscriptionUrl"),
  list: document.querySelector("#subscriptionList"),
  empty: document.querySelector("#emptyState"),
  count: document.querySelector("#subscriptionCount"),
  refreshAll: document.querySelector("#refreshAllButton"),
  gatewayBadge: document.querySelector("#gatewayBadge"),
  apiStatus: document.querySelector("#apiStatus"),
  running: document.querySelector("#runningStatus"),
  remoteNode: document.querySelector("#remoteNodeStatus"),
  gatewayHint: document.querySelector("#gatewayHint"),
  checkGateway: document.querySelector("#checkGatewayButton"),
  settingsForm: document.querySelector("#settingsForm"),
  refreshHours: document.querySelector("#refreshHours"),
  message: document.querySelector("#message")
};

let currentState;

elements.gatewayForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await withLoading(event.submitter, async () => {
    const result = await call("saveGatewaySettings", {
      settings: {
        gatewayUrl: elements.gatewayUrl.value,
        apiToken: elements.apiToken.value,
        proxyHost: elements.proxyHost.value,
        proxyPort: Number(elements.proxyPort.value),
        proxyUsername: elements.proxyUsername.value,
        proxyPassword: elements.proxyPassword.value
      }
    });
    currentState = result.state;
    renderState(result.state);
    renderGateway(result.gateway);
    showMessage("远程网关连接成功", true);
  });
});

elements.subscriptionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await withLoading(event.submitter, async () => {
    const result = await call("saveSubscription", {
      subscription: { name: elements.name.value, url: elements.url.value }
    });
    currentState = result.state;
    elements.subscriptionForm.reset();
    renderState(result.state);
    showMessage(result.errors?.length ? result.errors.join("；") : "订阅已添加", !result.errors?.length);
  });
});

elements.refreshAll.addEventListener("click", async () => {
  await withLoading(elements.refreshAll, async () => {
    const result = await call("refreshSubscriptions");
    currentState = result.state;
    renderState(result.state);
    showMessage(result.errors?.length ? result.errors.join("；") : "全部订阅已更新", !result.errors?.length);
  });
});

elements.checkGateway.addEventListener("click", async () => {
  await withLoading(elements.checkGateway, async () => {
    const result = await call("gatewayStatus");
    renderGateway({ available: true, ...result.gateway });
    showMessage("远程网关响应正常", true);
  });
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await withLoading(event.submitter, async () => {
    const result = await call("saveSettings", {
      settings: { refreshHours: Number(elements.refreshHours.value) }
    });
    currentState = result.state;
    renderState(result.state);
    showMessage("设置已保存", true);
  });
});

elements.list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "delete" && !confirm("删除这个订阅及其全部节点？")) return;
  await withLoading(button, async () => {
    const result = await call(action === "refresh" ? "refreshSubscriptions" : "deleteSubscription", {
      subscriptionId: id
    });
    currentState = result.state;
    renderState(result.state);
    showMessage(action === "refresh" ? "订阅已更新" : "订阅已删除", true);
  });
});

load();

async function load() {
  try {
    const result = await call("getState");
    currentState = result.state;
    renderState(result.state);
    renderGateway(result.gateway);
  } catch (error) {
    showMessage(error.message);
  }
}

function renderState(state) {
  elements.gatewayUrl.value = state.gatewayUrl || "";
  elements.apiToken.value = state.apiToken || "";
  elements.proxyHost.value = state.proxyHost || "";
  elements.proxyPort.value = String(state.proxyPort || 443);
  elements.proxyUsername.value = state.proxyUsername || "";
  elements.proxyPassword.value = state.proxyPassword || "";
  elements.refreshHours.value = String(state.refreshHours);
  elements.count.textContent = `${state.subscriptions.length} 个`;
  elements.refreshAll.disabled = !state.subscriptions.length;
  elements.empty.classList.toggle("hidden", Boolean(state.subscriptions.length));
  elements.list.replaceChildren(...state.subscriptions.map((subscription) => subscriptionCard(subscription, state.nodes)));
}

function subscriptionCard(subscription, nodes) {
  const card = document.createElement("article");
  card.className = "subscription-item card";
  const content = document.createElement("div");
  const titleRow = document.createElement("div");
  titleRow.className = "subscription-name-row";
  const title = document.createElement("h3");
  title.textContent = subscription.name;
  const chips = document.createElement("div");
  chips.className = "protocol-chips";
  const protocols = [...new Set(nodes.filter((node) => node.sourceId === subscription.id).map((node) => node.protocol))];
  for (const protocol of protocols) {
    const chip = document.createElement("span");
    chip.textContent = protocol;
    chips.append(chip);
  }
  titleRow.append(title, chips);
  const url = document.createElement("p");
  url.className = "subscription-url";
  url.textContent = maskUrl(subscription.url);
  url.title = subscription.url;
  const meta = document.createElement("p");
  meta.className = `subscription-meta${subscription.error ? " error" : ""}`;
  meta.textContent = subscription.error
    ? `更新失败：${subscription.error}`
    : `${subscription.nodeCount || 0} 个节点 · ${subscription.updatedAt ? `更新于 ${formatDate(subscription.updatedAt)}` : "尚未更新"}${subscription.warning ? ` · ${subscription.warning}` : ""}`;
  content.append(titleRow, url, meta);
  const actions = document.createElement("div");
  actions.className = "subscription-actions";
  actions.append(
    actionButton("更新", "refresh", subscription.id, "secondary"),
    actionButton("删除", "delete", subscription.id, "danger-button")
  );
  card.append(content, actions);
  return card;
}

function actionButton(label, action, id, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.action = action;
  button.dataset.id = id;
  button.textContent = label;
  return button;
}

function renderGateway(gateway = {}) {
  const ready = Boolean(gateway.available);
  const status = gateway.status || {};
  elements.gatewayBadge.textContent = ready ? "已连接" : "未连接";
  elements.gatewayBadge.classList.toggle("online", ready);
  elements.apiStatus.textContent = ready ? "响应正常" : "不可用";
  elements.running.textContent = status.running ? "运行中" : "未运行";
  elements.remoteNode.textContent = status.selectedNodeName || "尚未选择";
  elements.gatewayHint.textContent = ready
    ? `HTTPS 代理：${gateway.proxy?.host || currentState?.proxyHost || "—"}:${gateway.proxy?.port || currentState?.proxyPort || 443}`
    : gateway.error || "请先部署网关并填写连接信息。";
}

async function call(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "操作失败");
  return response;
}

async function withLoading(button, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中…";
  hideMessage();
  try {
    await task();
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
    if (button.textContent === "处理中…") button.textContent = original;
  }
}

function showMessage(text, success = false) {
  elements.message.textContent = text;
  elements.message.classList.add("show");
  elements.message.classList.toggle("success", success);
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(hideMessage, 5000);
}

function hideMessage() {
  elements.message.classList.remove("show", "success");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function maskUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?••••••" : ""}`;
  } catch {
    return value;
  }
}
