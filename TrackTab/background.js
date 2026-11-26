const STATE_KEY = "tracktab_state";
const TICK_ALARM = "tracktab_tick";
const COLLECT_ALARM = "tracktab_collect";
const TICK_INTERVAL_MS = 15000;
const MAX_DELTA_MS = 120000;
const GAP_THRESHOLD_MS = 300000;
const MAX_SESSIONS = 500;
const MAX_CLOSED_TABS = 300;

function defaultState() {
  return {
    version: 1,
    updatedAt: 0,
    settings: {
      enabled: true,
      collectEveryMs: 300000
    },
    tabs: {},
    domains: {},
    sessions: [],
    system: {
      cpu: null,
      memory: null,
      cpuUsage: null,
      cpuRaw: null,
      collectedAt: 0
    },
    own: {
      boots: 0,
      ticks: 0,
      collects: 0,
      lastTick: 0,
      lastCollect: 0,
      lastSync: 0,
      storageBytes: 0,
      collectMs: 0
    }
  };
}

function migrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base, ...raw };
  out.settings = { ...base.settings, ...(raw.settings || {}) };
  out.tabs = raw.tabs && typeof raw.tabs === "object" ? raw.tabs : {};
  out.domains = raw.domains && typeof raw.domains === "object" ? raw.domains : {};
  out.sessions = Array.isArray(raw.sessions) ? raw.sessions.slice(-MAX_SESSIONS) : [];
  out.system = { ...base.system, ...(raw.system || {}) };
  out.own = { ...base.own, ...(raw.own || {}) };
  return out;
}

let state = defaultState();
let lastTick = Date.now();
let activeTabId = null;
let activeWindowId = null;
let focused = true;
let idle = false;
let currentSession = null;
let persistTimer = null;
let initialized = false;
let readyResolve = null;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});

function domainFromUrl(url) {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function isTrackableUrl(url) {
  return /^https?:/i.test(url || "");
}

function ensureDomain(name) {
  const key = name || "unknown";
  if (!state.domains[key]) {
    state.domains[key] = {
      domain: key,
      activeMs: 0,
      upMs: 0,
      visits: 0,
      lastSeen: 0,
      createdAt: Date.now()
    };
  }
  return state.domains[key];
}

function ensureTab(tab) {
  const id = tab.id;
  const url = tab.url || "";
  const trackable = isTrackableUrl(url);
  const domain = trackable ? domainFromUrl(url) : "internal";
  let record = state.tabs[id];

  if (!record) {
    record = {
      id,
      url,
      title: tab.title || "",
      domain,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      activeMs: 0,
      upMs: 0,
      visits: 1,
      open: true,
      closedAt: 0,
      metrics: null
    };
    state.tabs[id] = record;
    if (trackable) ensureDomain(domain).visits += 1;
    return record;
  }

  if (record.url !== url) {
    record.url = url;
    record.domain = domain;
    record.visits = (record.visits || 0) + 1;
    if (trackable) ensureDomain(domain).visits += 1;
  }

  record.domain = domain;
  record.title = tab.title || record.title;
  record.open = true;
  record.closedAt = 0;
  record.lastSeen = Date.now();
  return record;
}

function pruneClosedTabs() {
  const closed = Object.values(state.tabs)
    .filter((tab) => !tab.open)
    .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  const excess = closed.length - MAX_CLOSED_TABS;
  for (let index = 0; index < excess; index += 1) {
    delete state.tabs[closed[index].id];
  }
}

function startSession(tab, now) {
  if (currentSession) currentSession.end = now;
  currentSession = {
    id: "s" + now.toString(36) + Math.random().toString(36).slice(2, 6),
    tabId: tab.id,
    domain: tab.domain,
    start: now,
    end: now,
    ms: 0
  };
  state.sessions.push(currentSession);
  if (state.sessions.length > MAX_SESSIONS) {
    state.sessions.splice(0, state.sessions.length - MAX_SESSIONS);
  }
}

function tick() {
  const now = Date.now();
  let delta = now - lastTick;
  if (delta < 0) delta = 0;

  if (delta > GAP_THRESHOLD_MS) {
    lastTick = now;
    return;
  }

  lastTick = now;
  state.own.ticks = (state.own.ticks || 0) + 1;

  if (!state.settings.enabled) return;

  const ms = Math.min(delta, MAX_DELTA_MS);

  for (const id in state.tabs) {
    const tab = state.tabs[id];
    if (!tab.open || !isTrackableUrl(tab.url)) continue;
    tab.upMs = (tab.upMs || 0) + ms;
    tab.lastSeen = now;
    const domainRecord = ensureDomain(tab.domain);
    domainRecord.upMs = (domainRecord.upMs || 0) + ms;
    domainRecord.lastSeen = now;
  }

  schedulePersist();

  if (!focused || idle || activeTabId == null) {
    currentSession = null;
    return;
  }

  const tab = state.tabs[activeTabId];
  if (!tab || !isTrackableUrl(tab.url)) {
    currentSession = null;
    return;
  }

  tab.activeMs = (tab.activeMs || 0) + ms;
  tab.lastSeen = now;
  const domainRecord = ensureDomain(tab.domain);
  domainRecord.activeMs = (domainRecord.activeMs || 0) + ms;
  domainRecord.lastSeen = now;

  if (!currentSession || currentSession.tabId !== tab.id || currentSession.domain !== tab.domain) {
    startSession(tab, now);
  }
  currentSession.end = now;
  currentSession.ms = (currentSession.ms || 0) + ms;
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persist().catch(() => {});
  }, 400);
}

