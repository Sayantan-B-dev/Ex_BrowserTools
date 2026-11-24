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

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = { ...DEFAULTS, ...(settings || {}) };
  merged.keys = { ...DEFAULTS.keys, ...((settings && settings.keys) || {}) };
  return merged;
}

function pickKey(settings) {
  const provider = settings.provider;
  if (provider === "openrouter") {
    const keys = (settings.keys.openrouter || []).filter(Boolean);
    if (!keys.length) return "";
    return keys[Math.floor(Math.random() * keys.length)];
  }
  return String(settings.keys[provider] || "").trim();
}

function endpoint(base) {
  const clean = String(base || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(clean)) return clean;
  return clean + "/chat/completions";
}

function extractContent(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part && part.text ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

async function callChat(messages) {
  const settings = await getSettings();
  const key = pickKey(settings);
  if (!key) {
    throw new Error("No API key configured. Open Settings and paste your .env or key.");
  }
  if (!settings.baseUrl) throw new Error("No base URL configured.");
  if (!settings.model) throw new Error("No model configured.");

  const url = endpoint(settings.baseUrl);
  const controller = new AbortController();
  const timeout = Number(settings.timeoutMs) || DEFAULTS.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    };
    if (settings.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://summarizebuddy.local";
      headers["X-Title"] = "SummarizeBuddy";
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: Number(settings.temperature) || 0,
        max_tokens: Number(settings.maxTokens) || DEFAULTS.maxTokens,
        stream: false
      })
    });

    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message =
        (data && data.error && data.error.message) ||
        (data && data.message) ||
        raw.slice(0, 300) ||
        "HTTP " + response.status;
      throw new Error(response.status + ": " + message);
    }

    const content = extractContent(data);
    if (!content) throw new Error("The provider returned an empty response.");
    return content;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Request timed out after " + timeout + " ms.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "chat") {
    callChat(message.messages || [])
      .then((content) => sendResponse({ ok: true, content }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "test") {
    callChat([{ role: "user", content: "Reply with exactly: OK" }])
      .then((content) => sendResponse({ ok: true, content }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});
