const els = {
  statusLine: document.getElementById("statusLine"),
  refreshBtn: document.getElementById("refreshBtn"),
  toggleBtn: document.getElementById("toggleBtn"),
  dbDot: document.getElementById("dbDot"),
  dbStatus: document.getElementById("dbStatus"),
  linkBtn: document.getElementById("linkBtn"),
  openFileBtn: document.getElementById("openFileBtn"),
  reconnectBtn: document.getElementById("reconnectBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  saveBtn: document.getElementById("saveBtn"),
  unlinkBtn: document.getElementById("unlinkBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importInput: document.getElementById("importInput"),
  clearBtn: document.getElementById("clearBtn"),
  cards: document.getElementById("cards"),
  donut: document.getElementById("donut"),
  donutTotal: document.getElementById("donutTotal"),
  bars: document.getElementById("bars"),
  tabsBody: document.getElementById("tabsBody"),
  domainsBody: document.getElementById("domainsBody"),
  sessions: document.getElementById("sessions"),
  showClosed: document.getElementById("showClosed"),
  ownStats: document.getElementById("ownStats")
};

const COLORS = [
  "#4f8cff",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6"
];

const IDB_NAME = "tracktab_db";
const IDB_STORE = "handles";
const IDB_KEY = "db";

let currentState = null;
let fileHandle = null;
let lastWrite = 0;
let lastWrittenUpdatedAt = 0;
let fileWriteTimer = null;
let syncing = false;

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(payload || {}) }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response" });
    });
  });
}