async function persist() {
  await ready;
  state.updatedAt = Date.now();
  state.own.lastTick = lastTick;
  try {
    state.own.storageBytes = await chrome.storage.local.getBytesInUse(null);
  } catch {}
  await chrome.storage.local.set({ [STATE_KEY]: state });
  state.own.lastSync = Date.now();
}

async function loadState() {
  let stored = null;
  try {
    const result = await chrome.storage.local.get(STATE_KEY);
    stored = result[STATE_KEY] || null;
  } catch {}
  state = migrate(stored);
  state.own.boots = (state.own.boots || 0) + 1;
  lastTick = Number(state.own.lastTick) || Date.now();
}

async function syncOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const openIds = new Set();
  for (const tab of tabs) {
    if (!tab.id) continue;
    openIds.add(tab.id);
    ensureTab(tab);
  }
  for (const id in state.tabs) {
    const record = state.tabs[id];
    if (record.open && !openIds.has(Number(id))) {
      record.open = false;
      record.closedAt = Date.now();
    }
  }
  pruneClosedTabs();
}

async function restoreActive() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0] && tabs[0].id) {
      activeTabId = tabs[0].id;
      activeWindowId = tabs[0].windowId;
    }
  } catch {}

  try {
    const win = await chrome.windows.getLastFocused();
    focused = Boolean(win && win.focused !== false);
  } catch {}

  try {
    const idleState = await chrome.idle.queryState(60);
    idle = idleState !== "active";
  } catch {}
}

async function collectSystem() {
  let cpuInfo = null;
  let memoryInfo = null;
  try {
    cpuInfo = await chrome.system.cpu.getInfo();
  } catch {}
  try {
    memoryInfo = await chrome.system.memory.getInfo();
  } catch {}

  let cpuUsage = state.system.cpuUsage || null;
  if (cpuInfo && state.system.cpuRaw) {
    const user = cpuInfo.processors.reduce((sum, proc) => sum + proc.usage.user, 0);
    const kernel = cpuInfo.processors.reduce((sum, proc) => sum + proc.usage.kernel, 0);
    const idleTime = cpuInfo.processors.reduce((sum, proc) => sum + proc.usage.idle, 0);
    const prev = state.system.cpuRaw;
    const total = user - prev.user + (kernel - prev.kernel) + (idleTime - prev.idle);
    if (total > 0) {
      cpuUsage = Math.round(((user - prev.user + (kernel - prev.kernel)) / total) * 1000) / 10;
    }
  }

  state.system.cpuRaw = cpuInfo
    ? {
        user: cpuInfo.processors.reduce((sum, proc) => sum + proc.usage.user, 0),
        kernel: cpuInfo.processors.reduce((sum, proc) => sum + proc.usage.kernel, 0),
        idle: cpuInfo.processors.reduce((sum, proc) => sum + proc.usage.idle, 0)
      }
    : null;

  state.system.cpu = cpuInfo
    ? {
        modelName: cpuInfo.modelName,
        archName: cpuInfo.archName,
        numOfProcessors: cpuInfo.numOfProcessors,
        features: cpuInfo.features
      }
    : null;

  state.system.memory = memoryInfo
    ? {
        capacity: memoryInfo.capacity,
        availableCapacity: memoryInfo.availableCapacity
      }
    : null;

  state.system.cpuUsage = cpuUsage;
  state.system.collectedAt = Date.now();
}

