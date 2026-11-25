const el = (id) => document.getElementById(id);

let settings = null;
let page = null;
let history = [];
let busy = false;
let toastTimer = null;

const SUMMARIZE_PROMPT =
  "Summarize this page. Give me:\n" +
  "1. A 2-3 sentence TL;DR\n" +
  "2. 5-8 key bullet points\n" +
  "3. Any important numbers, dates, or action items";

const SUMMARIZE_CHAT_PROMPT =
  "Summarize our conversation so far about this page. " +
  "Give a short TL;DR and the key points we have covered.";

function providerLabel() {
  return SB.providerLabel(settings);
}

function hasKey() {
  return SB.hasKey(settings);
}

function showToast(text, kind) {
  const node = el("toast");
  node.textContent = text;
  node.className = "toast" + (kind ? " " + kind : "");
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

async function loadSettings() {
  settings = await SB.loadSettings();
  el("status").textContent = providerLabel();
  el("status").classList.toggle("warn", !hasKey());
  if (!hasKey()) {
    el("status").textContent = providerLabel() + " - no API key (open Settings)";
  }
}

async function readPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (!clone) return { title: document.title, url: location.href, text: "" };
      clone
        .querySelectorAll("script,style,noscript,svg,canvas,iframe,template")
        .forEach((node) => node.remove());
      let text = clone.innerText || clone.textContent || "";
      text = text
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      return { title: document.title || location.hostname, url: location.href, text };
    }
  });

  const data = injection && injection.result;
  if (!data || !data.text) throw new Error("Could not read any text from this page.");
  return data;
}

async function refreshPage() {
  try {
    await loadSettings();
    const result = await readPage();
    const max = Number(settings.maxChars) || 12000;
    const truncated = result.text.length > max;
    page = { ...result, text: result.text.slice(0, max) };

    el("pageTitle").textContent = result.title || result.url;
    let host = "";
    try {
      host = new URL(result.url).hostname;
    } catch {
      host = result.url;
    }
    el("pageMeta").textContent =
      result.text.length.toLocaleString() + " chars" +
      (truncated ? " (truncated)" : "") +
      (host ? " · " + host : "");
  } catch (error) {
    page = null;
    el("pageTitle").textContent = "Could not read this page";
    el("pageMeta").textContent = error.message || String(error);
    el("pageMeta").title = error.message || "";
  }
}

function systemPrompt() {
  if (!page) {
    return (
      "You are SummarizeBuddy, a concise reading assistant. " +
      "No page content is available right now, so answer generally and say that you could not read the page."
    );
  }
  return (
    "You are SummarizeBuddy, a concise and accurate reading assistant. " +
    "The user is viewing the web page below. Use it as your main source of truth.\n\n" +
    "Title: " + page.title + "\n" +
    "URL: " + page.url + "\n" +
    "Content:\n\"\"\"\n" + page.text + "\n\"\"\"\n\n" +
    "Answer questions about this page in a clear, compact way. " +
    "If the answer is not in the page, say so and label any outside knowledge as general knowledge. " +
    "Format the answer in Markdown: use short paragraphs, bullet lists, bold for key terms, and fenced code blocks for code."
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text) {
  const codes = [];
  let result = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    codes.push(code);
    return "\u0000C" + (codes.length - 1) + "\u0000";
  });

  result = result
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
    );

  result = result.replace(/\u0000C(\d+)\u0000/g, (_match, index) => {
    return "<code>" + codes[Number(index)] + "</code>";
  });
  return result;
}

