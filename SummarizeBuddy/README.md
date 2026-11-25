# SummarizeBuddy

A Chrome side-panel assistant that reads the page you are on, summarizes it, and answers follow-up
questions about it. It is provider-agnostic and uses your own API key.

## Features

- One-click **Summarize page** with a TL;DR, key bullet points, and action items.
- **Summarize chat** condenses the current conversation.
- Chat about the current page. Memory is page-scoped and resets when the page changes.
- Rendered Markdown replies: headings, lists, bold/italic, links, quotes, inline and fenced code.
- Multiple providers: Adaption, OpenRouter, NVIDIA NIM, or any OpenAI-compatible endpoint.
- Import your existing `.env` in Settings. OpenRouter keys rotate per request.
- Floating Settings popup inside the side panel, with a hamburger menu for Settings and All chats.
- Six themes: Dark, Light, Midnight, Forest, Solarized, Rose.
- Save chats locally, with an optional auto save toggle. Browse saved chats in All chats by domain, link, and time created.
- Download the current chat as a PDF through the print dialog.
- Export and import all non-secret data (theme, preferences, saved chats) as `MasterMetadata.json`.
- Auto refresh when the active tab changes or navigates. The manual Reload button is still available.
- Keys stay in `chrome.storage.local`; nothing is hardcoded in the source.

## Requirements

- Google Chrome **114 or newer** (side panel support).
- An API key for at least one supported provider.
- Access to the page you want to summarize (regular `http(s)` pages; browser-internal pages are
  blocked by Chrome).

## Installation

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `SummarizeBuddy` folder (the one containing
   `manifest.json`).
4. Pin **SummarizeBuddy** to the toolbar if you like.

After changing any extension file, return to `chrome://extensions` and click the reload icon on the
SummarizeBuddy card.

## Configuration

Open the floating Settings popup from either place:

- The **Settings** button in the side panel header.
- The hamburger menu in the header, then **Settings**.

The separate options page still exists as a fallback under
`chrome://extensions` → SummarizeBuddy → **Details** → **Extension options**.

### Option A: Import your `.env` (recommended)

1. In Settings, scroll to **Import .env**.
2. Either choose your `.env` file with the file picker, or paste its contents into the text area.
3. Click **Apply pasted .env**.

Settings are saved automatically. The importer understands these variables:

| Variable | Used for |
| --- | --- |
| `ADAPTION_API_KEY` | Adaption API key |
| `ADAPTION_BASE_URL` | Adaption base URL (default `https://api.prod.adaptionlabs.ai/api/v1`) |
| `ADAPTION_MODEL` | Adaption model name |
| `OPENROUTER_API_KEY_1`, `_2`, `_3`, ... | OpenRouter keys, one per line, rotated per request |
| `NVIDIA_API_KEY` | NVIDIA NIM API key |
| `NVIDIA_MODEL` | NVIDIA model name |
| `AI_REQUEST_TIMEOUT_MS` | Request timeout in milliseconds |

Anything else in the file is ignored. The real keys are only written to your browser profile.

### Option B: Enter values manually

1. Pick a **Provider**. Choosing one fills in that provider's default base URL and model.
2. Paste the matching key into the **API keys** section.
3. Adjust any of the optional settings below.
4. Click **Save** (or just keep editing, changes auto-save).

### Provider defaults

| Provider | Base URL | Default model |
| --- | --- | --- |
| Adaption | `https://api.prod.adaptionlabs.ai/api/v1` | `gemma-4-31b-it` |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemma-3-27b-it` (placeholder, change to a model your key can use) |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3.5-bolt-e4b` |
| Custom | whatever you enter | whatever you enter |

The client appends `/chat/completions` to the base URL unless you already included it, so a base URL
like `https://example.com/v1` becomes `https://example.com/v1/chat/completions`.

### Optional settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Temperature | `0.3` | Lower is more focused; higher is more creative. |
| Max output tokens | `1200` | Upper bound on the reply length. |
| Request timeout (ms) | `30000` | How long to wait before aborting a request. |
| Max page characters | `12000` | Page text beyond this is truncated before sending. |