async function collectPageMetrics() {
  const resources = performance.getEntriesByType("resource") || [];
  let transferBytes = 0;
  let decodedBytes = 0;
  let cachedResources = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let streamCount = 0;
  const byType = {};

  for (const entry of resources) {
    const transfer = entry.transferSize || 0;
    const decoded = entry.decodedBodySize || 0;
    transferBytes += transfer;
    decodedBytes += decoded;
    if (transfer === 0 && decoded > 0) cachedResources += 1;
    const type = entry.initiatorType || "other";
    byType[type] = (byType[type] || 0) + 1;
    const name = entry.name || "";
    if (type === "img" || /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(name)) {
      imageCount += 1;
      imageBytes += decoded || transfer;
    }
    if (
      type === "video" ||
      type === "audio" ||
      /\.(m3u8|mpd|mp4|webm|ogg|mp3|aac)(\?|#|$)/i.test(name)
    ) {
      streamCount += 1;
    }
  }

  let storage = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      storage = { usage: estimate.usage || 0, quota: estimate.quota || 0 };
    }
  } catch {}

  const nav = performance.getEntriesByType("navigation")[0] || null;
  const mem = performance.memory
    ? {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit
      }
    : null;

  const conn = navigator.connection
    ? {
        effectiveType: navigator.connection.effectiveType || "",
        downlink: navigator.connection.downlink || 0,
        rtt: navigator.connection.rtt || 0,
        saveData: Boolean(navigator.connection.saveData)
      }
    : null;

  const dom = {
    nodes: document.getElementsByTagName("*").length,
    images: document.images ? document.images.length : 0,
    videos: document.querySelectorAll("video").length,
    audios: document.querySelectorAll("audio").length,
    iframes: document.querySelectorAll("iframe").length,
    scripts: document.scripts ? document.scripts.length : 0,
    links: document.links ? document.links.length : 0
  };

  let lagMs = null;
  if (document.visibilityState === "visible") {
    const lagStart = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    lagMs = Math.max(0, performance.now() - lagStart - 50);
  }

  return {
    url: location.href,
    title: document.title,
    visibility: document.visibilityState,
    resources: resources.length,
    transferBytes,
    decodedBytes,
    cachedResources,
    imageCount,
    imageBytes,
    streamCount,
    byType,
    nav: nav
      ? {
          duration: nav.duration,
          domContentLoaded: nav.domContentLoadedEventEnd,
          load: nav.loadEventEnd
        }
      : null,
    mem,
    conn,
    dom,
    storage,
    lagMs: lagMs === null ? null : Math.round(lagMs * 100) / 100,
    collectedAt: Date.now()
  };
}

async function collectTab(tabId) {
  await ready;
  if (!state.settings.enabled) return;

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab || !/^https?:/i.test(tab.url || "")) return;

  const record = ensureTab(tab);
  const started = Date.now();

  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectPageMetrics
    });
    const result = injection && injection[0] ? injection[0].result : null;
    record.metrics = { ...(result || {}), available: true, collectedAt: Date.now() };
    record.url = tab.url;
    record.title = tab.title || record.title;
    record.domain = domainFromUrl(tab.url);
    state.own.collects = (state.own.collects || 0) + 1;
    state.own.lastCollect = Date.now();
    state.own.collectMs = Date.now() - started;
  } catch (error) {
    record.metrics = {
      available: false,
      reason: String((error && error.message) || error),
      collectedAt: Date.now()
    };
  }

  schedulePersist();
}

async function collectAllMetrics() {
  await ready;
  if (!state.settings.enabled) return;

  const started = Date.now();
  await syncOpenTabs();

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  for (const tab of tabs) {
    if (!tab.id) continue;
    const record = ensureTab(tab);
    if (!/^https?:/i.test(tab.url || "")) {
      record.metrics = {
        available: false,
        reason: "Restricted page",
        collectedAt: Date.now()
      };
      continue;
    }
    try {
      const injection = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectPageMetrics
      });
      const result = injection && injection[0] ? injection[0].result : null;
      record.metrics = { ...(result || {}), available: true, collectedAt: Date.now() };
    } catch (error) {
      record.metrics = {
        available: false,
        reason: String((error && error.message) || error),
        collectedAt: Date.now()
      };
    }
  }

  await collectSystem();
  state.own.collects = (state.own.collects || 0) + 1;
  state.own.lastCollect = Date.now();
  state.own.collectMs = Date.now() - started;
  schedulePersist();
}

