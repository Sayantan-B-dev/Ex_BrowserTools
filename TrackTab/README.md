# TrackTab

TrackTab is a local Chrome extension that monitors your open tabs and stores the data in a single JSON file that you control. It is part of the ReadAssistent workspace; see [the workspace README](../README.md) for the other extensions.

It tracks per tab uptime, active time, resource counts, page JS heap, network type, and storage usage. It also tracks per site totals, visit counts, recent sessions, and system wide CPU and memory.

## Install

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked and select the `TrackTab` folder.
4. Pin the extension to the toolbar.

## Use

- Click the TrackTab icon to see a quick summary and the tracking switch.
- Turn the switch off to pause collection. Existing data is kept.
- Click Dashboard to open the full view.

The dashboard has these sections:

- Summary cards for open tabs, sites, active time, uptime, system CPU, memory, JS heap, network, and cache.
- A donut chart of time by site.
- A bar chart of active time by tab.
- A tabs table with per tab resources, images, streams, cache, and actions.
- A sites table with totals and actions.
- Recent sessions.
- TrackTab own stats at the very bottom.

Active time only counts the tab you are actually watching. A tab counts as watched when it is the active tab, its window is focused, and the system is not idle.

## Database file

TrackTab saves a hot copy in `chrome.storage.local` and can mirror it to `C:\Users\Virus404\Documents\tracktab.txt` as the primary database.

Because Chrome extensions cannot silently write to an absolute path, you choose the file once:

1. Open the dashboard.
2. Click Link file.
3. Choose the Documents folder and name the file `tracktab.txt`.

After that, the file handle is stored in IndexedDB and the dashboard writes the JSON state to the file every 30 seconds and after changes.

Other database actions:

- Open file: pick an existing `tracktab.txt` or JSON file and merge it.
- Reload from file: read the linked file again and merge newer values.
- Save now: write the current state immediately.
- Unlink: forget the file handle. Browser storage keeps working.
- Export JSON: download a copy.
- Import JSON: merge a previously exported file.
- Clear all: delete all tracked data.

If Chrome asks for permission again, click Reconnect.

## Browser support

File sync uses the File System Access API, which Brave and some Chromium forks do not expose. The
dashboard checks for it at startup and switches to a browser storage mode instead of showing an
error:

- The Link file, Reconnect, Reload from file, and Unlink buttons are hidden.
- Open file becomes Load backup and opens the normal file picker to merge a saved copy.
- Save now becomes Download copy and downloads the current database from browser storage.
- The status line explains that auto sync to a file is unavailable.

Tracking, history, and the dashboard keep working in this mode. Back up with Download copy and
restore with Load backup, or use Export JSON and Import JSON. Chrome and other Chromium browsers
with the File System Access API keep the full linked-file behavior.

The file is plain JSON with a version, timestamps, settings, a `tabs` map, a `domains` map, a `sessions` array, system stats, and extension stats.

## Metric limits

Chrome does not expose full per tab process memory or per tab CPU to extensions on Windows. TrackTab reports what is available:

- Page JS heap via `performance.memory` when the page exposes it.
- Resource counts, transfer and decoded bytes via the Resource Timing API.
- Image and stream counts from resource entries and DOM queries.
- Network type via `navigator.connection`.
- Storage usage via `navigator.storage.estimate()`.
- Event loop lag as a light responsiveness proxy.
- System wide CPU and memory via `chrome.system.cpu` and `chrome.system.memory`.

Pages with restricted URLs, such as `chrome://` pages, cannot be scanned and are marked as restricted.

## Privacy

Everything stays on your device. TrackTab makes no network requests and sends no data anywhere.

## Low overhead

Updates are event driven. A 1 minute alarm advances uptime and active time. A 5 minute alarm scans page resources. Ticks use a 15 second timer while the service worker is awake. The dashboard refreshes its view every 15 seconds and writes the database file at most every 30 seconds.

## Files

- `manifest.json`: extension manifest.
- `background.js`: tracking state, alarms, metric collection, and message handling.
- `popup.html`, `popup.css`, `popup.js`: quick view and on/off switch.
- `dashboard.html`, `dashboard.css`, `dashboard.js`: full dashboard, file database sync, and the browser storage fallback.
- `utils.js`: shared formatting helpers.
