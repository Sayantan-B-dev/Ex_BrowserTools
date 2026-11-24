const el = (id) => document.getElementById(id);

let settings = null;
let page = null;
let history = [];
let busy = false;

const SUMMARIZE_PROMPT =
  "Summarize this page. Give me:\n" +
  "1. A 2-3 sentence TL;DR\n" +
  "2. 5-8 key bullet points\n" +
  "3. Any important numbers, dates, or action items";

function providerLabel() {
  if (!settings) return "";
  const name = settings.provider || "custom";
  return name.charAt(0).toUpperCase() + name.slice(1) + " · " + (settings.model || "no model");
}

function hasKey() {
  if (!settings) return false;
  const keys = settings.keys || {};
  if (settings.provider === "openrouter") {
    return (keys.openrouter || []).some(Boolean);
  }
  return Boolean(keys[settings.provider]);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  settings = { maxChars: 12000, provider: "adaption", ...(stored.settings || {}) };
  settings.keys = stored.settings && stored.settings.keys ? stored.settings.keys : {};
  el("status").textContent = providerLabel();
  el("status").classList.toggle("warn", !hasKey());
  if (!hasKey()) {
    el("status").textContent = providerLabel() + " — no API key (open Settings)";
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

function init() {
  el("summarize").addEventListener("click", () => send(SUMMARIZE_PROMPT));
  el("clear").addEventListener("click", clearChat);
  el("refresh").addEventListener("click", async () => {
    await refreshPage();
    await loadSettings();
  });
  el("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
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
