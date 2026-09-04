# Stream Hub — full audit, brainstorm and staged roadmap (2026-09-04, from v0.17.0)

## 1. What was audited and how

- **Every source file read in full**: main.js, preload.js, webview-preload.js, core.js, app.js, settings.js, wizard.js, sources.js, browse.js, dashboard.js, detail.js, live.js, library.js, media.js, keyboard.js, input.js, rail.js, icons.js, theme.js, index.html, style.css, test/e2e.js structure + all 182 test names, test/cdp.js, test/screenshots.js, both CI workflows, package.json build config, README, CHANGELOG headers.
- **Visual pass**: 53 screenshots of the real app on a throwaway profile with stubbed TMDB/live data — every view, every settings tab, every wizard step, palette/help/What's New/toast/update banner, light theme, an 860×560 window, gamepad-focus and touch modes. All eyeballed.
- **Missing-feature panel**: three persona agents (daily power user, couch/controller user, first-run user) each grepped the repo to prove absence. Their evidence is folded into §3.
- **Not done**: the planned adversarial verification pass (finder → two skeptics per finding) died twice on the account's usage limit. Every finding below was instead verified by me against the code or a screenshot; the file:line is the proof. Treat severities as one reviewer's call.

Severity scale: **critical** = data loss / crash / security · **high** = user-visible bug or a11y blocker · **medium** = wrong or awkward behaviour, perf, missing state · **low** = polish / consistency.

## 2. Findings (ranked)

### 2a. Visual bugs (all confirmed in screenshots)

| # | Sev | Where | Defect | Evidence | Smallest fix |
|---|-----|-------|--------|----------|--------------|
| V1 | high | style.css:113, :133, :677 | Top-bar **"+ Watch Later" and "Sources" buttons lose their styling** — `#topbar button { background:none; font-size:16px }` (specificity 1,0,1) beats `#watch-later` / `#live-sources` (1,0,0). Watch Later renders as bare grey text. | shots 23, 24, 54 | Raise the two selectors to `#topbar #watch-later`, `#topbar #live-sources`. |
| V2 | high | style.css:988 vs :989 | **"Sources" top-bar button wraps onto two lines** — `#topbar button svg { display:block }` (1,0,2) beats `#live-sources svg { display:inline }` (1,0,1). | shot 23 | `#topbar #live-sources svg { display:inline }`. |
| V3 | high | style.css:936, :624 | **Keyboard/controller focus ring wraps a huge empty box** on dashboard rails — `.rail` is flex (align-items: stretch) so every card stretches to the tallest sibling, and the ring outlines the stretched card. | shot 05 | `.rail { align-items: flex-start }`. |
| V4 | medium | browse.js:370, style.css:202 | **"No results" empty state is squeezed into one 160 px grid column** (it is placed inside `.grid`). | shot 07 | `grid-column: 1 / -1` on `#view .grid > .empty`. |
| V5 | medium | browse.js:184-213, :363-391 | **Hover preview lingers after the grid it belonged to is gone** — search redraw, tab switch (renderBrowse, not showBrowse), pagination and person→detail all re-render without `hideHoverPreview()`; a card removed under a still pointer never fires mouseleave. | shots 07, 08, 15 | Call `hideHoverPreview()` at the top of `drawResults`, the tab-bar `onPick`, and `renderBrowse`. |
| V6 | medium | library.js:36-41, style.css:809-855 | **S/E badge and the hover action row collide** on 160 px library cards (`S2 E5` + `TV Show ▾ ✎ ✕` share one 130 px line). | shot 18 | Move `.card-actions` to the bottom edge (as touch mode already does) or hide `.badge` while `.card:hover`. |
| V7 | medium | live.js:726-733, style.css:278 | **Plain-site live tiles sit as a detached 200 px block above the category bar** instead of inside the grid. | shots 21, 45 | Render site tiles as the first cards of `match-grid` (a `matchCard`-shaped node with the site name) or as chips in `.subtabs`. |
| V8 | low | style.css:718 | **Tagline is near-invisible** over the detail backdrop (muted italic on imagery, no scrim). | shots 10, 14 | Use `--text` at `.85` opacity + `text-shadow`, or drop the tagline. |
| V9 | low | style.css:559 | **Wizard preview URL breaks mid-word** (`word-break: break-all` → "https://exa / mple-player.com"). | shot 28 | `overflow-wrap: anywhere; word-break: normal`, one line per example. |
| V10 | low | style.css:649 | **Command palette shows the default grey Windows scrollbar** while every other scroller hides its bar. | shots 30, 46 | `.palette-list { scrollbar-width: thin }` + matching `::-webkit-scrollbar` rule. |
| V11 | low | style.css:161-167 + :736 | **Person page content is indented 48 px while its header sits at 24 px** (`#person` padding + `.detail-section` padding stack). | shot 15 | `#person { padding: 0 0 40px }` so it matches `#detail`. |
| V12 | low | style.css:598-614, :799, :613 | **Emoji as icons** (🎬 / 📺 fallbacks, ▲▼, ✓✕, ‹›, ▶, ←) despite icons.js existing — font-dependent rendering, inconsistent weight. | shots 17, 19, 21, 25-general | Swap for `icon()` glyphs; keep `←`/`›` only inside text labels. |

