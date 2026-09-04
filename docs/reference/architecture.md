# Architecture

Electron 43 desktop app. One `BrowserWindow` (renderer, `contextIsolation: true`, CSP `default-src 'self'`) hosting one reused `<webview id="webview" allowpopups>` that loads user-added sites. No framework, no bundler, no runtime deps beyond `@ghostery/adblocker-electron` and `electron-updater`.

## Hard constraints (never break)

1. Repo and binary stay **provider-neutral**: zero committed site names or URLs, in code and in test fixtures.
2. **No stream extraction** — only a site's own published embed URL is loaded, full-frame in the webview.
3. Classic `<script>` files sharing one global scope; CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:`. No inline scripts (theme.js is external for that reason).
4. No new runtime dependencies, no new binary assets.
5. Minimal diffs; every behaviour ships with a test that fails when the change is reverted.

## Renderer files and load order (index.html)

`theme.js` (in `<head>`, pre-paint theme) → `core.js` → `icons.js` → `rail.js` → `media.js` → `sources.js` → `browse.js` → `live.js` → `detail.js` → `library.js` → `dashboard.js` → `wizard.js` → `settings.js` → `keyboard.js` → `input.js` → `app.js` (bootstrap, last).

| File | Owns |
|------|------|
| core.js | `$`, `mk`, `load/store` (localStorage JSON), shared state (`sources`, `cont`, `later`, `tmdbKey`, `playing`, `intendedMedia`, `lastPlayed`, `openedFrom`), `toast`, `hideAll`/`open`/`revealWebview`/`resumeLast`, the `show*` view switchers, a boot migration purging live/YouTube entries from Continue. |
| app.js | Event wiring for rail/topbar, update banner, blocked-nav toast, settings export/import, bootstrap (`pushMain`, `rekeyLibrary`, landing view, What's New). |
| browse.js | `tmdbGet` cache, TMDB browse (tabs, search, filters, pager), `posterCard`, hover preview. |
| dashboard.js | Rail registry `DASH_RAILS`, hero carousel, resume cards, onboarding card, lazy fill. |
| detail.js | Title detail page, person page, lightbox, `addLater`. |
| live.js | Live-catalog fetch/parse/group, source picker page, Live tab, catalog cache. |
| library.js | Continue / Watch Later grid cards, `openLibraryItem`, note edit, `healLibrary`. |
| media.js | `mediaKey`/`tmdbIdOf`/`parseSeasonEpisode`, capture pipeline, progress handler, auto-next. |
| sources.js | Settings source list, `buildSource`/`addSource`/`buildUrl`, `openOn`, topbar switchers. |
| settings.js | `SETTINGS_DEFAULTS`, migrations, `mainSubset`/`pushMain`, the tabbed Settings screen. |
| wizard.js | Add/edit source modal wizard. |
| keyboard.js | Key dispatcher, Esc chain, grid navigation, palette, help, What's New modals. |
| input.js | Input-mode body class, touch long-press, gamepad polling. |
| rail.js | `wireRail` (chevrons + edge fades). |
| icons.js | Inline SVG `icon(name)` + chrome icon application. |

## Views

`#dashboard`, `#home` (library), `#browse`, `#detail` (also hosts the live source picker), `#person`, `#settings`, and the `webview`. `hideAll()` is the single choke point: hides every view, clears `playing`/`intendedMedia`/`currentLiveMatch`, cancels a pending capture, hides topbar switchers, drops the hover preview. `open(url, track)` records the launching view in `openedFrom` (Esc returns there) and, when `track`, the ⏯ Resume target `lastPlayed`.

## Main ↔ renderer bridge

`preload.js` exposes `window.sh` (see main-process.md). The guest `<webview>` gets `webview-preload.js` with `contextIsolation: false` (runs in the page's world) — see adblock-youtube.md.

## Data

All renderer state is `localStorage` JSON: `sources`, `continue`, `watchlater`, `tmdbKey`, `settings`, `lastSource`, `defaultSource`, `lastPlayed`, `browseFilters`, `liveView`, `dashRailType`, plus one-shot flags (`railsV060`, `adlistV017`, `libraryHealed`, `padHintSeen`, `lastSeenVersion`). Main keeps `userData/settings.json` (the ⚙ subset) and `userData/window.json`.