function deleteTab(tabId) {
  const key = String(tabId);
  delete state.tabs[key];
  state.sessions = state.sessions.filter((session) => String(session.tabId) !== key);
  if (currentSession && String(currentSession.tabId) === key) currentSession = null;
}

function deleteDomain(domain) {
  delete state.domains[domain];
  for (const id in state.tabs) {
    if (state.tabs[id].domain === domain) delete state.tabs[id];
  }
  state.sessions = state.sessions.filter((session) => session.domain !== domain);
}

function clearAll() {
  const enabled = state.settings.enabled;
  state = defaultState();
  state.settings.enabled = enabled;
  currentSession = null;
}

function importState(incoming) {
  if (!incoming || typeof incoming !== "object") return;
  const enabled = state.settings.enabled;
  state = migrate(incoming);
  state.settings.enabled =
    typeof incoming.settings === "object" && typeof incoming.settings.enabled === "boolean"
      ? incoming.settings.enabled
      : enabled;
  currentSession = null;
  lastTick = Date.now();
}

function setupAlarms() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(COLLECT_ALARM, { periodInMinutes: 5 });
}

async function init() {
  await loadState();
  await syncOpenTabs();
  await restoreActive();
  setupAlarms();
  initialized = true;
  readyResolve();
  schedulePersist();

  if (state.settings.enabled && activeTabId != null) {
    collectTab(activeTabId).catch(() => {});
  }
}

init().catch(() => {
  initialized = true;
  readyResolve();
});

setInterval(() => {
  if (initialized) tick();
}, TICK_INTERVAL_MS);

chrome.tabs.onCreated.addListener(async () => {
  await ready;
  await syncOpenTabs();
  schedulePersist();
});

chrome.tabs.onActivated.addListener(async (info) => {
  await ready;
  tick();
  activeTabId = info.tabId;
  activeWindowId = info.windowId;
  try {
    const tab = await chrome.tabs.get(info.tabId);
    ensureTab(tab);
  } catch {}
  schedulePersist();
  collectTab(info.tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;
  if (changeInfo.url || changeInfo.title) {
    if (tabId === activeTabId) tick();
    ensureTab(tab);
    schedulePersist();
  }
  if (changeInfo.status === "complete") {
    collectTab(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  tick();
  const record = state.tabs[tabId];
  if (record) {
    record.open = false;
    record.closedAt = Date.now();
  }
  if (activeTabId === tabId) activeTabId = null;
  schedulePersist();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await ready;
  tick();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    focused = false;
    activeTabId = null;
    currentSession = null;
  } else {
    focused = true;
    activeWindowId = windowId;
    try {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      if (tabs[0] && tabs[0].id) {
        activeTabId = tabs[0].id;
        ensureTab(tabs[0]);
      }
    } catch {}
  }
  schedulePersist();
});

chrome.idle.onStateChanged.addListener(async (newState) => {
  await ready;
  tick();
  idle = newState !== "active";
  if (idle) currentSession = null;
  schedulePersist();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === TICK_ALARM) {
    tick();
    await syncOpenTabs();
    schedulePersist();
  }
  if (alarm.name === COLLECT_ALARM) {
    collectAllMetrics().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  (async () => {
    await ready;

    switch (message.type) {
      case "getState":
        sendResponse({ ok: true, state });
        break;
      case "setEnabled":
        tick();
        state.settings.enabled = Boolean(message.enabled);
        if (!state.settings.enabled) currentSession = null;
        await persist();
        sendResponse({ ok: true, state });
        break;
      case "collect":
        await collectAllMetrics();
        sendResponse({ ok: true, state });
        break;
      case "collectTab":
        await collectTab(message.tabId);
        sendResponse({ ok: true, state });
        break;
      case "deleteTab":
        deleteTab(message.tabId);
        await persist();
        sendResponse({ ok: true, state });
        break;
      case "deleteDomain":
        deleteDomain(message.domain);
        await persist();
        sendResponse({ ok: true, state });
        break;
      case "clearAll":
        clearAll();
        await persist();
        sendResponse({ ok: true, state });
        break;
      case "importState":
        importState(message.state);
        await persist();
        sendResponse({ ok: true, state });
        break;
      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: String((error && error.message) || error) });
  });

  return true;
});
