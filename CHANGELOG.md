# Changelog

All notable changes to Stream Hub, grouped into milestone updates. Individual version tags remain in git
history. Download the latest installer from the [Releases page](https://github.com/jbi2109/stream-hub/releases/latest).

---

## v0.2.8 – v0.2.13 — Layout, filters & quality-of-life (July 2026)

### Features
- **Rail layout split** *(v0.2.8)* — each rail button now shows only its own content: 🔍 Browse is
  Movies / TV / Anime only, 📺 opens Live TV on its own (no shared tab bar), and YouTube is reached
  solely from the ▶ button.
- **⏯ Resume button** *(v0.2.8)* — a new rail button that jumps straight back to whatever you were last
  watching (live, VOD, or YouTube) without re-walking the source pages. Reveals the still-loaded player
  instantly when possible.
- **Two-hop live catalogs** *(v0.2.8)* — supports streamed.pk-style APIs where the match list carries
  `{source, id}` pairs and the playable embed comes from a second `…/stream/{source}/{id}` request.
  The second-hop URL is derived generically from your own catalog URL and resolved lazily when you open
  a match. Stream language and HD flags map onto the source-row chips.
- **Browse filters + pagination** *(v0.2.10, v0.2.11)* — Movies / TV / Anime gain six pill filters
  (**Genre · Year · Language · Country · Sort · Provider**, all TMDB-backed) and a **Prev / Next pager**
  (20 titles per page) to walk the entire catalog. Sorts include Most Popular, Newest, Oldest, Highest
  Rated, Most Voted, and A-Z. Anime stays Japanese-origin unless you explicitly pick another language.
- **Live TV filters** *(v0.2.13)* — a **Most watched** sort (from viewer/popularity fields in the
  catalog data) and a **Live now** toggle that hides matches that haven't kicked off yet.

### Fixes & polish
- Rail order: Library on top with the 🔍 icon, Movies/TV Shows below with the 🎥 icon *(v0.2.9)*.
- Opening the YouTube tab no longer wipes the Resume target *(v0.2.10)*.
- The app window / taskbar now shows the Stream Hub logo instead of a blank page icon *(v0.2.12)*.

---

## v0.2.4 – v0.2.7 — The Live TV engine (July 2026)

### Features
- **Generic live catalogs** *(v0.2.4)* — add any live-streams JSON API by URL through the wizard. The
  parser is fully generic: it walks nested, grouped-by-sport shapes, expands per-event `channels[]`
  arrays, and recognises broad field-name variants. No provider is committed to the repo — you paste
  your own catalog URLs.
- **One tile per match** *(v0.2.5)* — a match with many streams collapses into a single card; sources
  are grouped and labelled, with best-effort language detection and a **default live language** setting
  that floats your language to the top.
- **Unified live grid** *(v0.2.6)* — all catalogs merge into one grid with a single search + category
  filter. Matches from different catalogs merge team-order-aware ("A vs B" = "B vs A"). Clicking a
  match opens a full **source-selection page** listing every stream from every catalog, with language
  and quality chips. The movie/TV detail page's source dropdown became the same "Watch on" list.
- **Fast incremental loading** *(v0.2.7)* — each catalog renders as it resolves, so a slow or dead
  catalog no longer blocks the grid (fetches abort at 60 s). A hover-revealed **Sources** button over
  the player reopens the picker mid-watch.

### Fixes & polish
- Add-source wizard rebuilt: no more flashing/re-rendering on every click, no more closing when
  pressing Next with the name box focused, and ✎ now edits **every** facet of a source in place *(v0.2.4)*.
- Catalog fetches send a browser User-Agent (some APIs reject the default one) *(v0.2.4)*.
- Matches always open the source page first — never auto-jump into the only-loaded source *(v0.2.7)*.
- YouTube videos and live streams no longer leak into Continue Watching (including a race when leaving
  a stream quickly); existing junk entries are purged on launch *(v0.2.7)*.

---

## v0.2.0 – v0.2.3 — UI overhaul & sign-in fixes (July 2026)

### Features
- **Total UI overhaul** *(v0.2.0)* — a modern media-app shell: left icon rail, top bar, and a dedicated
  **tabbed Settings screen** (General / Appearance / Sources / Playback / Library / Updates / Advanced /
  About) replacing the old sidebar.
- **Theming** *(v0.2.0)* — dark/light themes, six accent colors, and adjustable poster size, applied
  before first paint (no flash).

### Fixes & polish
- **Google / YouTube sign-in** *(v0.2.1)* — fixed "This browser or app may not be secure": Chromium's
  Client-Hints headers are stripped on Google's login hosts and sign-in opens in a standalone window
  that presents consistently as Firefox.
- **YouTube playback** *(v0.2.2)* — fixed the black, silent player: YouTube is exempted from ad-block
  *scriptlet* injection (which mangled the player's init data). Network-level ad-blocking stays on.
- **Sponsored-tile hiding restored** *(v0.2.3)* — YouTube gets cosmetic element-hiding CSS again (hides
  Sponsored feed tiles and the masthead banner) while scriptlets stay off so videos keep playing.

---

## v0.1.0 – v0.1.4 — Foundation (July 2026)

### The first public release *(v0.1.0)*
A desktop browser shell that turns your own streaming sites into one tidy media library:
- **TMDB Browse home** — discover Movies, TV, and Anime; search; native **detail pages** with overview,
  rating, cast, season/episode picker, in-app trailers, and "where to watch".
- **Bring-your-own sources** — add any embed player or site by URL with an optional watch-link pattern;
  nothing is bundled with the app.
- **Automatic Continue Watching** — title, poster, and season/episode captured as you watch, with real
  playback-position progress bars read from the player.
- **Watch Later** — one-click save that auto-advances its episode as you keep watching.
- **Ad-blocking** (full uBlock-style lists, refreshed daily) and **pop-under blocking**, with real
  login popups (Google, Discord, etc.) allowed.
- **Windows installer with in-app auto-update** from GitHub Releases.
- **Settings export / import** for moving your setup between machines.

### Fixes & polish
- Continue Watching / Watch Later titles fixed for embeds that expose no page title; clicks on a card's
  controls no longer open the show *(v0.1.1)*.
- App version shown in the footer + visible auto-update status *(v0.1.2)*.
- Library entries titled from the TMDB id in the URL (provider-agnostic) and old junk entries healed
  automatically *(v0.1.3)*.
- Per-card **source switcher** — change which source a saved show continues on *(v0.1.4)*.
