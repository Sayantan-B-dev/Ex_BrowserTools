const elements = {
  statusDot: document.getElementById("statusDot"),
  trackingHint: document.getElementById("trackingHint"),
  toggle: document.getElementById("trackToggle"),
  openTabs: document.getElementById("openTabs"),
  activeTime: document.getElementById("activeTime"),
  topSite: document.getElementById("topSite"),
  sites: document.getElementById("sites"),
  cpuUsage: document.getElementById("cpuUsage"),
  memory: document.getElementById("memory"),
  lastSync: document.getElementById("lastSync")
};

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

function render(state) {
  if (!state) return;

  const enabled = Boolean(state.settings && state.settings.enabled);
  elements.toggle.checked = enabled;
  elements.statusDot.classList.toggle("on", enabled);
  elements.trackingHint.textContent = enabled ? "Collecting tab data" : "Tracking paused";

  const tabs = Object.values(state.tabs || {}).filter((tab) => tab.domain !== "internal");
  const openTabs = tabs.filter((tab) => tab.open);
  const domains = Object.values(state.domains || {}).filter((domain) => domain.domain !== "internal");
  const totalActive = domains.reduce((sum, domain) => sum + (domain.activeMs || 0), 0);
  const top = topDomain(state);

  elements.openTabs.textContent = String(openTabs.length);
  elements.activeTime.textContent = formatDuration(totalActive);
  elements.topSite.textContent = top ? top.domain : "none";
  elements.topSite.title = top ? top.domain : "";
  elements.sites.textContent = String(domains.length);

  const cpuUsage = state.system && typeof state.system.cpuUsage === "number" ? state.system.cpuUsage : null;
  elements.cpuUsage.textContent = cpuUsage === null ? "n/a" : cpuUsage + "%";

  const memory = state.system && state.system.memory;
  if (memory && memory.capacity) {
    const used = memory.capacity - memory.availableCapacity;
    elements.memory.textContent = formatBytes(used) + " / " + formatBytes(memory.capacity);
  } else {
    elements.memory.textContent = "n/a";
  }

  elements.lastSync.textContent = state.updatedAt ? "Saved " + timeAgo(state.updatedAt) : "Local only";
}

async function refresh() {
  const response = await send("getState");
  if (response.ok) render(response.state);
}

elements.toggle.addEventListener("change", async () => {
  const enabled = elements.toggle.checked;
  const response = await send("setEnabled", { enabled });
  if (response.ok) render(response.state);
});

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
}

document.getElementById("openDashboard").addEventListener("click", openDashboard);
document.getElementById("openDashboardBig").addEventListener("click", openDashboard);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tracktab_state && changes.tracktab_state.newValue) {
    render(changes.tracktab_state.newValue);
  }
});

refresh();