function setDbStatus(text, kind) {
  els.dbStatus.textContent = text;
  els.dbDot.className = "db-dot " + (kind || "");
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const request = tx.objectStore(IDB_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function mergeStates(local, file) {
  const base = local && typeof local === "object" ? local : {};
  const incoming = file && typeof file === "object" ? file : {};
  const out = JSON.parse(JSON.stringify(base));
  out.settings = { ...(base.settings || {}), ...(incoming.settings || {}) };
  out.system =
    incoming.system && (incoming.system.collectedAt || 0) > ((base.system && base.system.collectedAt) || 0)
      ? incoming.system
      : base.system || {};
  out.own = { ...(base.own || {}) };

  const tabs = { ...(base.tabs || {}) };
  for (const [id, tab] of Object.entries(incoming.tabs || {})) {
    const current = tabs[id];
    if (!current) {
      tabs[id] = tab;
      continue;
    }
    const currentMetricsAt = (current.metrics && current.metrics.collectedAt) || 0;
    const incomingMetricsAt = (tab.metrics && tab.metrics.collectedAt) || 0;
    const localNewer = (current.lastSeen || 0) >= (tab.lastSeen || 0);
    tabs[id] = {
      ...current,
      ...tab,
      activeMs: Math.max(current.activeMs || 0, tab.activeMs || 0),
      upMs: Math.max(current.upMs || 0, tab.upMs || 0),
      visits: Math.max(current.visits || 0, tab.visits || 0),
      firstSeen: Math.min(
        current.firstSeen || Number.MAX_SAFE_INTEGER,
        tab.firstSeen || Number.MAX_SAFE_INTEGER
      ),
      lastSeen: Math.max(current.lastSeen || 0, tab.lastSeen || 0),
      open: localNewer ? Boolean(current.open) : Boolean(tab.open),
      closedAt: Math.max(current.closedAt || 0, tab.closedAt || 0),
      metrics: incomingMetricsAt >= currentMetricsAt ? tab.metrics : current.metrics
    };
  }
  out.tabs = tabs;

  const domains = { ...(base.domains || {}) };
  for (const [name, domain] of Object.entries(incoming.domains || {})) {
    const current = domains[name];
    if (!current) {
      domains[name] = domain;
      continue;
    }
    domains[name] = {
      ...current,
      ...domain,
      activeMs: Math.max(current.activeMs || 0, domain.activeMs || 0),
      upMs: Math.max(current.upMs || 0, domain.upMs || 0),
      visits: Math.max(current.visits || 0, domain.visits || 0),
      firstSeen: Math.min(
        current.firstSeen || Number.MAX_SAFE_INTEGER,
        domain.firstSeen || Number.MAX_SAFE_INTEGER
      ),
      lastSeen: Math.max(current.lastSeen || 0, domain.lastSeen || 0)
    };
  }
  out.domains = domains;

  const sessionMap = new Map();
  for (const session of [...(base.sessions || []), ...(incoming.sessions || [])]) {
    if (session && session.id) sessionMap.set(session.id, session);
  }
  out.sessions = Array.from(sessionMap.values())
    .sort((a, b) => (a.start || 0) - (b.start || 0))
    .slice(-500);
  out.updatedAt = Math.max(base.updatedAt || 0, incoming.updatedAt || 0);
  return out;
}

function render(state) {
  currentState = state;
  if (!state) return;

  const enabled = Boolean(state.settings && state.settings.enabled);
  els.toggleBtn.textContent = enabled ? "Pause tracking" : "Resume tracking";
  els.toggleBtn.classList.toggle("active", enabled);

  const tabs = Object.values(state.tabs || {}).filter((tab) => tab.domain !== "internal");
  const openTabs = tabs.filter((tab) => tab.open);
  const domains = Object.values(state.domains || {}).filter((domain) => domain.domain !== "internal");
  const totalActive = domains.reduce((sum, domain) => sum + (domain.activeMs || 0), 0);
  const totalUptime = openTabs.reduce((sum, tab) => sum + (tab.upMs || 0), 0);

  els.statusLine.textContent = enabled
    ? openTabs.length +
      " open tabs, " +
      domains.length +
      " sites, updated " +
      timeAgo(state.updatedAt)
    : "Tracking paused, updated " + timeAgo(state.updatedAt);

  renderCards(state, tabs, openTabs, domains, totalActive, totalUptime);
  renderDonut(domains);
  renderBars(openTabs);
  renderTabsTable(tabs);
  renderDomainsTable(domains, tabs);
  renderSessions(state.sessions || []);
  renderOwn(state);
}

function renderCards(state, tabs, openTabs, domains, totalActive, totalUptime) {
  const memory = state.system && state.system.memory;
  const memoryText =
    memory && memory.capacity
      ? formatBytes(memory.capacity - memory.availableCapacity) + " / " + formatBytes(memory.capacity)
      : "n/a";
  const cpuText =
    state.system && typeof state.system.cpuUsage === "number"
      ? state.system.cpuUsage + "%"
      : "n/a";

  const latestNetwork = tabs
    .filter((tab) => tab.metrics && tab.metrics.conn)
    .sort((a, b) => (b.metrics.collectedAt || 0) - (a.metrics.collectedAt || 0))[0];
  const networkText = latestNetwork
    ? latestNetwork.metrics.conn.effectiveType || "unknown"
    : "n/a";

  const cacheBytes = tabs.reduce(
    (sum, tab) => sum + ((tab.metrics && tab.metrics.storage && tab.metrics.storage.usage) || 0),
    0
  );
  const heapBytes = tabs.reduce(
    (sum, tab) => sum + ((tab.metrics && tab.metrics.mem && tab.metrics.mem.used) || 0),
    0
  );

  const cards = [
    ["Open tabs", String(openTabs.length), "live tabs"],
    ["Sites", String(domains.length), "tracked domains"],
    ["Active time", formatDuration(totalActive), "watched tab only"],
    ["Uptime", formatDuration(totalUptime), "open tabs"],
    ["System CPU", cpuText, "system wide"],
    ["Memory", memoryText, "system wide"],
    ["JS heap", formatBytes(heapBytes), "pages reporting"],
    ["Network", networkText, "latest page"],
    ["Cache", formatBytes(cacheBytes), "page storage"]
  ];

  els.cards.innerHTML = cards
    .map(
      ([label, value, hint]) =>
        '<div class="card">' +
        '<span class="card-label">' +
        escapeHtml(label) +
        "</span>" +
        '<span class="card-value">' +
        escapeHtml(value) +
        "</span>" +
        '<span class="card-hint">' +
        escapeHtml(hint) +
        "</span>" +
        "</div>"
    )
    .join("");
}

function renderDonut(domains) {
  const items = domains
    .filter((domain) => (domain.activeMs || 0) > 0)
    .sort((a, b) => b.activeMs - a.activeMs);
  const total = items.reduce((sum, domain) => sum + domain.activeMs, 0);
  els.donutTotal.textContent = total ? formatDuration(total) : "";

  if (!total) {
    els.donut.innerHTML = '<div class="empty">No active time recorded yet.</div>';
    return;
  }

  const top = items.slice(0, 8);
  const rest = items.slice(8);
  if (rest.length) {
    top.push({
      domain: "Other",
      activeMs: rest.reduce((sum, domain) => sum + domain.activeMs, 0)
    });
  }

  const radius = 70;
  const stroke = 26;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  let circles = "";

  top.forEach((item, index) => {
    const fraction = item.activeMs / total;
    const dash = fraction * circumference;
    circles +=
      '<circle cx="90" cy="90" r="' +
      radius +
      '" fill="none" stroke="' +
      COLORS[index % COLORS.length] +
      '" stroke-width="' +
      stroke +
      '" stroke-dasharray="' +
      dash +
      " " +
      (circumference - dash) +
      '" stroke-dashoffset="' +
      -offset +
      '" transform="rotate(-90 90 90)"></circle>';
    offset += dash;
  });

  const legend = top
    .map((item, index) => {
      const pct = Math.round((item.activeMs / total) * 100);
      return (
        '<div class="legend-row">' +
        '<span class="legend-dot" style="background:' +
        COLORS[index % COLORS.length] +
        '"></span>' +
        '<span class="legend-name" title="' +
        escapeHtml(item.domain) +
        '">' +
        escapeHtml(item.domain) +
        "</span>" +
        '<span class="legend-value">' +
        formatDuration(item.activeMs) +
        "</span>" +
        '<span class="legend-pct">' +
        pct +
        "%</span>" +
        "</div>"
      );
    })
    .join("");

  els.donut.innerHTML =
    '<div class="donut">' +
    '<svg viewBox="0 0 180 180" role="img" aria-label="Time by site">' +
    '<circle cx="90" cy="90" r="' +
    radius +
    '" fill="none" stroke="var(--line)" stroke-width="' +
    stroke +
    '"></circle>' +
    circles +
    '<text x="90" y="86" text-anchor="middle" class="donut-total">' +
    formatDuration(total) +
    "</text>" +
    '<text x="90" y="104" text-anchor="middle" class="donut-sub">total active</text>' +
    "</svg>" +
    '<div class="legend">' +
    legend +
    "</div>" +
    "</div>";
}

function renderBars(openTabs) {
  const items = openTabs
    .filter((tab) => (tab.activeMs || 0) > 0)
    .sort((a, b) => b.activeMs - a.activeMs)
    .slice(0, 8);

  if (!items.length) {
    els.bars.innerHTML = '<div class="empty">No active time recorded yet.</div>';
    return;
  }

  const max = items[0].activeMs || 1;
  els.bars.innerHTML = items
    .map((tab) => {
      const pct = Math.max(2, Math.round((tab.activeMs / max) * 100));
      const label = tab.domain || tab.title || "unknown";
      return (
        '<div class="bar-row">' +
        '<span class="bar-label" title="' +
        escapeHtml(tab.title || tab.domain) +
        '">' +
        escapeHtml(label) +
        "</span>" +
        '<span class="bar-track"><span class="bar-fill" style="width:' +
        pct +
        '%"></span></span>' +
        '<span class="bar-value">' +
        formatDuration(tab.activeMs) +
        "</span>" +
        "</div>"
      );
    })
    .join("");
}

function renderTabsTable(tabs) {
  const showClosed = els.showClosed.checked;
  let list = tabs.slice().sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return (b.activeMs || 0) - (a.activeMs || 0);
  });

  if (!showClosed) list = list.filter((tab) => tab.open);
  list = list.slice(0, 200);

  if (!list.length) {
    els.tabsBody.innerHTML = '<tr><td colspan="12" class="empty">No tabs tracked yet.</td></tr>';
    return;
  }

  els.tabsBody.innerHTML = list
    .map((tab) => {
      const metrics = tab.metrics || {};
      const memory = metrics.mem && metrics.mem.used ? formatBytes(metrics.mem.used) : "n/a";
      const memoryTitle = metrics.mem
        ? "used " + formatBytes(metrics.mem.used) + " of " + formatBytes(metrics.mem.limit)
        : "";
      const network = metrics.conn && metrics.conn.effectiveType ? metrics.conn.effectiveType : "n/a";
      const networkTitle = metrics.conn
        ? metrics.conn.downlink + " Mbps, " + metrics.conn.rtt + " ms RTT"
        : "";
      const lag = metrics.available && typeof metrics.lagMs === "number" ? metrics.lagMs + " ms" : "n/a";
      const resources = metrics.available ? formatNumber(metrics.resources) : "n/a";
      const images = metrics.available
        ? formatNumber(metrics.imageCount) +
          (metrics.imageBytes ? " / " + formatBytes(metrics.imageBytes) : "")
        : "n/a";
      const streams = metrics.available ? formatNumber(metrics.streamCount) : "n/a";
      const cache = metrics.storage && metrics.storage.usage
        ? formatBytes(metrics.storage.usage)
        : metrics.available
          ? formatBytes(metrics.decodedBytes)
          : "n/a";
      const cacheTitle = metrics.cachedResources
        ? metrics.cachedResources + " cached resources"
        : "";
      const title = tab.title || tab.url || "";
      const status = tab.open ? "" : ' <span class="badge">closed</span>';

      return (
        '<tr class="' +
        (tab.open ? "" : "closed-row") +
        '">' +
        '<td class="site"><span class="site-name" title="' +
        escapeHtml(tab.domain) +
        '">' +
        escapeHtml(tab.domain || "unknown") +
        "</span>" +
        status +
        "</td>" +
        '<td class="title-cell" title="' +
        escapeHtml(title) +
        '">' +
        escapeHtml(title) +
        "</td>" +
        "<td>" +
        formatDuration(tab.activeMs) +
        "</td>" +
        "<td>" +
        formatDuration(tab.upMs) +
        "</td>" +
        '<td title="' +
        escapeHtml(memoryTitle) +
        '">' +
        memory +
        "</td>" +
        '<td title="' +
        escapeHtml(networkTitle) +
        '">' +
        escapeHtml(network) +
        "</td>" +
        "<td>" +
        lag +
        "</td>" +
        "<td>" +
        resources +
        "</td>" +
        "<td>" +
        images +
        "</td>" +
        "<td>" +
        streams +
        "</td>" +
        '<td title="' +
        escapeHtml(cacheTitle) +
        '">' +
        cache +
        "</td>" +
        '<td class="row-actions">' +
        '<button class="icon-btn" data-action="collect" data-tab="' +
        tab.id +
        '" type="button">Scan</button>' +
        '<button class="icon-btn danger" data-action="delete-tab" data-tab="' +
        tab.id +
        '" type="button">Delete</button>' +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
}

function renderDomainsTable(domains, tabs) {
  const sorted = domains.slice().sort((a, b) => (b.activeMs || 0) - (a.activeMs || 0));

  if (!sorted.length) {
    els.domainsBody.innerHTML = '<tr><td colspan="7" class="empty">No sites tracked yet.</td></tr>';
    return;
  }

  const tabCounts = {};
  for (const tab of tabs) {
    tabCounts[tab.domain] = (tabCounts[tab.domain] || 0) + 1;
  }

  els.domainsBody.innerHTML = sorted
    .map(
      (domain) =>
        "<tr>" +
        '<td class="site">' +
        escapeHtml(domain.domain) +
        "</td>" +
        "<td>" +
        formatDuration(domain.activeMs) +
        "</td>" +
        "<td>" +
        formatDuration(domain.upMs) +
        "</td>" +
        "<td>" +
        formatNumber(domain.visits) +
        "</td>" +
        "<td>" +
        formatNumber(tabCounts[domain.domain] || 0) +
        "</td>" +
        "<td>" +
        (domain.lastSeen ? timeAgo(domain.lastSeen) : "never") +
        "</td>" +
        '<td class="row-actions">' +
        '<button class="icon-btn danger" data-action="delete-domain" data-domain="' +
        escapeHtml(domain.domain) +
        '" type="button">Delete</button>' +
        "</td>" +
        "</tr>"
    )
    .join("");
}

function renderSessions(sessions) {
  const list = sessions
    .slice()
    .sort((a, b) => (b.start || 0) - (a.start || 0))
    .slice(0, 12);

  if (!list.length) {
    els.sessions.innerHTML = '<div class="empty">No sessions recorded yet.</div>';
    return;
  }

  els.sessions.innerHTML = list
    .map(
      (session) =>
        '<div class="session-row">' +
        '<span class="session-domain">' +
        escapeHtml(session.domain) +
        "</span>" +
        '<span class="session-time">' +
        escapeHtml(new Date(session.start).toLocaleTimeString()) +
        "</span>" +
        '<span class="session-dur">' +
        formatDuration(session.ms) +
        "</span>" +
        "</div>"
    )
    .join("");
}

function renderOwn(state) {
  const own = state.own || {};
  const dashHeap =
    performance.memory && performance.memory.usedJSHeapSize
      ? formatBytes(performance.memory.usedJSHeapSize)
      : "n/a";

  const items = [
    ["Worker starts", formatNumber(own.boots)],
    ["Ticks", formatNumber(own.ticks)],
    ["Metric scans", formatNumber(own.collects)],
    ["Last scan", own.lastCollect ? timeAgo(own.lastCollect) : "never"],
    ["Scan time", own.collectMs ? formatNumber(own.collectMs) + " ms" : "n/a"],
    ["Storage", own.storageBytes ? formatBytes(own.storageBytes) : "n/a"],
    ["Dashboard heap", dashHeap],
    ["DOM nodes", formatNumber(document.getElementsByTagName("*").length)],
    ["File save", lastWrite ? timeAgo(lastWrite) : "never"]
  ];

  els.ownStats.innerHTML = items
    .map(
      ([label, value]) =>
        '<div class="own-item">' +
        '<span class="own-label">' +
        escapeHtml(label) +
        "</span>" +
        '<span class="own-value">' +
        escapeHtml(value) +
        "</span>" +
        "</div>"
    )
    .join("");
}

async function refreshState() {
  const response = await send("getState");
  if (response.ok) render(response.state);
}

async function refreshMetrics() {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "Scanning...";
  try {
    const response = await send("collect");
    if (response.ok) {
      render(response.state);
      scheduleFileWrite();
    }
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "Refresh metrics";
  }
}

async function toggleTracking() {
  const enabled = !(currentState && currentState.settings && currentState.settings.enabled);
  const response = await send("setEnabled", { enabled });
  if (response.ok) {
    render(response.state);
    scheduleFileWrite();
  }
}

function scheduleFileWrite() {
  if (!fileHandle) return;
  clearTimeout(fileWriteTimer);
  fileWriteTimer = setTimeout(() => {
    writeStateToFile().catch(() => {});
  }, 1500);
}

async function readStateFromFile() {
  if (!fileHandle) return null;
  const file = await fileHandle.getFile();
  const text = await file.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function writeStateToFile() {
  if (!fileHandle) {
    setDbStatus("No file linked.", "warn");
    return false;
  }

  try {
    const permission = await fileHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      setDbStatus("File permission needed. Click Reconnect.", "warn");
      return false;
    }

    const state = currentState || (await send("getState")).state;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();

    lastWrite = Date.now();
    lastWrittenUpdatedAt = state.updatedAt || 0;
    renderOwn(state);
    return true;
  } catch (error) {
    setDbStatus("Write failed: " + (error.message || error), "error");
    return false;
  }
}

async function autoSync() {
  if (!fileHandle || syncing) return;
  syncing = true;

  try {
    const local = currentState || (await send("getState")).state;
    const file = await readStateFromFile();
    const merged = file ? mergeStates(local, file) : local;
    const response = await send("importState", { state: merged });

    if (response.ok) {
      render(response.state);
      await writeStateToFile();
      setDbStatus("Synced with " + fileHandle.name, "ok");
    }
  } catch (error) {
    setDbStatus("Sync failed: " + (error.message || error), "error");
  } finally {
    syncing = false;
  }
}

async function linkFile() {
  if (!window.showSaveFilePicker) {
    setDbStatus("File System Access API is not available in this browser.", "error");
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "tracktab.txt",
      startIn: "documents",
      types: [
        {
          description: "TrackTab database",
          accept: { "text/plain": [".txt"] }
        }
      ]
    });

    fileHandle = handle;
    await idbSet(IDB_KEY, handle);
    els.reconnectBtn.classList.add("hidden");

    const saved = await writeStateToFile();
    if (saved) {
      setDbStatus("Linked to " + handle.name + ". Data saved.", "ok");
    }
  } catch (error) {
    if (error && error.name === "AbortError") return;
    setDbStatus("Link failed: " + (error.message || error), "error");
  }
}

async function openExistingFile() {
  if (!window.showOpenFilePicker) {
    setDbStatus("File System Access API is not available in this browser.", "error");
    return;
  }

  try {
    const handles = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "TrackTab database",
          accept: { "text/plain": [".txt", ".json"] }
        }
      ]
    });

    const handle = handles && handles[0];
    if (!handle) return;

    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    if (permission !== "granted") {
      setDbStatus("Permission denied.", "error");
      return;
    }

    fileHandle = handle;
    await idbSet(IDB_KEY, handle);
    els.reconnectBtn.classList.add("hidden");
    await autoSync();
  } catch (error) {
    if (error && error.name === "AbortError") return;
    setDbStatus("Open failed: " + (error.message || error), "error");
  }
}

