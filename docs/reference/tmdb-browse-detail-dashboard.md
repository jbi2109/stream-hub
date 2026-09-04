# TMDB: browse, detail, dashboard (browse.js, detail.js, dashboard.js)

## Fetching

- `tmdbGet(path, params)` → `window.sh.tmdb` through main (renderer CSP forbids direct fetch). Promise cache keyed by versioned `path?sortedParams` (api_key excluded), 5 min TTL, config paths (`/genre/`, `/configuration/`, `/watch/providers/`) cached forever, failures evicted, FIFO cap 500 (`capMap`). Never throws — main returns `{error}`.
- `tmdbMeta(id, type)` → `{title, poster, backdrop}` promise cache used to title library entries by the id in their URL; null/failed results are not retained.
- `hoverDetail`, `discoverRail` (5 min, cap 24), `seasonsCache` (sources.js) are separate caches.

## Browse

Tabs movie / tv / anime (anime = `/discover/tv` with genre 16 and `ja` unless a language is picked). A non-empty query hits `/search/{mt}` and hides the filter bar; anime search client-filters genre 16. Filters (genre, year, language, country, sort, provider) persist per tab in `browseFilters`; advanced ones collapse behind a Filters toggle with an active-count badge. Search is debounced 300 ms and stale responses are dropped by comparing `browseQuery`/`browseTab` at resolve time. Pager: 20/page, TMDB caps at 500 pages. `focusBrowseSearch` (`/`, Ctrl+F, controller X) preserves the query; discovery entries (rail button, digits 1-3, `openGenre`, `seeAllMovies`) clear it.

`posterCard` = 2:3 poster, hover play overlay, gradient title/meta, rank badge (Top 10), "New" tag (released within 21 days). It stamps `el._preview` for touch long-press / pad Y and starts the 1 s hover-preview timer when `(hover: hover)`.

## Hover preview

One fixed singleton (`hoverPreviewNode`) positioned above/below the card and clamped to the viewport; cross-fades up to 4 backdrop frames every 2.5 s (Ken Burns, all gated by `body.reduced-motion`). Hidden on scroll (capture listener), on `hideAll`, on pad move, and (v0.20) at the top of `renderBrowse` and `drawResults` so a search redraw, pager click or tab switch never leaves one behind. Hover wiring lives in `wireHover(el, kind, item)`: `mouseenter` is ignored for 400 ms after any scroll (a card sliding under a parked pointer is not a hover) and only pointer motion on the card arms the 1 s timer.

## Detail page

`showDetail(kind, id)` fetches one object with `append_to_response=credits,videos,external_ids,watch/providers,images,recommendations,similar` + `include_image_language=en,null` (required for logos). Renders: sticky full-bleed backdrop with a scroll-linked cover, poster, logo-or-h1, meta, director/creator, genre chips (deep-link to Browse), ▶ Play (default source → last used → first), Trailer (YouTube embed), a Watch Later toggle that shows membership (`laterKey` / `inLater` / `removeLater` with Undo, v0.20; the hover preview uses the same), "Watch on" source list, overview, TV episodes (season select, unaired = Coming Soon), cast (→ person page), where-to-watch logos (region from ⚙), photos (lightbox), Recommendations / More Like This rails. Back / Esc return to the view that opened the page (`detailFrom`: dashboard | home | browse — kept across title→title, person→title and player→title hops); `detailOrigin` remembers the title for the person page's back and for Esc out of a player launched from the page (`openedFrom === 'detail'`).

## Dashboard

`DASH_RAILS` registry (`id, title|fn, seeAll, skel, skelN, special?, type?, build`), membership + order from `settings.dashRails` (`DEFAULT_DASH_RAILS = ['continue','trending','top10','live','because']`, genre rails off by default). `railShell` paints skeletons synchronously; `fillRail` swaps in cards or removes the section. First two rails and every `special` rail fill eagerly; the rest lazy-fill via an IntersectionObserver rooted on `#dashboard` (400 px margin). Discover rails carry a Movies/TV segmented toggle persisted per rail (`dashRailType`). The `live` rail is cache-only (`cachedLiveNow` + `warmLiveCache(4)`), never blocks on a dead catalog. `because` seeds from the newest Continue entry with a TMDB id (`bywSeed`) and self-removes.

Hero: slide 0 = newest Continue entry (shares ONE detail fetch with resume-card[0] through a seeded `tmdbMetaCache` entry) with ▶ Resume, else trending #1; slides 1–4 trending; 7 s auto-advance paused on mouse hover and on keyboard/controller focus inside the hero (v0.20), arrows + dots, stilled under reduced motion. Onboarding card replaces everything when there is no key AND no source (audit B8).