### 2b. Behaviour bugs

| # | Sev | Where | Defect | Evidence | Smallest fix |
|---|-----|-------|--------|----------|--------------|
| B1 | high | media.js:4-20, sources.js:920-935 | **A source whose watch-link pattern puts `{id}` in the query string (`?id=…`) silently loses everything id-based**: no Continue-Watching identity (`mediaKey` falls back to host+path, every episode of every show collapses to ONE entry), no hero Resume, no source/episode switcher, no auto-next, no TMDB re-titling. `buildUrl` happily produces such URLs; `tmdbIdOf` only scans the pathname for `/\d{3,}`. | shot 24 (no switchers), code | In `tmdbIdOf`/`mediaKey`/`parseSeasonEpisode` also read `id`, `tmdb`, `s`/`season`, `e`/`episode` query params. One shared helper. |
| B2 | high | detail.js:39, :74, keyboard.js:430-435 | **Detail "← Browse" / Esc always returns to Browse**, even when the title was opened from the Dashboard, Library, hover preview or a person page. Esc also does nothing on Dashboard/Browse/Library (no history). | shots 10, 14; persona evidence | Record `detailOrigin.from` (the view that called `showDetail`) and route back to it; a 1-deep origin is enough — no full history stack. |
| B3 | medium | library.js:702 | **Watch-Later cards label live / TV items "Movie"** (`se \|\| 'Movie'`). | shot 19 | `se \|\| CAT_LABEL-style map of typeOf(item)`. |
| B4 | medium | detail.js:175, browse.js:173/210 | **"+ Watch Later" never shows membership and cannot remove** — clicking again silently re-adds. | persona evidence | Render `✓ In Watch Later` when `later.some(c => c.key === key)`; click toggles (filter out + toast with Undo). |
| B5 | medium | dashboard.js:574-576, library.js:714-718 | **A Completed episode stays a "Resume" card that replays the ending**; nothing advances to the next episode or retires a finished film. | persona evidence | On capture/progress ≥95 %: TV → rewrite the entry to the next episode (reuse the rollover in `maybeAutoAdvance`) with position null; movie → keep for 24 h then drop from `cont` (or a "Watched" chip + hide from the rail). |
| B6 | medium | detail.js:153-154, :164 | **Detail page always offers "Play S1 E1"**, ignoring the Continue entry for that id. | persona evidence | Seed `curSeason/curEpisode` from `cont.find(key === type#id)`; label the button "Resume S2 E5"; mark watched episodes with a chip. |
| B7 | medium | live.js:597 | **Live source picker sorts "unknown language" rows ABOVE known ones when no preference is set** (`l ? 2 : 1`). | shot 22 ("Stream 3" first) | `pref && l === pref ? 0 : 1` — stop ranking unknown ahead of known. |
| B8 | medium | dashboard.js:833, wizard.js:526-537 | **Onboarding card is an AND gate and never refreshes after the wizard closes** — add a key first and the checklist vanishes before a source exists; add a source first and the card still says "add a source" until you navigate. | persona evidence | Gate on `!tmdbKey \|\| !sources.length`, tick completed steps, call `renderDashboard()` from wizard `finish()` when the dashboard is visible. |
| B9 | low | dashboard.js:262-266 | **Preview opens under a stationary pointer after a wheel scroll** (1 s later a card slides under the cursor). | shot 03 | Skip the hover timer for 400 ms after any scroll (the capture-phase scroll listener already exists). |
| B10 | low | settings.js:383-388 | **Number fields silently reject invalid input** (type 0 → nothing saved, field still shows 0, no message). | code | On reject: revert `inp.value` and toast "minimum is N". |

