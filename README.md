# ReadAssistent workspace

A small workspace of local-first Chrome extensions. Each extension lives in its own folder and has
its own detailed README covering install steps, settings, usage, limits, and troubleshooting.

## Projects

| Project | Folder | What it does |
| --- | --- | --- |
| SummarizeBuddy | [`SummarizeBuddy/`](SummarizeBuddy/README.md) | Summarizes the page you are reading and lets you chat about it with your own AI provider key. |
| TrackTab | [`TrackTab/`](TrackTab/README.md) | Tracks what you do in the browser: per tab uptime, active time, resources, sites, sessions, and system stats. |

Use this file to find a project. Open the project's own README for full detail.

## Repository layout

```
ReadAssistent/
├── .env                  # your real keys (git-ignored, never commit)
├── README.md             # this workspace overview
├── List.md               # short project list
├── commit.js             # helper that replays the work as small commits
├── SummarizeBuddy/       # AI page summarizer side panel extension
│   ├── README.md         # detailed setup and usage guide
│   └── manifest.json ... # extension source
└── TrackTab/             # browser activity tracker and dashboard extension
    ├── README.md         # detailed setup and metric guide
    └── manifest.json ... # extension source
```

## Install an extension

Both extensions install the same way:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the extension folder (`SummarizeBuddy` or `TrackTab`).
3. Pin the extension to the toolbar.
4. Follow that folder's README to finish setup.

After editing extension files, reload the extension from `chrome://extensions`.

## Browser support

The extensions target Chromium browsers. Brave and other Chromium forks work, with one difference:
Brave does not expose the File System Access API, so TrackTab cannot auto-sync to a file there. It
falls back to browser storage with manual backup and restore. See
[`TrackTab/README.md`](TrackTab/README.md#browser-support).

## Security

- Real API keys are not stored in extension source. They are read from your `.env` at setup time and
  saved to `chrome.storage.local` in your browser profile.
- `.env` is listed in `.gitignore`; keep it out of version control and never paste real keys into
  shared files or screenshots.
- Requests go directly from your browser to the provider you configure. There is no intermediary
  server.
- TrackTab keeps all tracking data on your device and makes no network requests.
