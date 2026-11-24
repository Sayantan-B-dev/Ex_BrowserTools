const el = (id) => document.getElementById(id);

const DEFAULTS = {
  provider: "adaption",
  baseUrl: "https://api.prod.adaptionlabs.ai/api/v1",
  model: "gemma-4-31b-it",
  timeoutMs: 30000,
  maxChars: 12000,
  maxTokens: 1200,
  temperature: 0.3,
  keys: { adaption: "", openrouter: [], nvidia: "" }
};

const PROVIDER_DEFAULTS = {
  adaption: {
    baseUrl: "https://api.prod.adaptionlabs.ai/api/v1",
    model: "gemma-4-31b-it"
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemma-3-27b-it"
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3.5-bolt-e4b"
  },
  custom: { baseUrl: "", model: "" }
};

let loading = true;
let saveTimer = null;

function setStatus(text, kind) {
  const node = el("status");
  node.textContent = text;
  node.className = "status" + (kind ? " " + kind : "");
}

function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function collectOpenRouterKeys(env) {
  return Object.keys(env)
    .filter((key) => /^OPENROUTER_API_KEY(_\d+)?$/.test(key))
    .sort((a, b) => {
      const na = parseInt((a.match(/(\d+)$/) || [0, 0])[1], 10);
      const nb = parseInt((b.match(/(\d+)$/) || [0, 0])[1], 10);
      return na - nb;
    })
    .map((key) => env[key])
    .filter(Boolean);
}

function applyEnv(text) {
  const env = parseEnv(text);
  let count = 0;

  if (env.ADAPTION_API_KEY) {
    el("adaptionKey").value = env.ADAPTION_API_KEY;
    count++;
  }
  if (env.NVIDIA_API_KEY) {
    el("nvidiaKey").value = env.NVIDIA_API_KEY;
    count++;
  }
  const openrouterKeys = collectOpenRouterKeys(env);
  if (openrouterKeys.length) {
    el("openrouterKeys").value = openrouterKeys.join("\n");
    count++;
  }

  const provider = el("provider").value;
  if (provider === "adaption") {
    if (env.ADAPTION_BASE_URL) el("baseUrl").value = env.ADAPTION_BASE_URL;
    if (env.ADAPTION_MODEL) el("model").value = env.ADAPTION_MODEL;
  }
  if (provider === "nvidia" && env.NVIDIA_MODEL) {
    el("model").value = env.NVIDIA_MODEL;
  }
  if (env.AI_REQUEST_TIMEOUT_MS) {
    const timeout = parseInt(env.AI_REQUEST_TIMEOUT_MS, 10);
    if (timeout > 0) el("timeoutMs").value = String(timeout);
  }

  return { count, env };
}

function readForm() {
  const openrouter = el("openrouterKeys")
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    provider: el("provider").value,
    baseUrl: el("baseUrl").value.trim(),
    model: el("model").value.trim(),
    temperature: Number(el("temperature").value),
    maxTokens: Number(el("maxTokens").value),
    timeoutMs: Number(el("timeoutMs").value),
    maxChars: Number(el("maxChars").value),
    keys: {
      adaption: el("adaptionKey").value.trim(),
      nvidia: el("nvidiaKey").value.trim(),
      openrouter
    }
  };
}

async function save() {
  const settings = readForm();
  await chrome.storage.local.set({ settings });
  setStatus("Saved", "ok");
}

function scheduleSave() {
  if (loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save().catch((error) => setStatus(error.message || String(error), "error"));
  }, 400);
}

function fillForm(settings) {
  el("provider").value = settings.provider || DEFAULTS.provider;
  el("baseUrl").value = settings.baseUrl || "";
  el("model").value = settings.model || "";
  el("temperature").value = String(settings.temperature ?? DEFAULTS.temperature);
  el("maxTokens").value = String(settings.maxTokens ?? DEFAULTS.maxTokens);
  el("timeoutMs").value = String(settings.timeoutMs ?? DEFAULTS.timeoutMs);
  el("maxChars").value = String(settings.maxChars ?? DEFAULTS.maxChars);

  const keys = settings.keys || {};
  el("adaptionKey").value = keys.adaption || "";
  el("nvidiaKey").value = keys.nvidia || "";
  el("openrouterKeys").value = (keys.openrouter || []).join("\n");
}

async function load() {
  loading = true;
  const stored = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };
  settings.keys = { ...DEFAULTS.keys, ...((stored.settings && stored.settings.keys) || {}) };
  fillForm(settings);
  loading = false;
}

function useProviderDefaults() {
  const defaults = PROVIDER_DEFAULTS[el("provider").value];
  if (!defaults) return;
  el("baseUrl").value = defaults.baseUrl || "";
  el("model").value = defaults.model || "";
}

async function testConnection() {
  const button = el("test");
  button.disabled = true;
  setStatus("Testing…");
  try {
    await save();
    const response = await chrome.runtime.sendMessage({ type: "test" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Test failed.");
    }
    setStatus("Connection OK: " + response.content, "ok");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function reset() {
  const confirmed = confirm("Remove all saved settings and API keys?");
  if (!confirmed) return;
  await chrome.storage.local.remove("settings");
  await load();
  setStatus("Reset to defaults", "ok");
}

function init() {
  el("provider").addEventListener("change", () => {
    useProviderDefaults();
    scheduleSave();
  });

  document.querySelectorAll("input, select, textarea").forEach((node) => {
    node.addEventListener("input", scheduleSave);
    node.addEventListener("change", scheduleSave);
  });

  el("applyEnv").addEventListener("click", async () => {
    const text = el("envText").value.trim();
    if (!text) {
      setStatus("Paste your .env contents first.", "error");
      return;
    }
    const { count } = applyEnv(text);
    if (!count) {
      setStatus("No supported keys found in that text.", "error");
      return;
    }
    await save();
    el("envStatus").textContent = "Imported and saved.";
    setStatus("Imported .env and saved", "ok");
  });

  el("envFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    el("envText").value = text;
    const { count } = applyEnv(text);
    if (!count) {
      setStatus("No supported keys found in " + file.name, "error");
      return;
    }
    await save();
    el("envStatus").textContent = "Imported from " + file.name + " and saved.";
    setStatus("Imported .env and saved", "ok");
  });

  el("save").addEventListener("click", () => {
    save().catch((error) => setStatus(error.message || String(error), "error"));
  });
  el("test").addEventListener("click", testConnection);
  el("reset").addEventListener("click", reset);

  load().catch((error) => setStatus(error.message || String(error), "error"));
}

init();