Use **Test connection** to send a tiny "Reply with exactly: OK" request with the current settings.
**Reset** clears all saved settings and keys from the browser profile.

## Usage

1. Navigate to an article, documentation page, or any readable page.
2. Click the SummarizeBuddy toolbar icon. The side panel opens and reads the page.
3. Use the bottom rows:
   - Row 1: type a question in the chat bubble and press **Send** (or **Enter**).
   - Row 2: **Summarize page** or **Summarize chat**.
   - Row 3: **Clear**, **Download PDF**, or **Save locally**.
4. Open the hamburger menu for **Settings** and **All chats**.
5. The page info and provider status sit directly above the controls.

The chat is page-scoped. When the active tab changes, navigates, or reloads, the panel
automatically re-reads the page and starts a fresh conversation. **Reload** still re-reads the
current tab manually.

Settings include themes, auto save, and export/import of `MasterMetadata.json`. All chats are stored
in `chrome.storage.local` and can be opened or deleted from **All chats**.

## How it works

```
Toolbar click
   │
   ▼
sidepanel.html/js ── chrome.scripting ──▶ page text (title, URL, visible text)
   │
   │ chrome.runtime.sendMessage({type:"chat"})
   ▼
background.js ── fetch ──▶ provider /chat/completions ──▶ Markdown reply
   │
   ▼
sidepanel.js ── markdown renderer ──▶ styled chat bubble
```

- **Page extraction** clones the DOM, strips scripts/styles/navigation-less elements, and keeps the
  visible text. Content is truncated to `maxChars`.
- **Prompting** sends a system message containing the page title, URL, and text, followed by the
  conversation history.
- **Networking** happens in the service worker (`background.js`) with your host permissions, so
  cross-origin provider calls work without CORS issues.
- **Key rotation** picks a random OpenRouter key per request when several are configured.

## File map

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 declaration, permissions, side panel, options page |
| `background.js` | Provider selection, key rotation, request timeout, API calls |
| `settings-core.js` | Shared defaults, provider presets, `.env` parsing, load/save helpers |
| `sidepanel.html/.css/.js` | Chat UI, page reading, themes, settings popup, All chats, PDF and backup |
| `options.html/.css/.js` | Fallback settings page, `.env` import/parsing, connection test |
| `.env.example` | Placeholder template for the supported environment variables |

## Privacy and security

- Your keys are stored unencrypted in `chrome.storage.local`, scoped to this extension in this
  browser profile. Anyone with access to your profile can read them, so protect your machine and
  profile.
- Page text and your questions are sent only to the provider you configured. No third-party relay
  is involved.
- Do not commit a filled-in `.env` file, and do not share an extension folder that has keys baked
  into it. This project keeps keys out of the source for that reason.
- The renderer escapes all model output before formatting it, which prevents injected HTML from
  executing in the side panel.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| "No API key configured" | Open Settings and import `.env` or paste a key for the selected provider. |
| `401` / `403` | Key is wrong, expired, or lacks access to the selected model. |
| `404` or "model not found" | Model name is wrong for that provider. Check the provider's model list. |
| Request timed out | Raise **Request timeout (ms)**, or the provider is slow/unreachable. |
| "Could not read this page" | The page is a `chrome://`, Web Store, PDF viewer, or otherwise restricted page. Try a normal article tab. |
| Empty or very short summary | The page may be JavaScript-rendered or mostly canvas. Reload the page, then press **Reload** in the panel. |
| OpenRouter rejects the model | Replace the default placeholder model with one available to your key. |
| Changes not applied | Reload the extension from `chrome://extensions`, then reopen the side panel. |

## Limitations

- Text-only: images, charts, and scanned PDFs are not interpreted.
- Long pages are truncated at `maxChars`; raise it if your model has a large context window.
- Responses are not streamed; the reply appears when the full response arrives.
- One page context at a time. The conversation resets when the page changes.
- PDF export opens the print dialog. Choose **Save as PDF** there to download the file.
- The bot icon uses the Material Symbols font from Google Fonts. It may not render while offline.