async function reconnectFile() {
  if (!fileHandle) return;

  try {
    const permission = await fileHandle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      setDbStatus("Permission denied.", "error");
      return;
    }
    els.reconnectBtn.classList.add("hidden");
    await autoSync();
  } catch (error) {
    setDbStatus("Reconnect failed: " + (error.message || error), "error");
  }
}

async function reloadFromFile() {
  if (!fileHandle) {
    setDbStatus("No file linked. Click Link file first.", "warn");
    return;
  }
  await autoSync();
}

async function unlinkFile() {
  fileHandle = null;
  lastWrittenUpdatedAt = 0;
  try {
    await idbDel(IDB_KEY);
  } catch {}
  els.reconnectBtn.classList.add("hidden");
  setDbStatus("Database unlinked. Tracking still saved in browser storage.", "warn");
}

function exportJson() {
  const state = currentState;
  if (!state) return;

  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "tracktab-export-" + new Date().toISOString().slice(0, 10) + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importJson(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const local = currentState || (await send("getState")).state;
    const merged = mergeStates(local, parsed);
    const response = await send("importState", { state: merged });

    if (response.ok) {
      render(response.state);
      if (fileHandle) await writeStateToFile();
      setDbStatus("Imported " + file.name, "ok");
    }
  } catch (error) {
    setDbStatus("Import failed: " + (error.message || error), "error");
  } finally {
    els.importInput.value = "";
  }
}