function renderMarkdown(source) {
  let text = escapeHtml(String(source || "")).replace(/\r\n/g, "\n");
  const blocks = [];

  text = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    blocks.push({ lang, code });
    return "\u0000B" + (blocks.length - 1) + "\u0000";
  });

  const lines = text.split("\n");
  const out = [];
  let listType = null;
  let listItems = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push("<p>" + paragraph.join("<br>") + "</p>");
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listType) {
      const items = listItems.map((item) => "<li>" + renderInline(item) + "</li>").join("");
      out.push("<" + listType + ">" + items + "</" + listType + ">");
      listType = null;
      listItems = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const codeMatch = /^\u0000B(\d+)\u0000$/.exec(trimmed);
    if (codeMatch) {
      flushParagraph();
      flushList();
      const block = blocks[Number(codeMatch[1])];
      const label = block.lang ? '<span class="code-lang">' + block.lang + "</span>" : "";
      out.push(
        '<div class="code-block">' +
          label +
          "<pre><code>" +
          block.code.replace(/\n$/, "") +
          "</code></pre></div>"
      );
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
      continue;
    }

    if (/^([-*_]\s*){3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      out.push("<hr>");
      continue;
    }

    const listItem = /^([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (listItem) {
      flushParagraph();
      const type = /^\d/.test(listItem[1]) ? "ol" : "ul";
      if (listType !== type) {
        flushList();
        listType = type;
      }
      listItems.push(listItem[2]);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      flushList();
      out.push("<blockquote>" + renderInline(trimmed.replace(/^>\s?/, "")) + "</blockquote>");
      continue;
    }

    flushList();
    paragraph.push(renderInline(trimmed));
  }

  flushParagraph();
  flushList();

  return out.join("").replace(/\u0000B(\d+)\u0000/g, (_match, index) => {
    const block = blocks[Number(index)];
    return "<pre><code>" + block.code.replace(/\n$/, "") + "</code></pre>";
  });
}

function removeEmptyState() {
  const empty = el("chat").querySelector(".empty");
  if (empty) empty.remove();
}

function addMessage(role, text) {
  removeEmptyState();
  const node = document.createElement("div");
  node.className = "msg " + role;
  if (role === "assistant") {
    node.classList.add("md");
    node.innerHTML = renderMarkdown(text);
  } else {
    node.textContent = text;
  }
  el("chat").appendChild(node);
  el("chat").scrollTop = el("chat").scrollHeight;
  return node;
}

function addPending() {
  const node = addMessage("pending", "Thinking");
  return node;
}

function setBusy(value) {
  busy = value;
  el("send").disabled = value;
  el("summarize").disabled = value;
}

async function send(text) {
  if (busy) return;
  const content = text.trim();
  if (!content) return;

  if (!page) await refreshPage();
  if (!settings) await loadSettings();

  addMessage("user", content);
  history.push({ role: "user", content });
  setBusy(true);
  const pending = addPending();

  try {
    const messages = [{ role: "system", content: systemPrompt() }, ...history];
    const response = await chrome.runtime.sendMessage({ type: "chat", messages });
    pending.remove();
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Request failed.");
    }
    addMessage("assistant", response.content);
    history.push({ role: "assistant", content: response.content });
  } catch (error) {
    pending.remove();
    addMessage("error", error.message || String(error));
  } finally {
    setBusy(false);
    el("chat").scrollTop = el("chat").scrollHeight;
  }
}

function summarizeChat() {
  if (!history.length) {
    showToast("No chat to summarize yet.");
    return;
  }
  send(SUMMARIZE_CHAT_PROMPT);
}

function downloadPdf() {
  showToast("PDF export is not available yet.");
}

function saveCurrentChat() {
  showToast("Local saving is not available yet.");
}

function showEmpty() {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent =
    "Open any article, then click “Summarize page” or ask a question about it.";
  el("chat").appendChild(node);
}

function clearChat() {
  history = [];
  el("chat").innerHTML = "";
  showEmpty();
}

function autoGrow() {
  const input = el("input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}

function openOverlay(id) {
  el(id).hidden = false;
}

function closeOverlay(id) {
  el(id).hidden = true;
}

function setSettingsStatus(text, kind) {
  const node = el("settingsStatus");
  node.textContent = text;
  node.className = "status" + (kind ? " " + kind : "");
}

function fillSettingsForm() {
  if (!settings) return;
  el("provider").value = settings.provider || SB.DEFAULTS.provider;
  el("baseUrl").value = settings.baseUrl || "";
  el("model").value = settings.model || "";
  el("temperature").value = String(settings.temperature ?? SB.DEFAULTS.temperature);
  el("maxTokens").value = String(settings.maxTokens ?? SB.DEFAULTS.maxTokens);
  el("timeoutMs").value = String(settings.timeoutMs ?? SB.DEFAULTS.timeoutMs);
  el("maxChars").value = String(settings.maxChars ?? SB.DEFAULTS.maxChars);
  const keys = settings.keys || {};
  el("adaptionKey").value = keys.adaption || "";
  el("nvidiaKey").value = keys.nvidia || "";
  el("openrouterKeys").value = (keys.openrouter || []).join("\n");
}

function readSettingsForm() {
  const openrouter = el("openrouterKeys")
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    ...(settings || {}),
    provider: el("provider").value,
    baseUrl: el("baseUrl").value.trim(),
    model: el("model").value.trim(),
    temperature: Number(el("temperature").value),
    maxTokens: Number(el("maxTokens").value),
    timeoutMs: Number(el("timeoutMs").value),
    maxChars: Number(el("maxChars").value),
    keys: {
      ...((settings && settings.keys) || {}),
      adaption: el("adaptionKey").value.trim(),
      nvidia: el("nvidiaKey").value.trim(),
      openrouter
    }
  };
}

async function saveSettingsForm(notify) {
  if (!settings) settings = await SB.loadSettings();
  const next = readSettingsForm();
  await SB.saveSettings(next);
  settings = next;
  await loadSettings();
  if (notify) {
    setSettingsStatus("Saved", "ok");
    showToast("Settings saved", "ok");
  }
}

function useProviderDefaults() {
  const defaults = SB.PROVIDER_DEFAULTS[el("provider").value];
  if (!defaults) return;
  el("baseUrl").value = defaults.baseUrl || "";
  el("model").value = defaults.model || "";
}

function applyEnvText(text) {
  const env = SB.parseEnv(text);
  let count = 0;

  if (env.ADAPTION_API_KEY) {
    el("adaptionKey").value = env.ADAPTION_API_KEY;
    count++;
  }
  if (env.NVIDIA_API_KEY) {
    el("nvidiaKey").value = env.NVIDIA_API_KEY;
    count++;
  }
  const openrouterKeys = SB.collectOpenRouterKeys(env);
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

  return count;
}

async function testConnection() {
  const button = el("testConnection");
  button.disabled = true;
  setSettingsStatus("Testing…");
  try {
    await saveSettingsForm(false);
    const response = await chrome.runtime.sendMessage({ type: "test" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Test failed.");
    }
    setSettingsStatus("OK: " + response.content, "ok");
  } catch (error) {
    setSettingsStatus(error.message || String(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function resetSettings() {
  const confirmed = confirm("Remove all saved settings and API keys?");
  if (!confirmed) return;
  await chrome.storage.local.remove("settings");
  settings = await SB.loadSettings();
  fillSettingsForm();
  await loadSettings();
  setSettingsStatus("Reset to defaults", "ok");
}

async function openSettings() {
  if (!settings) await loadSettings();
  fillSettingsForm();
  setSettingsStatus("");
  closeOverlay("menuOverlay");
  openOverlay("settingsModal");
}

function init() {
  el("summarize").addEventListener("click", () => send(SUMMARIZE_PROMPT));
  el("summarizeChat").addEventListener("click", summarizeChat);
  el("clear").addEventListener("click", clearChat);
  el("downloadPdf").addEventListener("click", downloadPdf);
  el("saveChat").addEventListener("click", saveCurrentChat);
  el("refresh").addEventListener("click", async () => {
    await refreshPage();
    await loadSettings();
  });
  el("settings").addEventListener("click", openSettings);
  el("menuBtn").addEventListener("click", () => openOverlay("menuOverlay"));
  el("closeMenu").addEventListener("click", () => closeOverlay("menuOverlay"));
  el("menuSettings").addEventListener("click", openSettings);
  el("menuChats").addEventListener("click", () => {
    closeOverlay("menuOverlay");
    showToast("All chats is not available yet.");
  });
  el("closeSettings").addEventListener("click", () => closeOverlay("settingsModal"));
  el("provider").addEventListener("change", useProviderDefaults);
  el("saveSettings").addEventListener("click", () => {
    saveSettingsForm(true).catch((error) => setSettingsStatus(error.message || String(error), "error"));
  });
  el("testConnection").addEventListener("click", testConnection);
  el("resetSettings").addEventListener("click", resetSettings);
  el("applyEnv").addEventListener("click", async () => {
    const text = el("envText").value.trim();
    if (!text) {
      setSettingsStatus("Paste your .env contents first.", "error");
      return;
    }
    const count = applyEnvText(text);
    if (!count) {
      setSettingsStatus("No supported keys found in that text.", "error");
      return;
    }
    await saveSettingsForm(false);
    el("envStatus").textContent = "Imported and saved.";
    setSettingsStatus("Imported .env and saved", "ok");
  });
  el("envFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    el("envText").value = text;
    const count = applyEnvText(text);
    if (!count) {
      setSettingsStatus("No supported keys found in " + file.name, "error");
      return;
    }
    await saveSettingsForm(false);
    el("envStatus").textContent = "Imported from " + file.name + " and saved.";
    setSettingsStatus("Imported .env and saved", "ok");
  });
  el("menuOverlay").addEventListener("click", (event) => {
    if (event.target === el("menuOverlay")) closeOverlay("menuOverlay");
  });
  el("settingsModal").addEventListener("click", (event) => {
    if (event.target === el("settingsModal")) closeOverlay("settingsModal");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeOverlay("menuOverlay");
      closeOverlay("settingsModal");
    }
  });
  el("send").addEventListener("click", () => {
    const input = el("input");
    const value = input.value;
    input.value = "";
    autoGrow();
    send(value);
  });
  el("input").addEventListener("input", autoGrow);
  el("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      el("send").click();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) loadSettings();
  });

  showEmpty();
  loadSettings().then(refreshPage);
  el("input").focus();
}

init();