### 2c. Robustness / main process

| # | Sev | Where | Defect | Evidence | Smallest fix |
|---|-----|-------|--------|----------|--------------|
| R1 | high | app.js:217-220, core.js:22-24, :49-51 | **A malformed import (or hand-edited file) bricks the app**: `sources`/`continue`/`watchlater`/`settings.dashRails` are read with no shape check; a non-array makes `sources.map` throw at boot → blank window, and Settings is unreachable to fix it. | code | `load()` variant `loadList(key)` = `Array.isArray(v) ? v : []`; in `importSettings` only accept known keys and validate types before writing; toast what was skipped. |
| R2 | medium | main.js:443-451 | **TMDB proxy has no timeout** — a hung request leaves the detail page on "Loading…" forever (every other fetch in main uses `AbortSignal.timeout`). | code | `signal: AbortSignal.timeout(15000)`. |
| R3 | medium | main.js:366-375 | **Window restores to a display that no longer exists** (unplugged monitor) — saved x/y used unchecked → window off-screen. | code | Intersect saved bounds with `screen.getAllDisplays()`; fall back to default when empty. |
| R4 | medium | app.js:168-172 | **No `did-fail-load` handling** — a dead source shows Chromium's raw `ERR_NAME_NOT_RESOLVED` page inside the app. | persona evidence | On `did-fail-load` (main frame, code ≠ -3) show a toast "Couldn't load <host> — Switch source / Edit source" using the existing action toast. |
| R5 | low | package.json build.files | `.impeccable/hook.cache.json` and `build/` scratch ship inside the installer (`**/*` with a short exclude list). | code | Add `"!.impeccable"`. |
| R6 | low | main.js:455-460 | `set-setting` merges any keys the renderer sends (`Object.assign(ms, patch)`). Renderer is trusted, so not a security issue — but a typo'd key persists forever in settings.json. | code | Whitelist to `Object.keys(MAIN_DEFAULTS)`. |

No XSS found: every user/site/TMDB string goes through `textContent`; the four `innerHTML` uses are static headings. Renderer CSP + contextIsolation posture is sound. Nothing critical.

### 2d. Accessibility and 10-foot use

