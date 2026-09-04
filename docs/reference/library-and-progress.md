# Library, capture and watch progress (media.js, library.js, sources.js)

## Identity

- `idFromUrl(url)` = the first `/\d{3,}` run in the pathname, else (v0.20) an `id` / `tmdb` / `tmdb_id` / `tmdbId` query parameter of 3+ digits, else null. `tmdbIdOf` is the same function. `mediaKey(url)` = `type#tmdbId` when there is an id, else `host+path`.
- `parseSeasonEpisode(url, title)`: `?season/&episode` (or `s`/`e`) params, else `/id/S/E` path form, else `S1E2` in the title.
- `mediaType(url, season)`: `tv` when a season is known, the path mentions tv/series/show/anime/episode, or `?type=` says so; `classify` adds `live` via the source's category; `typeOf(item)` falls back for old entries.

## Capture pipeline

`did-navigate` / `did-navigate-in-page` / `did-stop-loading` → `scheduleCapture` (⚙ `captureDebounce`, default 600 ms) → `captureCurrent`:
1. Skip non-media URLs (`isMediaUrl`), YouTube, live URLs and anything opened with `intendedMedia.live`.
2. Title/poster precedence: `intendedMedia` (set by detail Watch, live tile, card reopen — only trusted when its id appears in the URL) → TMDB by URL id → existing entry → scraped `og:title` / `og:image` (`parsePage` runs in the guest top document).
3. Upsert into `cont` (sorted by `updatedAt` desc) when ⚙ `trackContinue`; Watch Later follows the episode when ⚙ `autoAdvanceLater` (title overwritten only from an authoritative source).

`onVideoProgress` (from the main-process poll) writes `position/duration/updatedAt` on the `activeKey` entry and first calls `maybeAutoAdvance`: with ⏭ on, a TV episode within 45 s of the end (duration ≥ 300 s) opens the next episode on the same source, rolling seasons via `seasonsCache` and stopping at the last finale; single-fire per open.

## Library grid (library.js)

`card(item, isCont)`: 2:3 poster, S/E badge, progress bar, hover actions (type select · edit note · ✕ remove — no undo, audit F12), title, per-card source select (rebuildable entries) or read-only label, sub-line (note / S/E / "Watching"; Watch Later shows S/E or the type — Movie / TV Show / Live TV). Tabs Continue / Watch Later, sub-tabs All / Movies / TV Shows (/ Live TV for Watch Later). `openLibraryItem` re-opens the URL, sets `playing` for rebuildable entries so the topbar switchers and auto-next work, and pins the card's source as `lastSourceUrl`.

Dashboard resume cards wrap the same `card()` (16:9, timestamp/Completed chip, relative time, backdrop swapped in from `tmdbMeta` on idle). "Completed" (≥ 95 %) is only a chip — nothing advances or retires the entry (audit B5).

## Sources (sources.js)

`buildSource` prefixes `https://`, keeps `catalogUrl`/`template`. `buildUrl(src, type, id, season, episode)`: default `{origin}/embed/{type}/{id}[/{s}/{e}]`, or the `template` with `{origin} {type} {id} {season} {episode}` tokens; empty path segments are trimmed so one template serves movie and TV. `sourcesFor(kind)`: exact category, falling back to all vod+anime. `openOn(...)` sets `currentSource`/`lastSourceUrl`, opens, sets `playing` + `intendedMedia`, persists `lastPlayed.playing`, and renders the topbar source switcher (only when ≥ 2 sources) and episode switcher (`optgroup` per season, ≤ 300 episodes).

## Migrations and repair

- core.js boot: default category `vod`, purge live + YouTube entries from Continue.
- `rekeyLibrary()` at boot: re-key by `mediaKey`, merge duplicates (newest wins), write only when something changed.
- `healLibrary()` once (`libraryHealed` flag) on idle: re-title/re-poster entries from TMDB by URL id; Settings → Library → "Re-fetch titles" clears the flag.
