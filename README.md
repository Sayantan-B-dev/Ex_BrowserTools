# ReadAssistent workspace

A small workspace containing **SummarizeBuddy**, a Chrome extension that summarizes the page you
are reading and lets you chat about it using your own AI provider API key.

## Contents

```
ReadAssistent/
├── .env                  # your real keys (git-ignored, never commit)
├── README.md             # this file
└── SummarizeBuddy/       # the Chrome extension (load this folder unpacked)
    ├── .env.example      # template showing the supported variables
    ├── manifest.json
    ├── background.js
    ├── settings-core.js
    ├── sidepanel.html / .css / .js
    ├── options.html / .css / .js
    └── README.md         # detailed setup and usage guide
```

## Quick start

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `SummarizeBuddy` folder.
3. Open the extension's **Settings**, then either paste your `.env` contents or import the file.
4. Click the SummarizeBuddy toolbar icon to open the side panel on any article.
5. Press **Summarize page**, or ask a question about the page.

Full instructions live in [`SummarizeBuddy/README.md`](SummarizeBuddy/README.md).

## Supported providers

The extension speaks the OpenAI-compatible chat completions API, so it works with:

- **Adaption** (`ADAPTION_API_KEY`, `ADAPTION_BASE_URL`, `ADAPTION_MODEL`)
- **OpenRouter** (`OPENROUTER_API_KEY_1..N`, rotated per request)
- **NVIDIA NIM** (`NVIDIA_API_KEY`, `NVIDIA_MODEL`)
- **Any custom OpenAI-compatible endpoint** (set base URL and model in Settings)

## Security

- Real API keys are **not** stored in the extension source. They are read from your `.env` at setup
  time and saved to `chrome.storage.local` in your browser profile.
- `.env` is listed in `.gitignore`; keep it out of version control and never paste real keys into
  shared files or screenshots.
- Requests go directly from your browser to the provider you configure. There is no intermediary
  server.