async function clearAll() {
  const confirmed = confirm("Delete all tracked tabs, sites, and sessions? This cannot be undone.");
  if (!confirmed) return;

  const response = await send("clearAll");
  if (response.ok) {
    render(response.state);
    if (fileHandle) await writeStateToFile();
    setDbStatus("All tracking data cleared.", "warn");
  }
}

async function loadStoredHandle() {
  try {
    fileHandle = await idbGet(IDB_KEY);
  } catch {
    fileHandle = null;
  }

  if (!fileHandle) {
    setDbStatus("Database not linked. Click Link file and choose Documents/tracktab.txt.", "warn");
    return;
  }

  try {
    const permission = await fileHandle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      setDbStatus("Linked to " + fileHandle.name, "ok");
      els.reconnectBtn.classList.add("hidden");
      await autoSync();
    } else {
      setDbStatus("Permission needed for " + fileHandle.name + ". Click Reconnect.", "warn");
      els.reconnectBtn.classList.remove("hidden");
    }
  } catch {
    fileHandle = null;
    setDbStatus("Linked file is no longer available. Link again.", "error");
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;

  if (action === "collect") {
    target.disabled = true;
    await send("collectTab", { tabId: Number(target.dataset.tab) });
    target.disabled = false;
    await refreshState();
    scheduleFileWrite();
  }

  if (action === "delete-tab") {
    if (!confirm("Delete this tab record?")) return;
    const response = await send("deleteTab", { tabId: Number(target.dataset.tab) });
    if (response.ok) {
      render(response.state);
      if (fileHandle) await writeStateToFile();
    }
  }

  if (action === "delete-domain") {
    if (!confirm("Delete this site, its tabs, and its sessions?")) return;
    const response = await send("deleteDomain", { domain: target.dataset.domain });
    if (response.ok) {
      render(response.state);
      if (fileHandle) await writeStateToFile();
    }
  }
});