| # | Sev | Where | Defect | Evidence | Smallest fix |
|---|-----|-------|--------|----------|--------------|
| A1 | high | style.css:475-488 | **Toggle switches have NO visible keyboard focus** — the real checkbox is `opacity:0; width:0; height:0`, so Tab lands on an invisible 0 px element. Every switch in Settings is affected. | code | `.switch input:focus-visible + .slider { outline: var(--focus-ring); outline-offset: 2px }`. |
| A2 | high | keyboard.js:198, input.js | **Controller cannot reach ▶ Play, season select, Browse tabs, pager, hero Resume/arrows, rail buttons, or any Settings control** — `NAV_SEL` is cards only and `moveGrid` clamps inside one container; the palette is pad-blind (D-pad/A swallowed while it is open). | persona evidence; shot 05 | Two steps: (1) make the palette pad-navigable (route D-pad/A to its own idx/run while `paletteEl`); (2) add `button, select, [tabindex]` inside the visible view as a fallback when arrow movement clamps — a spike first (§5). |
| A3 | medium | style.css (15 rules) | **Fifteen text styles are 10–11 px** (`.match-time`, `.src-q`, `.card-source`, `.live-chip`, `.cast-char`, `.wiz-count`, `.ep-chip`, `.filter-badge`, `.poster-info-meta`, `.src-lang`, `.rail-type button`, `.tile-tag`, `.dashrail-move`, `.card-source-label`, `.card .badge`). Unreadable from a couch; below the 12 px floor. | code | Raise to `--fs-xs` (11 px) minimum where decorative, 12 px where informational; plus a UI-scale setting (F-couch-2). |
| A4 | medium | style.css:9 vs :6 | **Muted text on `--panel-2` is 4.48:1 in dark mode** (#8a919e on #262a33) — just under AA, and it is exactly the surface used for the 11 px chips/selects above. Light theme passes (5.4:1). | computed | Lighten `--muted` to `#949ba8` (≈5.0:1 on panel-2). |
| A5 | medium | dashboard.js:729-731 | **Hero carousel pauses on mouse hover only** — keyboard/pad focus on its buttons keeps the slide rotating away. | code | Add `focusin`/`focusout` mirrors of the mouse handlers. |
| A6 | medium | settings.js:348, :352, :410 | **Native `confirm()` dialogs** for Clear/Reset — unreadable and unanswerable from a controller, and they freeze the renderer. | code | Replace with the existing action toast ("Cleared — Undo") or a two-click confirm on the button. |
| A7 | low | style.css:698 | **Player "Sources" overlay is hover-only**; touch mode is handled, gamepad mode is not. | code | `body.input-gamepad #sources-overlay { opacity: 1 }` (until in-player pad control lands). |

### 2e. Performance

| # | Sev | Where | Defect | Evidence | Smallest fix |
|---|-----|-------|--------|----------|--------------|
| P1 | medium | browse.js:333-334, :390 | **First Browse paint waits for four filter-option fetches** (genres, providers, languages, countries) before the results request even starts. Skeletons sit there for the sum of both round-trips on every cold session. | code | Kick off `drawResults()` before the `await Promise.all(...)`; fill the filter bar when it resolves. |
| P2 | low | live.js:764-766 | Live grid rebuilds re-focus by index; fine. Catalog CAP 500 rows, 5 MB body cap, 60 s abort — all present. No perf issue found in the player path. | — | — |

### 2f. Consistency, dead code, motion

| # | Sev | Where | Defect | Fix |
|---|-----|-------|--------|-----|
| C1 | low | style.css:432-441, :596 | Dead rules: `#sources li input` (inline edit was replaced by the wizard) and `.tile-logo` (no JS renders it). | Delete both. |
| C2 | low | style.css:477-486, :696, :795 | Raw durations `.15s`, `.15s`, `.12s` beside the `--dur-*` tokens. | Use `var(--dur-fast)`. |
| C3 | low | dashboard.js:482-485 | "Trending" and "Top 10 Today" are the same `/discover?sort_by=popularity` slice — identical rails when both are on. | Point Top 10 at `/trending/{mt}/day` (TMDB has it; one path change). |
| C4 | low | README.md | Feature prose is one 40-line bullet per section; the test count and the hero screenshot are the only assets. Fine for now — revisit when the roadmap ships. | — |

### 2g. Tests and CI

- CI is in good shape: the full e2e suite runs on every PR/push and gates every tag; release pre-creation avoids the electron-builder race. CHANGELOG sections are separated correctly for the release script; versions are monotonic.
- **Coverage gaps that matter** (nothing above is tested): topbar button styling (V1/V2), rail focus geometry (V3), empty-state layout (V4), preview cleanup on re-render (V5), query-string ids (B1), detail back-to-origin (B2), WL labels/toggle (B3/B4), import validation (R1), TMDB timeout (R2), `did-fail-load` (R4), switch focus (A1), pad-in-palette (A2), hero focus pause (A5).
- **Order dependence**: the suite is one sequential run and several tests inherit state (e.g. the toast left by test 80 is removed by 81). Every new test must clean its own toast/modal/webview state and must not depend on an earlier `cont` entry.
- 24 hard `sleep()`s exist; none is a flake source today, but new tests should use `until()` polls only.

## 3. Missing features (verified absent; ranked by persona priority)

| # | Feature | Who | Effort | Notes |
|---|---------|-----|--------|-------|
| F1 | External links open in the system browser (Get a key / GitHub / release notes are dead today — every host `window.open` is denied) | first-run | S | `shell.openExternal` behind one IPC; allow-list https only. |
| F2 | TMDB key check on paste + empty states that say why (bad key / offline) instead of a blank dashboard | first-run | S | Hit `/configuration` once on change; toast ✓/✗; dashboard shows one line when every rail failed. |
| F3 | Detail page resumes where you left off + watched-episode chips (= B6) | power | M | |
| F4 | Completed items roll forward / retire (= B5) | power | M | |
| F5 | Pad-navigable command palette (= A2 step 1) | couch | S | |
| F6 | Lean-back fullscreen: F11 / pad toggle hides rail + topbar; optional launch-fullscreen setting | couch | S | `win.setFullScreen` + a body class. |
| F7 | UI scale setting (10-foot zoom) | couch | S | One `zoom` on `<html>` from `applyThemeVars` + a segmented row. |
| F8 | Next / Previous episode button + shortcut while watching (reuses the auto-next rollover) | power | S | Topbar buttons + `N`/`P` forwarded from the guest like Esc. |
| F9 | In-player pad control: A play/pause, ←/→ seek, LB/RB episode, Y sources; plus media keys and mute | couch | M | Same frame-walk `readVideo` already does; extend to `play()/pause()/currentTime`. No extraction — it is the site's own `<video>`. |
| F10 | Watch Later toggle + membership state (= B4) | power | S | |
| F11 | Library sort + type-to-filter | power | S | Reuse `pillSelect` + `.browse-search`. |
| F12 | Undo on remove (source / card) via the action toast | first-run | S | |
| F13 | Friendly player load-failure state (= R4) | first-run | S | |
| F14 | Help reachable by mouse (palette entry + Settings → About row) | first-run | S | |
| F15 | Onboarding checklist that ticks and refreshes (= B8) + wizard "Try it" button | first-run | S | |
| F16 | Ctrl+K searches titles too (library first, then TMDB) | power | M | |
| F17 | Right-click context menu on cards | power | M | |
| F18 | Hover preview + Details on library cards | power | S | |
| F19 | Rail text labels (or labels on hover/focus) | first-run | S | |
| F20 | Export "sources only" (no key, no history) | first-run | S | |
| F21 | Plain-language copy pass (JSON API, embed pattern, uBlock, debounce) | first-run | S | |
| F22 | Picture-in-picture / always-on-top mini player | power | M | `setAlwaysOnTop` mini mode is the lazy version. |
| F23 | Controller on-screen keyboard | couch | M | Only after A2. |
| F24 | Watch Later reordering | power | M | Low priority. |
| F25 | Second window | power | L | Out of scope — globals are single-instance. |
| F26 | **SponsorBlock for YouTube** (previously agreed as the third of three releases) | you | M | Hash-prefix API via main IPC, skip in the guest preload, visible CC BY-NC-SA attribution, no vendored GPL code. |

## 4. Brainstorm — options per theme, and the pick

Each pick is the lowest rung that holds (reuse → native → minimal code). Alternatives are listed so the choice is visible.

1. **Top-bar styling (V1, V2)** — (a) restructure the topbar into classes; (b) raise the three losing selectors' specificity; (c) `!important`. **Pick (b)**: three selector edits, no markup change, no test churn.
2. **Focus geometry (V3)** — (a) outline the `.poster-wrap` instead of the card; (b) `align-items: flex-start` on `.rail`. **Pick (b)**: one line, also fixes the stretched hover box.
3. **Hover-preview leaks (V5, B9)** — (a) MutationObserver that hides the preview whenever its card leaves the DOM; (b) explicit `hideHoverPreview()` in the three redraw entry points + a scroll grace. **Pick (b)**: explicit beats magic; the redraw sites are known.
4. **Query-string ids (B1)** — (a) tell users not to use query patterns; (b) one helper `idFromUrl(url)` that checks pathname then `id`/`tmdb` params, used by `mediaKey`, `tmdbIdOf`, `parseSeasonEpisode`; (c) store the TMDB id on the Continue entry at open time so URL parsing is a fallback only. **Pick (b) now, (c) is the right long-term shape** — (c) needs a migration for existing entries; do (b) first, (c) when B5/B6 land (they need the id on the entry anyway).
5. **Back navigation (B2)** — (a) full view history stack with Esc popping it; (b) `showDetail(kind, id, from)` records the launching view and both back paths use it; Esc on top-level views stays a no-op. **Pick (b)**: the app has four top-level views and one detail level; a stack is speculative.
6. **Completed items (B5)** — (a) delete finished entries; (b) roll TV forward to the next episode, retire movies after 24 h; (c) "Watched" chip only. **Pick (b)** with (c) as the visible state on the library grid; runs inside the existing progress handler, gated by a one-shot migration for entries already ≥95 %.
7. **Import safety (R1)** — (a) JSON schema; (b) per-key `Array.isArray` / `typeof` guards + known-key allow-list. **Pick (b)**.
8. **Controller reach (A2)** — (a) full spatial navigation (nearest element in direction, all focusables); (b) palette becomes pad-navigable + `Tab`-order fallback when an arrow move clamps at a container edge; (c) add every control to `NAV_SEL`. **Pick (b) after a one-day spike** — (a) is a subsystem, (c) breaks grid maths. Spike question: can `moveGrid` fall through to "next focusable in DOM order" without regressing the 6 keyboard tests?
9. **Player control from the couch (F8, F9)** — (a) synthesize key events into the guest; (b) extend `readVideo`'s frame-walk with `play/pause/seek` and expose one IPC `player-cmd`; (c) require players to expose an API. **Pick (b)**: same privileged frame-walk, same "site's own video element" boundary, no extraction.
10. **Confirmations (A6)** — (a) custom modal; (b) two-click "Clear? — click again" button; (c) action toast with Undo. **Pick (c)** for library clears (undo is better than confirm), (b) for Reset settings.
11. **Empty/error states (F2, R4)** — (a) global error boundary view; (b) one toast per failure class + a single-line dashboard message when all rails fail. **Pick (b)**.
12. **10-foot text (A3, F7)** — (a) rewrite the type scale; (b) raise the 15 sub-12 px rules to 12 px and add a UI-scale setting (`zoom` 1.0 / 1.15 / 1.3). **Pick (b)**.
13. **Live site tiles (V7)** — (a) merge into the match grid as pseudo-matches; (b) chips row above the grid; (c) leave. **Pick (a)**: one card shape, one keyboard model.
14. **SponsorBlock (F26)** — keep the agreed design: main-process hash-prefix lookup, guest-side skip, attribution in Settings → Privacy, toggle default on. Ordered after the bug tranche (below) unless you want it first.

## 5. Plan v1 (first draft — theme-grouped)

| Rel | Theme | Contents |
|-----|-------|----------|
| v0.18 | Visual fixes | V1–V12, C1, C2 |
| v0.19 | Navigation | B2, V5, B9, F1 |
| v0.20 | Continue Watching correctness | B1, B3, B4, B5, B6 |
| v0.21 | Error + empty states | F2, R2, R4, B8, B10 |
| v0.22 | Player controls | F8, F9, media keys, mute, A7 |
| v0.23 | 10-foot | A1, A2, A3, A4, A5, A6, F5, F6, F7 |
| v0.24 | Library | F11, F12, F18, F16 |
| v0.25 | Robustness | R1, R3, R5, R6 |
| v0.26 | Onboarding + copy | F14, F15, F19, F20, F21 |
| v0.27 | SponsorBlock | F26 |
| v0.28 | Perf + nice-to-haves | P1, C3, F17, F22 |

## 6. Critique of plan v1

1. **Too big per release.** v0.18 touches 14 CSS sites; v0.20 rewrites the identity model AND the completion model in one go; v0.23 is a month. You asked for *several smaller implementations per fix/feature*, not one big one per theme. A 14-item CSS release also makes the visual-QA eyeball pass useless — one screenshot can't attribute a regression.
2. **Risk is mixed.** v0.20 puts a data-model migration (B5) next to a one-line label fix (B3). If the migration misbehaves the trivial fix is stuck in the same release.
3. **Order ignores dependencies.** B5/B6 both need the TMDB id reliably on the entry (B1 first, then storing the id — option 4c). F9 needs the `player-cmd` IPC that F8 also needs. A2 needs its spike before it can be sized. F7 (UI scale) should land before A3 (font floors) so the floor is judged at scale 1.
4. **Tests are unplanned.** Every release needs at least one test that goes red when the fix is reverted (house rule). The plan says nothing about which tests, and several fixes (V1–V3) are CSS-only — they need computed-style assertions, not DOM ones.
5. **The e2e run is order-dependent** — adding tests that leave `cont` entries or toasts behind will break later tests; each release's test must clean up.
6. **SponsorBlock is buried at v0.27** although it was the agreed next release. That should be your call, not the plan's.
7. **Migrations are missing.** B5 (already-completed entries), B1 (re-keying existing query-string entries), `--muted` change (none), UI scale (new default only). The installed-base lesson from v0.6/v0.17 says name every one.
8. **Spikes are unmarked.** A2 (controller reach) and F9 (in-player control via frame-walk on real players) are feasibility questions; they must not be scheduled as fixed-size releases.
9. **"Visual QA after every change"** needs a per-release screenshot list, otherwise the eyeball step drifts.

## 7. Plan v2 (revised — this is the one to approve)

Rules baked in: one release ≤ 1 day; 1–3 related findings each; every release names its revert-proof test and its screenshot list; migrations named; spikes are spikes. Version = `npm version minor` each time (v0.18.0, v0.19.0 …). Order = cheap-and-visible first, then correctness, then robustness, then features by persona priority. Move SponsorBlock anywhere you like.

| Rel | Scope | Finding(s) | Files | Revert-proof test | Screenshots to eyeball | Migration |
|-----|-------|-----------|-------|-------------------|------------------------|-----------|
| **v0.18** | Top-bar buttons styled again; Sources on one line | V1, V2 | style.css | computed `background-color` of `#watch-later` is the accent and `#live-sources` height ≤ 1 line while a live stream is open | player-live, player-vod, narrow-player | — |
| **v0.19** | Focus ring hugs the card; empty state spans the grid | V3, V4 | style.css | `.rail .card` height ≈ poster-wrap+title height under keyboard focus; `.grid > .empty` width > 3 columns | dash-gamepad-focus, browse-empty | — |
| **v0.20** | Hover preview never outlives its grid | V5, B9 | browse.js | after a search redraw / tab switch / person nav `#hover-preview` is hidden; a scroll then 300 ms hover shows nothing | browse-empty, browse-anime, person | — |
| **v0.21** | Small visual polish | V8, V9, V10, V11, C1, C2 | style.css | tagline contrast ≥ 3:1 measured; palette scrollbar width ≤ 8 px | detail-tv-top, wizard-4, palette, person | — |
| **v0.22** | Library card badge/actions no longer collide; WL labels right; live tiles join the grid | V6, B3, V7 | style.css, library.js, live.js | WL live card sub reads "Live TV"; `.badge` and `.card-actions` bounding boxes don't intersect on hover; a site source renders as a `.match-card` in `.match-grid` | library-card-hover, library-later, live-tab | — |
| **v0.23** | Query-string watch links get full identity | B1 | media.js (one helper) | `tmdbIdOf('…?type=tv&id=1501&s=2&e=5')==='1501'`, `parseSeasonEpisode` → {2,5}, Continue entry keyed `tv#1501`; existing path-style URLs unchanged | player-vod (switchers visible) | re-key existing entries at boot (rekeyLibrary already runs; it just needs the new helper) |
| **v0.24** | Back goes where you came from | B2 | detail.js, core.js, keyboard.js | detail opened from Dashboard: Back button text "← Dashboard", Esc lands on `#dashboard`; from Library → `#home`; person → detail → origin | detail-tv-top (label) | — |
| **v0.25** | External links open in your browser; help reachable by mouse | F1, F14 | main.js, preload.js, dashboard.js, settings.js, keyboard.js | IPC `open-external` refuses `javascript:`/`file:`; palette lists "Keyboard shortcuts"; About has a Shortcuts row | dash-onboard, settings-about, palette | — |
| **v0.26** | Bad key / dead source say so | F2, R4, R2 | app.js, main.js, dashboard.js | 401 stub → toast "TMDB rejected the key"; `did-fail-load` stub → toast with Switch/Edit; TMDB fetch aborts at 15 s (stub hangs) | browse-nokey, dashboard with failing stub, player error | — |
| **v0.27** | Import can't brick the app; window stays on-screen | R1, R3, R5, R6 | app.js, core.js, main.js, package.json | import `{"sources":"x"}` → boot shows empty list + toast; saved bounds off every display → default bounds | settings-library after a bad import | — |
| **v0.28** | Watch Later toggles and shows state; Undo on remove | B4, F10, F12 | detail.js, browse.js, library.js, sources.js | detail WL button reads "✓ In Watch Later" after add and removes on second click; ✕ then Undo restores the card/source | detail-movie, library-continue, settings-sources | — |
| **v0.29** | Switch focus visible; hero pauses on focus; confirms answerable | A1, A5, A6 | style.css, dashboard.js, settings.js | switch input focus → slider has an outline; `heroTimer` null after `focusin`; Clear buttons produce a toast with Undo, no `window.confirm` call | settings-playback (Tab focus), dash (focus on arrow), settings-library | — |
| **v0.30** | Pad-navigable palette; Sources overlay visible in pad mode | F5, A7 | input.js, keyboard.js, style.css | stubbed pad Down/A with the palette open runs the second action; `body.input-gamepad #sources-overlay` opacity 1 | palette (pad mode), player-live (pad mode) | — |
| **v0.31 (spike)** | Can `moveGrid` fall through to the next focusable when it clamps, without regressing the 6 keyboard tests? One day, throwaway code, outcome = a sized plan for A2 | A2 | keyboard.js | existing keyboard tests stay green | — | — |
| **v0.32** | UI scale setting; sub-12 px text raised; muted contrast fixed | F7, A3, A4 | theme.js, settings.js, style.css | `--ui-scale` applies `zoom`; no rule < 11 px (grep in test); `--muted` on `--panel-2` ≥ 4.5:1 computed | settings-appearance, dash, live-tab at 1.3× | new default only |
| **v0.33** | Lean-back fullscreen (F11 / Start-hold), launch-fullscreen setting | F6 | main.js, preload.js, app.js, style.css | IPC toggles `isFullScreen`; body class hides rail+topbar | player-vod fullscreen | — |
| **v0.34** | Detail page resumes; watched chips | B6, F3 | detail.js | Continue entry S2E5 → Play button "Resume S2 E5", episodes 1–4 carry `.watched` | detail-tv-top, detail-tv-episodes | — |
| **v0.35** | Completed episodes roll forward, finished films retire | B5, F4 | media.js, dashboard.js, library.js | progress 96 % on S1E3 → entry becomes S1E4 pos null; movie 96 % → gone from the rail after the 24 h clock (stub Date) | dash-full, library-continue | one-shot: existing ≥95 % entries processed at boot |
| **v0.36** | Next/Prev episode buttons + N/P keys | F8 | index.html, app.js, main.js, keyboard.js | button click opens S1E2 on the same source; N from inside the guest forwards like Esc | player-vod-topbar | — |
| **v0.37 (spike)** | Player control via the frame-walk on two real embed players (play/pause/seek) — feasibility only | F9 | main.js | — | — | — |
| **v0.38** | In-player pad control + media keys + mute (sized from the spike) | F9, A7 | main.js, preload.js, webview-preload.js, input.js | stubbed pad A toggles `paused` in the fixture player; MediaPlayPause too | player-vod (pad mode) | — |
| **v0.39** | Library sort + filter | F11 | library.js, style.css | typing "har" leaves one card; sort "Title" reorders | library-continue | persist `libView` |
| **v0.40** | Onboarding ticks + refreshes; wizard "Try it"; rail labels | B8, F15, F19 | dashboard.js, wizard.js, index.html, style.css | onboarding step 2 shows ✓ after `addSource`; Try it opens `buildUrl(src,'movie',27205)` | dash-onboard (both states), wizard-4, dash | — |
| **v0.41** | Browse first paint no longer waits for filters; Top 10 = TMDB trending | P1, C3 | browse.js, dashboard.js | results request issued before `/genre` resolves (request-order fixture); Top 10 hits `/trending/movie/day` | browse-movies-filters, dash-scrolled | — |
| **v0.42** | SponsorBlock | F26 | main.js, preload.js, webview-preload.js, settings.js | stubbed `/api/skipSegments` → fixture video jumps past the segment; toggle off → no jump; attribution text present | settings-privacy, yt-watch | new default only |
| **v0.43** | Ctrl+K searches titles | F16 | keyboard.js | typing a library title lists it above commands; Enter opens it | palette | — |
| **v0.44** | Copy pass + sources-only export + About "what it connects to" | F21, F20, C4 | settings.js, wizard.js, live.js, app.js, README | export-sources file has no `tmdbKey`/`continue` keys | settings-sources, wizard-2, settings-about | — |
| later | Context menu (F17), library hover preview (F18), PiP (F22), on-screen keyboard (F23), WL reorder (F24) | — | — | each its own release when reached | — | — |

Per-release ritual (unchanged): CHANGELOG entry in the release commit; e2e green ×2; `npm version minor`; push tag; poll CI; PATCH the release body from the CHANGELOG; verify 3 assets; then my critique of the implementation (look, style, code) and a fix-up pass before the next release starts.

## 8. Assumptions and open questions

1. **SponsorBlock position** — v0.42 above; say if it should be v0.18.
2. **Completed-movie retirement** — 24 h grace then drop from Continue Watching (still in history via Watch Later if saved). Alternative: keep with a "Watched" chip forever. I assumed drop.
3. **UI scale** — `zoom` on `<html>` scales the webview chrome too, which is what a couch user wants; the guest page itself is unaffected.
4. **Query-string ids** — I assumed `id`, `tmdb`, `tmdb_id` for the id and `s`/`season`, `e`/`episode` for numbers. Add others when you meet them.
5. **Versioning** — one `npm version minor` per row above (0.18 → 0.44). Spikes (v0.31, v0.37) do not ship a release; they produce a sized plan and are absorbed into the next row.
6. **Two things deliberately not planned**: a second window (F25, single-instance globals) and full spatial navigation (only if the v0.31 spike says the fallback is not enough).
