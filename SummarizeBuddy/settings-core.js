(function () {
  const DEFAULTS = {
    provider: "adaption",
    baseUrl: "https://api.prod.adaptionlabs.ai/api/v1",
    model: "gemma-4-31b-it",
    timeoutMs: 30000,
    maxChars: 12000,
    maxTokens: 1200,
    temperature: 0.3,
    theme: "dark",
    autoSave: false,
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

  function mergeSettings(stored) {
    const settings = { ...DEFAULTS, ...(stored || {}) };
    settings.keys = { ...DEFAULTS.keys, ...((stored && stored.keys) || {}) };
    return settings;
  }

  async function loadSettings() {
    const { settings } = await chrome.storage.local.get("settings");
    return mergeSettings(settings);
  }

  async function saveSettings(settings) {
    await chrome.storage.local.set({ settings });
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

  function providerLabel(settings) {
    if (!settings) return "";
    const name = settings.provider || "custom";
    return name.charAt(0).toUpperCase() + name.slice(1) + " · " + (settings.model || "no model");
  }

  function hasKey(settings) {
    if (!settings) return false;
    const keys = settings.keys || {};
    if (settings.provider === "openrouter") {
      return (keys.openrouter || []).some(Boolean);
    }
    return Boolean(keys[settings.provider]);
  }

  window.SB = {
    DEFAULTS,
    PROVIDER_DEFAULTS,
    mergeSettings,
    loadSettings,
    saveSettings,
    parseEnv,
    collectOpenRouterKeys,
    providerLabel,
    hasKey
  };
})();