els.refreshBtn.addEventListener("click", refreshMetrics);
els.toggleBtn.addEventListener("click", toggleTracking);
els.linkBtn.addEventListener("click", linkFile);
els.openFileBtn.addEventListener("click", openExistingFile);
els.reconnectBtn.addEventListener("click", reconnectFile);
els.reloadBtn.addEventListener("click", reloadFromFile);
els.saveBtn.addEventListener("click", async () => {
  const saved = await writeStateToFile();
  if (saved && fileHandle) setDbStatus("Saved to " + fileHandle.name, "ok");
});
els.unlinkBtn.addEventListener("click", unlinkFile);
els.exportBtn.addEventListener("click", exportJson);
els.importBtn.addEventListener("click", () => els.importInput.click());
els.importInput.addEventListener("change", () => {
  const file = els.importInput.files && els.importInput.files[0];
  if (file) importJson(file);
});
els.clearBtn.addEventListener("click", clearAll);
els.showClosed.addEventListener("change", () => {
  if (currentState) render(currentState);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tracktab_state && changes.tracktab_state.newValue) {
    render(changes.tracktab_state.newValue);
  }
});

async function boot() {
  await refreshState();
  await loadStoredHandle();

  setInterval(refreshState, 15000);

  setInterval(() => {
    if (!fileHandle) return;
    if (!currentState) return;
    if ((currentState.updatedAt || 0) === lastWrittenUpdatedAt) return;
    writeStateToFile().catch(() => {});
  }, 30000);
}

boot();
