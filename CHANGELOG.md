# Changelog

All notable changes to Stream Hub, grouped into milestone updates. Individual version tags remain in git
history. Download the latest installer from the [Releases page](https://github.com/jbi2109/stream-hub/releases/latest).

---

## v0.4.2 — YouTube video ads blocked (July 2026)

v0.4.1 blocked YouTube video ads by having the ad-block engine inject uBlock's `+js()` scriptlets
into the page. On a signed-in YouTube player that backfired: the engine injects them via a `<script>`
DOM node, YouTube's Content-Security-Policy blocks that node insertion, and the violation is
uncatchable — so the player never started and you got a grey video area.

- **YouTube video ads still blocked — the grey player is fixed for everyone on update.** The
  engine-scriptlet approach is gone. In its place, an in-page **config pruner** removes the ad
  fields (pre-roll/mid-roll) from YouTube's player config before the player ever reads it. It never
  inserts a DOM script (no CSP violation), never touches the player (no grey/black video), and
  never blocks a network request. An **auto-skip fallback** mutes and fast-forwards anything that
  slips through (e.g. server-side-inserted ads).
- **Toggle unchanged.** **Settings → Privacy → YouTube ad-blocking** still lets you turn it off and
  reload if YouTube ever misbehaves.
- Nothing else from v0.4.1 changes — the network + cosmetic ad-blocking, the cached self-updating
  ad lists, and the **Update ad lists now** button all work exactly as before.

---

## v0.4.1 — YouTube ad-blocking & self-updating ad lists (July 2026)

Ad-blocking got a real upgrade, prompted by pre-roll ads slipping through on YouTube.

- **YouTube pre-roll/mid-roll blocking re-enabled** — the app previously withheld uBlock's YouTube
  scriptlets because an old engine bug could black-screen the player; the upstream fix landed, so
  YouTube now gets the full treatment. Still best-effort (YouTube actively fights blockers). If a
  YouTube video ever goes black, flip **Settings → Privacy → YouTube ad-blocking** off and reload
  the video.
- **Fixed: full filter lists never actually cached** — a bug silently downgraded the engine to a
  reduced ads-only list on most launches. The full uBlock-style lists (network + cosmetic +
  scriptlets) now download once, cache properly, and load instantly on later launches.
- **Ad lists auto-refresh while the app runs** — stale lists rebuild in the background on the
  schedule set in Settings → Advanced (default daily), with no interruption to playback; if a
  refresh fails, the previous lists stay active. A new **Update ad lists now** button plus a status
  line ("Full lists · updated 3h ago") live in Settings → Privacy.
- **Fixed: rail edge fades could fail to appear** on the Dashboard until you scrolled.

---

## v0.4.0 — The cinematic pass (July 2026)

The first release of the v0.4 series — a visual overhaul informed by a 5-agent study of the best
open-source media apps. No behavior changes to sources or playback; the engine underneath is untouched.

- **A hero banner tops the Dashboard** — your most recent Continue Watching item (with backdrop art,
  TMDB logo art, and a **▶ Resume** button that jumps straight back in, plus "min left"), or the top
  trending title when there's nothing to resume.
- **Cinematic detail pages** — a full-bleed backdrop sits behind the page and fades away as you
  scroll; titles render as **TMDB logo art** when available; the top bar blends into the page at the
  top of a detail view.
- **Continue Watching cards are now 16:9 mini-posters** on the Dashboard, with backdrop art, a
  timestamp chip (or a green **Completed** chip), your progress bar, and "3 days ago" recency — the
  Library grid keeps the denser poster layout.
- **Real icons** — the emoji glyphs across the rail, top bar, and buttons are replaced with a crisp
  SVG icon set that recolors with your theme and accent.
- **Poster hover** — browse/trending posters get a subtle zoom, accent ring, play glyph, and an
  always-on title/year/★ gradient.
- **Skeleton loading** — grids and rails now load as shaped placeholders instead of a spinner, so
  nothing jumps; rails fade at the edges when there's more to scroll.
- **Light theme actually looks right** — every hardcoded dark color (tiles, match cards, chips, the
  detail hero) now follows the theme.
- **Toasts** — small top-right notifications replace the old button-flash for Watch Later, source
  removal, and settings import/export feedback.
- **Motion, politely** — subtle entrance animations throughout, all disabled automatically when your
  OS asks for reduced motion.

---

## v0.3.6 — Repo polish: CI, What's New & docs (July 2026)

- **"What's New" after updates** — the first launch after an auto-update opens a card with that
  release's changelog (pulled from the GitHub release notes; falls back to a link when offline).
  Shows once per version; Esc or **Got it** closes it.
- **Every pull request and push to main now runs the full 112-test e2e suite** on a Windows runner,
  and **releases run the suite before building** — a tag can no longer publish a broken installer.
  The README carries the CI badge.
- **README** gained a first-run screenshot, the TMDB attribution notice, and a short trademark &
  attribution note. (`test/screenshots.js` regenerates the screenshots over the same CDP harness the
  tests use.)

---

## v0.3.5 — Dashboard home, first-run setup & polished states (July 2026)

- **A new Dashboard is the landing page** (🏠 on the rail, `0` on the keyboard, or Ctrl+K → "Open
  Dashboard"): horizontal rails for **Continue Watching** (the same cards as the Library — click one
  and it resumes the exact episode on its own source, with the episode/source switchers lit),
  **Trending** (TMDB's most popular, straight to the detail page), and **Live now** (live matches from
  your catalogs, most-watched first). Each rail has a **See all →** into the full view, empty rails
  hide themselves, and **Esc from the player returns to the Dashboard** when you launched from it.
  Prefer the old behavior? Settings → General → **Landing view** now offers Dashboard / Browse /
  Library.
- **The Dashboard never slows you down**: Continue Watching and Live now render instantly from local
  state (the live rail reads the existing 90-second catalog cache — it never fetches; when the cache
  is cold it shows an "Open Live TV to load matches" shortcut), and Trending fills in behind a spinner.
- **First-run onboarding** — a fresh install (no TMDB key, no sources) now gets a friendly two-step
  setup card (get/paste a TMDB key → add your first source, straight into the wizard) instead of bare
  prompts. It disappears on its own once you've set either up. The Browse and Live TV empty states also
  gained buttons that jump straight to Settings / the add-source wizard.
- **Consistent loading/empty/error states** — a real spinner replaces the bare "Loading…" text across
  Browse, Live TV, and the detail page, with shared styling for empty and error messages.
- Arrow keys work on the Dashboard too: ←/→ walk a rail, ↑/↓ hop between rails.

---

## v0.3.4 — Keyboard control & command palette (July 2026)

The whole native UI is now drivable without a mouse:

- **Arrow-key navigation** across every grid (browse posters, live matches, library cards, episodes,
  source rows) with a visible focus ring; **Enter** opens the focused item — including starting playback
  from a source row.
- **Ctrl+K command palette** — jump anywhere (Browse tabs, Live TV, YouTube, Library, Settings), Resume
  watching, add a source, refresh live catalogs, or focus search. Works **while watching** too.
- **Digit keys** `1–3` for Movies/TV/Anime, `4` Live TV, `5` YouTube; `/` focuses search; `?` shows a
  shortcuts overlay.
- **Esc does the right thing everywhere**: closes the topmost modal, backs out of Settings/detail/the
  live source page, and exits the player **back to wherever you launched it from** (Library, Live, or
  Browse) — without fighting fullscreen-exit.

---

## v0.3.3 — Persistent filters & live match badges (July 2026)

- **Your filter selections now stick** — the Movies/TV/Anime filter pills (Genre, Year, Language,
  Country, Sort, Provider) are remembered **per tab**, and the Live TV sort + "Live now" toggle are
  remembered too — across tab switches *and* app restarts.
- **LIVE & kickoff badges on the live grid** — every match card shows a red **LIVE** chip when it has
  started, **"in 34m"** when kickoff is close, or the kickoff time/date. The default ordering puts
  live matches first, then upcoming by kickoff.

---

## v0.3.2 — Episode switcher & auto-play next (July 2026)

- **Switch episodes without leaving the player** — a new top-bar dropdown beside the source switcher
  lists every season and episode (`S2 E5` style); picking one reloads the same source deep-linked to
  that episode. No more backing out to the detail page between episodes.
- **⏭ Auto-play next episode** — a top-bar toggle that, near the end of an episode, automatically rolls
  into the next one (crossing season boundaries, stopping at the series finale) on the same source.
  Works wherever the player exposes playback progress — the same best-effort as the progress bars.
- **Continue Watching cards now light up the full player toolbar** — continuing a show from the library
  enables the episode + source switchers and auto-play, exactly like starting from the detail page, and
  episode switching stays on the card's own source.

---

## v0.3.1 — Settings that reach the engine (July 2026)

The Settings screen gains a **Privacy & blocking** tab and new Updates/Advanced rows whose switches now
control the main process — nearly all of them **apply immediately, no restart**:

- **Ad-blocking on/off** — flips the whole blocking engine live.
- **Extra login pop-up hosts** — add your own sites' sign-in hosts (comma-separated) so their login
  pop-ups are allowed; everything else stays blocked.
- **Google sign-in fix on/off** — the Firefox-presentation workaround for Google's "browser not secure"
  block, now optional in case it ever misbehaves.
- **Check for updates on launch** — off means updates only happen when you press *Check now*.
- **Advanced:** playback progress poll interval (applies to newly opened players), ad-list refresh age
  (next launch), and live catalog timeout (how long a slow catalog may load before it's marked ✕).

Settings are mirrored to the app's own `settings.json` so they're honored from the moment the app starts,
and a settings **Import/Reset** re-syncs them automatically. Update-check failures now show the actual
error reason instead of a bare "Check failed".

---

## v0.3.0 — Performance & quality-of-life (July 2026)

### Performance
- **Live TV loads instantly on re-entry** — catalog results are cached for ~90 seconds, so coming back
  from a source page (or flicking between tabs) no longer refetches every catalog. A **↻ Refresh**
  button forces a fresh fetch when you want one.
- **Per-catalog status chips** — each catalog shows `name ✓ count`, `✕ failed`, or `…` while loading, so
  a timed-out or dead catalog is visible instead of silently missing.
- **Two-hop sources resolve in parallel** — opening a match with several `{source, id}` streams fires
  the lookups together instead of one-after-another, and resolved results are cached across grid
  rebuilds.
- **Lazy image loading** everywhere (browse posters, live thumbnails, library cards, episode stills,
  cast photos) — big grids no longer eager-load hundreds of images.

### Quality of life
- **⏯ Resume survives a restart** — the last-watched show is persisted, so the Resume button works
  immediately after relaunching the app. Resuming a movie/show also restores the top-bar source
  switcher (not just the live Sources UI).
- **Window size and position are remembered** across restarts (including maximized state).
- Changing the **watch region** now refreshes the provider filter list without a restart.
- Library entries saved with no source configured can no longer navigate the player to a broken page.

### Internals
- The live TV engine moved into its own file (`live.js`), separated from the TMDB browse code.

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
