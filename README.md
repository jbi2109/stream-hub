# Stream Hub

A minimal desktop app that turns any set of streaming websites into a single, tidy
media library. Point it at the sites you use, and Stream Hub gives you one window with
**bookmarks, automatic watch-progress tracking, and built-in ad-blocking** on top of them.

It is a thin browser shell — an Electron [`<webview>`](https://www.electronjs.org/docs/latest/api/webview-tag)
wrapped in a small UI. It scrapes nothing, extracts no video, and bundles no content or
sources of its own. You add your own sites; the app just makes them nicer to use.

---

## Features

- **Bring-your-own sources** — add any streaming site by name + URL. Tag each as
  **Movies / TV Shows** or **Live TV**; the sidebar groups them accordingly.
- **Continue Watching (automatic)** — as you browse a show, the app reads the title,
  poster, and season/episode from the page and builds a poster-card entry. No "save" button.
- **Real playback progress** — the main process reads the video's position from inside the
  (cross-origin) player frame and draws a progress bar. Best-effort: some players expose it,
  some don't; season/episode is always captured.
- **Watch Later** — one button adds the current title; it then auto-advances its episode as
  you keep watching, and deep-links back to the latest one.
- **Tabs & categories** — a tabbed home (Continue Watching / Watch Later), each filterable by
  **All / Movies / TV Shows** (Watch Later also has **Live TV**). A per-card dropdown lets you
  fix a wrong auto-classification. Live TV is never added to Continue Watching.
- **Ad-blocking** — network-level blocking via the [Ghostery](https://github.com/ghostery/adblocker)
  engine + EasyList, cached locally after first launch.
- **Popup blocking** — ad pop-unders are denied; same-site `_blank` links open in place;
  real login pop-ups (Google, Apple, Discord, GitHub, Microsoft, Facebook) are allowed so you
  can sign into sites that offer accounts (Google logins get a Firefox user-agent so its
  "insecure browser" check passes).
- **Persistent** — sources, library, and site logins all persist across restarts.

## Requirements

- [Node.js](https://nodejs.org/) 18+ (developed on v24)
- Windows / macOS / Linux (Electron)

## Install & run

```bash
git clone https://github.com/jbi2109/stream-hub.git
cd stream-hub
npm install
npm start
```

On Windows you can also double-click **`launch.bat`**.

## Usage

1. Click **+ Add source**, enter a name and URL, and pick a category (Movies/TV Shows or Live TV).
2. Click a source in the sidebar to open it in the built-in browser.
3. Browse and play as normal. Shows appear under **Continue Watching** automatically; hit
   **+ Watch Later** to bookmark something for later.
4. Click **🏠 Home** to return to your library. Use the tabs to switch views and the pills to
   filter by type. Each card has ✎ (note), ✕ (remove), and a category dropdown.

## How it works

| File | Responsibility |
|------|----------------|
| `main.js` | Electron main process: window, popup policy, ad-blocker, reads playback position from the player frame, per-host user-agent tweaks. |
| `preload.js` | Tiny `contextBridge` that forwards playback progress to the UI. |
| `index.html` | App layout (sidebar, top bar, webview, home container). |
| `renderer.js` | All UI logic: sources, capture/classification, tabs, cards, storage. |
| `style.css` | Styling. |
| `test/e2e.js` | End-to-end test suite. |

State is stored in the browser's `localStorage` (sources, `continue`, `watchlater`). There is
no backend and no telemetry.

## Testing

```bash
npm test
```

Launches the real app under the Chrome DevTools Protocol and runs an end-to-end suite covering
navigation, popup rules, ad-blocking, login user-agent handling, cross-origin progress reading,
the tabbed library, categorisation, and persistence.

## Disclaimer

Stream Hub is a general-purpose web browser wrapper. It hosts, streams, indexes, and bundles
**no content and no sources** — it ships with an empty source list and only loads the websites
**you** choose to add. You are solely responsible for the sites you use and for accessing only
content you are legally entitled to. Respect copyright law and the terms of service of any site
you visit. The software is provided "as is", without warranty, under the MIT License.

## License

[MIT](LICENSE) © Joshua Irvine
