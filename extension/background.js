const ALARM_NAME = "subscription-refresh";
const DEFAULTS = {
  subscriptions: [],
  nodes: [],
  selectedNodeId: "",
  connected: false,
  refreshHours: 24,
  gatewayUrl: "",
  apiToken: "",
  proxyHost: "",
  proxyPort: 443,
  proxyUsername: "",
  proxyPassword: "",
  lastError: ""
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  await chrome.storage.local.set({ ...DEFAULTS, ...withoutUndefined(current) });
  await configureAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await configureAlarm();
  const state = await getStoredState();
  if (state.connected && state.selectedNodeId) {
    try {
      await startConnection(state.selectedNodeId);
    } catch (error) {
      await chrome.storage.local.set({ connected: false, lastError: friendlyError(error) });
      await clearChromeProxy();
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshSubscriptions().catch(recordError);
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    chrome.storage.local.get(["proxyHost", "proxyPort", "proxyUsername", "proxyPassword"], (state) => {
      const challenger = details.challenger || {};
      const sameHost = normalizeHost(challenger.host) === normalizeHost(state.proxyHost);
      const samePort = !challenger.port || Number(challenger.port) === Number(state.proxyPort);
      if (details.isProxy && sameHost && samePort && state.proxyUsername && state.proxyPassword) {
        callback({ authCredentials: { username: state.proxyUsername, password: state.proxyPassword } });
        return;
      }
      callback({});
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "getState": return getPublicState();
    case "connect": return startConnection(message.nodeId);
    case "disconnect": return stopConnection();
    case "selectNode": return selectNode(message.nodeId);
    case "refreshSubscriptions": return refreshSubscriptions(message.subscriptionId);
    case "saveSubscription": return saveSubscription(message.subscription);
    case "deleteSubscription": return deleteSubscription(message.subscriptionId);
    case "saveSettings": return saveSettings(message.settings);
    case "saveGatewaySettings": return saveGatewaySettings(message.settings);
    case "gatewayStatus": return { gateway: await gatewayRequest("/v1/status") };
    default: throw new Error("未知操作");
  }
}

async function getPublicState() {
  const state = await getStoredState();
  let gateway;
  if (!gatewayConfigured(state)) {
    gateway = { available: false, error: "请先配置远程网关" };
  } else {
    try {
      const result = await gatewayRequest("/v1/status", {}, state);
      gateway = { available: true, ...result };
    } catch (error) {
      gateway = { available: false, error: friendlyError(error) };
    }
  }
  return { state, gateway };
}

async function startConnection(requestedNodeId) {
  const state = await getStoredState();
  requireGateway(state);
  const nodeId = requestedNodeId || state.selectedNodeId || state.nodes[0]?.id;
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("请先添加订阅并选择节点");

  const result = await gatewayRequest("/v1/nodes/select", {
    method: "POST",
    body: { node: sanitizeNode(node) }
  }, state);
  if (!result.status?.running) throw new Error(result.status?.lastError || "远程 sing-box 未能启动");

  const proxy = result.proxy || {};
  const proxyHost = proxy.host || state.proxyHost;
  const proxyPort = Number(proxy.port || state.proxyPort);
  const proxyUsername = proxy.username || state.proxyUsername;
  try {
    await setChromeProxy(proxyHost, proxyPort);
  } catch (error) {
    throw new Error(`Chrome 代理设置失败：${friendlyError(error)}`);
  }
  await chrome.storage.local.set({
    selectedNodeId: node.id,
    connected: true,
    proxyHost,
    proxyPort,
    proxyUsername,
    lastError: ""
  });
  return { state: await getStoredState(), gateway: { available: true, ...result } };
}

async function stopConnection() {
  await clearChromeProxy();
  await chrome.storage.local.set({ connected: false, lastError: "" });
  return { state: await getStoredState() };
}

async function selectNode(nodeId) {
  const state = await getStoredState();
  if (!state.nodes.some((node) => node.id === nodeId)) throw new Error("节点不存在或已经失效");
  await chrome.storage.local.set({ selectedNodeId: nodeId });
  return state.connected ? startConnection(nodeId) : { state: await getStoredState() };
}

async function saveSubscription(input) {
  const state = await getStoredState();
  requireGateway(state);
  const name = String(input?.name || "").trim();
  const url = String(input?.url || "").trim();
  if (!name) throw new Error("请输入订阅名称");
  if (!/^https?:\/\//i.test(url)) throw new Error("订阅地址必须以 http:// 或 https:// 开头");

  const id = input.id || crypto.randomUUID();
  const subscription = {
    id,
    name: name.slice(0, 80),
    url,
    updatedAt: input.updatedAt || null,
    nodeCount: input.nodeCount || 0,
    warning: "",
    error: ""
  };
  const subscriptions = [...state.subscriptions.filter((item) => item.id !== id), subscription];
  await chrome.storage.local.set({ subscriptions });
  return refreshSubscriptions(id);
}

async function deleteSubscription(subscriptionId) {
  const state = await getStoredState();
  const subscriptions = state.subscriptions.filter((item) => item.id !== subscriptionId);
  const nodes = state.nodes.filter((item) => item.sourceId !== subscriptionId);
  const selectedNodeId = nodes.some((item) => item.id === state.selectedNodeId)
    ? state.selectedNodeId
    : nodes[0]?.id || "";
  await chrome.storage.local.set({ subscriptions, nodes, selectedNodeId });
  if (state.connected) {
    if (selectedNodeId) await startConnection(selectedNodeId);
    else await stopConnection();
  }
  return { state: await getStoredState() };
}

async function saveGatewaySettings(settings) {
  const candidate = {
    ...(await getStoredState()),
    gatewayUrl: normalizeGatewayUrl(settings.gatewayUrl),
    apiToken: String(settings.apiToken || "").trim(),
    proxyHost: normalizeHost(settings.proxyHost),
    proxyPort: Number(settings.proxyPort),
    proxyUsername: String(settings.proxyUsername || "").trim(),
    proxyPassword: String(settings.proxyPassword || "")
  };
  requireGateway(candidate);
  const gateway = await gatewayRequest("/v1/status", {}, candidate);
  const proxy = gateway.proxy || {};
  candidate.proxyHost = proxy.host || candidate.proxyHost;
  candidate.proxyPort = Number(proxy.port || candidate.proxyPort);
  candidate.proxyUsername = proxy.username || candidate.proxyUsername;
  await chrome.storage.local.set({
    gatewayUrl: candidate.gatewayUrl,
    apiToken: candidate.apiToken,
    proxyHost: candidate.proxyHost,
    proxyPort: candidate.proxyPort,
    proxyUsername: candidate.proxyUsername,
    proxyPassword: candidate.proxyPassword,
    lastError: ""
  });
  if (candidate.connected && candidate.selectedNodeId) await startConnection(candidate.selectedNodeId);
  return { state: await getStoredState(), gateway: { available: true, ...gateway } };
}

async function saveSettings(settings) {
  const refreshHours = Number(settings.refreshHours);
  if (![0, 6, 12, 24, 48].includes(refreshHours)) throw new Error("自动更新时间无效");
  await chrome.storage.local.set({ refreshHours });
  await configureAlarm();
  return { state: await getStoredState() };
}

async function refreshSubscriptions(onlyId) {
  const state = await getStoredState();
  requireGateway(state);
  const targets = onlyId ? state.subscriptions.filter((item) => item.id === onlyId) : state.subscriptions;
  if (!targets.length) throw new Error(onlyId ? "订阅不存在" : "还没有添加订阅");

  let nodes = [...state.nodes];
  const subscriptions = [...state.subscriptions];
  const errors = [];
  for (const subscription of targets) {
    const index = subscriptions.findIndex((item) => item.id === subscription.id);
    try {
      const parsed = await gatewayRequest("/v1/subscriptions/refresh", {
        method: "POST",
        body: { id: subscription.id, name: subscription.name, url: subscription.url }
      }, state);
      nodes = [...nodes.filter((node) => node.sourceId !== subscription.id), ...parsed.nodes];
      subscriptions[index] = {
        ...subscription,
        updatedAt: new Date().toISOString(),
        nodeCount: parsed.nodes.length,
        warning: parsed.warnings.slice(0, 3).join("；"),
        error: ""
      };
    } catch (error) {
      const message = friendlyError(error);
      errors.push(`${subscription.name}：${message}`);
      subscriptions[index] = { ...subscription, error: message };
    }
  }

  let selectedNodeId = state.selectedNodeId;
  if (!nodes.some((node) => node.id === selectedNodeId)) selectedNodeId = nodes[0]?.id || "";
  await chrome.storage.local.set({ subscriptions, nodes, selectedNodeId, lastError: errors.join("；") });
  if (state.connected && selectedNodeId) await startConnection(selectedNodeId);
  return { state: await getStoredState(), errors };
}

async function gatewayRequest(path, options = {}, providedState) {
  const state = providedState || await getStoredState();
  requireGateway(state);
  const url = new URL(path.replace(/^\//, ""), `${state.gatewayUrl}/`);
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${state.apiToken}`,
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw new Error(`无法连接远程网关：${friendlyError(error)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`远程网关返回了无效响应（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(payload.error || `远程网关错误（HTTP ${response.status}）`);
  return payload;
}

async function configureAlarm() {
  const { refreshHours = DEFAULTS.refreshHours } = await chrome.storage.local.get("refreshHours");
  await chrome.alarms.clear(ALARM_NAME);
  if (Number(refreshHours) > 0) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: Number(refreshHours) * 60 });
  }
}

async function setChromeProxy(host, port) {
  if (!host) throw new Error("远程代理主机为空");
  await chrome.proxy.settings.set({
    scope: "regular",
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "https", host, port: Number(port) },
        bypassList: ["localhost", "127.0.0.1", "<local>"]
      }
    }
  });
}

async function clearChromeProxy() {
  await chrome.proxy.settings.clear({ scope: "regular" });
}

async function getStoredState() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function requireGateway(state) {
  if (!gatewayConfigured(state)) throw new Error("请先在设置页配置远程网关");
  if (!Number.isInteger(Number(state.proxyPort)) || Number(state.proxyPort) < 1 || Number(state.proxyPort) > 65535) {
    throw new Error("HTTPS 代理端口无效");
  }
}

function gatewayConfigured(state) {
  return Boolean(state.gatewayUrl && state.apiToken && state.proxyHost && state.proxyUsername && state.proxyPassword);
}

function normalizeGatewayUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("网关 API 地址无效");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("网关 API 必须使用 HTTPS（本机测试除外）");
  }
  return url.href.replace(/\/$/, "");
}

function normalizeHost(value) {
  return String(value || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function sanitizeNode(node) {
  const { raw: _raw, ...safe } = node;
  return safe;
}

function friendlyError(error) {
  return error?.message || String(error) || "未知错误";
}

function recordError(error) {
  chrome.storage.local.set({ lastError: friendlyError(error) });
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
