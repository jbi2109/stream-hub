# Stream Hub

A minimal desktop app that turns any set of streaming websites into a single, tidy
media library. Point it at the sites you use, and Stream Hub gives you one window with
**bookmarks, automatic watch-progress tracking, and built-in ad-blocking** on top of them.

It is a thin browser shell — an Electron [`<webview>`](https://www.electronjs.org/docs/latest/api/webview-tag)
wrapped in a small UI. It scrapes nothing, extracts no video, and bundles no content or
sources of its own. You add your own sites; the app just makes them nicer to use.

---

## Features

- **Browse home (TMDB)** — the app's own landing page: discover Movies, TV, and Anime
  from [TMDB](https://www.themoviedb.org/), search, and open a title's **native detail page**
  (overview, genres, rating, cast, seasons + episode picker with stills, in-app trailer,
  "where to watch"). Pick which **source** to play on (defaults to your last-used), and the
  **Watch** button loads that source's own embed player, deep-linked to the exact episode — with
  a top-bar switcher to swap sources mid-watch. A **Live TV** tab shows your live sources as
  tiles, or — for a **live catalog** source (a JSON API of live streams you add by URL) — a
  **searchable catalog** with a **category filter**, each stream clickable to embed. Plus a
  built-in **YouTube** tab. Needs a free TMDB API key.
- **Bring-your-own players & sources** — manage everything in one **Settings** list: add any
  embed player or site by name + URL, tag each as **Movies / TV Shows**, **Anime**, or **Live TV**,
  and pick a **default player**. Each entry has an optional, editable **embed pattern** (tokens
  `{origin} {type} {id} {season} {episode}`) controlling how Browse builds its watch link; movies
  auto-trim season/episode. Ships empty — you add your own.
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
- **Ad-blocking** — the [Ghostery](https://github.com/ghostery/adblocker) engine with full
  uBlock-style lists (network + cosmetic + scriptlets), cached locally and refreshed daily.
  Best-effort YouTube ad-blocking included (never as bulletproof as uBlock Origin in a real
  browser — YouTube actively fights blockers).
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

1. Paste a free **TMDB API key** into the Settings field (themoviedb.org → Settings → API →
   API Key v3) to power the Browse home.
2. Under **Settings**, click **+ Add player / source** — a short **step-by-step wizard** (Name →
   Type → URL → Pattern) walks you through it, with an example on hover over each box and a live
   preview of the watch link it builds. Pick a **default player** once you have a few.
3. **Browse** (the landing page) to discover Movies / TV / Anime and click a title; on the detail
   page choose a source and hit **Watch** (swap sources mid-watch from the top bar). The **Live TV**
   and **YouTube** tabs launch those directly.
4. Shows appear under **Continue Watching** automatically as you watch; hit **+ Watch Later**
   to bookmark. Click **📽 Library** to see your Continue Watching / Watch Later, filter by
   type, and per-card ✎ (note), ✕ (remove), or category dropdown.

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

Launches the real app under the Chrome DevTools Protocol and runs a 45-test end-to-end suite
covering navigation, popup rules, ad-blocking, login user-agent handling, cross-origin progress
reading, the TMDB browse home, the native detail page, per-source embed patterns, the source
picker/switcher, the add-player wizard, the tabbed library, categorisation, and persistence.

## Disclaimer

Stream Hub is a general-purpose web browser wrapper. It hosts, streams, indexes, and bundles
**no content and no sources** — it ships with an empty source list and only loads the websites
**you** choose to add. You are solely responsible for the sites you use and for accessing only
content you are legally entitled to. Respect copyright law and the terms of service of any site
you visit. The software is provided "as is", without warranty, under the MIT License.

## License

[MIT](LICENSE) © Joshua Irvine
